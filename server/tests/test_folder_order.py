"""One chat-list folder order per server, shared by every client (GET/PUT /api/folders/order, summary stream v2)."""
import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

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
        self.assertEqual(json.loads(self.order_file.read_text()), {"order": ["Lab", "General"], "revision": 101})
        # A folder a chat is filed under joins at the end; a known one changes nothing, and a blank one is General.
        await agent_server.remember_folder("Notes")
        await agent_server.remember_folder(" Lab ")
        await agent_server.remember_folder("   ")
        await agent_server.remember_folder(None)
        self.assertEqual(await agent_server.get_folder_order(), {"order": ["Lab", "General", "Notes"], "revision": 102})
        # Delete folder sends the order without it; an unchanged order is not saved again.
        self.assertEqual((await self.put("General", "Lab"))["order"], ["General", "Lab"])
        self.assertEqual((await self.put("General", "Lab"))["revision"], 103)
        # Clients adopt only a newer revision, so a restarted server starts above the saved one,
        # even when this run saved faster than the clock advanced.
        self.order_file.write_text(json.dumps({"order": ["General", "Lab"], "revision": int(time.time()) + 1000}))
        order, revision = agent_server.load_folder_order()
        self.assertEqual((order, revision), (["General", "Lab"], json.loads(self.order_file.read_text())["revision"] + 1))

    async def test_a_chats_long_folder_name_never_blocks_a_full_order(self) -> None:
        # A chat's folder name has no length limit, and every client sends the whole order back.
        name = "x" * 5000
        self.assertEqual((await self.put("General", name))["order"], ["General", name])

    async def test_stream_v2_carries_the_order_and_v1_carries_only_chat_rows(self) -> None:
        # A v1 client (desktop 143 and older) closes the socket on a packet type it does not know.
        await self.put("Lab", "General")
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
            await self.put("General", "Lab")
            await agent_server.broadcast_session_summary(chat_row())
            for socket in (v1, v2):
                socket.release.set()
            await asyncio.gather(*tasks)
        self.assertEqual([packet["type"] for packet in v1.packets], ["session_summary"])
        # A socket that connects gets the order at once, so a reconnecting client takes what it missed.
        self.assertEqual([(packet["type"], packet.get("order")) for packet in v2.packets],
                         [("folder_order", ["Lab", "General"]), ("folder_order", ["General", "Lab"]), ("session_summary", None)])
        self.assertEqual(v2.packets[1], {"type": "folder_order", "server_identity": agent_server.server_identity(),
                                         "order": ["General", "Lab"], "revision": 102})

    async def test_a_chat_filed_under_a_new_folder_adds_it_and_a_moved_chat_is_pushed(self) -> None:
        await self.put("General")
        with fresh_store():
            created = (await agent_server.create_session(
                agent_server.CreateSessionRequest(title="Plan", folder="Projects", backend="claude")))["session"]
            self.assertEqual(agent_server.FOLDER_ORDER, ["General", "Projects"])
            with patch.object(agent_server, "broadcast_session_summary", AsyncMock()) as push:
                # A title change does not move the chat in the list.
                await agent_server.update_session(created["id"], agent_server.UpdateSessionRequest(title="Plan B"))
                push.assert_not_awaited()
                # A move, from any client or an agent, reaches the other chat lists at once.
                await agent_server.update_session(created["id"], agent_server.UpdateSessionRequest(folder="Inbox"))
            push.assert_awaited_once()
            self.assertEqual(push.await_args.args[0]["folder"], "Inbox")
            self.assertEqual(agent_server.FOLDER_ORDER, ["General", "Projects", "Inbox"])
        # A tab's folder stays out of the order: a browser tab saves its page title often, which would
        # bring back a folder deleted while the tab was still in it.
        await agent_server.create_surface(agent_server.SurfaceCreateRequest(kind="terminal", folder="Ops"))
        self.assertEqual(agent_server.FOLDER_ORDER, ["General", "Projects", "Inbox"])

    async def test_an_order_that_cannot_be_saved_does_not_fail_the_chat_change(self) -> None:
        await self.put("General")
        with patch.object(agent_server, "save_folder_order", AsyncMock(side_effect=OSError("disk full"))), \
                self.assertLogs(agent_server.logger, level="WARNING"):
            await agent_server.remember_folder("Notes")
        self.assertEqual(agent_server.FOLDER_ORDER, ["General"])


if __name__ == "__main__":
    unittest.main()
