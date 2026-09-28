"""Canvas storage, compilation cache, and CLI check."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agentsdock_canvas as canvas  # noqa: E402

VALID_SOURCE = (
    "import { H1, Stack, Text, useCanvasState } from '@zed/canvas';\n"
    "export default function Report() {\n"
    "  const [count, setCount] = useCanvasState('count', 1);\n"
    "  return <Stack><H1>Demo</H1><Text>{count}</Text></Stack>;\n"
    "}\n"
)

needs_node = unittest.skipIf(shutil.which("node") is None, "node is not installed")


class CanvasTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_path = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def test_session_dir_rejects_bad_ids(self) -> None:
        with self.assertRaises(ValueError):
            canvas.session_dir(self.tmp_path, "../escape")
        with self.assertRaises(ValueError):
            canvas.canvas_path(self.tmp_path, "../x")
        with self.assertRaises(ValueError):
            canvas.canvas_path(self.tmp_path, "bad name")

    def test_canvas_path_accepts_consecutive_dots(self) -> None:
        assert canvas.canvas_path(self.tmp_path, "q3..final") == self.tmp_path / "q3..final.canvas.tsx"

    def test_ensure_session_dir_copies_agent_files(self) -> None:
        directory = canvas.ensure_session_dir(self.tmp_path, "sess_1")
        assert directory == self.tmp_path / "canvases" / "sess_1"
        assert (directory / "AUTHORING.md").is_file()
        assert (directory / "sdk.d.ts").is_file()

    def test_state_round_trip_and_size_limit(self) -> None:
        path = self.tmp_path / "demo.canvas.tsx"
        path.write_text(VALID_SOURCE)
        assert canvas.read_state(path) == {}
        canvas.write_state(path, {"count": 3})
        assert canvas.read_state(path) == {"count": 3}
        with self.assertRaises(ValueError):
            canvas.write_state(path, {"blob": "x" * (canvas.MAX_STATE_BYTES + 1)})

    def test_list_canvases_ignores_other_files(self) -> None:
        (self.tmp_path / "a.canvas.tsx").write_text(VALID_SOURCE)
        (self.tmp_path / "a.canvas.data.json").write_text("{}")
        (self.tmp_path / ".a.canvas.build.json").write_text("{}")
        (self.tmp_path / "notes.md").write_text("x")
        names = [item["name"] for item in canvas.list_canvases(self.tmp_path)]
        assert names == ["a"]

    @needs_node
    def test_build_compiles_and_reuses_cache(self) -> None:
        path = self.tmp_path / "demo.canvas.tsx"
        path.write_text(VALID_SOURCE)
        first = canvas.build(path)
        assert first["diagnostics"] is None
        assert "CanvasModule" in first["javascript"]
        assert first["runtime_version"] == canvas.runtime_version()
        cache = json.loads(canvas.build_cache_path(path).read_text())
        assert cache["source_sha256"]

        # Unchanged source must not invoke the compiler again.
        with patch.object(canvas, "compile_source", lambda *_a, **_k: self.fail("compiler re-run for unchanged source")):
            second = canvas.build(path)
        assert second["javascript"] == first["javascript"]

    def test_build_does_not_cache_transient_compile_failures(self) -> None:
        path = self.tmp_path / "demo.canvas.tsx"
        path.write_text(VALID_SOURCE)
        cache_file = canvas.build_cache_path(path)

        # node missing from PATH.
        with patch.object(canvas, "node_binary", lambda: None):
            result = canvas.build(path)
        assert result["javascript"] == "" and "node" in result["diagnostics"]
        assert not cache_file.exists()

        # node present but the compiler timed out.
        self.enterContext(patch.object(canvas, "node_binary", lambda: "/fake/node"))

        def timed_out(*_a, **_k):
            raise subprocess.TimeoutExpired("node", 1)

        with patch.object(canvas.subprocess, "run", timed_out):
            assert "timed out" in canvas.build(path)["diagnostics"]
        assert not cache_file.exists()

        # node died (signal) instead of finishing.
        with patch.object(canvas.subprocess, "run", lambda *_a, **_k: subprocess.CompletedProcess(["node"], -9, b"", b"")):
            assert canvas.build(path)["diagnostics"] == "Canvas compiler failed."
        assert not cache_file.exists()

        # A real verdict (exit 1 = compile errors) is cached.
        with patch.object(canvas.subprocess, "run", lambda *_a, **_k: subprocess.CompletedProcess(["node"], 1, b"", b"boom")):
            assert canvas.build(path)["diagnostics"] == "boom"
        assert json.loads(cache_file.read_text())["diagnostics"] == "boom"

    @needs_node
    def test_check_cli_reports_forbidden_imports(self) -> None:
        path = self.tmp_path / "bad.canvas.tsx"
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


if __name__ == "__main__":
    unittest.main()
