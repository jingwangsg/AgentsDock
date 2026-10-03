"""Authority and loopback-transport plumbing shared by the agent helper CLIs.

The helpers (agentsdock_chats, _jobs, _team, _publish, _emergency, _mail) run
as subprocesses of an agent turn and talk to agent_server over HTTP with
urllib.  They never import agent_server; this module must stay importable from
the bare helper directory with only the standard library.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


PROVIDER_RUNTIME_VALUE_MAX_BYTES = 4096


class CLIError(RuntimeError):
    """A safe, user-facing CLI failure."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def provider_opener() -> urllib.request.OpenerDirector:
    # urllib honors HTTP_PROXY even for loopback addresses on some hosts.
    # Disabling proxies and redirects keeps the capability token on the
    # already-validated local endpoint.
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        NoRedirectHandler(),
    )


def nonempty_chat_id(value: str) -> str:
    chat_id = value.strip()
    if not chat_id:
        raise argparse.ArgumentTypeError("--chat-id must not be empty")
    return chat_id


def canonical_http_origin(value: str, label: str) -> tuple[str, bool]:
    raw = value.strip()
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port or 80
    except ValueError as exc:
        raise CLIError(f"{label} must be an HTTP origin") from exc
    if (
        parsed.scheme.lower() != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise CLIError(f"{label} must be an HTTP origin")
    host = parsed.hostname.lower()
    try:
        address = ipaddress.ip_address(host)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        host = address.compressed
        loopback = address.is_loopback
        url_host = f"[{host}]" if isinstance(address, ipaddress.IPv6Address) else host
    except ValueError:
        loopback = host == "localhost"
        url_host = host
    return f"http://{url_host}:{port}", loopback


def bounded_identity_value(value: str | None, label: str) -> str:
    clean = str(value or "").strip()
    try:
        size = len(clean.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise CLIError(f"{label} is not valid UTF-8") from exc
    if size > PROVIDER_RUNTIME_VALUE_MAX_BYTES:
        raise CLIError(f"{label} exceeds the provider runtime limit")
    return clean


def selected_authority_path(authority_file: str | None = None) -> Path:
    explicit = bounded_identity_value(authority_file, "--authority-file")
    ambient = bounded_identity_value(
        os.environ.get("AGENTSDOCK_PROVIDER_AUTHORITY_FILE"),
        "AGENTSDOCK_PROVIDER_AUTHORITY_FILE",
    )
    if explicit and ambient:
        explicit_key = os.path.abspath(os.path.expanduser(explicit))
        ambient_key = os.path.abspath(os.path.expanduser(ambient))
        if explicit_key != ambient_key:
            raise CLIError(
                "--authority-file conflicts with the live provider authority"
            )
    selected = explicit or ambient
    if not selected:
        raise CLIError("--authority-file is required")
    return Path(selected).expanduser()


def _authority_payload(authority_file: str | None) -> Any:
    path = selected_authority_path(authority_file)
    try:
        if path.stat().st_mode & 0o077:
            raise CLIError("authority file permissions are unsafe")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CLIError(f"could not read authority file: {exc}") from exc
    return payload


def provider_authority(authority_file: str | None = None) -> tuple[str, str]:
    """Return (capability, chat_id) from the authority file.

    A live AGENTSDOCK_CHAT_ID must name the same chat as the authority file so
    a stale or foreign environment cannot redirect a helper call.
    """

    payload = _authority_payload(authority_file)
    capability = str(payload.get("provider_capability") or payload.get("capability") or "")
    source_session_id = str(payload.get("source_session_id") or "").strip()
    if not capability or not source_session_id:
        raise CLIError("authority file is invalid")
    environment_chat_id = bounded_identity_value(
        os.environ.get("AGENTSDOCK_CHAT_ID"),
        "AGENTSDOCK_CHAT_ID",
    )
    if environment_chat_id and environment_chat_id != source_session_id:
        raise CLIError("AGENTSDOCK_CHAT_ID does not match the authority file")
    return capability, source_session_id


def authority_server_origin(authority_file: str | None = None) -> str:
    return bounded_identity_value(
        _authority_payload(authority_file).get("provider_server_origin"),
        "authority provider_server_origin",
    )


def validated_server_url(authority_origin: str | None = None) -> str:
    """Return the server URL from AGENTSDOCK_SERVER_URL after origin checks.

    A loopback URL is accepted as-is.  A non-loopback URL must equal
    ``authority_origin``; when that is ``None`` the ambient authority file is
    read for it only at that point, so helpers whose transport layer does not
    know the explicit --authority-file still work on loopback without one.
    """

    raw_server_url = os.environ.get("AGENTSDOCK_SERVER_URL", "").strip()
    if not raw_server_url:
        raise CLIError("missing agent environment: AGENTSDOCK_SERVER_URL")
    server_origin, loopback = canonical_http_origin(
        raw_server_url,
        "AGENTSDOCK_SERVER_URL",
    )
    runtime_origin = bounded_identity_value(
        os.environ.get("AGENTSDOCK_PROVIDER_SERVER_ORIGIN"),
        "AGENTSDOCK_PROVIDER_SERVER_ORIGIN",
    )
    if runtime_origin:
        canonical_runtime, _runtime_loopback = canonical_http_origin(
            runtime_origin,
            "AGENTSDOCK_PROVIDER_SERVER_ORIGIN",
        )
        if canonical_runtime != server_origin:
            raise CLIError(
                "AGENTSDOCK_SERVER_URL conflicts with the live provider origin"
            )
    if loopback:
        return raw_server_url.rstrip("/")
    if authority_origin is None:
        authority_origin = authority_server_origin(None)
    if not authority_origin:
        raise CLIError(
            "non-loopback AGENTSDOCK_SERVER_URL must match the authority origin"
        )
    canonical_authority, _authority_loopback = canonical_http_origin(
        authority_origin,
        "authority provider_server_origin",
    )
    if canonical_authority != server_origin:
        raise CLIError(
            "non-loopback AGENTSDOCK_SERVER_URL must match the authority origin"
        )
    return server_origin


def provider_headers(capability: str) -> dict[str, str]:
    """Return the one canonical header accepted by agent-helper routes.

    The retired cross-chat-specific header is intentionally omitted.  The
    server rejects requests that mix legacy and current authority names so a
    browser or stale helper cannot smuggle ambiguous credentials.
    """

    return {
        "Accept": "application/json",
        "X-AgentsDock-Provider-Capability": capability,
    }


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    token: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """One JSON request to an already-validated server URL, no retries."""

    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = provider_headers(token)
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with provider_opener().open(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("detail") or raw
        except (json.JSONDecodeError, AttributeError):
            detail = raw
        raise CLIError(
            f"server rejected request ({exc.code}): {detail or exc.reason}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CLIError(
            f"could not reach AgentsServer: {getattr(exc, 'reason', exc)}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise CLIError("AgentsServer returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise CLIError("AgentsServer returned an invalid response")
    return result
