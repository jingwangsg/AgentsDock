"""Canvas storage, compilation cache, and CLI check."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agentsdock_canvas as canvas  # noqa: E402

VALID_SOURCE = (
    "import { H1, Stack, Text, useCanvasState } from '@zed/canvas';\n"
    "export default function Report() {\n"
    "  const [count, setCount] = useCanvasState('count', 1);\n"
    "  return <Stack><H1>Demo</H1><Text>{count}</Text></Stack>;\n"
    "}\n"
)

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def test_session_dir_rejects_bad_ids(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        canvas.session_dir(tmp_path, "../escape")
    with pytest.raises(ValueError):
        canvas.canvas_path(tmp_path, "../x")
    with pytest.raises(ValueError):
        canvas.canvas_path(tmp_path, "bad name")


def test_canvas_path_accepts_consecutive_dots(tmp_path: Path) -> None:
    assert canvas.canvas_path(tmp_path, "q3..final") == tmp_path / "q3..final.canvas.tsx"


def test_ensure_session_dir_copies_agent_files(tmp_path: Path) -> None:
    directory = canvas.ensure_session_dir(tmp_path, "sess_1")
    assert directory == tmp_path / "canvases" / "sess_1"
    assert (directory / "AUTHORING.md").is_file()
    assert (directory / "sdk.d.ts").is_file()


def test_state_round_trip_and_size_limit(tmp_path: Path) -> None:
    path = tmp_path / "demo.canvas.tsx"
    path.write_text(VALID_SOURCE)
    assert canvas.read_state(path) == {}
    canvas.write_state(path, {"count": 3})
    assert canvas.read_state(path) == {"count": 3}
    with pytest.raises(ValueError):
        canvas.write_state(path, {"blob": "x" * (canvas.MAX_STATE_BYTES + 1)})


def test_list_canvases_ignores_other_files(tmp_path: Path) -> None:
    (tmp_path / "a.canvas.tsx").write_text(VALID_SOURCE)
    (tmp_path / "a.canvas.data.json").write_text("{}")
    (tmp_path / ".a.canvas.build.json").write_text("{}")
    (tmp_path / "notes.md").write_text("x")
    names = [item["name"] for item in canvas.list_canvases(tmp_path)]
    assert names == ["a"]


@needs_node
def test_build_compiles_and_reuses_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "demo.canvas.tsx"
    path.write_text(VALID_SOURCE)
    first = canvas.build(path)
    assert first["diagnostics"] is None
    assert "CanvasModule" in first["javascript"]
    assert first["runtime_version"] == canvas.runtime_version()
    cache = json.loads(canvas.build_cache_path(path).read_text())
    assert cache["source_sha256"]

    # Unchanged source must not invoke the compiler again.
    monkeypatch.setattr(canvas, "compile_source", lambda *_a, **_k: pytest.fail("compiler re-run for unchanged source"))
    second = canvas.build(path)
    assert second["javascript"] == first["javascript"]


def test_build_does_not_cache_transient_compile_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "demo.canvas.tsx"
    path.write_text(VALID_SOURCE)
    cache_file = canvas.build_cache_path(path)

    # node missing from PATH.
    monkeypatch.setattr(canvas, "node_binary", lambda: None)
    result = canvas.build(path)
    assert result["javascript"] == "" and "node" in result["diagnostics"]
    assert not cache_file.exists()

    # node present but the compiler timed out.
    monkeypatch.setattr(canvas, "node_binary", lambda: "/fake/node")

    def timed_out(*_a, **_k):
        raise subprocess.TimeoutExpired("node", 1)

    monkeypatch.setattr(canvas.subprocess, "run", timed_out)
    assert "timed out" in canvas.build(path)["diagnostics"]
    assert not cache_file.exists()

    # node died (signal) instead of finishing.
    monkeypatch.setattr(canvas.subprocess, "run", lambda *_a, **_k: subprocess.CompletedProcess(["node"], -9, b"", b""))
    assert canvas.build(path)["diagnostics"] == "Canvas compiler failed."
    assert not cache_file.exists()

    # A real verdict (exit 1 = compile errors) is cached.
    monkeypatch.setattr(canvas.subprocess, "run", lambda *_a, **_k: subprocess.CompletedProcess(["node"], 1, b"", b"boom"))
    assert canvas.build(path)["diagnostics"] == "boom"
    assert json.loads(cache_file.read_text())["diagnostics"] == "boom"


@needs_node
def test_check_cli_reports_forbidden_imports(tmp_path: Path) -> None:
    path = tmp_path / "bad.canvas.tsx"
    path.write_text("import x from 'lodash';\nexport default function R() { return null }\n")
    completed = subprocess.run(
        [sys.executable, str(Path(canvas.__file__)), "check", str(path)],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 1
    assert "Unsupported Canvas import" in completed.stdout + completed.stderr

    path.write_text(VALID_SOURCE)
    completed = subprocess.run(
        [sys.executable, str(Path(canvas.__file__)), "check", str(path)],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert completed.stdout.startswith("OK:")
