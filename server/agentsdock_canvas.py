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
from typing import Any, Callable

RUNTIME_DIR = Path(__file__).resolve().parent / "canvas_runtime"
CANVAS_SUFFIX = ".canvas.tsx"
STATE_SUFFIX = ".canvas.data.json"
BUILD_CACHE_PREFIX = "."
BUILD_CACHE_SUFFIX = ".canvas.build.json"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_STATE_BYTES = 4 * 1024 * 1024
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


def prompt_section(state_dir: Path, session_id: str, *, directory_label: str | None = None) -> str:
    """System prompt addendum telling the agent where and how to author a Canvas.

    ``directory_label`` (e.g. ``$AGENTSDOCK_CANVAS_DIR``) replaces the literal
    per-chat path so a system prompt stays byte-identical across chats; the
    caller must export that variable to the agent process.
    """
    if unavailable_reason():
        return ""
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
    target = state_path(path)
    temporary = target.with_name(target.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    temporary.write_text(payload + "\n", encoding="utf-8")
    temporary.replace(target)


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

def register_canvas_routes(app: Any, *, state_dir: Path, session_exists: Callable[[str], bool]) -> None:
    from fastapi import Body, HTTPException
    from fastapi.responses import Response

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
