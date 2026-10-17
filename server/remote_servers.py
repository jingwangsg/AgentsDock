"""Hub for remote AgentsServers that are reachable only over SSH.

The hub keeps a registry of remote servers, holds an ``ssh -L`` tunnel open to
each one, deploys or updates the server source on demand, and reverse-proxies
``/api/remote/{id}/...`` (HTTP and WebSocket) to the tunnel so clients only ever
hold the hub's URL and token; phones, which have neither ssh nor the server
source, get the same capability. Hosts are ssh destinations or the cluster
notations ``oci@<sky-cluster>``, ``aws@<sky-cluster>`` and ``osmo@<workflow>`` (see ``ssh_route``).
"""

from __future__ import annotations

import asyncio
import base64
import fnmatch
import io
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Literal
from urllib.parse import parse_qsl, urlencode

import httpx
import websockets
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.background import BackgroundTask
from starlette.requests import ClientDisconnect
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

# Same syntax as electron/src/main/settings.ts. Only the hub resolves oci@/aws@/osmo@ (ssh_route);
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
# Measured through an osmo exec relay: 20-40 s to open an ssh session, then 3-8 s per request
# (0.09 s on the host itself). A deploy waits DEPLOY_HEALTH_WAIT_SECONDS for the tunnel and a fresh server.
HEALTH_REQUEST_TIMEOUT = 20.0
DEPLOY_HEALTH_WAIT_SECONDS = 120.0
# HTTP timeout for a remote's /api/admin/runtimes/{backend}/update: the remote itself stops the CLI
# after 10 minutes (RUNTIME_CLI_UPDATE_TIMEOUT_SECONDS), so its answer arrives before this fires.
CLI_UPDATE_REQUEST_TIMEOUT = 11 * 60.0
CLI_PRODUCT_NAMES = {"claude": "Claude Code", "codex": "Codex"}
SSH_FORWARD_PROBE_TIMEOUT = 30.0
SSH_FORWARD_PROBE_FAILURES = 3
UPLOAD_CHUNK = 256 * 1024
# Forwarded ssh hops drop mid-transfer; each retry appends from the byte count
# the host reports, so a hop that flaps every couple of minutes still finishes
# a multi-minute upload instead of restarting it.
UPLOAD_RETRIES = 8
UPLOAD_RETRY_DELAY = 5.0

DEFAULT_INSTALL_DIR = "~/.agentsdock-server"
# install.sh's default AGENTS_SERVER_CONFIG_DIR: where a server installed with install.sh (a Mac's own server) keeps its env.
INSTALL_SH_CONFIG_DIR = "~/.config/agents-server"
SKY_CA_BUNDLE = Path.home() / ".sky" / "certs" / "requests-ca-bundle.pem"
# An aws@ cluster's ssh entry opens an AWS SSM session, which needs AWS credentials: a temporary
# STS session that the cluster itself mints (see aws_session_file); one credentials file per cluster.
AWS_SESSION_DIR = Path.home() / ".aws"
AWS_SESSION_SECONDS = 3600
# An STS session is replaced this long before it ends: a deploy resolves its route once and
# opens its later ssh connections with that route's credentials.
AWS_SESSION_MARGIN = 1800
# A failed relay is repeated only after this long: tunnels retry a failed connection every
# few seconds, and a relay that keeps failing must not flood the cluster's job queue.
AWS_RELAY_INTERVAL = 120.0
# When SkyPilot's API server login on the hub's machine expires, every oci@ ssh fails at Sky's websocket
# proxy and every `sky` call (ssh entry listing, aws@ session relay) with HTTP 401. A failed oci@ or aws@
# connection then asks Sky whether it needs a login; tunnels fail together and share one answer this long.
SKY_API_INFO_INTERVAL = 60.0
# A login page opens again only after this long, so a page the user ignores is not followed by one per retry.
SKY_LOGIN_INTERVAL = 600.0
# `sky api login` polls for the Authorize click for 300 s, then falls back to Sky's older localhost-callback
# login, which opens a second page; it is killed before that.
SKY_LOGIN_TIMEOUT = 290.0
# Sky rewrites a cluster's ssh entry only when it lists the cluster. A relaunched cluster runs in a new pod
# with a new address, and the old entry ends every ssh with "Connection closed by UNKNOWN port 65535" until
# the next listing. Such a tunnel exit and every deploy have Sky list the cluster (5-7 s, measured 2026-10-16);
# tunnels fail together and share one listing this long.
SKY_ENTRY_REFRESH_INTERVAL = 60.0
SKY_LOGIN_ERROR = ("SkyPilot on the hub's machine needs a new login. Click Authorize on the newest SkyPilot login "
                   "page in that machine's browser (the hub opens one at most every 10 minutes), or run `sky api login` there.")
# A cluster container's own ~ does not outlive it. When the hub's environment names
# the persistent cluster home where the Claude and Codex logins are kept, a default
# install goes there, one per cluster or workflow (see default_install_dir); mount points are
# site-specific, so they stay out of the source.
CLUSTER_HOME_ENV = {"oci@": "AGENTSDOCK_OCI_HOME", "osmo@": "AGENTSDOCK_OSMO_HOME"}
# workflow -> OSMO pool, recorded by osmo_lead_task on every tunnel and deploy query. Pools mount different
# storage and a workflow's name need not name its pool, so cluster_home matches AGENTSDOCK_OSMO_POOL_HOMES
# ("<pool glob>=<home>", space-separated, first match wins) against it; a pool that matches no entry, or is
# not recorded yet, gets AGENTSDOCK_OSMO_HOME.
OSMO_POOLS: dict[str, str] = {}
# No leading "-": workflow and task names are passed to the osmo CLI as arguments.
OSMO_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
# `ssh <remote name>` from this machine: one alias file per remote (see write_ssh_alias), in the
# directory where the desktop app keeps its own aliases and that ~/.ssh/config includes.
SSH_ALIAS_DIR = Path.home() / ".agentsdock" / "ssh"
SSH_CONFIG = Path.home() / ".ssh" / "config"
# First line of every alias file the hub writes; the desktop app leaves such a file to the hub
# (hubKeepsSshHost in electron/src/main/ssh-hosts.ts).
SSH_ALIAS_MARKER = "# Added by the AgentsDock hub"
# A name ssh_config takes as a Host pattern and a file name (SSH_HOST_ALIAS_PATTERN on the desktop).
SSH_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

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


def cluster_home(ssh_host: str, *, by_pool: bool = True) -> str:
    """The persistent home the hub's environment names for this cluster target, without a trailing /, or "".

    An osmo@ target gets its pool's home only once osmo_lead_task recorded the pool; by_pool=False
    gives the home it had before AGENTSDOCK_OSMO_POOL_HOMES named its pool."""
    pool = OSMO_POOLS.get(ssh_host.removeprefix("osmo@"), "") if by_pool and ssh_host.startswith("osmo@") else ""
    for entry in os.environ.get("AGENTSDOCK_OSMO_POOL_HOMES", "").split():
        pattern, _, home = entry.partition("=")
        if pool and home and fnmatch.fnmatchcase(pool, pattern):
            return home.rstrip("/")
    return next((os.environ.get(name, "") for prefix, name in CLUSTER_HOME_ENV.items() if ssh_host.startswith(prefix)), "").rstrip("/")


def default_install_dir(ssh_host: str, *, by_pool: bool = True) -> str:
    """The home of a cluster target is shared storage: one install per target keeps each
    machine's chats apart, and no two servers ever write one state directory. The install
    stays a direct child of the home, which the deploy then uses as HOME."""
    home = cluster_home(ssh_host, by_pool=by_pool)
    if not home:
        return DEFAULT_INSTALL_DIR
    return validate_remote_dir(f"{home}/.agentsdock-server-{ssh_host.split('@', 1)[1]}")


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
    # Registered by attach: another hub set this install up and updates it, so this hub never redeploys it.
    attached: bool = False
    # Left out of the lists clients offer for choosing a server; Settings still lists it, and its tunnels,
    # chats and ssh alias stay as they are.
    hidden: bool = False

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


class RemoteServerUpdate(BaseModel):
    """Change a registered server in place; its id, and so every client profile, stays valid."""

    name: str | None = None
    ssh_host: str | None = None
    install_dir: str | None = None
    hidden: bool | None = None

    _name = field_validator("name")(classmethod(lambda cls, value: RemoteServer._name(value) if value is not None else None))
    _host = field_validator("ssh_host")(classmethod(lambda cls, value: validate_ssh_host(value) if value is not None else None))
    _dir = field_validator("install_dir")(classmethod(lambda cls, value: validate_remote_dir(value) if value is not None else None))


class RemoteServerOrder(BaseModel):
    ids: list[str]


class RemoteDeployRequest(BaseModel):
    ssh_host: str
    install_dir: str = DEFAULT_INSTALL_DIR
    name: str | None = None
    port: int = 0  # 0 = let the host pick (or keep an existing install's port)
    # Used once to install this hub's SSH key on the host; never stored (see RemoteServerManager._install_key).
    password: str | None = Field(default=None, repr=False)

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
    # Same one-time use as RemoteDeployRequest.password.
    password: str | None = Field(default=None, repr=False)

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
        "hidden": server.hidden,
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
    compress: bool = False,
) -> list[str]:
    args = [
        "-N",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", f"ConnectTimeout={connect_timeout}",
        # A Sky websocket hop stalled for ~50 s on 2026-10-07 with every request on the
        # connection timing out while ssh, probing every 30 s, never noticed. Three missed
        # probes 10 s apart end such a connection in 30 s and the supervisor reconnects.
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=accept-new",
        *NO_MULTIPLEX,
    ]
    if compress:
        # Measured 2026-10-07 on oci_dev through the Sky proxy, two rounds each: an
        # 800 KB JSON page 104-133 KiB/s plain, 351 KiB/s with -C; /api/health 1.5 s
        # plain, 1.0 s with -C. Random bytes gain nothing, so file-body tunnels skip it.
        args.append("-C")
    if verbose:
        args.append("-v")
    if channel_timeout is not None:
        args.extend(["-o", f"ChannelTimeout={channel_timeout}"])
    local_binding = f"127.0.0.1:{validate_port(local_port)}" if bind_mode == "ipv4" else str(validate_port(local_port))
    return [*args, "-L", f"{local_binding}:127.0.0.1:{validate_remote_port(remote_port)}", validate_ssh_host(ssh_host)]


async def resolved_proxy_command(ssh_host: str) -> str:
    """The ProxyCommand ssh resolves for the host; empty when it has none."""
    return (await resolved_ssh_options(ssh_host)).get("proxycommand", [""])[0]


