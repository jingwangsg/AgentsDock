"""Print a Markdown digest of what the user did on AgentsDock in one time window.

The scheduled jobs of the digest assistant chat run this and summarise its
output: every half hour for the last 30 minutes, at midnight for the day that
ended. It sends only GET requests, to the local hub and through the hub's
proxy to its visible remotes, with the token from the local env file.

  activity_digest.py --since 30m --exclude <digest chat id>
  activity_digest.py --day yesterday --exclude <digest chat id>

The user's own words are the messages they sent, queued or steered (turns
without a purpose that were not imported from a provider transcript).
Scheduled job runs, mailbox wakes and cross-chat mail are agent activity.
"""
from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULT_ENV_FILE = Path.home() / ".config/agentsdock-local/env"
PAGE_LIMIT = 500
REQUEST_TIMEOUT_SECONDS = 20
# Per mode: pages of compact events read per chat, characters kept per quoted
# message and per result, and UTF-8 bytes printed in total. Codex hands the
# model about 10k tokens of a command's output and drops the middle of longer
# output; a day's 45 KB of mixed Chinese and English measured 11.3k tokens.
LIMITS = {
    "window": {"pages": 2, "words": 800, "result": 600, "output_bytes": 20_000},
    "day": {"pages": 8, "words": 300, "result": 160, "output_bytes": 32_000},
}
SECRET_RE = re.compile(
    r"(?i)(?:token|password|passwd|secret|api[_-]?key)\w*\s*[:=]\s*\S+"
    r"|\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b"
)


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def clip(text: str, limit: int) -> str:
    text = SECRET_RE.sub("[redacted]", " ".join(str(text or "").split()))
    return text if len(text) <= limit else text[: limit - 1] + "…"


def read_hub(env_file: Path) -> tuple[str, str]:
    values = {}
    for line in env_file.read_text().splitlines():
        key, _, value = line.removeprefix("export ").partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return f"http://127.0.0.1:{values['AGENTSDOCK_AGENT_PORT']}", values["AGENTSDOCK_AGENT_TOKEN"]


class Hub:
    def __init__(self, base: str, token: str):
        self.base = base
        self.token = token
        # The hub is local; a configured HTTP proxy must not receive the token.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(self, path: str, **query) -> dict:
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        request = urllib.request.Request(url, headers={"X-AgentsDock-Token": self.token})
        with self.opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.load(response)


