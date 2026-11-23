"""On-demand provider access over a deployed server's authenticated SSH channel."""
import asyncio
import base64
import contextlib
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import select
import socket
import stat
import sys

LIMIT = 65536
FAILURE = "Hub provider login is unavailable. Check the hub login and its SSH connection."
CODEX_CONFIG = {
    "cli_auth_credentials_store": "ephemeral",
    "model_provider": "openai",
    "chatgpt_base_url": "https://chatgpt.com/backend-api/",
    "openai_base_url": "https://chatgpt.com/backend-api/codex",
}


class HubLoginError(RuntimeError):
    pass


def claims(token):
    try:
        part = token.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        if not isinstance(payload, dict):
            raise HubLoginError(FAILURE)
        return payload
    except (ValueError, IndexError, AttributeError) as exc:
        raise HubLoginError(FAILURE) from exc


def codex_identity(token):
    # A workspace can contain multiple users. Token rotation must keep both.
    payload = claims(token)
    details = payload["https://api.openai.com/auth"]
    account, subject = details["chatgpt_account_id"], payload["sub"]
    if not all(isinstance(value, str) and value for value in (account, subject)):
        raise HubLoginError(FAILURE)
    return hashlib.sha256(json.dumps([account, subject]).encode()).hexdigest()


def codex_environment(env):
    # Native endpoint and login overrides on a remote must not redirect a Hub token.
    return {k: v for k, v in env.items() if k.upper() not in {
        "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_AUTH_TOKEN", "OPENAI_API_BASE", "OPENAI_BASE_URL",
        "CODEX_APP_SERVER_CHATGPT_BASE_URL", "CODEX_AUTHAPI_BASE_URL", "CODEX_CLOUD_TASKS_BASE_URL",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
    }}


def socket_path(install):
    # Linux sockaddr_un paths are short even when the install is deep in a shared mount.
    digest = hashlib.sha256(os.fsencode(Path(install).resolve())).hexdigest()[:24]
    return Path("/tmp") / f"agentsdock-auth-{os.getuid()}-{digest}" / "socket"


def request(install, backend, previous="", refresh=False):
    path = socket_path(install)
    try:
        info = path.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise HubLoginError(FAILURE)
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(18)
            sock.connect(str(path))
            sock.sendall(json.dumps([backend, previous, refresh]).encode() + b"\n")
            with sock.makefile("rb") as stream:
                result = json.loads(stream.readline(LIMIT))
        if not isinstance(result, dict) or not isinstance(result.get("accessToken"), str) or not result["accessToken"]:
            raise HubLoginError(FAILURE)
        if backend == "codex":
            if not isinstance(result.get("chatgptAccountId"), str) or not result["chatgptAccountId"]:
                raise HubLoginError(FAILURE)
            return {"accessToken": result["accessToken"], "chatgptAccountId": result["chatgptAccountId"]}
        return {"accessToken": result["accessToken"]}
    except (OSError, ValueError) as exc:
        raise HubLoginError(FAILURE) from exc


def remote_relay(install):
    """The deployed user's CLI clients are the only local consumers."""
    path = socket_path(install)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    info = path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise HubLoginError(FAILURE)
    with (path.parent / "lock").open("a") as lock, socket.socket(socket.AF_UNIX) as listener:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        challenge = sys.stdin.buffer.readline(128).strip()
        if len(challenge) != 64:
            return
        fd = os.open(Path(install) / ".hub-provider-proof", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as proof:
            info = os.fstat(proof.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise HubLoginError(FAILURE)
            key = proof.read(65)
            if len(key) != 64:
                raise HubLoginError(FAILURE)
        path.unlink(missing_ok=True)
        listener.bind(str(path))
        listener.listen(32)
        try:
            print(hmac.digest(key, challenge, "sha256").hex(), flush=True)
            while True:
                ready, _, _ = select.select([listener, sys.stdin.buffer], [], [])
                if sys.stdin.buffer in ready:
                    return
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(5)
                    try:
                        with conn.makefile("rb") as stream:
                            line = stream.readline(512)
                        if not line.endswith(b"\n"):
                            continue
                    except OSError:
                        continue
                    sys.stdout.buffer.write(line)
                    sys.stdout.buffer.flush()
                    reply = sys.stdin.buffer.readline(LIMIT)
                    if not reply.endswith(b"\n"):
                        return
                    with contextlib.suppress(OSError):
                        conn.sendall(reply)
        finally:
            path.unlink(missing_ok=True)


async def forward_requests(proc, key, issue):
    challenge = secrets.token_hex(32).encode()
    proc.stdin.write(challenge + b"\n")
    await proc.stdin.drain()
    proof = await asyncio.wait_for(proc.stdout.readline(), 30)
    if not hmac.compare_digest(proof.strip(), hmac.digest(key.encode(), challenge, "sha256").hex().encode()):
        raise HubLoginError(FAILURE)
    while line := await proc.stdout.readline():
        try:
            backend, previous, refresh = json.loads(line)
            if backend not in ("codex", "cursor") or not isinstance(previous, str) or type(refresh) is not bool:
                raise ValueError()
            grant = await asyncio.wait_for(issue(backend, previous, refresh), 15)
        except Exception:
            # Provider exceptions can carry headers or raw auth responses.
            grant = {}
        proc.stdin.write(json.dumps(grant).encode() + b"\n")
        await proc.stdin.drain()


if __name__ == "__main__":
    remote_relay(sys.argv[1])
