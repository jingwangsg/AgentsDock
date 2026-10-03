"""A turn that fails on a model capacity error is resent as the user message "go on"."""
import asyncio
import tempfile
import unittest
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import agent_server as server

CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model."


class ModelCapacityErrorPatternTests(unittest.TestCase):
    def test_matches_codex_and_claude_capacity_messages(self):
        for message in (
            CAPACITY_MESSAGE,
            "Server overloaded; retry later.",
            'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        ):
            self.assertTrue(server.MODEL_CAPACITY_ERROR_RE.search(message), message)

    def test_ignores_other_failures(self):
        for message in (
            "Invalid value: max. Supported values are: none, minimal, low, medium, high, and xhigh.",
            "killed after idle timeout",
            "Codex exited 1 without error output.",
            'Traceback (most recent call last):\n  File "runner.py", line 529, in main\nRuntimeError: boom',
            "",
        ):
            self.assertFalse(server.MODEL_CAPACITY_ERROR_RE.search(message), repr(message))


class ModelCapacityResendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = server.SessionStore()
        self.store.save = AsyncMock()
        self.sess = {"id": "chat-1", "backend": "codex", "title": "Chat", "cwd": "/tmp", "folder": "General"}
        self.store.sessions = {"chat-1": self.sess}
        self.attempts = {}
        self.run_ids = set()
        self.tasks = {}
        self.queued = {}
        self.busy = set()
        for target, value in (
            ("STORE", self.store),
            ("MODEL_CAPACITY_RESEND_ATTEMPTS", self.attempts),
            ("MODEL_CAPACITY_ERROR_RUNS", self.run_ids),
            ("SESSION_TURN_TASKS", self.tasks),
            ("QUEUED_TURNS", self.queued),
            ("RUN_NOW_TURNS", {}),
            ("BUSY_SESSIONS", self.busy),
            ("SERVER_SHUTTING_DOWN", False),
        ):
            self.enterContext(patch.object(server, target, value))
        self.start_turn = self.enterContext(patch.object(server, "start_turn", new_callable=AsyncMock))
        self.enterContext(patch.object(server, "refresh_native_session_title", new_callable=AsyncMock))
        self.enterContext(patch.object(server, "finalize_cross_chat_terminal", new_callable=AsyncMock))
        self.enterContext(patch.object(server, "schedule_generated_session_title"))

        async def append(session_id, event_type, payload=None):
            return {"id": "evt", "seq": 1, "session_id": session_id, "type": event_type, **(payload or {})}

        self.enterContext(patch.object(server, "append_event", side_effect=append))

    async def finish(self, run_id="run-1", **changes):
        payload = {"run_id": run_id, "backend": "codex", "exit_code": 1, "result_text": "", "stopped": False}
        await server.append_turn_finished_event("chat-1", {**payload, **changes})
        await asyncio.gather(*tuple(self.tasks.get("chat-1", ())))

    async def test_failed_capacity_turn_resends_go_on(self):
        self.run_ids.add("run-1")
        await self.finish()
        self.start_turn.assert_awaited_once()
        session_id, req = self.start_turn.await_args.args
        self.assertEqual(session_id, "chat-1")
        self.assertEqual(req.prompt, "go on")
        self.assertIsNone(req.display_prompt)
        self.assertEqual(req.client_capabilities, ["codex_interactive_v1"])
        self.assertEqual(self.attempts, {"chat-1": 1})
        self.assertEqual(self.run_ids, set())
        self.assertEqual(self.tasks, {})

    async def test_claude_resend_keeps_the_sdk_transport(self):
        self.sess["backend"] = "claude"
        self.run_ids.add("run-1")
        await self.finish()
        self.assertEqual(self.start_turn.await_args.args[1].client_capabilities, ["claude_sdk_interactive_v1"])

    async def test_start_failure_terminal_is_resent(self):
        self.run_ids.add("run-1")
        await self.finish(exit_code=None)
        self.start_turn.assert_awaited_once()

    async def test_consecutive_resends_stop_at_the_limit(self):
        for index in range(server.MODEL_CAPACITY_RESEND_LIMIT):
            self.run_ids.add(f"run-{index}")
            await self.finish(f"run-{index}")
        self.assertEqual(self.start_turn.await_count, server.MODEL_CAPACITY_RESEND_LIMIT)
        self.run_ids.add("run-over")
        with self.assertLogs(server.logger, level="WARNING") as logs:
            await self.finish("run-over")
        self.assertEqual(self.start_turn.await_count, server.MODEL_CAPACITY_RESEND_LIMIT)
        self.assertTrue(any("resend limit reached" in line for line in logs.output))
        self.assertEqual(self.attempts, {"chat-1": server.MODEL_CAPACITY_RESEND_LIMIT})

    async def test_terminal_without_capacity_failure_resets_the_budget(self):
        for name, changes in {
            "normal completion": dict(run_id="run-ok", exit_code=0, result_text="Done."),
            "other failure": dict(run_id="run-other"),
            "capacity run stopped": dict(stopped=True, exit_code=None),
            "capacity error then completion": dict(exit_code=0, result_text="Recovered."),
        }.items():
            with self.subTest(name):
                self.attempts["chat-1"] = server.MODEL_CAPACITY_RESEND_LIMIT
                if changes.get("run_id", "run-1") == "run-1":
                    self.run_ids.add("run-1")
                await self.finish(**changes)
                self.start_turn.assert_not_awaited()
                self.assertEqual(self.attempts, {})
                self.assertEqual(self.run_ids, set())

    async def test_user_message_resets_the_budget(self):
        self.attempts["chat-1"] = server.MODEL_CAPACITY_RESEND_LIMIT
        with patch.object(server, "admit_turn", new_callable=AsyncMock, return_value={"ok": True}):
            await server.post_turn("chat-1", server.TurnRequest(prompt="go on"))
        self.assertEqual(self.attempts, {})

    async def test_resend_failure_is_logged_not_raised(self):
        self.start_turn.side_effect = server.HTTPException(status_code=409, detail="archived chats cannot start turns")
        self.run_ids.add("run-1")
        with self.assertLogs(server.logger, level="WARNING") as logs:
            await self.finish()
        self.assertTrue(any("resend failed" in line for line in logs.output))

    async def test_chats_with_other_work_are_left_alone(self):
        def queued():
            self.queued["chat-1"] = deque([{"queued_id": "queued-1", "prompt": "next"}])

        def busy():
            self.busy.add("chat-1")

        cases = {
            "job run": ({"purpose": "scheduled_job"}, None),
            "queued message continues instead": ({}, queued),
            "message admitted meanwhile": ({}, busy),
        }
        for name, (changes, arrange) in cases.items():
            with self.subTest(name):
                if arrange:
                    arrange()
                self.run_ids.add("run-1")
                await self.finish(**changes)
                self.start_turn.assert_not_awaited()
                self.assertEqual(self.run_ids, set())
                self.assertEqual(self.attempts, {})
            self.queued.clear()
            self.busy.clear()


class ModelCapacityErrorRecordingTests(unittest.IsolatedAsyncioTestCase):
    """The real append_event marks the failing run so the terminal can resend."""

    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.store = server.SessionStore()
        self.store.save = AsyncMock()
        self.store.sessions = {"chat-1": {"id": "chat-1", "backend": "codex", "title": "Chat"}}
        self.run_ids = set()
        for target, value in (
            ("STATE_DIR", root / "state"),
            ("SESSIONS_FILE", root / "state" / "sessions.json"),
            ("STORE", self.store),
            ("EVENT_SEQ_CACHE", {}),
            ("EVENT_SEQ_LOCK", asyncio.Lock()),
            ("EVENT_DELIVERY_LOCKS", {}),
            ("HISTORY_SEARCH_DIRTY", set()),
            ("DELETING_SESSIONS", set()),
            ("DELETED_SESSION_TOMBSTONES", set()),
            ("MODEL_CAPACITY_ERROR_RUNS", self.run_ids),
            ("HUB", SimpleNamespace(broadcast=AsyncMock())),
            ("INTERACTIVE_CHAT_LIVE", SimpleNamespace(notify=Mock())),
        ):
            self.enterContext(patch.object(server, target, value))

    async def test_capacity_error_event_marks_its_run(self):
        await server.append_event("chat-1", "error", {"run_id": "run-1", "backend": "codex", "message": CAPACITY_MESSAGE})
        await server.append_event("chat-1", "error", {"run_id": "run-2", "backend": "claude", "message": "killed after idle timeout"})
        await server.append_event("chat-1", "assistant_text", {"run_id": "run-3", "text": CAPACITY_MESSAGE})
        self.assertEqual(self.run_ids, {"run-1"})


if __name__ == "__main__":
    unittest.main()
