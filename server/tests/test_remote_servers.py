"""Remote-server hub: registry, tunnel argv, header rewriting, and the HTTP/WS reverse proxy."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import shlex
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import io
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.requests import ClientDisconnect
from websockets.asyncio.client import connect as websocket_connect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import remote_servers as rs  # noqa: E402

HUB_TOKEN = "hub-token-" + "h" * 30
REMOTE_TOKEN = "remote-token-" + "r" * 40

# Plays the host for deploy/attach jobs: answers the probe and the bootstrap from
# host.json and logs each call's full argv, its SSL_CERT_FILE, and ``tail``, the part
# after ``bash -s --`` (None for a plain remote command such as the upload's ``cat >``).
FAKE_SSH = r'''#!{python}
import json, os, subprocess, sys
state = {state!r}
argv = sys.argv[1:]
if "-G" in argv:  # ssh -G: the resolved configuration, with ssh_config percent tokens left as is
    print("identityfile ~/.ssh/id_rsa\nidentityfile %d/.ssh/id_%u\nidentityfile ~/.ssh/id_ed25519")
    sys.exit(0)
stdin = sys.stdin.buffer.read()
tail = argv[argv.index("--") + 1:] if "--" in argv else None
# A password step offers it through an askpass helper; the fake runs the helper like ssh would.
askpass = os.environ.get("SSH_ASKPASS")
password = subprocess.run([askpass, "password:"], capture_output=True, text=True).stdout.strip() if askpass else None
with open(os.path.join(state, "calls.jsonl"), "a") as log:
    log.write(json.dumps(dict(tail=tail, command=None if tail is not None else argv[-1], argv=argv, ca=os.environ.get("SSL_CERT_FILE"),
                              stdin_head=stdin[:120].decode("utf-8", "replace"), password=password,
                              askpass_require=os.environ.get("SSH_ASKPASS_REQUIRE"))) + "\n")
if password == "wrong":  # the host refuses the password
    print(argv[-2] + ": Permission denied (publickey,password).")
    sys.exit(255)
if password == "keys-only":  # the host takes no passwords at all
    print(argv[-2] + ": Permission denied (publickey).")
    sys.exit(255)
host = json.load(open(os.path.join(state, "host.json")))
if tail is not None and len(tail) == 1:  # probe: bash -s -- <install_dir>
    print("AGENTSDOCK_TUNNEL_PROBE=" + json.dumps(dict(os="Linux", arch="x86_64", uid=1000, home="/h", tmux=True, free_port=7850, existing_port=host["existing_port"])))
elif tail is not None:  # bootstrap: bash -s -- <install_dir> <port> <home> [restart]
    print("[AgentsDock setup] Starting AgentsServer on port " + tail[1])
    print("AGENTSDOCK_SETUP_RESULT=" + json.dumps(dict(access_token=host["token"], remote_port=int(tail[1]), install_dir=tail[0], server_version="1.2.3")))
'''


def make_server(**overrides) -> rs.RemoteServer:
    values = dict(
        id="abcdef123456", name="osmo", ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server",
        remote_port=7850, local_port=7851, token=REMOTE_TOKEN, created_at="2026-09-27T00:00:00Z",
    )
    values.update(overrides)
    return rs.RemoteServer(**values)


def raw(*pairs: tuple[str, str]) -> list[tuple[bytes, bytes]]:
    return [(name.encode(), value.encode()) for name, value in pairs]


# --- proxy integration helpers (fake upstream, no ssh) -------------------------


def fake_upstream(identity: str = "fake-remote") -> FastAPI:
    """identity tells a test that runs two fakes which one answered."""
    app = FastAPI()

    def token_headers(request: Request) -> list[tuple[str, str]]:
        return [(name.decode(), value.decode()) for name, value in request.scope["headers"] if name.lower() in (b"authorization", b"x-agentsdock-token", b"x-zenithdock-token", b"cookie")]

    async def read_body(request: Request) -> bytes:
        try:
            return await request.body()
        except ClientDisconnect:  # the hub dropped this connection along with its own client
            return b""

    @app.post("/api/admin/runtimes/{backend}/update")
    async def runtime_update(request: Request, backend: str) -> dict:
        # The real route takes the remote's own token in this header and nothing else.
        if dict(token_headers(request)).get("x-agentsdock-token") != REMOTE_TOKEN:
            raise HTTPException(status_code=401, detail="unauthorized")
        return {"output": "", "diagnostic": {"available": True, "version": f"{backend}-2.0"}}

    @app.api_route("/echo/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def echo(request: Request, rest: str) -> dict:
        body = await read_body(request)
        return {
            "method": request.method, "path": rest, "query": request.url.query,
            "credentials": token_headers(request),
            "content_length": request.headers.get("content-length"),
            "transfer_encoding": request.headers.get("transfer-encoding"),
            "forwarded": request.headers.get("x-forwarded-for"),
            "sha256": hashlib.sha256(body).hexdigest(), "size": len(body),
        }

    @app.get("/admin")
    async def admin(request: Request) -> Response:
        names = [name for name, _ in token_headers(request)]
        if names in (["x-agentsdock-token"], ["x-zenithdock-token"]) and token_headers(request)[0][1] == REMOTE_TOKEN:
            return JSONResponse({"ok": True})
        return JSONResponse({"detail": "unauthorized", "seen": names}, status_code=401)

    @app.get("/bearer")
    async def bearer(request: Request) -> Response:
        creds = token_headers(request)
        if creds == [("authorization", f"Bearer {REMOTE_TOKEN}")]:
            return JSONResponse({"ok": True})
        return JSONResponse({"detail": "unauthorized", "seen": creds}, status_code=401)

    @app.get("/stream")
    async def stream() -> StreamingResponse:
        async def chunks():
            for index in range(3):
                yield f"chunk-{index};".encode()
                await asyncio.sleep(0.01)
        return StreamingResponse(chunks(), media_type="text/plain")

    @app.api_route("/range", methods=["GET", "HEAD"])
    async def ranged(request: Request) -> Response:
        payload = b"0123456789" * 10
        header = request.headers.get("range")
        if header:
            start, end = (int(part) for part in header.removeprefix("bytes=").split("-"))
            return Response(payload[start:end + 1], status_code=206, headers={"Content-Range": f"bytes {start}-{end}/{len(payload)}", "Accept-Ranges": "bytes"}, media_type="application/octet-stream")
        return Response(payload, media_type="application/octet-stream")

    @app.get("/api/health")
    async def health(request: Request) -> dict:
        return {"server_identity": identity, "token_ok": ("x-agentsdock-token", REMOTE_TOKEN) in token_headers(request)}

    @app.api_route("/api/sessions/{rest:path}", methods=["GET", "POST"])
    async def session_route(request: Request, rest: str) -> dict:
        body = await read_body(request)
        return {"identity": identity, "method": request.method, "path": rest, "size": len(body), "content_length": request.headers.get("content-length")}

    @app.websocket("/api/{rest:path}")
    async def ws_identity(ws: WebSocket, rest: str) -> None:
        await ws.accept()
        await ws.send_text(json.dumps({"identity": identity, "path": rest}))
        await ws.close()

    @app.websocket("/ws")
    async def ws_echo(ws: WebSocket) -> None:
        offered = [part.strip() for part in ws.headers.get("sec-websocket-protocol", "").split(",") if part.strip()]
        await ws.accept(subprotocol=offered[0] if offered else None)
        await ws.send_text(json.dumps({"protocols": offered, "query": ws.url.query, "header_token": ws.headers.get("x-agentsdock-token")}))
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await ws.send_bytes(message["bytes"][::-1])
            elif message["text"] == "close":
                await ws.close(code=4001, reason="bye")
                return
            else:
                await ws.send_text("echo:" + message["text"])

    @app.websocket("/slow-ws")
    async def ws_slow(ws: WebSocket) -> None:
        await asyncio.sleep(0.3)
        await ws.accept()
        await ws.receive()

    return app


async def serve(app: FastAPI):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(16)
    # log_config=None keeps uvicorn's loggers propagating, so a root-logger
    # handler sees ASGI errors.
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", log_config=None, access_log=False, lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        await asyncio.sleep(0.01)
    return server, task, sock.getsockname()[1]


async def stop(server: uvicorn.Server, task: asyncio.Task) -> None:
    server.should_exit = True
    await task


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def hub_hooks(**overrides):
    """The hub-side callables Update & redeploy all needs; tests inspect the mocks."""
    return SimpleNamespace(**{
        "hub_running_chat_count": lambda: 0,
        "hub_update_cli": mock.AsyncMock(side_effect=lambda backend: f"{backend}-hub-9.9"),
        "hub_restart": mock.AsyncMock(return_value=None),
        **overrides,
    })


async def hub_with_fake(tmp_path: Path, ws_authorized=lambda ws: True, hooks=None):
    hooks = hooks or hub_hooks()
    upstream_server, upstream_task, upstream_port = await serve(fake_upstream())
    manager = rs.RemoteServerManager(tmp_path, source_dir=tmp_path, manage_tunnels=False)
    remote = make_server(local_port=upstream_port)
    manager.servers[remote.id] = remote
    dead = make_server(id="deaddeaddead", name="dead", local_port=free_port())
    manager.servers[dead.id] = dead
    hub = FastAPI()
    rs.register_remote_server_routes(hub, manager=manager, authorize_admin=lambda request: None, websocket_authorized=ws_authorized,
                                     hub_running_chat_count=hooks.hub_running_chat_count, hub_update_cli=hooks.hub_update_cli, hub_restart=hooks.hub_restart)
    hub_server, hub_task, hub_port = await serve(hub)

    async def close() -> None:
        await manager.stop()
        await stop(hub_server, hub_task)
        await stop(upstream_server, upstream_task)

    return manager, remote, dead, hub_port, close


class RemoteServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_path = Path(self.enterContext(tempfile.TemporaryDirectory()))

    # --- registry -------------------------------------------------------------

    def test_registry_roundtrip_is_private_and_hides_tokens(self) -> None:
        path = self.tmp_path / "state" / "remote-servers.json"
        servers = [make_server(), make_server(id="123456abcdef", name="lab", local_port=7852)]
        rs.save_registry(path, servers)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert rs.load_registry(path) == servers
        view = rs.public_view(servers[0], {"state": "connected", "restarts": 0, "last_error": None})
        assert "token" not in view and view["proxy_path"] == "/api/remote/abcdef123456"
        assert rs.load_registry(self.tmp_path / "missing.json") == []

    def test_create_rejects_dangerous_input(self) -> None:
        for field, value in [
            ("ssh_host", "-oProxyCommand=curl evil"),
            ("ssh_host", "host name"),
            ("install_dir", "/tmp/with space"),
            ("install_dir", "-rf"),
            ("remote_port", 80),
            ("remote_port", 70000),
            ("token", "short"),
            ("token", "has whitespace " + "x" * 40),
        ]:
            with self.subTest(field=field, value=value):
                payload = {"ssh_host": "osmo_9000", "install_dir": "~/.agentsdock-server", "remote_port": 7850, "token": REMOTE_TOKEN}
                payload[field] = value
                with self.assertRaises(ValidationError):
                    rs.RemoteServerCreate(**payload)

    def test_update_changes_an_entry_in_place_and_redeploys_a_moved_one(self) -> None:
        async def main() -> None:
            manager = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
            manager.servers["abcdef123456"] = make_server()
            deploys: list[tuple[str | None, bool]] = []
            live_tunnel = mock.Mock(server=manager.servers["abcdef123456"])
            manager.tunnels["abcdef123456"] = live_tunnel
            with mock.patch.object(manager, "start_deploy", side_effect=lambda request, *, redeploy_id, keep_port: deploys.append((redeploy_id, keep_port)) or rs.DeployJob(job_id="job")):
                renamed, job = manager.update("abcdef123456", rs.RemoteServerUpdate(name=" lab "))
                assert (renamed.name, job, deploys) == ("lab", None, [])
                # A rename keeps the live forward instead of restarting it.
                assert manager.tunnels["abcdef123456"] is live_tunnel and live_tunnel.server.name == "lab"

                with mock.patch.dict(os.environ, {"AGENTSDOCK_OCI_HOME": "/mnt/lustre/me"}):
                    moved, job = manager.update("abcdef123456", rs.RemoteServerUpdate(ssh_host="oci@new_cluster"))
                # The old port may belong to the previous install's server; the new install picks its own.
                assert job is not None and deploys == [("abcdef123456", False)]
                with mock.patch.dict(os.environ, {"AGENTSDOCK_OCI_HOME": "/mnt/lustre/me"}), self.assertRaises(HTTPException) as odd:
                    manager.update("abcdef123456", rs.RemoteServerUpdate(ssh_host="oci@a:b"))
                assert odd.exception.status_code == 422
            # Same id, so client profiles stay; chats belong to their machine, so the new host gets
            # its own install on the shared storage instead of the old host's state.
            saved = rs.load_registry(manager.path)[0]
            assert (saved.id, saved.name, saved.ssh_host) == ("abcdef123456", "lab", "oci@new_cluster")
            assert saved.install_dir == "/mnt/lustre/me/.agentsdock-server-new_cluster"

            running = asyncio.get_running_loop().create_future()
            manager.jobs["busy"] = rs.DeployJob(job_id="busy", task=asyncio.ensure_future(running))
            with self.assertRaises(HTTPException) as busy:
                manager.update("abcdef123456", rs.RemoteServerUpdate(install_dir="/mnt/lustre/other"))
            assert busy.exception.status_code == 409 and manager.servers["abcdef123456"].install_dir == saved.install_dir
            running.cancel()
            with self.assertRaises(HTTPException) as unknown:
                manager.update("000000000000", rs.RemoteServerUpdate(name="x"))
            assert unknown.exception.status_code == 404

        asyncio.run(main())

    def test_update_route_rejects_unsafe_fields(self) -> None:
        manager = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
        manager.servers["abcdef123456"] = make_server()
        hub = FastAPI()
        rs.register_remote_server_routes(hub, manager=manager, authorize_admin=lambda request: None, websocket_authorized=lambda ws: True, **vars(hub_hooks()))
        client = TestClient(hub)
        assert client.patch(f"{rs.ADMIN_PATH}/abcdef123456", json={"ssh_host": "-oProxyCommand=x"}).status_code == 422
        response = client.patch(f"{rs.ADMIN_PATH}/abcdef123456", json={"name": "lab"})
        assert response.status_code == 200 and response.json()["server"]["name"] == "lab" and response.json()["job_id"] is None
        assert "token" not in response.json()["server"]

    def test_order_route_reorders_the_registry_around_what_the_client_has_synced(self) -> None:
        manager = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
        manager.servers["abcdef123456"] = make_server()
        manager.servers["123456abcdef"] = make_server(id="123456abcdef", name="lab", local_port=7852)
        manager.servers["fedcba654321"] = make_server(id="fedcba654321", name="new", local_port=7853)
        manager.servers["aaaaaa111111"] = make_server(id="aaaaaa111111", name="newer", local_port=7854)
        hub = FastAPI()
        rs.register_remote_server_routes(hub, manager=manager, authorize_admin=lambda request: None, websocket_authorized=lambda ws: True, **vars(hub_hooks()))
        client = TestClient(hub)
        # The client still holds a removed server's id and has not synced the two newest ones.
        assert client.put(f"{rs.ADMIN_PATH}/order", json={"ids": ["123456abcdef", "000000000000", "abcdef123456"]}).status_code == 204
        expected = ["123456abcdef", "abcdef123456", "fedcba654321", "aaaaaa111111"]
        assert [server["id"] for server in manager.list()] == expected
        assert [server.id for server in rs.load_registry(manager.path)] == expected
        assert rs.capability(manager)["ids"] == expected

    def test_deploy_request_defaults_and_port_zero(self) -> None:
        request = rs.RemoteDeployRequest(ssh_host="user@host")
        assert request.install_dir == "~/.agentsdock-server" and request.port == 0
        with self.assertRaises(ValidationError):
            rs.RemoteDeployRequest(ssh_host="host", port=22)

    def test_attach_request_validates_like_deploy(self) -> None:
        request = rs.RemoteAttachRequest(ssh_host="user@host")
        assert request.install_dir == "~/.agentsdock-server" and request.name is None and not hasattr(request, "port")
        for payload in [{"ssh_host": "-oProxyCommand=curl evil"}, {"ssh_host": "host", "install_dir": "/tmp/with space"}]:
            with self.assertRaises(ValidationError):
                rs.RemoteAttachRequest(**payload)

    # --- ssh argv and supervisor decisions ------------------------------------

    def test_tunnel_and_revive_args(self) -> None:
        assert rs.tunnel_args("osmo_9000", 7851, 7850) == [
            "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ControlMaster=no", "-o", "ControlPath=none",
            "-L", "127.0.0.1:7851:127.0.0.1:7850", "osmo_9000",
        ]
        # JSON tunnels ask ssh to compress; the argv is otherwise unchanged.
        compressed = rs.tunnel_args("osmo_9000", 7851, 7850, compress=True)
        assert compressed[-4:] == ["-C", "-L", "127.0.0.1:7851:127.0.0.1:7850", "osmo_9000"]
        assert [arg for arg in compressed if arg != "-C"] == rs.tunnel_args("osmo_9000", 7851, 7850)
        # No local port: a reverse-only connection (the inference tunnel) has no -L.
        reverse_only = rs.tunnel_args("osmo_9000", None, 7850)
        assert reverse_only[-3:] == ["-o", "ControlPath=none", "osmo_9000"] and "-L" not in reverse_only
        assert rs.revive_args("osmo_9000", "~/.agentsdock-server")[-3:] == ["bash", "-lc", "exec bash ~/.agentsdock-server/start.sh"]
        assert rs.remote_shell_args("h")[-4:] == ["h", "bash", "-s", "--"]
        with self.assertRaises(ValueError):
            rs.tunnel_args("-oProxyCommand=x", 7851, 7850)

    def test_plain_ssh_forward_persists_and_preserves_its_mapping(self) -> None:
        profile = rs.SSHForward(
            id="123456abcdef", name="herorun dashboard", ssh_host="herorun-288g-recovery-e0b3",
            local_port=8266, remote_port=8265, bind_mode="ipv4",
            channel_timeout="direct-tcpip=2m", ca_bundle_path="/tmp/sky-ca.pem",
            created_at="2026-09-28T00:00:00Z",
        )
        path = self.tmp_path / "state" / "ssh-forwards.json"
        rs.save_forward_registry(path, [profile])
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert rs.load_forward_registry(path) == [profile]
        args = rs.tunnel_args(profile.ssh_host, profile.local_port, profile.remote_port,
                              bind_mode=profile.bind_mode, channel_timeout=profile.channel_timeout)
        assert args[-5:] == ["-o", "ChannelTimeout=direct-tcpip=2m", "-L",
                             "127.0.0.1:8266:127.0.0.1:8265", profile.ssh_host]
        assert rs.tunnel_args("jing-debug-1e47", 9000, 22, bind_mode="dual")[-3:] == [
            "-L", "9000:127.0.0.1:22", "jing-debug-1e47",
        ]
        with self.assertRaises(ValidationError):
            rs.SSHForward(id="abcdef123456", created_at="2026-09-28T00:00:00Z",
                          name="bad", ssh_host="-oProxyCommand=x", local_port=9000, remote_port=22)
        with self.assertRaises(ValidationError):
            rs.SSHForward(id="abcdef123456", created_at="2026-09-28T00:00:00Z",
                          name="bad", ssh_host="jing-debug-1e47", local_port=9000, remote_port=0)

    def test_restart_moves_a_busy_port_clear_of_every_registered_port(self) -> None:
        # Seen live: the first server's port was still held by the old hub's ssh, and the
        # replacement was the port the second server, loaded later, was registered with.
        script = self.tmp_path / "ssh"
        script.write_text("#!/bin/sh\nexec sleep 30\n")
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        first_free = rs.find_free_local_port(set())
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            held = busy.getsockname()[1]
            manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
            rs.save_registry(manager.path, [
                make_server(id="aaaaaaaaaaaa", local_port=held),
                make_server(id="bbbbbbbbbbbb", local_port=first_free),
            ])

            async def main() -> None:
                await manager.start()
                await manager.stop()

            asyncio.run(main())
        ports = {server.id: server.local_port for server in rs.load_registry(manager.path)}
        assert ports["bbbbbbbbbbbb"] == first_free
        assert ports["aaaaaaaaaaaa"] not in (held, first_free)

    def test_plain_ssh_forward_loads_after_manager_restart(self) -> None:
        async def main() -> None:
            manager = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
            original = rs.SSHForward(
                id="abcdef123456", created_at="2026-09-28T00:00:00Z", name="debug ssh",
                ssh_host="jing-debug-1e47", local_port=9000, remote_port=22, bind_mode="dual",
            )
            rs.save_forward_registry(manager.forward_path, [original])
            await manager.start()
            assert manager.list_forwards()[0]["ssh_host"] == "jing-debug-1e47"
            await manager.stop()

            rs.save_forward_registry(manager.forward_path, [original.model_copy(update={"ssh_host": "jing-debug-3edd"})])
            restarted = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
            await restarted.start()
            assert restarted.list_forwards()[0]["ssh_host"] == "jing-debug-3edd"
            await restarted.stop()

        asyncio.run(main())

    def test_plain_ssh_forward_retries_after_process_exit(self) -> None:
        script = self.tmp_path / "ssh"
        calls = self.tmp_path / "forward-calls.jsonl"
        script.write_text(f'''#!{sys.executable}
import json, os, socket, sys, time
args = sys.argv[1:]
if "-G" in args:
    print("proxycommand ssh -tt -W '[%h]:%p' root@127.0.0.1")
    sys.exit(0)
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps({{"args": args, "ca": os.environ.get("SSL_CERT_FILE"),
                          "requests_ca": os.environ.get("REQUESTS_CA_BUNDLE")}}) + "\\n")
count = len(open({str(calls)!r}).readlines())
if count == 1:
    print("channel 1: open failed: connect failed: Connection refused", file=sys.stderr)
    sys.exit(255)
binding = args[args.index("-L") + 1].split(":")
with socket.socket() as listener:
    listener.bind((binding[0], int(binding[1])))
    listener.listen(1)
    print("debug1: Local forwarding listening on %s port %s." % (binding[0], binding[1]),
          file=sys.stderr, flush=True)
    time.sleep(30)
''')
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        self.enterContext(mock.patch.object(rs, "MIN_BACKOFF", 0.05))
        self.enterContext(mock.patch.object(rs, "SETTLE_SECONDS", 0.05))
        local_port = free_port()
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        forward = rs.SSHForward(
            id="123456abcdef", name="debug", ssh_host="jing-debug-1e47", local_port=local_port,
            remote_port=20034, bind_mode="ipv4", ca_bundle_path=str(self.tmp_path / "sky-ca.pem"),
            created_at="2026-09-28T00:00:00Z",
        )
        rs.save_forward_registry(manager.forward_path, [forward])

        async def main() -> None:
            await manager.start()
            try:
                for _ in range(100):
                    status = manager.list_forwards()[0]["tunnel"]
                    if status["state"] == "connected" and status["restarts"] == 1:
                        break
                    await asyncio.sleep(0.05)
                else:
                    self.fail(f"forward did not reconnect: {status}")
                with socket.create_connection(("127.0.0.1", local_port), timeout=1):
                    pass
            finally:
                await manager.stop()

        asyncio.run(main())
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        assert len(records) == 2
        assert all(record["ca"] == str(self.tmp_path / "sky-ca.pem")
                   and record["requests_ca"] == record["ca"] for record in records)
        assert all("ConnectTimeout=30" in record["args"] for record in records)
        assert all(any(arg.startswith("ProxyCommand=ssh -S none -o ControlMaster=no -o ControlPath=none")
                       for arg in record["args"]) for record in records)

    def test_backoff_and_revive_detection(self) -> None:
        values = []
        current = rs.MIN_BACKOFF
        for _ in range(6):
            values.append(current)
            current = rs.next_backoff(current)
        assert values == [2, 4, 8, 10, 10, 10]
        assert rs.needs_revive("channel 3: open failed: connect failed: Connection refused\n")
        assert not rs.needs_revive("Warning: Permanently added 'osmo' (ED25519) to the list of known hosts.")

    def test_parse_probe_result_and_setup_log(self) -> None:
        probe = rs.parse_probe(["noise", 'AGENTSDOCK_TUNNEL_PROBE={"home": "/h", "free_port": 7850, "tmux": true}'])
        assert probe["free_port"] == 7850
        with self.assertRaises(RuntimeError):
            rs.parse_probe(["nothing"])
        result = rs.parse_setup_result([
            "[AgentsDock setup] Starting AgentsServer on port 7850",
            'AGENTSDOCK_SETUP_RESULT={"access_token": "t", "remote_port": 7850, "install_dir": "/h/.agentsdock-server"}',
        ])
        assert result["install_dir"] == "/h/.agentsdock-server"
        assert rs.setup_log_message("[AgentsDock setup] Installing uv") == "Installing uv"
        assert rs.setup_log_message("plain") is None

    def test_source_tarball_excludes_only_the_agreed_paths(self) -> None:
        source = self.tmp_path / "server"
        for relative in ["agent_server.py", ".venv/lib/x.py", "tests/test_x.py", "pkg/__pycache__/x.pyc", "pkg/keep.py", "canvas_runtime/node_modules/lib/tests/keep.js", ".DS_Store"]:
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("x")
        with tarfile.open(fileobj=io.BytesIO(rs.build_source_tarball(source)), mode="r:gz") as tar:
            names = sorted(tar.getnames())
        assert names == ["agent_server.py", "canvas_runtime", "canvas_runtime/node_modules", "canvas_runtime/node_modules/lib", "canvas_runtime/node_modules/lib/tests", "canvas_runtime/node_modules/lib/tests/keep.js", "pkg", "pkg/keep.py"]

    # --- deploy jobs against a scripted host ----------------------------------

    def fake_host(self, existing_port: int | None) -> Path:
        """Point ssh at a script playing the host; returns the argv log it appends to."""
        state = self.tmp_path / "host"
        state.mkdir()
        (state / "host.json").write_text(json.dumps({"token": REMOTE_TOKEN, "existing_port": existing_port}))
        script = self.tmp_path / "ssh"
        script.write_text(FAKE_SSH.format(python=sys.executable, state=str(state)))
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        # manage_tunnels=False opens no tunnel, so the health poll is answered here.
        self.enterContext(mock.patch.object(rs.RemoteServerManager, "_wait_health", mock.AsyncMock(return_value={"version": "1.2.3"})))
        return state / "calls.jsonl"

    def run_job(self, request: rs.RemoteAttachRequest) -> tuple[rs.RemoteServerManager, rs.DeployJob]:
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path, manage_tunnels=False)

        async def main() -> rs.DeployJob:
            job = manager.start_deploy(request)
            assert job.task is not None
            await job.task
            await manager.stop()
            return job

        return manager, asyncio.run(main())

    def test_a_password_installs_the_hubs_key_once_before_the_probe(self) -> None:
        calls = self.fake_host(existing_port=None)
        self.enterContext(mock.patch.object(rs, "hub_public_key", mock.AsyncMock(return_value="ssh-ed25519 AAAAtest hub")))
        request = rs.RemoteDeployRequest(ssh_host="dev@build-host", password="hunter2")
        assert "hunter2" not in repr(request)
        manager, job = self.run_job(request)
        assert job.done and job.error is None, job.log
        sessions = [json.loads(line) for line in calls.read_text().splitlines()]
        # The key install comes first, authenticates with the password from the askpass helper, and no other session sees it.
        install = sessions[0]
        assert install["tail"] is None and "BatchMode=yes" not in install["argv"] and install["askpass_require"] == "force"
        assert {"BatchMode=no", "PubkeyAuthentication=no", "PasswordAuthentication=yes", "NumberOfPasswordPrompts=1"} <= set(install["argv"])
        assert install["command"] == "'umask 077 && mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'"
        assert install["stdin_head"] == "\nssh-ed25519 AAAAtest hub\n" and install["password"] == "hunter2"
        assert "hunter2" not in json.dumps(install["argv"]) and "hunter2" not in install["stdin_head"]
        assert all(session["password"] is None for session in sessions[1:]) and sessions[1]["tail"] == ["~/.agentsdock-server"]
        messages = [entry["message"] for entry in job.log]
        assert any(message.startswith("Installing this hub's SSH key on dev@build-host") for message in messages)
        assert "hunter2" not in json.dumps(job.view(None))

    def test_a_refused_password_fails_the_key_install_with_the_hosts_reason(self) -> None:
        self.fake_host(existing_port=None)
        self.enterContext(mock.patch.object(rs, "hub_public_key", mock.AsyncMock(return_value="ssh-ed25519 AAAAtest hub")))
        _, job = self.run_job(rs.RemoteDeployRequest(ssh_host="dev@build-host", password="wrong"))
        assert job.error == "dev@build-host did not accept the password."
        _, job = self.run_job(rs.RemoteDeployRequest(ssh_host="dev@build-host", password="keys-only"))
        assert job.error == "dev@build-host does not accept passwords; install a key there by hand."

    def test_a_cluster_target_rejects_a_password(self) -> None:
        self.fake_host(existing_port=None)
        with mock.patch.object(rs, "ssh_route", mock.AsyncMock(return_value=rs.SSHRoute([], "root@wf", {}))):
            _, job = self.run_job(rs.RemoteDeployRequest(ssh_host="osmo@wf", password="hunter2"))
        assert job.error == "oci@ and osmo@ targets are reached through the cluster CLI; leave the password empty."

    def test_hub_public_key_uses_the_resolved_identity_or_generates_one(self) -> None:
        self.fake_host(existing_port=None)
        home = self.tmp_path / "home"
        home.mkdir()
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            # No public key yet: an ed25519 key is generated, preferred over the id_rsa and the %-token entries.
            generated = asyncio.run(rs.hub_public_key(rs.SSHRoute([], "build-host", dict(os.environ))))
            assert generated.startswith("ssh-ed25519 ") and generated.endswith(" agentsdock-hub")
            assert (home / ".ssh" / "id_ed25519.pub").read_text().strip() == generated
            # The first resolved identity with a public key is reused, never regenerated.
            (home / ".ssh" / "id_rsa.pub").write_text("ssh-rsa AAAAexisting me\n")
            assert asyncio.run(rs.hub_public_key(rs.SSHRoute([], "build-host", dict(os.environ)))) == "ssh-rsa AAAAexisting me"
            # A private key whose .pub is missing is read back, not overwritten.
            (home / ".ssh" / "id_rsa.pub").unlink()
            (home / ".ssh" / "id_ed25519.pub").unlink()
            derived = asyncio.run(rs.hub_public_key(rs.SSHRoute([], "build-host", dict(os.environ))))
            assert derived.split()[:2] == generated.split()[:2]
            assert (home / ".ssh" / "id_ed25519").exists() and not (home / ".ssh" / "id_ed25519.pub").exists()

    def test_attach_registers_the_existing_install_without_uploading_or_restarting(self) -> None:
        calls = self.fake_host(existing_port=7860)
        manager, job = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server"))
        assert job.done and job.error is None, job.log
        [server] = rs.load_registry(manager.path)
        assert (server.name, server.ssh_host, server.install_dir, server.remote_port, server.token) == ("osmo_9000", "osmo_9000", "/mnt/lustre/.agentsdock-server", 7860, REMOTE_TOKEN)
        assert job.server == server and job.phase == "complete" and server.attached
        # Exactly two ssh sessions, the probe and the bootstrap: no upload command,
        # and the bootstrap gets no "restart" argument.
        sessions = [json.loads(line)["tail"] for line in calls.read_text().splitlines()]
        assert sessions == [["/mnt/lustre/.agentsdock-server"], ["/mnt/lustre/.agentsdock-server", "7860", "/h"]]
        assert "download" not in {entry["phase"] for entry in job.log}

    def test_a_deploy_over_an_attached_entry_makes_it_this_hubs_install(self) -> None:
        self.fake_host(existing_port=7860)
        manager, _ = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server"))
        [server] = rs.load_registry(manager.path)

        async def main() -> rs.DeployJob:
            await manager.start()
            # The path a move takes (update → start_deploy); the redeploy route refuses attached entries.
            job = manager.start_deploy(None, redeploy_id=server.id)
            await job.task
            await manager.stop()
            return job

        job = asyncio.run(main())
        assert job.error is None, job.log
        assert not rs.load_registry(manager.path)[0].attached

    def test_a_deploy_naming_a_registered_install_updates_that_entry_and_keeps_its_id(self) -> None:
        self.fake_host(existing_port=7860)
        manager, _ = self.run_job(rs.RemoteDeployRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server", name="first"))
        [server] = rs.load_registry(manager.path)

        async def main() -> rs.DeployJob:
            await manager.start()
            job = manager.start_deploy(rs.RemoteDeployRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server"))
            await job.task
            await manager.stop()
            return job

        job = asyncio.run(main())
        assert job.error is None, job.log
        # Clients address a remote as /api/remote/<id>; a second entry for the same install
        # would strand every saved profile on the retired id.
        [again] = rs.load_registry(manager.path)
        assert (again.id, again.name) == (server.id, "first")

    def test_a_rename_during_a_redeploy_survives_its_write_back(self) -> None:
        self.fake_host(existing_port=7860)
        manager, _ = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server"))
        [server] = rs.load_registry(manager.path)
        # The redeploy reports a new token, so it writes the entry back.
        host = self.tmp_path / "host" / "host.json"
        host.write_text(json.dumps({"token": "t" * 40, "existing_port": 7860}))
        parse = rs.parse_setup_result

        def rename_then_parse(lines):
            manager.update(server.id, rs.RemoteServerUpdate(name="renamed"))
            return parse(lines)

        async def main() -> rs.DeployJob:
            await manager.start()
            with mock.patch.object(rs, "parse_setup_result", side_effect=rename_then_parse):
                job = manager.start_deploy(None, redeploy_id=server.id)
                await job.task
            await manager.stop()
            return job

        job = asyncio.run(main())
        assert job.error is None, job.log
        [saved] = rs.load_registry(manager.path)
        assert (saved.name, saved.token) == ("renamed", "t" * 40)

    def fake_osmo(self) -> None:
        """Put an ``osmo`` first on PATH that answers ``workflow query``."""
        bin_dir = self.tmp_path / "bin"
        bin_dir.mkdir()
        script = bin_dir / "osmo"
        script.write_text(f"""#!{sys.executable}
