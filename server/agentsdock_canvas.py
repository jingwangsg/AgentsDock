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
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
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
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_COMMENTS_BYTES = 4 * 1024 * 1024
MAX_COMMENT_CHARS = 8_000
# The whole answer stays in the chat; a thread keeps enough to read in place.
MAX_REPLY_CHARS = 20_000
COMMENT_MODES = ("ask", "edit")
FINAL_REPLY_STATUSES = frozenset({"done", "failed", "stopped", "cancelled"})
TAG_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
COMPILE_TIMEOUT_SECONDS = 180
RUNTIME_ASSETS = {"vendor.js": "application/javascript", "shell.html": "text/html"}
AGENT_FILES = ("AUTHORING.md", "sdk.d.ts")


# ---------------------------------------------------------------- runtime

def runtime_version() -> str | None:
    try:
        return (RUNTIME_DIR / "version").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


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
        "A Canvas is one standalone `<name>.canvas.tsx` React report that the user views beside the chat. "
        "Create one only when the artifact itself is the deliverable (reports, comparisons, metrics, interactive explorations). "
        f"Before writing or editing a Canvas, read {directory / 'AUTHORING.md'} and the SDK declarations at {directory / 'sdk.d.ts'}. "
        "Import only from `@zed/canvas`, default-export the component, and embed the data directly. "
        f"After saving, run `{check} {directory}/<name>.canvas.tsx` and fix every reported error. "
        "Finish with a short conclusion and a Markdown link to the absolute .canvas.tsx path; do not paste the report into the chat."
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
        completed = subprocess.run(
            [node_binary() or "node", str(RUNTIME_DIR / "compile.cjs")],
            input=source.encode("utf-8"),
            capture_output=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "", f"Canvas compiler timed out after {int(timeout)}s.", False
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
        raise ValueError("Canvas source is larger than 2 MiB")
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
# user's messages. Each message starts an ordinary chat turn; its reply is the
# turn's final answer, read back from the chat's event log by run id (or by
# queued id until a queued turn starts) and stored once the turn is over.

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


def build(path: Path) -> dict[str, Any]:
    """Return the canvas with a compiled bundle, reusing the cache when the source is unchanged."""
    stat = path.stat()
    if stat.st_size > MAX_SOURCE_BYTES:
        raise ValueError("Canvas source is larger than 2 MiB")
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
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
        "state": read_state(path),
    }


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
) -> None:
    """``start_turn(session_id, prompt, display_prompt, client_capabilities)`` admits a
    comment's turn exactly like a composer message and returns its run_id or queued_id."""
    from fastapi import Body, HTTPException
    from fastapi.responses import Response

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

    async def start_comment_turn(session_id: str, path: Path, anchor: dict[str, Any], body: dict[str, Any], *, follow_up: bool) -> dict[str, Any]:
        try:
            mode, text, revision = comment_message(body)
        except ValueError as exc:
            raise bad_request(exc) from None
        capabilities = [value for value in body.get("client_capabilities") or [] if isinstance(value, str)][:16]
        prompt, display_prompt = comment_prompt(path, revision, anchor, mode, text, follow_up=follow_up)
        started = await start_turn(session_id, prompt, display_prompt, capabilities)
        return {
            "id": f"msg_{uuid.uuid4().hex[:12]}",
            "mode": mode,
            "body": text,
            "revision": revision,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "turn": {"run_id": started.get("run_id"), "queued_id": started.get("queued_id")},
            "reply": {"status": "queued" if started.get("queued") else "running"},
        }

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

    @app.get("/api/sessions/{session_id}/canvases/{name}")
    async def get_session_canvas(session_id: str, name: str) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        try:
            return await asyncio.to_thread(build, path)
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None

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

    @app.put("/api/sessions/{session_id}/canvases/{name}/source")
    async def put_session_canvas_source(session_id: str, name: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        source = body.get("source")
        base_revision = body.get("base_revision")
        if not isinstance(source, str) or not isinstance(base_revision, int) or isinstance(base_revision, bool):
            raise HTTPException(status_code=400, detail="source must be text and base_revision the revision it was edited from")
        try:
            await asyncio.to_thread(save_source, path, source, base_revision)
            return await asyncio.to_thread(build, path)
        except RevisionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None

    @app.get("/api/sessions/{session_id}/canvases/{name}/comments")
    async def list_session_canvas_comments(session_id: str, name: str) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            if await asyncio.to_thread(resolve_replies, threads, session_events(session_id)):
                await asyncio.to_thread(write_comments, path, threads)
        return {"threads": threads}

    @app.post("/api/sessions/{session_id}/canvases/{name}/comments")
    async def create_session_canvas_comment(session_id: str, name: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        try:
            anchor = comment_anchor(body.get("anchor"))
        except ValueError as exc:
            raise bad_request(exc) from None
        # The thread is stored only once its turn was admitted, so a refused turn leaves nothing behind.
        message = await start_comment_turn(session_id, path, anchor, body, follow_up=False)
        now = message["created_at"]
        thread = {"id": f"cmt_{uuid.uuid4().hex[:12]}", "anchor": anchor, "status": "open", "created_at": now, "updated_at": now, "messages": [message]}
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            threads.append(thread)
            await asyncio.to_thread(write_comments, path, threads)
        return {"thread": thread}

    @app.post("/api/sessions/{session_id}/canvases/{name}/comments/{thread_id}/messages")
    async def reply_session_canvas_comment(session_id: str, name: str, thread_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        _, path = resolve(session_id, name)
        anchor = find_thread(await asyncio.to_thread(read_comments, path), thread_id).get("anchor") or {}
        message = await start_comment_turn(session_id, path, comment_anchor(anchor), body, follow_up=True)
        async with comment_lock(path):
            threads = await asyncio.to_thread(read_comments, path)
            thread = find_thread(threads, thread_id)
            thread.setdefault("messages", []).append(message)
            # Asking again reopens a resolved thread.
            thread["status"] = "open"
            thread["updated_at"] = message["created_at"]
            await asyncio.to_thread(write_comments, path, threads)
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
            find_thread(threads, thread_id)
            await asyncio.to_thread(write_comments, path, [thread for thread in threads if thread.get("id") != thread_id])
        return {"deleted": thread_id}

    # No return annotation: with `from __future__ import annotations` the string 'Response'
    # is unresolvable at OpenAPI generation time and made /openapi.json return 500.
    @app.get("/api/canvas-runtime/{asset}", response_class=Response)
    async def get_canvas_runtime_asset(asset: str):
        media_type = RUNTIME_ASSETS.get(asset)
        if media_type is None:
            raise HTTPException(status_code=404, detail="unknown runtime asset")
        try:
            data = await asyncio.to_thread((RUNTIME_DIR / asset).read_bytes)
        except OSError:
            raise HTTPException(status_code=404, detail="runtime asset missing") from None
        return Response(content=data, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})


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
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    javascript, diagnostics, _ran = compile_source(source)
    if diagnostics:
        print(diagnostics)
        return 1
    print(f"OK: {path.name} compiled ({len(javascript.encode('utf-8'))} bytes of JavaScript).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
