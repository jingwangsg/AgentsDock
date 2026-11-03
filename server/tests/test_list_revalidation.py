"""The chat list, a chat's subagents and its files list: gzipped for a client that accepts it, and an empty 304 for
a client whose cached copy is still current; health is gzipped only. Decoded, every 200 is the same bytes as before."""

import gzip
import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import agent_server as server

SESSION = "sess_list_revalidation"
AUTH = {"Authorization": "Bearer test-secret"}


class ListRevalidationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.enterContext(patch.dict(server.STORE.sessions, {SESSION: {
            "id": SESSION, "title": "lists " * 40, "backend": "codex", "cwd": "/work", "created_at": "2026-11-03T01:00:00Z",
        }}))
        self.subagents = [{"seq": index, "type": "subagent_state", "subagent_id": f"child-{index}",
                           "subagent_log": [{"ts": "2026-11-03T01:00:00Z", "text": f"step {step} of child {index}"} for step in range(80)]}
                          for index in range(8)]
        self.files = [{"id": f"file_{index:016x}", "filename": f"shot-{index}.png", "content_type": "image/png", "size": 1000 + index}
                      for index in range(40)]
        self.enterContext(patch.object(server, "build_subagent_snapshot", lambda session_id, limit: {
            "session_id": session_id, "subagents": self.subagents, "count": len(self.subagents), "active_count": 0, "latest_seq": 7}))
        self.enterContext(patch.object(server, "list_session_file_records", lambda session_id: list(self.files)))
        self.client = TestClient(server.app)

    def raw(self, path: str, **headers: str):
        # httpx asks for gzip by default; plain unless a test asks.
        with self.client.stream("GET", path, headers={**AUTH, "Accept-Encoding": "identity", **headers}) as response:
            return response.status_code, response.headers, b"".join(response.iter_raw())

    def test_each_list_is_gzipped_and_revalidated(self):
        for path in ("/api/sessions?summary=true", f"/api/sessions/{SESSION}/subagents?limit=64",
                     f"/api/sessions/{SESSION}/files?offset=0&limit=60"):
            with self.subTest(path=path):
                status, headers, plain = self.raw(path)
                self.assertEqual(status, 200)
                self.assertNotIn("content-encoding", headers)
                self.assertEqual(headers["cache-control"], "private, no-cache")
                self.assertEqual(headers["vary"], "Accept-Encoding")
                etag = headers["etag"]
                self.assertRegex(etag, r'^W/"[0-9a-f]{32}"$')

                status, headers, packed = self.raw(path, **{"Accept-Encoding": "zstd, br, gzip"})
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-encoding"], "gzip")
                self.assertEqual(int(headers["content-length"]), len(packed))
                self.assertEqual(gzip.decompress(packed), plain)
                self.assertEqual(headers["etag"], etag, "both encodings name the same JSON")

                for sent in (etag, f'W/"0000", {etag}'):
                    status, headers, empty = self.raw(path, **{"Accept-Encoding": "gzip", "If-None-Match": sent})
                    self.assertEqual(status, 304)
                    self.assertEqual(empty, b"")
                    self.assertEqual(headers["etag"], etag)
                    self.assertNotIn("content-encoding", headers)

                status, _, body = self.raw(path, **{"If-None-Match": 'W/"0000"'})
                self.assertEqual(status, 200)
                self.assertEqual(body, plain)

    def test_health_is_gzipped_but_never_revalidated(self):
        status, headers, packed = self.raw("/api/health", **{"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-encoding"], "gzip")
        self.assertTrue(json.loads(gzip.decompress(packed))["ok"])
        self.assertNotIn("etag", headers, "its load and memory figures change on every call")
        status, headers, plain = self.raw("/api/health")
        self.assertNotIn("content-encoding", headers)
        self.assertTrue(json.loads(plain)["ok"])

    def test_a_change_moves_the_tag(self):
        path = f"/api/sessions/{SESSION}/subagents?limit=64"
        _, headers, _ = self.raw(path)
        before = headers["etag"]
        self.subagents[0] = {**self.subagents[0], "subagent_status": "completed"}
        status, headers, body = self.raw(path, **{"If-None-Match": before})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["etag"], before)
        self.assertEqual(json.loads(body)["subagents"][0]["subagent_status"], "completed")

    def test_an_error_carries_no_tag(self):
        status, headers, _ = self.raw("/api/sessions/sess_missing/files", **{"Accept-Encoding": "gzip"})
        self.assertEqual(status, 404)
        self.assertNotIn("etag", headers)
        self.assertNotIn("content-encoding", headers)

    def test_a_file_is_marked_immutable(self):
        path = server.STATE_DIR / "list-revalidation-file.png"
        path.write_bytes(b"\x89PNG fixed bytes")
        self.addCleanup(path.unlink)
        meta = {"id": "file_00000000000000aa", "path": str(path), "filename": "shot.png", "content_type": "image/png"}
        with patch.object(server, "require_session_file_meta", lambda session_id, file_id: meta):
            response = self.client.get(f"/api/sessions/{SESSION}/files/{meta['id']}", headers=AUTH)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"\x89PNG fixed bytes")
        self.assertEqual(response.headers["cache-control"], "private, max-age=31536000, immutable")
        self.assertTrue(response.headers["etag"])


if __name__ == "__main__":
    unittest.main()
