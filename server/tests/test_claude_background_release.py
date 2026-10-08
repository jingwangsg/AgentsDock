"""A Claude run that only background tasks keep open is released, not interrupted.

Interrupting the CLI kills its background agents and shells. A user message sent
while the model is idle, and Stop pressed in that state, therefore end the run
with the model's own Result and leave the tasks alive for the next run.
"""
import asyncio
import unittest
from collections import deque
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import agent_server


SESSION = "sess_waiting"


class ReleaseForQueuedTurnTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, released: bool = True) -> AsyncMock:
        manager = AsyncMock()
        manager.release_awaiting_run = AsyncMock(return_value=released)
        return manager

    def active(self, **overrides) -> dict:
        return {"run_id": "run_parent", "transport": agent_server.CLAUDE_TRANSPORT_AGENT_SDK, "stop_requested": False, **overrides}

    async def test_releases_the_active_sdk_run_when_a_message_waits(self) -> None:
        manager = self.manager()
        with (
            patch.object(agent_server, "CLAUDE_SDK_MANAGER", manager),
            patch.object(agent_server, "QUEUED_TURNS", {SESSION: deque([{"queued_id": "q1", "prompt": "status?"}])}),
            patch.object(agent_server, "ACTIVE", {SESSION: self.active()}),
        ):
            self.assertTrue(await agent_server.release_claude_run_for_queued_turn(SESSION))
            # The supervisor's own notice names the run it is waiting in.
            self.assertTrue(await agent_server.release_claude_run_for_queued_turn(SESSION, "run_parent"))
        manager.release_awaiting_run.assert_awaited_with(SESSION, run_id="run_parent")
        self.assertEqual(manager.release_awaiting_run.await_count, 2)

    async def test_leaves_runs_alone_without_a_queue_or_outside_the_sdk_transport(self) -> None:
        manager = self.manager()
        cases = {
            "no queue": ({}, self.active()),
            "print transport": ({SESSION: deque([{"queued_id": "q1"}])}, self.active(transport=agent_server.CLAUDE_TRANSPORT_PRINT)),
            "stop in progress": ({SESSION: deque([{"queued_id": "q1"}])}, self.active(stop_requested=True)),
            "another run": ({SESSION: deque([{"queued_id": "q1"}])}, self.active(run_id="run_newer")),
        }
        for name, (queue, active) in cases.items():
            with self.subTest(name):
                with (
                    patch.object(agent_server, "CLAUDE_SDK_MANAGER", manager),
                    patch.object(agent_server, "QUEUED_TURNS", queue),
                    patch.object(agent_server, "ACTIVE", {SESSION: active}),
                ):
                    self.assertFalse(await agent_server.release_claude_run_for_queued_turn(SESSION, "run_parent"))
        manager.release_awaiting_run.assert_not_awaited()

    async def test_a_supervisor_failure_is_reported_not_raised(self) -> None:
        manager = self.manager()
        manager.release_awaiting_run.side_effect = RuntimeError("actor closed")
        with (
            patch.object(agent_server, "CLAUDE_SDK_MANAGER", manager),
            patch.object(agent_server, "QUEUED_TURNS", {SESSION: deque([{"queued_id": "q1"}])}),
            patch.object(agent_server, "ACTIVE", {SESSION: self.active()}),
        ):
            self.assertFalse(await agent_server.release_claude_run_for_queued_turn(SESSION))


