#!/usr/bin/env python3
"""Capability-scoped Team Network mail CLI for AgentsDock agents."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.parse
from typing import Any

from agentsdock_cli_common import (
    CLIError,
    provider_authority,
    request_json,
    selected_authority_path,
    validated_server_url,
)


MAIL_BODY_MAX_BYTES = 8_192


def _request_json(
    method: str,
    path: str,
    capability: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return request_json(
        method, f"{validated_server_url()}{path}", payload, token=capability
    )


def list_routes(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    result = _request_json("GET", "/api/agent/team-mail/routes", capability)
    routes = result.get("routes")
    if (
        not isinstance(routes, list)
        or any(not isinstance(route, dict) for route in routes)
    ):
        raise CLIError("AgentsServer returned an invalid Team Network mail route list")
    return result


def send(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    if sys.stdin.isatty():
        raise CLIError("Team Network mail body must be provided on stdin")
    input_stream = getattr(sys.stdin, "buffer", sys.stdin)
    raw_message = input_stream.read(MAIL_BODY_MAX_BYTES + 1)
    if isinstance(raw_message, str):
        raw_message = raw_message.encode("utf-8")
    if len(raw_message) > MAIL_BODY_MAX_BYTES:
        raise CLIError("Team Network mail body exceeds the configured size limit")
    try:
        message = raw_message.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise CLIError("Team Network mail body must be valid UTF-8") from exc
    if not message:
        raise CLIError("Team Network mail body on stdin must not be empty")
    route_id = str(args.route or "").strip()
    kind = str(args.kind or "message")
    if kind != "message":
        raise CLIError("AgentsDock agent mail permits messages only")
    stable_key = "mail_cli_" + hashlib.sha256(
        f"{capability}\0{route_id}\0{kind}\0{message}".encode("utf-8")
    ).hexdigest()
    result = _request_json(
        "POST",
        f"/api/agent/team-mail/routes/{urllib.parse.quote(route_id, safe='')}",
        capability,
        {
            "kind": kind,
            "message": message,
            "idempotency_key": args.idempotency_key or stable_key,
        },
    )
    if set(result) != {"ok", "route_id", "kind", "accepted", "duplicate"}:
        raise CLIError("AgentsServer returned an invalid Team Network mail receipt")
    if (
        result.get("ok") is not True
        or result.get("route_id") != route_id
        or result.get("kind") != kind
        or result.get("accepted") is not True
        or type(result.get("duplicate")) is not bool
    ):
        raise CLIError("AgentsServer returned an invalid Team Network mail receipt")
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Send passive Team Network mail using this live agent turn.",
        allow_abbrev=False,
    )
    root.add_argument(
        "--authority-file",
        help="mode-0600 per-run AgentsDock provider authority file",
    )
    commands = root.add_subparsers(dest="command", required=True)
    list_command = commands.add_parser(
        "list", help="list this turn's opaque mail routes", allow_abbrev=False
    )
    list_command.set_defaults(handler=list_routes)
    send_command = commands.add_parser(
        "send",
        help="send one passive mailbox item with its UTF-8 body on stdin",
        allow_abbrev=False,
    )
    send_command.add_argument("--route", required=True, help="opaque route from list")
    send_command.add_argument(
        "--kind",
        choices=("message",),
        default="message",
    )
    send_command.add_argument("--idempotency-key", help=argparse.SUPPRESS)
    send_command.set_defaults(handler=send)
    return root


def main(argv: list[str] | None = None) -> int:
    previous_authority_file = os.environ.get(
        "AGENTSDOCK_PROVIDER_AUTHORITY_FILE"
    )
    try:
        args = parser().parse_args(argv)
        selected_authority = selected_authority_path(args.authority_file)
        os.environ["AGENTSDOCK_PROVIDER_AUTHORITY_FILE"] = str(
            selected_authority
        )
        result = args.handler(args)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except CLIError as exc:
        print(f"agentsdock-mail: {exc}", file=sys.stderr)
        return 2
    finally:
        if previous_authority_file is None:
            os.environ.pop("AGENTSDOCK_PROVIDER_AUTHORITY_FILE", None)
        else:
            os.environ[
                "AGENTSDOCK_PROVIDER_AUTHORITY_FILE"
            ] = previous_authority_file


if __name__ == "__main__":
    raise SystemExit(main())
