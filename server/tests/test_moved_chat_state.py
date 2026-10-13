"""Carrying a chat's state from a sibling install; synthetic installs under one temp home."""
import asyncio
from contextlib import nullcontext
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_server
import moved_chat_state
import side_questions

OLD_ID = "sess_00000000000000aa"
NEW_ID = "sess_00000000000000bb"
KEYS = {("claude", "claude-conversation")}


class Installs:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="moved-chat-state-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.old = self.install(".agentsdock-server-old", {OLD_ID: {"backend": "claude", "claude_session_id": "claude-conversation"}})
        self.new = self.install(".agentsdock-server-new", {})

    def install(self, name, sessions):
        state = self.home / name / "state"
        state.mkdir(parents=True)
        (state / "sessions.json").write_text(json.dumps(sessions))
        return state

    def canvas(self, state, session_id, name="report"):
        directory = state / "canvases" / session_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{name}.canvas.tsx").write_text("export default () => null\n")
        (directory / f"{name}.canvas.comments.json").write_text('{"threads": []}')
        os.utime(directory / f"{name}.canvas.tsx", (1_700_000_000, 1_700_000_000))
        return directory

    def published_file(self, state, file_id, session_id, payload=b"video"):
        directory = state / "files" / file_id
        directory.mkdir(parents=True)
        (directory / "clip.mp4").write_bytes(payload)
        meta = {"id": file_id, "session_id": session_id, "kind": "artifact", "path": str(directory / "clip.mp4"),
                "filename": "clip.mp4", "size": len(payload)}
        (directory / "meta.json").write_text(json.dumps(meta, indent=2))
        return meta

    def side_chat(self, state, session_id, *copies):
        with sqlite3.connect(state / "side_chats.sqlite3") as database:
            database.execute("CREATE TABLE IF NOT EXISTS chats (owner TEXT, session TEXT, document TEXT NOT NULL, PRIMARY KEY(owner, session))")
            for owner, exchanges in copies:
                document = {"session_id": session_id, "side_chat_id": "side", "revision": 1, "exchanges": exchanges,
                            "last_request_id": None, "_provider_state": {"backend": "claude"}}
                database.execute("INSERT INTO chats VALUES(?,?,?)", (owner, session_id, json.dumps(document)))
        database.close()


