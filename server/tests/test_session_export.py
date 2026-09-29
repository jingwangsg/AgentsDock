"""Download a chat as Markdown or as its raw event log."""

import json
import unittest
from unittest.mock import patch
from urllib.parse import unquote

from fastapi.testclient import TestClient

import agent_server as server

SESSION = "sess_export_test"
EVENTS = [
    {"seq": 1, "type": "session_created", "ts": "2026-09-29T01:00:00Z", "session": {"id": SESSION}},
    {"seq": 2, "type": "turn_started", "ts": "2026-09-29T01:00:05Z", "run_id": "r1", "prompt": "找附近的理疗诊所",
     "provider_cross_chat_route_snapshot": [{"token": "server-only"}]},
    {"seq": 3, "type": "reasoning_summary", "ts": "2026-09-29T01:00:06Z", "run_id": "r1", "text": "private reasoning"},
    {"seq": 4, "type": "tool_started", "ts": "2026-09-29T01:00:07Z", "run_id": "r1",
     "tool": {"name": "Bash", "input": {"command": "cat <<'EOF'\n```python\n# Notes\nEOF"}}},
    {"seq": 5, "type": "assistant_text", "ts": "2026-09-29T01:00:09Z", "run_id": "r1", "text": "Here are three clinics."},
    {"seq": 6, "type": "turn_finished", "ts": "2026-09-29T01:00:10Z", "run_id": "r1", "result_text": "Here are three clinics."},
    {"seq": 7, "type": "turn_started", "ts": "2026-09-29T02:00:00Z", "run_id": "r2", "prompt": "Which is closest?"},
    {"seq": 8, "type": "turn_finished", "ts": "2026-09-29T02:00:30Z", "run_id": "r2", "result_text": "The first one."},
    {"seq": 9, "type": "error", "ts": "2026-09-29T02:01:00Z", "run_id": "r3", "message": "Claude is not authenticated on this server."},
]


class SessionExportTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.enterContext(patch.dict(server.STORE.sessions, {SESSION: {
            "id": SESSION, "title": "理疗诊所 / nearby", "backend": "codex", "model": "gpt-6-astra",
            "cwd": "/work", "created_at": "2026-09-29T01:00:00Z", "codex_thread_id": "thread-1",
        }}))
        path = server.events_path(SESSION)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(event, ensure_ascii=False) + "\n" for event in EVENTS))
        self.client = TestClient(server.app)

    def get(self, fmt):
        return self.client.get(f"/api/sessions/{SESSION}/export?format={fmt}", headers={"Authorization": "Bearer test-secret"})

    def test_markdown_has_each_turn_and_tool_once_and_no_reasoning(self):
        response = self.get("markdown")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/markdown"))
        disposition = response.headers["content-disposition"]
        self.assertIn('filename="nearby.md"', disposition)
        self.assertEqual(unquote(disposition.split("filename*=UTF-8''")[1]), "理疗诊所 nearby.md")
        text = response.text
        self.assertTrue(text.startswith("# 理疗诊所 / nearby\n"))
        self.assertIn("- Provider session: thread-1", text)
        self.assertIn("## You · 2026-09-29 01:00 UTC\n\n找附近的理疗诊所", text)
        # A multi-line command stays on one line, so it cannot open a fence or heading.
        self.assertIn("- Tool `Bash`: cat <<'EOF' ```python # Notes EOF\n", text)
        self.assertNotIn("\n```python", text)
        self.assertEqual(text.count("Here are three clinics."), 1)
        self.assertIn("## Assistant · 2026-09-29 02:00 UTC\n\nThe first one.", text)
        self.assertIn("**Error · 2026-09-29 02:01 UTC:** Claude is not authenticated on this server.", text)
        self.assertNotIn("private reasoning", text)
        self.assertLess(text.index("找附近"), text.index("Which is closest?"))

    def test_jsonl_is_the_client_safe_event_log(self):
        response = self.get("jsonl")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/x-ndjson")
        self.assertIn('filename="nearby.jsonl"', response.headers["content-disposition"])
        self.assertEqual([json.loads(line)["seq"] for line in response.text.splitlines()], list(range(1, 10)))
        self.assertNotIn("server-only", response.text)

    def test_unknown_session_and_bad_format(self):
        missing = self.client.get("/api/sessions/sess_missing/export", headers={"Authorization": "Bearer test-secret"})
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(self.get("pdf").status_code, 422)


if __name__ == "__main__":
    unittest.main()
