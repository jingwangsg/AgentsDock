"""Chats the composer's "Create new agent" makes on another server: the hub creates them, the composer pairs them under the chip's label."""
from __future__ import annotations

import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import agent_server
import cross_server_mail


@contextmanager
def fresh_store():
    store = agent_server.SessionStore()
    with ExitStack() as stack:
        for patcher in (
            patch.object(agent_server, "STORE", store),
            patch.object(agent_server, "ensure_dirs"),
            patch.object(agent_server, "append_event", AsyncMock()),
            patch.object(store, "save", AsyncMock()),
            patch.object(agent_server, "HISTORY_SEARCH_DIRTY", set()),
        ):
            stack.enter_context(patcher)
        yield store


class FakeEnd(cross_server_mail.End):
    def __init__(self, identity: str, name: str, titles: dict[str, str]) -> None:
        self.identity = identity
        self.name = name
        self.titles = titles
        self.created: list[dict] = []
        self.installed: list[dict] = []

    async def chats(self) -> list[dict]:
        return []

    async def describe(self, session_id: str) -> dict:
        return {"title": self.titles[session_id], "backend": "claude"}

    async def install(self, route: dict) -> None:
        self.installed.append(route)

    async def uninstall(self, pair_id: str) -> None:
        pass

    async def create(self, chat: dict) -> dict:
        self.created.append(chat)
        return {"id": "sess_new", "title": chat["title"], "folder": chat.get("folder")}


def pair_request(**overrides) -> agent_server.CrossServerPairRequest:
    return agent_server.CrossServerPairRequest(**{
        "source_server_identity": "srv-hub", "source_session_id": "sess_src",
        "target_server_identity": "srv-remote", "target_session_id": "sess_new", **overrides,
    })


class HubCreateTests(unittest.IsolatedAsyncioTestCase):
    async def test_hub_creates_the_chat_on_the_chosen_server_or_refuses(self):
        remote = FakeEnd("srv-remote", "gpu-box", {})
        request = agent_server.CrossServerChatRequest(
            server_identity="srv-remote", title="triage flaky tests", folder="Lab", cwd="", backend="claude", model=None, effort=None,
        )
        with patch.object(agent_server.CROSS_SERVER_RELAY, "ends", return_value={remote.identity: remote}):
            result = await agent_server.create_cross_server_chat(request)
        self.assertEqual(result["session"]["id"], "sess_new")
        # Only the fields the client set reach the server; its defaults fill the rest.
        self.assertEqual(remote.created, [{"title": "triage flaky tests", "folder": "Lab", "cwd": "", "backend": "claude"}])
        with patch.object(agent_server.CROSS_SERVER_RELAY, "ends", return_value={}):
            with self.assertRaises(agent_server.HTTPException) as raised:
                await agent_server.create_cross_server_chat(request)
        self.assertEqual(raised.exception.status_code, 409)

    async def test_chat_list_tells_the_composer_that_the_hub_creates_chats(self):
        remote = FakeEnd("srv-remote", "gpu-box", {})
        with patch.object(agent_server.CROSS_SERVER_RELAY, "ends", return_value={remote.identity: remote}):
            snapshot = await agent_server.list_cross_server_chats()
        self.assertTrue(snapshot["create_chats"])
        self.assertEqual([server["server_identity"] for server in snapshot["servers"]], ["srv-remote"])

    async def test_chat_list_marks_a_remote_hidden_on_the_hub(self):
        ends = {identity: cross_server_mail.RemoteEnd(None, SimpleNamespace(name=identity, hidden=hidden), identity)
                for identity, hidden in (("srv-shown", False), ("srv-hidden", True))}
        for end in ends.values():
            end.chats = AsyncMock(return_value=[])
        with patch.object(agent_server.CROSS_SERVER_RELAY, "ends", return_value=ends):
            snapshot = await agent_server.list_cross_server_chats()
        # Listed all the same: a client on the hidden remote finds itself there.
        self.assertEqual([(server["server_identity"], server["hidden"]) for server in snapshot["servers"]],
                         [("srv-shown", False), ("srv-hidden", True)])

    async def test_chat_list_names_each_servers_home_directory(self):
        # "Create new agent" shows it as the working directory its empty field means.
        hub = agent_server.LOCAL_CROSS_SERVER_END
        remote = cross_server_mail.RemoteEnd(None, SimpleNamespace(name="gpu-box", hidden=False), "srv-remote",
                                             default_cwd="/home/gpu")
        remote.chats = AsyncMock(return_value=[])
        with tempfile.TemporaryDirectory() as home, ExitStack() as stack:
            stack.enter_context(patch.object(agent_server, "DEFAULT_CWD", home))
            stack.enter_context(patch.object(agent_server, "server_identity", return_value="srv-hub"))
            stack.enter_context(patch.object(type(hub), "chats", AsyncMock(return_value=[])))
            stack.enter_context(patch.object(agent_server.CROSS_SERVER_RELAY, "ends",
                                             return_value={"srv-hub": hub, remote.identity: remote}))
            snapshot = await agent_server.list_cross_server_chats()
        self.assertEqual([(server["server_identity"], server["default_cwd"]) for server in snapshot["servers"]],
                         [("srv-hub", home), ("srv-remote", "/home/gpu")])

    async def test_local_end_creates_a_named_chat_in_process(self):
        with fresh_store() as store:
            session = await agent_server.LOCAL_CROSS_SERVER_END.create(
                {"title": "Fix login", "folder": "Research", "cwd": "", "backend": "claude"},
            )
            self.assertEqual(store.sessions[session["id"]]["_title_source"], "manual")
        self.assertEqual((session["title"], session["folder"], session["backend"]), ("Fix login", "Research", "claude"))


