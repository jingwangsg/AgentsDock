"""Remote-server hub: registry, tunnel argv, header rewriting, and the HTTP/WS reverse proxy."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import io
from pathlib import Path
from unittest import mock

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ValidationError
from websockets.asyncio.client import connect as websocket_connect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import remote_servers as rs  # noqa: E402

HUB_TOKEN = "hub-token-" + "h" * 30
REMOTE_TOKEN = "remote-token-" + "r" * 40

# Plays the host for deploy/attach jobs: answers the probe and the bootstrap from
# host.json and records every ssh argv (the part after ``bash -s --``; None for
# a plain remote command such as the upload's ``cat >``).
FAKE_SSH = r'''#!{python}
import json, os, sys
state = {state!r}
argv = sys.argv[1:]
sys.stdin.buffer.read()
tail = argv[argv.index("--") + 1:] if "--" in argv else None
with open(os.path.join(state, "calls.jsonl"), "a") as log:
    log.write(json.dumps(dict(tail=tail, command=None if tail is not None else argv[-1])) + "\n")
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


def fake_upstream() -> FastAPI:
    app = FastAPI()

    def token_headers(request: Request) -> list[tuple[str, str]]:
        return [(name.decode(), value.decode()) for name, value in request.scope["headers"] if name.lower() in (b"authorization", b"x-agentsdock-token", b"x-zenithdock-token", b"cookie")]

    @app.api_route("/echo/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def echo(request: Request, rest: str) -> dict:
        body = await request.body()
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
        return {"server_identity": "fake-remote", "token_ok": ("x-agentsdock-token", REMOTE_TOKEN) in token_headers(request)}

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


async def hub_with_fake(tmp_path: Path, ws_authorized=lambda ws: True):
    upstream_server, upstream_task, upstream_port = await serve(fake_upstream())
    manager = rs.RemoteServerManager(tmp_path, source_dir=tmp_path, manage_tunnels=False)
    remote = make_server(local_port=upstream_port)
    manager.servers[remote.id] = remote
    dead = make_server(id="deaddeaddead", name="dead", local_port=free_port())
    manager.servers[dead.id] = dead
    hub = FastAPI()
    rs.register_remote_server_routes(hub, manager=manager, authorize_admin=lambda request: None, websocket_authorized=ws_authorized)
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
            "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ControlMaster=no", "-o", "ControlPath=none",
            "-L", "127.0.0.1:7851:127.0.0.1:7850", "osmo_9000",
        ]
        assert rs.revive_args("osmo_9000", "~/.agentsdock-server")[-3:] == ["bash", "-lc", "exec bash ~/.agentsdock-server/start.sh"]
        assert rs.remote_shell_args("h")[-4:] == ["h", "bash", "-s", "--"]
        with self.assertRaises(ValueError):
            rs.tunnel_args("-oProxyCommand=x", 7851, 7850)

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

    def test_attach_registers_the_existing_install_without_uploading_or_restarting(self) -> None:
        calls = self.fake_host(existing_port=7860)
        manager, job = self.run_job(rs.RemoteAttachRequest(ssh_host="osmo_9000", install_dir="/mnt/lustre/.agentsdock-server"))
        assert job.done and job.error is None, job.log
        [server] = rs.load_registry(manager.path)
        assert (server.name, server.ssh_host, server.install_dir, server.remote_port, server.token) == ("osmo_9000", "osmo_9000", "/mnt/lustre/.agentsdock-server", 7860, REMOTE_TOKEN)
        assert job.server == server and job.phase == "complete"
        # Exactly two ssh sessions, the probe and the bootstrap: no upload command,
        # and the bootstrap gets no "restart" argument.
        sessions = [json.loads(line)["tail"] for line in calls.read_text().splitlines()]
        assert sessions == [["/mnt/lustre/.agentsdock-server"], ["/mnt/lustre/.agentsdock-server", "7860", "/h"]]
        assert "download" not in {entry["phase"] for entry in job.log}

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
                    assert (await client.post("/api/admin/remote-servers/attach", json={"ssh_host": "bad host"})).status_code == 422
            finally:
                await close()

        asyncio.run(main())

    def test_bootstrap_without_a_tarball_leaves_a_healthy_install_alone(self) -> None:
        # $HOME/.local/bin is the first PATH entry the script prepends, so fakes
        # placed there shadow the real uv/curl/claude/tmux and record every call.
        home = self.tmp_path / "home"
        bin_dir = home / ".local" / "bin"
        bin_dir.mkdir(parents=True)
        calls = self.tmp_path / "calls.log"
        for name in ("uv", "curl", "claude", "tmux"):
            (bin_dir / name).write_text(f"#!/bin/sh\necho {name} \"$@\" >> '{calls}'\n")
            (bin_dir / name).chmod(0o700)
        install = self.tmp_path / "install"
        (install / "server" / ".venv" / "bin").mkdir(parents=True)
        (install / "server" / ".venv" / "bin" / "python").symlink_to(sys.executable)
        (install / "server" / "agent_server.py").write_text("")
        (install / "server" / "VERSION").write_text("1.2.3\n")
        (install / "env").write_text(f"export AGENTSDOCK_AGENT_TOKEN={REMOTE_TOKEN}\nexport AGENTSDOCK_AGENT_PORT=7860\n")

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
        assert (install / "env").read_text() == f"export AGENTSDOCK_AGENT_TOKEN={REMOTE_TOKEN}\nexport AGENTSDOCK_AGENT_PORT=7860\n"

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