import json, sys
workflow = sys.argv[3]
tasks = [dict(name="worker_1", lead=False), dict(name="master", lead=True)]
answers = {{
    "wf-running": dict(status="RUNNING", groups=[dict(tasks=tasks)]),
    "wf-done": dict(status="COMPLETED", groups=[dict(tasks=tasks)]),
    "wf-garbled": dict(status="RUNNING", groups=[dict(tasks=[None])]),
}}
if workflow not in answers:
    print("Workflow " + workflow + " not found", file=sys.stderr)
    sys.exit(1)
print(json.dumps(answers[workflow]))
""")
        script.chmod(0o700)
        self.enterContext(mock.patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}))

    def test_cluster_notations_resolve_to_ssh_routes(self) -> None:
        self.fake_osmo()
        plain = asyncio.run(rs.ssh_route("osmo_9000"))
        assert (plain.options, plain.destination) == ([], "osmo_9000")

        route = asyncio.run(rs.ssh_route("osmo@wf-running"))
        osmo = shlex.quote(str(self.tmp_path / "bin" / "osmo"))
        assert route.destination == "root@wf-running"
        assert route.options == [
            "-o", "ConnectTimeout=30",
            "-o", f"ProxyCommand={osmo} workflow exec wf-running master --raw --raw-port 22",
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        ]
        for host, message in (("osmo@wf-done", "is COMPLETED"), ("osmo@wf-missing", "not found"),
                              ("osmo@wf-garbled", "unexpected result"), ("osmo@a%b", "Invalid OSMO workflow id"),
                              ("osmo@-x", "Invalid OSMO workflow id")):
            with self.assertRaisesRegex(OSError, message):
                asyncio.run(rs.ssh_route(host))

        ca = self.tmp_path / "sky-ca.pem"
        ca.write_text("ca")
        with (mock.patch.object(rs, "SKY_CA_BUNDLE", ca),
              mock.patch.object(rs, "write_sky_ssh_entry", mock.AsyncMock()),
              mock.patch.object(rs, "isolated_proxy_args", mock.AsyncMock(return_value=["-o", "ProxyCommand=x"])) as isolated):
            route = asyncio.run(rs.ssh_route("oci@sky-cluster"))
            isolated.assert_awaited_once_with("sky-cluster")
            assert (route.options, route.destination) == (["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x"], "sky-cluster")
            assert route.env["SSL_CERT_FILE"] == route.env["REQUESTS_CA_BUNDLE"] == str(ca)
            isolated.return_value = []
            with self.assertRaisesRegex(OSError, "no ssh entry"):
                asyncio.run(rs.ssh_route("oci@gone-cluster"))

    def test_deploy_health_wait_outlasts_a_slow_relay(self) -> None:
        # Through an osmo exec relay each request took 3-8 s (0.09 s on the host itself).
        manager = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
        server = rs.RemoteServer(id="abcdefabcdef", name="osmo", ssh_host="osmo@wf-running", install_dir="/mnt/x",
                                 remote_port=7850, local_port=7851, token="t" * 32, created_at="2026-09-30T00:00:00Z")
        answer = httpx.Response(200, json={"version": "1.2.3"})
        get = mock.AsyncMock(side_effect=[httpx.ReadTimeout("slow"), httpx.ConnectError("not yet"), answer])
        self.enterContext(mock.patch.object(manager.http, "get", get))
        self.enterContext(mock.patch.object(rs.asyncio, "sleep", mock.AsyncMock()))

        assert asyncio.run(manager._wait_health(server)) == {"version": "1.2.3"}
        assert all(call.kwargs["timeout"] >= 15 for call in get.await_args_list)

    def test_a_missing_sky_ssh_entry_is_written_by_sky_status_before_giving_up(self) -> None:
        # Sky writes a cluster's ssh entry when `sky status` lists it; a new cluster has none yet.
        bin_dir = self.tmp_path / "sky-bin"
        bin_dir.mkdir()
        calls = self.tmp_path / "sky-calls.jsonl"
        sky = bin_dir / "sky"
        sky.write_text(f"""#!{sys.executable}
