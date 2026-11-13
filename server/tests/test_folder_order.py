"""One chat-list folder order per server, shared by every client (GET/PUT /api/folders/order, summary stream v2)."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

import agent_server
from tests.test_new_agent_chats import fresh_store
from tests.test_session_summary_events import Socket, chat_row

V1 = agent_server.SESSION_SUMMARY_WEBSOCKET_PROTOCOL
V2 = agent_server.SESSION_SUMMARY_WEBSOCKET_PROTOCOL_V2


class FolderOrderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        state = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.order_file = state / "folder-order.json"
        self.enterContext(patch.object(agent_server, "FOLDER_ORDER_FILE", self.order_file))
        self.enterContext(patch.object(agent_server, "SURFACES_FILE", state / "surfaces.json"))
        self.enterContext(patch.object(agent_server, "SURFACES", {}))
        self.enterContext(patch.object(agent_server, "FOLDER_ORDER", None))
        self.enterContext(patch.object(agent_server, "FOLDER_ORDER_REVISION", 100))

    async def put(self, *folders: str) -> dict:
        return await agent_server.put_folder_order(agent_server.FolderOrderRequest(order=list(folders)))

    async def test_the_first_order_a_client_sends_becomes_the_shared_one_and_new_folders_join_it(self) -> None:
        # Until a client sends its order there is none to keep, so a new folder waits for that order.
        self.assertEqual(await agent_server.get_folder_order(), {"order": None, "revision": 100})
        await agent_server.remember_folder("Notes")
        self.assertFalse(self.order_file.exists())

        self.assertEqual(await self.put(" Lab ", "General", "Lab", ""), {"order": ["Lab", "General"], "revision": 101})
        self.assertEqual(json.loads(self.order_file.read_text()), {"order": ["Lab", "General"]})
        # A folder a chat or tab is filed under joins at the end; a known one changes nothing.
        await agent_server.remember_folder("Notes")
        await agent_server.remember_folder(" Lab ")
        await agent_server.remember_folder(None)  # a chat without a folder is in General
        self.assertEqual(await agent_server.get_folder_order(), {"order": ["Lab", "General", "Notes"], "revision": 102})
        # Delete folder sends the order without it; an unchanged order is not saved again.
        self.assertEqual((await self.put("General", "Lab"))["order"], ["General", "Lab"])
        self.assertEqual((await self.put("General", "Lab"))["revision"], 103)
        # A restarted server reads the same order.
        self.assertEqual(agent_server.load_folder_order(), ["General", "Lab"])

    def test_a_folder_name_is_bounded_well_above_what_clients_create(self) -> None:
        # A chat's folder name itself has no limit, so the bound only keeps one request small.
        agent_server.FolderOrderRequest(order=["x" * 1024])
        with self.assertRaises(ValidationError):
            agent_server.FolderOrderRequest(order=["x" * 1025])

    async def test_stream_v2_carries_the_order_and_v1_carries_only_chat_rows(self) -> None:
        # A v1 client (desktop 143 and older) closes the socket on a packet type it does not know.
        v1 = Socket(f"{V1}, agentsdock-token.abc")
        v2 = Socket(f"{V2}, {V1}, agentsdock-token.abc")
        with patch.object(agent_server, "websocket_authorized", return_value=True):
            tasks = [asyncio.create_task(agent_server.session_summary_events(socket)) for socket in (v1, v2)]
            for _ in range(200):
                await asyncio.sleep(0)
                if (v1 in agent_server.HUB._subscribers.get(agent_server.SESSION_SUMMARY_HUB_KEY, set())
                        and v2 in agent_server.HUB._subscribers.get(agent_server.SESSION_SUMMARY_V2_HUB_KEY, set())):
                    break
            else:
                self.fail("sockets were not registered")
            self.assertEqual((v1.accepted_protocol, v2.accepted_protocol), (V1, V2))
            await self.put("Lab", "General")
            await agent_server.broadcast_session_summary(chat_row())
            for socket in (v1, v2):
                socket.release.set()
            await asyncio.gather(*tasks)
        self.assertEqual([packet["type"] for packet in v1.packets], ["session_summary"])
        self.assertEqual([packet["type"] for packet in v2.packets], ["folder_order", "session_summary"])
        self.assertEqual(v2.packets[0], {"type": "folder_order", "server_identity": agent_server.server_identity(),
                                         "order": ["Lab", "General"], "revision": 101})

    async def test_a_chat_or_tab_filed_under_a_new_folder_adds_it_and_a_moved_chat_is_pushed(self) -> None:
        await self.put("General")
        with fresh_store() as store:
            created = await store.create(agent_server.CreateSessionRequest(title="Plan", folder="Projects", backend="claude"))
            self.assertEqual(agent_server.FOLDER_ORDER, ["General", "Projects"])
            # A move, from any client or an agent, reaches the other chat lists at once.
            with patch.object(agent_server, "broadcast_session_summary", AsyncMock()) as push:
                await agent_server.update_session(created["id"], agent_server.UpdateSessionRequest(folder="Inbox"))
            push.assert_awaited_once()
            self.assertEqual(push.await_args.args[0]["folder"], "Inbox")
            self.assertEqual(agent_server.FOLDER_ORDER, ["General", "Projects", "Inbox"])
        await agent_server.create_surface(agent_server.SurfaceCreateRequest(kind="terminal", folder="Ops"))
        self.assertEqual(agent_server.FOLDER_ORDER, ["General", "Projects", "Inbox", "Ops"])

    async def test_an_order_that_cannot_be_saved_does_not_fail_the_chat_change(self) -> None:
        await self.put("General")
        with patch.object(agent_server, "save_folder_order", AsyncMock(side_effect=OSError("disk full"))), \
                self.assertLogs(agent_server.logger, level="WARNING"):
            await agent_server.remember_folder("Notes")
        self.assertEqual(agent_server.FOLDER_ORDER, ["General"])


if __name__ == "__main__":
    unittest.main()
