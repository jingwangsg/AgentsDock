"""Hub for remote AgentsServers that are reachable only over SSH.

The hub keeps a registry of remote servers, holds an ``ssh -L`` tunnel open to
each one, deploys or updates the server source on demand, and reverse-proxies
``/api/remote/{id}/...`` (HTTP and WebSocket) to the tunnel so clients only ever
hold the hub's URL and token; phones, which have neither ssh nor the server
source, get the same capability. Hosts are ssh destinations or the cluster
notations ``oci@<sky-cluster>`` and ``osmo@<workflow>`` (see ``ssh_route``).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import socket
import tarfile
import time
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import parse_qsl, urlencode

import httpx
import websockets
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, field_validator
from starlette.background import BackgroundTask
from websockets.asyncio.client import connect as websocket_connect

logger = logging.getLogger("agents-server")

SERVER_DIR = Path(__file__).resolve().parent
PROBE_SCRIPT = SERVER_DIR / "remote_probe.sh"
BOOTSTRAP_SCRIPT = SERVER_DIR / "remote_bootstrap.sh"
PROBE_PREFIX = "AGENTSDOCK_TUNNEL_PROBE="
RESULT_PREFIX = "AGENTSDOCK_SETUP_RESULT="
SETUP_LOG_PREFIX = "[AgentsDock setup] "
TOKEN_SUBPROTOCOL_PREFIX = "agentsdock-token."
PROXY_PREFIX = "/api/remote"
ADMIN_PATH = "/api/admin/remote-servers"

# Same syntax as electron/src/main/settings.ts. Only the hub resolves oci@/osmo@ (ssh_route);
# elsewhere ssh_host is a literal ssh destination.
SSH_HOST_RE = re.compile(r"^[A-Za-z0-9_.@%+:\[\]-]+$")
REMOTE_DIR_RE = re.compile(r"^[A-Za-z0-9_.~/-]+$")
REMOTE_ID_RE = re.compile(r"^[a-z0-9]{12}$")
LOCAL_PORT_RANGE = range(7851, 8000)
MIN_BACKOFF = 2.0
# A refused connect costs nothing, and the user's own ssh forward (the usual
# cause) tends to return within seconds; a 30 s cap kept the remote offline
# for half a minute after ssh was already back.
MAX_BACKOFF = 10.0
REVIVE_INTERVAL = 120.0
SETTLE_SECONDS = 3.0
SSH_FORWARD_PROBE_INTERVAL = 10.0
SSH_FORWARD_PROBE_TIMEOUT = 30.0
SSH_FORWARD_PROBE_FAILURES = 3
UPLOAD_CHUNK = 256 * 1024
# Forwarded ssh hops drop mid-transfer; each retry appends from the byte count
# the host reports, so a hop that flaps every couple of minutes still finishes
# a multi-minute upload instead of restarting it.
UPLOAD_RETRIES = 8
UPLOAD_RETRY_DELAY = 5.0

DEFAULT_INSTALL_DIR = "~/.agentsdock-server"
SKY_CA_BUNDLE = Path.home() / ".sky" / "certs" / "requests-ca-bundle.pem"
# A cluster container's own ~ does not outlive it. When the hub's environment names
# the persistent cluster home that holds the Claude and Codex logins, a default
# install goes there, one per cluster or workflow (see _deploy); mount points are
# site-specific, so they stay out of the source.
CLUSTER_HOME_ENV = {"oci@": "AGENTSDOCK_OCI_HOME", "osmo@": "AGENTSDOCK_OSMO_HOME"}
# No leading "-": workflow and task names are passed to the osmo CLI as arguments.
OSMO_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")

NO_MULTIPLEX = ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
SSH_BATCH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", *NO_MULTIPLEX]


def validate_ssh_host(value: str) -> str:
    host = value.strip()
    if not host or host.startswith("-") or not SSH_HOST_RE.match(host):
        raise ValueError("Invalid SSH host.")
    return host


def validate_remote_dir(value: str) -> str:
    directory = value.strip()
    if not directory or directory.startswith("-") or not REMOTE_DIR_RE.match(directory):
        raise ValueError("Invalid remote install directory.")
    return directory


def validate_port(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1024 <= value <= 65535:
        raise ValueError("Ports must be between 1024 and 65535.")
    return value


def validate_remote_port(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError("Remote port must be between 1 and 65535.")
    return value


def validate_token(value: str) -> str:
    if not 32 <= len(value) <= 256 or any(character.isspace() for character in value):
        raise ValueError("Invalid access token.")
    return value


class RemoteServer(BaseModel):
    id: str
    name: str
    ssh_host: str
    install_dir: str
    remote_port: int
    local_port: int
    token: str
    created_at: str

    @field_validator("id")
    @classmethod
    def _id(cls, value: str) -> str:
        if not REMOTE_ID_RE.match(value):
            raise ValueError("Invalid remote server id.")
        return value

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Name is required.")
        return value.strip()[:120]

    _host = field_validator("ssh_host")(classmethod(lambda cls, value: validate_ssh_host(value)))
    _dir = field_validator("install_dir")(classmethod(lambda cls, value: validate_remote_dir(value)))
    _ports = field_validator("remote_port", "local_port")(classmethod(lambda cls, value: validate_port(value)))
    _token = field_validator("token")(classmethod(lambda cls, value: validate_token(value)))


class RemoteServerCreate(BaseModel):
    """Register a server that already runs on the host (no deployment)."""

    ssh_host: str
    install_dir: str
    remote_port: int
    token: str
    name: str | None = None

    _host = field_validator("ssh_host")(classmethod(lambda cls, value: validate_ssh_host(value)))
    _dir = field_validator("install_dir")(classmethod(lambda cls, value: validate_remote_dir(value)))
    _port = field_validator("remote_port")(classmethod(lambda cls, value: validate_port(value)))
    _token = field_validator("token")(classmethod(lambda cls, value: validate_token(value)))


class SSHForward(BaseModel):
    id: str
    name: str
    ssh_host: str
    local_port: int
    remote_port: int
    bind_mode: Literal["ipv4", "dual"] = "ipv4"
    channel_timeout: Literal["direct-tcpip=2m"] | None = None
    ca_bundle_path: str | None = None
    created_at: str

    _host = field_validator("ssh_host")(classmethod(lambda cls, value: validate_ssh_host(value)))
    _local_port = field_validator("local_port")(classmethod(lambda cls, value: validate_port(value)))

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Name is required.")
        return value.strip()[:120]

    @field_validator("remote_port")
    @classmethod
    def _remote_port(cls, value: int) -> int:
        return validate_remote_port(value)

    @field_validator("ca_bundle_path")
    @classmethod
    def _ca_bundle_path(cls, value: str | None) -> str | None:
        if value is not None and not Path(value).is_absolute():
            raise ValueError("CA bundle path must be absolute.")
        return value

    @field_validator("id")
    @classmethod
    def _id(cls, value: str) -> str:
        if not REMOTE_ID_RE.fullmatch(value):
            raise ValueError("Invalid forward id.")
        return value


class RemoteDeployRequest(BaseModel):
    ssh_host: str
    install_dir: str = DEFAULT_INSTALL_DIR
    name: str | None = None
    port: int = 0  # 0 = let the host pick (or keep an existing install's port)

    _host = field_validator("ssh_host")(classmethod(lambda cls, value: validate_ssh_host(value)))
    _dir = field_validator("install_dir")(classmethod(lambda cls, value: validate_remote_dir(value)))

    @field_validator("port")
    @classmethod
    def _port(cls, value: int) -> int:
        return value if value == 0 else validate_port(value)


class RemoteAttachRequest(BaseModel):
    """Register an install another hub deployed: nothing is uploaded and the server keeps its port and token."""

    ssh_host: str
    install_dir: str = DEFAULT_INSTALL_DIR
    name: str | None = None

    _host = field_validator("ssh_host")(classmethod(lambda cls, value: validate_ssh_host(value)))
    _dir = field_validator("install_dir")(classmethod(lambda cls, value: validate_remote_dir(value)))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_registry(path: Path) -> list[RemoteServer]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text("utf-8"))
    return [RemoteServer.model_validate(item) for item in raw.get("servers", [])]


def load_forward_registry(path: Path) -> list[SSHForward]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text("utf-8"))
    if raw.get("version") != 1 or "forwards" not in raw:
        raise ValueError("Invalid SSH forward registry.")
    return [SSHForward.model_validate(item) for item in raw["forwards"]]


def save_registry(path: Path, servers: list[RemoteServer]) -> None:
    """Atomic private write: the registry holds every remote's access token."""

    _save_private_registry(path, "servers", [server.model_dump() for server in servers])