import json, os, sys
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps([sys.argv[1:], os.environ.get("SSL_CERT_FILE")]) + "\\n")
""")
        sky.chmod(0o700)
        ca = self.tmp_path / "sky-ca.pem"
        ca.write_text("ca")
        self.enterContext(mock.patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}))
        self.enterContext(mock.patch.object(rs, "SKY_CA_BUNDLE", ca))
        isolated = self.enterContext(mock.patch.object(rs, "isolated_proxy_args", mock.AsyncMock(side_effect=[[], ["-o", "ProxyCommand=x"]])))

        route = asyncio.run(rs.ssh_route("oci@new-cluster"))
        assert (route.options, route.destination) == (["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x"], "new-cluster")
        assert [json.loads(line) for line in calls.read_text().splitlines()] == [[["status", "-u", "--", "new-cluster"], str(ca)]]
        assert isolated.await_count == 2

        isolated.side_effect = [[], []]
        with self.assertRaisesRegex(OSError, "no ssh entry for gone-cluster"):
            asyncio.run(rs.ssh_route("oci@gone-cluster"))

    def test_osmo_workflow_deploys_and_revives_through_its_proxy_command(self) -> None:
        calls = self.fake_host(existing_port=None)
        self.fake_osmo()
        manager, job = self.run_job(rs.RemoteDeployRequest(ssh_host="osmo@wf-running", install_dir="/mnt/shared/u/.agentsdock-server"))
        assert job.done and job.error is None, job.log
        [server] = rs.load_registry(manager.path)
        # The registry keeps the notation, so every reconnect resolves the workflow's lead task again.
        assert server.ssh_host == "osmo@wf-running"
        assert server.install_dir == "/mnt/shared/u/.agentsdock-server"  # an explicit directory is kept
        asyncio.run(rs.start_remote_server(server))
        route = asyncio.run(rs.ssh_route("osmo@wf-running"))
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        # probe, upload, bootstrap, start.sh: each ssh call goes through the workflow's route.
        assert [record["tail"] is not None for record in records] == [True, False, True, False]
        for record in records:
            argv = record["argv"]
            assert argv[:len(route.options)] == route.options and argv.count("root@wf-running") == 1 and "osmo@wf-running" not in argv

    def test_cluster_installs_default_to_one_install_per_target_in_the_configured_homes(self) -> None:
        calls = self.fake_host(existing_port=7860)
        self.fake_osmo()
        ca = self.tmp_path / "sky-ca.pem"
        ca.write_text("ca")
        self.enterContext(mock.patch.object(rs, "SKY_CA_BUNDLE", ca))
        self.enterContext(mock.patch.object(rs, "isolated_proxy_args", mock.AsyncMock(return_value=["-o", "ProxyCommand=x"])))
        self.enterContext(mock.patch.dict(os.environ, {"AGENTSDOCK_OSMO_HOME": "/mnt/osmo-home/u", "AGENTSDOCK_OCI_HOME": "/mnt/oci-home/u/"}))
        for host, home in (("osmo@wf-running", "/mnt/osmo-home/u"), ("oci@sky-cluster", "/mnt/oci-home/u")):
            manager, job = self.run_job(rs.RemoteAttachRequest(ssh_host=host))
            assert job.done and job.error is None, job.log
            server = next(server for server in rs.load_registry(manager.path) if server.ssh_host == host)
            assert server.install_dir == f"{home}/.agentsdock-server-{host.split('@')[1]}"
        # Sky's websocket proxy runs inside the oci@ ssh calls (the last two) and needs the CA bundle there.
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        assert [record["ca"] for record in records[2:]] == [str(ca), str(ca)]
        # Without a configured home the usual default stays.
        del os.environ["AGENTSDOCK_OSMO_HOME"]
        manager, job = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo@wf-running"))
        assert [server.install_dir for server in rs.load_registry(manager.path) if server.ssh_host == "osmo@wf-running"][-1] == rs.DEFAULT_INSTALL_DIR

    def test_oci_server_tunnel_carries_the_configured_site_forwards(self) -> None:
        script = self.tmp_path / "ssh"
        calls = self.tmp_path / "tunnel-calls.jsonl"
        script.write_text(f"""#!{sys.executable}
