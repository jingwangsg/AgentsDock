"""On-demand, native-admin Git workspace operations; no background watchers."""
from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager, suppress
from typing import Any, Callable, Literal

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

MAX_OUTPUT = 2 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024
DEADLINE_SECONDS = 30
# Comparison endpoints besides a revision: the working tree (with untracked files) and the index.
POINT_WORKTREE = "WORKTREE"
POINT_INDEX = "INDEX"
MAX_COMPARE_FILES = 5000
# A revision the user names (commit, branch, tag, HEAD~2, main@{1}); never an option or a range.
_REVISION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,255}$")
_LOCKS = [threading.Lock() for _ in range(64)]


def fail(code: str, message: str, status: int = 409) -> None:
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


@contextmanager
def repository_lock(root: Path, deadline: float):
    lock = _LOCKS[hash(str(root)) % len(_LOCKS)]
    if not lock.acquire(timeout=max(0, deadline - time.monotonic())):
        fail("git_busy", "Another workspace Git action is still running. Refresh and try again.", 409)
    try:
        yield
    finally:
        lock.release()


class GitAction(BaseModel):
    action: Literal["stage", "unstage", "discard", "commit", "resolve", "continue", "abort"]
    expected_revision: str = Field(min_length=64, max_length=64)
    paths: list[str] | None = Field(default=None, max_length=1000)
    message: str | None = Field(default=None, max_length=65536)
    path: str | None = Field(default=None, max_length=4096)
    content: str | None = Field(default=None, max_length=MAX_TEXT)
    confirmed: bool = False


class CheckpointRestore(BaseModel):
    run_id: str = Field(min_length=1, max_length=256)
    expected_revision: str = Field(min_length=64, max_length=64)
    confirmed: bool = False