def save_forward_registry(path: Path, forwards: list[SSHForward]) -> None:
    _save_private_registry(path, "forwards", [forward.model_dump() for forward in forwards])


def _save_private_registry(path: Path, key: str, entries: list[dict[str, Any]]) -> None:

    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, key: entries}, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp)
        raise


def public_view(server: RemoteServer, tunnel: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": server.id,
        "name": server.name,
        "ssh_host": server.ssh_host,
        "install_dir": server.install_dir,
        "remote_port": server.remote_port,
        "local_port": server.local_port,
        "created_at": server.created_at,
        "proxy_path": f"{PROXY_PREFIX}/{server.id}",
        "tunnel": tunnel,
    }


# --- ssh ------------------------------------------------------------------


def ssh_binary() -> str:
    return shutil.which("ssh") or "/usr/bin/ssh"


def remote_shell_args(ssh_host: str) -> list[str]:
    """argv that feeds a script on stdin to ``bash -s -- <args>`` on the host."""

    return [*SSH_BATCH_OPTIONS, validate_ssh_host(ssh_host), "bash", "-s", "--"]


def tunnel_args(
    ssh_host: str,
    local_port: int,
    remote_port: int,
    *,
    bind_mode: Literal["ipv4", "dual"] = "ipv4",
    channel_timeout: Literal["direct-tcpip=2m"] | None = None,
    connect_timeout: int = 10,
    verbose: bool = False,
) -> list[str]:
    local_binding = f"127.0.0.1:{validate_port(local_port)}" if bind_mode == "ipv4" else str(validate_port(local_port))
    args = [
        "-N",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", f"ConnectTimeout={connect_timeout}",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=accept-new",
        *NO_MULTIPLEX,
    ]
    if verbose:
        args.append("-v")
    if channel_timeout is not None:
        args.extend(["-o", f"ChannelTimeout={channel_timeout}"])
    return [*args, "-L", f"{local_binding}:127.0.0.1:{validate_remote_port(remote_port)}", validate_ssh_host(ssh_host)]


async def isolated_proxy_args(ssh_host: str) -> list[str]:
    # Sky-generated aliases have an inner ssh hop; the outer -o options do not isolate it.
    config = await asyncio.create_subprocess_exec(
        ssh_binary(), "-G", ssh_host, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, _ = await asyncio.wait_for(config.communicate(), timeout=15)
    except asyncio.TimeoutError:
        config.kill()
        await config.wait()
        raise
    if config.returncode:
        raise OSError(f"ssh -G failed for {ssh_host}")
    prefix = "proxycommand ssh "
    for line in output.decode("utf-8", "replace").splitlines():
        if line.startswith(prefix):
            return ["-o", "ProxyCommand=ssh -S none -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=30 " + line[len(prefix):]]
    return []


@dataclass
class SSHRoute:
    """ssh options, destination and environment that reach a registered host."""

    options: list[str]
    destination: str
    env: dict[str, str]


async def osmo_lead_task(workflow: str) -> tuple[str, str]:
    """The osmo CLI path and the lead task of a running workflow."""

    if not OSMO_NAME_RE.fullmatch(workflow):
        raise OSError(f"Invalid OSMO workflow id: {workflow}")
    # launchd starts the hub with a minimal PATH; the osmo CLI installs into one of these.
    search = os.pathsep.join([os.environ.get("PATH", ""), "/usr/local/bin", "/opt/homebrew/bin", str(Path.home() / ".local" / "bin")])
    osmo = shutil.which("osmo", path=search)
    if osmo is None:
        raise OSError("The osmo CLI is not installed on this server.")
    # load-bearing: Tunnel._supervise retries only OSError; any other exception ends the tunnel task.
    query = await asyncio.create_subprocess_exec(
        osmo, "workflow", "query", workflow, "-t", "json",
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, error = await asyncio.wait_for(query.communicate(), timeout=60)
    except asyncio.TimeoutError:
        raise OSError(f"osmo workflow query {workflow} timed out.") from None
    finally:
        if query.returncode is None:  # timed out, or the tunnel or deploy was cancelled
            query.kill()
            await query.wait()
    if query.returncode:
        raise OSError(last_line(error.decode("utf-8", "replace")) or f"osmo workflow query {workflow} failed.")
    try:
        data = json.loads(output)
        status = data["status"]
        leads = [task["name"] for group in data["groups"] for task in group["tasks"] if task.get("lead")]
    except (ValueError, LookupError, TypeError, AttributeError):
        raise OSError(f"osmo workflow query {workflow} returned an unexpected result.") from None
    if status != "RUNNING":
        raise OSError(f"OSMO workflow {workflow} is {status}.")
    lead = next((name for name in leads if isinstance(name, str) and OSMO_NAME_RE.fullmatch(name)), None)
    if lead is None:
        raise OSError(f"OSMO workflow {workflow} has no lead task.")
    return osmo, lead


async def ssh_route(ssh_host: str) -> SSHRoute:
    """Resolve the cluster notations; any other host is a plain ssh destination.

    ``oci@<cluster>``: a Sky-generated alias. Its inner hop needs isolation, and Sky's
    websocket proxy needs Sky's CA bundle, which a launchd-started hub does not inherit.
    ``osmo@<workflow>``: sshd in the workflow's lead task, reached as root with
    ``osmo workflow exec --raw`` as the ProxyCommand.
    """

    env = ssh_env()
    # A Sky connection took 13-14 s end to end when measured; the 10-15 s ConnectTimeout
    # used elsewhere is too short for either proxy. Route options come first, so this wins.
    slow_proxy = ["-o", "ConnectTimeout=30"]
    if ssh_host.startswith("oci@"):
        cluster = ssh_host.removeprefix("oci@")
        options = await isolated_proxy_args(cluster)
        if not options:
            raise OSError(f"Sky has no ssh entry for {cluster}; refresh it with `sky status -r` in its workspace.")
        if SKY_CA_BUNDLE.exists():
            env["SSL_CERT_FILE"] = env["REQUESTS_CA_BUNDLE"] = str(SKY_CA_BUNDLE)
        return SSHRoute([*slow_proxy, *options], cluster, env)
    if ssh_host.startswith("osmo@"):
        workflow = ssh_host.removeprefix("osmo@")
        osmo, task = await osmo_lead_task(workflow)
        return SSHRoute([
            *slow_proxy,
            # The shell runs ProxyCommand after ssh expands % tokens; workflow and task match OSMO_NAME_RE.
            "-o", f"ProxyCommand={shlex.quote(osmo).replace('%', '%%')} workflow exec {workflow} {task} --raw --raw-port 22",
            # Every task pod has its own host key; OSMO already authenticated the exec channel.
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        ], f"root@{workflow}", env)
    return SSHRoute([], ssh_host, env)


def revive_args(ssh_host: str, install_dir: str) -> list[str]:
    # install_dir is validated to [A-Za-z0-9_.~/-], so it is safe unquoted and a
    # leading ~ still expands on the host.
    return [*SSH_BATCH_OPTIONS, validate_ssh_host(ssh_host), "bash", "-lc", f"exec bash {validate_remote_dir(install_dir)}/start.sh"]


def needs_revive(stderr_line: str) -> bool:
    # ssh reports a per-connection forward failure without exiting when the
    # remote AgentsServer is not listening.
    return "open failed: connect failed" in stderr_line.lower()


def next_backoff(current: float) -> float:
    return min(MAX_BACKOFF, current * 2)


def local_port_free(port: int) -> bool:
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def find_free_local_port(reserved: set[int]) -> int:
    for port in LOCAL_PORT_RANGE:
        if port not in reserved and local_port_free(port):
            return port
    raise RuntimeError(f"No free local port between {LOCAL_PORT_RANGE.start} and {LOCAL_PORT_RANGE.stop - 1}.")


def ssh_env() -> dict[str, str]:
    return {**os.environ, "LC_ALL": "C", "LANG": "C"}


async def start_remote_server(server: RemoteServer) -> None:
    """Run ``<install_dir>/start.sh`` on the host; used when the forward finds no listener."""

    route = await ssh_route(server.ssh_host)
    proc = await asyncio.create_subprocess_exec(
        ssh_binary(), *route.options, *revive_args(route.destination, server.install_dir),
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=route.env,
    )
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), 120)
    except asyncio.TimeoutError:
        with suppress(ProcessLookupError):
            proc.kill()
        raise RuntimeError("start.sh did not finish within 120s.")
    if proc.returncode != 0:
        raise RuntimeError(last_line(output.decode("utf-8", "replace")) or f"start.sh exited {proc.returncode}")