class CarryOverTests(Installs, unittest.TestCase):
    def carry(self):
        return moved_chat_state.carry_over(self.new, NEW_ID, KEYS, "claude")

    def test_the_only_owner_gives_its_canvases_files_and_side_chat_to_the_new_chat(self):
        source = self.canvas(self.old, OLD_ID)
        meta = self.published_file(self.old, "art_0000000000000001", OLD_ID)
        self.published_file(self.old, "art_0000000000000002", "sess_someone_else_")
        self.side_chat(self.old, OLD_ID, ("old-owner", [{"request_id": "r1", "status": "completed"}]))
        before = sorted((path.name, path.read_bytes()) for path in source.iterdir())

        summary, side_chat = self.carry()

        target = self.new / "canvases" / NEW_ID
        self.assertEqual(sorted((path.name, path.read_bytes()) for path in target.iterdir()), before)
        self.assertEqual((target / "report.canvas.tsx").stat().st_mtime, 1_700_000_000)
        copied = json.loads((self.new / "files" / "art_0000000000000001" / "meta.json").read_text())
        self.assertEqual(copied, {**meta, "session_id": NEW_ID,
                                  "path": str(self.new / "files" / "art_0000000000000001" / "clip.mp4")})
        self.assertEqual(Path(copied["path"]).read_bytes(), b"video")
        self.assertFalse((self.new / "files" / "art_0000000000000002").exists())
        self.assertEqual(side_chat["exchanges"], [{"request_id": "r1", "status": "completed"}])
        self.assertEqual(summary, f"from=.agentsdock-server-old/{OLD_ID} canvases=1 files=1")
        # The old install is only read.
        self.assertEqual(sorted((path.name, path.read_bytes()) for path in source.iterdir()), before)
        self.assertEqual(json.loads((self.old / "files" / "art_0000000000000001" / "meta.json").read_text()), meta)

    def test_two_owners_carry_nothing(self):
        self.canvas(self.old, OLD_ID)
        second = self.install(".agentsdock-server-third", {"sess_00000000000000cc": {"backend": "claude", "claude_session_id": "claude-conversation"}})
        self.canvas(second, "sess_00000000000000cc")

        summary, side_chat = self.carry()

        self.assertEqual(summary, "nothing carried owners=2 sibling_installs=2 "
                                  f"(.agentsdock-server-old/{OLD_ID}, .agentsdock-server-third/sess_00000000000000cc)")
        self.assertIsNone(side_chat)
        self.assertFalse((self.new / "canvases").exists())

    def test_a_deleted_earlier_chat_leaves_its_canvas_behind(self):
        # Deleting a chat removes its sessions.json row but not its canvas directory.
        self.canvas(self.old, OLD_ID)
        (self.old / "sessions.json").write_text("{}")

        summary, side_chat = self.carry()

        self.assertEqual(summary, "nothing carried owners=0 sibling_installs=1")
        self.assertIsNone(side_chat)
        self.assertFalse((self.new / "canvases").exists())

    def test_an_install_without_siblings_returns_no_summary(self):
        lone = Path(tempfile.mkdtemp(dir=self.home)) / ".agentsdock-server" / "state"
        lone.mkdir(parents=True)

        self.assertEqual(moved_chat_state.carry_over(lone, NEW_ID, KEYS, "claude"), (None, None))

    def test_files_over_the_limit_stay_behind_while_canvases_move(self):
        self.canvas(self.old, OLD_ID)
        self.published_file(self.old, "art_0000000000000001", OLD_ID, payload=b"x" * 100)

        with patch.object(moved_chat_state, "MAX_CARRIED_FILE_BYTES", 50):
            summary, _ = self.carry()

        self.assertIn("canvases=1 files=0 files_left_behind=1", summary)
        self.assertTrue((self.new / "canvases" / NEW_ID / "report.canvas.tsx").is_file())
        self.assertFalse((self.new / "files").exists())

    def test_symlinks_are_not_followed_out_of_the_install(self):
        source = self.canvas(self.old, OLD_ID)
        outside = self.home / "private.txt"
        outside.write_text("secret")
        (source / "leak.canvas.tsx").symlink_to(outside)

        summary, _ = self.carry()

        self.assertFalse((self.new / "canvases" / NEW_ID / "leak.canvas.tsx").exists())
        self.assertIn("canvases=1", summary)

    def test_an_existing_record_of_the_same_file_is_kept(self):
        self.published_file(self.old, "art_0000000000000001", OLD_ID, payload=b"old")
        mine = self.published_file(self.new, "art_0000000000000001", NEW_ID, payload=b"mine")

        summary, _ = self.carry()

        self.assertIn("files=0", summary)
        self.assertEqual(json.loads((self.new / "files" / "art_0000000000000001" / "meta.json").read_text()), mine)

    def test_staging_leftovers_are_skipped_and_one_failed_copy_does_not_stop_the_others(self):
        self.published_file(self.old, ".art_0000000000000001-interrupted", OLD_ID)
        self.published_file(self.old, "art_0000000000000002", OLD_ID)
        self.published_file(self.old, "art_0000000000000003", OLD_ID)
        copy = moved_chat_state.shutil.copy2

        def copy2(source, target):
            if "art_0000000000000002" in str(source):
                raise PermissionError("denied")
            return copy(source, target)

        with patch.object(moved_chat_state.shutil, "copy2", copy2):
            summary, _ = self.carry()

        self.assertEqual(sorted(path.name for path in (self.new / "files").iterdir()), ["art_0000000000000003"])
        self.assertIn("files=1 file_not_copied=art_0000000000000002 (denied)", summary)

    def test_empty_side_chats_are_ignored_and_two_non_empty_ones_are_left_behind(self):
        self.side_chat(self.old, OLD_ID, ("a", []), ("b", [{"request_id": "r1", "status": "completed"}]))
        self.assertEqual(self.carry()[1]["exchanges"], [{"request_id": "r1", "status": "completed"}])

        (self.old / "side_chats.sqlite3").unlink()
        self.side_chat(self.old, OLD_ID, ("a", [{"request_id": "r1"}]), ("b", [{"request_id": "r2"}]))
        summary, side_chat = self.carry()
        self.assertIsNone(side_chat)
        self.assertIn("side_chat=left_behind copies=2", summary)


