"""A background read of a chat's timeline (prefetch=true) returns the same page as an open, without starting what only
an open should: the provider history sync and the queue repair."""

import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import agent_server as server

SESSION = "sess_prefetch_read"
AUTH = {"Authorization": "Bearer test-secret"}


class SessionPrefetchTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.enterContext(patch.dict(server.STORE.sessions, {SESSION: {
            "id": SESSION, "title": "prefetch", "backend": "codex", "cwd": "/work", "created_at": "2026-11-03T01:00:00Z",
        }}))
        self.history_sync = self.enterContext(patch.object(server, "schedule_provider_history_sync"))
        self.queue_repair = self.enterContext(patch.object(server, "reconcile_idle_queue_session_from_snapshot", AsyncMock(return_value=False)))
        self.client = TestClient(server.app)

    def page(self, query: str) -> dict:
        response = self.client.get(f"/api/sessions/{SESSION}?{query}", headers=AUTH)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_an_open_starts_the_history_sync_and_queue_repair(self):
        self.page("after=0&limit=40&tail=false&visible=true")
        self.history_sync.assert_called_once()
        self.queue_repair.assert_awaited_once_with(SESSION)

    def test_health_tells_clients_the_flag_is_taken(self):
        response = self.client.get("/api/health", headers=AUTH)
        self.assertEqual(response.json()["capabilities"]["session_prefetch_v1"], {"available": True, "version": 1})

    def test_a_prefetch_starts_neither_and_returns_the_same_page(self):
        opened = self.page("after=0&limit=40&tail=false&visible=true")
        self.history_sync.reset_mock()
        self.queue_repair.reset_mock()
        for flag in ("true", "1"):
            with self.subTest(prefetch=flag):
                self.assertEqual(self.page(f"after=0&limit=40&tail=false&visible=true&prefetch={flag}"), opened)
        self.history_sync.assert_not_called()
        self.queue_repair.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