class Repository:
    def __init__(self, workspace: Path):
        self.deadline = time.monotonic() + DEADLINE_SECONDS
        self.root = workspace.resolve(strict=True)
        self.index_override: Path | None = None
        self.publish_index_on_error = False
        top, code, _ = self.git("rev-parse", "--show-toplevel", check=False)
        if code or not top.strip():
            fail("workspace_not_git", "This chat's working directory is not inside a Git worktree.", 422)
        self.root = Path(os.fsdecode(top.rstrip(b"\n"))).resolve(strict=True)
        gitdir, _, _ = self.git("rev-parse", "--absolute-git-dir")
        self.gitdir = Path(os.fsdecode(gitdir.rstrip(b"\n"))).resolve(strict=True)
        index, _, _ = self.git("rev-parse", "--git-path", "index")
        self.index = Path(os.fsdecode(index.rstrip(b"\n")))
        if not self.index.is_absolute():
            self.index = self.root / self.index
        if self.index.is_symlink():
            fail("git_unsafe_index", "Git index is a symlink; use the terminal for this repository.")

    def git(self, *args: str, check: bool = True, input: bytes | None = None,
            limit: int = MAX_OUTPUT, truncate: bool = False,
            extra_env: dict[str, str] | None = None) -> tuple[bytes, int, bool]:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            fail("git_timeout", "Git exceeded its 30 second deadline. Refresh before trying again.", 504)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("GIT_") or key in {"GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"}}
        env.update(GIT_TERMINAL_PROMPT="0", GIT_EDITOR="true", GIT_SEQUENCE_EDITOR="true",
                   GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", LC_ALL="C")
        if self.index_override is not None:
            env["GIT_INDEX_FILE"] = str(self.index_override)
        env.update(extra_env or {})
        command = ["git", "--literal-pathspecs", "-c", "core.fsmonitor=false",
                   "-c", "core.untrackedCache=false", "-c", "gc.auto=0",
                   "-c", "maintenance.auto=false", "-c", "credential.interactive=false",
                   "-c", "core.pager=cat", *args]
        try:
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                process = subprocess.Popen(command, cwd=self.root, env=env,
                                           stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                           stdout=output, stderr=errors, start_new_session=True)
                try:
                    process.communicate(input, timeout=remaining)
                except subprocess.TimeoutExpired:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    fail("git_timeout", "Git timed out. Refresh repository status before trying again.", 504)
                output.seek(0)
                result = output.read(limit + 1)
                errors.seek(0)
                error = errors.read(8192).decode("utf-8", "replace").strip()
        except FileNotFoundError:
            fail("git_unavailable", "Git is not installed on this server.", 501)
        if check and process.returncode:
            fail("git_command_failed", error or "Git could not complete this operation.")
        clipped = len(result) > limit
        if clipped and not truncate:
            fail("git_result_too_large", "This repository result is too large for the workspace Git view.", 413)
        return result[:limit], process.returncode, clipped

    def path(self, value: str) -> str:
        if (not isinstance(value, str) or not value or len(value) > 4096
                or value.startswith("/") or "\\" in value or "\x00" in value
                or any(part in ("", ".", "..") or part.casefold() == ".git" for part in value.split("/"))):
            fail("git_invalid_path", "Select a repository-relative file outside Git's metadata directory.", 400)
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            fail("git_filename_encoding", "This repository contains a filename that is not UTF-8. Use the terminal for this repository.", 415)
        # Git pathspecs are literal; walk each parent without following links.
        current = self.root
        for part in value.split("/")[:-1]:
            current /= part
            try:
                info = current.lstat()
            except FileNotFoundError:
                break  # A deleted tracked path may have missing parent directories.
            if not stat.S_ISDIR(info.st_mode):
                fail("git_unsafe_path", "Git paths cannot traverse symbolic links or non-directories.", 400)
        return value

    def read_worktree(self, path: str) -> bytes | None:
        path = self.path(path)
        parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in path.split("/")[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = next_fd
            name = path.split("/")[-1]
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                return os.fsencode(os.readlink(name, dir_fd=parent))
            if not stat.S_ISREG(info.st_mode):
                fail("git_not_regular_file", "This Git entry is not a regular text file.", 415)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                with os.fdopen(fd, "rb", closefd=False) as stream:
                    data = stream.read(MAX_TEXT + 1)
                if len(data) > MAX_TEXT:
                    fail("git_file_too_large", "This file exceeds the 2 MiB Git text editor limit.", 413)
                return data
            finally:
                os.close(fd)
        except FileNotFoundError:
            return None
        except OSError as exc:
            fail("git_unsafe_path", f"Cannot safely open this repository file: {exc.strerror}", 409)
        finally:
            os.close(parent)

    def operation(self) -> str | None:
        for marker, operation in (("rebase-merge", "rebase"), ("rebase-apply", "rebase"),
                                  ("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"),
                                  ("REVERT_HEAD", "revert")):
            if (self.gitdir / marker).exists():
                return operation
        return None

    def status(self) -> dict[str, Any]:
        raw, _, _ = self.git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
        files: list[dict[str, Any]] = []
        entries = iter(raw.split(b"\0"))
        for entry in entries:
            if not entry:
                continue
            xy = entry[:2].decode("ascii")
            item: dict[str, Any] = {"path": os.fsdecode(entry[3:]), "index_status": xy[0],
                                    "worktree_status": xy[1], "staged": xy[0] not in " ?",
                                    "unstaged": xy[1] != " ", "untracked": xy == "??",
                                    "conflicted": xy in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}}
            if xy[0] in "RC" or xy[1] in "RC":
                item["original_path"] = os.fsdecode(next(entries))
            files.append(item)
        head_raw, head_code, _ = self.git("rev-parse", "--verify", "HEAD", check=False)
        branch_raw, _, _ = self.git("symbolic-ref", "--quiet", "--short", "HEAD", check=False)
        head = None if head_code else head_raw.decode().strip()
        branch = branch_raw.decode("utf-8", "replace").strip() or None
        digest = hashlib.sha256()
        digest.update(os.fsencode(self.root))
        digest.update(os.fsencode(self.gitdir))
        digest.update(raw)
        digest.update(head_raw)
        digest.update(branch_raw)
        # Index bytes identify the exact staged tree, including conflict stages.
        try:
            digest.update(self.index.read_bytes())
        except FileNotFoundError:
            digest.update(b"unborn-index")
        for item in files:
            for path in (item["path"], item.get("original_path")):
                if path is None:
                    continue
                self.path(path)
                try:
                    info = (self.root / path).lstat()
                    digest.update(str((info.st_dev, info.st_ino, info.st_mode, info.st_size,
                                       info.st_mtime_ns, info.st_ctime_ns)).encode())
                except FileNotFoundError:
                    digest.update(b"missing")
        for marker in ("HEAD", "MERGE_HEAD", "MERGE_MSG", "CHERRY_PICK_HEAD", "REVERT_HEAD",
                       "ORIG_HEAD", "rebase-merge/head-name", "rebase-merge/onto",
                       "rebase-merge/git-rebase-todo", "rebase-merge/done",
                       "rebase-apply/next", "rebase-apply/last", "sequencer/todo"):
            target = self.gitdir / marker
            if target.is_file() and not target.is_symlink():
                digest.update(marker.encode())
                with target.open("rb") as stream:
                    digest.update(stream.read(MAX_OUTPUT))
        return {"root": str(self.root), "branch": branch, "head": head,
                "revision": digest.hexdigest(), "operation": self.operation(), "files": files,
                "staged_count": sum(item["staged"] and not item["conflicted"] for item in files),
                "conflict_count": sum(item["conflicted"] for item in files)}

    def checked_status(self, revision: str) -> dict[str, Any]:
        current = self.status()
        if not re.fullmatch(r"[0-9a-f]{64}", revision or "") or current["revision"] != revision:
            fail("git_stale_revision", "Repository changed since review. Refresh and review the current changes before trying again.")
        return current

    @staticmethod
    def text(data: bytes | None) -> tuple[str | None, bool]:
        if data is None:
            return None, False
        try:
            if b"\0" in data:
                return "", True
            return data.decode("utf-8"), False
        except UnicodeDecodeError:
            return "", True

    def diff(self, path: str, view: str) -> dict[str, Any]:
        path = self.path(path)
        if view not in {"staged", "unstaged"}:
            fail("git_invalid_view", "Diff view must be staged or unstaged.", 400)
        before = self.status()
        item = next((entry for entry in before["files"] if entry["path"] == path), None)
        if item is None:
            fail("git_file_not_changed", "This file no longer has repository changes. Refresh the list.", 404)
        binary = False
        truncated = False
        if item["untracked"] and view == "unstaged":
            content, binary = self.text(self.read_worktree(path))
            result = "" if binary else "".join(difflib.unified_diff([], (content or "").splitlines(keepends=True),
                                                                       fromfile="/dev/null", tofile="b/" + path))
            encoded = result.encode("utf-8")
            truncated = len(encoded) > MAX_OUTPUT
            result = encoded[:MAX_OUTPUT].decode("utf-8", "replace")
        else:
            args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]
            if view == "staged":
                args.append("--cached")
            args += ["--", path]
            if item.get("original_path"):
                args.append(self.path(item["original_path"]))
            output, _, truncated = self.git(*args, truncate=True)
            result = output.decode("utf-8", "replace")
            binary = b"Binary files " in output or b"GIT binary patch" in output
        self.checked_status(before["revision"])
        return {"path": path, "view": view, "diff": result, "binary": binary,
                "truncated": truncated, "revision": before["revision"]}

    def conflict(self, path: str) -> dict[str, Any]:
        path = self.path(path)
        before = self.status()
        if not any(item["path"] == path and item["conflicted"] for item in before["files"]):
            fail("git_not_conflicted", "This file no longer has unresolved conflicts. Refresh the list.")
        raw, _, _ = self.git("ls-files", "--unmerged", "-z", "--", path)
        result: dict[str, Any] = {"path": path, "base": None, "ours": None, "theirs": None,
                                  "result": "", "binary": False, "revision": before["revision"]}
        for entry in raw.split(b"\0"):
            if not entry:
                continue
            mode, oid, stage = entry.split(b"\t", 1)[0].split(b" ")
            data, _, _ = self.git("cat-file", "blob", oid.decode(), limit=MAX_TEXT)
            value, binary = self.text(data)
            result[{b"1": "base", b"2": "ours", b"3": "theirs"}[stage]] = value
            result["binary"] |= binary or mode != b"100644" and mode != b"100755"
        value, binary = self.text(self.read_worktree(path))
        result["result"] = value or ""
        result["binary"] |= binary
        self.checked_status(before["revision"])
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 12 * 1024 * 1024:
            fail("git_conflict_too_large", "This conflict is too large for the editor. Resolve it in the terminal.", 413)
        return result

    def refs(self, limit: int = 60) -> dict[str, Any]:
        """HEAD, the recent commits, branches and tags a comparison can name."""
        head_raw, head_code, _ = self.git("rev-parse", "--verify", "HEAD", check=False)
        branch_raw, _, _ = self.git("symbolic-ref", "--quiet", "--short", "HEAD", check=False)
        commits: list[dict[str, Any]] = []
        if not head_code:
            raw, _, _ = self.git("log", f"--max-count={limit}", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s")
            for line in raw.decode("utf-8", "replace").splitlines():
                parts = line.split("\x1f")
                if len(parts) == 5:
                    commits.append({"hash": parts[0], "short": parts[1], "author": parts[2], "date": parts[3], "subject": parts[4]})
        names, _, _ = self.git("for-each-ref", "--format=%(refname)", "--sort=-committerdate", "--count=400",
                               "refs/heads", "refs/tags")
        branches: list[str] = []
        tags: list[str] = []
        for ref in names.decode("utf-8", "replace").splitlines():
            if ref.startswith("refs/heads/"):
                branches.append(ref[len("refs/heads/"):])
            elif ref.startswith("refs/tags/"):
                tags.append(ref[len("refs/tags/"):])
        return {"head": None if head_code else head_raw.decode().strip(),
                "branch": branch_raw.decode("utf-8", "replace").strip() or None,
                "commits": commits, "branches": branches, "tags": tags}

    def point(self, value: str) -> dict[str, Any]:
        """One end of a comparison: the working tree, the index, or a revision resolved to a commit."""
        if value in (POINT_WORKTREE, POINT_INDEX):
            return {"ref": value, "resolved": None}
        if not isinstance(value, str) or not _REVISION_PATTERN.fullmatch(value) or ".." in value:
            fail("git_invalid_revision", "Name a commit, branch or tag; ranges and options are not accepted.", 400)
        output, code, _ = self.git("rev-parse", "--verify", "--quiet", "--end-of-options", value + "^{commit}", check=False)
        if code or not output.strip():
            fail("git_unknown_revision", f"{value} is not a commit in this repository.", 404)
        return {"ref": value, "resolved": output.decode().strip()}

    def compare_points(self, base: str, target: str) -> tuple[dict[str, Any], dict[str, Any], list[str], bool]:
        """Resolve both ends and the `git diff` selector between them; the flag says the target is the working tree."""
        base_point, target_point = self.point(base), self.point(target)
        if base_point["ref"] == POINT_WORKTREE:
            fail("git_invalid_compare", "The working tree can only be the newer side of a comparison.", 400)
        if base == target:
            fail("git_invalid_compare", "Choose two different points to compare.", 400)
        if target_point["ref"] == POINT_WORKTREE:
            selector = [] if base_point["ref"] == POINT_INDEX else [base_point["resolved"]]
        elif target_point["ref"] == POINT_INDEX:
            selector = ["--cached", base_point["resolved"]]
        elif base_point["ref"] == POINT_INDEX:
            selector = ["--cached", "-R", target_point["resolved"]]
        else:
            selector = [base_point["resolved"], target_point["resolved"]]
        return base_point, target_point, selector, target_point["ref"] == POINT_WORKTREE

    def compare(self, base: str, target: str) -> dict[str, Any]:
        """The files that differ between two points, untracked files included when the newer side is the working tree."""
        base_point, target_point, selector, worktree = self.compare_points(base, target)
        raw, _, clipped = self.git("diff", "--name-status", "-z", "--no-renames", "--no-ext-diff",
                                   "--ignore-submodules=none", *selector, "--", truncate=True)
        files: list[dict[str, Any]] = []
        entries = iter(raw.split(b"\0"))
        for entry in entries:
            if not entry:
                continue
            path = next(entries, b"")
            if path:
                files.append({"path": os.fsdecode(path), "status": entry[:1].decode("ascii", "replace"), "untracked": False})
        if worktree:
            others, _, _ = self.git("ls-files", "--others", "--exclude-standard", "-z")
            files.extend({"path": os.fsdecode(entry), "status": "A", "untracked": True} for entry in others.split(b"\0") if entry)
        files.sort(key=lambda item: item["path"])
        return {"base": base_point, "target": target_point, "files": files[:MAX_COMPARE_FILES],
                "truncated": clipped or len(files) > MAX_COMPARE_FILES}

    def compare_diff(self, base: str, target: str, path: str) -> dict[str, Any]:
        path = self.path(path)
        _, _, selector, worktree = self.compare_points(base, target)
        output, _, truncated = self.git("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
                                        *selector, "--", path, truncate=True)
        result = output.decode("utf-8", "replace")
        binary = b"Binary files " in output or b"GIT binary patch" in output
        if not output and worktree:
            # Git has no diff for an untracked file; the working tree shows it as wholly added.
            _, code, _ = self.git("ls-files", "--error-unmatch", "--", path, check=False)
            content, is_binary = (self.text(self.read_worktree(path)) if code else (None, False))
            if content is not None:
                binary = is_binary
                result = "" if binary else "".join(difflib.unified_diff([], content.splitlines(keepends=True),
                                                                           fromfile="/dev/null", tofile="b/" + path))
                encoded = result.encode("utf-8")
                truncated = len(encoded) > MAX_OUTPUT
                result = encoded[:MAX_OUTPUT].decode("utf-8", "replace")
        return {"path": path, "base": base, "target": target, "diff": result, "binary": binary, "truncated": truncated}

    def safe_git_configuration(self, action: str, paths: list[str]) -> None:
        # Ordinary hooks and filters may execute arbitrary code or alter reviewed
        # blobs. Refuse these repositories instead of silently skipping policy.
        if action in {"stage", "discard", "resolve", "continue", "abort"} and paths:
            attributes, _, _ = self.git("check-attr", "-z", "filter", "merge", "--", *paths)
            values = attributes.split(b"\0")
            for position in range(0, len(values) - 2, 3):
                attribute, value = values[position + 1:position + 3]
                if value in {b"unspecified", b"unset"}:
                    continue
                if attribute == b"merge" and (action in {"stage", "discard", "resolve"} or value in {b"set", b"text", b"binary", b"union"}):
                    continue
                fail("git_custom_driver", "A selected file uses a custom Git filter or merge driver. Complete this operation in the terminal.")
        if action in {"commit", "continue", "abort"}:
            hookpath, _, _ = self.git("rev-parse", "--git-path", "hooks")
            directory = Path(os.fsdecode(hookpath.rstrip(b"\n")))
            if not directory.is_absolute():
                directory = self.root / directory
            if directory.exists() and any(item.is_file() and os.access(item, os.X_OK)
                                          and not item.name.endswith(".sample") for item in directory.iterdir()):
                fail("git_hooks_require_terminal", "This repository has executable Git hooks. Run this operation in the terminal so its hooks can run normally.")
        if action == "continue" and self.operation() == "rebase":
            todo = self.gitdir / "rebase-merge" / "git-rebase-todo"
            if todo.is_file() and re.search(r"(?m)^\s*(exec|x)\s", todo.read_text()):
                fail("git_rebase_exec", "This rebase has executable todo commands. Continue it in the terminal.")

    @contextmanager
    def index_transaction(self):
        lock_path = Path(str(self.index) + ".lock")
        try:
            lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            fail("git_index_locked", "Git's index is locked. Let an active operation finish; if a prior workspace action reported an index recovery error, restore its saved index before removing this lock.")
        try:
            temp_fd, name = tempfile.mkstemp(prefix="agentsdock-index-", dir=self.index.parent)
        except OSError as exc:
            os.close(lock_fd)
            with suppress(FileNotFoundError):
                lock_path.unlink()
            fail("git_storage_failure", f"Could not prepare Git's index snapshot: {exc.strerror}. Check free space and permissions, then refresh.", 507)
        temporary = Path(name)
        preserve_recovery = False
        def publish() -> None:
            nonlocal preserve_recovery
            if temporary.exists():
                try:
                    completed_fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        os.fsync(completed_fd)
                    finally:
                        os.close(completed_fd)
                    # Keep Git's real lock held while publishing the completed
                    # same-filesystem index. Do not copy it a second time: an
                    # ENOSPC here could otherwise lose the only correct index
                    # after commit/rebase has already changed HEAD or files.
                    os.replace(temporary, self.index)
                except OSError as exc:
                    preserve_recovery = True
                    raise HTTPException(status_code=507, detail={
                        "code": "git_index_recovery_required",
                        "message": (
                            f"Git may have changed HEAD or working files, but its completed index could not be published: {exc.strerror}. "
                            f"The recovery index is retained at {temporary}; {lock_path} remains in place to block further Git writes. "
                            f"After fixing storage or permissions, restore that index to {self.index}, then remove the lock and refresh."
                        ),
                        "recovery_index": str(temporary),
                        "index_path": str(self.index),
                        "lock_path": str(lock_path),
                    }) from exc
        try:
            with os.fdopen(temp_fd, "wb") as stream:
                if self.index.exists():
                    stream.write(self.index.read_bytes())
            if temporary.stat().st_size == 0:
                temporary.unlink()  # Git treats a missing index as an unborn index.
            try:
                yield temporary
            except BaseException:
                if self.publish_index_on_error:
                    publish()
                raise
            else:
                publish()
        finally:
            self.index_override = None
            os.close(lock_fd)
            if not preserve_recovery:
                with suppress(FileNotFoundError):
                    lock_path.unlink()
                with suppress(FileNotFoundError):
                    temporary.unlink()
                with suppress(FileNotFoundError):
                    Path(str(temporary) + ".lock").unlink()

    def save_resolution(self, path: str, content: str, expected: bytes | None) -> None:
        data = content.encode("utf-8")
        if len(data) > MAX_TEXT or b"\0" in data:
            fail("git_invalid_resolution", "Resolution must be UTF-8 text no larger than 2 MiB.", 400)
        # Secure directory descriptors prevent a concurrent symlink parent swap
        # from redirecting the save outside the canonical worktree.
        parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temp_name = ""
        try:
            for part in path.split("/")[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = next_fd
            name = path.split("/")[-1]
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                fail("git_unsafe_resolution", "Only regular files without hard links can be resolved in the editor.")
            temp_name = ".agentsdock-resolution-" + os.urandom(12).hex()
            fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         stat.S_IMODE(info.st_mode), dir_fd=parent)
            os.fchmod(fd, stat.S_IMODE(info.st_mode))
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            latest = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if latest != info or self.read_worktree(path) != expected:
                fail("git_stale_revision", "The conflict file changed while saving. Refresh before trying again.")
            os.replace(temp_name, name, src_dir_fd=parent, dst_dir_fd=parent)
        except FileNotFoundError:
            fail("git_resolution_missing", "The conflict result file is missing. Restore it in the terminal before editing.")
        finally:
            if temp_name:
                with suppress(FileNotFoundError):
                    os.unlink(temp_name, dir_fd=parent)
            os.close(parent)

    def action(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request["action"]
        with repository_lock(self.root, self.deadline):
            with self.index_transaction() as temporary:
                before = self.checked_status(request.get("expected_revision", ""))
                paths = [self.path(value) for value in (request.get("paths") or [])]
                available = {item["path"]: item for item in before["files"]}
                driver_paths = paths
                if action == "resolve":
                    driver_paths = [self.path(request.get("path") or "")]
                elif action in {"continue", "abort"}:
                    tracked, _, _ = self.git("ls-files", "-z")
                    driver_paths = [os.fsdecode(value) for value in tracked.split(b"\0") if value]
                self.safe_git_configuration(action, driver_paths)
                if action in {"stage", "unstage"}:
                    if not paths or any(path not in available for path in paths):
                        fail("git_invalid_selection", "Select files from the current repository changes.", 400)
                    if any(available[path]["conflicted"] for path in paths):
                        fail("git_unresolved_conflict", "Resolve conflicted files in the conflict editor before staging.")
                    # Rename entries must operate on both index paths.
                    paths = list(dict.fromkeys(paths + [self.path(available[path]["original_path"])
                                                       for path in paths if available[path].get("original_path")]))
                    self.index_override = temporary
                    if action == "stage":
                        self.git("add", "--", *paths)
                    elif before["head"]:
                        self.git("reset", "--quiet", "HEAD", "--", *paths)
                    else:
                        self.git("update-index", "--force-remove", "--", *paths)
                    self.index_override = None
                    self.checked_status(before["revision"])
                elif action == "discard":
                    if request.get("confirmed") is not True:
                        fail("git_discard_confirmation_required", "Confirm discarding these changes before continuing.", 400)
                    if not paths or any(path not in available or not available[path]["unstaged"]
                                        or available[path]["conflicted"] for path in paths):
                        fail("git_invalid_selection", "Select unstaged or untracked files from the current repository changes.", 400)
                    # Only the working tree changes: tracked files return to their staged (index)
                    # version, untracked files are deleted. checkout-index runs no hooks.
                    tracked = [path for path in paths if not available[path]["untracked"]]
                    untracked = [path for path in paths if available[path]["untracked"]]
                    if tracked:
                        self.git("checkout-index", "--force", "--", *tracked)
                    if untracked:
                        self.git("clean", "--force", "--quiet", "--", *untracked)
                elif action == "commit":
                    message = request.get("message", "") or ""
                    if not message.strip():
                        fail("git_commit_message_required", "Enter a commit message.", 400)
                    if before["conflict_count"]:
                        fail("git_unresolved_conflict", "Resolve every conflict before committing.")
                    if before["operation"]:
                        fail("git_operation_in_progress", "Use Continue to finish the current Git operation.")
                    if not before["staged_count"]:
                        fail("git_nothing_staged", "Stage and review files before committing.")
                    self.index_override = temporary
                    self.publish_index_on_error = True
                    self.git("commit", "--file=-", input=message.encode("utf-8"))
                elif action == "resolve":
                    path = self.path(request.get("path") or "")
                    if path not in available or not available[path]["conflicted"]:
                        fail("git_not_conflicted", "This file no longer has unresolved conflicts.")
                    conflict = self.conflict(path)
                    if conflict["binary"]:
                        fail("git_binary_conflict", "Resolve binary or symbolic-link conflicts in the terminal.", 415)
                    content = request.get("content")
                    if not isinstance(content, str):
                        fail("git_resolution_required", "Provide the resolved file content.", 400)
                    if re.search(r"(?m)^(<{7}|={7}|>{7}|\|{7})(?: |$)", content):
                        fail("git_conflict_markers", "Remove the conflict markers before saving and staging.")
                    self.checked_status(before["revision"])
                    self.save_resolution(path, content, conflict["result"].encode("utf-8"))
                    self.index_override = temporary
                    try:
                        self.git("add", "--", path)
                        staged, _, _ = self.git("show", ":" + path, limit=MAX_TEXT)
                        if staged != content.encode("utf-8") or self.read_worktree(path) != staged:
                            fail("git_stale_revision", "The conflict file changed while staging. Its newer content was preserved; refresh before staging again.")
                    except HTTPException as exc:
                        fail("git_resolution_saved_not_staged", "Resolution was saved but Git could not stage it. Refresh and stage it in the terminal. " + str(exc.detail))
                elif action in {"continue", "abort"}:
                    operation = before["operation"]
                    if operation is None:
                        fail("git_no_operation", "There is no merge, rebase, cherry-pick, or revert to finish.")
                    if action == "abort" and request.get("confirmed") is not True:
                        fail("git_abort_confirmation_required", "Confirm aborting this Git operation before continuing.", 400)
                    if action == "continue" and before["conflict_count"]:
                        fail("git_unresolved_conflict", "Resolve and stage every conflict before continuing.")
                    self.index_override = temporary
                    self.publish_index_on_error = True
                    try:
                        self.git(operation, "--" + action)
                    except HTTPException as exc:
                        # Rebase/cherry-pick can legitimately stop at the next
                        # conflict. Their new index must accompany the new files.
                        unmerged, _, _ = self.git("ls-files", "--unmerged", "-z")
                        if action != "continue" or not unmerged or exc.detail.get("code") != "git_command_failed":
                            raise
                else:
                    fail("git_invalid_action", "Unsupported Git action.", 400)
            return self.status()

    def restore_checkpoint(self, commit: str, objects_dir: Path, expected_revision: str) -> dict[str, Any]:
        """Make the worktree match ``commit`` (an AgentsDock turn checkpoint).

        The checkpoint's objects live only in ``objects_dir``, so the real
        index is left untouched: publishing a tree whose blobs are absent from
        the repository's own object database would break later ``diff
        --cached``/``commit``. Files are written from a scratch index; tracked
        or untracked-but-not-ignored files missing from the checkpoint are
        deleted. Ignored files are never touched.
        """
        if not re.fullmatch(r"[0-9a-f]{40,64}", commit or ""):
            fail("git_invalid_checkpoint", "The checkpoint reference is not a Git commit id.", 400)
        alternates = {"GIT_ALTERNATE_OBJECT_DIRECTORIES": str(objects_dir)}

        def listed(raw: bytes) -> set[str]:
            return {os.fsdecode(entry) for entry in raw.split(b"\0") if entry}

        with repository_lock(self.root, self.deadline):
            with self.index_transaction() as temporary:
                before = self.checked_status(expected_revision)
                if before["operation"]:
                    fail("git_operation_in_progress", "Finish or abort the current Git operation before restoring a checkpoint.")
                tracked, _, _ = self.git("ls-files", "-z")
                others, _, _ = self.git("ls-files", "--others", "--exclude-standard", "-z")
                scratch = Path(str(temporary) + ".checkpoint")
                try:
                    self.index_override = scratch
                    self.git("read-tree", commit, extra_env=alternates)
                    self.git("checkout-index", "--all", "--force", extra_env=alternates)
                    checkpoint_paths, _, _ = self.git("ls-files", "-z")
                finally:
                    self.index_override = None
                    with suppress(FileNotFoundError):
                        scratch.unlink()
                for path in sorted((listed(tracked) | listed(others)) - listed(checkpoint_paths)):
                    if any(part in ("", ".", "..") for part in path.split("/")):
                        continue
                    target = self.root / path
                    with suppress(FileNotFoundError):
                        if not stat.S_ISDIR(target.lstat().st_mode):
                            target.unlink()
            return self.status()


def register_workspace_git_routes(app: Any, *, authorize: Callable, workspace_root: Callable,
                                  checkpoint_restore: Callable) -> None:
    def repository(session_id: str, for_write: bool = False) -> Repository:
        _, root = workspace_root(session_id, for_write=for_write)
        return Repository(root)

    @app.get("/api/sessions/{session_id}/workspace/git")
    async def workspace_git_status(request: Request, session_id: str) -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id).status())

    @app.get("/api/sessions/{session_id}/workspace/git/diff")
    async def workspace_git_diff(request: Request, session_id: str,
                                 path: str = Query(min_length=1, max_length=4096),
                                 view: Literal["staged", "unstaged"] = "unstaged") -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id).diff(path, view))

    @app.get("/api/sessions/{session_id}/workspace/git/conflict")
    async def workspace_git_conflict(request: Request, session_id: str,
                                     path: str = Query(min_length=1, max_length=4096)) -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id).conflict(path))

    @app.get("/api/sessions/{session_id}/workspace/git/refs")
    async def workspace_git_refs(request: Request, session_id: str,
                                 limit: int = Query(default=60, ge=1, le=500)) -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id).refs(limit))

    @app.get("/api/sessions/{session_id}/workspace/git/compare")
    async def workspace_git_compare(request: Request, session_id: str,
                                    base: str = Query(min_length=1, max_length=256),
                                    target: str = Query(min_length=1, max_length=256)) -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id).compare(base, target))

    @app.get("/api/sessions/{session_id}/workspace/git/compare/diff")
    async def workspace_git_compare_diff(request: Request, session_id: str,
                                         base: str = Query(min_length=1, max_length=256),
                                         target: str = Query(min_length=1, max_length=256),
                                         path: str = Query(min_length=1, max_length=4096)) -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id).compare_diff(base, target, path))

    @app.post("/api/sessions/{session_id}/workspace/git/action")
    async def workspace_git_action(request: Request, session_id: str, req: GitAction) -> dict[str, Any]:
        authorize(request)
        return await asyncio.to_thread(lambda: repository(session_id, True).action(req.model_dump()))

    @app.post("/api/sessions/{session_id}/workspace/git/checkpoint/restore")
    async def restore_session_checkpoint(request: Request, session_id: str, req: CheckpointRestore) -> dict[str, Any]:
        authorize(request)
        if req.confirmed is not True:
            fail("git_checkpoint_confirmation_required", "Confirm restoring this checkpoint before continuing.", 400)
        # checkpoint_restore holds the chat lifecycle lock, requires an idle
        # chat, resolves the commit, and records the restore event on exit.
        async with checkpoint_restore(session_id, req.run_id) as (commit, objects_dir):
            return await asyncio.to_thread(
                lambda: repository(session_id, True).restore_checkpoint(commit, objects_dir, req.expected_revision))
