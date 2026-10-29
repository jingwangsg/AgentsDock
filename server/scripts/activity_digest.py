"""Print a Markdown digest of what the user did on AgentsDock in one time window.

The scheduled jobs of the digest assistant chat run this and summarise its
output: every half hour for the half hour that just ended, at midnight for
the day that ended (Asia/Shanghai). It sends only GET requests, to the local
hub and through the hub's proxy to its visible remotes, with the token from
the local env file. Reading a chat has the server-side effect of opening it
in the app: the server may catch the chat up with its provider transcript.

  activity_digest.py --since 30m --exclude <digest chat id>
  activity_digest.py --day yesterday --exclude <digest chat id>

The user's messages are turns without a purpose that were not imported from
a provider transcript: typed, queued or steered. Scheduled job runs, mailbox
wakes and cross-chat mail are agent activity. A standalone job's run chats
are not read; the chat that owns the job reports each run.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ENV_FILE = Path.home() / ".config/agentsdock-local/env"
TZ = ZoneInfo("Asia/Shanghai")
PAGE_LIMIT = 500
REQUEST_TIMEOUT_SECONDS = 20
# Per mode: pages of compact events read per chat, characters kept per quoted
# message and per result, and UTF-8 bytes printed in total. Codex hands the
# model about 10k tokens of a command's output and drops the middle of longer
# output; a day's 45 KB of mixed Chinese and English measured 11.3k tokens.
LIMITS = {
    "window": {"pages": 2, "quote_chars": 800, "result_chars": 600, "output_bytes": 20_000},
    "day": {"pages": 8, "quote_chars": 300, "result_chars": 160, "output_bytes": 32_000},
}
# Values of secret-named keys (key: value, key=value, "key": "value",
# --key value, where the name may continue only after _ or -, so tokenizer
# and max_tokens are left alone), Bearer tokens, URL credentials, tokens
# with a known prefix, and hex strings of 32 or more digits (which include
# full commit hashes). Character classes stay ASCII: Python's \w would also
# match a run of Chinese text.
SECRET_RE = re.compile(
    r"""(?i)(?:token|password|passwd|secret|api[_-]?key|密码)(?:[_-][a-z0-9_-]*)?["']?\s*[:=：]\s*["']?[^\s"',}]+"""
    r"|--(?:token|password|passwd|secret|api-?key)(?:-[a-z0-9-]*)?\s+\S+"
    r"|\bbearer\s+\S+"
    r"|(?<=://)[^\s/:@]+:[^\s/@]+(?=@)"
    r"|(?<![a-z0-9_-])(?:sk-|ghp_|gho_|github_pat_|xox[abp]-|hf_|AKIA)[a-z0-9_-]{16,}"
    r"|(?<![a-z0-9])[0-9a-f]{32,}(?![a-z0-9])"
)


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def clip(text: str, limit: int) -> str:
    """One line of `text` with secrets redacted, at most `limit` characters."""
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
    # run_id -> {started, purpose, job_title, finished, result, stopped,
    # last_text, end, running}. `end` is when the run stopped holding the
    # chat: its end event, the next turn's start, or the chat's latest event.
    runs: dict[str, dict] = {}
    # run_id -> the same fields for the runs of this chat's standalone jobs.
    # Each runs in a run chat of its own, which the digest does not read; this
    # chat records its start (job_ran with run_session_id) and its end
    # (job_finished). A run chat works beside this chat, so its run ends none
    # of this chat's turns and does not make this chat running.
    standalone_runs: dict[str, dict] = {}
    # run_id or queued_id -> {at, text, run_id or queued_id}; the message's
    # run is attached after the loop.
    messages: dict[str, dict] = {}
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
            # A chat runs one turn at a time. A run that never got its end
            # event ended when the next one started.
            for run in runs.values():
                run.setdefault("end", at)
            runs[run_id] = {"started": at, "purpose": event.get("purpose"), "job_title": event.get("job_title")}
            prompt = (event.get("prompt") or "").strip()
            if event.get("purpose") is None and prompt:
                if event.get("queued_id"):
                    # Counted as the user's message when it was queued.
                    queued_runs[event["queued_id"]] = run_id
                else:
                    messages[run_id] = {"at": at, "text": prompt, "run_id": run_id}
        elif kind == "turn_queued" and event.get("purpose") is None and (event.get("prompt") or "").strip():
            messages[event["queued_id"]] = {"at": at, "text": event["prompt"], "queued_id": event["queued_id"]}
        elif kind == "turn_queue_updated" and event.get("queued_id") in messages:
            messages[event["queued_id"]]["text"] = event.get("prompt") or messages[event["queued_id"]]["text"]
        elif kind == "turn_unqueued" and event.get("reason") != "native_delivery_fence":
            # The user removed the queued message before it ran. A fence
            # precedes a steer into a running Codex goal; the steer follows.
            messages.pop(event.get("queued_id"), None)
        elif kind == "turn_steered" and run_id and event.get("queued_id"):
            queued_runs[event["queued_id"]] = run_id
        elif kind in ("turn_finished", "turn_stopped", "job_finished") and run_id:
            # turn_stopped ends a run on Stop and when a restart interrupted it.
            run = (standalone_runs if kind == "job_finished" else runs).setdefault(run_id, {})
            run.setdefault("finished", at)
            run.setdefault("end", at)
            run["stopped"] = run.get("stopped") or kind == "turn_stopped" or bool(event.get("stopped"))
            run["result"] = event.get("result_text") or run.get("result") or ""
        elif kind == "job_ran" and run_id and event.get("run_session_id"):
            job = event.get("job") or {}
            standalone_runs.setdefault(run_id, {}).update(started=at, purpose="scheduled_job", job_title=job.get("title"))
        elif kind == "assistant_text" and run_id:
            runs.setdefault(run_id, {})["last_text"] = event.get("text") or ""
        elif kind == "artifact_created" and since <= at < until:
            artifact = event.get("artifact") or {}
            files.append(artifact.get("title") or artifact.get("filename") or "file")
        elif kind == "chat_conversation_message_received" and since <= at < until:
            mail.append((at, event.get("source_title") or "another chat", event.get("handoff_preview") or ""))

    # Only the latest turn can still be open, while several standalone runs
    # can. An open run has run up to the chat's latest event.
    for run in [*runs.values(), *standalone_runs.values()]:
        if "end" not in run:
            run.update(end=last_event_at, running=True)
    for message in messages.values():
        message["run"] = runs.get(message.get("run_id") or queued_runs.get(message.get("queued_id"), ""))
    # A run seen only by its end or its text started before the fetched events.
    active = [run for run in runs.values() if run.get("started", since) < until and run["end"] >= since]
    # A standalone run is listed while it overlaps the window, also when it
    # started earlier: its run chat is not read, so this is its only report.
    # One seen only by its end has no start time to print.
    standalone_active = [
        run for run in standalone_runs.values() if "started" in run and run["started"] < until and run["end"] >= since
    ]
    agent_runs = [run for run in active if run.get("purpose") and run["started"] >= since] + standalone_active
    return {
        "messages": sorted((m for m in messages.values() if since <= m["at"] < until), key=lambda m: m["at"]),
        "agent_runs": sorted(agent_runs, key=lambda run: run["started"]),
        "active": active,
        "standalone_active": standalone_active,
        "running": any(run.get("running") or run["end"] > until for run in active),
        "files": files,
        "mail": mail,
    }


def latest_progress(hub: Hub, prefix: str, session_id: str, since: datetime, until: datetime) -> list[str]:
    """The chat's newest model text and tool calls in [since, until)."""
    page = hub.get(f"{prefix}/api/sessions/{session_id}", tail="true", visible="true", limit=80)
    texts, tools = [], []
    for event in page.get("events") or []:
        if not since <= parse_ts(event["ts"]) < until:
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