import json, sys, time
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
if "-N" in sys.argv:
    time.sleep(30)
""")
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        self.enterContext(mock.patch.object(rs, "isolated_proxy_args", mock.AsyncMock(return_value=["-o", "ProxyCommand=x"])))
        self.enterContext(mock.patch.dict(os.environ, {"AGENTSDOCK_OCI_TUNNEL_SSH_ARGS": "-R 12052:git.example:12051 -o ExitOnForwardFailure=no"}))
        os.environ.pop("AGENTSDOCK_INFERENCE_PROXY_PORT", None)
        self.enterContext(mock.patch.object(rs, "SETTLE_SECONDS", 0.05))
        oci_port = free_port()
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        rs.save_registry(manager.path, [
            make_server(id="aaaaaaaaaaaa", ssh_host="oci@sky-cluster", local_port=oci_port),
            make_server(id="bbbbbbbbbbbb", ssh_host="plain-host", local_port=free_port()),
        ])

        async def main() -> None:
            await manager.start()
            try:
                # Two servers, each with its main, bulk, stream and surface tunnel, plus one git rewrite.
                for _ in range(200):
                    if calls.exists() and len(calls.read_text().splitlines()) == 9:
                        return
                    await asyncio.sleep(0.05)
                self.fail("tunnels did not start")
            finally:
                await manager.stop()

        asyncio.run(main())
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        tunnels = [argv for argv in records if "-N" in argv]
        [oci] = [argv for argv in tunnels if argv[-2] == f"127.0.0.1:{oci_port}:127.0.0.1:7850"]
        # Before the tunnel's own options, so ExitOnForwardFailure=no wins over its =yes.
        assert oci[:9] == ["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x", "-R", "12052:git.example:12051", "-o", "ExitOnForwardFailure=no", "-N"]
        # The bulk, stream and surface tunnels must not claim the site forward's remote port a second time.
        oci_others = [argv for argv in tunnels if argv[-1] == "sky-cluster" and argv is not oci]
        assert len(oci_others) == 3 and all(argv[:5] == ["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x", "-N"] for argv in oci_others)
        assert all("-R" not in argv for argv in tunnels if argv[-1] == "plain-host")
        # Once connected, git on the host is pointed at the forward, in the server's HOME.
        [rewrite] = [argv for argv in records if "-N" not in argv]
        assert rewrite[-2] == "sky-cluster" and "-R" not in rewrite
        assert rewrite[-1].startswith("set -a; . /mnt/lustre/.agentsdock-server/env; set +a; ")
        assert "url.ssh://git@127.0.0.1:12052/.insteadOf" in rewrite[-1] and "ssh://git@git.example:12051/" in rewrite[-1]

    def test_every_server_gets_an_inference_tunnel_that_alone_reverse_forwards_the_proxy_port(self) -> None:
        script = self.tmp_path / "ssh"
        calls = self.tmp_path / "tunnel-calls.jsonl"
        script.write_text(f"""#!{sys.executable}
