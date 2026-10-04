"""/api/session-summaries/events: live chat list rows for chats without an open timeline."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import agent_server


class Socket:
    def __init__(self, protocols: str) -> None:
        self.headers = {"sec-websocket-protocol": protocols}
        self.query_params: dict = {}
        self.accepted_protocol = None
        self.closed_with = None
        self.packets: list = []
        self.release = asyncio.Event()

    async def accept(self, *, subprotocol=None) -> None:
        self.accepted_protocol = subprotocol

    async def close(self, code: int) -> None:
        self.closed_with = code
        self.release.set()

    async def send_json(self, packet: dict) -> None:
        self.packets.append(packet)

    async def receive_text(self) -> str:
        await self.release.wait()
        raise agent_server.WebSocketDisconnect()


def chat_row(**overrides) -> dict:
    row = {
        "id": "chat", "title": "Chat", "backend": "claude", "cwd": "/tmp", "folder": "General",
        "created_at": "2026-10-04T00:00:00Z", "updated_at": "2026-10-04T00:00:00Z",
        "latest_event_seq": 3, "latest_event_type": "tool_finished",
        "latest_agent_event_seq": 3, "latest_agent_event_type": "tool_finished",
    }
    row.update(overrides)
    return row


class SessionSummaryEventsTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_subscriber_receives_pushed_rows_but_not_an_initializing_fork(self) -> None:
        socket = Socket(f"{agent_server.SESSION_SUMMARY_WEBSOCKET_PROTOCOL}, agentsdock-token.abc")
        with patch.object(agent_server, "websocket_authorized", return_value=True):
            task = asyncio.create_task(agent_server.session_summary_events(socket))
            for _ in range(200):
                await asyncio.sleep(0)
                if socket in agent_server.HUB._subscribers.get(agent_server.SESSION_SUMMARY_HUB_KEY, set()):
                    break
            else:
                self.fail("socket was not registered")
            self.assertEqual(socket.accepted_protocol, agent_server.SESSION_SUMMARY_WEBSOCKET_PROTOCOL)
            await agent_server.broadcast_session_summary(chat_row(latest_agent_event_type="turn_finished", latest_agent_event_seq=7))
            await agent_server.broadcast_session_summary(chat_row(id="forking", _fork_initializing=True))
            socket.release.set()
            await task
        self.assertEqual(len(socket.packets), 1)
        packet = socket.packets[0]
        self.assertEqual(packet["type"], "session_summary")
        self.assertEqual(packet["server_identity"], agent_server.server_identity())
        self.assertEqual((packet["session"]["id"], packet["session"]["latest_agent_event_type"]), ("chat", "turn_finished"))
        self.assertNotIn("_fork_initializing", packet["session"])

    async def test_the_wrong_protocol_is_rejected_before_registration(self) -> None:
        socket = Socket("agentsdock-token.abc")
        with patch.object(agent_server, "websocket_authorized", return_value=True):
            await agent_server.session_summary_events(socket)
        self.assertEqual(socket.closed_with, 4406)
        self.assertNotIn(socket, agent_server.HUB._subscribers.get(agent_server.SESSION_SUMMARY_HUB_KEY, set()))

    async def test_turn_boundaries_push_the_row_and_other_events_do_not(self) -> None:
        sess = chat_row()
        with patch.object(agent_server.STORE, "sessions", {"chat": sess}), patch.object(
            agent_server.STORE, "save", new=AsyncMock(),
        ), patch.object(agent_server, "broadcast_session_summary", new=AsyncMock()) as push:
            await agent_server.update_session_event_metadata("chat", {"type": "tool_started", "seq": 4, "ts": "2026-10-04T00:00:04Z", "run_id": "r1"})
            push.assert_not_awaited()
            await agent_server.update_session_event_metadata("chat", {"type": "turn_finished", "seq": 5, "ts": "2026-10-04T00:00:05Z", "run_id": "r1", "exit_code": 0})
            push.assert_awaited_once_with(sess)
        self.assertEqual((sess["latest_event_type"], sess["latest_event_seq"]), ("turn_finished", 5))

    async def test_a_provider_question_pushes_the_row_once_per_change(self) -> None:
        sess = chat_row()
        pending = {"q1": {"session_id": "chat", "responded": False}}
        with patch.object(agent_server, "CLAUDE_PENDING_INTERACTIONS", pending), patch.object(
            agent_server.STORE, "sessions", {"chat": sess},
        ), patch.object(agent_server.STORE, "save", new=AsyncMock()), patch.object(
            agent_server, "broadcast_session_summary", new=AsyncMock(),
        ) as push:
            await agent_server.update_claude_pending_session_metadata("chat")
            self.assertTrue(sess["claude_needs_user_action"])
            push.assert_awaited_once_with(sess)
            await agent_server.update_claude_pending_session_metadata("chat")
            push.assert_awaited_once()
            pending["q1"]["responded"] = True
            await agent_server.update_claude_pending_session_metadata("chat")
            self.assertFalse(sess["claude_needs_user_action"])
            self.assertEqual(push.await_count, 2)


if __name__ == "__main__":
    unittest.main()
