import asyncio
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import agent_server
from workspace_git import Repository


GIT = shutil.which("git")


class CodeDiffStateMixin:
    def isolated_state(self, root: Path):
        state = root / "state"
        return patch.multiple(
            agent_server,
            STATE_DIR=state,
            FILES_ROOT=state / "files",
            CODE_DIFFS_ROOT=state / "code_diffs",
            CROSS_CHAT_AUTHORITY_ROOT=state / "cross_chat_authority",
        )

    def git(self, repo: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
        assert GIT is not None
        return subprocess.run(
            [GIT, "-C", str(repo), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )

    def repository(self, root: Path) -> Path:
        repo = root / "repo"
        repo.mkdir()
        self.git(repo, "init", "-q")
        self.git(repo, "config", "user.name", "Audit Test")
        self.git(repo, "config", "user.email", "audit@example.invalid")
        return repo

    def loose_objects(self, repo: Path) -> set[str]:
        objects = repo / ".git" / "objects"
        return {
            str(path.relative_to(objects))
            for path in objects.glob("[0-9a-f][0-9a-f]/*")
            if path.is_file()
        }


@unittest.skipUnless(GIT, "git is required")
class CodeDiffSnapshotTests(CodeDiffStateMixin, unittest.TestCase):
    def test_attributed_paths_canonicalize_parent_aliases_without_following_leaf(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            alias = root / "repo-alias"
            alias.symlink_to(repo, target_is_directory=True)
            outside = root / "outside"
            outside.mkdir()
            (repo / "tracked.txt").write_text("tracked\n")
            (repo / "tracked-link").symlink_to(outside / "target")
            (repo / "escaped-parent").symlink_to(
                outside,
                target_is_directory=True,
            )

            normalized = agent_server._normalize_changed_paths(
                {
                    str(alias / "tracked.txt"),
                    str(alias / "tracked-link"),
                    str(alias / "escaped-parent" / "untrusted.txt"),
                },
                str(repo),
                str(alias),
            )

            self.assertEqual(normalized, ["tracked-link", "tracked.txt"])

    def test_attributed_paths_skip_unresolvable_home_alias_without_disruption(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "repo"
            repo.mkdir()
            (repo / "tracked.txt").write_text("tracked\n")
            missing_home_path = (
                "~agentsdock_code_diff_user_that_must_not_exist_9f41/file"
            )

            self.assertEqual(
                agent_server._normalize_changed_paths(
                    {missing_home_path},
                    str(repo),
                    str(repo),
                ),
                [],
            )

            normalized = agent_server._normalize_changed_paths(
                {
                    missing_home_path,
                    "tracked.txt",
                },
                str(repo),
                str(repo),
            )

            self.assertEqual(normalized, ["tracked.txt"])

            with patch.dict(os.environ, {"HOME": str(Path(temporary))}):
                self.assertEqual(
                    agent_server._normalize_changed_paths(
                        {"~/repo/tracked.txt"},
                        str(repo),
                        str(repo),
                    ),
                    ["tracked.txt"],
                )

    def test_attributed_pathspec_metacharacters_remain_literal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repository(root)
            attributed = {"*.txt", ":(glob)*.md"}
            unrelated = {"victim.txt", "victim.md"}
            for name in attributed | unrelated:
                (repo / name).write_text("base\n")
            self.git(repo, "add", "-A")
            self.git(repo, "commit", "-qm", "base")

            hostile_pathspec_environment = {
                "GIT_GLOB_PATHSPECS": "1",
                "GIT_ICASE_PATHSPECS": "1",
                "GIT_LITERAL_PATHSPECS": "0",
                "GIT_NOGLOB_PATHSPECS": "1",
            }
            with self.isolated_state(root), patch.dict(
                os.environ,
                hostile_pathspec_environment,
            ):
                baseline = agent_server._capture_git_tree(
                    "chat",
                    "literal-pathspec",
                    str(repo),
                )
                self.assertIsNotNone(baseline)
                assert baseline is not None
                for name in attributed | unrelated:
                    (repo / name).write_text(f"changed {name}\n")

                _checkpoint, metadata = agent_server._write_turn_code_diff(
                    "chat",
                    "literal-pathspec",
                    "cursor",
                    baseline,
                    str(repo),
                    attributed,
                )

            self.assertIsNotNone(metadata)
            assert metadata is not None
            self.assertEqual(metadata["attributed_paths"], sorted(attributed))
            self.assertEqual(
                {item["path"] for item in metadata["diff_files"]},
                attributed,
            )

    def test_snapshot_preserves_exact_git_paths_without_polluting_object_store(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repository(root)
            (repo / "staged.txt").write_text("base staged\n")
            (repo / "deleted.txt").write_text("delete me\n")
            (repo / "space name.txt").write_text("base spaced\n")
            (repo / "binary.bin").write_bytes(b"\x00base\xff")
            (repo / "target-a").write_text("a\n")
            (repo / "target-b").write_text("b\n")
            (repo / "linked").symlink_to("target-a")
            self.git(repo, "add", "-A")
            self.git(repo, "commit", "-qm", "base")

            with self.isolated_state(root):
                baseline = agent_server._capture_git_tree(
                    "chat",
                    "run-weird",
                    str(repo),
                )
                self.assertIsNotNone(baseline)
                assert baseline is not None
                self.assertTrue(Path(baseline["object_dir"]).is_dir())

                # Exercise an index-only change, deletion, whitespace and
                # newline names, a symlink update, and a binary update.
                (repo / "staged.txt").write_text("staged only\n")
                self.git(repo, "add", "staged.txt")
                (repo / "deleted.txt").unlink()
                (repo / "space name.txt").write_text("spaced changed\n")
                newline_name = "line\nbreak.txt"
                (repo / newline_name).write_text("newline path\n")
                (repo / "linked").unlink()
                (repo / "linked").symlink_to("target-b")
                (repo / "binary.bin").write_bytes(b"\x00changed\x00\xff")
                real_objects_before = self.loose_objects(repo)

                _checkpoint, metadata = agent_server._write_turn_code_diff(
                    "chat",
                    "run-weird",
                    "codex",
                    baseline,
                    str(repo),
                    {
                        "staged.txt",
                        "deleted.txt",
                        "space name.txt",
                        newline_name,
                        "linked",
                        "binary.bin",
                    },
                )

                self.assertIsNotNone(metadata)
                assert metadata is not None
                paths = {item["path"] for item in metadata["diff_files"]}
                self.assertTrue({
                    "staged.txt",
                    "deleted.txt",
                    "space name.txt",
                    newline_name,
                    "linked",
                    "binary.bin",
                }.issubset(paths))
                binary = next(
                    item for item in metadata["diff_files"]
                    if item["path"] == "binary.bin"
                )
                self.assertTrue(binary["binary"])
                patch_path = agent_server.code_diffs_dir("chat") / "run-weird.patch"
                metadata_path = agent_server.code_diffs_dir("chat") / "run-weird.json"
                self.assertGreater(patch_path.stat().st_size, 0)
                self.assertLessEqual(
                    patch_path.stat().st_size,
                    agent_server.CODE_DIFF_PATCH_MAX_BYTES,
                )
                self.assertEqual(stat.S_IMODE(patch_path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(metadata_path.stat().st_mode), 0o600)
                self.assertEqual(self.loose_objects(repo), real_objects_before)
                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )
                self.assertEqual(baseline["object_dir"], "")

            with self.isolated_state(root), patch.object(
                agent_server,
                "CODE_DIFF_INDEX_MAX_BYTES",
                8,
            ):
                self.assertIsNone(agent_server._capture_git_tree(
                    "chat",
                    "oversize-index",
                    str(repo),
                ))
                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )

    def test_durable_checkpoint_commit_restores_baseline_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repository(root)
            (repo / ".gitignore").write_text("ignored.log\n")
            (repo / "tracked.txt").write_text("base\n")
            (repo / "removed-by-agent.txt").write_text("keep me\n")
            self.git(repo, "add", "-A")
            self.git(repo, "commit", "-qm", "base")
            head = self.git(repo, "rev-parse", "HEAD").stdout.decode().strip()
            # User state when the turn starts: an unstaged edit, an untracked
            # file, and an ignored file.
            (repo / "tracked.txt").write_text("user edit\n")
            (repo / "notes.txt").write_text("untracked at baseline\n")
            (repo / "ignored.log").write_text("ignored\n")

            with self.isolated_state(root):
                objects_dir = agent_server.checkpoint_objects_dir("chat")
                baseline = agent_server._capture_git_tree("chat", "turn-1", str(repo), durable=True)
                assert baseline is not None
                self.assertEqual(baseline["object_dir"], str(objects_dir))
                self.assertEqual(stat.S_IMODE(objects_dir.stat().st_mode), 0o700)
                real_objects_before = self.loose_objects(repo)

                (repo / "tracked.txt").write_text("agent edit\n")
                (repo / "notes.txt").write_text("agent rewrote notes\n")
                (repo / "removed-by-agent.txt").unlink()
                (repo / "created.txt").write_text("agent created\n")
                (repo / "ignored.log").write_text("still ignored\n")
                checkpoint, metadata = agent_server._write_turn_code_diff(
                    "chat", "turn-1", "codex", baseline, str(repo),
                    {"tracked.txt", "notes.txt", "removed-by-agent.txt", "created.txt"},
                )
                assert checkpoint is not None and metadata is not None
                commit = checkpoint["checkpoint_commit"]
                self.assertRegex(commit, r"^[0-9a-f]{40,64}$")
                self.assertEqual(metadata["checkpoint_commit"], commit)
                self.assertEqual(checkpoint, {
                    "run_id": "turn-1",
                    "checkpoint_commit": commit,
                    "changed_files": ["created.txt", "notes.txt", "removed-by-agent.txt", "tracked.txt"],
                })
                ref = agent_server.checkpoints_dir("chat") / "turn-1"
                self.assertEqual(ref.read_text().strip(), commit)
                self.assertEqual(stat.S_IMODE(ref.stat().st_mode), 0o600)
                # The durable directory survives the baseline discard; the
                # user's object database and refs never see the checkpoint.
                self.assertEqual(baseline["object_dir"], "")
                self.assertTrue(objects_dir.is_dir())
                self.assertEqual(list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")), [])
                self.assertEqual(self.loose_objects(repo), real_objects_before)
                self.assertNotEqual(subprocess.run(
                    [GIT, "-C", str(repo), "cat-file", "-e", commit],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                ).returncode, 0)
                self.assertNotIn(commit, self.git(repo, "for-each-ref").stdout.decode())

                stale = Repository(repo).status()["revision"]
                (repo / "created.txt").write_text("changed after review\n")
                with self.assertRaises(HTTPException) as stale_error:
                    Repository(repo).restore_checkpoint(commit, objects_dir, stale)
                self.assertEqual(stale_error.exception.detail["code"], "git_stale_revision")
                (repo / ".git" / "MERGE_HEAD").write_text(head + "\n")
                with self.assertRaises(HTTPException) as merging:
                    Repository(repo).restore_checkpoint(commit, objects_dir, Repository(repo).status()["revision"])
                self.assertEqual(merging.exception.detail["code"], "git_operation_in_progress")
                (repo / ".git" / "MERGE_HEAD").unlink()
                self.assertEqual((repo / "created.txt").read_text(), "changed after review\n")

                status = Repository(repo).restore_checkpoint(commit, objects_dir, Repository(repo).status()["revision"])

                self.assertEqual((repo / "tracked.txt").read_text(), "user edit\n")
                self.assertEqual((repo / "notes.txt").read_text(), "untracked at baseline\n")
                self.assertEqual((repo / "removed-by-agent.txt").read_text(), "keep me\n")
                self.assertFalse((repo / "created.txt").exists())
                self.assertEqual((repo / "ignored.log").read_text(), "still ignored\n")
                self.assertEqual(
                    {(item["path"], item["staged"], item["untracked"]) for item in status["files"]},
                    {("tracked.txt", False, False), ("notes.txt", False, True)},
                )
                self.assertEqual(status["head"], head)
                self.assertEqual(self.loose_objects(repo), real_objects_before)
                self.assertEqual(list((repo / ".git").glob("agentsdock-index-*")), [])
                self.assertFalse((repo / ".git" / "index.lock").exists())

                with patch.object(agent_server, "CODE_DIFF_CHECKPOINT_MAX_PER_SESSION", 1):
                    second = agent_server._capture_git_tree("chat", "turn-2", str(repo), durable=True)
                    assert second is not None
                    (repo / "tracked.txt").write_text("second agent edit\n")
                    later_checkpoint, later = agent_server._write_turn_code_diff("chat", "turn-2", "codex", second, str(repo), {"tracked.txt"})
                assert later_checkpoint is not None and later is not None
                self.assertEqual(later["checkpoint_commit"], later_checkpoint["checkpoint_commit"])
                self.assertEqual(
                    sorted(path.name for path in agent_server.checkpoints_dir("chat").iterdir()),
                    ["objects", "turn-2"],
                )

                unchanged = agent_server._capture_git_tree("chat", "turn-3", str(repo), durable=True)
                assert unchanged is not None
                self.assertEqual(
                    agent_server._write_turn_code_diff("chat", "turn-3", "codex", unchanged, str(repo), set()),
                    (None, None),
                )
                self.assertFalse((agent_server.checkpoints_dir("chat") / "turn-3").exists())

                # A shell command (no agent-attributed edit paths) still moves
                # the tree, so the turn gets a checkpoint but no code diff.
                fourth = agent_server._capture_git_tree("chat", "turn-4", str(repo), durable=True)
                assert fourth is not None
                (repo / "note.txt").write_text("created through a shell command\n")
                shell_checkpoint, shell_diff = agent_server._write_turn_code_diff("chat", "turn-4", "codex", fourth, str(repo), set())
                self.assertIsNone(shell_diff)
                assert shell_checkpoint is not None
                self.assertEqual(shell_checkpoint["changed_files"], ["note.txt"])
                self.assertEqual(
                    (agent_server.checkpoints_dir("chat") / "turn-4").read_text().strip(),
                    shell_checkpoint["checkpoint_commit"],
                )
                self.assertFalse((agent_server.code_diffs_dir("chat") / "turn-4.patch").exists())
                hidden = {"type": "turn_checkpoint", **shell_checkpoint}
                self.assertTrue(agent_server.is_client_visible_event(hidden))
                self.assertFalse(agent_server.is_visible_timeline_event(hidden, compact=True))
                self.assertFalse(agent_server.semantic_timeline_event_is_display(hidden))
                self.assertIn("turn_checkpoint", agent_server.SEMANTIC_TIMELINE_ESSENTIAL_DETAIL_TYPES)

                agent_server.delete_session_local_roots("chat")
                self.assertFalse(agent_server.code_diffs_dir("chat").exists())

    def test_oversize_discovery_and_patch_leave_no_partial_or_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repository(root)
            (repo / "tracked.txt").write_text("base\n")
            self.git(repo, "add", "tracked.txt")
            self.git(repo, "commit", "-qm", "base")
            with self.isolated_state(root), patch.object(
                agent_server,
                "CODE_DIFF_SNAPSHOT_MAX_FILE_BYTES",
                8,
            ):
                (repo / "large-untracked.txt").write_text("x" * 32)
                self.assertIsNone(agent_server._capture_git_tree(
                    "chat",
                    "oversize-discovery",
                    str(repo),
                ))
                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )

            (repo / "large-untracked.txt").unlink()
            with self.isolated_state(root):
                baseline = agent_server._capture_git_tree(
                    "chat",
                    "oversize-patch",
                    str(repo),
                )
                assert baseline is not None
                (repo / "tracked.txt").write_text(
                    "".join(f"changed line {index}\n" for index in range(200))
                )
                with patch.object(agent_server, "CODE_DIFF_PATCH_MAX_BYTES", 128):
                    result = agent_server._write_turn_code_diff(
                        "chat",
                        "oversize-patch",
                        "codex",
                        baseline,
                        str(repo),
                        {"tracked.txt"},
                    )
                self.assertEqual(result, (None, None))
                self.assertFalse(
                    (agent_server.code_diffs_dir("chat") / "oversize-patch.patch").exists()
                )
                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )

    def test_index_and_pathspec_temps_are_private_independent_of_umask(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source-index"
            destination = root / "private-index"
            pathspec = root / "private-pathspec"
            source.write_bytes(b"index bytes")
            old_umask = os.umask(0)
            try:
                agent_server._copy_private_bounded_file(
                    source,
                    destination,
                    max_bytes=1024,
                    deadline=time.monotonic() + 1,
                )
                agent_server._write_nul_pathspec(
                    pathspec,
                    [b"space name", b"line\nbreak"],
                    deadline=time.monotonic() + 1,
                )
            finally:
                os.umask(old_umask)

            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(pathspec.stat().st_mode), 0o600)
            self.assertEqual(pathspec.read_bytes(), b"space name\0line\nbreak\0")

    def test_git_spawn_failure_after_object_dir_creation_is_cleaned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repository(root)
            with self.isolated_state(root), patch.object(
                agent_server,
                "_git_command",
                side_effect=OSError("spawn failed"),
            ):
                result = agent_server._capture_git_tree(
                    "chat",
                    "spawn-failure",
                    str(repo),
                )
                self.assertIsNone(result)
                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )

    def test_all_git_commands_share_one_wall_clock_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repository(root)
            wrapper_root = root / "bin"
            wrapper_root.mkdir()
            wrapper = wrapper_root / "git"
            wrapper.write_text(
                "#!/bin/sh\nsleep 0.20\nexec "
                + subprocess.list2cmdline([str(GIT)])
                + " \"$@\"\n"
            )
            wrapper.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
            original_path = os.environ.get("PATH", "")
            with self.isolated_state(root), patch.object(
                agent_server,
                "CODE_DIFF_SNAPSHOT_TIMEOUT_SECONDS",
                0.35,
            ), patch.dict(
                os.environ,
                {"PATH": f"{wrapper_root}{os.pathsep}{original_path}"},
            ):
                started = time.monotonic()
                result = agent_server._capture_git_tree(
                    "chat",
                    "overall-deadline",
                    str(repo),
                )
                elapsed = time.monotonic() - started

                self.assertIsNone(result)
                self.assertLess(elapsed, 0.75)
                self.assertGreater(elapsed, 0.25)
                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )


class CodeDiffCancellationTests(CodeDiffStateMixin, unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancel_before_baseline_adoption_cleans_owned_objects(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            started = threading.Event()
            release = threading.Event()

            def delayed_capture(
                session_id: str,
                _run_id: str,
                _cwd: str,
                **_kwargs: object,
            ) -> dict[str, str]:
                snapshot = agent_server.code_diffs_dir(session_id) / ".snapshot-cancel"
                snapshot.mkdir(parents=True)
                (snapshot / "owned").write_bytes(b"object")
                started.set()
                release.wait(timeout=5)
                return {
                    "repo_root": str(root),
                    "tree": "tree",
                    "object_dir": str(snapshot),
                    "alternate_object_dir": str(root),
                }

            with self.isolated_state(root), patch.object(
                agent_server,
                "_capture_git_tree",
                side_effect=delayed_capture,
            ):
                owner = asyncio.create_task(agent_server.capture_git_baseline(
                    "chat",
                    "cancel-before-adoption",
                    str(root),
                ))
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                owner.cancel()
                await asyncio.sleep(0)
                owner.cancel()
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await owner

                self.assertEqual(
                    list(agent_server.code_diffs_dir("chat").glob(".snapshot-*")),
                    [],
                )
                self.assertNotIn(owner, agent_server.GIT_BASELINES_BY_TASK)


if __name__ == "__main__":
    unittest.main()
