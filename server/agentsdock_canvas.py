#!/usr/bin/env python3
"""Agent Canvas: server-side storage and compilation of `.canvas.tsx` reports.

A Canvas is a single React/TSX document an agent writes with its ordinary file
tools into a managed directory under the state dir, one directory per chat.
The bundled runtime (canvas_runtime/, shared with the Zed implementation) type
checks and compiles it with Node; clients render the result in a sandboxed page.
Files stay authoritative; the compiled bundle is a cache keyed by source hash.

Also usable as a CLI for agents:  agentsdock_canvas.py check <file.canvas.tsx>
"""
from __future__ import annotations

import asyncio
import functools
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

RUNTIME_DIR = Path(__file__).resolve().parent / "canvas_runtime"
CANVAS_SUFFIX = ".canvas.tsx"
STATE_SUFFIX = ".canvas.data.json"
COMMENTS_SUFFIX = ".canvas.comments.json"
BUILD_CACHE_PREFIX = "."
BUILD_CACHE_SUFFIX = ".canvas.build.json"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# A Canvas embeds its data: a 2.3 MiB research report compiled in 2 s to 6.6 MiB of JavaScript.
MAX_SOURCE_BYTES = 8 * 1024 * 1024
SOURCE_TOO_LARGE = f"Canvas source is larger than {MAX_SOURCE_BYTES // (1024 * 1024)} MiB"
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_COMMENTS_BYTES = 4 * 1024 * 1024
MAX_COMMENT_CHARS = 8_000
# The whole answer stays in the chat; a thread keeps enough to read in place.
MAX_REPLY_CHARS = 20_000
COMMENT_MODES = ("ask", "edit")
FINAL_REPLY_STATUSES = frozenset({"done", "failed", "stopped", "cancelled"})
TAG_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
COMPILE_TIMEOUT_SECONDS = 180
# The LEGAL file carries the bundled runtime's license notices into exported standalone pages.
RUNTIME_ASSETS = {"vendor.js": "application/javascript", "vendor.js.LEGAL.txt": "text/plain", "shell.html": "text/html"}
# Everything the served bundle, the compiler and the agent's guide depend on; runtime_version() digests them.
RUNTIME_FILES = ("AUTHORING.md", "compile.cjs", "katex.js", "markdown.js", "modules.json", "sdk.d.ts", "shell.html", "usage-bar.js", "vendor.js")
AGENT_FILES = ("AUTHORING.md", "sdk.d.ts")


# ---------------------------------------------------------------- runtime

@functools.lru_cache(maxsize=1)
def runtime_version() -> str | None:
    """sha256 over RUNTIME_FILES (each name, then its bytes, in that order).

    Clients cache shell.html and vendor.js per version and the build cache is
    keyed on it, so a change to any runtime file must change the version; a
    digest does that without a hand-maintained file. Cached for the process:
    the files change only with a redeploy, which restarts the server.
    """
    digest = hashlib.sha256()
    try:
        for name in RUNTIME_FILES:
            digest.update(name.encode("utf-8"))
            digest.update((RUNTIME_DIR / name).read_bytes())
    except OSError:
        return None
    return digest.hexdigest()


def runtime_asset_bytes(asset: str) -> bytes:
    # The SDK bundle has no source in this repository, so the Markdown component
    # is plain JavaScript in markdown.js, appended to vendor.js when served, with
    # katex.js (the formula renderer markdown.js calls) in between: clients still
    # fetch one script and key their caches on the runtime version. usage-bar.js
    # replaces the bundle's UsageBar the same way.
    parts = ("vendor.js", "usage-bar.js", "katex.js", "markdown.js") if asset == "vendor.js" else (asset,)
    return b"\n".join((RUNTIME_DIR / name).read_bytes() for name in parts)


def node_binary() -> str | None:
    return shutil.which("node")


def unavailable_reason() -> str | None:
    if not (RUNTIME_DIR / "compile.cjs").is_file() or not runtime_version():
        return "The Canvas runtime is missing from this AgentsServer install."
    if not node_binary():
        return "Canvas needs `node` on the AgentsServer PATH to compile reports."
    return None


def capability(state_dir: Path) -> dict[str, Any]:
    reason = unavailable_reason()
    return {
        "available": reason is None,
        "version": 1,
        "runtime_version": runtime_version(),
        # Clients gate the comment threads and the source editor on these.
        "comments": True,
        "source_edit": True,
        "message": reason or "Agents can author .canvas.tsx reports; clients render them beside the chat.",
    }


