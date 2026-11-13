"""The chat list, a chat's subagents and its files list: gzipped for a client that accepts it, and an empty 304 for
a client whose cached copy is still current; health and eight more JSON reads are gzipped but never revalidated.
A body gzip cannot make smaller stays plain. Decoded, every 200 is the same bytes as before."""

import gzip
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

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

    def test_eight_more_json_reads_are_gzipped_but_never_revalidated(self):
        # 2026-11-13: these went out plain; the jobs list was 22 KB on every read and a deploy's status 12.6 KB every few seconds.
        rows = [{"id": f"row-{index}", "name": f"entry {index}", "detail": "state " * 20} for index in range(30)]
        deploy_job = Mock(server=None)
        deploy_job.view.return_value = {"log": rows}
        for name, value in (("public_job", lambda row: row), ("discover_runtime_catalog", lambda **_: {"backends": rows}),
                            ("build_timeline_index", lambda session_id: {"rows": rows}),
                            ("claude_runtime_snapshot", AsyncMock(return_value={"runtime": rows})),
                            ("codex_runtime_snapshot", AsyncMock(return_value={"runtime": rows})),
                            ("complete_working_directory_sync", lambda path, limit: {"entries": rows})):
            self.enterContext(patch.object(server, name, value))
        self.enterContext(patch.dict(server.JOBS.jobs, {row["id"]: row for row in rows}, clear=True))
        self.enterContext(patch.object(server.REMOTE_SERVERS, "list", lambda: rows))
        self.enterContext(patch.object(server.REMOTE_SERVERS, "job", lambda job_id: deploy_job))
        reads = [(path, AUTH) for path in ("/api/jobs", "/api/runtime/catalog", "/api/working-directories/complete?path=/w",
                                           f"/api/sessions/{SESSION}/timeline-index", f"/api/sessions/{SESSION}/claude/runtime",
                                           f"/api/sessions/{SESSION}/codex/runtime")]
        reads += [(path, {"X-AgentsDock-Token": "test-secret"})
                  for path in ("/api/admin/remote-servers", "/api/admin/remote-servers/deploy/0123456789abcdef")]

        # raw() always sends the bearer header, which the hub's admin routes refuse beside the native one.
        def fetch(path: str, auth: dict[str, str], encoding: str):
            with self.client.stream("GET", path, headers={**auth, "Accept-Encoding": encoding}) as response:
                return response.status_code, response.headers, b"".join(response.iter_raw())

        for path, auth in reads:
            with self.subTest(path=path):
                status, headers, plain = fetch(path, auth, "identity")
                self.assertEqual(status, 200)
                self.assertNotIn("content-encoding", headers)
                self.assertEqual(headers["vary"], "Accept-Encoding")
                self.assertNotIn("etag", headers)
                self.assertIn(b"entry 29", plain)

                status, headers, packed = fetch(path, auth, "gzip, deflate, br")
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-encoding"], "gzip")
                self.assertEqual(int(headers["content-length"]), len(packed))
                self.assertEqual(gzip.decompress(packed), plain)
                self.assertLess(len(packed), len(plain) / 2)

    def test_a_body_gzip_cannot_make_smaller_stays_plain(self):
        # gzip's header and trailer are 20 bytes: a server without scheduled jobs answers 11 bytes, which would grow to 31.
        self.enterContext(patch.dict(server.JOBS.jobs, {}, clear=True))
        status, headers, body = self.raw("/api/jobs", **{"Accept-Encoding": "gzip"})
        self.assertEqual((status, body), (200, b'{"jobs":[]}'))
        self.assertNotIn("content-encoding", headers)
        self.assertEqual(int(headers["content-length"]), len(body))

    def test_compressing_does_not_wait_for_the_default_thread_pool(self):
        # That pool fills up when a filesystem stalls. The jobs list needs no thread of its own, so with gzip on the
        # default pool it would answer only when a thread came free.
        self.enterContext(patch.dict(server.JOBS.jobs, {f"job-{index}": {"id": f"job-{index}", "name": "nightly " * 20} for index in range(30)}, clear=True))
        self.enterContext(patch.object(server, "public_job", lambda row: row))
        with patch.object(server.asyncio, "to_thread", side_effect=AssertionError("the default pool was used")):
            status, headers, _ = self.raw("/api/jobs", **{"Accept-Encoding": "gzip"})
        self.assertEqual((status, headers["content-encoding"]), (200, "gzip"))

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
