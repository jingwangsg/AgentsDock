"""Real disposable Git repositories; never import or start the live server."""
import os
import errno
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from workspace_git import Repository


class WorkspaceGitTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        self.env.start()
        self.temporary = tempfile.TemporaryDirectory(prefix="workspace-git-unit-", dir=os.environ.get("WORKSPACE_GIT_QA_TMP"))
        self.root = Path(self.temporary.name) / "repo"
        self.root.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Workspace QA")
        self.git("config", "user.email", "workspace-qa@example.invalid")

    def tearDown(self):
        self.temporary.cleanup()
        self.env.stop()

    def git(self, *args, check=True):
        process = subprocess.run(["git", *args], cwd=self.root, capture_output=True, check=False)
        if check and process.returncode:
            self.fail(process.stderr.decode())
        return process.stdout.decode()

    def write(self, path, content):
        (self.root / path).write_text(content)

    def initial(self, **files):
        for path, content in (files or {"file.txt": "base\n"}).items():
            self.write(path, content)
        self.git("add", ".")
        self.git("commit", "-m", "initial")

    def status(self):
        return Repository(self.root).status()

    def action(self, action, **kwargs):
        revision = kwargs.pop("expected_revision", self.status()["revision"])
        return Repository(self.root).action({"action": action, "expected_revision": revision, **kwargs})

    def test_stage_partial_commit_and_stale_index(self):
        self.initial()
        self.write("file.txt", "reviewed\n")
        staged = self.action("stage", paths=["file.txt"])
        self.write("file.txt", "later unstaged work\n")
        status = self.status()
        self.assertTrue(status["files"][0]["staged"])
        self.assertTrue(status["files"][0]["unstaged"])
        self.assertIn("+reviewed", Repository(self.root).diff("file.txt", "staged")["diff"])
        self.assertIn("+later unstaged", Repository(self.root).diff("file.txt", "unstaged")["diff"])
        with self.assertRaises(HTTPException) as error:
            self.action("commit", expected_revision=staged["revision"], message="stale")
        self.assertEqual(error.exception.detail["code"], "git_stale_revision")
        self.action("commit", message="reviewed snapshot")
        self.assertEqual(self.git("show", "HEAD:file.txt"), "reviewed\n")
        self.assertEqual((self.root / "file.txt").read_text(), "later unstaged work\n")
        self.assertEqual(self.status()["staged_count"], 0)

    def test_compare_between_commits_the_index_and_the_working_tree(self):
        self.initial(**{"file.txt": "base\n", "gone.txt": "old\n"})
        first = self.git("rev-parse", "HEAD").strip()
        self.write("file.txt", "second\n")
        (self.root / "gone.txt").unlink()
        self.write("born.txt", "new\n")
        self.git("add", "-A")
        self.git("commit", "-m", "second")
        self.git("tag", "v1")
        self.write("file.txt", "staged\n")
        self.git("add", "file.txt")
        self.write("file.txt", "worktree\n")
        self.write("loose.txt", "untracked\n")
        repo = Repository(self.root)

        refs = repo.refs()
        self.assertEqual([commit["subject"] for commit in refs["commits"]], ["second", "initial"])
        self.assertEqual((refs["branch"], refs["branches"], refs["tags"]), ("main", ["main"], ["v1"]))
        self.assertEqual(refs["head"], refs["commits"][0]["hash"])

        between = repo.compare(first, "v1")
        self.assertEqual([(item["path"], item["status"]) for item in between["files"]],
                         [("born.txt", "A"), ("file.txt", "M"), ("gone.txt", "D")])
        self.assertEqual((between["base"]["resolved"], between["target"]["resolved"]), (first, refs["head"]))
        self.assertIn("+second", repo.compare_diff(first, "v1", "file.txt")["diff"])
        # The index against HEAD shows the staged edit; the working tree against HEAD shows the latest edit and untracked files.
        self.assertIn("+staged", repo.compare_diff("HEAD", "INDEX", "file.txt")["diff"])
        worktree = repo.compare("HEAD", "WORKTREE")
        self.assertEqual([(item["path"], item["status"], item["untracked"]) for item in worktree["files"]],
                         [("file.txt", "M", False), ("loose.txt", "A", True)])
        self.assertIn("+worktree", repo.compare_diff("HEAD", "WORKTREE", "file.txt")["diff"])
        self.assertIn("+untracked", repo.compare_diff("HEAD", "WORKTREE", "loose.txt")["diff"])
        self.assertIn("+worktree", repo.compare_diff("INDEX", "WORKTREE", "file.txt")["diff"])
        # Reversed: the index as the newer side of a revision shows the removal of the staged line.
        self.assertIn("-staged", repo.compare_diff("INDEX", "HEAD", "file.txt")["diff"])

    def test_compare_rejects_options_ranges_unknown_revisions_and_a_working_tree_base(self):
        self.initial()
        repo = Repository(self.root)
        for base, target, code in (("--output=/tmp/x", "HEAD", "git_invalid_revision"), ("HEAD~1..HEAD", "HEAD", "git_invalid_revision"),
                                   ("nope", "HEAD", "git_unknown_revision"), ("WORKTREE", "HEAD", "git_invalid_compare"),
                                   ("HEAD", "HEAD", "git_invalid_compare")):
            with self.assertRaises(HTTPException) as error:
                repo.compare(base, target)
            self.assertEqual(error.exception.detail["code"], code, (base, target))

    def test_unborn_unstage_and_literal_filename(self):
        self.write(":(glob)*.txt", "literal\n")
        self.action("stage", paths=[":(glob)*.txt"])
        self.action("unstage", paths=[":(glob)*.txt"])
        self.assertTrue(self.status()["files"][0]["untracked"])
        self.action("stage", paths=[":(glob)*.txt"])
        self.action("commit", message="first")
        self.assertIsNotNone(self.status()["head"])

    def test_linked_worktree_and_renamed_file(self):
        self.initial()
        linked = self.root.parent / "linked"
        self.git("worktree", "add", "-b", "linked", str(linked))
        (linked / "nested").mkdir()
        os.rename(linked / "file.txt", linked / "renamed.txt")
        repository = Repository(linked / "nested")
        before = repository.status()
        self.assertEqual(before["root"], str(linked.resolve()))
        repository.action({"action": "stage", "paths": ["file.txt", "renamed.txt"], "expected_revision": before["revision"]})
        renamed = Repository(linked).status()
        self.assertEqual(renamed["files"][0]["original_path"], "file.txt")
        Repository(linked).action({"action": "unstage", "paths": ["renamed.txt"], "expected_revision": renamed["revision"]})
        self.assertEqual(Repository(linked).status()["staged_count"], 0)

    def merge_conflict(self):
        self.initial()
        self.git("checkout", "-b", "incoming")
        self.write("file.txt", "incoming\n")
        self.git("commit", "-am", "incoming")
        self.git("checkout", "main")
        self.write("file.txt", "current\n")
        self.git("commit", "-am", "current")
        self.git("merge", "incoming", check=False)

    def test_conflict_resolution_and_merge_continue(self):
        self.merge_conflict()
        conflict = Repository(self.root).conflict("file.txt")
        self.assertEqual((conflict["base"], conflict["ours"], conflict["theirs"]), ("base\n", "current\n", "incoming\n"))
        with self.assertRaises(HTTPException):
            self.action("stage", paths=["file.txt"])
        self.action("resolve", path="file.txt", content="combined\n")
        done = self.action("continue")
        self.assertIsNone(done["operation"])
        self.assertEqual(self.git("show", "HEAD:file.txt"), "combined\n")
        self.assertEqual(len(self.git("rev-list", "--parents", "-n", "1", "HEAD").split()), 3)

    def test_continue_rebase_preserves_next_conflict_index(self):
        self.initial(**{"one.txt": "base one\n", "two.txt": "base two\n"})
        self.git("checkout", "-b", "topic")
        self.write("one.txt", "topic one\n")
        self.git("commit", "-am", "topic one")
        self.write("two.txt", "topic two\n")
        self.git("commit", "-am", "topic two")
        self.git("checkout", "main")
        self.write("one.txt", "main one\n")
        self.write("two.txt", "main two\n")
        self.git("commit", "-am", "main changes")
        self.git("checkout", "topic")
        self.git("rebase", "main", check=False)
        self.action("resolve", path="one.txt", content="resolved one\n")
        next_conflict = self.action("continue")
        self.assertEqual(next_conflict["operation"], "rebase")
        self.assertEqual(next_conflict["conflict_count"], 1)
        self.assertTrue(next(item for item in next_conflict["files"] if item["path"] == "two.txt")["conflicted"])
        self.assertIn("two.txt", self.git("ls-files", "--unmerged"))
        self.action("resolve", path="two.txt", content="resolved two\n")
        complete = self.action("continue")
        self.assertIsNone(complete["operation"])
        self.assertEqual(self.git("show", "HEAD:one.txt"), "resolved one\n")
        self.assertEqual(self.git("show", "HEAD:two.txt"), "resolved two\n")

    def test_abort_requires_confirmation_and_preserves_coherent_index(self):
        self.merge_conflict()
        with self.assertRaises(HTTPException) as error:
            self.action("abort")
        self.assertEqual(error.exception.detail["code"], "git_abort_confirmation_required")
        self.assertEqual(self.status()["operation"], "merge")
        result = self.action("abort", confirmed=True)
        self.assertIsNone(result["operation"])
        self.assertEqual(result["files"], [])
        self.assertEqual((self.root / "file.txt").read_text(), "current\n")

    def test_discard_restores_the_staged_version_and_deletes_untracked_files(self):
        self.initial(**{"file.txt": "base\n", "gone.txt": "gone\n"})
        self.write("file.txt", "staged\n")
        self.action("stage", paths=["file.txt"])
        self.write("file.txt", "later\n")
        (self.root / "gone.txt").unlink()
        (self.root / "new").mkdir()
        self.write("new/notes.txt", "draft\n")
        paths = ["file.txt", "gone.txt", "new/notes.txt"]
        with self.assertRaises(HTTPException) as error:
            self.action("discard", paths=paths)
        self.assertEqual(error.exception.detail["code"], "git_discard_confirmation_required")
        result = self.action("discard", paths=paths, confirmed=True)
        self.assertEqual([(item["path"], item["staged"], item["unstaged"]) for item in result["files"]], [("file.txt", True, False)])
        self.assertEqual((self.root / "file.txt").read_text(), "staged\n")
        self.assertEqual((self.root / "gone.txt").read_text(), "gone\n")
        self.assertFalse((self.root / "new" / "notes.txt").exists())
        with self.assertRaises(HTTPException) as error:
            self.action("discard", paths=["file.txt"], confirmed=True)
        self.assertEqual(error.exception.detail["code"], "git_invalid_selection")
        # Checking out a file would run a smudge filter.
        self.git("config", "filter.unused.smudge", "cat")
        self.write(".gitattributes", "gone.txt filter=unused\n")
        self.write("gone.txt", "changed\n")
        with self.assertRaises(HTTPException) as error:
            self.action("discard", paths=["gone.txt"], confirmed=True)
        self.assertEqual(error.exception.detail["code"], "git_custom_driver")

    def test_paths_and_concurrent_index_are_guarded(self):
        self.initial()
        self.write("file.txt", "changed\n")
        (self.root / "escape").symlink_to(self.root.parent, target_is_directory=True)
        for path in ("../outside", ".git/config", "escape/outside", "/absolute"):
            with self.subTest(path=path), self.assertRaises(HTTPException):
                Repository(self.root).diff(path, "unstaged")
        (self.root / ".git" / "index.lock").write_text("owned by another command")
        with self.assertRaises(HTTPException) as error:
            self.action("stage", paths=["file.txt"])
        self.assertEqual(error.exception.detail["code"], "git_index_locked")
        self.assertEqual((self.root / ".git" / "index.lock").read_text(), "owned by another command")

    def test_hooks_and_active_filters_are_not_silently_skipped(self):
        self.initial()
        self.git("config", "filter.unused.clean", "cat")
        self.write("file.txt", "change\n")
        self.action("stage", paths=["file.txt"])
        hook = self.root / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 0\n")
        hook.chmod(0o755)
        with self.assertRaises(HTTPException) as error:
            self.action("commit", message="blocked")
        self.assertEqual(error.exception.detail["code"], "git_hooks_require_terminal")
        self.write(".gitattributes", "file.txt filter=unused\n")
        with self.assertRaises(HTTPException) as error:
            self.action("stage", paths=["file.txt"])
        self.assertEqual(error.exception.detail["code"], "git_custom_driver")

    def test_disk_full_allocating_snapshot_releases_real_index_lock(self):
        self.initial()
        self.write("file.txt", "change\n")
        with patch("workspace_git.tempfile.mkstemp", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            with self.assertRaises(HTTPException) as error:
                self.action("stage", paths=["file.txt"])
        self.assertEqual(error.exception.detail["code"], "git_storage_failure")
        self.assertFalse((self.root / ".git" / "index.lock").exists())
        self.assertEqual(self.action("stage", paths=["file.txt"])["staged_count"], 1)

    def test_publish_failure_after_abort_retains_correct_index_and_blocks_writes(self):
        self.merge_conflict()
        with patch("workspace_git.os.replace", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            with self.assertRaises(HTTPException) as error:
                self.action("abort", confirmed=True)
        detail = error.exception.detail
        self.assertEqual(detail["code"], "git_index_recovery_required")
        recovery = Path(detail["recovery_index"])
        lock = Path(detail["lock_path"])
        self.assertTrue(recovery.is_file())
        self.assertTrue(lock.is_file())
        self.assertFalse((self.root / ".git" / "MERGE_HEAD").exists())
        self.assertEqual((self.root / "file.txt").read_text(), "current\n")
        recovered = subprocess.run(["git", "ls-files", "--unmerged"], cwd=self.root,
                                   env={**os.environ, "GIT_INDEX_FILE": str(recovery)},
                                   capture_output=True, check=True)
        self.assertEqual(recovered.stdout, b"")
        self.assertIn("file.txt", self.git("ls-files", "--unmerged"))
        with self.assertRaises(HTTPException) as blocked:
            self.action("stage", paths=["file.txt"])
        self.assertEqual(blocked.exception.detail["code"], "git_index_locked")
        self.assertTrue(recovery.exists())
        # Exercise the error's exact recovery instructions in this disposable repo.
        os.replace(recovery, Path(detail["index_path"]))
        lock.unlink()
        self.assertEqual(self.status()["files"], [])


if __name__ == "__main__":
    unittest.main()
