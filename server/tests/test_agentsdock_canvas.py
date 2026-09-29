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

    def test_prompt_names_why_canvas_is_unavailable(self) -> None:
        with patch.object(canvas, "node_binary", lambda: None):
            section = canvas.prompt_section(self.tmp_path, "sess_1")
        assert "Canvas is unavailable on this server" in section and "`node`" in section
        assert "tell them it is unavailable and why" in section

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



ANCHOR = {"canvas_id": "summary", "tag": "td", "text": "loss 2.41", "html": "<td>loss 2.41</td>"}


class CanvasCommentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_path = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.tmp_path / "report.canvas.tsx"
        self.path.write_text(VALID_SOURCE)

    def test_comments_round_trip_beside_the_canvas(self) -> None:
        assert canvas.read_comments(self.path) == []
        canvas.write_comments(self.path, [{"id": "cmt_1", "messages": []}])
        assert (self.tmp_path / "report.canvas.comments.json").is_file()
        assert canvas.read_comments(self.path) == [{"id": "cmt_1", "messages": []}]
        # The comments file is not a canvas.
        assert [item["name"] for item in canvas.list_canvases(self.tmp_path)] == ["report"]

    def test_anchor_and_message_validation(self) -> None:
        assert canvas.comment_anchor({**ANCHOR, "text": "x" * 900})["text"] == "x" * 400
        assert canvas.comment_anchor({"canvas_id": None, "tag": "div"})["canvas_id"] is None
        for bad in ({"canvas_id": "a", "tag": "<script>"}, {"tag": "div", "canvas_id": ""}, "div"):
            with self.assertRaises(ValueError):
                canvas.comment_anchor(bad)
        assert canvas.comment_message({"mode": "ask", "body": " why? ", "revision": 7}) == ("ask", "why?", 7)
        for bad in ({"mode": "fix", "body": "x", "revision": 1}, {"mode": "ask", "body": "  ", "revision": 1}, {"mode": "ask", "body": "x", "revision": True}):
            with self.assertRaises(ValueError):
                canvas.comment_message(bad)

    def test_prompt_keeps_questions_from_editing(self) -> None:
        ask, ask_display = canvas.comment_prompt(self.path, 7, canvas.comment_anchor(ANCHOR), "ask", "为什么这么高？", follow_up=False)
        assert "question" in ask and "do not modify the canvas" in ask
        assert 'data-canvas-id="summary"' in ask and "revision 7" in ask and "Question: 为什么这么高？" in ask
        assert ask_display == "Canvas question on report · summary · loss 2.41: 为什么这么高？"
        edit, edit_display = canvas.comment_prompt(self.path, 7, canvas.comment_anchor({"canvas_id": None, "tag": "h1", "text": "Title"}), "edit", "make it shorter", follow_up=True)
        assert "Change the canvas file" in edit and "do not modify" not in edit
        assert "continues an earlier comment thread" in edit
        assert edit_display == "Canvas edit on report · <h1> Title: make it shorter"

    def test_resolve_replies_follows_queue_start_and_finish(self) -> None:
        def message(turn):
            return {"id": "m", "turn": turn, "reply": {"status": "queued"}}
        queued = message({"run_id": None, "queued_id": "q1"})
        running = message({"run_id": "run_b", "queued_id": None})
        stopped = message({"run_id": "run_c", "queued_id": None})
        cancelled = message({"run_id": None, "queued_id": "q2"})
        done = {"id": "m", "turn": {"run_id": "run_z"}, "reply": {"status": "done", "text": "kept"}}
        threads = [{"messages": [queued, running, stopped, cancelled, done]}]
        events = [
            {"type": "turn_started", "run_id": "run_b"},
            {"type": "turn_started", "run_id": "run_a", "queued_id": "q1"},
            {"type": "turn_finished", "run_id": "run_a", "exit_code": 0, "result_text": "Because the 1B run", "ts": "t1"},
            {"type": "turn_started", "run_id": "run_c"},
            {"type": "turn_stopped", "run_id": "run_c", "ts": "t2"},
            {"type": "turn_unqueued", "queued_id": "q2", "ts": "t3"},
            {"type": "turn_finished", "run_id": "run_z", "exit_code": 0, "result_text": "never read"},
        ]
        assert canvas.resolve_replies(threads, iter(events)) is True
        assert queued["turn"]["run_id"] == "run_a"
        assert queued["reply"] == {"status": "done", "text": "Because the 1B run", "finished_at": "t1"}
        assert running["reply"] == {"status": "running"}
        assert stopped["reply"]["status"] == "stopped"
        assert cancelled["reply"]["status"] == "cancelled"
        assert done["reply"]["text"] == "kept"
        # Nothing unfinished: the event log is not read at all.
        assert canvas.resolve_replies([{"messages": [done]}], iter(())) is False

    def test_failed_turn_and_long_answer(self) -> None:
        failing = {"turn": {"run_id": "r"}, "reply": None}
        canvas.resolve_replies([{"messages": [failing]}], [{"type": "turn_finished", "run_id": "r", "exit_code": 1, "result_text": "x" * (canvas.MAX_REPLY_CHARS + 5)}])
        assert failing["reply"]["status"] == "failed"
        assert len(failing["reply"]["text"]) == canvas.MAX_REPLY_CHARS

    def test_save_source_refuses_a_stale_revision(self) -> None:
        revision = self.path.stat().st_mtime_ns
        with self.assertRaises(canvas.RevisionConflict) as caught:
            # A millisecond older: a real concurrent save, not rounding.
            canvas.save_source(self.path, "// mine", revision - 1_000_000)
        assert caught.exception.revision == revision
        assert self.path.read_text() == VALID_SOURCE
        # A JavaScript client echoes the revision as the nearest double: still the same revision.
        canvas.save_source(self.path, "// mine", int(json.loads(json.dumps(float(revision)))))
        assert self.path.read_text() == "// mine"
        with self.assertRaises(ValueError):
            canvas.save_source(self.path, "x" * (canvas.MAX_SOURCE_BYTES + 1), self.path.stat().st_mtime_ns)


class CanvasCommentRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        from fastapi import FastAPI, HTTPException
        from fastapi.testclient import TestClient

        self.state_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        directory = canvas.session_dir(self.state_dir, "sess_1")
        directory.mkdir(parents=True)
        self.path = directory / "report.canvas.tsx"
        self.path.write_text(VALID_SOURCE)
        self.events: list[dict] = []
        self.turns: list[tuple] = []
        self.refuse = False

        async def start_turn(session_id, prompt, display_prompt, capabilities):
            if self.refuse:
                raise HTTPException(status_code=409, detail="chat is archived")
            self.turns.append((session_id, prompt, display_prompt, capabilities))
            return {"queued": True, "queued_id": "q1"} if len(self.turns) == 1 else {"run_id": f"run_{len(self.turns)}"}

        app = FastAPI()
        canvas.register_canvas_routes(
            app, state_dir=self.state_dir, session_exists=lambda session_id: session_id == "sess_1",
            session_events=lambda session_id: iter(self.events), start_turn=start_turn,
        )
        self.client = TestClient(app)
        self.base = "/api/sessions/sess_1/canvases/report"

    def test_thread_lifecycle(self) -> None:
        response = self.client.post(f"{self.base}/comments", json={"anchor": ANCHOR, "mode": "ask", "body": "why?", "revision": 5, "client_capabilities": ["claude_sdk_interactive_v1"]})
        assert response.status_code == 200, response.text
        thread = response.json()["thread"]
        assert thread["status"] == "open" and thread["anchor"]["canvas_id"] == "summary"
        assert thread["messages"][0]["turn"] == {"run_id": None, "queued_id": "q1"}
        assert thread["messages"][0]["reply"] == {"status": "queued"}
        session_id, prompt, display_prompt, capabilities = self.turns[0]
        assert session_id == "sess_1" and "Question: why?" in prompt and display_prompt.endswith("summary · loss 2.41: why?")
        assert capabilities == ["claude_sdk_interactive_v1"]

        self.events[:] = [
            {"type": "turn_started", "run_id": "run_9", "queued_id": "q1"},
            {"type": "turn_finished", "run_id": "run_9", "exit_code": 0, "result_text": "Because.", "ts": "t"},
        ]
        listed = self.client.get(f"{self.base}/comments").json()["threads"]
        assert listed[0]["messages"][0]["reply"] == {"status": "done", "text": "Because.", "finished_at": "t"}
        # Stored: the answer survives the event log going away (rewind, compaction).
        self.events.clear()
        assert self.client.get(f"{self.base}/comments").json()["threads"][0]["messages"][0]["reply"]["text"] == "Because."

        resolved = self.client.patch(f"{self.base}/comments/{thread['id']}", json={"status": "resolved"}).json()["thread"]
        assert resolved["status"] == "resolved"
        followed = self.client.post(f"{self.base}/comments/{thread['id']}/messages", json={"mode": "edit", "body": "fix it", "revision": 6}).json()["thread"]
        assert followed["status"] == "open" and len(followed["messages"]) == 2
        assert "continues an earlier comment thread" in self.turns[1][1]
        assert followed["messages"][1]["turn"]["run_id"] == "run_2"

        assert self.client.delete(f"{self.base}/comments/{thread['id']}").status_code == 200
        assert self.client.get(f"{self.base}/comments").json()["threads"] == []

    def test_refused_turn_stores_nothing_and_bad_input_is_rejected(self) -> None:
        self.refuse = True
        response = self.client.post(f"{self.base}/comments", json={"anchor": ANCHOR, "mode": "ask", "body": "why?", "revision": 5})
        assert response.status_code == 409
        assert self.client.get(f"{self.base}/comments").json()["threads"] == []
        self.refuse = False
        assert self.client.post(f"{self.base}/comments", json={"anchor": ANCHOR, "mode": "rewrite", "body": "x", "revision": 5}).status_code == 400
        assert self.client.post(f"{self.base}/comments", json={"anchor": {"tag": "<b>"}, "mode": "ask", "body": "x", "revision": 5}).status_code == 400
        assert self.client.patch(f"{self.base}/comments/cmt_missing", json={"status": "resolved"}).status_code == 404
        assert self.turns == []

    def test_source_save_detects_a_concurrent_edit(self) -> None:
        revision = self.path.stat().st_mtime_ns
        with patch.object(canvas, "build", lambda path: {"source": path.read_text(), "revision": path.stat().st_mtime_ns}):
            conflict = self.client.put(f"{self.base}/source", json={"source": "// mine", "base_revision": revision - 1_000_000})
            assert conflict.status_code == 409 and "changed since it was opened" in conflict.json()["detail"]
            saved = self.client.put(f"{self.base}/source", json={"source": "// mine", "base_revision": revision})
        assert saved.status_code == 200 and saved.json()["source"] == "// mine"
        assert self.client.put(f"{self.base}/source", json={"source": 3, "base_revision": revision}).status_code == 400


if __name__ == "__main__":
    unittest.main()