def outcome(run: dict | None, limit: int) -> str:
    if not run:
        return "queued, not started yet"
    if run.get("running"):
        return "still running"
    if "finished" not in run:
        return "ended without a recorded result"
    text = clip(run.get("result") or run.get("last_text") or "", limit)
    state = "stopped" if run.get("stopped") else "finished"
    return f"{run['finished'].astimezone(TZ):%H:%M} {state}" + (f": {text}" if text else "")


def render_chat(session: dict, server: str, digest: dict, limits: dict) -> list[str]:
    lines = [
        f"## {clip(session.get('title') or session['id'], 80)} · {server} · folder {session.get('folder') or '-'}"
        f" · {'running' if digest['running'] else 'idle'} at the end"
    ]
    messages = digest["messages"]
    if messages:
        lines.append("User messages:")
    for index, message in enumerate(messages):
        lines.append(f"- {message['at'].astimezone(TZ):%H:%M} 「{clip(message['text'], limits['quote_chars'])}」")
        # Messages steered into one run share its outcome: print it once, after the last.
        following = messages[index + 1]["run"] if index + 1 < len(messages) else None
        if message["run"] is None or message["run"] is not following:
            lines.append(f"  → {outcome(message['run'], limits['result_chars'])}")
    for run in digest["agent_runs"]:
        label = f"scheduled job “{run['job_title']}”" if run.get("job_title") else run["purpose"]
        lines.append(f"- {run['started'].astimezone(TZ):%H:%M} agent turn ({label}) → {outcome(run, limits['result_chars'])}")
    for at, source, preview in digest["mail"]:
        lines.append(f"- {at.astimezone(TZ):%H:%M} mail from “{clip(source, 60)}”: {clip(preview, 200)}")
    if digest["files"]:
        lines.append("Files: " + "; ".join(clip(name, 100) for name in digest["files"]))
    return lines