class PairLabelTests(unittest.IsolatedAsyncioTestCase):
    async def test_pair_installs_the_chip_label_on_the_source_side_and_retires_an_older_one(self):
        hub = FakeEnd("srv-hub", "", {"sess_src": "E2E source"})
        remote = FakeEnd("srv-remote", "gpu-box", {"sess_new": "triage flaky tests", "sess_old": "write the docs"})
        older = {
            "pair_id": "pair_" + "0" * 32,
            "a_server_identity": "srv-hub", "a_session_id": "sess_src", "a_route_id": "route_" + "a" * 32,
            "b_server_identity": "srv-remote", "b_session_id": "sess_old", "b_route_id": "route_" + "b" * 32,
        }
        ledger: dict[str, dict] = {}

        async def cross_server_call(operation: str, *args):
            if operation == "find_pair":
                return None
            if operation == "put_pair":
                ledger["pair"] = args[0]
                return None
            if operation == "pairs_for":
                return [older, ledger["pair"]]
            raise AssertionError(operation)

        with (
            patch.object(agent_server.CROSS_SERVER_RELAY, "ends", return_value={hub.identity: hub, remote.identity: remote}),
            patch.object(agent_server.CROSS_CHAT, "cross_server_call", AsyncMock(side_effect=cross_server_call)),
        ):
            result = await agent_server.create_cross_server_pair(pair_request(target_label="New agent"))
        self.assertTrue(result["created"])
        # The new pair: the chip's label on the source side, the source's real title on the target side.
        self.assertEqual(
            [(route["peer_session_id"], route["peer_title"]) for route in hub.installed],
            [("sess_new", "New agent"), ("sess_old", "write the docs")],
        )
        self.assertEqual([(route["peer_session_id"], route["peer_title"]) for route in remote.installed], [("sess_src", "E2E source")])
        # The older pair went back to its chat's real title under its own route and pair ids.
        self.assertEqual((hub.installed[1]["route_id"], hub.installed[1]["pair_id"]), (older["a_route_id"], older["pair_id"]))

    async def test_pair_without_a_label_keeps_the_target_title(self):
        hub = FakeEnd("srv-hub", "", {"sess_src": "E2E source"})
        remote = FakeEnd("srv-remote", "gpu-box", {"sess_new": "triage flaky tests"})
        calls = AsyncMock(side_effect=lambda operation, *args: None)
        with (
            patch.object(agent_server.CROSS_SERVER_RELAY, "ends", return_value={hub.identity: hub, remote.identity: remote}),
            patch.object(agent_server.CROSS_CHAT, "cross_server_call", calls),
        ):
            await agent_server.create_cross_server_pair(pair_request())
        self.assertEqual([route["peer_title"] for route in hub.installed], ["triage flaky tests"])
        self.assertNotIn("pairs_for", [call.args[0] for call in calls.await_args_list])


if __name__ == "__main__":
    unittest.main()
