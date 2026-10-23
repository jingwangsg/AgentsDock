"""A chat page is gzipped for a client that accepts it; decoded, it is the same bytes."""

import gzip
import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import agent_server as server

SESSION = "sess_page_gzip_test"


class SessionPageGzipTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.enterContext(patch.dict(server.STORE.sessions, {SESSION: {
            "id": SESSION, "title": "gzip", "backend": "codex", "cwd": "/work", "created_at": "2026-10-23T01:00:00Z",
        }}))
        events = []
        for turn in range(1, 41):
            events += [
                {"seq": 3 * turn - 2, "type": "turn_started", "run_id": f"r{turn}", "prompt": f"第 {turn} 个问题 " * 20},
                {"seq": 3 * turn - 1, "type": "assistant_text", "run_id": f"r{turn}", "text": f"Answer {turn} " * 50},
                {"seq": 3 * turn, "type": "turn_finished", "run_id": f"r{turn}", "result_text": f"Answer {turn}"},
            ]
        path = server.events_path(SESSION)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events))
        self.client = TestClient(server.app)

    def raw(self, query: str, encoding: str):
        headers = {"Authorization": "Bearer test-secret", "Accept-Encoding": encoding}
        with self.client.stream("GET", f"/api/sessions/{SESSION}?{query}", headers=headers) as response:
            return response.status_code, response.headers, b"".join(response.iter_raw())

    def test_every_page_mode_is_gzipped_only_for_a_client_that_accepts_it(self):
        for query in ("after=30&limit=240&tail=false&visible=true", "limit=48&tail=true&visible=true&page_mode=semantic",
                      "limit=1"):
            with self.subTest(query=query):
                status, headers, plain = self.raw(query, "identity")
                self.assertEqual(status, 200)
                self.assertNotIn("content-encoding", headers)
                self.assertEqual(headers["vary"], "Accept-Encoding")
                self.assertTrue(json.loads(plain)["events"])

                status, headers, packed = self.raw(query, "gzip, deflate, br")
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-encoding"], "gzip")
                self.assertEqual(headers["vary"], "Accept-Encoding")
                self.assertEqual(int(headers["content-length"]), len(packed))
                self.assertEqual(gzip.decompress(packed), plain)
                self.assertLess(len(packed), len(plain) / 2)

    def test_an_error_is_not_encoded(self):
        status, headers, body = self.raw("page_mode=bogus&limit=1", "gzip")
        self.assertEqual(status, 400)
        self.assertNotIn("content-encoding", headers)
        self.assertIn("page_mode", json.loads(body)["detail"])


if __name__ == "__main__":
    unittest.main()
