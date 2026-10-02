"""Claude context compaction: native /compact route and SDK lifecycle projection."""
import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from claude_agent_sdk.types import SystemMessage
from fastapi import HTTPException

import agent_server


def setUpModule():
    unittest.enterModuleContext(patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": "test-token"}))


def status_message(**fields: object) -> SystemMessage:
    return SystemMessage(subtype="status", data={"type": "system", "subtype": "status", "session_id": "provider-1", **fields})


def boundary_message(pre_tokens: int = 27295, post_tokens: int = 4717) -> SystemMessage:
    return SystemMessage(subtype="compact_boundary", data={
        "type": "system", "subtype": "compact_boundary", "session_id": "provider-1",
        "compact_metadata": {"trigger": "manual", "pre_tokens": pre_tokens, "post_tokens": post_tokens,
                             "cumulative_dropped_tokens": pre_tokens - post_tokens, "duration_ms": 18413},
    })


class ClaudeCompactionProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.previous_sessions = agent_server.STORE.sessions
        self.previous_active = agent_server.ACTIVE
        agent_server.STORE.sessions = {"chat": {
            "id": "chat", "backend": agent_server.BACKEND_CLAUDE,
            "claude_context_usage_snapshot": {"context_tokens": 27295, "context_window": 200000},
        }}
        agent_server.ACTIVE = {"chat": {"run_id": "run-1", "backend": agent_server.BACKEND_CLAUDE}}
        self.append_event = AsyncMock(return_value={})
        self.stack = patch.multiple(agent_server, append_event=self.append_event, mark_provider_turn_ready=AsyncMock())
        self.stack.start()

    async def asyncTearDown(self) -> None:
        self.stack.stop()
        agent_server.STORE.sessions = self.previous_sessions
        agent_server.ACTIVE = self.previous_active

    async def project(self, message: SystemMessage, state: dict) -> None:
        await agent_server.project_claude_sdk_message(
            "chat", "run-1", message, text_parts=[], current_tools={}, changed_paths=set(), compaction_state=state,
        )

    def projected(self) -> list[tuple[str, dict]]:
        return [(call.args[1], call.args[2]) for call in self.append_event.await_args_list]

    async def test_manual_compaction_projects_started_then_completed_with_token_counts(self) -> None:
        state = {"manual": True}
        await self.project(status_message(status="compacting"), state)
        self.assertTrue(agent_server.ACTIVE["chat"]["claude_compaction_in_progress"])
        await self.project(status_message(status=None, compact_result="success"), state)
        await self.project(boundary_message(), state)

        events = self.projected()
        self.assertEqual([event_type for event_type, _ in events],
                         ["claude_compaction_started", "claude_compaction_completed"])
        started, completed = events[0][1], events[1][1]
        self.assertEqual(started["compaction_id"], "run-1")
        self.assertEqual(started["status"], "in_progress")
        self.assertEqual(started["token_usage_before"]["context_tokens"], 27295)
        self.assertEqual(started["message"], "Claude started compacting this chat's context.")
        self.assertEqual(completed["compaction_id"], "run-1")
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["compact_metadata"]["post_tokens"], 4717)
        self.assertEqual(completed["message"], "Claude compacted this chat's context from 27,295 to 4,717 tokens.")
        self.assertNotIn("claude_compaction_in_progress", agent_server.ACTIVE["chat"])
        self.assertEqual(state, {"manual": True, "count": 1})

    async def test_automatic_compaction_wording_and_second_identity(self) -> None:
        state = {"manual": False}
        await self.project(status_message(status="compacting"), state)
        await self.project(boundary_message(), state)
        await self.project(status_message(status="compacting"), state)
        await self.project(boundary_message(), state)
        events = self.projected()
        self.assertEqual(events[0][1]["message"], "Claude started automatic context compaction.")
        self.assertEqual([payload["compaction_id"] for _, payload in events], ["run-1", "run-1", "run-1:1", "run-1:1"])

    async def test_failed_compact_result_closes_the_row_with_the_result_reason(self) -> None:
        state = {"manual": True}
        await self.project(status_message(status="compacting"), state)
        await self.project(status_message(status=None, compact_result="failed"), state)
        # The row stays open until the terminal result carries the reason.
        self.assertEqual([event_type for event_type, _ in self.projected()], ["claude_compaction_started"])
        details = await agent_server.project_claude_sdk_message(
            "chat", "run-1",
            {"type": "result", "subtype": "success", "session_id": "provider-1", "is_error": False,
             "result": "Not enough messages to compact.", "local_command": "compact"},
            text_parts=[], current_tools={}, changed_paths=set(), compaction_state=state,
        )
        self.assertEqual(details["local_command"], "compact")
        events = self.projected()
        self.assertEqual(events[1][0], "claude_compaction_completed")
        self.assertEqual(events[1][1]["status"], "failed")
        self.assertEqual(events[1][1]["message"], "Claude context compaction failed: Not enough messages to compact.")
        self.assertNotIn("open_id", state)
        self.assertNotIn("claude_compaction_in_progress", agent_server.ACTIVE["chat"])

    async def test_interrupt_closes_only_an_open_compaction(self) -> None:
        await agent_server.append_claude_compaction_completed(
            "chat", "run-1", {"manual": True}, status="interrupted", message="stopped")
        self.append_event.assert_not_awaited()
        state = {"manual": True}
        await self.project(status_message(status="compacting"), state)
        await agent_server.append_claude_compaction_completed(
            "chat", "run-1", state, status="interrupted", message="stopped")
        self.assertEqual(self.projected()[1][1]["status"], "interrupted")

    async def test_other_status_messages_are_ignored(self) -> None:
        state = {"manual": False}
        await self.project(status_message(status=None), state)
        await self.project(SystemMessage(subtype="init", data={"type": "system", "subtype": "init"}), state)
        self.append_event.assert_not_awaited()


