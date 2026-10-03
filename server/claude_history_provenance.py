"""Pure, bounded Claude source-lineage classification. Never edits transcripts.

The marker's wording is not evidence of a human Stop action. A synthetic user
record must belong to an already established prompt, not begin a new prompt.
Only source identifiers are carried between byte-cursor reads; never chat text.
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
import json
from pathlib import Path
import re


INTERRUPTION_MARKERS = frozenset({
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
})
_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)\Z")
_MAX_BRANCH_EVENTS = 128


def _uuid(value) -> str | None:
    return value if isinstance(value, str) and _UUID.fullmatch(value) else None


def _timestamp(value) -> str | None:
    if not isinstance(value, str) or not _TIME.fullmatch(value):
        return None
    try:
        return value if datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo else None
    except ValueError:
        return None


def normalize_claude_interruption_context(value, provider_session_id=None) -> dict:
    """Allowlist a tiny initialized cursor state, including conservative empties."""
    empty = {"version": 1}
    if not isinstance(value, dict) or value.get("version") != 1:
        return empty
    keys = ("session_id", "prompt_id", "anchor_event_id", "last_event_id")
    if any(not _uuid(value.get(key)) for key in keys):
        return empty
    if provider_session_id and value["session_id"] != provider_session_id:
        return empty
    context = {"version": 1, **{key: value[key] for key in keys}}
    branch_ids = value.get("branch_event_ids")
    if branch_ids is not None:
        if (not isinstance(branch_ids, list) or not 1 <= len(branch_ids) <= _MAX_BRANCH_EVENTS
                or any(not _uuid(item) for item in branch_ids)
                or context["last_event_id"] not in branch_ids):
            return empty
        context["branch_event_ids"] = list(dict.fromkeys(branch_ids))
    return context


class ClaudeInterruptionTracker:
    def __init__(self, initial_context=None):
        self._context = normalize_claude_interruption_context(initial_context)

    def export_context(self) -> dict:
        return normalize_claude_interruption_context(self._context)

    def consume(self, event) -> dict | None:
        if not isinstance(event, dict):
            self._context = {"version": 1}
            return None
        if event.get("isSidechain") is True:
            return None
        event_id = _uuid(event.get("uuid"))
        # Non-message queue bookkeeping has no UUID and is outside the lineage.
        if event_id is None:
            if not isinstance(event.get("type"), str) or event.get("type") in ("user", "assistant", "attachment"):
                self._context = {"version": 1}
            return None
        session_id = _uuid(event.get("sessionId"))
        parent_id = _uuid(event.get("parentUuid"))
        prompt_id = _uuid(event.get("promptId"))
        timestamp = _timestamp(event.get("timestamp"))
        message = event.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        blocks = content if isinstance(content, list) else []
        marker = (
            event.get("type") == "user"
            and isinstance(message, dict) and message.get("role") == "user"
            and len(blocks) == 1 and isinstance(blocks[0], dict)
            and blocks[0].get("type") == "text"
            and isinstance(blocks[0].get("text"), str)
            and blocks[0]["text"] in INTERRUPTION_MARKERS
        )
        context = self._context
        # Parallel tool results can be siblings of the same assistant record.
        # Keep their proven parents across incremental cursor reads; immediate
        # adjacency alone is not Claude's transcript ancestry contract.
        branch_ids = context.get("branch_event_ids", [context.get("last_event_id")])
        continued = (
            session_id is not None and session_id == context.get("session_id")
            and parent_id is not None and parent_id in branch_ids
            and (prompt_id is None or prompt_id == context.get("prompt_id"))
        )
        origin = None
        if marker and session_id and timestamp and (
            event.get("isMeta") is True
            or (continued and prompt_id is not None and prompt_id == context.get("prompt_id")
                and event_id != context.get("anchor_event_id")
                and parent_id != context.get("anchor_event_id"))
        ):
            origin = {
                "provider": "claude", "kind": "interruption", "cause": "unknown",
                "event_id": event_id, "session_id": session_id, "timestamp": timestamp,
            }
            if parent_id:
                origin["parent_event_id"] = parent_id
            if prompt_id:
                origin["prompt_id"] = prompt_id

        has_text = isinstance(content, str) and bool(content.strip()) or any(
            isinstance(block, dict) and block.get("type") == "text"
            and isinstance(block.get("text"), str) and bool(block["text"].strip())
            for block in blocks
        )
        tool_result = any(isinstance(block, dict) and block.get("type") == "tool_result" for block in blocks)
        real_prompt = (
            event.get("type") == "user" and isinstance(message, dict)
            and message.get("role") == "user" and has_text and not tool_result
            and not marker and event.get("isMeta") is not True
            and session_id and prompt_id and timestamp
        )
        if real_prompt:
            self._context = {"version": 1, "session_id": session_id, "prompt_id": prompt_id,
                             "anchor_event_id": event_id, "last_event_id": event_id,
                             "branch_event_ids": [event_id]}
        elif continued:
            self._context = {**context, "last_event_id": event_id,
                             "branch_event_ids": [*branch_ids, event_id][-_MAX_BRANCH_EVENTS:]}
        else:
            self._context = {"version": 1}
        return origin


# Built-in commands are stored name-first with an args element; custom
# commands and skills message-first, sometimes without args.
_COMMAND_WRAPPER = re.compile(
    r"(?:<command-message>[^<]*</command-message>\s*)?"
    r"<command-name>/([A-Za-z0-9_][A-Za-z0-9_.:-]{0,127})</command-name>\s*"
    r"(?:<command-message>[^<]*</command-message>\s*)?"
    r"(?:<command-args>([\s\S]*)</command-args>)?")
_LOCAL_COMMAND_OUTPUT = re.compile(r"<local-command-std(out|err)>[\s\S]*</local-command-std\1>")
_MAX_COMMAND_WRAPPERS = 32


class ClaudeCommandHistoryNormalizer:
    """Read a typed slash command as the command text; omit its local output.

    Claude Code stores a typed slash command as a user row holding a
    ``<command-name>`` wrapper and, when the command ran locally, its output
    as a second user row holding ``<local-command-stdout>`` (or ``stderr``)
    whose parent is that wrapper. Its UI prints the first as the command
    (``/compact``) and the second as command output, never as a message the
    person typed. The wrapper becomes that command text, so a command this
    chat ran itself also matches its own native turn and is not imported a
    second time. The output row has no place in the timeline, which has no
    item kind for command output and already omits every ``system`` row; it
    is omitted only behind a wrapper parent from the same session, so an
    output quotation with any other parent stays as submitted.
    """

    def __init__(self) -> None:
        self._wrappers: OrderedDict[str, str] = OrderedDict()

    def seed(self, path: Path, offset: int) -> None:
        """Replay the bytes just before a cursor so an output row finds its wrapper."""
        if offset <= 0:
            return
        try:
            with path.open("rb") as stream:
                start = max(0, offset - 65536)
                stream.seek(start)
                region = stream.read(offset - start)
        except OSError:
            return
        if start:
            region = region.partition(b"\n")[2]
        for line in region.splitlines():
            try:
                self.consume(json.loads(line))
            except (ValueError, RecursionError):
                continue

    def consume(self, event) -> dict | None:
        if not isinstance(event, dict) or event.get("type") != "user" or event.get("isSidechain") is True:
            return event
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "user" or not isinstance(message.get("content"), str):
            return event
        text = message["content"].strip()
        command = _COMMAND_WRAPPER.fullmatch(text)
        if command is not None:
            if isinstance(event.get("uuid"), str) and isinstance(event.get("sessionId"), str):
                self._wrappers[event["uuid"]] = event["sessionId"]
                while len(self._wrappers) > _MAX_COMMAND_WRAPPERS:
                    self._wrappers.popitem(last=False)
            args = (command[2] or "").strip()
            return {**event, "message": {**message, "content": "/" + command[1] + (" " + args if args else "")}}
        parent = event.get("parentUuid")
        if (_LOCAL_COMMAND_OUTPUT.fullmatch(text) and parent in self._wrappers
                and self._wrappers[parent] == event.get("sessionId")):
            return None
        return event