async def resolved_ssh_options(ssh_host: str, config_file: Path | None = None) -> dict[str, list[str]]:
    """`ssh -G`: every option as ssh would use it for the host, keyed in lower case; from `config_file` alone when given."""
    config = await asyncio.create_subprocess_exec(
        ssh_binary(), *(["-F", str(config_file)] if config_file else []), "-G", ssh_host, stdout=asyncio.subprocess.PIPE,
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
    options: dict[str, list[str]] = {}
    for line in output.decode("utf-8", "replace").splitlines():
        key, _, value = line.partition(" ")
        if key and value:
            options.setdefault(key, []).append(value)
    return options


async def isolated_proxy_args(ssh_host: str) -> list[str]:
    # Sky-generated aliases have an inner ssh hop; the outer -o options do not isolate it.
    command = await resolved_proxy_command(ssh_host)
    if not command.startswith("ssh "):
        return []
    return ["-o", "ProxyCommand=ssh -S none -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=30 " + command.removeprefix("ssh ")]


@dataclass
class SSHRoute:
    """ssh options, destination and environment that reach a registered host."""

    options: list[str]
    destination: str
    env: dict[str, str]


def cli_search_path() -> str:
    # launchd starts the hub with a minimal PATH; the osmo, sky and aws CLIs install into one of these.
    return os.pathsep.join([os.environ.get("PATH", ""), "/usr/local/bin", "/opt/homebrew/bin", str(Path.home() / ".local" / "bin")])


def cluster_cli(name: str) -> str | None:
    return shutil.which(name, path=cli_search_path())


async def write_sky_ssh_entry(cluster: str, env: dict[str, str]) -> None:
    """Have Sky write the cluster's ssh entry, which it does for every cluster ``sky status`` lists.

    A cluster launched since the last listing (or from another machine) has none yet. A plain
    listing, unlike ``sky status -r``, needs no workspace and never drops other entries.
    """

    sky = cluster_cli("sky")
    if sky is None:
        return
    listing = await asyncio.create_subprocess_exec(
        sky, "status", "-u", "--", cluster, env=env,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(listing.wait(), timeout=90)
    finally:
        if listing.returncode is None:  # timed out, or the tunnel or deploy was cancelled
            listing.kill()
            await listing.wait()


# Per cluster: the running or last ssh entry listing, and when it started.
SKY_ENTRY_REFRESH: dict[str, tuple[asyncio.Task[None], float]] = {}


async def refresh_sky_ssh_entry(ssh_host: str) -> None:
    """Have Sky rewrite the ssh entry of an oci@ or aws@ host, at most once per SKY_ENTRY_REFRESH_INTERVAL per cluster."""

    if not ssh_host.startswith(("oci@", "aws@")):
        return
    cluster = ssh_host.split("@", 1)[1]
    listing, started = SKY_ENTRY_REFRESH.get(cluster, (None, 0.0))
    # A listing still running (up to write_sky_ssh_entry's 90 s) is joined, not started again.
    if listing is None or (listing.done() and time.monotonic() - started >= SKY_ENTRY_REFRESH_INTERVAL):
        logger.info("asking Sky for a new ssh entry for %s", cluster)
        env = ssh_env()
        if SKY_CA_BUNDLE.exists():
            env["SSL_CERT_FILE"] = env["REQUESTS_CA_BUNDLE"] = str(SKY_CA_BUNDLE)
        listing = asyncio.create_task(write_sky_ssh_entry(cluster, env), name=f"sky-ssh-entry:{cluster}")
        SKY_ENTRY_REFRESH[cluster] = (listing, time.monotonic())
    # A cancelled waiter (a stopped tunnel or deploy) leaves the running listing to the others. A failed
    # listing does not fail the caller; the ssh that follows reports the problem.
    with suppress(OSError, asyncio.TimeoutError):
        await asyncio.shield(listing)


async def osmo_lead_task(workflow: str) -> tuple[str, str]:
    """The osmo CLI path and the lead task of a running workflow."""

    if not OSMO_NAME_RE.fullmatch(workflow):
        raise OSError(f"Invalid OSMO workflow id: {workflow}")
    osmo = cluster_cli("osmo")
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
        if isinstance(data.get("pool"), str):
            OSMO_POOLS[workflow] = data["pool"]
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


async def cli_output(argv: list[str], env: dict[str, str], timeout: float, stdin: bytes | None = None) -> str:
    """stdout of a CLI run; a failure or timeout raises OSError, which Tunnel._supervise retries."""

    proc = await asyncio.create_subprocess_exec(
        *argv, env=env, stdin=asyncio.subprocess.DEVNULL if stdin is None else asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    name = f"{Path(argv[0]).name} {argv[1]}"
    try:
        output, error = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except asyncio.TimeoutError:
        raise OSError(f"{name} timed out.") from None
    finally:
        if proc.returncode is None:  # timed out, or the tunnel or deploy was cancelled
            proc.kill()
            await proc.wait()
    if proc.returncode:
        raise OSError(last_line(error.decode("utf-8", "replace")) or last_line(output.decode("utf-8", "replace"))
                      or f"{name} exited {proc.returncode}.")
    return output.decode("utf-8", "replace")


# Runs on an aws@ cluster under `sky exec`. The cluster's own AWS keys mint the STS session. Sky
# keeps job logs, so the job prints the session only encrypted, with a key made for this run that
# reaches the job as a Sky secret. python3 on a base image may lack boto3.
AWS_RELAY_SCRIPT = f"""\
set -euo pipefail
python3 -c 'import boto3' 2>/dev/null || python3 -m pip install --quiet --user boto3
session=$(python3 -c '
import json, boto3
credentials = boto3.client("sts").get_session_token(DurationSeconds={AWS_SESSION_SECONDS})["Credentials"]
print(json.dumps({{key: credentials[key] for key in ("AccessKeyId", "SecretAccessKey", "SessionToken")}}))
' | openssl enc -aes-256-cbc -pbkdf2 -a -A -pass env:AGENTSDOCK_RELAY_KEY)
echo "AGENTSDOCK_AWS_SESSION=$session"
"""
# Per cluster, the running or last relay and when it started. The tunnels of one server
# reconnect together; they wait on one relay.
AWS_RELAYS: dict[str, tuple[asyncio.Task[None], float]] = {}


async def relay_aws_session(cluster: str, path: Path, env: dict[str, str]) -> None:
    """Have the cluster mint an STS session and save it to ``path`` as profile ``agentsdock``.

    The hub's machine usually holds no AWS keys; the cluster does, since Sky set it up with them.
    """

    sky = cluster_cli("sky")
    if sky is None:
        raise OSError("The sky CLI is not installed on this server.")
    # `sky exec` refuses a cluster outside the active workspace.
    listing = await cli_output([sky, "status", "-u", "-o", "json", "--", cluster], env, timeout=90)
    # Sky logs warnings to stdout too; the JSON starts at the line that opens the list.
    start = re.search(r"^\[", listing, re.MULTILINE)
    try:
        records = json.JSONDecoder().raw_decode(listing, start.start())[0] if start else []
        workspace = next((record["workspace"] for record in records if record["name"] == cluster), None)
    except (ValueError, LookupError, TypeError):
        raise OSError(f"`sky status -u` returned an unexpected result for {cluster}.") from None
    if workspace is None:
        raise OSError(f"`sky status -u` does not list {cluster}.")

    # --secret takes the key from this environment, so it is in neither argv nor the job log.
    relay_env = {**env, "AGENTSDOCK_RELAY_KEY": secrets.token_urlsafe(32)}
    # Measured on 2026-10-11: status and exec took 31 s together and the job itself ran 3 s;
    # the timeout leaves room for a busy job queue on the cluster.
    output = await cli_output(
        [sky, "exec", "--config", f"active_workspace={workspace}", "--name", "agentsdock-aws-session",
         "--secret", "AGENTSDOCK_RELAY_KEY", "--", cluster, AWS_RELAY_SCRIPT],
        relay_env, timeout=300,
    )
    sealed = re.search(r"AGENTSDOCK_AWS_SESSION=([A-Za-z0-9+/=]+)", output)
    if sealed is None:
        raise OSError(f"The AWS session relay on {cluster} printed no session.")
    opened = await cli_output(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-a", "-A", "-pass", "env:AGENTSDOCK_RELAY_KEY"],
        relay_env, timeout=30, stdin=sealed.group(1).encode() + b"\n",
    )
    try:
        session = json.loads(opened)
        content = (f"[agentsdock]\naws_access_key_id={session['AccessKeyId']}\n"
                   f"aws_secret_access_key={session['SecretAccessKey']}\naws_session_token={session['SessionToken']}\n")
    except (ValueError, LookupError, TypeError):
        raise OSError(f"The AWS session relay on {cluster} returned an unexpected result.") from None
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Replaced whole: the ssh connections of the other tunnels may read the file meanwhile.
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.touch(mode=0o600)
    tmp.write_text(content, "utf-8")
    os.replace(tmp, path)


async def aws_session_file(cluster: str, env: dict[str, str]) -> Path:
    """The credentials file for the cluster's SSM ProxyCommand, relayed again when its STS session nears its end."""

    path = AWS_SESSION_DIR / f"agentsdock-{cluster}.credentials"
    with suppress(FileNotFoundError):
        if time.time() - path.stat().st_mtime < AWS_SESSION_SECONDS - AWS_SESSION_MARGIN:
            return path
    relay, started = AWS_RELAYS.get(cluster, (None, 0.0))
    if relay is None or relay.done():
        # A relay that failed within the interval is not repeated; awaiting it raises its error again.
        failed = relay is not None and not relay.cancelled() and relay.exception() is not None
        if not failed or time.monotonic() - started >= AWS_RELAY_INTERVAL:
            relay = asyncio.create_task(relay_aws_session(cluster, path, env))
            AWS_RELAYS[cluster] = (relay, time.monotonic())
    # A cancelled waiter (a stopped tunnel or deploy) leaves a running relay to the others.
    await asyncio.shield(relay)
    return path


# The running or last `sky api info` and `sky api login`, and when each started.
SKY_API_INFO: tuple[asyncio.Task[str] | None, float] = (None, 0.0)
SKY_LOGIN: tuple[asyncio.Task[str] | None, float] = (None, 0.0)


async def sky_login_reason(ssh_host: str) -> str | None:
    """SKY_LOGIN_ERROR if ssh_host is an oci@ or aws@ host and Sky's API server answers needs_auth; else None.

    Called after a connection to the host failed. On needs_auth it also starts `sky api login`, which opens
    Sky's login page in this machine's browser, at most once per SKY_LOGIN_INTERVAL.
    """

    global SKY_API_INFO, SKY_LOGIN
    if not ssh_host.startswith(("oci@", "aws@")) or (sky := cluster_cli("sky")) is None:
        return None
    env = ssh_env()
    if SKY_CA_BUNDLE.exists():
        env["SSL_CERT_FILE"] = env["REQUESTS_CA_BUNDLE"] = str(SKY_CA_BUNDLE)
    probe, started = SKY_API_INFO
    if probe is None or time.monotonic() - started >= SKY_API_INFO_INTERVAL:
        probe = asyncio.create_task(cli_output([sky, "api", "info", "-o", "json"], env, timeout=20))
        SKY_API_INFO = (probe, time.monotonic())
    try:
        # A cancelled waiter (a stopped tunnel or deploy) leaves the running probe to the others.
        output = await asyncio.shield(probe)
        # Sky logs warnings to stdout too.
        server = json.loads(output[output.find("{"):])["server"]
        if server["status"] != "needs_auth":
            return None
        url = server["url"]
    except (OSError, ValueError, LookupError, TypeError):
        return None
    login, started = SKY_LOGIN
    if login is None or (login.done() and time.monotonic() - started >= SKY_LOGIN_INTERVAL):
        logger.warning("SkyPilot needs a new login; opening its login page for %s", url)
        login = asyncio.create_task(cli_output([sky, "api", "login", "-e", url], env, timeout=SKY_LOGIN_TIMEOUT))
        login.add_done_callback(sky_login_finished)
        SKY_LOGIN = (login, time.monotonic())
    return SKY_LOGIN_ERROR


def sky_login_finished(login: asyncio.Task[str]) -> None:
    global SKY_API_INFO
    if login.cancelled():
        return
    if login.exception() is not None:
        logger.warning("SkyPilot login did not complete: %s", login.exception())
        return
    logger.info("SkyPilot login completed")
    # The next failed connection asks again instead of reading the cached needs_auth.
    SKY_API_INFO = (None, 0.0)


async def ssh_route(ssh_host: str) -> SSHRoute:
    """Resolve the cluster notations; any other host is a plain ssh destination.

    ``oci@<cluster>``: a Sky-generated alias. Its inner hop needs isolation, and Sky's
    websocket proxy needs Sky's CA bundle, which a launchd-started hub does not inherit.
    ``aws@<cluster>``: a Sky-generated alias whose ProxyCommand opens an AWS SSM session
    with the credentials of an STS session the cluster mints (see aws_session_file).
    ``osmo@<workflow>``: sshd in the workflow's lead task, reached as root with
    ``osmo workflow exec --raw`` as the ProxyCommand.
    """

    env = ssh_env()
    # A Sky connection took 13-14 s end to end when measured; the 10-15 s ConnectTimeout
    # used elsewhere is too short for either proxy. Route options come first, so this wins.
    slow_proxy = ["-o", "ConnectTimeout=30"]
    if ssh_host.startswith("oci@"):
        cluster = ssh_host.removeprefix("oci@")
        if SKY_CA_BUNDLE.exists():
            env["SSL_CERT_FILE"] = env["REQUESTS_CA_BUNDLE"] = str(SKY_CA_BUNDLE)
        options = await isolated_proxy_args(cluster)
        if not options:
            await write_sky_ssh_entry(cluster, env)
            options = await isolated_proxy_args(cluster)
        if not options:
            if (await resolved_proxy_command(cluster)).startswith("aws ssm "):
                raise OSError(f"{cluster} is an AWS cluster; use aws@{cluster}.")
            raise OSError(f"Sky has no ssh entry for {cluster}; check that `sky status -u` lists it as UP.")
        return SSHRoute([*slow_proxy, *options], cluster, env)
    if ssh_host.startswith("aws@"):
        cluster = ssh_host.removeprefix("aws@")
        # For the sky CLI; the aws CLI then trusts this bundle alone, and it holds the public roots too.
        if SKY_CA_BUNDLE.exists():
            env["SSL_CERT_FILE"] = env["REQUESTS_CA_BUNDLE"] = str(SKY_CA_BUNDLE)
        command = await resolved_proxy_command(cluster)
        if not command.startswith("aws ssm "):
            await write_sky_ssh_entry(cluster, env)
            command = await resolved_proxy_command(cluster)
        if not command.startswith("aws ssm "):
            raise OSError(f"Sky has no AWS ssh entry for {cluster}; check that `sky status -u` lists it as UP.")
        credentials = await aws_session_file(cluster, env)
        # The ProxyCommand runs the aws CLI, which runs session-manager-plugin; both install into this PATH.
        env.update(AWS_SHARED_CREDENTIALS_FILE=str(credentials), AWS_PROFILE="agentsdock", PATH=cli_search_path())
        # Keys exported in the environment win over AWS_PROFILE; a shell running an alias's ProxyCommand may have some.
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
            env.pop(name, None)
        return SSHRoute(slow_proxy, cluster, env)
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


# The options Sky writes for a cluster, in its order, as `ssh -G` names them (COPIED_OPTIONS on the desktop).
SSH_ALIAS_OPTIONS = [
    ("hostname", "HostName"), ("user", "User"), ("port", "Port"), ("identityfile", "IdentityFile"),
    ("identitiesonly", "IdentitiesOnly"), ("forwardagent", "ForwardAgent"), ("stricthostkeychecking", "StrictHostKeyChecking"),
    ("userknownhostsfile", "UserKnownHostsFile"), ("globalknownhostsfile", "GlobalKnownHostsFile"), ("setenv", "SetEnv"),
    ("serveraliveinterval", "ServerAliveInterval"), ("proxyjump", "ProxyJump"), ("proxycommand", "ProxyCommand"),
]


async def ssh_alias_content(name: str, ssh_host: str, route: SSHRoute) -> str:
    """The ssh_config block that makes `ssh <name>` take the route the hub's tunnels take."""

    lines = [f"{SSH_ALIAS_MARKER} for the remote server {name} ({ssh_host}). Rewritten when the hub reconnects to it; removed with it.",
             f"Host {name}"]
    if ssh_host.startswith("osmo@"):
        # The route names everything: root in the workflow's lead task, through `osmo workflow exec`.
        user, host = route.destination.split("@", 1)
        lines += [f"  HostName {host}", f"  User {user}"]
        for option in route.options[1::2]:
            key, value = option.split("=", 1)
            # The hub's own connect limit; an interactive login waits for the pod as long as its user does.
            if key != "ConnectTimeout":
                lines.append(f"  {key} {value}")
    else:
        resolved = await resolved_ssh_options(route.destination)
        for key, option in SSH_ALIAS_OPTIONS:
            for value in resolved.get(key, []):
                # ssh -G prints StrictHostKeyChecking as true/false; the config file wants yes/no.
                value = {"true": "yes", "false": "no"}.get(value, value) if key == "stricthostkeychecking" else value
                if value == "none" or (key == "serveraliveinterval" and value == "0"):
                    continue
                if key == "proxycommand" and ssh_host.startswith(("oci@", "aws@")):
                    # Sky's proxy needs the environment the hub's route sets: Sky's CA bundle, and for aws@ the
                    # STS session, relayed again when it nears its end. This file's __main__ sets it up and runs
                    # the command; ssh still expands the command's % tokens.
                    helper = [sys.executable, str(Path(__file__).resolve()), "proxy-command", ssh_host]
                    value = " ".join(shlex.quote(part).replace("%", "%%") for part in helper) + f" {shlex.quote(value)}"
                lines.append(f"  {option} {value}")
    content = "\n".join(lines) + "\n"
    # The Include comes first in ~/.ssh/config, so a block ssh cannot read would stop every ssh on this machine.
    # ssh -G prints values without their quotes, such as a key path with a space.
    with tempfile.TemporaryDirectory(prefix="agentsdock-alias-") as directory:
        check = Path(directory, name)
        check.write_text(content, "utf-8")
        await resolved_ssh_options(name, check)
    return content


def write_ssh_alias(name: str, content: str) -> None:
    """Replace the alias file atomically and add the Include if it is missing.

    Any ssh started meanwhile reads every file the Include matches, so it must never see a partial one.
    """

    SSH_ALIAS_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = SSH_ALIAS_DIR / name
    # A leading dot keeps the temporary file out of the Include's `*`.
    tmp = path.with_name(f".{name}.{secrets.token_hex(4)}.tmp")
    tmp.touch(mode=0o600)
    tmp.write_text(content, "utf-8")
    os.replace(tmp, path)
    # The Include goes first, as SkyPilot's does: an Include after a matching Host block would not apply to
    # it. The same line as the desktop app's (ensureSshConfigInclude), so the two never add it twice.
    home = Path.home()
    alias_dir = f"~/{SSH_ALIAS_DIR.relative_to(home)}" if SSH_ALIAS_DIR.is_relative_to(home) else str(SSH_ALIAS_DIR)
    include = f"Include {alias_dir}/*"
    existing = SSH_CONFIG.read_text("utf-8") if SSH_CONFIG.exists() else ""
    if include not in (line.strip() for line in existing.splitlines()):
        SSH_CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        SSH_CONFIG.write_text(f"{include}\n{existing}", "utf-8")
        SSH_CONFIG.chmod(0o600)


def remove_ssh_alias(name: str) -> None:
    """Remove the alias file if the hub wrote it; a file of that name from anyone else stays."""

    path = SSH_ALIAS_DIR / name
    with suppress(OSError):
        if SSH_ALIAS_RE.fullmatch(name) and path.read_text("utf-8").startswith(SSH_ALIAS_MARKER):
            path.unlink()


def revive_args(ssh_host: str, install_dir: str) -> list[str]:
    # ssh joins its arguments with spaces for the remote shell, so the -c command is quoted
    # as one word: unquoted, `bash -lc` got only "exec" and the server never started.
    # install_dir is validated to [A-Za-z0-9_.~/-], so the inner shell can take it unquoted and expand a leading ~.
    return [*SSH_BATCH_OPTIONS, validate_ssh_host(ssh_host), "bash", "-lc", shlex.quote(f"exec bash {validate_remote_dir(install_dir)}/start.sh")]


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
        start_new_session=True,
    )
    try:
        async with ssh_process_group(proc):
            output, _ = await asyncio.wait_for(proc.communicate(), 120)
    except asyncio.TimeoutError:
        raise RuntimeError("start.sh did not finish within 120s.")
    if proc.returncode != 0:
        raise RuntimeError(last_line(output.decode("utf-8", "replace")) or f"start.sh exited {proc.returncode}")


async def hub_public_key(route: SSHRoute) -> str:
    """This hub's public key for the host: the first identity `ssh -G` resolves with a .pub file, else its ed25519 key (derived or generated)."""

    proc = await asyncio.create_subprocess_exec(
        ssh_binary(), *route.options, "-G", route.destination,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=route.env,
    )
    output, _ = await asyncio.wait_for(proc.communicate(), 30)
    # ssh -G leaves percent tokens (%d, %u, …) of an ssh_config IdentityFile unexpanded.
    identities = [Path(os.path.expanduser(line.split(None, 1)[1].strip()))
                  for line in output.decode("utf-8", "replace").splitlines()
                  if line.startswith("identityfile ") and "%" not in line]
    if not identities:
        raise RuntimeError("ssh resolved no identity file for the host.")
    for identity in identities:
        public = identity.with_name(identity.name + ".pub")
        if public.exists():
            return public.read_text("utf-8").strip()
    identity = next((candidate for candidate in identities if candidate.name == "id_ed25519"), identities[0])
    if identity.exists():
        # A private key without its .pub: derive it rather than let ssh-keygen stop at "Overwrite?".
        keygen = await asyncio.create_subprocess_exec(
            "ssh-keygen", "-y", "-f", str(identity),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        public_key, error = await asyncio.wait_for(keygen.communicate(), 60)
        if keygen.returncode != 0:
            raise RuntimeError(f"ssh-keygen failed: {error.decode('utf-8', 'replace').strip() or keygen.returncode}")
        return public_key.decode("utf-8").strip()
    identity.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    keygen = await asyncio.create_subprocess_exec(
        "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(identity), "-C", "agentsdock-hub",
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, error = await asyncio.wait_for(keygen.communicate(), 60)
    if keygen.returncode != 0:
        raise RuntimeError(f"ssh-keygen failed: {error.decode('utf-8', 'replace').strip() or keygen.returncode}")
    return identity.with_name(identity.name + ".pub").read_text("utf-8").strip()


class SSHConnectionLost(RuntimeError):
    """ssh exited 255: the connection itself failed rather than the remote command."""


def last_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def kill_process_group(proc: asyncio.subprocess.Process) -> None:
    """SIGKILL the process group of an ssh started with start_new_session=True, ssh included if it still runs.

    ssh's ProxyCommand children are in that group. One that outlives ssh, as Sky's websocket proxy
    does after a failed connect, keeps its connection and ssh's output pipes open indefinitely. A group
    id is not reused while any member lives, so this is safe after ssh itself was reaped.
    """
    # macOS answers EPERM, not ESRCH, for a group whose members have all exited but are not reaped yet.
    with suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


# Source of a helper process that SIGKILLs the ssh process groups the hub has not killed once the hub has
# exited; a SIGKILLed hub runs no shutdown. launchd ends only the hub's own process group, and each ssh has
# a session of its own. Lines on stdin: "+pgid" when an ssh starts, "-pgid" once its group is killed, so a
# group id reused later is never killed. End of file on stdin means the hub has exited, however it ended.
GROUP_KILLER_SOURCE = """
import os, signal, sys
groups = set()
for line in sys.stdin:
    if line[0] == "+":
        groups.add(int(line[1:]))
    else:
        groups.discard(int(line[1:]))
for pgid in groups:
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass
"""
_group_killer: subprocess.Popen[bytes] | None = None


def tell_group_killer(line: str) -> None:
    global _group_killer
    # The helper not starting or having exited costs only this safety net, never the caller.
    with suppress(OSError):
        if _group_killer is None:
            # In a session of its own, so launchd's kill of the hub's process group does not reach it.
            _group_killer = subprocess.Popen([sys.executable, "-I", "-c", GROUP_KILLER_SOURCE], stdin=subprocess.PIPE,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            # A stopped helper must not hold up the event loop once the pipe is full.
            os.set_blocking(_group_killer.stdin.fileno(), False)
        os.write(_group_killer.stdin.fileno(), f"{line}\n".encode())


@asynccontextmanager
async def ssh_process_group(proc: asyncio.subprocess.Process) -> AsyncIterator[None]:
    """Kill the process group of a one-shot ssh (started with start_new_session=True) when the block is left,
    and also 5 s after ssh exits if the block is still running then.

    The block reads ssh's output until end of file, and a ProxyCommand child that outlives ssh keeps that
    output open until the block's own timeout; the kill 5 s after the exit ends the read. While the block
    runs, the group is registered with the group killer in case the hub exits.
    """

    async def kill_after_exit() -> None:
        # The exit status, not proc.wait(): wait() also waits for end of file on ssh's pipes, which the child keeps open.
        while proc.returncode is None:
            await asyncio.sleep(1)
        # Let the children exit by themselves first, as Tunnel._supervise does: a killed AWS SSM plugin
        # leaves its session on the host for about 20 minutes.
        await asyncio.sleep(5)
        kill_process_group(proc)

    tell_group_killer(f"+{proc.pid}")
    watcher = asyncio.create_task(kill_after_exit(), name=f"ssh-group:{proc.pid}")
    try:
        yield
    finally:
        watcher.cancel()
        kill_process_group(proc)
        tell_group_killer(f"-{proc.pid}")


class Tunnel:
    """Keeps one ``ssh -N -L`` forward alive with backoff and optional remote revival."""

    def __init__(
        self, server: RemoteServer | SSHForward, revive: Callable[[RemoteServer], Awaitable[None]] | None,
        *, role: Literal["main", "bulk", "stream", "surface"] = "main",
        on_route: Callable[[SSHRoute], Awaitable[None]] | None = None,
    ):
        self.server = server
        self.role = role
        # Awaited with each route resolved before ssh starts; it must not raise.
        self._on_route = on_route
        self.label = server.id if role == "main" else f"{server.id} ({role})"
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
        self._task = asyncio.create_task(self._supervise(), name=f"ssh-tunnel:{self.label}")

    async def _supervise(self) -> None:
        while not self._stopped:
            try:
                route = await ssh_route(self.server.ssh_host)
                if self._on_route is not None:
                    await self._on_route(route)
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
                    # ssh binds its -L port only after the full connect, and a taken port then ends it
                    # (ExitOnForwardFailure). Failing here costs no connection and keeps the tunnel down
                    # (see RemoteServerManager.tunnel_down_on), so no remote's token goes to whoever holds
                    # the port. With SO_REUSEADDR, as ssh binds and unlike local_port_free, connections
                    # left in TIME_WAIT on the port do not make it taken.
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        try:
                            probe.bind(("127.0.0.1", self.server.local_port))
                        except OSError as exc:
                            raise OSError(f"local port {self.server.local_port}: {exc.strerror}") from exc
                    # The main and stream tunnels carry JSON and the surface tunnel mostly web pages,
                    # which ssh compresses well; the bulk tunnel carries file bodies, mostly already compressed.
                    args = tunnel_args(
                        route.destination, self.server.local_port, self.server.remote_port,
                        compress=self.role in ("main", "stream", "surface"),
                    )
                    # Site forwards the cluster's chats need, e.g. a git server that only this
                    # Mac can reach, ride on this long-lived tunnel; never on the short deploy
                    # connections or the other tunnels: sshd binds a remote port for one connection,
                    # a second -R for it fails and ExitOnForwardFailure ends that ssh.
                    self._site_args = (shlex.split(os.environ.get("AGENTSDOCK_OCI_TUNNEL_SSH_ARGS", ""))
                                       if self.role == "main" and self.server.ssh_host.startswith("oci@") else [])
                    options = [*route.options, *self._site_args]
                self._route = route
                proc = await asyncio.create_subprocess_exec(
                    ssh_binary(), *options, *args,
                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE, env=env, start_new_session=True,
                )
            except (OSError, asyncio.TimeoutError) as exc:
                # With Sky's login expired, ssh_route fails as "Sky has no ssh entry for …" or in the aws@ relay.
                reason = f"could not start ssh: {await sky_login_reason(self.server.ssh_host) or exc}"
                # Logged only when the reason changes: a taken port or an ended OSMO workflow fails here on every retry.
                if reason != self.status["last_error"]:
                    logger.warning("ssh tunnel %s %s", self.label, reason)
                self._mark_reconnecting(reason)
                await asyncio.sleep(self._backoff)
                self._backoff = next_backoff(self._backoff)
                continue
            self._proc = proc
            tell_group_killer(f"+{proc.pid}")
            logger.info("ssh tunnel %s started (pid %d)", self.label, proc.pid)
            # The forward is established quickly; a process that survives the
            # connect window counts as connected and resets the backoff.
            settle = (None if isinstance(self.server, SSHForward)
                      else asyncio.get_running_loop().call_later(SETTLE_SECONDS, self._mark_connected, proc))
            tail = ""

            async def read_stderr() -> None:
                nonlocal tail
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

            reader = asyncio.create_task(read_stderr(), name=f"ssh-tunnel-stderr:{self.label}")
            try:
                # Poll the exit status, which is set as soon as ssh exits. stderr's EOF, which proc.wait()
                # also waits for, comes only when every holder of the pipe has exited, and a ProxyCommand
                # child can outlive ssh.
                while proc.returncode is None:
                    await asyncio.sleep(1)
                # Let the ProxyCommand children exit by themselves first: a killed AWS SSM plugin leaves its
                # session on the host for about 20 minutes, and the tunnel's remote port stays taken with it.
                # The wait ends once all of them have closed stderr; Sky's websocket proxy may never exit.
                await asyncio.wait({reader}, timeout=5)
            finally:
                # Also on stop(), whose terminate() reaches ssh but not its ProxyCommand children.
                kill_process_group(proc)
                tell_group_killer(f"-{proc.pid}")
                reader.cancel()
            code = proc.returncode
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
            # An expired Sky login ends an oci@ ssh with "Connection closed by UNKNOWN port 65535", and only after
            # SETTLE_SECONDS, when the tunnel already counted as connected; so Sky is asked on every exit. The
            # tunnel is marked down first: while Sky answers, no request may go to its free local port.
            if self.server.ssh_host.startswith("oci@") and (sky_reason := await sky_login_reason(self.server.ssh_host)):
                self.status = {**self.status, "last_error": sky_reason}
            # Otherwise the same message means the entry still has a previous pod's address: the cluster was relaunched.
            elif "port 65535" in self.status["last_error"]:
                await refresh_sky_ssh_entry(self.server.ssh_host)
            logger.warning("ssh tunnel %s exited; restarting in %.0fs: %s", self.label, self._backoff, self.status["last_error"])
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
            start_new_session=True,
        )
        try:
            async with ssh_process_group(proc):
                _, error = await asyncio.wait_for(proc.communicate(), 120)
        except asyncio.TimeoutError:
            error = b"timed out"
        # None after the timeout: ssh was killed when the block was left and may not be reaped yet. Waiting
        # for it would also wait for its pipes, which a child outside its group can keep open.
        if proc.returncode != 0:
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
    # Update & redeploy all: the hub is restarting, so the client waits for a new server instance.
    restarting: bool = False
    # Clients read new log entries by count, so a log that reaches its cap stops showing progress;
    # update-all collects every remote's lines and gets a larger one.
    log_limit: int = 500

    def progress(self, phase: str, message: str) -> None:
        self.phase = phase
        self.log.append({"phase": phase, "message": message, "at": now_iso()})
        del self.log[:-self.log_limit]

    def view(self, tunnel: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "phase": self.phase,
            "done": self.done,
            "error": self.error,
            "log": list(self.log),
            "server": public_view(self.server, tunnel) if self.server else None,
            "restarting": self.restarting,
        }


@dataclass(kw_only=True)
class ChildDeployJob(DeployJob):
    """One remote's job inside a parent job (update-all, or attaching a hub's remotes): its progress also lands in the parent's log, labelled."""

    parent: DeployJob
    label: str

    def progress(self, phase: str, message: str) -> None:
        super().progress(phase, message)
        self.parent.progress(phase, f"{self.label}: {message}")


class UpdateAllRequest(BaseModel):
    force: bool = False


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
# A chat upload shares the remote's tunnel with every other request and the event
# stream. Measured 2026-10-02 through a Sky websocket proxy: the tunnel moves ~27 KiB/s,
# and ssh queues up to its 2 MiB channel window ahead of the next request, so one upload
# held every other request past the desktop's 30 s deadline. Bulk transfers therefore get
# a tunnel of their own; they stay slow, the rest of the chat no longer waits on them.
# A GET whose response is a file body (attachment, diff, workspace file, export) fills the
# connection the same way on the way back, so it takes the bulk tunnel too; one extra ssh
# connection per remote serves both directions. JSON routes beside them stay on the main tunnel.
UPLOAD_PATH_RE = re.compile(r"api/sessions/[^/]+/files")
DOWNLOAD_PATH_RE = re.compile(
    r"api/sessions/[^/]+/(files/[^/]+|links/file|diffs/[^/]+|workspace/(preview|download)|export)"
    r"|api/files/[^/]+"
)
# The live event streams (a chat's timeline, the sidebar summaries, emergency alerts) take the
# stream tunnel. Terminals stay on the main one.
STREAM_PATH_RE = re.compile(r"api/sessions/[^/]+/events|api/session-summaries/events|api/emergency-alerts/events")
# Browser-surface port tunnels (dashboards, web apps) take the surface tunnel; see _ensure_tunnel.
PORT_TUNNEL_PATH_RE = re.compile(r"api/sessions/[^/]+/ports/\d+/tunnel/ws")


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
        ssh_aliases: bool = False,
        own_identity: Callable[[], str] = lambda: "",
    ) -> None:
        self.path = state_dir / "remote-servers.json"
        self.forward_path = state_dir / "ssh-forwards.json"
        self.source_dir = source_dir
        self.manage_tunnels = manage_tunnels
        self._revive = revive
        # The ssh host a deploy is bootstrapping: it stops and restarts that server itself. The host alone, since an
        # entry update() moved still names the default directory until the deploy finishes.
        self._bootstrapping: str | None = None
        # This hub's own server identity: a hub it attaches may list this hub among its remotes.
        self.own_identity = own_identity
        # Keep an ssh alias per remote in SSH_ALIAS_DIR (see _keep_ssh_alias).
        self.ssh_aliases = ssh_aliases
        self.servers: dict[str, RemoteServer] = {}
        self.tunnels: dict[str, Tunnel] = {}
        self.bulk_tunnels: dict[str, Tunnel] = {}
        self.stream_tunnels: dict[str, Tunnel] = {}
        self.surface_tunnels: dict[str, Tunnel] = {}
        self.forwards: dict[str, SSHForward] = {}
        self.forward_tunnels: dict[str, Tunnel] = {}
        self.jobs: dict[str, DeployJob] = {}
        # keepalive_expiry must stay well below the remote uvicorn's idle keep-alive
        # (75 s, agent_server.main) plus the forward's delay: the remote starts its
        # idle timer when it sends a response, this one when the response arrives.
        # Otherwise a request reuses a connection the remote has already closed and
        # fails with "Server disconnected without sending a response".
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0),
            limits=httpx.Limits(keepalive_expiry=2.0),
            trust_env=False,
            event_hooks={"request": [self._refuse_down_tunnel]},
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
        await asyncio.gather(*(tunnel.stop() for tunnel in [*self.tunnels.values(), *self.bulk_tunnels.values(), *self.stream_tunnels.values(),
                                                              *self.surface_tunnels.values(), *self.forward_tunnels.values()]),
                             return_exceptions=True)
        self.tunnels.clear()
        self.bulk_tunnels.clear()
        self.stream_tunnels.clear()
        self.surface_tunnels.clear()
        self.forward_tunnels.clear()
        await self.http.aclose()

    def _reserved_ports(self) -> set[int]:
        return ({server.local_port for server in self.servers.values()}
                | {tunnel.server.local_port for tunnel in [*self.bulk_tunnels.values(), *self.stream_tunnels.values(),
                                                           *self.surface_tunnels.values()]}
                | {forward.local_port for forward in self.forwards.values()})

    def _ensure_tunnel(self, server: RemoteServer) -> None:
        if not self.manage_tunnels:
            return
        current = self.tunnels.get(server.id)
        if current is not None and current.server == server:
            return
        for stale in (current, self.bulk_tunnels.pop(server.id, None), self.stream_tunnels.pop(server.id, None),
                      self.surface_tunnels.pop(server.id, None)):
            if stale is not None:
                asyncio.create_task(stale.stop())
        on_route = (lambda route, remote_id=server.id: self._keep_ssh_alias(remote_id, route)) if self.ssh_aliases else None
        tunnel = Tunnel(server, self._revive_unless_bootstrapping, on_route=on_route)
        self.tunnels[server.id] = tunnel
        logger.info("ssh tunnel starting for %s (%s, local %d -> remote %d)", server.id, server.ssh_host, server.local_port, server.remote_port)
        tunnel.start()
        # The bulk tunnel's port is private to this hub process (only the proxy routes to
        # it), so it is not in the registry. The main tunnel already revives the remote.
        bulk = Tunnel(server.model_copy(update={"local_port": find_free_local_port(self._reserved_ports())}), None, role="bulk")
        self.bulk_tunnels[server.id] = bulk
        logger.info("ssh tunnel starting for %s (%s, local %d -> remote %d)", bulk.label, server.ssh_host, bulk.server.local_port, server.remote_port)
        bulk.start()
        # The chat event streams get a connection of their own too, so a large JSON page or a
        # burst of requests queued on the main connection no longer stalls the live timeline.
        stream = Tunnel(server.model_copy(update={"local_port": find_free_local_port(self._reserved_ports())}), None, role="stream")
        self.stream_tunnels[server.id] = stream
        logger.info("ssh tunnel starting for %s (%s, local %d -> remote %d)", stream.label, server.ssh_host, stream.server.local_port, server.remote_port)
        stream.start()
        # Browser-surface port tunnels get a connection of their own: a dashboard pulls megabytes
        # at once, and ssh lets 2 MB per channel queue ahead of everything else on its connection.
        # Through `osmo workflow exec --raw` the OSMO router closes a connection whose keepalive pong
        # waits 20 s behind such a queue. Measured 2026-10-11 under four dashboard pulls: the loaded
        # connection's ping round trip reached 23.7 s while a sibling connection stayed at 1.1 s.
        surface = Tunnel(server.model_copy(update={"local_port": find_free_local_port(self._reserved_ports())}), None, role="surface")
        self.surface_tunnels[server.id] = surface
        logger.info("ssh tunnel starting for %s (%s, local %d -> remote %d)", surface.label, server.ssh_host, surface.server.local_port, server.remote_port)
        surface.start()

    async def _keep_ssh_alias(self, remote_id: str, route: SSHRoute) -> None:
        """Point `ssh <name>` at the route the remote's main tunnel resolved; a failure leaves the tunnel alone."""
        server = self.servers.get(remote_id)
        if server is None:
            return
        # A Host block named like a host the hub dials would take over the hub's own connections to it (its
        # `ssh -G` and tunnels read the alias first); `ssh <name>` reaches such a host as it is anyway.
        dialed = {entry.ssh_host.split("@")[-1] for entry in [*self.servers.values(), *self.forwards.values()]}
        if server.name in dialed:
            remove_ssh_alias(server.name)
            return
        # Two remotes of one name would take turns in one file.
        if not SSH_ALIAS_RE.fullmatch(server.name) or sum(other.name == server.name for other in self.servers.values()) > 1:
            logger.info("no ssh alias for remote %s: the name is not a host alias, or another remote has it too", server.name)
            return
        with suppress(OSError):
            first_line = (SSH_ALIAS_DIR / server.name).read_text("utf-8").partition("\n")[0]
            # Another server's file of this name stays. The desktop app's first line names its server's SSH host
            # (electron/src/main/ssh-hosts.ts); the hub replaces such a file for the same remote.
            if not first_line.startswith(SSH_ALIAS_MARKER) and f"(SSH host {server.ssh_host})" not in first_line:
                logger.info("no ssh alias for remote %s: %s belongs to another server", server.name, SSH_ALIAS_DIR / server.name)
                return
        try:
            content = await ssh_alias_content(server.name, server.ssh_host, route)
            # Renamed or removed meanwhile: the newer entry writes its own.
            if self.servers.get(remote_id) is server:
                write_ssh_alias(server.name, content)
        except Exception as exc:  # noqa: BLE001 - the tunnel awaits this; an alias must never stop it
            logger.warning("ssh alias for %s not written: %s", server.name, exc)

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

    def tunnel_status(self, remote_id: str, *, bulk: bool = False) -> dict[str, Any] | None:
        tunnel = (self.bulk_tunnels if bulk else self.tunnels).get(remote_id)
        return dict(tunnel.status) if tunnel else None

    def tunnel_down_on(self, port: int | None) -> Tunnel | None:
        """The tunnel on this local port from its ssh's exit or failed start until the next ssh starts.

        No ssh holds the port then, so a listener there is another process: no request carrying a
        remote's token may go to it.
        """
        # Not the SSH forwards: no remote's token goes to them.
        tunnels = [*self.tunnels.values(), *self.bulk_tunnels.values(), *self.stream_tunnels.values(), *self.surface_tunnels.values()]
        return next((tunnel for tunnel in tunnels if tunnel.server.local_port == port and (
            # An exited ssh stays in _proc while its ProxyCommand children get time to exit by themselves.
            tunnel._proc.returncode is not None if tunnel._proc is not None else tunnel.status["state"] == "reconnecting")), None)

    async def _refuse_down_tunnel(self, request: httpx.Request) -> None:
        # Every user of this client (the proxy, health probes, CLI updates, the cross-server mail relay)
        # sends a remote's token to a tunnel port, so the check sits here and not at each call site;
        # each already treats ConnectError as the remote being unreachable.
        if (tunnel := self.tunnel_down_on(request.url.port)) is not None:
            raise httpx.ConnectError(f"ssh tunnel {tunnel.label} is down: {tunnel.status['last_error']}", request=request)

    def bulk_port(self, server: RemoteServer) -> int:
        tunnel = self.bulk_tunnels.get(server.id)
        # Without a managed bulk tunnel (manage_tunnels=False, tests) the registered port serves everything.
        return tunnel.server.local_port if tunnel is not None else server.local_port

    def stream_port(self, server: RemoteServer) -> int:
        tunnel = self.stream_tunnels.get(server.id)
        return tunnel.server.local_port if tunnel is not None else server.local_port

    def surface_port(self, server: RemoteServer) -> int:
        tunnel = self.surface_tunnels.get(server.id)
        return tunnel.server.local_port if tunnel is not None else server.local_port

    def get(self, remote_id: str) -> RemoteServer | None:
        return self.servers.get(remote_id)

    def list(self) -> list[dict[str, Any]]:
        return [public_view(server, self.tunnel_status(server.id)) for server in self.servers.values()]

    def _save(self) -> None:
        save_registry(self.path, list(self.servers.values()))

    async def _revive_unless_bootstrapping(self, server: RemoteServer) -> None:
        # A request during a redeploy finds no server and asks for a revive; its start.sh beside the bootstrap's
        # could restart the server mid-install or end the bootstrap's start.sh with a tmux error.
        if self._bootstrapping == server.ssh_host:
            raise RuntimeError("its deployment is restarting it")
        await self._revive(server)

    def _unshadow(self, ssh_host: str) -> None:
        """Remove the hub's alias named like a host the hub is about to dial (see _keep_ssh_alias)."""
        if self.ssh_aliases:
            remove_ssh_alias(ssh_host.split("@")[-1])

    async def add(self, request: RemoteServerCreate) -> RemoteServer:
        self._unshadow(request.ssh_host)
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
        for tunnel in (self.tunnels.pop(remote_id, None), self.bulk_tunnels.pop(remote_id, None), self.stream_tunnels.pop(remote_id, None),
                       self.surface_tunnels.pop(remote_id, None)):
            if tunnel is not None:
                await tunnel.stop()
        self._save()
        if self.ssh_aliases and all(other.name != server.name for other in self.servers.values()):
            remove_ssh_alias(server.name)

    def reorder(self, ids: list[str]) -> None:
        """The listed servers take this order. A client lists what it has synced so far: servers it does not
        know yet keep their relative order after those, and ids it still holds for removed ones are skipped."""
        ordered = [remote_id for remote_id in ids if remote_id in self.servers]
        ordered += [remote_id for remote_id in self.servers if remote_id not in ordered]
        self.servers = {remote_id: self.servers[remote_id] for remote_id in ordered}
        self._save()

    def update(self, remote_id: str, request: RemoteServerUpdate) -> tuple[RemoteServer, DeployJob | None]:
        """A new host or install dir redeploys there. Chats belong to their machine: a new host
        gets its target's fresh install unless install_dir is given. The previous server keeps
        running and keeps its chats."""
        server = self.servers.get(remote_id)
        if server is None:
            raise HTTPException(status_code=404, detail="Unknown remote server.")
        changes = {key: value for key, value in request.model_dump(exclude_none=True).items() if getattr(server, key) != value}
        if changes.keys() == {"hidden"}:
            # Only what clients list changes. The entry stays the same object, so the mail relay keeps its end
            # for it: cross_server_mail.Relay.refresh drops and probes again an entry that was replaced.
            server.hidden = changes["hidden"]
            self._save()
            return server, None
        if "ssh_host" in changes and request.install_dir is None:
            if changes["ssh_host"].startswith("osmo@"):
                # The workflow's home can depend on its pool, which only the deploy's osmo workflow query records.
                changes["install_dir"] = DEFAULT_INSTALL_DIR
            else:
                try:
                    changes["install_dir"] = default_install_dir(changes["ssh_host"])
                except ValueError as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from None
        previous_name = server.name
        server = server.model_copy(update=changes)
        moved = "ssh_host" in changes or "install_dir" in changes
        # load-bearing order: start_deploy raises (409 busy, 503 no ssh) before the registry
        # changes, and its task reads the entry only after this synchronous method returns.
        job = self.start_deploy(None, redeploy_id=remote_id, keep_port=False) if moved else None
        self.servers[remote_id] = server
        self._save()
        if "name" in changes and self.ssh_aliases and all(other.name != previous_name for other in self.servers.values()):
            remove_ssh_alias(previous_name)
        if moved:
            self._ensure_tunnel(server)
        elif remote_id in self.tunnels:
            # A rename keeps the live forward; restarting it would drop every connection through it.
            self.tunnels[remote_id].server = server
            # So the alias takes the new name from the route that forward resolved.
            if "name" in changes and self.ssh_aliases and (route := self.tunnels[remote_id]._route) is not None:
                asyncio.create_task(self._keep_ssh_alias(remote_id, route))
        return server, job

    async def probe_health(self, server: RemoteServer) -> dict[str, Any] | None:
        try:
            response = await self.http.get(
                f"http://127.0.0.1:{server.local_port}/api/health",
                headers={"X-AgentsDock-Token": server.token}, timeout=HEALTH_REQUEST_TIMEOUT,
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

    def start_deploy(self, request: RemoteDeployRequest | RemoteAttachRequest | None, *, redeploy_id: str | None = None,
                     keep_port: bool = True) -> DeployJob:
        if any(job.task is not None and not job.task.done() for job in self.jobs.values()):
            raise HTTPException(status_code=409, detail="Another remote deployment is already running.")
        if redeploy_id is not None and redeploy_id not in self.servers:
            raise HTTPException(status_code=404, detail="Unknown remote server.")
        if redeploy_id is None and isinstance(request, RemoteDeployRequest):
            # A deploy naming a host and directory that already hold a registered server
            # is that server's update: keep its id (clients address it as /api/remote/<id>)
            # instead of registering a second entry and retiring the first.
            install_dir = default_install_dir(request.ssh_host) if request.install_dir == DEFAULT_INSTALL_DIR else request.install_dir
            same_install = [server for server in self.servers.values()
                            if server.ssh_host == request.ssh_host and server.install_dir == install_dir]
            if same_install:
                redeploy_id = same_install[0].id
        if not shutil.which("ssh") and not Path(ssh_binary()).exists():
            raise HTTPException(status_code=503, detail="ssh is not installed on this server.")
        job = DeployJob(job_id=secrets.token_hex(8))
        self.jobs[job.job_id] = job
        del_ids = [job_id for job_id, old in list(self.jobs.items()) if old.done][:-20]
        for job_id in del_ids:
            self.jobs.pop(job_id, None)
        job.task = asyncio.create_task(self._deploy(job, request, redeploy_id, keep_port), name=f"remote-deploy:{job.job_id}")
        return job

    def job(self, job_id: str) -> DeployJob | None:
        return self.jobs.get(job_id)

    # -- update all -----------------------------------------------------------

    async def servers_with_running_chats(self, hub_running_count: int) -> list[dict[str, Any]]:
        """Servers an update-all would interrupt: the hub and every remote it redeploys, with their running chat counts (None: unreachable).

        The remotes are probed at once: a frozen remote holds its probe for HEALTH_REQUEST_TIMEOUT, and
        the client's request has its own 30 s limit."""
        running: list[dict[str, Any]] = [{"id": None, "running": hub_running_count}] if hub_running_count else []
        redeployed = [server for server in self.servers.values() if not server.attached]
        for server, health in zip(redeployed, await asyncio.gather(*(self.probe_health(server) for server in redeployed))):
            count = len(health.get("active") or []) if health is not None else None
            if count != 0:
                running.append({"id": server.id, "name": server.name, "running": count})
        return running

    def start_update_all(self, *, hub_update_cli: Callable[[str], Awaitable[tuple[str, bool]]],
                         hub_restart: Callable[[], Awaitable[str | None]]) -> DeployJob:
        """One job: redeploy each remote and update its CLIs, update the hub's CLIs, then restart the hub.

        The hub restarts last because this job runs inside it; the client sees the job finish, then
        waits for a new server instance. `hub_update_cli(backend)` returns the version the update left
        installed ("" if unknown) and whether it installed a missing CLI; `hub_restart()` returns an error
        message when this process cannot restart itself.
        """
        if any(job.task is not None and not job.task.done() for job in self.jobs.values()):
            raise HTTPException(status_code=409, detail="A deployment or update is already running.")
        job = DeployJob(job_id=secrets.token_hex(8), log_limit=5000)
        self.jobs[job.job_id] = job
        job.task = asyncio.create_task(self._update_all(job, hub_update_cli, hub_restart), name=f"remote-update-all:{job.job_id}")
        return job

    async def update_cli(self, server: RemoteServer, backend: str) -> tuple[str, bool]:
        """Run the CLI update on a remote through its tunnel (the remote installs a missing CLI); returns the version it reports ("" if none) and whether it installed."""
        response = await self.http.post(
            f"http://127.0.0.1:{server.local_port}/api/admin/runtimes/{backend}/update",
            headers={"X-AgentsDock-Token": server.token}, timeout=CLI_UPDATE_REQUEST_TIMEOUT,
        )
        if response.status_code != 200:
            detail = ""
            with suppress(ValueError):
                detail = str((response.json() or {}).get("detail") or "")
            raise RuntimeError(detail or f"HTTP {response.status_code}")
        result = response.json()
        # load-bearing: .get - an attached or not-yet-redeployed remote runs a server that sends no "action".
        return str((result.get("diagnostic") or {}).get("version") or ""), result.get("action") == "install"

    async def _update_all(self, job: DeployJob, hub_update_cli: Callable[[str], Awaitable[tuple[str, bool]]],
                          hub_restart: Callable[[], Awaitable[str | None]]) -> None:
        failures: list[str] = []

        async def update_clis(label: str, run: Callable[[str], Awaitable[tuple[str, bool]]]) -> None:
            for backend, product in CLI_PRODUCT_NAMES.items():
                # The hub learns that a CLI was missing only from the server's answer, so this line says "updating"
                # and the result line says "installed".
                job.progress("cli", f"{label}: updating {product}…")
                try:
                    version, installed = await run(backend)
                    if installed:
                        job.progress("cli", f"{label}: installed {product} {version}".rstrip())
                    else:
                        job.progress("cli", f"{label}: {product} {version or 'updated'}")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - the job view carries the message
                    detail = str(getattr(exc, "detail", None) or exc or exc.__class__.__name__)
                    failures.append(f"{label}: {product}: {detail}")
                    job.progress("cli", f"{label}: {product}: {detail}")

        try:
            for server in list(self.servers.values()):
                if server.attached:
                    job.progress("redeploy", f"{server.name}: attached from another hub, not redeployed.")
                else:
                    child = ChildDeployJob(job_id=f"{job.job_id}:{server.id}", parent=job, label=server.name)
                    await self._deploy(child, None, server.id)
                    # _deploy swallows its own cancellation; a cancelled update-all must not go on to the next server.
                    task = asyncio.current_task()
                    if task is not None and task.cancelling():
                        raise asyncio.CancelledError
                    if child.error:
                        failures.append(f"{server.name}: {child.error}")
                await update_clis(server.name, lambda backend, server=server: self.update_cli(server, backend))
            await update_clis("hub", hub_update_cli)
            job.progress("restart", "Restarting the hub…")
            restart_error = await hub_restart()
            if restart_error:
                failures.append(f"hub: {restart_error}")
                job.progress("restart", restart_error)
            else:
                job.restarting = True
            if failures:
                job.error = "; ".join(failures)
        except asyncio.CancelledError:
            job.error = "Update cancelled."
            job.progress(job.phase, job.error)
        except Exception as exc:  # noqa: BLE001 - the job view carries the message
            job.error = str(exc) or exc.__class__.__name__
            job.progress(job.phase, job.error)
            logger.warning("update-all %s failed: %s", job.job_id, job.error)
        finally:
            job.done = True

    def cancel_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.task is None or job.task.done():
            return False
        job.task.cancel()
        return True

    async def _deploy(self, job: DeployJob, request: RemoteDeployRequest | RemoteAttachRequest | None, redeploy_id: str | None,
                      keep_port: bool = True) -> None:
        ssh_host = ""  # the except reads it; the lookups below can raise first, and "" names no Sky host
        try:
            existing = self.servers[redeploy_id] if redeploy_id else None
            attach = isinstance(request, RemoteAttachRequest)
            if existing is not None:
                # A moved server takes its new install's own port or a free one: the bootstrap stops
                # whatever serves the port it is given, which may be the previous install's server.
                ssh_host, install_dir = existing.ssh_host, existing.install_dir
                requested_port = existing.remote_port if keep_port else 0
            else:
                assert request is not None
                ssh_host, install_dir = request.ssh_host, request.install_dir
                requested_port = request.port if isinstance(request, RemoteDeployRequest) else 0

            if request is not None and request.password and ssh_host.startswith(("oci@", "aws@", "osmo@")):
                raise RuntimeError("oci@, aws@ and osmo@ targets are reached through the cluster CLI; leave the password empty.")
            self._unshadow(ssh_host)
            job.progress("connect", f"Probing {ssh_host}…")
            # A relaunched cluster keeps its name but not its address; its old ssh entry would fail the deploy.
            await refresh_sky_ssh_entry(ssh_host)
            route = await ssh_route(ssh_host)
            # After the route, whose osmo workflow query records the pool an osmo@ home can depend on. Only a new
            # deploy and an entry update() moved arrive with the default; a Redeploy keeps the entry's directory.
            from_default = install_dir == DEFAULT_INSTALL_DIR and (existing is None or not keep_port)
            if from_default:
                install_dir = default_install_dir(ssh_host)
            # The directory the target's install went to before AGENTSDOCK_OSMO_POOL_HOMES named its pool
            # (install_dir when there is no other). Without AGENTSDOCK_OSMO_HOME that would be the shared
            # ~/.agentsdock-server, which names no target and may hold another workflow's install.
            earlier_dir = (default_install_dir(ssh_host, by_pool=False)
                           if from_default and not attach and cluster_home(ssh_host, by_pool=False) else install_dir)
            if existing is not None and any(other.id != existing.id and other.ssh_host == ssh_host and other.install_dir == earlier_dir
                                            for other in self.servers.values()):
                # Another entry owns that install: a moved entry taking it too would list one server twice.
                earlier_dir = install_dir
            if request is not None and request.password:
                job.progress("connect", f"Installing this hub's SSH key on {ssh_host} with the password…")
                await self._install_key(job, route, request.password)
            # An attach that keeps the default directory also finds a machine's own install.sh server. A deploy
            # into a pool home also finds the target's earlier install, which holds its chats; as the second
            # directory, the probe takes it only when the pool home has no install.
            probe_dirs = [install_dir, INSTALL_SH_CONFIG_DIR] if attach and request.install_dir == DEFAULT_INSTALL_DIR else [install_dir]
            if earlier_dir != install_dir:
                probe_dirs.append(earlier_dir)
            probe_lines = await self._run_ssh(job, route, [*remote_shell_args(route.destination), *probe_dirs], stdin=PROBE_SCRIPT.read_bytes(), idle_timeout=60)
            probe = parse_probe(probe_lines)
            home = cluster_home(ssh_host)
            if earlier_dir != install_dir and probe["install_dir"] != install_dir:
                # Upgraded in place as a Redeploy of that directory would be: it keeps its port, its token
                # and the home it was installed with. A requested port would start a second server on its state.
                install_dir, home = probe["install_dir"], cluster_home(ssh_host, by_pool=False)
                requested_port = 0
                job.progress("connect", f"Found an existing install at {install_dir}; deploying there to keep its chats.")
            if from_default and existing is None and not attach:
                # start_deploy looked for this install before the pool was known: a registered one is updated.
                existing = next((server for server in self.servers.values()
                                 if server.ssh_host == ssh_host and server.install_dir == install_dir), None)
                if existing is not None:
                    requested_port = existing.remote_port
            # The probe takes the install's parent as HOME only once it holds a Claude or Codex
            # login. A fresh cluster home has none yet; the container's own ~ (often /root) would
            # then receive the CLIs and logins, and the next container drops them.
            if home and install_dir.rpartition("/")[0] == home:
                probe["home"] = home
            if attach and not (probe.get("existing_port") and probe.get("existing_token")):
                raise RuntimeError(f"No AgentsServer install was found at {install_dir} on {ssh_host}. Deploy a new server instead.")
            if attach and existing is None:
                # Attaching an install registered here already (a hub attached again to pick up the
                # remotes it added since) refreshes that entry instead of listing the server twice.
                existing = next((server for server in self.servers.values()
                                 if server.ssh_host == ssh_host and server.install_dir == probe["install_dir"]), None)
            remote_port = requested_port or probe.get("existing_port") or probe["free_port"]
            job.progress("connect", f"Host: {probe.get('os')} {probe.get('arch')}, uid {probe.get('uid')}, home {probe['home']}; remote port {remote_port}.")

            if attach:
                # An attach reads the install's port and token and changes nothing on the host: whoever
                # installed it (another hub, or install.sh on that machine) keeps its updates, its Claude
                # token and its restarts. The tunnel's revive runs <install_dir>/start.sh, which only a
                # hub-deployed install has; launchd restarts an install.sh server.
                result = {"remote_port": probe["existing_port"], "install_dir": probe["install_dir"], "access_token": probe["existing_token"]}
            else:
                if not probe.get("tmux"):
                    job.progress("connect", "tmux is not installed on the host; setup will try to install it.")
                job.progress("download", f"Uploading AgentsServer source to {ssh_host}…")
                tarball = await asyncio.to_thread(build_source_tarball, self.source_dir)
                await self._upload(job, route, install_dir, tarball)
                job.progress("install", f"Installing AgentsServer on {ssh_host}…")
                args = [*remote_shell_args(route.destination), install_dir, str(remote_port), probe["home"]]
                if existing is not None:
                    args.append("restart")
                # The hub's own long-lived Claude token (`claude setup-token`) rides at the head of the
                # script on stdin: never in argv, ps output or the job log.
                token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
                prelude = f"AGENTSDOCK_CLAUDE_TOKEN={shlex.quote(token)}\n".encode() if token else b""
                self._bootstrapping = ssh_host
                try:
                    result_lines = await self._run_ssh(
                        job, route, args, stdin=prelude + BOOTSTRAP_SCRIPT.read_bytes(), idle_timeout=180,
                        on_line=lambda line: job.progress("install", setup_log_message(line) or "") if setup_log_message(line) else None,
                    )
                finally:
                    self._bootstrapping = None
                result = parse_setup_result(result_lines)

            job.progress("service", "Opening the SSH tunnel…")
            if existing is not None:
                # The registry entry as it is now: a rename (or removal) may have happened while this ran.
                server = self.servers.get(existing.id)
                if server is None:
                    raise RuntimeError("The remote server was removed during the deployment.")
                # A deploy over an attached entry (a move) installs this hub's own server there; an attach keeps the entry's owner.
                if (server.attached and not attach) or server.remote_port != result["remote_port"] or server.install_dir != result["install_dir"] or server.token != result["access_token"]:
                    server = server.model_copy(update={"remote_port": result["remote_port"], "install_dir": result["install_dir"], "token": result["access_token"],
                                                       "attached": attach and server.attached})
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
                    attached=attach,
                )
                self.servers[server.id] = server
                self._save()
                self._ensure_tunnel(server)

            job.progress("health", "Waiting for the server behind the tunnel…")
            health = await self._wait_health(server)
            job.server = server
            failures = await self._attach_hub_remotes(job, server) if attach and not isinstance(job, ChildDeployJob) else []
            job.progress("complete", f"AgentsServer {health.get('version') or ''} is reachable through the hub.".replace("  ", " "))
            if failures:
                # After the "complete" line, so a failure is not the step shown as done.
                job.progress("connect", f"Not attached: {'; '.join(failures)}")
        except asyncio.CancelledError:
            job.error = "Deployment cancelled."
            job.progress(job.phase, job.error)
        except Exception as exc:  # noqa: BLE001 - the job view carries the message
            job.error = str(exc) or exc.__class__.__name__
            # Set first: a cancellation during the Sky check still leaves the job its error.
            job.error = await sky_login_reason(ssh_host) or job.error
            job.progress(job.phase, job.error)
            logger.warning("remote deployment %s failed: %s", job.job_id, job.error)
        finally:
            job.done = True
            if job.proc is not None and job.proc.returncode is None:
                with suppress(ProcessLookupError):
                    job.proc.kill()
            job.proc = None

    async def _attach_hub_remotes(self, job: DeployJob, hub: RemoteServer) -> list[str]:
        """Attach every remote the attached hub lists, so this hub reaches each one directly; returns the failures.

        Skipped: a remote whose server identity is registered here already (this hub's own server
        included), or whose host and directory are. Attaching the hub again picks up remotes it added since.
        """
        headers = {"X-AgentsDock-Token": hub.token}
        try:
            response = await self.http.get(f"http://127.0.0.1:{hub.local_port}{ADMIN_PATH}", headers=headers, timeout=HEALTH_REQUEST_TIMEOUT)
            response.raise_for_status()
            hub_remotes = response.json()["servers"]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            return [f"the servers {hub.name} manages could not be read: {exc or exc.__class__.__name__}"]
        if not hub_remotes:
            return []

        # Each remote's identity as the other hub reaches it: a remote known here needs no ssh, and the
        # host name, resolved by this Mac's own ssh config, must reach the same server.
        async def identity_through_hub(remote: dict[str, Any]) -> str | None:
            with suppress(httpx.HTTPError, ValueError, AttributeError):
                response = await self.http.get(f"http://127.0.0.1:{hub.local_port}{PROXY_PREFIX}/{remote['id']}/api/health",
                                               headers=headers, timeout=HEALTH_REQUEST_TIMEOUT)
                if response.status_code == 200:
                    return response.json().get("server_identity")
            return None

        registered, expected = await asyncio.gather(
            asyncio.gather(*(self.probe_health(server) for server in self.servers.values())),
            asyncio.gather(*(identity_through_hub(remote) for remote in hub_remotes)),
        )
        known_identities = {self.own_identity(), *((health or {}).get("server_identity") for health in registered)} - {None, ""}
        job.progress("connect", f"{hub.name} is a hub; attaching the servers it manages…")
        failures: list[str] = []
        for remote, identity in zip(hub_remotes, expected):
            name = str(remote.get("name") or remote.get("ssh_host"))
            try:
                if identity in known_identities or any(server.ssh_host == remote.get("ssh_host") and server.install_dir == remote.get("install_dir")
                                                       for server in self.servers.values()):
                    job.progress("connect", f"{name}: already registered on this hub.")
                    continue
                request = RemoteAttachRequest(ssh_host=remote.get("ssh_host"), install_dir=remote.get("install_dir"), name=name)
                child = ChildDeployJob(job_id=f"{job.job_id}:{remote.get('id')}", parent=job, label=name)
                registered_ids = set(self.servers)
                await self._deploy(child, request, None)
                # _deploy swallows its own cancellation; a cancelled attach must not go on to the next server.
                task = asyncio.current_task()
                if task is not None and task.cancelling():
                    raise asyncio.CancelledError
                if child.error or child.server is None:
                    failures.append(f"{name}: {child.error}")
                    continue
                if child.server.id in registered_ids:
                    # The probe found an install registered here under another spelling of its directory.
                    job.progress("connect", f"{name}: already registered on this hub.")
                    continue
                # The identity is readable only through the new entry's tunnel, so these entries are attached first.
                reached = ((await self.probe_health(child.server)) or {}).get("server_identity")
                if reached is not None and reached in known_identities:
                    await self.remove(child.server.id)
                    job.progress("connect", f"{name}: already registered on this hub.")
                    continue
                if reached is not None and identity not in (None, reached):
                    await self.remove(child.server.id)
                    failures.append(f"{name}: {request.ssh_host} reaches another server from this hub")
                    continue
                known_identities |= {reached or identity} - {None}
                if remote.get("hidden"):
                    self.update(child.server.id, RemoteServerUpdate(hidden=True))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one remote's failure must not fail the attach of the hub
                failures.append(f"{name}: {getattr(exc, 'detail', None) or exc or exc.__class__.__name__}")
        return failures

    async def _install_key(self, job: DeployJob, route: SSHRoute, password: str) -> None:
        """Append this hub's public key to the host's authorized_keys, authenticating once with the password.

        Every other ssh here (probe, upload, bootstrap, the tunnels) runs with BatchMode and
        needs key authentication. The password reaches ssh through an SSH_ASKPASS helper that
        reads a 0600 file in a private temporary directory, never argv or the job log.
        """
        public_key = await hub_public_key(route)
        with tempfile.TemporaryDirectory(prefix="agentsdock-askpass-") as directory:
            password_file = Path(directory, "password")
            password_file.write_text(password + "\n", "utf-8")
            password_file.chmod(0o600)
            askpass = Path(directory, "askpass.sh")
            askpass.write_text(f"#!/bin/sh\ncat {shlex.quote(str(password_file))}\n", "utf-8")
            askpass.chmod(0o700)
            # Without a tty, ssh (8.4+) consults SSH_ASKPASS only when forced.
            env = {**route.env, "SSH_ASKPASS": str(askpass), "SSH_ASKPASS_REQUIRE": "force"}
            # One quoted argument: ssh joins its arguments with spaces for the remote shell.
            command = shlex.quote("umask 077 && mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys")
            try:
                await self._run_ssh(
                    job, replace(route, env=env),
                    # The command line wins over the user's ssh_config: no BatchMode, password and
                    # keyboard-interactive on, one prompt per method so a wrong password is not retried.
                    ["-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", *NO_MULTIPLEX, "-o", "BatchMode=no",
                     "-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=yes", "-o", "KbdInteractiveAuthentication=yes",
                     "-o", "NumberOfPasswordPrompts=1", route.destination, command],
                    # The leading blank line keeps the key off an unterminated last line; sshd skips blank lines.
                    stdin=b"\n" + public_key.encode("utf-8") + b"\n", idle_timeout=60,
                )
            except SSHConnectionLost as exc:
                detail = str(exc)
                if detail.endswith("(publickey)."):
                    raise RuntimeError(f"{route.destination} does not accept passwords; install a key there by hand.") from None
                if "Permission denied" in detail:
                    raise RuntimeError(f"{route.destination} did not accept the password.") from None
                raise RuntimeError(f"Could not install the SSH key on {route.destination}: {detail}") from None
        job.progress("connect", "SSH key installed; the password is not kept.")

    async def _run_ssh(self, job: DeployJob, route: SSHRoute, args: list[str], *, stdin: bytes, idle_timeout: float,
                       on_line: Callable[[str], None] | None = None) -> list[str]:
        proc = await asyncio.create_subprocess_exec(
            ssh_binary(), *route.options, *args,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=route.env,
            start_new_session=True,
        )
        job.proc = proc
        lines: list[str] = []
        assert proc.stdin is not None and proc.stdout is not None
        try:
            async with ssh_process_group(proc):
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
        if code != 0:
            detail = next((line for line in reversed(lines) if line.strip() and not line.startswith((PROBE_PREFIX, RESULT_PREFIX))), "")
            if code == 255:
                raise SSHConnectionLost(detail or "ssh exited 255")
            # The host script failed in the step it announced last; what follows that
            # "[AgentsDock setup]" line is the step's own output (uv's build error, a tar error,
            # the server log tail). Its last 200 lines go into the job log, under log_limit so the
            # earlier phases stay visible; the PROBE and RESULT lines stay out, the latter carries
            # the access token. The error is the step's first error line: uv opens its block with
            # "error: Failed to build `<package>`" (older releases: an indented "× Failed to build")
            # and the "hint:" line it ends with says nothing about the cause.
            start = max((index + 1 for index, line in enumerate(lines) if line.startswith(SETUP_LOG_PREFIX)), default=0)
            step_output = [line for line in lines[start:] if line.strip() and not line.startswith((PROBE_PREFIX, RESULT_PREFIX))]
            for line in step_output[-200:]:
                job.progress(job.phase, line)
            detail = next((line.strip() for line in step_output if line.startswith("error") or line.lstrip().startswith("×")), detail)
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
            start_new_session=True,
        )
        job.proc = proc
        assert proc.stdin is not None
        output = b""
        try:
            async with ssh_process_group(proc):
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
        if proc.returncode != 0:
            detail = last_line(output.decode("utf-8", "replace")) or f"ssh exited {proc.returncode}"
            if proc.returncode == 255:
                raise SSHConnectionLost(f"Uploading the server source failed: {detail}")
            raise RuntimeError(f"Uploading the server source failed: {detail}")

    async def _wait_health(self, server: RemoteServer, timeout: float = DEPLOY_HEALTH_WAIT_SECONDS) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last_error = "no response"
        while time.monotonic() < deadline:
            try:
                response = await self.http.get(f"http://127.0.0.1:{server.local_port}/api/health", headers={"X-AgentsDock-Token": server.token}, timeout=HEALTH_REQUEST_TIMEOUT)
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
        # Registry order: a client reconciles when this changes, which a reorder elsewhere does without changing the count.
        "ids": list(manager.servers),
        # Likewise for a remote hidden or shown from another client.
        "hidden": [remote_id for remote_id, server in manager.servers.items() if server.hidden],
    }


