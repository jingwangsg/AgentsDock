import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import agent_server
from tests.test_port_tunnel import DuplexWebSocket, RecordingWebSocket, authenticated_protocols


class BrowserTunnelTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_tab_reaches_server_loopback_without_a_chat(self) -> None:
        async def echo(reader, writer):
            try:
                writer.write(await reader.read(1024))
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        port = server.sockets[0].getsockname()[1]
        socket = DuplexWebSocket(b"browser API and WebSocket bytes")
        with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
             patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}), \
             patch.object(agent_server, "PORT_TUNNELS", agent_server.PortTunnelRegistry()):
            await asyncio.wait_for(agent_server.session_port_tunnel("browser_test", str(port), socket), 5)
        self.assertEqual(b"".join(socket.inbound), socket.outbound)

    async def test_unknown_or_terminal_surface_cannot_open_browser_tunnels(self) -> None:
        for surfaces in ({}, {"browser_test": {"kind": "terminal"}}):
            socket = RecordingWebSocket(authenticated_protocols())
            with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
                 patch.object(agent_server, "SURFACES", surfaces), \
                 patch.object(agent_server, "PORT_TUNNELS", agent_server.PortTunnelRegistry()):
                await agent_server.session_port_tunnel("browser_test", "8265", socket)
            self.assertEqual(socket.calls[-1][1], 4404)

    async def test_browser_tunnel_still_requires_server_authentication(self) -> None:
        socket = RecordingWebSocket(authenticated_protocols("wrong-token"))
        with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
             patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}):
            await agent_server.session_port_tunnel("browser_test", "8265", socket)
        self.assertEqual(socket.calls[-1][1], 4401)

    async def test_standard_browser_ports_are_admitted_but_zero_is_rejected(self) -> None:
        for port, code in (("80", 4502), ("443", 4502), ("0", 4400)):
            with self.subTest(port=port):
                socket = RecordingWebSocket(authenticated_protocols())
                connection = AsyncMock(side_effect=ConnectionRefusedError("test service is absent"))
                with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
                     patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}), \
                     patch.object(agent_server, "PORT_TUNNELS", agent_server.PortTunnelRegistry()), \
                     patch.object(agent_server.asyncio, "open_connection", connection):
                    await agent_server.session_port_tunnel("browser_test", port, socket)
                self.assertEqual(socket.calls[-1][1], code)
                self.assertEqual(connection.await_count, 0 if port == "0" else 1)

    async def test_browser_tab_names_a_host_for_the_server_to_resolve_and_dial(self) -> None:
        hosts = (
            ("intranet.example.", "intranet.example"),  # trailing dot dropped
            ("my_host.corp", "my_host.corp"),  # Chromium accepts underscores in names
            ("[fd00::2]", "fd00::2"),  # bracketed IPv6 literal
            ("192.0.2.7", "192.0.2.7"),
        )
        for named, dialed in hosts:
            with self.subTest(host=named):
                socket = RecordingWebSocket(authenticated_protocols())
                connection = AsyncMock(side_effect=ConnectionRefusedError("test host refuses"))
                with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
                     patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}), \
                     patch.object(agent_server, "PORT_TUNNELS", agent_server.PortTunnelRegistry()), \
                     patch.object(agent_server.asyncio, "open_connection", connection):
                    await agent_server.session_port_tunnel("browser_test", "80", socket, host=named)
                self.assertEqual(connection.await_args.kwargs, {"host": dialed, "port": 80})
                self.assertEqual(socket.calls[-1][1], 4502)

    async def test_only_a_browser_tab_names_a_host_and_only_a_well_formed_one(self) -> None:
        connection = AsyncMock()
        cases = (
            ("browser_test", "bad host"),  # space
            ("browser_test", "-x.example"),  # label starts with a hyphen
            ("browser_test", "a" * 254),  # longer than a DNS name
            ("browser_test", "http://x"),  # a URL, not a host
            ("browser_test", ""),  # ?host= with no value
            ("chat", "intranet.example"),  # a chat never names a host
        )
        with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
             patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}), \
             patch.dict(agent_server.STORE.sessions, {"chat": {"id": "chat"}}), \
             patch.object(agent_server, "PORT_TUNNELS", agent_server.PortTunnelRegistry()), \
             patch.object(agent_server.asyncio, "open_connection", connection):
            for session_id, host in cases:
                with self.subTest(session=session_id, host=host):
                    socket = RecordingWebSocket(authenticated_protocols())
                    await agent_server.session_port_tunnel(session_id, "8265", socket, host=host)
                    self.assertEqual(socket.calls[-1][1], 4400)
        connection.assert_not_awaited()

    def test_the_route_binds_host_from_the_query_string(self) -> None:
        connection = AsyncMock(side_effect=ConnectionRefusedError("test host refuses"))
        with patch.object(agent_server, "AGENT_TOKEN", "server-token"), \
             patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}), \
             patch.object(agent_server, "PORT_TUNNELS", agent_server.PortTunnelRegistry()), \
             patch.object(agent_server.asyncio, "open_connection", connection), \
             TestClient(agent_server.app).websocket_connect(
                 "/api/sessions/browser_test/ports/443/tunnel/ws?host=%5Bfd00%3A%3A2%5D",
                 subprotocols=list(authenticated_protocols()),
             ) as socket:
            closed = socket.receive()
        self.assertEqual((closed["type"], closed["code"]), ("websocket.close", 4502))
        self.assertEqual(connection.await_args.kwargs, {"host": "fd00::2", "port": 443})

    async def test_deleting_a_browser_retires_its_connections(self) -> None:
        registry = agent_server.PortTunnelRegistry()
        socket = RecordingWebSocket(authenticated_protocols())
        await registry.reserve("browser_test", socket)
        with patch.object(agent_server, "SURFACES", {"browser_test": {"kind": "browser"}}), \
             patch.object(agent_server, "PORT_TUNNELS", registry), \
             patch.object(agent_server, "save_surfaces"):
            await agent_server.delete_surface("browser_test")
        self.assertEqual(socket.calls[-1][1], 4404)
        self.assertEqual((await registry.snapshot())["active_connections"], 0)