class ClaudeCompactionResultTests(unittest.TestCase):
    def test_local_command_result_is_not_an_empty_turn_error(self) -> None:
        common = dict(prompt="/compact", result_text="", had_tool_activity=False, stopped=False,
                      terminal_result_received=True, existing_error=False)
        self.assertEqual(agent_server.claude_empty_turn_failure_message(**common), agent_server.CLAUDE_EMPTY_TURN_ERROR)
        self.assertEqual(agent_server.claude_empty_turn_failure_message(**common, local_command_result=True), "")

    def test_result_details_carry_local_command(self) -> None:
        result = SimpleNamespace(result="", is_error=False, subtype="success", session_id="provider-1",
                                 errors=None, terminal_reason=None, local_command="compact")
        self.assertEqual(agent_server.claude_sdk_result_details(result)["local_command"], "compact")
        plain = SimpleNamespace(result="ok", is_error=False, subtype="success", session_id="provider-1",
                                errors=None, terminal_reason=None)
        self.assertIsNone(agent_server.claude_sdk_result_details(plain)["local_command"])

    def test_lifecycle_key_keeps_providers_apart(self) -> None:
        self.assertEqual(
            agent_server.timeline_index_codex_lifecycle_key({"type": "claude_compaction_started", "compaction_id": "run-1"}),
            "claude:compaction:run-1")
        self.assertEqual(
            agent_server.timeline_index_codex_lifecycle_key({"type": "codex_compaction_completed", "compaction_id": "run-1"}),
            "codex:compaction:run-1")


class ClaudeCompactionRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.previous_sessions = agent_server.STORE.sessions
        agent_server.STORE.sessions = {"chat": {"id": "chat", "backend": agent_server.BACKEND_CLAUDE},
                                       "codex-chat": {"id": "codex-chat", "backend": agent_server.BACKEND_CODEX}}
        inventory = SimpleNamespace(revision="pcmdrev_" + "b" * 32, records=[
            SimpleNamespace(public={"invocation": "/compact", "id": "pcmd_" + "a" * 32})])
        self.discover = AsyncMock(return_value=({"support": {"available": True}}, inventory))
        self.start_turn = AsyncMock(return_value={"run_id": "run-1"})
        self.stack = patch.multiple(
            agent_server, discover_session_provider_commands=self.discover, start_turn=self.start_turn,
            claude_sdk_dependency_available=lambda: True, CLAUDE_TRANSPORT=agent_server.CLAUDE_TRANSPORT_AGENT_SDK)
        self.stack.start()

    async def asyncTearDown(self) -> None:
        self.stack.stop()
        agent_server.STORE.sessions = self.previous_sessions

    async def test_compact_dispatches_the_validated_native_command_without_queueing(self) -> None:
        response = await agent_server.post_claude_compact("chat")
        self.assertEqual(response, {"accepted": True, "run_id": "run-1", "operation_id": "run-1"})
        call = self.start_turn.await_args
        self.assertEqual(call.args[0], "chat")
        self.assertEqual(call.args[1].prompt, "/compact")
        self.assertEqual(call.args[1].skill_selection.id, "pcmd_" + "a" * 32)
        self.assertEqual(call.args[1].client_capabilities, [agent_server.CLAUDE_SDK_INTERACTIVE_CLIENT_CAPABILITY])
        self.assertFalse(call.kwargs["queue_if_busy"])

    async def test_missing_native_command_and_wrong_backend_are_rejected(self) -> None:
        self.discover.return_value = ({"support": {"available": True}}, SimpleNamespace(records=[], revision=""))
        with self.assertRaises(HTTPException) as missing:
            await agent_server.post_claude_compact("chat")
        self.assertEqual(missing.exception.status_code, 409)
        with self.assertRaises(HTTPException) as wrong:
            await agent_server.post_claude_compact("codex-chat")
        self.assertEqual(wrong.exception.status_code, 400)
        self.start_turn.assert_not_awaited()


class ClaudeCompactionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.previous_sessions = agent_server.STORE.sessions
        agent_server.STORE.sessions = {"chat": {
            "id": "chat", "backend": agent_server.BACKEND_CLAUDE,
            "_active_codex_compactions": {"claude:compaction:run-1": {
                "lifecycle_key": "claude:compaction:run-1", "compaction_id": "run-1", "run_id": "run-1",
                "started_seq": 10, "started_at": "2026-10-02T12:00:00Z"}},
        }}

    async def asyncTearDown(self) -> None:
        agent_server.STORE.sessions = self.previous_sessions

    async def test_abandoned_claude_compaction_is_closed_with_its_own_type(self) -> None:
        recorded: list[dict] = []

        async def append_recovery(session_id: str, event_type: str, payload: dict) -> dict:
            event = {"seq": 11, "type": event_type, "ts": "2026-10-02T12:00:01Z", **payload}
            recorded.append(event)
            await agent_server.update_session_event_metadata(session_id, event)
            return event

        with patch.object(agent_server, "append_event", side_effect=append_recovery), \
                patch.object(agent_server.STORE, "save", AsyncMock()):
            recovered = await agent_server.recover_abandoned_codex_compactions_after_start()
        self.assertEqual(recovered, 1)
        self.assertEqual(recorded[0]["type"], "claude_compaction_completed")
        self.assertEqual(recorded[0]["status"], "interrupted")
        self.assertNotIn("_active_codex_compactions", agent_server.STORE.sessions["chat"])


if __name__ == "__main__":
    unittest.main()
