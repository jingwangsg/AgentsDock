#!/usr/bin/env python3
"""Capability-scoped Team Network helper for AgentsDock agents.

Read commands (mentions, inbox, bulletin/feed, sent, read, skills, skill get) are available on
every ordinary turn.  ``routes``, ``send``, ``reply``, and ``edit`` exist only when the user
mentioned Team Network recipients with ``@@`` on this turn; the server freezes
those recipients into opaque per-run routes.  Message bodies arrive on stdin so
they never appear in process arguments.

The Bulletin route posts only to the shared board. The all_servers route sends
Team Network mail to each current server inbox, not to an email/SMTP address.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
from pathlib import Path
from typing import Any

from agentsdock_cli_common import (
    CLIError,
    provider_authority,
    request_json,
    selected_authority_path,
    validated_server_url,
)


BODY_MAX_BYTES = 49_152
ATTACHMENT_MAX_COUNT = 16
SENDER_SCAN_PAGE_SIZE = 50
SENDER_SCAN_MAX_RESULTS = 50
SENDER_SCAN_MAX_PAGES = 20
SENDER_SCAN_MAX_SECONDS = 45.0
# Keep complete, pretty-printed responses below the provider's 128 KiB stdout cap.
SENDER_SCAN_OUTPUT_MAX_BYTES = 96 * 1024


def _request_json(
    method: str,
    path: str,
    capability: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float = 60.0,
) -> dict[str, Any]:
    return request_json(
        method, f"{validated_server_url()}{path}", payload,
        token=capability, timeout=timeout,
    )


def _query(params: dict[str, Any]) -> str:
    clean = {key: value for key, value in params.items() if value not in (None, "", False)}
    if not clean:
        return ""
    return "?" + urllib.parse.urlencode(
        {key: ("1" if value is True else str(value)) for key, value in clean.items()}
    )


def _sender_name(value: str) -> str:
    name = value.strip()
    if name.startswith("@@"):
        name = name[2:].strip()
    if not name:
        raise CLIError("--from requires a sender display name")
    return name


def _sender_output_size(result: dict[str, Any]) -> int:
    # Match main()'s JSON formatting and print's final newline, including metadata.
    return len(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")) + 1


def _list_by_sender(
    capability: str, params: dict[str, Any], name: str, limit: int,
) -> dict[str, Any]:
    """Scan existing ascending pages on demand, retaining a lossless cursor."""
    if limit < 1:
        raise CLIError("--limit must be positive")
    limit = min(limit, SENDER_SCAN_MAX_RESULTS)
    needle = name.casefold()
    cursor = max(0, params.get("after_sequence") or 0)
    params = {**params, "limit": SENDER_SCAN_PAGE_SIZE}
    deadline = time.monotonic() + SENDER_SCAN_MAX_SECONDS
    matches: list[dict[str, Any]] = []
    scanned = 0
    pages = 0
    result: dict[str, Any] | None = None
    has_more = True
    stop_reason = "page_limit"

    def response(*, candidate: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            **(result or {}),
            "messages": [*matches, candidate] if candidate is not None else matches,
            "next_after_sequence": candidate["sequence"] if candidate is not None else cursor,
            # This describes unexamined source messages, not confirmed matches.
            "has_more": True if candidate is not None else has_more,
            "sender_filter": name,
            "scan_complete": False if candidate is not None else not has_more,
            "scan_stop_reason": "output_limit" if candidate is not None else stop_reason,
            # Reserve enough digits for later scan counters when checking a match.
            "scanned_pages": SENDER_SCAN_MAX_PAGES if candidate is not None else pages,
            "scanned_messages": SENDER_SCAN_MAX_PAGES * SENDER_SCAN_PAGE_SIZE if candidate is not None else scanned,
        }

    while pages < SENDER_SCAN_MAX_PAGES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            stop_reason = "time_limit"
            break
        result = _request_json(
            "GET", "/api/agent/team/messages"
            + _query({**params, "after_sequence": cursor}),
            capability, timeout=remaining,
        )
        messages = result.get("messages")
        next_cursor = result.get("next_after_sequence")
        has_more = result.get("has_more")
        if (
            not isinstance(messages, list)
            or len(messages) > SENDER_SCAN_PAGE_SIZE
            or type(has_more) is not bool
            or type(next_cursor) is not int
        ):
            raise CLIError("AgentsServer returned an invalid message page")
        previous = cursor
        for item in messages:
            if (
                not isinstance(item, dict)
                or type(item.get("sequence")) is not int
                or item["sequence"] <= previous
                or not isinstance(item.get("sender"), dict)
            ):
                raise CLIError("AgentsServer returned an invalid message page cursor or sender")
            previous = item["sequence"]
        if next_cursor != previous or (has_more and next_cursor <= cursor):
            raise CLIError("AgentsServer returned an invalid or nonadvancing message page cursor")
        page_team = result.get("team_id")
        if page_team:
            if params.get("team") and params["team"] != page_team:
                raise CLIError("AgentsServer changed teams during a sender read")
            params["team"] = page_team
        pages += 1
        for index, item in enumerate(messages):
            display_name = str(item["sender"].get("display_name") or "")
            if display_name.strip().casefold() == needle:
                candidate = response(candidate=item)
                if _sender_output_size(candidate) > SENDER_SCAN_OUTPUT_MAX_BYTES:
                    if _sender_output_size({**candidate, "messages": [item]}) > SENDER_SCAN_OUTPUT_MAX_BYTES:
                        raise CLIError("A matching message exceeds the sender read output limit")
                    # Do not consume this match: the next explicit read must see it.
                    has_more = True
                    stop_reason = "output_limit"
                    break
                matches.append(item)
            cursor = item["sequence"]
            scanned += 1
            if len(matches) >= limit:
                # Unexamined entries in this page must remain available on the
                # next explicit read, even if this was the server's final page.
                has_more = index < len(messages) - 1 or has_more
                break
        if stop_reason == "output_limit":
            break
        if not has_more:
            stop_reason = "exhausted"
            break
        if len(matches) >= limit:
            stop_reason = "result_limit"
            break
    if result is None:
        raise CLIError("Sender read time budget expired before a page was received")
    output = response()
    if _sender_output_size(output) > SENDER_SCAN_OUTPUT_MAX_BYTES:
        raise CLIError("Sender read response metadata exceeds the output limit")
    return output


def list_box(args: argparse.Namespace, box: str) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    mention = getattr(args, "mention", None)
    if mention is not None and mention < 1:
        raise CLIError("--mention must be a positive mention index from `mentions`")
    params = {
        "box": box,
        "unread": getattr(args, "unread", False),
        "since": getattr(args, "since", None),
        "after_sequence": getattr(args, "after", None),
        "limit": args.limit,
        "team": getattr(args, "team", None),
        "include_mail_subject": getattr(args, "include_mail_subject", False),
        "mention": mention,
    }
    from_name = getattr(args, "from_name", None)
    if from_name is not None:
        return _list_by_sender(capability, params, _sender_name(from_name), args.limit)
    result = _request_json(
        "GET",
        "/api/agent/team/messages" + _query(params),
        capability,
    )
    messages = result.get("messages")
    if not isinstance(messages, list):
        raise CLIError("AgentsServer returned an invalid message list")
    return result


def inbox(args: argparse.Namespace) -> dict[str, Any]:
    return list_box(args, "inbox")


def feed(args: argparse.Namespace) -> dict[str, Any]:
    return list_box(args, "feed")


def sent(args: argparse.Namespace) -> dict[str, Any]:
    return list_box(args, "sent")


def mentions(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    result = _request_json("GET", "/api/agent/team/mentions", capability)
    if not isinstance(result.get("mentions"), list):
        raise CLIError("AgentsServer returned an invalid Team Network mention list")
    return result


def read(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    message_id = str(args.message_id or "").strip()
    if not message_id:
        raise CLIError("MESSAGE_ID is required")
    return _request_json(
        "GET",
        f"/api/agent/team/messages/{urllib.parse.quote(message_id, safe='')}"
        + _query({
            "download": bool(args.download), "team": getattr(args, "team", None),
            "include_mail_subject": getattr(args, "include_mail_subject", False),
            "include_revision": getattr(args, "include_revision", False),
        }),
        capability,
        timeout=600.0 if args.download else 60.0,
    )


def skills(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    return _request_json(
        "GET",
        "/api/agent/team/skills"
        + _query(
            {
                "include_archived": bool(args.include_archived),
                "team": getattr(args, "team", None),
            }
        ),
        capability,
    )


def skill_get(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    slug = str(args.slug or "").strip().lower()
    if not slug:
        raise CLIError("SLUG is required")
    return _request_json(
        "GET",
        f"/api/agent/team/skills/{urllib.parse.quote(slug, safe='')}"
        + _query(
            {
                "version": args.version,
                "download": bool(args.download),
                "team": getattr(args, "team", None),
            }
        ),
        capability,
        timeout=600.0 if args.download else 60.0,
    )


def routes(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    result = _request_json("GET", "/api/agent/team/routes", capability)
    if not isinstance(result.get("routes"), list):
        raise CLIError("AgentsServer returned an invalid route list")
    return result


def _read_body() -> str:
    if sys.stdin.isatty():
        raise CLIError("the message body must be provided on stdin")
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    raw = stream.read(BODY_MAX_BYTES + 1)
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > BODY_MAX_BYTES:
        raise CLIError(f"the message body exceeds {BODY_MAX_BYTES} bytes")
    try:
        body = raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise CLIError("the message body must be valid UTF-8") from exc
    if not body:
        raise CLIError("the message body on stdin must not be empty")
    return body


def _attachment_paths(values: list[str]) -> list[str]:
    paths: list[str] = []
    for value in values:
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise CLIError(f"attachment paths must be absolute: {value}")
        if not path.is_file():
            raise CLIError(f"attachment is not a regular file: {value}")
        resolved = str(path.resolve())
        if resolved not in paths:
            paths.append(resolved)
    if len(paths) > ATTACHMENT_MAX_COUNT:
        raise CLIError(f"at most {ATTACHMENT_MAX_COUNT} attachments per message")
    return paths


def _mail_subject(value: str) -> str:
    if any(unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"} for char in value):
        raise CLIError("--title must be a single line without control characters")
    subject = value.strip()
    if not 1 <= len(subject) <= 160:
        raise CLIError("--title must be between 1 and 160 characters")
    return subject


def send(args: argparse.Namespace) -> dict[str, Any]:
    capability, _session_id = provider_authority(args.authority_file)
    route_id = str(args.route or "").strip()
    if not route_id:
        raise CLIError("--route is required; run `routes` first")
    kind = str(args.kind or "message")
    if kind not in {"message", "skill"}:
        raise CLIError("--kind must be message or skill")
    reply_id = getattr(args, "in_reply_to", None)
    if reply_id is not None:
        if kind != "message":
            raise CLIError("--in-reply-to requires --kind message")
        if not isinstance(reply_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{8,240}", reply_id) is None:
            raise CLIError("reply MESSAGE_ID must contain 8 to 240 ASCII letters, digits, underscores, or hyphens")
    title = (
        _mail_subject(args.title) if kind == "message" and args.title is not None
        else str(args.title).strip() if args.title else None
    )
    body = _read_body()
    attachments = _attachment_paths(list(args.attach or []))
    payload: dict[str, Any] = {
        "kind": kind,
        "body": body,
        "body_format": "markdown",
        "attachments": attachments,
    }
    if title is not None:
        payload["title"] = title
    if reply_id is not None:
        payload["in_reply_to_message_id"] = reply_id
    if kind == "skill":
        if not args.skill_slug:
            raise CLIError("--skill-slug is required for --kind skill")
        if not args.title:
            raise CLIError("--title is required for --kind skill")
        skill: dict[str, Any] = {"slug": str(args.skill_slug).strip().lower()}
        if args.summary:
            skill["summary"] = str(args.summary).strip()
        if args.tags:
            skill["tags"] = [tag.strip().lower() for tag in str(args.tags).split(",") if tag.strip()]
        if args.change_note:
            skill["change_note"] = str(args.change_note).strip()
        if args.expected_version is not None:
            skill["expected_version"] = int(args.expected_version)
        payload["skill"] = skill
    elif args.skill_slug or args.expected_version is not None:
        raise CLIError("skill options require --kind skill")
    stable_key = "team_cli_" + hashlib.sha256(
        json.dumps(
            [capability, route_id, payload],
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    payload["idempotency_key"] = args.idempotency_key or stable_key
    result = _request_json(
        "POST",
        f"/api/agent/team/routes/{urllib.parse.quote(route_id, safe='')}",
        capability,
        payload,
        timeout=900.0,
    )
    required = {"ok", "route_id", "message_id", "kind", "accepted", "duplicate", "attachments"}
    if (
        not required.issubset(result)
        or result.get("ok") is not True
        or result.get("route_id") != route_id
        or result.get("kind") != kind
        or result.get("accepted") is not True
        or type(result.get("duplicate")) is not bool
    ):
        raise CLIError("AgentsServer returned an invalid Team Network send receipt")
    return result


def edit(args: argparse.Namespace) -> dict[str, Any]:
    """Revise one exact Bulletin message; never fall back to creating a post."""
    capability, _session_id = provider_authority(args.authority_file)
    route_id = str(args.route or "").strip()
    if not route_id:
        raise CLIError("--route is required; run `routes` first")
    message_id = args.message_id
    if not isinstance(message_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{8,240}", message_id) is None:
        raise CLIError("MESSAGE_ID must contain 8 to 240 ASCII letters, digits, underscores, or hyphens")
    expected_version = args.expected_version
    if type(expected_version) is not int or expected_version < 1:
        raise CLIError("--expected-version must be a positive integer; read --include-revision first")
    payload: dict[str, Any] = {
        "kind": "bulletin_edit",
        "message_id": message_id,
        "expected_version": expected_version,
        "body": _read_body(),
        "body_format": "markdown",
    }
    stable_key = "team_cli_" + hashlib.sha256(json.dumps(
        [capability, route_id, payload], sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    payload["idempotency_key"] = args.idempotency_key or stable_key
    result = _request_json(
        "POST", f"/api/agent/team/routes/{urllib.parse.quote(route_id, safe='')}",
        capability, payload, timeout=900.0,
    )
    if (
        result.get("ok") is not True
        or result.get("route_id") != route_id
        or result.get("message_id") != message_id
        or result.get("kind") != "bulletin_edit"
        or result.get("accepted") is not True
        or type(result.get("duplicate")) is not bool
        or type(result.get("attachments")) is not int
        or result["attachments"] < 0
        or result.get("edited") is not True
        or type(result.get("version")) is not int
        or result["version"] != expected_version + 1
    ):
        raise CLIError("AgentsServer returned an invalid Team Network edit receipt")
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Read native Team Network mail, Bulletin, and skills, and send to @@-mentioned recipients.",
        allow_abbrev=False,
    )
    root.add_argument(
        "--authority-file",
        help="mode-0600 per-run AgentsDock provider authority file",
    )
    commands = root.add_subparsers(dest="command", required=True)

    mentions_command = commands.add_parser(
        "mentions", help="list this turn's selected @@ identities for exact Team Network reads", allow_abbrev=False,
    )
    mentions_command.set_defaults(handler=mentions)

    def listing(name: str, help_text: str, *, aliases: tuple[str, ...] = ()):
        command = commands.add_parser(name, aliases=list(aliases), help=help_text, allow_abbrev=False)
        command.add_argument("--limit", type=int, default=20, help="maximum messages to return; with --from, maximum sender matches (capped at 50 and the output budget)")
        command.add_argument("--after", type=int, default=None, help="sequence cursor")
        command.add_argument("--team", default=None, help="team id when this server is in several teams")
        command.add_argument("--include-mail-subject", action="store_true", help="request mail subjects from a compatible Team Hub")
        return command

    inbox_command = listing("inbox", "messages sent to this server")
    inbox_command.add_argument("--unread", action="store_true")
    sender_help = "exact case-insensitive sender display name, optionally prefixed @@; scans at most 20 pages/45 seconds; continue with --after next_after_sequence if has_more"
    def sender_options(command: argparse.ArgumentParser) -> None:
        selection = command.add_mutually_exclusive_group()
        selection.add_argument("--from", dest="from_name", default=None, help=sender_help)
        selection.add_argument("--mention", type=int, default=None, metavar="INDEX",
            help="exact selected @@ identity from `mentions`; server scopes its team and sender")
    sender_options(inbox_command)
    inbox_command.add_argument("--since", default=None, help="ISO-8601 timestamp or epoch seconds")
    inbox_command.set_defaults(handler=inbox)

    feed_command = listing("feed", "shared Team Network Bulletin posts", aliases=("bulletin",))
    sender_options(feed_command)
    feed_command.add_argument("--since", default=None)
    feed_command.set_defaults(handler=feed)

    sent_command = listing("sent", "messages this server sent")
    sent_command.set_defaults(handler=sent)

    read_command = commands.add_parser(
        "read", help="read one message with its attachments", allow_abbrev=False
    )
    read_command.add_argument("message_id")
    read_command.add_argument("--download", action="store_true", help="fetch attachments into the local team cache and print their paths")
    read_command.add_argument("--team", default=None)
    read_command.add_argument("--include-mail-subject", action="store_true", help="request the mail subject from a compatible Team Hub")
    read_command.add_argument("--include-revision", action="store_true", help="request the current Bulletin revision version before editing")
    read_command.set_defaults(handler=read)

    skills_command = commands.add_parser(
        "skills", help="list the team Skills library", allow_abbrev=False
    )
    skills_command.add_argument("--include-archived", action="store_true")
    skills_command.add_argument("--team", default=None)
    skills_command.set_defaults(handler=skills)

    skill_command = commands.add_parser(
        "skill", help="skill operations", allow_abbrev=False
    )
    skill_sub = skill_command.add_subparsers(dest="skill_command", required=True)
    skill_get_command = skill_sub.add_parser(
        "get",
        help="read one skill (latest version by default)",
        allow_abbrev=False,
    )
    skill_get_command.add_argument("slug")
    skill_get_command.add_argument("--version", type=int, default=None)
    skill_get_command.add_argument("--download", action="store_true")
    skill_get_command.add_argument("--team", default=None)
    skill_get_command.set_defaults(handler=skill_get)

    routes_command = commands.add_parser(
        "routes",
        help="list this run's @@ recipient routes",
        allow_abbrev=False,
    )
    routes_command.set_defaults(handler=routes)

    def message_send_options(command: argparse.ArgumentParser) -> None:
        command.add_argument("--route", required=True)
        command.add_argument("--title", default=None, help="optional single-line mail subject (max 160 characters; requires Hub support), or required skill title")
        command.add_argument("--attach", action="append", default=[], metavar="/abs/path")
        command.add_argument("--idempotency-key", help=argparse.SUPPRESS)

    send_command = commands.add_parser(
        "send",
        help="send one message to a route; the Markdown body is read from stdin",
        allow_abbrev=False,
    )
    message_send_options(send_command)
    send_command.add_argument("--kind", choices=("message", "skill"), default="message")
    send_command.add_argument(
        "--in-reply-to", default=None, metavar="MESSAGE_ID",
        help="reply to this message using its sender's frozen @@ route; no reply-all (message kind only)",
    )
    send_command.add_argument("--skill-slug", default=None)
    send_command.add_argument("--summary", default=None)
    send_command.add_argument("--tags", default=None, help="comma-separated tags")
    send_command.add_argument("--change-note", default=None)
    send_command.add_argument("--expected-version", type=int, default=None)
    send_command.set_defaults(handler=send)

    reply_command = commands.add_parser(
        "reply",
        help="reply to a message sender through this turn's frozen @@ sender route; no reply-all",
        description="Reply only to the message sender using a frozen route from this turn's explicit @@ sender mention; no reply-all. The Markdown body is read from stdin.",
        allow_abbrev=False,
    )
    reply_command.add_argument("in_reply_to", metavar="MESSAGE_ID")
    message_send_options(reply_command)
    reply_command.set_defaults(
        handler=send, kind="message", skill_slug=None, summary=None, tags=None,
        change_note=None, expected_version=None,
    )
    edit_command = commands.add_parser(
        "edit", help="edit the body of one existing Bulletin message by exact ID and version",
        description="Read MESSAGE_ID --include-revision first, then edit that exact Bulletin message through an authorized Bulletin route. The replacement Markdown body is read from stdin. Title, attachments, and skill data are preserved. Unsupported servers and stale versions fail without creating a new post.",
        allow_abbrev=False,
    )
    edit_command.add_argument("message_id", metavar="MESSAGE_ID")
    edit_command.add_argument("--route", required=True)
    edit_command.add_argument("--expected-version", type=int, required=True)
    edit_command.add_argument("--idempotency-key", help=argparse.SUPPRESS)
    edit_command.set_defaults(handler=edit)
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
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
        return 0
    except CLIError as exc:
        print(f"agentsdock-team: {exc}", file=sys.stderr)
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
