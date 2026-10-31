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

    def title_earlier_chat(self, title):
        (self.old / "sessions.json").write_text(json.dumps({OLD_ID: {
            "backend": "claude", "claude_session_id": "claude-conversation", "title": title, "updated_at": "2026-10-17T00:00:00Z"}}))

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


class EarlierTitlesTests(Installs, unittest.TestCase):
    def titles(self):
        return moved_chat_state.earlier_chat_titles(self.new, "claude")

    def test_the_earlier_chat_names_its_conversation(self):
        self.title_earlier_chat("N2 takeover")

        self.assertEqual(self.titles(), {("claude", "claude-conversation"): "N2 takeover"})

    def test_an_untitled_earlier_chat_names_nothing(self):
        self.assertEqual(self.titles(), {})

    def test_the_latest_of_several_earlier_chats_names_the_conversation(self):
        # A second move leaves the conversation in both earlier installs.
        self.title_earlier_chat("N2 takeover")
        self.install(".agentsdock-server-a-newer", {"sess_00000000000000cc": {
            "backend": "claude", "claude_session_id": "claude-conversation", "title": "N2 eval", "updated_at": "2026-10-18T00:00:00Z"}})

        self.assertEqual(self.titles(), {("claude", "claude-conversation"): "N2 eval"})


class EarlierRuntimesTests(Installs, unittest.TestCase):
    def runtimes(self):
        return moved_chat_state.earlier_chat_runtimes(self.new, "claude")

    def test_the_latest_earlier_chat_gives_the_model_even_when_another_ties_without_one(self):
        (self.old / "sessions.json").write_text(json.dumps({OLD_ID: {
            "backend": "claude", "claude_session_id": "claude-conversation", "model": "opus", "effort": "high",
            "updated_at": "2026-10-17T00:00:00Z"}}))
        for name, session_id, model in ((".agentsdock-server-a-newer", "sess_00000000000000cc", "sonnet"),
                                        (".agentsdock-server-b-tie", "sess_00000000000000dd", None)):
            self.install(name, {session_id: {"backend": "claude", "claude_session_id": "claude-conversation",
                                             "model": model, "effort": model and "max", "updated_at": "2026-10-18T00:00:00Z"}})

        self.assertEqual(self.runtimes(), {("claude", "claude-conversation"): ("sonnet", "max")})

    def test_a_parked_identity_of_another_backend_gives_no_model(self):
        (self.old / "sessions.json").write_text(json.dumps({OLD_ID: {
            "backend": "claude", "claude_session_id": "claude-conversation", "codex_thread_id": "codex-conversation",
            "model": "opus", "effort": "high"}}))

        self.assertEqual(self.runtimes(), {("claude", "claude-conversation"): ("opus", "high")})


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

    async def resume_list(self):
        return [(row["provider_session_id"], row["label"]) for row in (await agent_server.get_local_sessions(limit=200))["sessions"]]

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

    async def test_the_resume_list_and_the_imported_chat_take_the_earlier_chat_title(self):
        self.title_earlier_chat("N2 takeover")

        self.assertEqual(await self.resume_list(), [("claude-conversation", "N2 takeover")])
        result = (await agent_server.bulk_import_sessions_guarded(self.import_request(), set()))["results"][0]
        await self.carried_in_background()
        self.assertEqual(self.store.sessions[result["session_id"]]["title"], "N2 takeover")

    async def test_an_unreadable_sibling_index_keeps_the_provider_titles(self):
        provider_titles = await self.resume_list()
        (self.old / "sessions.json").write_text("{")

        with self.assertLogs(agent_server.logger, "WARNING") as logs:
            self.assertEqual(await self.resume_list(), provider_titles)
        self.assertIn("earlier chat titles unavailable", "\n".join(logs.output))


def picker(models, efforts=("low", "medium", "high", "xhigh", "max")):
    """A runtime catalog's model and effort rows, led by the server-default row."""
    return {"models": [{"value": "", "label": "Server default"}, *({"value": value, "label": label} for value, label in models)],
            "efforts": [{"value": "", "label": "Server default"}, *({"value": effort, "label": effort} for effort in efforts)]}


# The rows of Claude's native picker on a real hub (2026-10-31): aliases are labelled by what they resolve to.
CLAUDE_PICKER = picker((("default", "Default — Sonnet 5.5"), ("opus", "Opus 5.5"), ("claude-opus-5", "Opus 5"),
                        ("sonnet", "Sonnet 5.5"), ("haiku", "Haiku 5.5")))
CODEX_PICKER = picker((("gpt-6.1-sol", "GPT-6.1-Sol"), ("gpt-6-luna", "GPT-6-Luna")))


