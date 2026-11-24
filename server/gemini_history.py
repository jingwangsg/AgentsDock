"""Discover native Gemini CLI JSONL chats and replay their public text revisions."""
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import os
import re
from pathlib import Path
from typing import Iterator
from uuid import UUID

from cursor_history import safe_path
from pinned_jsonl import pinned_records, regular_stamp
from server_instances import read_regular


CONTEXT_LABEL = "AgentsDock Gemini turn context"
MAX_DISCOVERY_BYTES = 16 * 1024 * 1024
MAX_PICKER_TRANSCRIPT_BYTES = 256 * 1024
MAX_PICKER_TOTAL_BYTES = 8 * 1024 * 1024


def user_prompt_text(content: str) -> str:
    # The length also disambiguates user text and instructions quoting the footer.
    prefix = re.match(r"^\[AgentsDock Gemini turn context; chars=(\d{1,9})\]\n", content)
    if prefix:
        end = prefix.end() + int(prefix[1])
        boundary = f"\n[End {CONTEXT_LABEL}]\n\n[Current user prompt]\n"
        if content.startswith(boundary, end):
            return content[end + len(boundary):]
    return content


def session_id(value):
    try:
        return value if isinstance(value, str) and str(UUID(value)) == value else None
    except ValueError:
        return None


@dataclass(frozen=True)
class Session:
    provider_id: str
    cwd: str
    path: Path
    updated: float
    size: int


def local_sessions(*, cwd: str | None = None, provider_id: str | None = None) -> Iterator[Session]:
    home = Path(os.environ.get("GEMINI_CLI_HOME") or Path.home())
    base = home / (".cache/.gemini" if os.environ.get("SANDBOX") == "sandbox-exec" else ".gemini")
    root = base / "tmp"
    if not root.is_dir() or not safe_path(root, base):
        return
    try:
        projects = os.scandir(root)
    except OSError:
        return
    with projects:
        remaining = 10000
        read_budget = MAX_DISCOVERY_BYTES
        for entry in projects:
            project = Path(entry.path)
            remaining -= 1
            if remaining <= 0:
                return
            marker, chats = project / ".project_root", project / "chats"
            if not safe_path(chats, base) or not chats.is_dir():
                continue
            try:
                marker_size = marker.lstat().st_size
                if marker_size > 8192:
                    continue
                if marker_size + 1 > read_budget:
                    return
                read_budget -= marker_size + 1
                workspace = read_regular(marker, max_bytes=marker_size).decode().strip()
                if not Path(workspace).is_absolute() or not Path(workspace).is_dir():
                    continue
                if cwd and Path(cwd).resolve() != Path(workspace):
                    continue
                digest = hashlib.sha256(workspace.encode()).hexdigest()
                for path in chats.iterdir():
                    remaining -= 1
                    if remaining <= 0:
                        return
                    if not (path.name.startswith("session-") and path.suffix == ".jsonl"):
                        continue
                    if provider_id and not path.stem.endswith("-" + provider_id[:8]):
                        continue
                    try:
                        stamp = regular_stamp(path)
                        header_bytes = min(stamp[2], 8192)
                        if header_bytes > read_budget:
                            return
                        read_budget -= header_bytes
                        records = pinned_records(path, stamp, end=header_bytes, max_line_bytes=8192)
                        try:
                            header = next(records)[0]
                        finally:
                            records.close()
                        native_id = session_id(header.get("sessionId"))
                        if (native_id and (not provider_id or native_id == provider_id)
                                and path.stem.endswith("-" + native_id[:8]) and header.get("kind") == "main"
                                and header.get("projectHash") == digest):
                            yield Session(native_id, workspace, path, stamp[3] / 1e9, stamp[2])
                    except (ValueError, OSError, StopIteration, RecursionError):
                        continue
            except (ValueError, OSError):
                continue


def read_transcript(session: Session, *, max_bytes: int, max_line_bytes: int, max_records: int):
    stamp = regular_stamp(session.path)
    if stamp[2] > max_bytes:
        raise ValueError("Gemini transcript exceeds the import limit.")
    identity = {"sessionId": session.provider_id, "kind": "main",
                "projectHash": hashlib.sha256(session.cwd.encode()).hexdigest()}
    messages = OrderedDict()
    summary = None
    for index, (event, _, _) in enumerate(pinned_records(
        session.path, stamp, max_line_bytes=max_line_bytes, max_records=max_records,
    )):
        if index == 0 and any(event.get(k) != v for k, v in identity.items()):
            raise ValueError("Gemini transcript changed identity.")
        if "$rewindTo" in event:
            summary = None
            rewind = event["$rewindTo"]
            if not isinstance(rewind, str):
                raise ValueError("Invalid Gemini rewind target.")
            if rewind in messages:
                while messages.popitem()[0] != rewind:
                    pass
            else:
                messages.clear()
        elif "$patch" in event:
            patch = event["$patch"]
            if not isinstance(patch, dict) or any(
                not isinstance(patch.get(k, []), list) for k in ("updates", "orderIds", "removeIds")
            ):
                raise ValueError("Invalid Gemini message patch.")
            for update in (patch, *patch.get("updates", [])):
                key = update.get("id") if isinstance(update, dict) else None
                if isinstance(key, str) and key in messages and "content" in update:
                    if messages[key][1] != update["content"]:
                        summary = None
                    messages[key] = (messages[key][0], update["content"])
            if patch.get("removeIds") or patch.get("orderIds"):
                summary = None
            for key in patch.get("removeIds", []):
                if isinstance(key, str):
                    messages.pop(key, None)
            for key in patch.get("orderIds", []):
                if isinstance(key, str) and key in messages:
                    messages.move_to_end(key)
        else:
            metadata = event.get("$set", event)
            if not isinstance(metadata, dict) or not isinstance(metadata.get("messages", []), list):
                raise ValueError("Invalid Gemini session metadata.")
            if any(k in metadata and metadata[k] != v for k, v in identity.items()):
                raise ValueError("Gemini transcript changed identity.")
            if "$set" in event and "messages" in metadata:
                messages.clear()
                summary = None
            for row in metadata.get("messages", [event]):
                if isinstance(row, dict) and isinstance(row.get("id"), str):
                    value = row.get("type"), row.get("content")
                    if row["id"] in messages and messages[row["id"]] != value:
                        summary = None
                    messages[row["id"]] = value
            if "summary" in metadata and ("$set" in event or "sessionId" in metadata):
                summary = metadata["summary"] if isinstance(metadata["summary"], str) else None

    return summary, messages.values()


def public_messages(session: Session, *, max_bytes: int, max_line_bytes: int, max_records: int):
    _, rows = read_transcript(session, max_bytes=max_bytes, max_line_bytes=max_line_bytes, max_records=max_records)
    yield from public_message_rows(rows)


def public_message_rows(rows):
    for role, content in rows:
        if role not in ("user", "gemini"):
            continue
        if isinstance(content, list):
            content = "".join(p["text"] for p in content if isinstance(p, dict)
                              and isinstance(p.get("text"), str) and not p.get("thought"))
        if not isinstance(content, str) or not content.strip():
            continue
        if role == "user" and content.lstrip().startswith(("<session_context>", "<hook_context>")):
            continue
        yield ("assistant", content) if role == "gemini" else ("user", user_prompt_text(content))
