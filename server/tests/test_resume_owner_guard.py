"""POST /api/sessions refuses a provider conversation a sibling chat already owns."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import agent_server as server


class ResumeOwnerGuardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.state_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = server.SessionStore()
        self.store.sessions = {
            "owner": {
                "id": "owner", "backend": "codex", "title": "dataset browser",
                "codex_thread_id": "01a107ed-97a4-7981-91d6-5d79a5d8a1f2",
                "cwd": "/tmp", "folder": "General", "updated_at": "before",
            },
        }
        for name, value in (
            ("STATE_DIR", self.state_dir),
            ("SESSIONS_FILE", self.state_dir / "sessions.json"),
            ("FILES_ROOT", self.state_dir / "files"),
            ("CODE_DIFFS_ROOT", self.state_dir / "code_diffs"),
            ("CROSS_CHAT_AUTHORITY_ROOT", self.state_dir / "cross_chat_authority"),
            ("STORE", self.store),
            ("HISTORY_SEARCH_DIRTY", set()),
        ):
            self.enterContext(patch.object(server, name, value))

    async def asyncTearDown(self) -> None:
        await self.store.flush_pending_save()

    async def test_a_thread_a_sibling_chat_owns_is_refused_and_names_the_owner(self) -> None:
        request = server.CreateSessionRequest(
            backend="codex", cwd="/tmp", title="Resumed Codex 01a107ed",
            provider_session_id="01a107ed-97a4-7981-91d6-5d79a5d8a1f2", import_history=True,
        )
        with self.assertRaises(HTTPException) as raised:
            await server.create_session(request)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("dataset browser", str(raised.exception.detail))
        self.assertEqual(list(self.store.sessions), ["owner"])

    async def test_an_archived_owner_is_named_as_archived(self) -> None:
        self.store.sessions["owner"]["archived"] = True
        request = server.CreateSessionRequest(
            backend="codex", cwd="/tmp",
            provider_session_id="01a107ed-97a4-7981-91d6-5d79a5d8a1f2",
        )
        with self.assertRaises(HTTPException) as raised:
            await server.create_session(request)
        self.assertIn("(archived)", str(raised.exception.detail))

    async def test_a_thread_no_chat_owns_still_creates(self) -> None:
        with patch.object(server, "other_local_instance_provider_keys", return_value=set()), \
                patch.object(server, "import_session_history", return_value={"imported": 0}):
            result = await server.create_session(server.CreateSessionRequest(
                backend="codex", cwd="/tmp", provider_session_id="01a1ffff-0000-7000-8000-000000000000",
            ))
        self.assertEqual(result["session"]["codex_thread_id"], "01a1ffff-0000-7000-8000-000000000000")