import json, sys, time
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
if "-N" in sys.argv:
    time.sleep(30)
""")
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        self.enterContext(mock.patch.object(rs, "isolated_proxy_args", mock.AsyncMock(return_value=["-o", "ProxyCommand=x"])))
        self.enterContext(mock.patch.dict(os.environ, {
            "AGENTSDOCK_INFERENCE_PROXY_PORT": "20001",
            "AGENTSDOCK_OCI_TUNNEL_SSH_ARGS": "-R 12052:git.example:12051",
        }))
        self.enterContext(mock.patch.object(rs, "SETTLE_SECONDS", 0.05))
        oci_port, plain_port = free_port(), free_port()
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        rs.save_registry(manager.path, [
            make_server(id="aaaaaaaaaaaa", ssh_host="oci@sky-cluster", local_port=oci_port),
            make_server(id="bbbbbbbbbbbb", ssh_host="plain-host", local_port=plain_port),
        ])

        async def main() -> None:
            await manager.start()
            try:
                # Two servers, each with its main, bulk, stream, surface and inference tunnel, plus the oci@ site forward's git rewrite.
                for _ in range(200):
                    if calls.exists() and len(calls.read_text().splitlines()) == 11:
                        break
                    await asyncio.sleep(0.05)
                else:
                    self.fail("tunnels did not start")
                assert set(manager.inference_tunnels) == {"aaaaaaaaaaaa", "bbbbbbbbbbbb"}
                # No -L, so no local port to keep free for it.
                assert manager._reserved_ports() == {oci_port, plain_port} | {
                    tunnel.server.local_port for tunnel in [*manager.bulk_tunnels.values(), *manager.stream_tunnels.values(),
                                                            *manager.surface_tunnels.values()]}
                plain_inference = manager.inference_tunnels["bbbbbbbbbbbb"]
                await manager.remove("bbbbbbbbbbbb")
                assert "bbbbbbbbbbbb" not in manager.inference_tunnels and plain_inference.status["state"] == "stopped"
            finally:
                await manager.stop()

        asyncio.run(main())
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        tunnels = [argv for argv in records if "-N" in argv]
        inference = [argv for argv in tunnels if "-L" not in argv]
        forwards = [argv for argv in tunnels if "-L" in argv]
        assert len(inference) == 2 and len(forwards) == 8
        # Every host, not only oci@, gets the forward, on a connection that carries nothing else;
        # the main, bulk, stream and surface tunnels must not claim the remote port too.
        for argv in inference:
            assert ("-R", "20001:127.0.0.1:20001") in zip(argv, argv[1:]) and argv.count("-R") == 1
        assert sorted(argv[-1] for argv in inference) == ["plain-host", "sky-cluster"]
        [oci_inference] = [argv for argv in inference if argv[-1] == "sky-cluster"]
        assert oci_inference[:7] == ["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x", "-R", "20001:127.0.0.1:20001", "-N"]
        assert all("20001:127.0.0.1:20001" not in argv for argv in forwards)
        # The git rewrite reads the site forwards only, since the proxy port is not a git server,
        # and its own short connection carries no proxy forward.
        [rewrite] = [argv for argv in records if "-N" not in argv]
        assert "ssh://git@git.example:12051/" in rewrite[-1] and all("20001" not in arg for arg in rewrite)

    def test_a_non_port_inference_proxy_value_is_ignored_instead_of_breaking_the_tunnels(self) -> None:
        script = self.tmp_path / "ssh"
        calls = self.tmp_path / "tunnel-calls.jsonl"
        script.write_text(f"""#!{sys.executable}
import json, sys, time
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
time.sleep(30)
""")
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        self.enterContext(mock.patch.dict(os.environ, {"AGENTSDOCK_INFERENCE_PROXY_PORT": "twenty"}))
        os.environ.pop("AGENTSDOCK_OCI_TUNNEL_SSH_ARGS", None)
        self.enterContext(mock.patch.object(rs, "SETTLE_SECONDS", 0.05))
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        rs.save_registry(manager.path, [make_server(id="bbbbbbbbbbbb", ssh_host="plain-host", local_port=free_port())])

        async def main() -> None:
            await manager.start()
            try:
                for _ in range(200):
                    if calls.exists() and len(calls.read_text().splitlines()) == 4:
                        return
                    await asyncio.sleep(0.05)
                self.fail("tunnels did not start")
            finally:
                await manager.stop()

        with self.assertLogs(rs.logger, level="WARNING") as logs:
            asyncio.run(main())
        assert any("AGENTSDOCK_INFERENCE_PROXY_PORT='twenty'" in line for line in logs.output)
        assert all("-R" not in argv for argv in (json.loads(line) for line in calls.read_text().splitlines()))
        assert manager.inference_tunnels == {}

    def test_osmo_tunnel_forwards_through_the_workflow_and_reports_an_ended_one(self) -> None:
        self.fake_osmo()
        script = self.tmp_path / "ssh"
        calls = self.tmp_path / "tunnel-calls.jsonl"
        script.write_text(f"""#!{sys.executable}
