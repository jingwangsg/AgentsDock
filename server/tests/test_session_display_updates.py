"""Display-only session edits answer before sessions.json is replaced."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import agent_server as server


class SessionDisplayUpdateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.state_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = server.SessionStore()
        self.store.sessions = {
            "chat": {
                "id": "chat", "backend": "claude", "title": "Before",
                "cwd": "/tmp", "folder": "General", "updated_at": "before",
            },
        }
        # save() runs ensure_dirs(), which creates these four roots; keep them
        # inside the temporary directory.
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
        # Let the writer finish before the temporary directory is removed.
        await self.store.flush_pending_save()

    async def test_display_only_patches_skip_the_flush_wait(self) -> None:
        save = AsyncMock(wraps=self.store.save)
        self.enterContext(patch.object(self.store, "save", save))
        for body in (
            {"title": "After"},
            {"title": "Again", "folder": "Work", "pinned": True},
        ):
            with self.subTest(body=body):
                save.reset_mock()
                await server.update_session("chat", server.UpdateSessionRequest(**body))
                save.assert_awaited_once_with(flush=False)

        # Anything beyond the display fields keeps the awaited write.
        save.reset_mock()
        await server.update_session(
            "chat", server.UpdateSessionRequest(title="Later", auto_title_enabled=False),
        )
        save.assert_awaited_once_with(flush=True)

        # Direct store callers are unchanged.
        save.reset_mock()
        await self.store.update("chat", {"title": "Direct"})
        save.assert_awaited_once_with(flush=True)

    async def test_rename_answers_before_a_slow_write_and_still_lands(self) -> None:
        real_write = server.write_sessions_json_text

        def slow_write(path: Path, text: str, **kwargs: object) -> None:
            # Hold the write past the bound asserted below; a request that
            # waited for it fails the test.
            time.sleep(1.0)
            real_write(path, text, **kwargs)

        self.enterContext(patch.object(server, "write_sessions_json_text", slow_write))
        started = time.monotonic()
        result = await server.update_session("chat", server.UpdateSessionRequest(title="After"))
        elapsed = time.monotonic() - started

        self.assertEqual(result["session"]["title"], "After")
        self.assertLess(elapsed, 0.5)
        self.assertEqual(self.store.save_write_count, 0)

        await self.store.flush_pending_save()
        on_disk = json.loads((self.state_dir / "sessions.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["chat"]["title"], "After")
        self.assertEqual(self.store.save_write_count, 1)


if __name__ == "__main__":
    unittest.main()
