"""A turn resent with the same client_request_id is answered once, never run twice."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import agent_server


def turn(request_id: str) -> agent_server.TurnRequest:
    return agent_server.TurnRequest(prompt="hi", client_request_id=request_id)


class TurnRequestIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        agent_server.TURN_REQUEST_RECEIPTS.clear()

    async def test_a_resend_returns_the_first_receipt(self) -> None:
        start = AsyncMock(side_effect=lambda session_id, req: {"session": {"id": session_id}, "request": req.client_request_id})
        with patch.object(agent_server, "start_turn", start):
            first = await agent_server.post_turn("chat", turn("request-0001"))
            again = await agent_server.post_turn("chat", turn("request-0001"))
            await agent_server.post_turn("chat", turn("request-0002"))
            await agent_server.post_turn("other-chat", turn("request-0001"))
        self.assertIs(again, first)
        self.assertEqual(start.await_count, 3)

    async def test_a_duplicate_that_arrives_while_the_first_runs_waits_for_it(self) -> None:
        # A stalled forward can deliver the original and the resend together.
        release = asyncio.Event()

        async def start(session_id: str, req: agent_server.TurnRequest) -> dict:
            await release.wait()
            return {"session": {"id": session_id}}

        start_mock = AsyncMock(side_effect=start)
        with patch.object(agent_server, "start_turn", start_mock):
            first = asyncio.create_task(agent_server.post_turn("chat", turn("request-0001")))
            await asyncio.sleep(0)
            duplicate = asyncio.create_task(agent_server.post_turn("chat", turn("request-0001")))
            await asyncio.sleep(0)
            release.set()
            self.assertIs(await duplicate, await first)
        self.assertEqual(start_mock.await_count, 1)

    async def test_a_rejected_turn_is_not_remembered(self) -> None:
        start = AsyncMock(side_effect=[agent_server.HTTPException(status_code=409, detail="busy"), {"session": {"id": "chat"}}])
        with patch.object(agent_server, "start_turn", start):
            with self.assertRaises(agent_server.HTTPException):
                await agent_server.post_turn("chat", turn("request-0001"))
            self.assertEqual(await agent_server.post_turn("chat", turn("request-0001")), {"session": {"id": "chat"}})
        self.assertEqual(start.await_count, 2)


if __name__ == "__main__":
    unittest.main()