import json, sys, time
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
time.sleep(30)
""")
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        self.enterContext(mock.patch.object(rs, "SETTLE_SECONDS", 0.05))
        # The ssh count below assumes no inference tunnel; the developer's shell may export the port.
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop("AGENTSDOCK_INFERENCE_PROXY_PORT", None)
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        running_port = free_port()
        rs.save_registry(manager.path, [
            make_server(id="aaaaaaaaaaaa", ssh_host="osmo@wf-running", local_port=running_port),
            make_server(id="bbbbbbbbbbbb", ssh_host="osmo@wf-done", local_port=free_port()),
        ])

        async def main() -> dict:
            await manager.start()
            try:
                # The running workflow starts its main, upload, stream and surface tunnels; the ended one never reaches ssh.
                for _ in range(200):
                    running = manager.tunnel_status("aaaaaaaaaaaa")
                    ended = manager.tunnel_status("bbbbbbbbbbbb")
                    if (running["state"] == "connected" and ended["state"] == "reconnecting"
                            and calls.exists() and len(calls.read_text().splitlines()) == 4):
                        return ended
                    await asyncio.sleep(0.05)
                self.fail(f"tunnels did not settle: {running} {ended}")
            finally:
                await manager.stop()

        ended = asyncio.run(main())
        assert "OSMO workflow wf-done is COMPLETED" in ended["last_error"]
        route = asyncio.run(rs.ssh_route("osmo@wf-running"))
        argvs = [json.loads(line) for line in calls.read_text().splitlines()]
        assert all(argv[:len(route.options)] == route.options and argv[-3] == "-L" and argv[-1] == "root@wf-running" for argv in argvs)
        assert sum(argv[-2] == f"127.0.0.1:{running_port}:127.0.0.1:7850" for argv in argvs) == 1

    def test_attach_fails_when_the_host_has_no_install(self) -> None:
        calls = self.fake_host(existing_port=None)
        manager, job = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo_9000"))
        assert job.done and job.error == "No AgentsServer install was found at ~/.agentsdock-server on osmo_9000. Deploy a new server instead."
        assert len(calls.read_text().splitlines()) == 1  # the probe only; the bootstrap never ran
        assert rs.load_registry(manager.path) == []

    def test_attach_route_runs_the_job_and_validates_the_body(self) -> None:
        self.fake_host(existing_port=7860)

        async def main() -> None:
            manager, _remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            try:
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{hub_port}") as client:
                    response = await client.post("/api/admin/remote-servers/attach", json={"ssh_host": "osmo_9000", "install_dir": "/mnt/lustre/.agentsdock-server", "name": "lustre"})
                    assert response.status_code == 202, response.text
                    job = manager.jobs[response.json()["job_id"]]
                    assert job.task is not None
                    await job.task
                    view = (await client.get(f"/api/admin/remote-servers/deploy/{job.job_id}")).json()
                    assert view["done"] and view["error"] is None, view["log"]
                    assert (view["server"]["name"], view["server"]["remote_port"]) == ("lustre", 7860) and "token" not in view["server"]
                    # Another hub owns an attached install: this hub neither uploads to nor restarts it.
                    refused = await client.post(f"/api/admin/remote-servers/{view['server']['id']}/redeploy")
                    assert refused.status_code == 409 and "attached" in refused.json()["detail"]
                    assert (await client.post("/api/admin/remote-servers/attach", json={"ssh_host": "bad host"})).status_code == 422
            finally:
                await close()

        asyncio.run(main())

    def test_update_all_redeploys_each_remote_updates_every_cli_and_restarts_the_hub_last(self) -> None:
        order: list[tuple[str, ...]] = []
        hooks = hub_hooks(hub_running_chat_count=lambda: 2)
        hooks.hub_update_cli.side_effect = lambda backend: order.append(("hub-cli", backend)) or f"{backend}-hub-9.9"
        released = asyncio.Event()

        async def restart() -> None:
            order.append(("restart",))
            await released.wait()  # holds the job open so the one-job-at-a-time rule can be checked
            return None

        hooks.hub_restart.side_effect = restart

        async def fake_deploy(job, request, redeploy_id, keep_port=True):
            order.append(("redeploy", redeploy_id))
            job.progress("upload", "Uploading the server…")
            if redeploy_id == "deaddeaddead":
                job.error = "ssh exited 255"
                job.progress("connect", job.error)
            job.done = True

        async def main() -> None:
            manager, remote, dead, hub_port, close = await hub_with_fake(self.tmp_path, hooks=hooks)
            attached = make_server(id="attachedatta", name="attached", local_port=free_port(), attached=True)
            manager.servers[attached.id] = attached
            real_update_cli = manager.update_cli

            async def update_cli(server, backend):
                order.append(("cli", server.id, backend))
                # The reachable remote answers the real request; the others have no server behind their port.
                return await real_update_cli(server, backend)

            probes = mock.AsyncMock(side_effect=lambda server: {"active": ["c1"]} if server is remote else None)
            try:
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{hub_port}") as client:
                    with mock.patch.object(manager, "_deploy", fake_deploy), mock.patch.object(manager, "update_cli", update_cli), \
                            mock.patch.object(manager, "probe_health", probes):
                        # Without force, the servers whose chats would stop are reported and nothing runs: the hub by
                        # its own count, a remote by its health, an unreachable remote as unknown, an attached one never.
                        blocked = await client.post("/api/admin/remote-servers/update-all", json={})
                        assert blocked.status_code == 200 and blocked.json() == {"running": [
                            {"id": None, "running": 2}, {"id": remote.id, "name": remote.name, "running": 1}, {"id": dead.id, "name": "dead", "running": None},
                        ]}
                        assert order == [] and probes.await_count == 2

                        started = await client.post("/api/admin/remote-servers/update-all", json={"force": True})
                        assert started.status_code == 202, started.text
                        job = manager.jobs[started.json()["job_id"]]
                        while ("restart",) not in order:
                            await asyncio.sleep(0.01)
                        # One job at a time, as for deploys.
                        with self.assertRaises(rs.HTTPException):
                            manager.start_deploy(None, redeploy_id=remote.id)
                        released.set()
                        await job.task
                        view = (await client.get(f"/api/admin/remote-servers/deploy/{job.job_id}")).json()
            finally:
                await close()
            assert order == [
                ("redeploy", remote.id), ("cli", remote.id, "claude"), ("cli", remote.id, "codex"),
                ("redeploy", dead.id), ("cli", dead.id, "claude"), ("cli", dead.id, "codex"),
                ("cli", attached.id, "claude"), ("cli", attached.id, "codex"),
                ("hub-cli", "claude"), ("hub-cli", "codex"), ("restart",),
            ]
            messages = [entry["message"] for entry in view["log"]]
            assert f"{remote.name}: Uploading the server…" in messages and f"{remote.name}: Claude Code claude-2.0" in messages
            assert "attached: attached from another hub, not redeployed." in messages and "hub: Codex codex-hub-9.9" in messages
            assert messages[-1] == "Restarting the hub…" and view["phase"] == "restart" and view["done"] and view["restarting"]
            # A remote's failures are reported; the hub still restarts.
            assert view["error"].startswith("dead: ssh exited 255; dead: Claude Code: ") and "attached: Codex: " in view["error"]

        asyncio.run(main())

    def test_update_all_reports_a_hub_that_cannot_restart_itself(self) -> None:
        hooks = hub_hooks(hub_restart=mock.AsyncMock(return_value="not run by launchd"))

        async def main() -> str | None:
            manager, _remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path, hooks=hooks)
            manager.servers.clear()
            try:
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{hub_port}") as client:
                    job = manager.jobs[(await client.post("/api/admin/remote-servers/update-all", json={"force": True})).json()["job_id"]]
                    await job.task
                    assert not job.restarting
                    return job.error
            finally:
                await close()

        assert asyncio.run(main()) == "hub: not run by launchd"

    def test_hub_claude_token_reaches_the_bootstrap_on_stdin_only(self) -> None:
        calls = self.fake_host(existing_port=7860)
        token = "sk-ant-oat01-" + "t" * 40
        self.enterContext(mock.patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": token}))
        manager, job = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server"))
        assert job.done and job.error is None, job.log
        probe, bootstrap = [json.loads(line) for line in calls.read_text().splitlines()]
        assert bootstrap["stdin_head"].startswith(f"AGENTSDOCK_CLAUDE_TOKEN={token}\n")
        assert not probe["stdin_head"].startswith("AGENTSDOCK_CLAUDE_TOKEN")
        assert all(token not in json.dumps(record["argv"]) for record in (probe, bootstrap))
        assert token not in json.dumps(job.log)

    def test_bootstrap_without_a_tarball_leaves_a_healthy_install_alone(self) -> None:
        # $HOME/.local/bin is the first PATH entry the script prepends, so fakes
        # placed there shadow the real uv/curl/claude/tmux and record every call.
        home = self.tmp_path / "home"
        bin_dir = home / ".local" / "bin"
        bin_dir.mkdir(parents=True)
        calls = self.tmp_path / "calls.log"
        # node present: the bootstrap then installs nothing.
        for name in ("uv", "curl", "claude", "tmux", "node"):
            (bin_dir / name).write_text(f"#!/bin/sh\necho {name} \"$@\" >> '{calls}'\n")
            (bin_dir / name).chmod(0o700)
        install = self.tmp_path / "install"
        (install / "server" / ".venv" / "bin").mkdir(parents=True)
        (install / "server" / ".venv" / "bin" / "python").symlink_to(sys.executable)
        (install / "server" / "agent_server.py").write_text("")
        (install / "server" / "VERSION").write_text("1.2.3\n")
        # A moved install's stale config dir, and no final newline (a hand edit).
        (install / "env").write_text(f"export AGENTSDOCK_AGENT_TOKEN={REMOTE_TOKEN}\nexport AGENTS_SERVER_CONFIG_DIR=/old\nexport AGENTSDOCK_AGENT_PORT=7860")
        install.chmod(0o775)  # a host umask of 002

        proc = subprocess.run(
            ["bash", "-s", "--", str(install), "7860", str(home)], input=rs.BOOTSTRAP_SCRIPT.read_bytes(),
            capture_output=True, env={**os.environ, "HOME": str(home)}, timeout=60,
        )

        output = proc.stdout.decode()
        assert proc.returncode == 0, output + proc.stderr.decode()
        result = rs.parse_setup_result(output.splitlines())
        assert (result["access_token"], result["remote_port"], result["server_version"]) == (REMOTE_TOKEN, 7860, "1.2.3")
        # The only external call is start.sh's health check, which found the server up.
        assert calls.read_text().splitlines() == [f"curl -fsS -m 3 -H Authorization: Bearer {REMOTE_TOKEN} http://127.0.0.1:7860/api/health"]
        # The only env change points the server's own settings writes (a token saved in the app) at this env,
        # whose directory the server writes only when group/others cannot.
        assert (install / "env").read_text() == (
            f"export AGENTSDOCK_AGENT_TOKEN={REMOTE_TOKEN}\nexport AGENTSDOCK_AGENT_PORT=7860\n"
            f"export AGENTS_SERVER_CONFIG_DIR={install}\n"
        )
        assert stat.S_IMODE(install.stat().st_mode) & 0o022 == 0

        # A token handed over by the hub lands in env once, without echoing it.
        token = "sk-ant-oat01-" + "t" * 40
        for _ in range(2):
            proc = subprocess.run(
                ["bash", "-s", "--", str(install), "7860", str(home)], input=f"AGENTSDOCK_CLAUDE_TOKEN={token}\n".encode() + rs.BOOTSTRAP_SCRIPT.read_bytes(),
                capture_output=True, env={**os.environ, "HOME": str(home)}, timeout=60,
            )
            assert proc.returncode == 0 and token not in proc.stdout.decode() + proc.stderr.decode(), proc.stderr.decode()
        assert (install / "env").read_text().count(f"export CLAUDE_CODE_OAUTH_TOKEN={token}\n") == 1
        assert (install / "env").read_text().count("export AGENTS_SERVER_CONFIG_DIR=") == 1
        assert stat.S_IMODE((install / "env").stat().st_mode) == 0o600

    # --- header rewriting -----------------------------------------------------

    def test_upstream_headers_keep_the_clients_credential_family(self) -> None:
        forwarded = rs.upstream_headers(raw(
            ("host", "hub:7850"), ("connection", "keep-alive"), ("x-forwarded-for", "1.2.3.4"), ("cookie", "a=b"),
            ("x-agentsdock-token", HUB_TOKEN), ("content-length", "12"), ("content-type", "application/json"), ("accept", "*/*"),
        ), REMOTE_TOKEN)
        assert forwarded == [("content-length", "12"), ("content-type", "application/json"), ("accept", "*/*"), ("x-agentsdock-token", REMOTE_TOKEN)]
        bearer = rs.upstream_headers(raw(("Authorization", f"Bearer {HUB_TOKEN}"), ("X-AgentsDock-Client", "electron")), REMOTE_TOKEN)
        assert bearer == [("X-AgentsDock-Client", "electron"), ("Authorization", f"Bearer {REMOTE_TOKEN}")]
        legacy = rs.upstream_headers(raw(("x-zenithdock-token", HUB_TOKEN), ("x-zenithdock-token", HUB_TOKEN)), REMOTE_TOKEN)
        assert legacy == [("x-zenithdock-token", REMOTE_TOKEN)]
        assert rs.upstream_headers(raw(("tailscale-user-login", "x"), ("via", "1.1 y")), REMOTE_TOKEN) == []

    def test_swap_token_query_and_ws_protocols(self) -> None:
        assert rs.swap_token_query("after=3&token=" + HUB_TOKEN, REMOTE_TOKEN) == "after=3&token=" + REMOTE_TOKEN
        assert rs.swap_token_query("after=3", REMOTE_TOKEN) == "after=3"
        assert rs.swap_token_query("", REMOTE_TOKEN) == ""
        encoded = base64.urlsafe_b64encode(REMOTE_TOKEN.encode()).decode().rstrip("=")
        assert rs.upstream_ws_protocols(["agentsdock-events-v1", "agentsdock-token.abc"], REMOTE_TOKEN) == (["agentsdock-events-v1", "agentsdock-token." + encoded], "agentsdock-token.abc")
        assert rs.upstream_ws_protocols(["agentsdock-token.abc", "agentsdock-token.def"], REMOTE_TOKEN) == (["agentsdock-token." + encoded], "agentsdock-token.abc")
        assert rs.upstream_ws_protocols(["agentsdock-events-v1"], REMOTE_TOKEN) == (["agentsdock-events-v1"], None)
        assert rs.valid_close_code(None) == 1000 and rs.valid_close_code(1006) == 1000 and rs.valid_close_code(4401) == 4401

    # --- proxy integration (fake upstream, no ssh) ----------------------------

    def test_http_proxy_swaps_credentials_and_streams_bodies(self) -> None:
        async def main() -> None:
            manager, remote, dead, hub_port, close = await hub_with_fake(self.tmp_path)
            base = f"http://127.0.0.1:{hub_port}/api/remote/{remote.id}"
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(f"{base}/echo/a/b?x=1&token={HUB_TOKEN}", headers={"X-AgentsDock-Token": HUB_TOKEN, "Cookie": "s=1", "X-Forwarded-For": "9.9.9.9"})
                    body = response.json()
                    assert response.status_code == 200
                    assert body["path"] == "a/b" and body["query"] == f"x=1&token={REMOTE_TOKEN}"
                    assert body["credentials"] == [["x-agentsdock-token", REMOTE_TOKEN]] and body["forwarded"] is None

                    # Multipart upload: bytes identical, Content-Length preserved, no chunking added.
                    payload = bytes(range(256)) * 700
                    response = await client.post(f"{base}/echo/upload", headers={"Authorization": f"Bearer {HUB_TOKEN}"}, files={"file": ("blob.bin", payload, "application/octet-stream")}, data={"note": "hi"})
                    body = response.json()
                    assert body["method"] == "POST" and body["size"] == int(body["content_length"]) and body["transfer_encoding"] is None
                    assert body["credentials"] == [["authorization", f"Bearer {REMOTE_TOKEN}"]]

                    # Exactly-one-header admin route and bearer-only route both see the family they need.
                    assert (await client.get(f"{base}/admin", headers={"X-ZenithDock-Token": HUB_TOKEN})).status_code == 200
                    assert (await client.get(f"{base}/bearer", headers={"Authorization": f"Bearer {HUB_TOKEN}"})).status_code == 200
                    assert (await client.get(f"{base}/bearer", headers={"X-AgentsDock-Token": HUB_TOKEN})).status_code == 401

                    # Streaming body and Range passthrough.
                    assert (await client.get(f"{base}/stream", headers={"X-AgentsDock-Token": HUB_TOKEN})).text == "chunk-0;chunk-1;chunk-2;"
                    response = await client.get(f"{base}/range", headers={"X-AgentsDock-Token": HUB_TOKEN, "Range": "bytes=10-19"})
                    assert response.status_code == 206 and response.content == b"0123456789" and response.headers["content-range"] == "bytes 10-19/100"
                    head = await client.head(f"{base}/range", headers={"X-AgentsDock-Token": HUB_TOKEN})
                    assert head.status_code == 200 and head.headers["content-length"] == "100" and head.content == b""

                    # Identity passthrough and error mapping.
                    assert (await client.get(f"{base}/api/health", headers={"X-AgentsDock-Token": HUB_TOKEN})).json() == {"server_identity": "fake-remote", "token_ok": True}
                    response = await client.get(f"http://127.0.0.1:{hub_port}/api/remote/nope00000000/api/health", headers={"X-AgentsDock-Token": HUB_TOKEN})
                    assert response.status_code == 404 and response.json()["detail"]["code"] == "remote_not_found"
                    response = await client.get(f"http://127.0.0.1:{hub_port}/api/remote/{dead.id}/api/health", headers={"X-AgentsDock-Token": HUB_TOKEN})
                    assert response.status_code == 502 and response.json()["detail"]["code"] == "remote_unreachable"

                    # Admin listing never leaks tokens.
                    listing = (await client.get(f"http://127.0.0.1:{hub_port}/api/admin/remote-servers")).json()
                    assert {entry["id"] for entry in listing["servers"]} == {remote.id, dead.id}
                    assert all("token" not in entry for entry in listing["servers"])
            finally:
                await close()

        asyncio.run(main())

    def test_chat_uploads_take_the_remotes_bulk_tunnel(self) -> None:
        async def main() -> None:
            manager, remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            bulk_server, bulk_task, bulk_port = await serve(fake_upstream(identity="bulk-tunnel"))
            base = f"http://127.0.0.1:{hub_port}/api/remote/{remote.id}/api/sessions/sess_1"
            headers = {"X-AgentsDock-Token": HUB_TOKEN}
            try:
                async with httpx.AsyncClient() as client:
                    payload = bytes(range(256)) * 40

                    async def post_upload() -> dict:
                        response = await client.post(f"{base}/files", headers=headers, files={"file": ("blob.bin", payload, "application/octet-stream")})
                        assert response.status_code == 200, response.text
                        return response.json()

                    # A hub that manages no tunnels keeps uploads on the main tunnel.
                    assert (await post_upload())["identity"] == "fake-remote"

                    # Never started: only its port matters here, and tunnel_status(bulk=True) must read this one.
                    manager.bulk_tunnels[remote.id] = rs.Tunnel(remote.model_copy(update={"local_port": bulk_port}), None, role="bulk")
                    posted = await post_upload()
                    assert posted["identity"] == "bulk-tunnel" and posted["size"] == int(posted["content_length"]) > len(payload)
                    # Listing files, and everything else, stay on the main tunnel.
                    for path in ("files?offset=0&limit=60", "pins"):
                        assert (await client.get(f"{base}/{path}", headers=headers)).json()["identity"] == "fake-remote", path
                    assert (await client.post(f"{base}/turns", headers=headers, json={})).json()["identity"] == "fake-remote"
                    assert manager.tunnel_status(remote.id, bulk=True) == {"state": "starting", "restarts": 0, "last_error": None}
            finally:
                await close()
                await stop(bulk_server, bulk_task)

        asyncio.run(main())

    def test_download_path_rule_matches_file_bodies_only(self) -> None:
        for path in ("api/sessions/s1/files/f1", "api/sessions/s1/links/file", "api/files/f1", "api/sessions/s1/diffs/run_1",
                     "api/sessions/s1/workspace/preview", "api/sessions/s1/workspace/download", "api/sessions/s1/export"):
            assert rs.DOWNLOAD_PATH_RE.fullmatch(path), path
        # JSON routes next to them: the file listing, a file's event, text read as JSON, and anything else.
        for path in ("api/sessions/s1/files", "api/sessions/s1/files/f1/event", "api/sessions/s1/workspace/file",
                     "api/sessions/s1/workspace/absolute-file", "api/sessions/s1/pins", "api/files", "api/health"):
            assert rs.DOWNLOAD_PATH_RE.fullmatch(path) is None, path

    def test_file_body_downloads_take_the_remotes_bulk_tunnel(self) -> None:
        async def main() -> None:
            manager, remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            bulk_server, bulk_task, bulk_port = await serve(fake_upstream(identity="bulk-tunnel"))
            base = f"http://127.0.0.1:{hub_port}/api/remote/{remote.id}/api/sessions/sess_1"
            headers = {"X-AgentsDock-Token": HUB_TOKEN}
            try:
                # Never started: only its port matters here.
                manager.bulk_tunnels[remote.id] = rs.Tunnel(remote.model_copy(update={"local_port": bulk_port}), None, role="bulk")
                async with httpx.AsyncClient() as client:
                    for path in ("files/file_1", "links/file?target=notes.md", "diffs/run_1",
                                 "workspace/preview?path=shot.png", "workspace/download?path=build.tgz", "export"):
                        assert (await client.get(f"{base}/{path}", headers=headers)).json()["identity"] == "bulk-tunnel", path
                    # The JSON routes beside them stay on the main tunnel, as does a POST to a download path.
                    for path in ("files?offset=0&limit=60", "files/file_1/event", "workspace/file?path=a.py"):
                        assert (await client.get(f"{base}/{path}", headers=headers)).json()["identity"] == "fake-remote", path
                    assert (await client.post(f"{base}/diffs/run_1", headers=headers, json={})).json()["identity"] == "fake-remote"
            finally:
                await close()
                await stop(bulk_server, bulk_task)

        asyncio.run(main())

    def test_chat_event_streams_take_the_remotes_stream_tunnel(self) -> None:
        async def main() -> None:
            manager, remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            stream_server, stream_task, stream_port = await serve(fake_upstream(identity="stream-tunnel"))
            base = f"ws://127.0.0.1:{hub_port}/api/remote/{remote.id}/api"
            headers = {"X-AgentsDock-Token": HUB_TOKEN}

            async def identity_of(path: str) -> str:
                async with websocket_connect(f"{base}/{path}", additional_headers=headers) as ws:
                    return json.loads(await ws.recv())["identity"]

            try:
                # A hub that manages no tunnels keeps the streams on the main tunnel.
                assert await identity_of("sessions/sess_1/events?after=0") == "fake-remote"
                # Never started: only its port matters here.
                manager.stream_tunnels[remote.id] = rs.Tunnel(remote.model_copy(update={"local_port": stream_port}), None, role="stream")
                for path in ("sessions/sess_1/events?after=0&visible=true", "session-summaries/events", "emergency-alerts/events"):
                    assert await identity_of(path) == "stream-tunnel", path
                # Port tunnels never take the stream tunnel.
                assert await identity_of("sessions/browser_1/ports/20003/tunnel/ws") == "fake-remote"
            finally:
                await close()
                await stop(stream_server, stream_task)

        asyncio.run(main())

    def test_browser_surface_port_tunnels_take_the_remotes_surface_tunnel(self) -> None:
        async def main() -> None:
            manager, remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            surface_server, surface_task, surface_port = await serve(fake_upstream(identity="surface-tunnel"))
            base = f"ws://127.0.0.1:{hub_port}/api/remote/{remote.id}/api"
            headers = {"X-AgentsDock-Token": HUB_TOKEN}

            async def identity_of(path: str) -> str:
                async with websocket_connect(f"{base}/{path}", additional_headers=headers) as ws:
                    return json.loads(await ws.recv())["identity"]

            try:
                # A hub that manages no tunnels keeps port tunnels on the main tunnel.
                assert await identity_of("sessions/browser_1/ports/20003/tunnel/ws") == "fake-remote"
                # Never started: only its port matters here.
                manager.surface_tunnels[remote.id] = rs.Tunnel(remote.model_copy(update={"local_port": surface_port}), None, role="surface")
                assert await identity_of("sessions/browser_1/ports/20003/tunnel/ws") == "surface-tunnel"
                # Terminals and event streams stay off it.
                assert await identity_of("sessions/sess_1/terminal/ws") == "fake-remote"
                assert await identity_of("sessions/sess_1/events?after=0") == "fake-remote"
            finally:
                await close()
                await stop(surface_server, surface_task)

        asyncio.run(main())

    def test_a_remote_gets_a_bulk_tunnel_on_its_own_unpersisted_port_and_no_inference_tunnel_unconfigured(self) -> None:
        script = self.tmp_path / "ssh"
        calls = self.tmp_path / "tunnel-calls.jsonl"
        script.write_text(f"""#!{sys.executable}
