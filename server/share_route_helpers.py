"""Request plumbing shared by the public-snapshot and interactive chat share routers.

Domain rules stay in each router. This module only bounds request bodies,
admits blocking storage work off the event loop, and canonicalizes the
browser origin a share capability is bound to.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
from urllib.parse import urlsplit

from fastapi import HTTPException

from public_chat_shares import PublicChatShareValidationError


def chat_share_origin(base: str) -> str:
    """Use the browser's canonical origin spelling when binding capabilities."""
    if not isinstance(base, str) or not base:
        raise PublicChatShareValidationError("Chat link must use an HTTP or HTTPS origin")
    try:
        parsed = urlsplit(base)
        parsed.port  # Reject malformed/out-of-range ports before persistence.
    except (TypeError, ValueError):
        raise PublicChatShareValidationError("Chat link must use an HTTP or HTTPS origin") from None
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or parsed.path not in {"", "/"} or "\\" in base or any(c.isspace() for c in base)):
        raise PublicChatShareValidationError("Chat link must use an HTTP or HTTPS origin")
    try:
        hostname = parsed.hostname.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise PublicChatShareValidationError("Invalid chat link hostname") from None
    if ":" in hostname:
        try:
            if "%" in hostname:
                raise ValueError("Scoped IPv6 is not a browser origin")
            hostname = ipaddress.IPv6Address(hostname).compressed
        except ValueError:
            raise PublicChatShareValidationError("Invalid chat link hostname") from None
        host = f"[{hostname}]"
    else:
        host = hostname
    port = parsed.port
    suffix = f":{port}" if port is not None and port != (443 if parsed.scheme == "https" else 80) else ""
    return f"{parsed.scheme}://{host}{suffix}"


def admission_slot(limit: int, *, retry_after: int | None = None):
    """Run blocking share work in a thread, at most ``limit`` operations at a time."""
    active = 0
    headers = None if retry_after is None else {"Retry-After": str(retry_after)}

    async def run(operation):
        nonlocal active
        if active >= limit:
            raise HTTPException(503, "Sharing is busy; retry shortly", headers=headers)
        active += 1
        # Shield worker completion on disconnect: a cancelled caller must not
        # release admission while its filesystem thread is still running.
        task = asyncio.create_task(asyncio.to_thread(operation))
        def finished(_):
            nonlocal active
            active -= 1
            # Retrieve an exception even when the requesting client disconnected.
            if not task.cancelled():
                task.exception()
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    return run


async def bounded_body_bytes(request, *, limit: int, timeout: float) -> bytes:
    async def collect():
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > limit:
                raise HTTPException(413, "Request is too large")
            data.extend(chunk)
        return bytes(data)
    try:
        # asyncio.timeout is unavailable on supported Python 3.10 hosts.
        return await asyncio.wait_for(collect(), timeout)
    except asyncio.TimeoutError:
        raise HTTPException(408, "Request body was not received") from None


async def bounded_json_body(request, *, limit: int, timeout: float) -> dict:
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Use application/json")
    try:
        value = json.loads(await bounded_body_bytes(request, limit=limit, timeout=timeout))
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "Invalid JSON") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "Expected a JSON object")
    return value
