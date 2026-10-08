"""A message sent while Claude works joins the turn as Claude Code's composer does; Send now needs no route match."""
import asyncio
import unittest
from collections import deque
from unittest.mock import AsyncMock, patch

import agent_server

# Must satisfy PROVIDER_CROSS_CHAT_ROUTE_ID_RE / _REVISION_RE and carry an alias and actions: a
# malformed route is normalized away and the snapshot would read as route-free.
DURABLE_ROUTE = {
    "route_id": "route_" + "a" * 32, "revision": "rev_" + "b" * 32, "target_session_id": "sess_other",
    "alias": "other", "actions": ["instruction", "request_reply"],
}


def queued_item(backend: str) -> dict:
    return {
        "queued_id": "q1", "prompt": "go on", "request_prompt": "go on", "display_prompt": None, "file_ids": [],
        "backend": backend, "client_capabilities": [agent_server.CLAUDE_SDK_INTERACTIVE_CLIENT_CAPABILITY],
        # The chat's own standing route, which the running turn does not hold.
        "provider_cross_chat_route_snapshot": [dict(DURABLE_ROUTE)],
        "provider_team_mail_route_snapshot": [],
    }


class ClaudeFollowUpSteerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.steer_queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self.stack = [
            patch.dict(agent_server.STORE.sessions, {"chat": {"id": "chat", "backend": "claude"}}),
            patch.dict(agent_server.CURRENT_TURNS, {"chat": {"run_id": "run-1", "provider_cross_chat_route_snapshot": []}}),
            patch.object(agent_server, "stop_cleanup_in_progress", return_value=False),
            patch.object(agent_server, "managed_server_update_admission_blocker", return_value=None),
            patch.object(agent_server, "codex_goal_followup_requires_native", return_value=False),
            patch.object(agent_server, "queued_claude_runtime_matches_active", return_value=True),
            patch.object(agent_server, "queued_codex_runtime_matches_active", return_value=True),
        ]
        for entry in self.stack:
            entry.start()
            self.addCleanup(entry.stop)
        self.addCleanup(agent_server.STEERING_SESSIONS.discard, "chat")
        self.addCleanup(agent_server.RUN_NOW_TURNS.pop, "chat", None)

    def _active(self, transport: str) -> dict:
        return {
            "run_id": "run-1", "transport": transport, "provider_turn_ready": True,
            "native_steer_queue": self.steer_queue, "provider_cross_chat_route_snapshot": [],
        }

    async def test_a_plain_message_joins_a_claude_turn_as_a_queued_frame_whatever_the_routes(self) -> None:
        with patch.dict(agent_server.ACTIVE, {"chat": self._active(agent_server.CLAUDE_TRANSPORT_AGENT_SDK)}), \
             patch.dict(agent_server.QUEUED_TURNS, {"chat": deque([queued_item("claude")])}):
            steer = asyncio.create_task(agent_server._run_queued_turn_now_once("chat", "q1", deliver_now=False, steer_only=True))
            request = await asyncio.wait_for(self.steer_queue.get(), 5)
            # The runner hands this to the CLI as a frame the model reads at its next step, not "now".
            self.assertIs(request["deliver_now"], False)
            self.assertEqual(request["selected"]["queued_id"], "q1")
            request["accepted_event"].set()
            request["future"].set_result({"ok": True, "native_steer": True, "queued_id": "q1", "run_id": "run-1",
                                          "interrupted": False, "replays_interrupted_message": False, "superseded_queued_ids": []})
            result = await asyncio.wait_for(steer, 5)
            self.assertTrue(result["native_steer"])
            self.assertFalse(agent_server.QUEUED_TURNS.get("chat"))

    async def test_send_now_into_a_claude_turn_needs_no_route_match_and_delivers_now(self) -> None:
        with patch.dict(agent_server.ACTIVE, {"chat": self._active(agent_server.CLAUDE_TRANSPORT_AGENT_SDK)}), \
             patch.dict(agent_server.QUEUED_TURNS, {"chat": deque([queued_item("claude")])}):
            steer = asyncio.create_task(agent_server._run_queued_turn_now_once("chat", "q1"))
            request = await asyncio.wait_for(self.steer_queue.get(), 5)
            self.assertIs(request["deliver_now"], True)
            request["accepted_event"].set()
            request["future"].set_result({"ok": True, "native_steer": True, "queued_id": "q1", "run_id": "run-1",
                                          "interrupted": False, "replays_interrupted_message": False, "superseded_queued_ids": []})
            self.assertTrue((await asyncio.wait_for(steer, 5))["native_steer"])

    async def test_a_message_that_cannot_join_a_claude_turn_stays_queued_untouched(self) -> None:
        # Another model or effort: the message waits for the next turn; nothing is promoted or marked.
        item = queued_item("claude")
        with patch.object(agent_server, "queued_claude_runtime_matches_active", return_value=False), \
             patch.dict(agent_server.ACTIVE, {"chat": self._active(agent_server.CLAUDE_TRANSPORT_AGENT_SDK)}), \
             patch.dict(agent_server.QUEUED_TURNS, {"chat": deque([item])}):
            result = await asyncio.wait_for(agent_server._run_queued_turn_now_once("chat", "q1", deliver_now=False, steer_only=True), 5)
            self.assertEqual((result["deferred"], result["native_steer"]), (True, False))
            self.assertEqual(list(agent_server.QUEUED_TURNS["chat"]), [item])
            self.assertNotIn("_paused_after_stop", item)
            self.assertNotIn("chat", agent_server.STEERING_SESSIONS)
            self.assertNotIn("chat", agent_server.RUN_NOW_TURNS)
            self.assertTrue(self.steer_queue.empty())

    async def test_a_codex_turn_keeps_the_route_match_rule(self) -> None:
        item = queued_item("codex")
        with patch.dict(agent_server.STORE.sessions, {"chat": {"id": "chat", "backend": "codex"}}), \
             patch.dict(agent_server.ACTIVE, {"chat": self._active(agent_server.CODEX_TRANSPORT_APP_SERVER)}), \
             patch.dict(agent_server.QUEUED_TURNS, {"chat": deque([item])}):
            result = await asyncio.wait_for(agent_server._run_queued_turn_now_once("chat", "q1", deliver_now=False, steer_only=True), 5)
            self.assertEqual((result["deferred"], result["native_steer"]), (True, False))
            self.assertEqual(list(agent_server.QUEUED_TURNS["chat"]), [item])

    async def test_only_the_head_of_the_queue_joins_the_turn(self) -> None:
        join = AsyncMock(return_value={"ok": True, "native_steer": True})
        release = AsyncMock(return_value=False)
        earlier, later = dict(queued_item("claude"), queued_id="q0"), queued_item("claude")
        with patch.object(agent_server, "_run_queued_turn_now_and_release", join), \
             patch.object(agent_server, "release_claude_run_for_queued_turn", release), \
             patch.dict(agent_server.ACTIVE, {"chat": self._active(agent_server.CLAUDE_TRANSPORT_AGENT_SDK)}), \
             patch.dict(agent_server.QUEUED_TURNS, {"chat": deque([earlier, later])}):
            # The later message keeps its place behind one that could not join: it is released for, not steered.
            await agent_server.steer_or_release_for_queued_turn("chat", "q1")
            join.assert_not_awaited()
            release.assert_awaited_once_with("chat")
            # The head joins; a Codex turn is released for without any join attempt.
            await agent_server.steer_or_release_for_queued_turn("chat", "q0")
            join.assert_awaited_once_with("chat", "q0", deliver_now=False, steer_only=True)
        with patch.object(agent_server, "_run_queued_turn_now_and_release", join), \
             patch.object(agent_server, "release_claude_run_for_queued_turn", release), \
             patch.dict(agent_server.ACTIVE, {"chat": self._active(agent_server.CODEX_TRANSPORT_APP_SERVER)}), \
             patch.dict(agent_server.QUEUED_TURNS, {"chat": deque([earlier])}):
            await agent_server.steer_or_release_for_queued_turn("chat", "q0")
            self.assertEqual(join.await_count, 1)
            self.assertEqual(release.await_count, 2)


if __name__ == "__main__":
    unittest.main()