class ResumeKeepsModelTests(Installs, unittest.IsolatedAsyncioTestCase):
    """Resume chat continues on the model and effort the conversation last used."""

    def setUp(self):
        super().setUp()
        self.cwd = self.home / "workspace"
        self.cwd.mkdir()
        projects = self.home / ".claude" / "projects"
        rows = [{"type": "user", "message": {"role": "user", "content": "question"}},
                {"type": "assistant", "requestedModel": "claude-opus-5-5", "effort": "high",
                 "message": {"model": "claude-opus-5-5", "role": "assistant", "content": [{"type": "text", "text": "answer"}]}},
                # The CLI's own error notice is not the conversation's model.
                {"type": "assistant", "isApiErrorMessage": True,
                 "message": {"model": "<synthetic>", "role": "assistant", "content": [{"type": "text", "text": "API Error"}]}}]
        transcript = projects / agent_server.claude_project_dir_for_cwd(str(self.cwd)).name / "claude-conversation.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text("".join(json.dumps({**row, "sessionId": "claude-conversation", "cwd": str(self.cwd)}) + "\n" for row in rows))
        rollout = self.home / ".codex" / "sessions" / "2026" / "10" / "31" / "rollout-2026-10-31T00-00-00-codex-conversation.jsonl"
        rollout.parent.mkdir(parents=True)
        rollout.write_text("".join(json.dumps(row) + "\n" for row in (
            {"type": "session_meta", "payload": {"id": "codex-conversation", "cwd": str(self.cwd)}},
            {"type": "turn_context", "payload": {"model": "gpt-6.1-sol", "effort": "xhigh"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "question"}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "answer"}},
            {"type": "turn_context", "payload": {"model": "gpt-6-luna", "effort": "low"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "follow-up"}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "done"}},
        )))
        self.store = agent_server.SessionStore()
        self.side_chats = side_questions.SideQuestions(storage_path=self.new / "side_chats.sqlite3")
        self.addAsyncCleanup(self.side_chats.close)
        for name, value in (("STATE_DIR", self.new), ("SESSIONS_FILE", self.new / "sessions.json"),
                            ("STORE", self.store), ("CLAUDE_PROJECTS_ROOT", projects),
                            ("CODEX_SESSIONS_ROOT", rollout.parents[3]), ("CODEX_SESSION_INDEX_PATH", self.home / "no-index"),
                            ("AGENT_TOKEN", "new-token"), ("SIDE_QUESTIONS", self.side_chats),
                            ("other_local_instance_provider_keys", lambda: set()), ("local_history_import_guard", nullcontext),
                            ("parse_claude_help_catalog", lambda: CLAUDE_PICKER),
                            ("discover_codex_catalog", lambda: CODEX_PICKER)):
            self.enterContext(patch.object(agent_server, name, value))
        self.enterContext(patch.object(agent_server, "ensure_dirs", side_effect=lambda session_id=None:
            (agent_server.session_dir(session_id) if session_id else self.new).mkdir(parents=True, exist_ok=True)))

    async def model_and_effort(self, session_id):
        # Await the background carry-over so it does not run after the patches are undone.
        await asyncio.gather(*(task for task in asyncio.all_tasks()
                               if task.get_coro().__name__ == "carry_over_moved_chat_state"))
        session = self.store.sessions[session_id]
        return session["model"], session["effort"]

    async def import_chat(self, backend, provider_id):
        result = (await agent_server.bulk_import_sessions_guarded(agent_server.BulkImportSessionsRequest(items=[{
            "provider_session_id": provider_id, "backend": backend, "cwd": str(self.cwd)}]), set()))["results"][0]
        self.assertTrue(result["ok"], result)
        return await self.model_and_effort(result["session_id"])

    async def test_a_claude_chat_continues_on_the_transcript_model_and_effort(self):
        # The transcript records the resolved ID; the picker offers it as the "opus" alias.
        self.assertEqual(await self.import_chat("claude", "claude-conversation"), ("opus", "high"))

    async def test_a_codex_chat_continues_on_the_rollout_model_and_effort(self):
        self.assertEqual(await self.import_chat("codex", "codex-conversation"), ("gpt-6-luna", "low"))

    async def test_an_effort_the_codex_model_no_longer_supports_is_dropped_and_the_chat_still_starts(self):
        with patch.object(agent_server, "codex_model_supported_efforts", lambda model: ("medium", "high")):
            self.assertEqual(await self.import_chat("codex", "codex-conversation"), ("gpt-6-luna", None))

    async def test_an_unreadable_sibling_index_still_leaves_the_transcript(self):
        (self.old / "sessions.json").write_text("{")

        with self.assertLogs(agent_server.logger, "WARNING") as logs:
            self.assertEqual(await self.import_chat("claude", "claude-conversation"), ("opus", "high"))
        self.assertIn("earlier chat runtimes unavailable", "\n".join(logs.output))

    async def test_the_earlier_chat_model_comes_before_the_transcript(self):
        (self.old / "sessions.json").write_text(json.dumps({OLD_ID: {
            "backend": "claude", "claude_session_id": "claude-conversation", "model": "sonnet", "effort": "max",
            "updated_at": "2026-10-17T00:00:00Z"}}))

        self.assertEqual(await self.import_chat("claude", "claude-conversation"), ("sonnet", "max"))

    async def test_a_model_missing_from_the_picker_keeps_the_default(self):
        without_opus = picker((("default", "Default — Sonnet 5.5"), ("sonnet", "Sonnet 5.5")))

        with patch.object(agent_server, "parse_claude_help_catalog", lambda: without_opus), \
                self.assertLogs(agent_server.logger, "INFO") as logs:
            self.assertEqual(await self.import_chat("claude", "claude-conversation"), (None, None))
        self.assertIn("resumed chat claude claude-conversation keeps the default model: claude-opus-5-5 from the "
                      "transcript is not in this server's picker", "\n".join(logs.output))

    async def test_resume_by_id_continues_on_the_conversation_model_unless_one_is_picked(self):
        created = await agent_server.create_session(agent_server.CreateSessionRequest(
            backend="codex", provider_session_id="codex-conversation", cwd=str(self.cwd)))
        self.assertEqual(await self.model_and_effort(created["session"]["id"]), ("gpt-6-luna", "low"))

        chosen = await agent_server.create_session(agent_server.CreateSessionRequest(
            backend="claude", provider_session_id="claude-conversation", cwd=str(self.cwd), model="sonnet"))
        self.assertEqual(await self.model_and_effort(chosen["session"]["id"]), ("sonnet", None))


if __name__ == "__main__":
    unittest.main()
