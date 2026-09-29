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
# host.json and logs each call's full argv, its SSL_CERT_FILE, and ``tail``, the part
# after ``bash -s --`` (None for a plain remote command such as the upload's ``cat >``).
FAKE_SSH = r'''#!{python}
import json, os, sys
state = {state!r}
argv = sys.argv[1:]
stdin = sys.stdin.buffer.read()
tail = argv[argv.index("--") + 1:] if "--" in argv else None
with open(os.path.join(state, "calls.jsonl"), "a") as log:
    log.write(json.dumps(dict(tail=tail, command=None if tail is not None else argv[-1], argv=argv, ca=os.environ.get("SSL_CERT_FILE"),
                              stdin_head=stdin[:120].decode("utf-8", "replace"))) + "\n")
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
              mock.patch.object(rs, "isolated_proxy_args", mock.AsyncMock(return_value=["-o", "ProxyCommand=x"])) as isolated):
            route = asyncio.run(rs.ssh_route("oci@sky-cluster"))
            isolated.assert_awaited_once_with("sky-cluster")
            assert (route.options, route.destination) == (["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x"], "sky-cluster")
            assert route.env["SSL_CERT_FILE"] == route.env["REQUESTS_CA_BUNDLE"] == str(ca)
            isolated.return_value = []
            with self.assertRaisesRegex(OSError, "no ssh entry"):
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
        self.enterContext(mock.patch.object(rs, "SETTLE_SECONDS", 0.05))
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        rs.save_registry(manager.path, [
            make_server(id="aaaaaaaaaaaa", ssh_host="oci@sky-cluster", local_port=free_port()),
            make_server(id="bbbbbbbbbbbb", ssh_host="plain-host", local_port=free_port()),
        ])

        async def main() -> None:
            await manager.start()
            try:
                for _ in range(200):
                    if calls.exists() and len(calls.read_text().splitlines()) == 3:
                        return
                    await asyncio.sleep(0.05)
                self.fail("tunnels did not start")
            finally:
                await manager.stop()

        asyncio.run(main())
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        argvs = {argv[-1]: argv for argv in records if "-N" in argv}
        oci = argvs["sky-cluster"]
        # Before the tunnel's own options, so ExitOnForwardFailure=no wins over its =yes.
        assert oci[:9] == ["-o", "ConnectTimeout=30", "-o", "ProxyCommand=x", "-R", "12052:git.example:12051", "-o", "ExitOnForwardFailure=no", "-N"]
        assert "-R" not in argvs["plain-host"]
        # Once connected, git on the host is pointed at the forward, in the server's HOME.
        [rewrite] = [argv for argv in records if "-N" not in argv]
        assert rewrite[-2] == "sky-cluster" and "-R" not in rewrite
        assert rewrite[-1].startswith("set -a; . /mnt/lustre/.agentsdock-server/env; set +a; ")
        assert "url.ssh://git@127.0.0.1:12052/.insteadOf" in rewrite[-1] and "ssh://git@git.example:12051/" in rewrite[-1]

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
        manager = rs.RemoteServerManager(self.tmp_path / "state", source_dir=self.tmp_path)
        running_port = free_port()
        rs.save_registry(manager.path, [
            make_server(id="aaaaaaaaaaaa", ssh_host="osmo@wf-running", local_port=running_port),
            make_server(id="bbbbbbbbbbbb", ssh_host="osmo@wf-done", local_port=free_port()),
        ])

        async def main() -> dict:
            await manager.start()
            try:
                for _ in range(200):
                    running = manager.tunnel_status("aaaaaaaaaaaa")
                    ended = manager.tunnel_status("bbbbbbbbbbbb")
                    if running["state"] == "connected" and ended["state"] == "reconnecting" and calls.exists():
                        return ended
                    await asyncio.sleep(0.05)
                self.fail(f"tunnels did not settle: {running} {ended}")
            finally:
                await manager.stop()

        ended = asyncio.run(main())
        assert "OSMO workflow wf-done is COMPLETED" in ended["last_error"]
        route = asyncio.run(rs.ssh_route("osmo@wf-running"))
        [argv] = [json.loads(line) for line in calls.read_text().splitlines()]
        assert argv[:len(route.options)] == route.options
        assert argv[-3:] == ["-L", f"127.0.0.1:{running_port}:127.0.0.1:7850", "root@wf-running"]

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

        # A token handed over by the hub lands in env once, without echoing it.
        token = "sk-ant-oat01-" + "t" * 40
        for _ in range(2):
            proc = subprocess.run(
                ["bash", "-s", "--", str(install), "7860", str(home)], input=f"AGENTSDOCK_CLAUDE_TOKEN={token}\n".encode() + rs.BOOTSTRAP_SCRIPT.read_bytes(),
                capture_output=True, env={**os.environ, "HOME": str(home)}, timeout=60,
            )
            assert proc.returncode == 0 and token not in proc.stdout.decode() + proc.stderr.decode(), proc.stderr.decode()
        assert (install / "env").read_text().count(f"export CLAUDE_CODE_OAUTH_TOKEN={token}\n") == 1
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