def window_bounds(args: argparse.Namespace, now: datetime) -> tuple[datetime, datetime, str]:
    if args.since:
        seconds = int(args.since.removesuffix("m")) * 60
        # End at the last whole slot (:00 or :30 for 30m), so a run that
        # starts late still covers the window next to the previous run's.
        until = datetime.fromtimestamp(now.timestamp() // seconds * seconds, timezone.utc)
        return until - timedelta(seconds=seconds), until, "window"
    day = now.astimezone(TZ).date() - timedelta(days=1) if args.day == "yesterday" else date.fromisoformat(args.day)
    since = datetime.combine(day, time(), tzinfo=TZ)
    until = datetime.combine(day + timedelta(days=1), time(), tzinfo=TZ)
    return since.astimezone(timezone.utc), until.astimezone(timezone.utc), "day"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    when = parser.add_mutually_exclusive_group(required=True)
    when.add_argument("--since", help="the last whole window of N minutes, e.g. 30m")
    when.add_argument("--day", help="yesterday or YYYY-MM-DD, in Asia/Shanghai")
    parser.add_argument("--exclude", action="append", default=[], help="chat id to leave out (repeatable)")
    args = parser.parse_args()

    since, until, mode = window_bounds(args, datetime.now(timezone.utc))
    hub = Hub(*read_hub(ENV_FILE))
    servers = [("local hub", "")]
    notes = []
    complete = True
    try:
        remotes = hub.get("/api/admin/remote-servers").get("servers") or []
        servers += [(remote["name"], f"/api/remote/{remote['id']}") for remote in remotes if not remote.get("hidden")]
    except Exception as exc:
        notes.append(f"remote list unreadable ({error_text(exc)})")
        complete = False

    sections = []
    for server, prefix in servers:
        try:
            sessions = hub.get(f"{prefix}/api/sessions").get("sessions") or []
        except Exception as exc:
            notes.append(f"{server}: unreachable ({error_text(exc)})")
            # A remote the hub cannot reach is out of the user's reach too.
            if not prefix:
                complete = False
            continue
        # Run chats of standalone jobs are skipped: the owner chat reports
        # each run, and a job that runs every minute makes 1,440 run chats a
        # day, each read costing the server a page and a history sync.
        candidates = [
            session for session in sessions
            if session["id"] not in args.exclude
            and not session.get("scheduled_job_run")
            and session.get("latest_event_at") and parse_ts(session["latest_event_at"]) >= since
        ]
        notes.append(f"{server}: {len(candidates)} chats with events")
        for session in candidates:
            # load-bearing: one unreadable chat must not cost the whole digest.
            try:
                events = compact_events(hub, prefix, session["id"], since, LIMITS[mode]["pages"])
                digest = summarize_chat(events, since, until, parse_ts(session["latest_event_at"]))
                progress = []
                if mode == "window" and digest["active"] and not digest["messages"]:
                    progress = latest_progress(hub, prefix, session["id"], since, until)
            except Exception as exc:
                notes.append(f"{server} chat “{clip(session.get('title'), 60)}” unreadable ({error_text(exc)})")
                complete = False
                continue
            # Without the user's messages, a chat belongs in a half-hour digest
            # only through what its agent did in the window.
            agent_work = progress if mode == "window" else digest["active"]
            if not (digest["messages"] or digest["agent_runs"] or digest["files"] or digest["mail"] or agent_work):
                continue
            lines = render_chat(session, server, digest, LIMITS[mode]) + progress
            if mode == "day":
                hours = set()
                for run in digest["active"] + digest["standalone_active"]:
                    hour = max(run.get("started", since), since).astimezone(TZ).replace(minute=0, second=0, microsecond=0)
                    while hour < min(run["end"], until):
                        hours.add(hour.hour)
                        hour += timedelta(hours=1)
                lines.append("Active hours: " + (", ".join(f"{hour:02d}" for hour in sorted(hours)) or "-"))
            first_message_at = digest["messages"][0]["at"] if digest["messages"] else until
            sections.append((first_message_at, lines))

    print(f"# AgentsDock activity {since.astimezone(TZ):%Y-%m-%d %H:%M} – {until.astimezone(TZ):%Y-%m-%d %H:%M} (Asia/Shanghai)")
    print("Servers: " + "; ".join(notes))
    if not complete:
        print("READ_ERRORS: some reads failed (see Servers), so activity may be missing.")
    if not sections:
        if complete:
            print("NO_ACTIVITY: no user messages and no agent work in this window.")
        return 0
    # Chats where the user spoke come first, in the order they first spoke.
    sections.sort(key=lambda section: section[0])
    # Bytes are handed out from the smallest chat up: each chat gets its full
    # size or an equal share of what is left, whichever is less. A long chat
    # is cut instead of pushing the chats after it out of the output.
    sizes = [sum(len(line.encode()) + 1 for line in lines) for _, lines in sections]
    allowances = [0] * len(sections)
    budget = LIMITS[mode]["output_bytes"]
    by_size = sorted(range(len(sections)), key=lambda index: sizes[index])
    for rank, index in enumerate(by_size):
        allowances[index] = min(sizes[index], budget // (len(sections) - rank))
        budget -= allowances[index]
    blocks = []
    for (_, lines), allowance in zip(sections, allowances):
        kept = []
        for line in lines:
            allowance -= len(line.encode()) + 1
            # The chat's header line is kept even when its share is smaller.
            if allowance < 0 and kept:
                kept.append(f"({len(lines) - len(kept)} more lines left out to fit the output limit)")
                break
            kept.append(line)
        blocks.append("\n".join(kept))
    print("\n\n".join(blocks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