# ---------------------------------------------------------------- layout

def canvas_root(state_dir: Path) -> Path:
    return state_dir / "canvases"


def session_dir(state_dir: Path, session_id: str) -> Path:
    if not SESSION_ID_RE.match(session_id):
        raise ValueError("invalid session id")
    return canvas_root(state_dir) / session_id


def ensure_session_dir(state_dir: Path, session_id: str) -> Path:
    """Create the chat's Canvas directory with the authoring guide and SDK types the agent reads."""
    directory = session_dir(state_dir, session_id)
    directory.mkdir(parents=True, exist_ok=True)
    for name in AGENT_FILES:
        source = RUNTIME_DIR / name
        target = directory / name
        try:
            data = source.read_bytes()
        except OSError:
            continue
        if not target.exists() or target.read_bytes() != data:
            target.write_bytes(data)
    return directory


def canvas_path(directory: Path, name: str) -> Path:
    # NAME_RE admits no path separator, so the result is always a direct child of `directory`.
    if not NAME_RE.match(name):
        raise ValueError("invalid canvas name")
    return directory / f"{name}{CANVAS_SUFFIX}"


def canvas_name(path: Path) -> str:
    return path.name[: -len(CANVAS_SUFFIX)]


def state_path(path: Path) -> Path:
    return path.with_name(canvas_name(path) + STATE_SUFFIX)


def build_cache_path(path: Path) -> Path:
    return path.with_name(BUILD_CACHE_PREFIX + canvas_name(path) + BUILD_CACHE_SUFFIX)


def comments_path(path: Path) -> Path:
    return path.with_name(canvas_name(path) + COMMENTS_SUFFIX)