def error_text(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.load(exc).get("detail")
        except Exception:
            detail = None
        if isinstance(detail, dict):
            return f"HTTP {exc.code} {detail.get('code') or ''}: {detail.get('message') or ''}"
        return f"HTTP {exc.code} {detail or exc.reason}"
    return str(getattr(exc, "reason", None) or exc) or type(exc).__name__


def compact_events(hub: Hub, prefix: str, session_id: str, since: datetime, pages: int) -> list[dict]:
    """The chat's compact timeline from about `since` on, oldest first."""
    events: list[dict] = []
    before = None
    for _ in range(pages):
        query = {"tail": "true", "compact": "true", "limit": PAGE_LIMIT}
        if before is not None:
            query["before"] = before
        page = hub.get(f"{prefix}/api/sessions/{session_id}", **query)
        batch = page.get("events") or []
        events[:0] = batch
        if not batch or not page.get("events_omitted_before") or parse_ts(batch[0]["ts"]) < since:
            break
        before = batch[0]["seq"]
    return events


def summarize_chat(events: list[dict], since: datetime, until: datetime, last_event_at: datetime) -> dict:
    """What happened in one chat in [since, until), from its compact events."""
    runs: dict[str, dict] = {}
    words: dict[str, dict] = {}
    queued_runs: dict[str, str] = {}
    files, mail = [], []
    for event in events:
        kind = event.get("type")
        at = parse_ts(event["ts"])
        run_id = event.get("run_id")
        # Imported rows copy a provider transcript written outside AgentsDock.
        if event.get("imported"):
            continue
        if kind == "turn_started" and run_id:
            # A chat runs one turn at a time. A run without turn_finished (the
            # server restarted under it) ended when the next one started.
            for run in runs.values():
                run.setdefault("end", run.get("finished", at))
            runs[run_id] = {"started": at, "purpose": event.get("purpose"), "job_title": event.get("job_title")}
            prompt = (event.get("prompt") or "").strip()
            if event.get("purpose") is None and prompt:
                if event.get("queued_id"):
                    queued_runs[event["queued_id"]] = run_id
                else:
                    words[run_id] = {"at": at, "text": prompt, "run_id": run_id}
        elif kind == "turn_queued" and event.get("purpose") is None and not event.get("source_session_id"):
            if (event.get("prompt") or "").strip():
                words[event["queued_id"]] = {"at": at, "text": event["prompt"], "queued_id": event["queued_id"]}
        elif kind == "turn_queue_updated" and event.get("queued_id") in words:
            words[event["queued_id"]]["text"] = event.get("prompt") or words[event["queued_id"]]["text"]
        elif kind == "turn_steered" and run_id and event.get("queued_id"):
            queued_runs[event["queued_id"]] = run_id
        elif kind == "turn_finished" and run_id:
            run = runs.setdefault(run_id, {})
            run.update(finished=at, result=event.get("result_text") or "", stopped=bool(event.get("stopped")))
            run.setdefault("end", at)
        elif kind == "assistant_text" and run_id:
            runs.setdefault(run_id, {})["last_text"] = event.get("text") or ""
        elif kind == "artifact_created" and since <= at < until:
            artifact = event.get("artifact") or {}
            files.append(artifact.get("title") or artifact.get("filename") or "file")
        elif kind == "chat_conversation_message_received" and since <= at < until:
            mail.append((at, event.get("source_title") or "another chat", event.get("handoff_preview") or ""))

    # Only the latest run can still be open; it has run up to the chat's latest event.
    for run in runs.values():
        if "end" not in run:
            run.update(end=last_event_at, running=True)
    for word in words.values():
        word["run"] = runs.get(word.get("run_id") or queued_runs.get(word.get("queued_id"), ""))
    # A run seen only by its end or its text started before the fetched events.
    active = [run for run in runs.values() if run.get("started", since) < until and run["end"] >= since]
    return {
        "words": sorted((w for w in words.values() if since <= w["at"] < until), key=lambda w: w["at"]),
        "agent_runs": [run for run in active if run.get("purpose") and run.get("started", since) >= since],
        "active": active,
        "running": any(run.get("running") or run["end"] > until for run in active),
        "files": files,
        "mail": mail,
    }


def latest_progress(hub: Hub, prefix: str, session_id: str, since: datetime) -> list[str]:
    """The newest model text and tool calls of the chat since `since`."""
    page = hub.get(f"{prefix}/api/sessions/{session_id}", tail="true", visible="true", limit=80)
    texts, tools = [], []
    for event in page.get("events") or []:
        if parse_ts(event["ts"]) < since:
            continue
        if event.get("type") in ("assistant_text", "reasoning_summary"):
            texts.append(event.get("text") or "")
        elif event.get("type") == "tool_started":
            tool = event.get("tool") or {}
            given = tool.get("input") if isinstance(tool.get("input"), dict) else {}
            detail = given.get("description") or given.get("command") or given.get("file_path") or ""
            tools.append(f"{tool.get('name') or 'tool'} {detail}".strip())
    lines = [f"Latest model text: {clip(texts[-1], 400)}"] if texts else []
    if tools:
        lines.append("Latest tools: " + "; ".join(clip(tool, 120) for tool in tools[-3:]))
    return lines


def outcome(run: dict | None, tz: ZoneInfo, limit: int) -> str:
    if not run:
        return "queued, not started yet"
    if run.get("running"):
        return "still running"
    if "finished" not in run:
        return "ended without a recorded result"
    text = clip(run.get("result") or run.get("last_text") or "", limit)
    state = "stopped" if run.get("stopped") else "finished"
    return f"{run['finished'].astimezone(tz):%H:%M} {state}" + (f": {text}" if text else "")


def active_hours(active: list[dict], since: datetime, until: datetime, tz: ZoneInfo) -> str:
    hours = set()
    for run in active:
        hour = max(run.get("started", since), since).astimezone(tz).replace(minute=0, second=0, microsecond=0)
        end = min(run["end"], until)
        while hour < end:
            hours.add(hour.hour)
            hour += timedelta(hours=1)
    return ", ".join(f"{hour:02d}" for hour in sorted(hours)) or "-"


def render_chat(session: dict, server: str, digest: dict, limits: dict, tz: ZoneInfo, extra: list[str]) -> list[str]:
    runtime = " ".join(filter(None, (session.get("backend"), session.get("model"))))
    lines = [
        f"## {clip(session.get('title') or session['id'], 80)} · {server} · folder {session.get('folder') or '-'}"
        f" · {runtime} · {'running' if digest['running'] else 'idle'} at the end"
    ]
    if digest["words"]:
        lines.append("User messages:")
        for word in digest["words"]:
            lines.append(f"- {word['at'].astimezone(tz):%H:%M} 「{clip(word['text'], limits['words'])}」")
            lines.append(f"  → {outcome(word['run'], tz, limits['result'])}")
    for run in digest["agent_runs"]:
        label = f"scheduled job “{run['job_title']}”" if run.get("job_title") else run["purpose"]
        lines.append(f"- {run['started'].astimezone(tz):%H:%M} agent turn ({label}) → {outcome(run, tz, limits['result'])}")
    for at, source, preview in digest["mail"]:
        lines.append(f"- {at.astimezone(tz):%H:%M} mail from “{clip(source, 60)}”: {clip(preview, limits['result'])}")
    if digest["files"]:
        lines.append("Files: " + "; ".join(clip(name, 100) for name in digest["files"]))
    return lines + extra


def window_bounds(args: argparse.Namespace, now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime, str]:
    if args.since:
        unit = {"m": "minutes", "h": "hours"}[args.since[-1]]
        return now - timedelta(**{unit: int(args.since[:-1])}), now, "window"
    today = now.astimezone(tz).date()
    day = {"today": today, "yesterday": today - timedelta(days=1)}.get(args.day)
    day = day or datetime.strptime(args.day, "%Y-%m-%d").date()
    since = datetime(day.year, day.month, day.day, tzinfo=tz)
    # Add the day in local time so a DST change yields 23 or 25 hours.
    until = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=tz)
    return since.astimezone(timezone.utc), until.astimezone(timezone.utc), "day"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    when = parser.add_mutually_exclusive_group(required=True)
    when.add_argument("--since", help="window ending now, e.g. 30m or 2h")
    when.add_argument("--day", help="YYYY-MM-DD, today or yesterday, in --tz")
    parser.add_argument("--tz", default="Asia/Shanghai")
    parser.add_argument("--exclude", action="append", default=[], help="chat id to leave out (repeatable)")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    args = parser.parse_args()

    tz = ZoneInfo(args.tz)
    since, until, mode = window_bounds(args, datetime.now(timezone.utc), tz)
    hub = Hub(*read_hub(args.env_file))
    servers = [("local hub", "")]
    server_notes = []
    try:
        remotes = hub.get("/api/admin/remote-servers").get("servers") or []
        servers += [(remote["name"], f"/api/remote/{remote['id']}") for remote in remotes if not remote.get("hidden")]
    except Exception as exc:
        server_notes.append(f"remote list unreadable ({error_text(exc)})")

    sections = []
    for server, prefix in servers:
        try:
            sessions = hub.get(f"{prefix}/api/sessions").get("sessions") or []
        except Exception as exc:
            server_notes.append(f"{server}: unreachable ({error_text(exc)})")
            continue
        candidates = [
            session for session in sessions
            if session["id"] not in args.exclude
            and session.get("latest_event_at") and parse_ts(session["latest_event_at"]) >= since
        ]
        server_notes.append(f"{server}: {len(candidates)} chats with events")
        for session in candidates:
            try:
                events = compact_events(hub, prefix, session["id"], since, LIMITS[mode]["pages"])
                digest = summarize_chat(events, since, until, parse_ts(session["latest_event_at"]))
                if not (digest["words"] or digest["active"] or digest["files"] or digest["mail"]):
                    continue
                extra = []
                if mode == "day":
                    extra = ["Active hours: " + active_hours(digest["active"], since, until, tz)]
                elif not digest["words"]:
                    # Without the user's words, a chat belongs in the
                    # half-hour digest only through what its agent did then.
                    extra = latest_progress(hub, prefix, session["id"], since)
                    if not (extra or digest["agent_runs"] or digest["files"] or digest["mail"]):
                        continue
            except Exception as exc:
                server_notes.append(f"{server} chat “{clip(session.get('title'), 60)}” unreadable ({error_text(exc)})")
                continue
            first_word_at = digest["words"][0]["at"] if digest["words"] else until
            sections.append((not digest["words"], first_word_at, render_chat(session, server, digest, LIMITS[mode], tz, extra)))

    print(f"# AgentsDock activity {since.astimezone(tz):%Y-%m-%d %H:%M} – {until.astimezone(tz):%Y-%m-%d %H:%M} ({args.tz})")
    print("Servers: " + "; ".join(server_notes))
    if not sections:
        print("NO_ACTIVITY: no user messages and no agent work in this window.")
        return 0
    # Chats where the user spoke come first, in the order they first spoke.
    blocks, budget = [], LIMITS[mode]["output_bytes"]
    for _, _, lines in sorted(sections, key=lambda section: section[:2]):
        block = "\n".join(lines)
        if len(block.encode()) > budget:
            blocks.append(f"(output limit reached; {len(sections) - len(blocks)} more chats left out)")
            break
        budget -= len(block.encode())
        blocks.append(block)
    print("\n\n".join(blocks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
