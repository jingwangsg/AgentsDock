#!/usr/bin/env python3
"""Publish files to the active AgentsDock chat turn and verify the receipt."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from agentsdock_cli_common import (
    CLIError,
    authority_server_origin,
    bounded_identity_value,
    nonempty_chat_id,
    provider_authority,
    provider_opener,
    validated_server_url,
)


def loopback_server_url() -> str:
    """Compatibility validator for legacy explicit loopback CLI calls."""

    return validated_server_url("")


def requested_chat_scope(chat_id: str | None, authority_chat_id: str) -> str:
    explicit = bounded_identity_value(chat_id, "--chat-id")
    if explicit and explicit != authority_chat_id:
        raise CLIError("--chat-id does not match the authority file")
    return authority_chat_id


def load_manifest(path: str) -> list[Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CLIError(f"could not read manifest {path!r}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        raise CLIError("manifest must be a JSON object with a files array")
    return list(data["files"])


def parse_entry_json(value: str) -> dict[str, Any]:
    try:
        entry = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid --entry-json: {exc}") from exc
    if not isinstance(entry, dict):
        raise argparse.ArgumentTypeError("--entry-json must decode to an object")
    return entry


def requested_files(args: argparse.Namespace) -> list[Any]:
    entries: list[Any] = list(args.paths)
    entries.extend(args.entry_json)
    if args.manifest:
        entries.extend(load_manifest(args.manifest))
    if not entries:
        raise CLIError("provide at least one absolute file path")
    return entries


def http_error_detail(raw: str) -> str:
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(decoded, dict):
        detail = decoded.get("detail")
        if isinstance(detail, str):
            return detail
        if detail is not None:
            return json.dumps(detail, separators=(",", ":"))
    return json.dumps(decoded, separators=(",", ":"))


def publish(
    chat_id: str | None,
    files: list[Any],
    *,
    publication_id: str | None = None,
    authority_file: str | None = None,
) -> dict[str, Any]:
    capability, authority_chat_id = provider_authority(authority_file)
    server_url = validated_server_url(authority_server_origin(authority_file))
    chat_id = requested_chat_scope(chat_id, authority_chat_id)
    publication_id = publication_id or f"pub_{uuid.uuid4().hex}"
    encoded_chat_id = urllib.parse.quote(chat_id, safe="")
    body = json.dumps({
        "publication_id": publication_id,
        "files": files,
    }).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-AgentsDock-Provider-Capability": capability,
    }
    decoded: Any = None
    ambiguous_error: BaseException | None = None
    opener = provider_opener()
    for attempt in range(2):
        attempt_headers = dict(headers)
        if attempt:
            attempt_headers["X-AgentsDock-Publication-Retry"] = "1"
        request = urllib.request.Request(
            f"{server_url}/api/agent/sessions/{encoded_chat_id}/artifacts",
            data=body,
            headers=attempt_headers,
            method="POST",
        )
        try:
            # Large videos can take time to copy from a network workspace. The
            # server performs that copy outside its event loop and returns only
            # after the artifact events are durable. One retry uses the same
            # publication ID, so a lost response cannot create duplicate cards.
            with opener.open(request, timeout=600) as response:
                raw_response = response.read().decode("utf-8")
            try:
                decoded = json.loads(raw_response)
            except json.JSONDecodeError as exc:
                # A truncated response is ambiguous: the event batch may
                # already be durable. Retry once with the same publication ID.
                ambiguous_error = exc
                if attempt == 0:
                    continue
                break
            ambiguous_error = None
            break
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            detail = http_error_detail(raw)
            raise CLIError(
                f"server rejected publication ({exc.code}): {detail or exc.reason}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            ambiguous_error = exc
            if attempt == 0:
                continue
    if ambiguous_error is not None:
        reason = getattr(ambiguous_error, "reason", ambiguous_error)
        raise CLIError(
            f"could not confirm publication {publication_id}: {reason}"
        ) from ambiguous_error
    if not isinstance(decoded, dict) or decoded.get("ok") is not True:
        raise CLIError("AgentsServer did not confirm publication")
    if decoded.get("publication_id") != publication_id:
        raise CLIError("AgentsServer returned a receipt for another publication")
    if decoded.get("chat_id") != chat_id:
        raise CLIError("AgentsServer returned a receipt for another chat")
    run_id = decoded.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise CLIError("AgentsServer returned a receipt without a run ID")
    receipts = decoded.get("receipts")
    if not isinstance(receipts, list) or len(receipts) != len(files):
        raise CLIError("AgentsServer returned an incomplete publication receipt")
    artifact_ids: set[str] = set()
    event_ids: set[str] = set()
    for receipt in receipts:
        artifact_id = str(receipt.get("artifact_id") or "") if isinstance(receipt, dict) else ""
        event_id = str(receipt.get("event_id") or "") if isinstance(receipt, dict) else ""
        if (
            not isinstance(receipt, dict)
            or not artifact_id.strip()
            or not event_id.strip()
            or not isinstance(receipt.get("event_seq"), int)
            or isinstance(receipt.get("event_seq"), bool)
            or int(receipt["event_seq"]) <= 0
            or receipt.get("run_id") != run_id
            or artifact_id in artifact_ids
            or event_id in event_ids
        ):
            raise CLIError("AgentsServer returned an invalid publication receipt")
        artifact_ids.add(artifact_id)
        event_ids.add(event_id)
    return decoded


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Attach files to the currently active AgentsDock chat turn.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--authority-file",
        help="mode-0600 per-run AgentsDock provider authority file",
    )
    parser.add_argument(
        "--chat-id",
        type=nonempty_chat_id,
        help="explicit chat scope (defaults to AGENTSDOCK_CHAT_ID)",
    )
    parser.add_argument(
        "--manifest",
        help="read additional entries from a legacy {\"files\": [...]} manifest",
    )
    parser.add_argument(
        "--publication-id",
        help="idempotency key (normally generated automatically)",
    )
    parser.add_argument(
        "--entry-json",
        action="append",
        default=[],
        type=parse_entry_json,
        metavar="JSON",
        help='publish an object entry such as {"path":"/tmp/demo.mp4","title":"Demo"}',
    )
    parser.add_argument("paths", nargs="*", help="absolute file paths")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = publish(
            args.chat_id,
            requested_files(args),
            publication_id=args.publication_id,
            authority_file=args.authority_file,
        )
    except CLIError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