# --- routes ---------------------------------------------------------------------


def register_remote_server_routes(
    app: FastAPI,
    *,
    manager: RemoteServerManager,
    authorize_admin: Callable[[Request], None],
    websocket_authorized: Callable[[WebSocket], bool],
    hub_running_chat_count: Callable[[], int],
    hub_update_cli: Callable[[str], Awaitable[tuple[str, bool]]],
    hub_restart: Callable[[], Awaitable[str | None]],
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

    @app.put(f"{ADMIN_PATH}/order", status_code=204)
    async def remote_servers_reorder(request: Request, body: RemoteServerOrder) -> Response:
        authorize_admin(request)
        manager.reorder(body.ids)
        return Response(status_code=204)

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

    @app.post(f"{ADMIN_PATH}/update-all")
    async def remote_servers_update_all(request: Request, body: UpdateAllRequest) -> JSONResponse:
        """Redeploy every remote, update the CLIs everywhere, restart the hub. Without force, servers with running chats stop it."""
        authorize_admin(request)
        if not body.force:
            running = await manager.servers_with_running_chats(hub_running_chat_count())
            if running:
                return JSONResponse({"running": running})
        job = manager.start_update_all(hub_update_cli=hub_update_cli, hub_restart=hub_restart)
        return JSONResponse({"job_id": job.job_id}, status_code=202)

    @app.post(f"{ADMIN_PATH}/{{remote_id}}/redeploy", status_code=202)
    async def remote_servers_redeploy(request: Request, remote_id: str) -> dict[str, Any]:
        authorize_admin(request)
        server = manager.servers.get(remote_id)
        if server is not None and server.attached:
            raise HTTPException(status_code=409, detail="This server was attached from another hub's install; redeploy it from that hub.")
        return {"job_id": manager.start_deploy(None, redeploy_id=remote_id).job_id}

    @app.patch(f"{ADMIN_PATH}/{{remote_id}}")
    async def remote_servers_update(request: Request, remote_id: str, body: RemoteServerUpdate) -> dict[str, Any]:
        authorize_admin(request)
        server, job = manager.update(remote_id, body)
        return {"server": public_view(server, manager.tunnel_status(remote_id)), "job_id": job.job_id if job else None}

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
        bulk = ((request.method == "POST" and UPLOAD_PATH_RE.fullmatch(path) is not None)
                or (request.method == "GET" and DOWNLOAD_PATH_RE.fullmatch(path) is not None))
        port = manager.bulk_port(server) if bulk else server.local_port
        url = f"http://127.0.0.1:{port}/{path}" + (f"?{query}" if query else "")
        body_sent = asyncio.Event()
        content = None
        if request.method not in ("GET", "HEAD") and (request.headers.get("content-length") not in (None, "0") or "transfer-encoding" in request.headers):
            async def body() -> AsyncIterator[bytes]:
                async for chunk in request.stream():
                    yield chunk
                body_sent.set()
            content = body()
        else:
            body_sent.set()

        async def client_left() -> None:
            # The body owns the receive channel until it has gone upstream.
            await body_sent.wait()
            while (await request.receive())["type"] != "http.disconnect":
                pass

        # The upstream request lives only as long as its client. The read timeout is
        # None, so a remote that accepts and never answers (a frozen server behind its
        # ssh forward) would otherwise pin one hub socket per abandoned request.
        upstream_request = manager.http.build_request(request.method, url, headers=headers, content=content)
        sending = asyncio.ensure_future(manager.http.send(upstream_request, stream=True))
        leaving = asyncio.ensure_future(client_left())
        try:
            await asyncio.wait((sending, leaving), return_when=asyncio.FIRST_COMPLETED)
        finally:
            leaving.cancel()
            answered = sending.done()
            if not answered:
                sending.cancel()  # closes its upstream connection
        if not answered:
            return Response(status_code=499)
        try:
            upstream = sending.result()
        except ClientDisconnect:
            # The client dropped its own request body mid-way (the desktop abandons an
            # upload whose chat closed). Nobody is left to receive an answer; 499 is
            # nginx's code for a client that closed its request.
            return Response(status_code=499)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            return JSONResponse(
                {"detail": {"code": "remote_unreachable", "remote_id": remote_id, "tunnel": manager.tunnel_status(remote_id, bulk=bulk), "message": str(exc) or "connection failed"}},
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
        port = (manager.stream_port(server) if STREAM_PATH_RE.fullmatch(path)
                else manager.surface_port(server) if PORT_TUNNEL_PATH_RE.fullmatch(path) else server.local_port)
        # websockets connects without manager.http and its down-tunnel check.
        if manager.tunnel_down_on(port) is not None:
            await ws.close(code=1011, reason="remote server unreachable")
            return
        url = f"ws://127.0.0.1:{port}/{path}" + (f"?{query}" if query else "")
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


if __name__ == "__main__":
    # The ProxyCommand ssh_alias_content writes for an oci@ or aws@ remote: Sky's own command, run in the
    # environment the hub's route sets for it.
    if len(sys.argv) != 4 or sys.argv[1] != "proxy-command":
        sys.exit("usage: remote_servers.py proxy-command <oci@cluster|aws@cluster> <command>")
    try:
        proxy_route = asyncio.run(ssh_route(sys.argv[2]))
    except OSError as exc:
        sys.exit(f"{sys.argv[2]}: {exc}")
    os.execve("/bin/sh", ["/bin/sh", "-c", f"exec {sys.argv[3]}"], proxy_route.env)