class SSHConnectionLost(RuntimeError):
    """ssh exited 255: the connection itself failed rather than the remote command."""


def last_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""


class Tunnel:
    """Keeps one ``ssh -N -L`` forward alive with backoff and optional remote revival."""

    def __init__(self, server: RemoteServer | SSHForward, revive: Callable[[RemoteServer], Awaitable[None]] | None):
        self.server = server
        # The route of the running ssh; the forward probe logs in with its destination and options.
        self._route: SSHRoute | None = None
        self.status: dict[str, Any] = {"state": "starting", "restarts": 0, "last_error": None}
        self._revive = revive
        self._task: asyncio.Task[None] | None = None
        self._revive_task: asyncio.Task[None] | None = None
        self._monitor_task: asyncio.Task[None] | None = None
        self._git_task: asyncio.Task[None] | None = None
        self._site_args: list[str] = []
        self._master_proc: asyncio.subprocess.Process | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._stopped = False
        self._backoff = MIN_BACKOFF
        self._last_revive = 0.0

    def start(self) -> None:
        self._task = asyncio.create_task(self._supervise(), name=f"ssh-tunnel:{self.server.id}")

    async def _supervise(self) -> None:
        while not self._stopped:
            try:
                route = await ssh_route(self.server.ssh_host)
                env = route.env
                if isinstance(self.server, SSHForward):
                    args = tunnel_args(
                        route.destination, self.server.local_port, self.server.remote_port,
                        bind_mode=self.server.bind_mode, channel_timeout=self.server.channel_timeout,
                        connect_timeout=30, verbose=True,
                    )
                    # Forwards registered by a bare Sky alias still get their inner hop isolated.
                    options = route.options or await isolated_proxy_args(route.destination)
                    if self.server.ca_bundle_path is not None:
                        env["SSL_CERT_FILE"] = self.server.ca_bundle_path
                        env["REQUESTS_CA_BUNDLE"] = self.server.ca_bundle_path
                else:
                    args = tunnel_args(route.destination, self.server.local_port, self.server.remote_port)
                    # Site forwards the cluster's chats need, e.g. a git server that only this
                    # Mac can reach, ride on this long-lived tunnel; never on the short deploy
                    # connections, which would contend for the same remote port.
                    self._site_args = (shlex.split(os.environ.get("AGENTSDOCK_OCI_TUNNEL_SSH_ARGS", ""))
                                       if self.server.ssh_host.startswith("oci@") else [])
                    options = [*route.options, *self._site_args]
                self._route = route
                proc = await asyncio.create_subprocess_exec(
                    ssh_binary(), *options, *args,
                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE, env=env,
                )
            except (OSError, asyncio.TimeoutError) as exc:
                self._mark_reconnecting(f"could not start ssh: {exc}")
                await asyncio.sleep(self._backoff)
                self._backoff = next_backoff(self._backoff)
                continue
            self._proc = proc
            # The forward is established quickly; a process that survives the
            # connect window counts as connected and resets the backoff.
            settle = (None if isinstance(self.server, SSHForward)
                      else asyncio.get_running_loop().call_later(SETTLE_SECONDS, self._mark_connected, proc))
            tail = ""
            assert proc.stderr is not None
            async for raw in proc.stderr:
                line = raw.decode("utf-8", "replace")
                tail = (tail + line)[-4000:]
                if isinstance(self.server, SSHForward) and (
                    f"Local forwarding listening on 127.0.0.1 port {self.server.local_port}." in line
                ):
                    self._mark_connected(proc)
                if needs_revive(line):
                    self._schedule_revive()
            code = await proc.wait()
            if settle is not None:
                settle.cancel()
            if self._monitor_task is not None:
                self._monitor_task.cancel()
                await asyncio.gather(self._monitor_task, return_exceptions=True)
                self._monitor_task = None
            self._proc = None
            if self._stopped:
                return
            self._mark_reconnecting(last_line(tail) or f"ssh exited ({code})")
            logger.warning("ssh tunnel %s exited; restarting in %.0fs: %s", self.server.id, self._backoff, self.status["last_error"])
            await asyncio.sleep(self._backoff)
            self._backoff = next_backoff(self._backoff)

    def _mark_connected(self, proc: asyncio.subprocess.Process) -> None:
        if self._proc is proc and proc.returncode is None:
            self.status = {**self.status, "state": "connected", "last_error": None}
            self._backoff = MIN_BACKOFF
            if self._site_args and (self._git_task is None or self._git_task.done()):
                self._git_task = asyncio.create_task(self._point_git_at_forwards(self._route), name=f"ssh-tunnel-git:{self.server.id}")
            if isinstance(self.server, SSHForward) and self.server.remote_port == 22 and self._monitor_task is None:
                self._monitor_task = asyncio.create_task(self._monitor_forward(proc), name=f"ssh-forward-health:{self.server.id}")

    async def _monitor_forward(self, outer: asyncio.subprocess.Process) -> None:
        assert isinstance(self.server, SSHForward) and self._route is not None
        host, port = self._route.destination, str(self.server.local_port)
        control_args = [
            "-o", "BatchMode=yes", "-o", "ProxyCommand=none", "-o", "HostName=127.0.0.1",
            "-o", "ConnectTimeout=30", "-o", "ConnectionAttempts=1", "-o", "LogLevel=ERROR",
            "-p", port,
            # After ProxyCommand=none, which therefore still wins; carries osmo@'s host-key options.
            *self._route.options,
        ]
        healthy_once = False
        failures = 0
        probe: asyncio.subprocess.Process | None = None
        try:
            while not self._stopped and self._proc is outer and outer.returncode is None:
                await asyncio.sleep(SSH_FORWARD_PROBE_INTERVAL)
                probe = await asyncio.create_subprocess_exec(
                    ssh_binary(), "-S", "none", *NO_MULTIPLEX, *control_args,
                    host, "exit", "0", stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    code = await asyncio.wait_for(probe.wait(), SSH_FORWARD_PROBE_TIMEOUT)
                except asyncio.TimeoutError:
                    probe.kill()
                    await probe.wait()
                    code = 124
                probe = None
                if code == 0:
                    healthy_once = True
                    failures = 0
                    if self._master_proc is None or self._master_proc.returncode is not None:
                        check = await asyncio.create_subprocess_exec(
                            ssh_binary(), *control_args, "-O", "check", host,
                            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.DEVNULL,
                        )
                        if await check.wait() != 0:
                            self._master_proc = await asyncio.create_subprocess_exec(
                                ssh_binary(), *control_args, "-N", "-o", "ControlMaster=auto",
                                "-o", "ControlPersist=no", "-o", "ServerAliveInterval=15",
                                "-o", "ServerAliveCountMax=3", host,
                                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                elif healthy_once:
                    failures += 1
                    if failures >= SSH_FORWARD_PROBE_FAILURES:
                        logger.info("SSH forward %s probe failed %d times; reconnecting", self.server.id, failures)
                        outer.terminate()
                        return
        finally:
            if probe is not None and probe.returncode is None:
                probe.kill()
                await probe.wait()
            master, self._master_proc = self._master_proc, None
            if master is not None and master.returncode is None:
                master.terminate()
                try:
                    await asyncio.wait_for(master.wait(), timeout=5)
                except asyncio.TimeoutError:
                    master.kill()
                    await master.wait()

    async def _point_git_at_forwards(self, route: SSHRoute) -> None:
        """Send git on the host through each `-R port:host:hostport` this tunnel carries.

        A forge whose ssh port only this Mac reaches is then reachable from the host's
        chats with repository URLs unchanged. The rewrite goes into the global git config
        of the server's HOME on every connect, so a new cluster, a new home or a reset
        gitconfig needs no setup.
        """
        assert isinstance(self.server, RemoteServer)
        commands = []
        for flag, spec in zip(self._site_args, self._site_args[1:]):
            forward = re.fullmatch(r"(\d+):([A-Za-z0-9.-]+):(\d+)", spec) if flag == "-R" else None
            if forward:
                port, host, host_port = forward.groups()
                key = shlex.quote(f"url.ssh://git@127.0.0.1:{port}/.insteadOf")
                value = shlex.quote(f"ssh://git@{host}:{host_port}/")
                commands.append(f"{{ git config --global --get-all {key} | grep -qxF {value} || git config --global --add {key} {value}; }}")
        if not commands:
            return
        # The install's env file sets the HOME whose git config the server's chats read.
        script = f"set -a; . {validate_remote_dir(self.server.install_dir)}/env; set +a; " + " && ".join(commands)
        proc = await asyncio.create_subprocess_exec(
            ssh_binary(), *route.options, *SSH_BATCH_OPTIONS, route.destination, script,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, env=route.env,
        )
        try:
            _, error = await asyncio.wait_for(proc.communicate(), 120)
        except asyncio.TimeoutError:
            error = b"timed out"
        finally:
            if proc.returncode is None:
                with suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
        if proc.returncode:
            logger.warning("git forward rewrite failed for %s: %s", self.server.id, last_line(error.decode("utf-8", "replace")))

    def _mark_reconnecting(self, reason: str) -> None:
        self.status = {"state": "reconnecting", "restarts": self.status["restarts"] + 1, "last_error": reason}

    def _schedule_revive(self) -> None:
        if self._revive is None:
            return
        now = time.monotonic()
        if now - self._last_revive < REVIVE_INTERVAL or (self._revive_task and not self._revive_task.done()):
            return
        self._last_revive = now
        self._revive_task = asyncio.create_task(self._run_revive(), name=f"ssh-tunnel-revive:{self.server.id}")

    async def _run_revive(self) -> None:
        try:
            assert self._revive is not None
            assert isinstance(self.server, RemoteServer)
            await self._revive(self.server)
            logger.info("remote server start requested for %s", self.server.id)
        except Exception as exc:  # noqa: BLE001 - reported, never fatal for the tunnel
            logger.warning("remote server revival failed for %s: %s", self.server.id, exc)

    async def stop(self) -> None:
        self._stopped = True
        proc = self._proc
        if proc is not None and proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.terminate()
        tasks = [task for task in (self._task, self._revive_task, self._monitor_task, self._git_task) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if proc is not None and proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        self.status = {**self.status, "state": "stopped"}


# --- deployment -------------------------------------------------------------


@dataclass
class DeployJob:
    job_id: str
    phase: str = "connect"
    done: bool = False
    error: str | None = None
    log: list[dict[str, str]] = field(default_factory=list)
    server: RemoteServer | None = None
    task: asyncio.Task[None] | None = None
    proc: asyncio.subprocess.Process | None = None

    def progress(self, phase: str, message: str) -> None:
        self.phase = phase
        self.log.append({"phase": phase, "message": message, "at": now_iso()})
        del self.log[:-500]

    def view(self, tunnel: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "phase": self.phase,
            "done": self.done,
            "error": self.error,
            "log": list(self.log),
            "server": public_view(self.server, tunnel) if self.server else None,
        }


def parse_probe(lines: list[str]) -> dict[str, Any]:
    for line in lines:
        if line.startswith(PROBE_PREFIX):
            data = json.loads(line[len(PROBE_PREFIX):])
            if not isinstance(data.get("home"), str) or not isinstance(data.get("free_port"), int):
                raise RuntimeError("The host probe returned an unexpected result.")
            return data
    raise RuntimeError("The host probe did not report its environment.")


def parse_setup_result(lines: list[str]) -> dict[str, Any]:
    for line in lines:
        if line.startswith(RESULT_PREFIX):
            data = json.loads(line[len(RESULT_PREFIX):])
            if not isinstance(data.get("access_token"), str) or not isinstance(data.get("remote_port"), int) or not isinstance(data.get("install_dir"), str):
                raise RuntimeError("The remote bootstrap returned an unexpected result.")
            return data
    raise RuntimeError("The remote bootstrap did not report its result.")


def setup_log_message(line: str) -> str | None:
    return line[len(SETUP_LOG_PREFIX):] if line.startswith(SETUP_LOG_PREFIX) else None


TOP_LEVEL_EXCLUDES = {".venv", ".git", "tests", ".pytest_cache"}


def build_source_tarball(source_dir: Path) -> bytes:
    """gzip tarball of the server source, same exclusions as the Electron upload."""

    def keep(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        parts = Path(info.name).parts
        if not parts or parts[0] in TOP_LEVEL_EXCLUDES or "__pycache__" in parts or info.name.endswith((".pyc", ".DS_Store")):
            return None
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for child in sorted(source_dir.iterdir()):
            tar.add(child, arcname=child.name, filter=keep)
    return buffer.getvalue()


# --- proxy helpers ----------------------------------------------------------

HOP_BY_HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}
# The remote rejects requests that look like they came through an identity-hiding proxy.
PROXY_IDENTITY_HEADERS = {"forwarded", "via", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"}
TOKEN_HEADERS = ("x-agentsdock-token", "x-zenithdock-token")
WS_HANDSHAKE_HEADERS = {"sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"}


def upstream_headers(raw_headers: list[tuple[bytes, bytes]], token: str, *, drop: set[str] = frozenset()) -> list[tuple[str, str]]:
    """Client headers with the hub credential swapped for the remote token in place.

    The remote's privileged routes check header *shape* (exactly one token header of
    one family, no cookies, no proxy-identity headers), so the credential family the
    client used is kept instead of injecting a canonical header.
    """

    forwarded: list[tuple[str, str]] = []
    families: list[str] = []
    for raw_name, raw_value in raw_headers:
        name = raw_name.decode("latin-1")
        lower = name.lower()
        if lower == "host" or lower == "cookie" or lower in HOP_BY_HOP_HEADERS or lower in PROXY_IDENTITY_HEADERS or lower.startswith("tailscale-user-") or lower in drop:
            continue
        if lower == "authorization" or lower in TOKEN_HEADERS:
            if lower not in families:
                families.append(lower)
            continue
        forwarded.append((name, raw_value.decode("latin-1")))
    for family in families:
        forwarded.append(("Authorization", f"Bearer {token}") if family == "authorization" else (family, token))
    return forwarded


def swap_token_query(query: str, token: str) -> str:
    pairs = parse_qsl(query, keep_blank_values=True)
    if not any(key == "token" for key, _ in pairs):
        return query
    return urlencode([(key, token if key == "token" else value) for key, value in pairs])


def downstream_headers(headers: httpx.Headers) -> list[tuple[str, str]]:
    return [(name, value) for name, value in headers.multi_items() if name.lower() not in HOP_BY_HOP_HEADERS]


def token_subprotocol(token: str) -> str:
    return TOKEN_SUBPROTOCOL_PREFIX + base64.urlsafe_b64encode(token.encode("utf-8")).decode("ascii").rstrip("=")


def upstream_ws_protocols(offered: list[str], token: str) -> tuple[list[str], str | None]:
    """Subprotocols to offer upstream, plus the client's token protocol to echo on accept."""

    protocols: list[str] = []
    echo: str | None = None
    for protocol in offered:
        if protocol.startswith(TOKEN_SUBPROTOCOL_PREFIX):
            if echo is None:
                echo = protocol
                protocols.append(token_subprotocol(token))
            continue
        protocols.append(protocol)
    return protocols, echo


def offered_protocols(ws: WebSocket) -> list[str]:
    values: list[str] = []
    for header in ws.headers.getlist("sec-websocket-protocol"):
        values.extend(part.strip() for part in header.split(",") if part.strip())
    return values


def valid_close_code(code: int | None) -> int:
    if code is None or code in (1005, 1006, 1015) or not 1000 <= code <= 4999:
        return 1000
    return code


# --- manager ------------------------------------------------------------------


class RemoteServerManager:
    def __init__(
        self,
        state_dir: Path,
        *,
        source_dir: Path,
        manage_tunnels: bool = True,
        revive: Callable[[RemoteServer], Awaitable[None]] = start_remote_server,
    ) -> None:
        self.path = state_dir / "remote-servers.json"
        self.forward_path = state_dir / "ssh-forwards.json"
        self.source_dir = source_dir
        self.manage_tunnels = manage_tunnels
        self._revive = revive
        self.servers: dict[str, RemoteServer] = {}
        self.tunnels: dict[str, Tunnel] = {}
        self.forwards: dict[str, SSHForward] = {}
        self.forward_tunnels: dict[str, Tunnel] = {}
        self.jobs: dict[str, DeployJob] = {}
        # keepalive_expiry must stay well below the remote uvicorn's idle keep-alive
        # (default 5 s). Both timers used to be 5 s, and over an ssh forward the
        # remote's close arrives late, so a request sent 4.5-5 s after the previous
        # one reused a connection the remote had already closed and failed with
        # "Server disconnected without sending a response".
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0),
            limits=httpx.Limits(keepalive_expiry=2.0),
            trust_env=False,
        )
        # Forward exactly the client's headers: httpx's defaults would change the
        # Accept-Encoding the remote sees and add a User-Agent the client never sent.
        for name in ("accept", "accept-encoding", "connection", "user-agent"):
            self.http.headers.pop(name, None)

    async def start(self) -> None:
        for forward in load_forward_registry(self.forward_path):
            self.forwards[forward.id] = forward
        # Load every server before moving any: a replacement port must avoid the
        # ports of servers later in the registry too.
        self.servers = {server.id: server for server in load_registry(self.path)}
        changed = False
        for server in self.servers.values():
            if self.manage_tunnels and not local_port_free(server.local_port):
                # Another process took the port while we were down; keep the
                # registry truthful before the tunnel binds.
                server.local_port = find_free_local_port(self._reserved_ports())
                changed = True
        if changed:
            save_registry(self.path, list(self.servers.values()))
        if self.manage_tunnels:
            for server in self.servers.values():
                self._ensure_tunnel(server)
            for forward in self.forwards.values():
                self._ensure_forward(forward)

    async def stop(self) -> None:
        for job in list(self.jobs.values()):
            if job.task is not None and not job.task.done():
                job.task.cancel()
        await asyncio.gather(*(tunnel.stop() for tunnel in [*self.tunnels.values(), *self.forward_tunnels.values()]),
                             return_exceptions=True)
        self.tunnels.clear()
        self.forward_tunnels.clear()
        await self.http.aclose()

    def _reserved_ports(self) -> set[int]:
        return ({server.local_port for server in self.servers.values()}
                | {forward.local_port for forward in self.forwards.values()})

    def _ensure_tunnel(self, server: RemoteServer) -> None:
        if not self.manage_tunnels:
            return
        current = self.tunnels.get(server.id)
        if current is not None and current.server == server:
            return
        if current is not None:
            asyncio.create_task(current.stop())
        tunnel = Tunnel(server, self._revive)
        self.tunnels[server.id] = tunnel
        logger.info("ssh tunnel starting for %s (%s, local %d -> remote %d)", server.id, server.ssh_host, server.local_port, server.remote_port)
        tunnel.start()

    def _ensure_forward(self, forward: SSHForward) -> None:
        if not self.manage_tunnels:
            return
        tunnel = Tunnel(forward, None)
        self.forward_tunnels[forward.id] = tunnel
        logger.info("ssh forward starting for %s (%s, local %d -> remote %d)",
                    forward.id, forward.ssh_host, forward.local_port, forward.remote_port)
        tunnel.start()

    def list_forwards(self) -> list[dict[str, Any]]:
        return [{**forward.model_dump(), "tunnel": dict(self.forward_tunnels[forward.id].status)
                 if forward.id in self.forward_tunnels else None}
                for forward in self.forwards.values()]

    def tunnel_status(self, remote_id: str) -> dict[str, Any] | None:
        tunnel = self.tunnels.get(remote_id)
        return dict(tunnel.status) if tunnel else None

    def get(self, remote_id: str) -> RemoteServer | None:
        return self.servers.get(remote_id)

    def list(self) -> list[dict[str, Any]]:
        return [public_view(server, self.tunnel_status(server.id)) for server in self.servers.values()]

    def _save(self) -> None:
        save_registry(self.path, list(self.servers.values()))

    async def add(self, request: RemoteServerCreate) -> RemoteServer:
        server = RemoteServer(
            id=secrets.token_hex(6),
            name=request.name or request.ssh_host,
            ssh_host=request.ssh_host,
            install_dir=request.install_dir,
            remote_port=request.remote_port,
            local_port=find_free_local_port(self._reserved_ports()),
            token=request.token,
            created_at=now_iso(),
        )
        self.servers[server.id] = server
        self._save()
        self._ensure_tunnel(server)
        return server

    async def remove(self, remote_id: str) -> None:
        server = self.servers.pop(remote_id, None)
        if server is None:
            raise HTTPException(status_code=404, detail="Unknown remote server.")
        tunnel = self.tunnels.pop(remote_id, None)
        if tunnel is not None:
            await tunnel.stop()
        self._save()

    async def probe_health(self, server: RemoteServer) -> dict[str, Any] | None:
        try:
            response = await self.http.get(
                f"http://127.0.0.1:{server.local_port}/api/health",
                headers={"X-AgentsDock-Token": server.token}, timeout=3.0,
            )
        except httpx.HTTPError:
            return None
        if response.status_code != 200:
            return None
        with suppress(ValueError):
            data = response.json()
            return data if isinstance(data, dict) else None
        return None

    # -- deploy ---------------------------------------------------------------

    def start_deploy(self, request: RemoteDeployRequest | RemoteAttachRequest | None, *, redeploy_id: str | None = None) -> DeployJob:
        if any(job.task is not None and not job.task.done() for job in self.jobs.values()):
            raise HTTPException(status_code=409, detail="Another remote deployment is already running.")
        if redeploy_id is not None and redeploy_id not in self.servers:
            raise HTTPException(status_code=404, detail="Unknown remote server.")
        if not shutil.which("ssh") and not Path(ssh_binary()).exists():
            raise HTTPException(status_code=503, detail="ssh is not installed on this server.")
        job = DeployJob(job_id=secrets.token_hex(8))
        self.jobs[job.job_id] = job
        del_ids = [job_id for job_id, old in list(self.jobs.items()) if old.done][:-20]
        for job_id in del_ids:
            self.jobs.pop(job_id, None)
        job.task = asyncio.create_task(self._deploy(job, request, redeploy_id), name=f"remote-deploy:{job.job_id}")
        return job

    def job(self, job_id: str) -> DeployJob | None:
        return self.jobs.get(job_id)

    def cancel_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.task is None or job.task.done():
            return False
        job.task.cancel()
        return True

    async def _deploy(self, job: DeployJob, request: RemoteDeployRequest | RemoteAttachRequest | None, redeploy_id: str | None) -> None:
        try:
            existing = self.servers[redeploy_id] if redeploy_id else None
            attach = isinstance(request, RemoteAttachRequest)
            if existing is not None:
                ssh_host, install_dir, requested_port = existing.ssh_host, existing.install_dir, existing.remote_port
            else:
                assert request is not None
                ssh_host, install_dir = request.ssh_host, request.install_dir
                requested_port = request.port if isinstance(request, RemoteDeployRequest) else 0
                home = next((os.environ.get(name, "") for prefix, name in CLUSTER_HOME_ENV.items() if ssh_host.startswith(prefix)), "")
                if home and install_dir == DEFAULT_INSTALL_DIR:
                    # The home is shared storage: one install per target keeps each cluster's
                    # chats apart, and no two servers ever write one state directory. The
                    # install stays a direct child of the home, which the probe then uses as HOME.
                    target = ssh_host.split("@", 1)[1]
                    install_dir = validate_remote_dir(f"{home.rstrip('/')}/.agentsdock-server-{target}")

            job.progress("connect", f"Probing {ssh_host}…")
            route = await ssh_route(ssh_host)
            probe_lines = await self._run_ssh(job, route, [*remote_shell_args(route.destination), install_dir], stdin=PROBE_SCRIPT.read_bytes(), idle_timeout=60)
            probe = parse_probe(probe_lines)
            if attach and not probe.get("existing_port"):
                raise RuntimeError(f"No AgentsServer install was found at {install_dir} on {ssh_host}. Deploy a new server instead.")
            remote_port = requested_port or probe.get("existing_port") or probe["free_port"]
            job.progress("connect", f"Host: {probe.get('os')} {probe.get('arch')}, uid {probe.get('uid')}, home {probe['home']}; remote port {remote_port}.")
            if not probe.get("tmux"):
                job.progress("connect", "tmux is not installed on the host; the server will run under nohup and chat terminals stay disabled.")

            if attach:
                job.progress("install", f"Checking the AgentsServer install on {ssh_host}…")
            else:
                job.progress("download", f"Uploading AgentsServer source to {ssh_host}…")
                tarball = await asyncio.to_thread(build_source_tarball, self.source_dir)
                await self._upload(job, route, install_dir, tarball)
                job.progress("install", f"Installing AgentsServer on {ssh_host}…")
            # Without upload.tgz on the host the bootstrap only makes sure the server
            # is running and reports its port and token (see remote_bootstrap.sh).
            args = [*remote_shell_args(route.destination), install_dir, str(remote_port), probe["home"]]
            if existing is not None:
                args.append("restart")
            # The hub's own long-lived Claude token (`claude setup-token`) rides at the head of the
            # script on stdin: never in argv, ps output or the job log.
            token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
            prelude = f"AGENTSDOCK_CLAUDE_TOKEN={shlex.quote(token)}\n".encode() if token else b""
            result_lines = await self._run_ssh(
                job, route, args, stdin=prelude + BOOTSTRAP_SCRIPT.read_bytes(), idle_timeout=180,
                on_line=lambda line: job.progress("install", setup_log_message(line) or "") if setup_log_message(line) else None,
            )
            result = parse_setup_result(result_lines)

            job.progress("service", "Opening the SSH tunnel…")
            if existing is not None:
                server = existing
                if existing.remote_port != result["remote_port"] or existing.install_dir != result["install_dir"] or existing.token != result["access_token"]:
                    server = existing.model_copy(update={"remote_port": result["remote_port"], "install_dir": result["install_dir"], "token": result["access_token"]})
                    self.servers[server.id] = server
                    self._save()
                    self._ensure_tunnel(server)
            else:
                server = RemoteServer(
                    id=secrets.token_hex(6),
                    name=(request.name if request and request.name else ssh_host),
                    ssh_host=ssh_host,
                    install_dir=result["install_dir"],
                    remote_port=result["remote_port"],
                    local_port=find_free_local_port(self._reserved_ports()),
                    token=result["access_token"],
                    created_at=now_iso(),
                )
                self.servers[server.id] = server
                self._save()
                self._ensure_tunnel(server)

            job.progress("health", "Waiting for the server behind the tunnel…")
            health = await self._wait_health(server)
            job.server = server
            job.progress("complete", f"AgentsServer {health.get('version') or ''} is reachable through the hub.".replace("  ", " "))
        except asyncio.CancelledError:
            job.error = "Deployment cancelled."
            job.progress(job.phase, job.error)
        except Exception as exc:  # noqa: BLE001 - the job view carries the message
            job.error = str(exc) or exc.__class__.__name__
            job.progress(job.phase, job.error)
            logger.warning("remote deployment %s failed: %s", job.job_id, job.error)
        finally:
            job.done = True
            if job.proc is not None and job.proc.returncode is None:
                with suppress(ProcessLookupError):
                    job.proc.kill()
            job.proc = None

    async def _run_ssh(self, job: DeployJob, route: SSHRoute, args: list[str], *, stdin: bytes, idle_timeout: float,
                       on_line: Callable[[str], None] | None = None) -> list[str]:
        proc = await asyncio.create_subprocess_exec(
            ssh_binary(), *route.options, *args,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=route.env,
        )
        job.proc = proc
        lines: list[str] = []
        assert proc.stdin is not None and proc.stdout is not None
        try:
            proc.stdin.write(stdin)
            await proc.stdin.drain()
            proc.stdin.close()
            while True:
                try:
                    raw = await asyncio.wait_for(proc.stdout.readline(), idle_timeout)
                except asyncio.TimeoutError:
                    raise RuntimeError(f"No output from the host for {idle_timeout:.0f}s.") from None
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                lines.append(line)
                if on_line is not None:
                    on_line(line)
            code = await proc.wait()
        finally:
            job.proc = None
            if proc.returncode is None:
                with suppress(ProcessLookupError):
                    proc.kill()
        if code != 0:
            detail = next((line for line in reversed(lines) if line.strip() and not line.startswith((PROBE_PREFIX, RESULT_PREFIX))), "")
            if code == 255:
                raise SSHConnectionLost(detail or "ssh exited 255")
            raise RuntimeError(detail or f"ssh exited {code}")
        return lines

    async def _upload(self, job: DeployJob, route: SSHRoute, install_dir: str, data: bytes) -> None:
        offset, attempts = 0, 0
        while True:
            try:
                if attempts:
                    offset = await self._uploaded_bytes(job, route, install_dir)
                    if offset > len(data):
                        offset = 0  # the host holds more than was sent: start over rather than append to it
                await self._upload_from(job, route, install_dir, data, offset)
                if attempts:
                    held = await self._uploaded_bytes(job, route, install_dir)
                    if held != len(data):
                        raise RuntimeError(f"Uploading the server source failed: the host holds {held} of {len(data)} bytes.")
                return
            except SSHConnectionLost as exc:
                attempts += 1
                if attempts > UPLOAD_RETRIES:
                    raise
                job.progress("download", f"{exc}; resuming the upload ({attempts}/{UPLOAD_RETRIES})…")
                await asyncio.sleep(UPLOAD_RETRY_DELAY)

    async def _uploaded_bytes(self, job: DeployJob, route: SSHRoute, install_dir: str) -> int:
        lines = await self._run_ssh(
            job, route, [*SSH_BATCH_OPTIONS, route.destination, f"wc -c < {install_dir}/upload.tgz 2>/dev/null || echo 0"],
            stdin=b"", idle_timeout=60,
        )
        # ssh warnings share the stream; the byte count is the last all-digit line.
        return next((int(line) for line in reversed(lines) if line.strip().isdigit()), 0)

    async def _upload_from(self, job: DeployJob, route: SSHRoute, install_dir: str, data: bytes, offset: int) -> None:
        # install_dir is validated to [A-Za-z0-9_.~/-]; unquoted so ~ expands on the host.
        target = f"{install_dir}/upload.tgz"
        command = f"mkdir -p {install_dir} && cat > {target}" if offset == 0 else f"cat >> {target}"
        proc = await asyncio.create_subprocess_exec(
            ssh_binary(), *route.options, *SSH_BATCH_OPTIONS, route.destination, command,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=route.env,
        )
        job.proc = proc
        assert proc.stdin is not None
        output = b""
        try:
            last_report = time.monotonic()
            view = memoryview(data)
            try:
                for pos in range(offset, len(data), UPLOAD_CHUNK):
                    proc.stdin.write(view[pos:pos + UPLOAD_CHUNK])
                    await asyncio.wait_for(proc.stdin.drain(), 120)
                    if time.monotonic() - last_report > 2:
                        last_report = time.monotonic()
                        job.progress("download", f"Uploading AgentsServer source… {min(len(data), pos + UPLOAD_CHUNK) / 1048576:.1f} MB")
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass  # ssh died first; its exit code and output carry the reason
            output, _ = await asyncio.wait_for(proc.communicate(), 120)
        except asyncio.TimeoutError:
            raise RuntimeError("Uploading the server source stalled.") from None
        finally:
            job.proc = None
            if proc.returncode is None:
                with suppress(ProcessLookupError):
                    proc.kill()
        if proc.returncode != 0:
            detail = last_line(output.decode("utf-8", "replace")) or f"ssh exited {proc.returncode}"
            if proc.returncode == 255:
                raise SSHConnectionLost(f"Uploading the server source failed: {detail}")
            raise RuntimeError(f"Uploading the server source failed: {detail}")

    async def _wait_health(self, server: RemoteServer, timeout: float = 30.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last_error = "no response"
        while time.monotonic() < deadline:
            try:
                response = await self.http.get(f"http://127.0.0.1:{server.local_port}/api/health", headers={"X-AgentsDock-Token": server.token}, timeout=3.0)
                if response.status_code == 200:
                    data = response.json()
                    return data if isinstance(data, dict) else {}
                last_error = f"health returned {response.status_code}"
            except httpx.HTTPError as exc:
                last_error = str(exc) or exc.__class__.__name__
            await asyncio.sleep(1)
        raise RuntimeError(f"The remote server did not answer through the tunnel: {last_error}")


def capability(manager: RemoteServerManager) -> dict[str, Any]:
    return {
        "available": True,
        "required": False,
        "version": 1,
        "proxy_prefix": PROXY_PREFIX,
        "admin_path": ADMIN_PATH,
        "ssh_available": shutil.which("ssh") is not None or Path("/usr/bin/ssh").exists(),
        "count": len(manager.servers),
    }


# --- routes ---------------------------------------------------------------------


def register_remote_server_routes(
    app: FastAPI,
    *,
    manager: RemoteServerManager,
    authorize_admin: Callable[[Request], None],
    websocket_authorized: Callable[[WebSocket], bool],
) -> None:
    @app.get(ADMIN_PATH)
    async def remote_servers_list(request: Request) -> dict[str, Any]:
        authorize_admin(request)
        return {"servers": manager.list()}

    @app.post(ADMIN_PATH, status_code=201)
    async def remote_servers_add(request: Request, body: RemoteServerCreate) -> dict[str, Any]:
        authorize_admin(request)
        server = await manager.add(body)
        return public_view(server, manager.tunnel_status(server.id))

    @app.post(f"{ADMIN_PATH}/deploy", status_code=202)
    async def remote_servers_deploy(request: Request, body: RemoteDeployRequest) -> dict[str, Any]:
        authorize_admin(request)
        return {"job_id": manager.start_deploy(body).job_id}

    @app.post(f"{ADMIN_PATH}/attach", status_code=202)
    async def remote_servers_attach(request: Request, body: RemoteAttachRequest) -> dict[str, Any]:
        authorize_admin(request)
        return {"job_id": manager.start_deploy(body).job_id}

    @app.get(f"{ADMIN_PATH}/deploy/{{job_id}}")
    async def remote_servers_deploy_status(request: Request, job_id: str) -> dict[str, Any]:
        authorize_admin(request)
        job = manager.job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown deployment job.")
        return job.view(manager.tunnel_status(job.server.id) if job.server else None)

    @app.post(f"{ADMIN_PATH}/deploy/{{job_id}}/cancel")
    async def remote_servers_deploy_cancel(request: Request, job_id: str) -> dict[str, Any]:
        authorize_admin(request)
        if manager.job(job_id) is None:
            raise HTTPException(status_code=404, detail="Unknown deployment job.")
        return {"cancelled": manager.cancel_job(job_id)}

    @app.post(f"{ADMIN_PATH}/{{remote_id}}/redeploy", status_code=202)
    async def remote_servers_redeploy(request: Request, remote_id: str) -> dict[str, Any]:
        authorize_admin(request)
        return {"job_id": manager.start_deploy(None, redeploy_id=remote_id).job_id}

    @app.get(f"{ADMIN_PATH}/{{remote_id}}/status")
    async def remote_servers_status(request: Request, remote_id: str) -> dict[str, Any]:
        authorize_admin(request)
        server = manager.get(remote_id)
        if server is None:
            raise HTTPException(status_code=404, detail="Unknown remote server.")
        return {"server": public_view(server, manager.tunnel_status(remote_id)), "tunnel": manager.tunnel_status(remote_id), "health": await manager.probe_health(server)}

    @app.delete(f"{ADMIN_PATH}/{{remote_id}}", status_code=204)
    async def remote_servers_remove(request: Request, remote_id: str) -> Response:
        authorize_admin(request)
        await manager.remove(remote_id)
        return Response(status_code=204)

    # OPTIONS is deliberately absent: the hub middleware lets OPTIONS through unauthenticated.
    @app.api_route(f"{PROXY_PREFIX}/{{remote_id}}/{{path:path}}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    async def remote_servers_proxy_http(request: Request, remote_id: str, path: str) -> Response:
        server = manager.get(remote_id)
        if server is None:
            return JSONResponse({"detail": {"code": "remote_not_found", "remote_id": remote_id}}, status_code=404)
        headers = upstream_headers(request.scope.get("headers", []), server.token)
        query = swap_token_query(request.url.query, server.token)
        url = f"http://127.0.0.1:{server.local_port}/{path}" + (f"?{query}" if query else "")
        content = None
        if request.method not in ("GET", "HEAD") and (request.headers.get("content-length") not in (None, "0") or "transfer-encoding" in request.headers):
            content = request.stream()
        upstream_request = manager.http.build_request(request.method, url, headers=headers, content=content)
        try:
            upstream = await manager.http.send(upstream_request, stream=True)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            return JSONResponse(
                {"detail": {"code": "remote_unreachable", "remote_id": remote_id, "tunnel": manager.tunnel_status(remote_id), "message": str(exc) or "connection failed"}},
                status_code=502,
            )
        except httpx.ReadTimeout as exc:
            return JSONResponse({"detail": {"code": "remote_timeout", "remote_id": remote_id, "message": str(exc) or "timeout"}}, status_code=504)
        except httpx.HTTPError as exc:
            return JSONResponse({"detail": {"code": "remote_proxy_error", "remote_id": remote_id, "message": str(exc) or exc.__class__.__name__}}, status_code=502)
        response = StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, background=BackgroundTask(upstream.aclose))
        response.raw_headers = [(name.encode("latin-1"), value.encode("latin-1")) for name, value in downstream_headers(upstream.headers)]
        return response

    @app.websocket(f"{PROXY_PREFIX}/{{remote_id}}/{{path:path}}")
    async def remote_servers_proxy_ws(ws: WebSocket, remote_id: str, path: str) -> None:
        if not websocket_authorized(ws):
            await ws.close(code=1008)
            return
        server = manager.get(remote_id)
        if server is None:
            await ws.close(code=1008, reason="unknown remote server")
            return
        protocols, echo = upstream_ws_protocols(offered_protocols(ws), server.token)
        headers = upstream_headers(ws.scope.get("headers", []), server.token, drop=WS_HANDSHAKE_HEADERS)
        query = swap_token_query(ws.url.query, server.token)
        url = f"ws://127.0.0.1:{server.local_port}/{path}" + (f"?{query}" if query else "")
        try:
            upstream = await websocket_connect(url, additional_headers=headers, subprotocols=protocols or None, max_size=None, open_timeout=10)
        except websockets.exceptions.InvalidStatus as exc:
            status = exc.response.status_code
            await ws.close(code=1008 if status in (401, 403) else 1011, reason=f"remote returned {status}")
            return
        except (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException):
            await ws.close(code=1011, reason="remote server unreachable")
            return
        selected = upstream.subprotocol
        try:
            await ws.accept(subprotocol=echo if (echo and selected and selected.startswith(TOKEN_SUBPROTOCOL_PREFIX)) else selected)
        except (RuntimeError, WebSocketDisconnect):
            # The client left while the upstream handshake was in flight (uvicorn
            # then refuses websocket.accept); close the upstream instead of leaking it.
            with suppress(Exception):
                await upstream.close()
            return

        async def pump_down() -> None:
            async for message in upstream:
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                else:
                    await ws.send_text(message)

        async def pump_up() -> dict[str, Any]:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    return message
                if message.get("bytes") is not None:
                    await upstream.send(message["bytes"])
                elif message.get("text") is not None:
                    await upstream.send(message["text"])

        down = asyncio.create_task(pump_down())
        up = asyncio.create_task(pump_up())
        try:
            done, pending = await asyncio.wait({down, up}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if up in done:
                disconnect = up.result() if up.exception() is None else {}
                await upstream.close(code=valid_close_code(disconnect.get("code")), reason=str(disconnect.get("reason") or "")[:120])
            else:
                error = down.exception()
                if error is None or isinstance(error, websockets.exceptions.ConnectionClosed):
                    await ws.close(code=valid_close_code(upstream.close_code), reason=(upstream.close_reason or "")[:120])
                else:
                    logger.warning("remote websocket proxy %s failed: %s", remote_id, error)
                    await ws.close(code=1011, reason="proxy error")
        finally:
            with suppress(Exception):
                await upstream.close()