def replace_file(target: Path, text: str) -> None:
    """Write through a sibling temporary so a reader never sees a half-written file."""
    temporary = target.with_name(target.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(target)


def prompt_section(state_dir: Path, session_id: str, *, directory_label: str | None = None) -> str:
    """System prompt addendum telling the agent where and how to author a Canvas.

    ``directory_label`` (e.g. ``$AGENTSDOCK_CANVAS_DIR``) replaces the literal
    per-chat path so a system prompt stays byte-identical across chats; the
    caller must export that variable to the agent process.
    """
    reason = unavailable_reason()
    if reason:
        # Without this an agent asked for a Canvas quietly substitutes another format.
        return (
            "## Canvas\n"
            f"Canvas is unavailable on this server: {reason} "
            "If the user asks for a Canvas, tell them it is unavailable and why before offering another format."
        )
    directory = ensure_session_dir(state_dir, session_id)
    if directory_label:
        directory = Path(directory_label)
    check = f"{sys.executable} {Path(__file__).resolve()} check"
    return (
        "## Canvas\n"
        f"This chat has a managed Canvas directory: {directory}\n"
        "A Canvas is one standalone `<name>.canvas.tsx` interactive technical report that the user views beside the chat: "
        "it holds the full text, as a written report does, with prose in the SDK's Markdown component and the key numbers "
        "in one summary table; it is not a dashboard that links to the text elsewhere. "
        "Create one only when the artifact itself is the deliverable (reports, tutorials, comparisons). "
        f"Before writing or editing a Canvas, read {directory / 'AUTHORING.md'} and the SDK declarations at {directory / 'sdk.d.ts'}. "
        "Import only from `@zed/canvas`, default-export the component, and embed the data directly. "
        f"After saving, run `{check} {directory}/<name>.canvas.tsx` and fix every reported error. "
        "Name the file after what it shows (`training_loss_comparison`, not `canvas2`) and keep editing it for the same report. "
        "Finish with a short conclusion and a Markdown link to the absolute .canvas.tsx path whose text is the report's title "
        "(the app lists each Canvas by that text); do not paste the report into the chat."
    )


# ---------------------------------------------------------------- compile

def compile_source(source: str, timeout: float = COMPILE_TIMEOUT_SECONDS) -> tuple[str, str | None, bool]:
    """Run the runtime compiler. Returns (javascript, diagnostics, ran).

    `ran` is False when the compiler itself could not run (no node, timeout, crash):
    the diagnostics then describe the host, not the source, and must not be cached.
    """
    reason = unavailable_reason()
    if reason:
        return "", reason, False
    env = {key: value for key, value in os.environ.items() if key not in ("NODE_OPTIONS", "NODE_PATH")}
    try:
        # load-bearing: the compiler reads the source from a file, not from a pipe. subprocess feeds a pipe
        # select.PIPE_BUF bytes at a time (512 on macOS, 4096 on Linux) and waits for the GIL between
        # writes: with one other busy thread a 1.3 MB source took 17-47 s instead of 0.8 s.
        with tempfile.TemporaryFile() as stdin:
            stdin.write(source.encode("utf-8"))
            stdin.seek(0)
            completed = subprocess.run(
                [node_binary() or "node", str(RUNTIME_DIR / "compile.cjs")],
                stdin=stdin,
                capture_output=True,
                timeout=timeout,
                env=env,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return "", f"Canvas compiler timed out after {int(timeout)}s.", False
    except OSError as exc:
        # No room or no directory for the source file: the host's state, like a missing node.
        return "", f"Canvas compiler could not run: {exc}", False
    if completed.returncode != 0:
        # compile.cjs exits 1 for every compile error; any other status means node itself died.
        ran = completed.returncode == 1
        return "", completed.stderr.decode("utf-8", "replace").strip() or "Canvas compiler failed.", ran
    return completed.stdout.decode("utf-8"), None, True


def read_state(path: Path) -> dict[str, Any]:
    try:
        raw = state_path(path).read_bytes()
    except OSError:
        return {}
    if len(raw) > MAX_STATE_BYTES:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def write_state(path: Path, state: dict[str, Any]) -> None:
    payload = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
        raise ValueError("Canvas state is larger than 4 MiB")
    replace_file(state_path(path), payload + "\n")


class RevisionConflict(Exception):
    def __init__(self, revision: int) -> None:
        super().__init__(f"The canvas changed since it was opened (now revision {revision}).")
        self.revision = revision


def save_source(path: Path, source: str, base_revision: int) -> None:
    """Replace the source the user edited, unless someone (usually the agent) saved in between."""
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError(SOURCE_TOO_LARGE)
    current = path.stat().st_mtime_ns
    # A revision is st_mtime_ns (~1.8e18), past the 2**53 a JavaScript number holds exactly,
    # so a client echoes the nearest double. Compare as that client saw it; neighbouring
    # doubles there are 256 ns apart, far finer than two real saves.
    if float(current) != float(base_revision):
        raise RevisionConflict(current)
    replace_file(path, source)


# ---------------------------------------------------------------- comments
#
# A thread is anchored to one element of the rendered canvas and holds the
# user's messages. By default each message starts an ordinary chat turn; its
# reply is the turn's final answer, read back from the chat's event log by run
# id (or by queued id until a queued turn starts) and stored once the turn is
# over.
#
# A question from a client that sends `side_chat: true` is answered in the
# thread's own side chat instead: a copy of the chat as it stands answers it,
# the chat gets no turn, and the threads' questions run at the same time. Its
# reply is read from the side chat's exchange whose request id is the message's
# id. An edit request stays a chat turn: the copy cannot write on most
# providers, and the chat would not see an edit made beside it.

def read_comments(path: Path) -> list[dict[str, Any]]:
    try:
        raw = comments_path(path).read_bytes()
    except OSError:
        return []
    if len(raw) > MAX_COMMENTS_BYTES:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        return []
    threads = value.get("threads") if isinstance(value, dict) else None
    return [thread for thread in threads if isinstance(thread, dict)] if isinstance(threads, list) else []


def write_comments(path: Path, threads: list[dict[str, Any]]) -> None:
    payload = json.dumps({"threads": threads}, ensure_ascii=False, indent=2)
    if len(payload.encode("utf-8")) > MAX_COMMENTS_BYTES:
        raise ValueError("Canvas comments are larger than 4 MiB")
    replace_file(comments_path(path), payload + "\n")


def comment_anchor(value: Any) -> dict[str, Any]:
    """The element a thread is about, as the runtime's selection reports it."""
    if not isinstance(value, dict):
        raise ValueError("anchor must be an object")
    canvas_id = value.get("canvas_id")
    tag = value.get("tag")
    if canvas_id is not None and not (isinstance(canvas_id, str) and 0 < len(canvas_id) <= 200):
        raise ValueError("anchor.canvas_id must be a short string or null")
    if not (isinstance(tag, str) and TAG_RE.match(tag)):
        raise ValueError("anchor.tag must be an element tag name")
    return {
        "canvas_id": canvas_id,
        "tag": tag,
        "text": str(value.get("text") or "")[:400],
        "html": str(value.get("html") or "")[:2000],
    }


def comment_message(value: Any) -> tuple[str, str, int]:
    if not isinstance(value, dict):
        raise ValueError("body must be an object")
    mode = value.get("mode")
    text = value.get("body")
    revision = value.get("revision")
    if mode not in COMMENT_MODES:
        raise ValueError("mode must be 'ask' or 'edit'")
    if not (isinstance(text, str) and text.strip()):
        raise ValueError("body must be non-empty text")
    if len(text) > MAX_COMMENT_CHARS:
        raise ValueError(f"a comment is limited to {MAX_COMMENT_CHARS} characters")
    if not isinstance(revision, int) or isinstance(revision, bool):
        raise ValueError("revision must be the canvas revision the comment was written against")
    return mode, text.strip(), revision


def comment_prompt(path: Path, revision: int, anchor: dict[str, Any], mode: str, body: str, *, follow_up: bool) -> tuple[str, str]:
    """(prompt for the agent, text the timeline shows for the user's message)."""
    where = f'inside data-canvas-id="{anchor["canvas_id"]}"' if anchor["canvas_id"] else "(no data-canvas-id)"
    lines = [
        f"Canvas comment ({'question' if mode == 'ask' else 'edit request'}) on {path} at revision {revision}.",
        f"Selected element: <{anchor['tag']}> {where}",
    ]
    if anchor["text"].strip():
        lines.append(f"Element text: {json.dumps(anchor['text'], ensure_ascii=False)}")
    if anchor["html"]:
        lines.append(f"Element HTML: {anchor['html']}")
    if follow_up:
        lines.append("This continues an earlier comment thread on the same element.")
    lines += [
        "",
        # A question must not turn into an edit: the user chose "ask" on purpose.
        "This is a question: answer it in your reply and do not modify the canvas."
        if mode == "ask" else
        "Change the canvas file to do what this comment asks, keep everything else unchanged, "
        "run the canvas check, and reply with a short summary of the change.",
        "",
        f"{'Question' if mode == 'ask' else 'Request'}: {body}",
    ]
    # The id is the nearest data-canvas-id, often a whole section, so the element's own text
    # follows it. Same format as the clients' thread labels (canvasAnchorLabel).
    text = " ".join(anchor["text"].split())[:40]
    if anchor["canvas_id"]:
        label = f"{anchor['canvas_id']} · {text}" if text else anchor["canvas_id"]
    else:
        label = f"<{anchor['tag']}> {text}".rstrip()
    display = f"Canvas {'question' if mode == 'ask' else 'edit'} on {canvas_name(path)} · {label}: {body}"
    return "\n".join(lines), display[:4096]


def with_earlier_exchanges(prompt: str, exchanges: Iterable[tuple[str, str]]) -> str:
    """The prompt after its thread's earlier questions and answers, for an agent that has not seen them."""
    lines: list[str] = []
    for question, answer in exchanges:
        lines += ["Earlier question in this comment thread:", question, "", "Its answer:", answer[:MAX_REPLY_CHARS], ""]
    return "\n".join([*lines, prompt])


def resolve_replies(threads: list[dict[str, Any]], events: Any) -> bool:
    """Fill each unfinished message's reply from the chat's events; True when the file should be rewritten."""
    pending = [
        message
        for thread in threads
        for message in thread.get("messages") or []
        if isinstance(message, dict)
        and isinstance(message.get("turn"), dict)
        and (message.get("reply") or {}).get("status") not in FINAL_REPLY_STATUSES
    ]
    if not pending:
        return False
    by_run = {str(message["turn"]["run_id"]): message for message in pending if message["turn"].get("run_id")}
    by_queue = {
        str(message["turn"]["queued_id"]): message
        for message in pending
        if not message["turn"].get("run_id") and message["turn"].get("queued_id")
    }
    started: set[str] = set()
    changed = False
    for event in events:
        kind = event.get("type")
        run_id = str(event.get("run_id") or "")
        queued_id = str(event.get("queued_id") or "")
        if kind == "turn_started":
            if queued_id in by_queue:
                message = by_queue.pop(queued_id)
                message["turn"]["run_id"] = run_id
                by_run[run_id] = message
                changed = True
            if run_id in by_run:
                started.add(run_id)
        elif kind == "turn_unqueued" and queued_id in by_queue:
            by_queue.pop(queued_id)["reply"] = {"status": "cancelled", "text": "", "finished_at": event.get("ts")}
            changed = True
        elif kind in ("turn_finished", "turn_stopped") and run_id in by_run:
            stopped = kind == "turn_stopped" or event.get("stopped") is True
            succeeded = event.get("exit_code") in (0, None)
            by_run.pop(run_id)["reply"] = {
                "status": "stopped" if stopped else "done" if succeeded else "failed",
                "text": str(event.get("result_text") or event.get("message") or "")[:MAX_REPLY_CHARS],
                "finished_at": event.get("ts"),
            }
            changed = True
    for run_id, message in by_run.items():
        message["reply"] = {"status": "running" if run_id in started else "queued"}
    for message in by_queue.values():
        message["reply"] = {"status": "queued"}
    return changed


def side_chat_reply(exchange: dict[str, Any] | None) -> dict[str, Any]:
    """A comment message's reply, from its exchange in the thread's side chat."""
    if exchange is None:
        # load-bearing: side chat state deleted beside the comments file would leave the message running forever.
        return {"status": "failed", "text": "The side chat that was answering this is gone. Ask again.",
                "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    status = exchange["status"]
    if status == "running":
        return {"status": "running"}
    finished_at = exchange.get("updated_at")
    if status == "completed":
        return {"status": "done", "text": str(exchange.get("answer") or "")[:MAX_REPLY_CHARS], "finished_at": finished_at}
    if status in ("cancelled", "interrupted"):
        # Interrupted: the server stopped while the side chat was answering.
        return {"status": "cancelled" if status == "cancelled" else "stopped", "text": "", "finished_at": finished_at}
    return {"status": "failed", "text": f"The side chat did not answer ({exchange.get('error') or status}). Ask again.",
            "finished_at": finished_at}


def build(path: Path) -> dict[str, Any]:
    """Return the canvas with a compiled bundle, reusing the cache when the source is unchanged."""
    stat = path.stat()
    if stat.st_size > MAX_SOURCE_BYTES:
        raise ValueError(SOURCE_TOO_LARGE)
    source = path.read_text(encoding="utf-8")
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    version = runtime_version()
    cache_file = build_cache_path(path)
    cached: dict[str, Any] | None = None
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cached = None
    if not (isinstance(cached, dict) and cached.get("source_sha256") == digest and cached.get("runtime_version") == version):
        javascript, diagnostics, ran = compile_source(source)
        cached = {
            "source_sha256": digest,
            "runtime_version": version,
            "javascript": javascript,
            "diagnostics": diagnostics,
            "compiled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # A host failure (no node, timeout, crash) says nothing about the source: leave the
        # cache alone so the next request retries instead of serving the stale reason.
        if ran:
            try:
                cache_file.write_text(json.dumps(cached), encoding="utf-8")
            except OSError:
                pass
    return {
        "name": canvas_name(path),
        "path": str(path),
        "source": source,
        "javascript": cached.get("javascript") or "",
        "diagnostics": cached.get("diagnostics"),
        "runtime_version": version,
        "revision": stat.st_mtime_ns,
        # As in the list: a client that holds a record without its source compares the two.
        "size": stat.st_size,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
        "state": read_state(path),
    }


def read_source(path: Path) -> dict[str, Any]:
    """The source with the revision it belongs to. It does not compile: a compile that the host
    failed is not cached, so each read would run it again."""
    stat = path.stat()
    if stat.st_size > MAX_SOURCE_BYTES:
        raise ValueError(SOURCE_TOO_LARGE)
    return {"source": path.read_text(encoding="utf-8"), "revision": stat.st_mtime_ns}


def list_canvases(directory: Path) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not directory.is_dir():
        return items
    for path in directory.iterdir():
        if not path.name.endswith(CANVAS_SUFFIX) or path.name.startswith("."):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        items.append({
            "name": canvas_name(path),
            "path": str(path),
            "revision": stat.st_mtime_ns,
            "size": stat.st_size,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
        })
    items.sort(key=lambda item: item["revision"], reverse=True)
    return items


# ---------------------------------------------------------------- routes

def register_canvas_routes(
    app: Any,
    *,
    state_dir: Path,
    session_exists: Callable[[str], bool],
    session_events: Callable[[str], Iterable[dict[str, Any]]],
    start_turn: Callable[[str, str, str, list[str]], Awaitable[dict[str, Any]]],
    side_chats: Any = None,
    side_chat_available: Callable[[str, str], bool] = lambda session_id, prompt: False,
) -> None:
    """``start_turn(session_id, prompt, display_prompt, client_capabilities)`` admits a
    comment's turn exactly like a composer message and returns its run_id or queued_id.

    ``side_chats`` is the ``side_questions.SyncedSideChats`` holding one side chat per comment
    thread; ``side_chat_available(session_id, prompt)`` tells whether the chat's provider can
    answer this prompt in one."""
    from fastapi import Body, Header, HTTPException
    from fastapi.responses import JSONResponse, Response

    from side_questions import SideQuestionError

    # Serializes each comments file's read-modify-write within this server.
    comment_locks: dict[str, asyncio.Lock] = {}

    def comment_lock(path: Path) -> asyncio.Lock:
        return comment_locks.setdefault(str(path), asyncio.Lock())

    def bad_request(exc: ValueError) -> HTTPException:
        return HTTPException(status_code=400, detail=str(exc))

    def find_thread(threads: list[dict[str, Any]], thread_id: str) -> dict[str, Any]:
        thread = next((thread for thread in threads if thread.get("id") == thread_id), None)
        if thread is None:
            raise HTTPException(status_code=404, detail="comment thread not found")
        return thread

    async def end_side_chat(session_id: str, thread_id: str) -> None:
        """Stop the thread's running answer and forget its exchanges."""
        chat = await side_chats.snapshot(thread_id, session_id)
        await side_chats.clear(thread_id, session_id, chat["side_chat_id"])

    async def start_comment_reply(session_id: str, path: Path, thread_id: str, anchor: dict[str, Any], body: dict[str, Any],
                                  *, earlier_messages: list[dict[str, Any]]) -> dict[str, Any]:
        """Admit the message's reply, in the thread's side chat or as a chat turn."""
        try:
            mode, text, revision = comment_message(body)
        except ValueError as exc:
            raise bad_request(exc) from None
        capabilities = [value for value in body.get("client_capabilities") or [] if isinstance(value, str)][:16]
        prompt, display_prompt = comment_prompt(path, revision, anchor, mode, text, follow_up=bool(earlier_messages))
        message = {
            "id": f"msg_{uuid.uuid4().hex[:12]}",
            "mode": mode,
            "body": text,
            "revision": revision,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # `side_chat`: the client refreshes its threads on `canvas_comments_updated`; one that does not
        # would show the reply only after the chat's next turn.
        if mode == "ask" and body.get("side_chat") is True and side_chat_available(session_id, prompt):
            chat = await side_chats.snapshot(thread_id, session_id)
            try:
                await side_chats.submit(thread_id, session_id, message["id"], prompt, chat["side_chat_id"], chat["last_request_id"])
            except SideQuestionError as exc:
                # 409: the thread's side chat is answering, stopping, or changed since the snapshot.
                detail = "This thread is still answering. Ask again when its reply is done." if exc.status_code == 409 else str(exc)
                raise HTTPException(status_code=exc.status_code, detail=detail) from None
            return {**message, "turn": None, "side_chat": True, "reply": {"status": "running"}}
        # The chat saw none of the thread's side chat exchanges, except those an earlier turn of the thread was told.
        unseen: list[tuple[str, str]] = []
        for item in earlier_messages:
            if item.get("side_chat") is not True:
                unseen = []
            elif (item.get("reply") or {}).get("status") == "done":
                unseen.append((item["body"], item["reply"]["text"]))
        started = await start_turn(session_id, with_earlier_exchanges(prompt, unseen), display_prompt, capabilities)
        return {
            **message,
            "turn": {"run_id": started.get("run_id"), "queued_id": started.get("queued_id")},
            "reply": {"status": "queued" if started.get("queued") else "running"},
        }

    async def resolve_side_chat_replies(session_id: str, threads: list[dict[str, Any]]) -> bool:
        """Fill each unfinished side chat message's reply; True when one finished and the file should be rewritten."""
        changed = False
        for thread in threads:
            pending = [message for message in thread.get("messages") or []
                       if isinstance(message, dict) and message.get("side_chat") is True
                       and (message.get("reply") or {}).get("status") not in FINAL_REPLY_STATUSES]
            if not pending:
                continue
            chat = await side_chats.snapshot(thread["id"], session_id)
            exchanges = {exchange["request_id"]: exchange for exchange in chat["exchanges"]}
            for message in pending:
                reply = side_chat_reply(exchanges.get(message["id"]))
                changed = changed or reply["status"] in FINAL_REPLY_STATUSES
                message["reply"] = reply
        return changed

    def resolve(session_id: str, name: str | None = None) -> tuple[Path, Path | None]:
        if not session_exists(session_id):
            raise HTTPException(status_code=404, detail="session not found")
        try:
            directory = session_dir(state_dir, session_id)
            path = canvas_path(directory, name) if name is not None else None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        if path is not None and not path.is_file():
            raise HTTPException(status_code=404, detail="canvas not found")
        return directory, path

    @app.get("/api/sessions/{session_id}/canvases")
    async def list_session_canvases(session_id: str) -> dict[str, Any]:
        directory, _ = resolve(session_id)
        return {"canvases": await asyncio.to_thread(list_canvases, directory), "capability": capability(state_dir)}

    def built_canvas_response(built: dict[str, Any], accept_encoding: str) -> Response:
        # The body carries the source and its compiled bundle, 9.2 MiB for a 2.3 MiB report and 1.6 MiB
        # gzipped; through a remote link of 0.1-0.4 MiB/s the plain body outlasts the desktop's 30 s
        # request limit. The hub proxy passes the encoded body through, as for the runtime assets.
        body = JSONResponse(built).body
        headers = {"Vary": "Accept-Encoding"}
        if "gzip" in accept_encoding:
            body = gzip.compress(body, compresslevel=6)
            headers["Content-Encoding"] = "gzip"
        return Response(content=body, media_type="application/json", headers=headers)

    @app.get("/api/sessions/{session_id}/canvases/{name}", response_class=Response)
    async def get_session_canvas(session_id: str, name: str, source: bool = True, accept_encoding: str = Header(default="")):
        _, path = resolve(session_id, name)
        try:
            built = await asyncio.to_thread(build, path)
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None
        # The page needs the bundle only, and the source is about half of the body: a client asks for
        # the record without it and reads the source when its source view opens.
        if not source:
            del built["source"]
        return await asyncio.to_thread(built_canvas_response, built, accept_encoding)

    @app.get("/api/sessions/{session_id}/canvases/{name}/source", response_class=Response)
    async def get_session_canvas_source(session_id: str, name: str, accept_encoding: str = Header(default="")):
        _, path = resolve(session_id, name)
        try:
            # The revision tells the client whether this source belongs to the record it shows.
            source = await asyncio.to_thread(read_source, path)
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None
        return await asyncio.to_thread(built_canvas_response, source, accept_encoding)

    @app.get("/api/sessions/{session_id}/canvases/{name}/state")
    async def get_session_canvas_state(session_id: str, name: str) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        return {"state": await asyncio.to_thread(read_state, path)}

    @app.put("/api/sessions/{session_id}/canvases/{name}/state")
    async def put_session_canvas_state(session_id: str, name: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        state = body.get("state")
        if not isinstance(state, dict):
            raise HTTPException(status_code=400, detail="state must be a JSON object")
        try:
            await asyncio.to_thread(write_state, path, state)
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None
        return {"state": state}

    @app.put("/api/sessions/{session_id}/canvases/{name}/source", response_class=Response)
    async def put_session_canvas_source(session_id: str, name: str, body: dict[str, Any] = Body(...),
                                        accept_encoding: str = Header(default="")):
        _, path = resolve(session_id, name)
        source = body.get("source")
        base_revision = body.get("base_revision")
        if not isinstance(source, str) or not isinstance(base_revision, int) or isinstance(base_revision, bool):
            raise HTTPException(status_code=400, detail="source must be text and base_revision the revision it was edited from")
        try:
            await asyncio.to_thread(save_source, path, source, base_revision)
            built = await asyncio.to_thread(build, path)
        except RevisionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None
        return await asyncio.to_thread(built_canvas_response, built, accept_encoding)

    @app.get("/api/sessions/{session_id}/canvases/{name}/comments")
    async def list_session_canvas_comments(session_id: str, name: str) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            turns_changed = await asyncio.to_thread(resolve_replies, threads, session_events(session_id))
            side_chats_changed = await resolve_side_chat_replies(session_id, threads)
            if turns_changed or side_chats_changed:
                await asyncio.to_thread(write_comments, path, threads)
        return {"threads": threads}

    @app.post("/api/sessions/{session_id}/canvases/{name}/comments")
    async def create_session_canvas_comment(session_id: str, name: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        try:
            anchor = comment_anchor(body.get("anchor"))
        except ValueError as exc:
            raise bad_request(exc) from None
        # The thread is stored only once its turn or side chat question was admitted, so a refused one leaves nothing behind.
        thread_id = f"cmt_{uuid.uuid4().hex[:12]}"
        message = await start_comment_reply(session_id, path, thread_id, anchor, body, earlier_messages=[])
        now = message["created_at"]
        thread = {"id": thread_id, "anchor": anchor, "status": "open", "created_at": now, "updated_at": now, "messages": [message]}
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            threads.append(thread)
            await asyncio.to_thread(write_comments, path, threads)
        return {"thread": thread}

    @app.post("/api/sessions/{session_id}/canvases/{name}/comments/{thread_id}/messages")
    async def reply_session_canvas_comment(session_id: str, name: str, thread_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        thread = find_thread(await asyncio.to_thread(read_comments, path), thread_id)
        # A reply reaches the comments file only when the threads are read: fill one finished since, so an Edit is told it.
        await resolve_side_chat_replies(session_id, [thread])
        message = await start_comment_reply(session_id, path, thread_id, comment_anchor(thread.get("anchor") or {}), body,
                                            earlier_messages=thread.get("messages") or [])
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            thread = next((thread for thread in threads if thread.get("id") == thread_id), None)
            if thread is not None:
                thread.setdefault("messages", []).append(message)
                # Asking again reopens a resolved thread.
                thread["status"] = "open"
                thread["updated_at"] = message["created_at"]
                await asyncio.to_thread(write_comments, path, threads)
        if thread is None:
            # Deleted while its question was admitted: nobody will read the answer. Outside the lock, as in the delete.
            if message.get("side_chat") is True:
                await end_side_chat(session_id, thread_id)
            raise HTTPException(status_code=404, detail="comment thread not found")
        return {"thread": thread}

    @app.patch("/api/sessions/{session_id}/canvases/{name}/comments/{thread_id}")
    async def update_session_canvas_comment(session_id: str, name: str, thread_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        status = body.get("status")
        if status not in ("open", "resolved"):
            raise HTTPException(status_code=400, detail="status must be 'open' or 'resolved'")
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            thread = find_thread(threads, thread_id)
            thread["status"] = status
            thread["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            await asyncio.to_thread(write_comments, path, threads)
        return {"thread": thread}

    @app.delete("/api/sessions/{session_id}/canvases/{name}/comments/{thread_id}")
    async def delete_session_canvas_comment(session_id: str, name: str, thread_id: str) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            thread = find_thread(threads, thread_id)
            await asyncio.to_thread(write_comments, path, [thread for thread in threads if thread.get("id") != thread_id])
        if any(message.get("side_chat") is True for message in thread.get("messages") or []):
            # After the thread is gone, so no later question is stored in it; outside the lock, as a Codex fork takes seconds to end.
            await end_side_chat(session_id, thread_id)
        return {"deleted": thread_id}

    # No return annotation: with `from __future__ import annotations` the string 'Response'
    # is unresolvable at OpenAPI generation time and made /openapi.json return 500.
    @app.get("/api/canvas-runtime/{asset}", response_class=Response)
    async def get_canvas_runtime_asset(asset: str, accept_encoding: str = Header(default="")):
        media_type = RUNTIME_ASSETS.get(asset)
        if media_type is None:
            raise HTTPException(status_code=404, detail="unknown runtime asset")
        try:
            data = await asyncio.to_thread(runtime_asset_bytes, asset)
        except OSError:
            raise HTTPException(status_code=404, detail="runtime asset missing") from None
        # The URL carries no version and vendor.js now changes with markdown.js: an HTTP cache
        # (the iOS fetch shares NSURLCache) must not hand a new runtime version the old body.
        headers = {"Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        # vendor.js is 952 KB with KaTeX, 277 KB gzipped; at 30 KiB/s through a congested remote
        # link the uncompressed body outlasts the desktop's 30 s request limit. The hub proxy
        # passes the encoded body and its header through unchanged.
        if "gzip" in accept_encoding:
            data = await asyncio.to_thread(gzip.compress, data)
            headers["Content-Encoding"] = "gzip"
        return Response(content=data, media_type=media_type, headers=headers)


# ---------------------------------------------------------------- CLI

def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "check":
        print("usage: agentsdock_canvas.py check <file.canvas.tsx>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.name.endswith(CANVAS_SUFFIX):
        print(f"error: {path} must end with {CANVAS_SUFFIX}", file=sys.stderr)
        return 2
    try:
        source = path.read_text(encoding="utf-8")
        size = path.stat().st_size
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    # The viewer refuses the same file; an agent must learn it here, not from the user.
    if size > MAX_SOURCE_BYTES:
        print(SOURCE_TOO_LARGE)
        return 1
    javascript, diagnostics, _ran = compile_source(source)
    if diagnostics:
        print(diagnostics)
        return 1
    print(f"OK: {path.name} compiled ({len(javascript.encode('utf-8'))} bytes of JavaScript).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