import json, sys, time
with open({str(calls)!r}, "a") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
time.sleep(30)
""")
        script.chmod(0o700)
        self.enterContext(mock.patch.object(rs, "ssh_binary", return_value=str(script)))
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop("AGENTSDOCK_INFERENCE_PROXY_PORT", None)
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        server = make_server(ssh_host="lab", local_port=free_port())
        rs.save_registry(manager.path, [server])

        async def main() -> None:
            await manager.start()
            try:
                for _ in range(200):
                    if calls.exists() and len(calls.read_text().splitlines()) == 4:
                        break
                    await asyncio.sleep(0.05)
                bulk = manager.bulk_tunnels[server.id]
                stream = manager.stream_tunnels[server.id]
                surface = manager.surface_tunnels[server.id]
                ports = (server.local_port, bulk.server.local_port, stream.server.local_port, surface.server.local_port)
                assert len(set(ports)) == 4
                assert manager.bulk_port(server) == bulk.server.local_port
                assert manager.stream_port(server) == stream.server.local_port
                assert manager.surface_port(server) == surface.server.local_port
                assert set(ports[1:]) <= manager._reserved_ports()
                # The registry keeps the one port clients may see; the other ports are this process's business.
                assert rs.load_registry(manager.path) == [server]
                argv = [json.loads(line) for line in calls.read_text().splitlines()]
                forwards = {args[-2]: args for args in argv}
                assert sorted(forwards) == sorted(f"127.0.0.1:{port}:127.0.0.1:7850" for port in ports)
                # JSON and web page tunnels compress, the file-body tunnel does not.
                assert "-C" in forwards[f"127.0.0.1:{server.local_port}:127.0.0.1:7850"]
                assert "-C" in forwards[f"127.0.0.1:{stream.server.local_port}:127.0.0.1:7850"]
                assert "-C" in forwards[f"127.0.0.1:{surface.server.local_port}:127.0.0.1:7850"]
                assert "-C" not in forwards[f"127.0.0.1:{bulk.server.local_port}:127.0.0.1:7850"]
                # Without AGENTSDOCK_INFERENCE_PROXY_PORT there is nothing to reverse forward.
                assert manager.inference_tunnels == {}
                await manager.remove(server.id)
                assert server.id not in manager.bulk_tunnels and bulk.status["state"] == "stopped"
                assert server.id not in manager.stream_tunnels and stream.status["state"] == "stopped"
                assert server.id not in manager.surface_tunnels and surface.status["state"] == "stopped"
            finally:
                await manager.stop()

        asyncio.run(main())

    def test_hub_proxy_logs_no_traceback_when_the_client_abandons_its_upload(self) -> None:
        # The desktop aborts an upload whose chat closed; the hub used to log a full
        # "Exception in ASGI application" traceback for the ClientDisconnect each time.
        async def main() -> None:
            manager, remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            try:
                with self.assertNoLogs("uvicorn.error", level="ERROR"):
                    _reader, writer = await asyncio.open_connection("127.0.0.1", hub_port)
                    writer.write((
                        f"POST /api/remote/{remote.id}/echo/upload HTTP/1.1\r\nHost: hub\r\nX-AgentsDock-Token: {HUB_TOKEN}\r\n"
                        "Content-Type: application/octet-stream\r\nContent-Length: 100000\r\n\r\n"
                    ).encode() + b"x" * 10)
                    await writer.drain()
                    await asyncio.sleep(0.2)  # the proxy has opened the upstream request and waits for more body
                    writer.close()
                    await writer.wait_closed()
                    await asyncio.sleep(0.5)  # the disconnect surfaces inside the proxy
            finally:
                await close()

        asyncio.run(main())

    def test_hub_proxy_closes_the_upstream_request_when_its_client_leaves(self) -> None:
        # A frozen remote: its ssh forward accepts the connection, the server never answers.
        # The hub kept one upstream socket per abandoned request (clients retry their polls),
        # until it ran out of file descriptors and stopped accepting anyone.
        async def main() -> None:
            manager, _remote, _dead, hub_port, close = await hub_with_fake(self.tmp_path)
            expected_tail = b""
            arrived, upstream_closed = asyncio.Event(), asyncio.Event()

            async def frozen_remote(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
                seen = b""
                while chunk := await reader.read(65536):
                    seen += chunk
                    if seen.endswith(b"\r\n\r\n" + expected_tail):
                        arrived.set()
                upstream_closed.set()
                writer.close()

            frozen_server = await asyncio.start_server(frozen_remote, "127.0.0.1", 0)
            frozen = make_server(id="f0f0f0f0f0f0", name="frozen", local_port=frozen_server.sockets[0].getsockname()[1])
            manager.servers[frozen.id] = frozen
            try:
                with self.assertNoLogs("uvicorn.error", level="ERROR"):
                    for head, expected_tail in ((f"GET /api/remote/{frozen.id}/api/health HTTP/1.1\r\n", b""),
                                                (f"POST /api/remote/{frozen.id}/api/sessions/sess_1/turns HTTP/1.1\r\nContent-Length: 8\r\n", b"body-end")):
                        arrived.clear()
                        upstream_closed.clear()
                        _reader, writer = await asyncio.open_connection("127.0.0.1", hub_port)
                        writer.write(f"{head}Host: hub\r\nX-AgentsDock-Token: {HUB_TOKEN}\r\n\r\n".encode() + expected_tail)
                        await writer.drain()
                        await asyncio.wait_for(arrived.wait(), 5)
                        writer.close()
                        await writer.wait_closed()
                        await asyncio.wait_for(upstream_closed.wait(), 2)
            finally:
                frozen_server.close()
                await close()

        asyncio.run(main())

    def test_hub_pool_forgets_idle_upstream_connections_before_uvicorn_does(self) -> None:
        # A remote AgentsServer runs uvicorn with its default idle keep-alive. The hub
        # must drop idle pooled connections well before that timer fires, otherwise a
        # request arriving just before it is written to a connection the remote has
        # already closed. The race needs a real ssh forward (the remote's close arrives
        # late there), so this pins the invariant rather than the race itself.
        manager = rs.RemoteServerManager(self.tmp_path, source_dir=self.tmp_path, manage_tunnels=False)
        try:
            assert manager.http._transport._pool._keepalive_expiry <= uvicorn.Config(FastAPI()).timeout_keep_alive / 2
        finally:
            asyncio.run(manager.http.aclose())

    def test_ws_proxy_rewrites_token_subprotocol_and_relays_close_codes(self) -> None:
        async def main() -> None:
            manager, remote, dead, hub_port, close = await hub_with_fake(self.tmp_path)
            hub_protocol = "agentsdock-token." + base64.urlsafe_b64encode(HUB_TOKEN.encode()).decode().rstrip("=")
            remote_protocol = rs.token_subprotocol(REMOTE_TOKEN)
            url = f"ws://127.0.0.1:{hub_port}/api/remote/{remote.id}/ws"
            try:
                # Token protocol first: the fake upstream selects it, the client gets its own protocol echoed back.
                async with websocket_connect(url, subprotocols=[hub_protocol, "agentsdock-events-v1"]) as ws:
                    assert ws.subprotocol == hub_protocol
                    hello = json.loads(await ws.recv())
                    assert hello["protocols"] == [remote_protocol, "agentsdock-events-v1"] and hello["header_token"] is None
                    await ws.send("ping")
                    assert await ws.recv() == "echo:ping"
                    await ws.send(b"\x00\x01\x02")
                    assert await ws.recv() == b"\x02\x01\x00"
                    await ws.send("close")
                    with self.assertRaises(websockets.exceptions.ConnectionClosed) as closed:
                        await ws.recv()
                    assert closed.exception.rcvd.code == 4001 and closed.exception.rcvd.reason == "bye"

                # Query-string token (mobile) is swapped and no header credential is invented.
                async with websocket_connect(f"{url}?after=5&token={HUB_TOKEN}", subprotocols=["agentsdock-events-v1"]) as ws:
                    assert ws.subprotocol == "agentsdock-events-v1"
                    hello = json.loads(await ws.recv())
                    assert hello["query"] == f"after=5&token={REMOTE_TOKEN}" and hello["header_token"] is None

                # Header token (electron) is swapped in place.
                async with websocket_connect(url, additional_headers={"X-AgentsDock-Token": HUB_TOKEN}) as ws:
                    hello = json.loads(await ws.recv())
                    assert hello["header_token"] == REMOTE_TOKEN

                # Unreachable remote closes with 1011 before any frame.
                with self.assertRaises(websockets.exceptions.InvalidStatus):
                    await websocket_connect(f"ws://127.0.0.1:{hub_port}/api/remote/{dead.id}/ws")
            finally:
                await close()

        asyncio.run(main())

    def test_ws_proxy_rejects_unauthenticated_clients(self) -> None:
        async def main() -> None:
            manager, remote, dead, hub_port, close = await hub_with_fake(self.tmp_path, ws_authorized=lambda ws: False)
            try:
                with self.assertRaises(websockets.exceptions.InvalidStatus) as rejected:
                    await websocket_connect(f"ws://127.0.0.1:{hub_port}/api/remote/{remote.id}/ws")
                assert rejected.exception.response.status_code == 403
            finally:
                await close()

        asyncio.run(main())

    def test_ws_proxy_tolerates_client_leaving_during_upstream_handshake(self) -> None:
        # Over a slow tunnel the upstream handshake takes a while; a client that gives
        # up meanwhile used to make ws.accept raise inside the route (a traceback per
        # occurrence) and leak the already-open upstream socket.
        async def main() -> None:
            manager, remote, dead, hub_port, close = await hub_with_fake(self.tmp_path)
            try:
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(websocket_connect(f"ws://127.0.0.1:{hub_port}/api/remote/{remote.id}/slow-ws"), 0.1)
                await asyncio.sleep(0.6)
            finally:
                await close()

        # uvicorn's loggers propagate to root (log_config=None in serve()), so
        # a root handler at ERROR sees the route's ASGI exception if one leaks.
        records: list[logging.LogRecord] = []
        handler = logging.Handler(level=logging.ERROR)
        handler.emit = records.append
        root = logging.getLogger()
        previous_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.ERROR)
        try:
            asyncio.run(main())
        finally:
            root.removeHandler(handler)
            root.setLevel(previous_level)
        assert not [record for record in records if "Exception in ASGI application" in record.getMessage()]


if __name__ == "__main__":
    unittest.main()
