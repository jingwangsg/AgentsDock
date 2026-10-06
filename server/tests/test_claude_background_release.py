"""A queued message ends a Claude run that only background tasks keep open.

Interrupting the CLI kills its background agents and shells, so a user message
sent while the model is idle must not go through Stop or a steer: the run is
released with the model's own Result and the tasks stay alive for the next run.
"""
import unittest
from collections import deque
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


if __name__ == "__main__":
    unittest.main()