class ImportCarriesStateTests(Installs, unittest.IsolatedAsyncioTestCase):
    """Both import routes, on a real session store under the new install."""

    def setUp(self):
        super().setUp()
        self.cwd = self.home / "workspace"
        self.cwd.mkdir()
        projects = self.home / ".claude" / "projects"
        transcript = projects / agent_server.claude_project_dir_for_cwd(str(self.cwd)).name / "claude-conversation.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(
            json.dumps({"type": "user", "sessionId": "claude-conversation", "cwd": str(self.cwd),
                        "message": {"role": "user", "content": "question"}}) + "\n"
            + json.dumps({"type": "assistant", "sessionId": "claude-conversation", "cwd": str(self.cwd),
                          "message": {"role": "assistant", "content": [{"type": "text", "text": "answer"}]}}) + "\n")
        self.store = agent_server.SessionStore()
        self.side_chats = side_questions.SideQuestions(storage_path=self.new / "side_chats.sqlite3")
        self.addAsyncCleanup(self.side_chats.close)
        for name, value in (("STATE_DIR", self.new), ("SESSIONS_FILE", self.new / "sessions.json"),
                            ("STORE", self.store), ("CLAUDE_PROJECTS_ROOT", projects), ("AGENT_TOKEN", "new-token"),
                            ("SIDE_QUESTIONS", self.side_chats), ("local_codex_session_candidates", lambda *a, **k: []),
                            ("other_local_instance_provider_keys", lambda: set()),
                            ("local_history_import_guard", nullcontext)):
            self.enterContext(patch.object(agent_server, name, value))
        self.enterContext(patch.object(agent_server, "ensure_dirs", side_effect=lambda session_id=None:
            (agent_server.session_dir(session_id) if session_id else self.new).mkdir(parents=True, exist_ok=True)))
        self.canvas(self.old, OLD_ID)
        self.published_file(self.old, "art_0000000000000001", OLD_ID)
        self.side_chat(self.old, OLD_ID, ("old-owner", [{"request_id": "r1", "question": "q", "status": "completed",
                                                         "answer": "a", "created_at": 1, "updated_at": 1}]))

    async def carried_in_background(self):
        # The copy runs as a task after the import has answered.
        tasks = [task for task in asyncio.all_tasks() if task.get_coro().__name__ == "carry_over_moved_chat_state"]
        self.assertEqual(len(tasks), 1)
        await tasks[0]

    def assert_carried(self, session_id):
        self.assertTrue((self.new / "canvases" / session_id / "report.canvas.tsx").is_file())
        self.assertEqual(json.loads((self.new / "files" / "art_0000000000000001" / "meta.json").read_text())["session_id"], session_id)
        owner = hashlib.sha256(b"new-token").hexdigest()
        self.assertEqual(self.side_chats.synced.store.load(owner, session_id)["exchanges"][0]["request_id"], "r1")

    def import_request(self):
        return agent_server.BulkImportSessionsRequest(items=[{
            "provider_session_id": "claude-conversation", "backend": "claude", "cwd": str(self.cwd)}])

    async def test_bulk_import_carries_the_earlier_chat_state(self):
        with self.assertLogs(agent_server.logger, "INFO") as logs:
            result = (await agent_server.bulk_import_sessions_guarded(self.import_request(), set()))["results"][0]
            await self.carried_in_background()

        self.assertTrue(result["ok"], result)
        self.assert_carried(result["session_id"])
        self.assertIn(f"from=.agentsdock-server-old/{OLD_ID} canvases=1 files=1 side_chat=carried", "\n".join(logs.output))

    async def test_resuming_a_provider_conversation_carries_the_earlier_chat_state(self):
        created = await agent_server.create_session(agent_server.CreateSessionRequest(
            backend="claude", claude_session_id="claude-conversation", cwd=str(self.cwd)))
        await self.carried_in_background()

        self.assert_carried(created["session"]["id"])

    async def test_a_failed_copy_keeps_the_imported_chat(self):
        with patch.object(moved_chat_state, "carry_over", side_effect=OSError("disk full")), \
                self.assertLogs(agent_server.logger, "WARNING") as logs:
            result = (await agent_server.bulk_import_sessions_guarded(self.import_request(), set()))["results"][0]
            await self.carried_in_background()

        self.assertTrue(result["ok"], result)
        self.assertIn(result["session_id"], self.store.sessions)
        self.assertIn("chat state carry-over failed", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