class StopReleasesWaitingRunTests(unittest.IsolatedAsyncioTestCase):
    """Stop on a Claude run that only background tasks keep open releases it.

    The model already answered; an SDK interrupt would make the CLI kill its
    background agents (task killedBy: parent). Stop ends the run with that
    answer instead and skips the post-Stop fence that evicts the chat process
    while children are still running.
    """

    async def stop(
        self, *, awaiting: bool, released: bool | Exception = True, already_released: bool = False,
    ) -> dict:
        manager = AsyncMock()
        manager.release_awaiting_run = AsyncMock(
            side_effect=released if isinstance(released, Exception) else None, return_value=released,
        )
        interrupt = AsyncMock(return_value=True)
        fence = AsyncMock(return_value=agent_server.empty_subagent_stop_result())
        evict = AsyncMock(return_value=True)
        active = {
            "run_id": "run_parent",
            "backend": agent_server.BACKEND_CLAUDE,
            "transport": agent_server.CLAUDE_TRANSPORT_AGENT_SDK,
            "provider_turn_ready": True,
            # hard-terminalize evicts only a token-owned process; the already
            # released run below must never reach it.
            "claude_sdk_owner_token": "owner",
            "claude_sdk_run": SimpleNamespace(
                run_id="run_parent", awaiting_background_tasks=awaiting, released=already_released,
            ),
        }
        with (
            patch.object(agent_server.STORE, "sessions", {SESSION: {"id": SESSION, "backend": agent_server.BACKEND_CLAUDE}}),
            patch.object(agent_server, "ACTIVE", {SESSION: active}),
            patch.object(agent_server, "BUSY_SESSIONS", {SESSION}),
            patch.object(agent_server, "CURRENT_TURNS", {SESSION: {"run_id": "run_parent", "backend": agent_server.BACKEND_CLAUDE}}),
            patch.object(agent_server, "STOPPED_RUNS", set()),
            patch.object(agent_server, "STOP_REQUESTS", set()),
            patch.object(agent_server, "QUEUED_TURNS", {}),
            patch.object(agent_server, "RUN_METADATA", {}),
            patch.object(agent_server, "ACTIVE_LOCK", asyncio.Lock()),
            patch.object(agent_server, "SESSION_LIFECYCLE_LOCKS", {}),
            patch.object(agent_server, "CLAUDE_SDK_MANAGER", manager),
            patch.object(agent_server, "interrupt_claude_sdk_run_bounded", interrupt),
            patch.object(agent_server, "stop_idle_claude_background_subagents_bounded", fence),
            patch.object(agent_server, "evict_claude_sdk_chat", evict),
            patch.object(agent_server, "append_event", AsyncMock(return_value={})),
            patch.object(agent_server, "STOP_CONFIRM_TIMEOUT_SECONDS", 0.01),
        ):
            result = await agent_server.stop_turn(SESSION)
        return {
            "result": result, "release": manager.release_awaiting_run, "interrupt": interrupt,
            "fence": fence, "evict": evict, "active": active,
        }

    async def test_a_waiting_run_is_released_and_its_children_are_left_running(self) -> None:
        probe = await self.stop(awaiting=True)
        self.assertTrue(probe["result"]["stopped"])
        probe["release"].assert_awaited_once_with(SESSION, run_id="run_parent")
        probe["interrupt"].assert_not_awaited()
        probe["fence"].assert_not_awaited()

    async def test_a_working_run_is_still_interrupted_and_fenced(self) -> None:
        probe = await self.stop(awaiting=False)
        self.assertTrue(probe["result"]["stopped"])
        probe["release"].assert_not_awaited()
        probe["interrupt"].assert_awaited_once()
        probe["fence"].assert_awaited_once()

    async def test_a_released_run_is_left_to_close_without_interrupt_or_eviction(self) -> None:
        # 2026-10-08: Send now 0.4 s after a release found the run still
        # closing, waited 5 s, then evicted the process and its two agents.
        probe = await self.stop(awaiting=False, already_released=True)
        self.assertFalse(probe["result"]["stopped"])
        self.assertTrue(probe["result"]["pending"])
        self.assertTrue(probe["result"]["run_already_released"])
        probe["release"].assert_not_awaited()
        probe["interrupt"].assert_not_awaited()
        probe["fence"].assert_not_awaited()
        probe["evict"].assert_not_awaited()
        self.assertNotIn("stop_requested", probe["active"])

    async def test_a_release_that_returns_false_falls_back_to_the_interrupt(self) -> None:
        probe = await self.stop(awaiting=True, released=False)
        probe["release"].assert_awaited_once()
        probe["interrupt"].assert_awaited_once()
        probe["fence"].assert_awaited_once()

    async def test_a_release_that_fails_falls_back_to_the_interrupt(self) -> None:
        probe = await self.stop(awaiting=True, released=RuntimeError("actor closed"))
        probe["release"].assert_awaited_once()
        probe["interrupt"].assert_awaited_once()
        probe["fence"].assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
