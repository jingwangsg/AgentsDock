"""Display-only session edits answer before sessions.json is replaced."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
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


class StoreLockDiskIoTests(unittest.IsolatedAsyncioTestCase):
    """One chat's sessions.json write must not block another chat's metadata."""

    def setUp(self) -> None:
        self.state_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = server.SessionStore()
        self.store.sessions = {
            "a": {
                "id": "a", "backend": "claude", "title": "A", "cwd": "/tmp",
                "folder": "General", "updated_at": "before", "sort_order": 1000,
            },
            "b": {
                "id": "b", "backend": "claude", "title": "B", "cwd": "/tmp",
                "folder": "General", "updated_at": "before", "sort_order": 2000,
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
        self.enterContext(patch.object(server, "append_event", AsyncMock()))
        self.enterContext(
            patch.object(server, "broadcast_provider_runtime_changed", AsyncMock()),
        )

    async def asyncTearDown(self) -> None:
        await self.store.flush_pending_save()

    def hold_writes(self) -> tuple[threading.Event, threading.Event]:
        """Make the writer thread signal entry and block until released."""

        real_write = server.write_sessions_json_text
        started, release = threading.Event(), threading.Event()

        def held_write(path: Path, text: str, **kwargs: object) -> None:
            started.set()
            release.wait(5)
            real_write(path, text, **kwargs)

        self.enterContext(patch.object(server, "write_sessions_json_text", held_write))
        return started, release

    async def test_store_mutations_wait_for_disk_outside_the_store_lock(self) -> None:
        cases = {
            "update": lambda: self.store.update("a", {"auto_title_enabled": False}),
            "create": lambda: self.store.create(
                server.CreateSessionRequest(backend="claude", cwd="/tmp"),
            ),
            "reorder": lambda: self.store.reorder("a", direction="down"),
            "mark_backend_started": lambda: self.store.mark_backend_started("a", "claude"),
            "save_provider_session": lambda: self.store.save_provider_session(
                "a", "claude-1", "claude",
            ),
        }
        for name, start in cases.items():
            with self.subTest(method=name):
                started, release = self.hold_writes()
                task = asyncio.create_task(start())
                self.assertTrue(await asyncio.to_thread(started.wait, 5))
                self.assertFalse(self.store._lock.locked())
                release.set()
                await task
                await self.store.flush_pending_save()

    async def test_authorization_patches_keep_the_lock_through_the_write(self) -> None:
        # The rollback restores a whole-session snapshot, so no other mutation
        # may interleave with the write: these PATCHes keep the awaited save
        # inside the lock.
        started, release = self.hold_writes()
        task = asyncio.create_task(
            self.store.update("a", {"provider_jobs_access": "read_only"}),
        )
        self.assertTrue(await asyncio.to_thread(started.wait, 5))
        self.assertTrue(self.store._lock.locked())
        release.set()
        await task

    async def test_provider_binding_waits_for_disk_outside_both_global_locks(self) -> None:
        started, release = self.hold_writes()
        with (
            patch.dict(server.ACTIVE, {"a": {"run_id": "run-1"}}),
            patch.object(server, "BUSY_SESSIONS", {"a"}),
        ):
            task = asyncio.create_task(server.persist_run_provider_session(
                "a", "run-1", "claude", "claude-1",
            ))
            self.assertTrue(await asyncio.to_thread(started.wait, 5))
            self.assertFalse(server.ACTIVE_LOCK.locked())
            self.assertFalse(self.store._lock.locked())
            self.assertEqual(self.store.sessions["a"]["claude_session_id"], "claude-1")
            release.set()
            self.assertTrue(await task)

    async def test_read_marks_answer_before_the_sessions_write(self) -> None:
        real_write = server.write_sessions_json_text

        def slow_write(path: Path, text: str, **kwargs: object) -> None:
            time.sleep(1.0)
            real_write(path, text, **kwargs)

        self.enterContext(patch.object(server, "write_sessions_json_text", slow_write))
        started = time.monotonic()
        await self.store.mark_read("a", 3)
        await self.store.mark_unread("a")
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(self.store.save_write_count, 0)

        await self.store.flush_pending_save()
        on_disk = json.loads((self.state_dir / "sessions.json").read_text(encoding="utf-8"))
        self.assertTrue(on_disk["a"]["manual_unread"])
        self.assertEqual(on_disk["a"]["last_read_agent_event_seq"], 2)
        self.assertEqual(self.store.save_write_count, 1)

    async def test_usage_checkpoints_do_not_wait_for_the_sessions_write(self) -> None:
        save = AsyncMock(wraps=self.store.save)
        self.enterContext(patch.object(self.store, "save", save))
        self.store.sessions["a"].update({
            "backend": "codex", "codex_thread_id": "thread-1", "session_id": "thread-1",
        })
        self.assertTrue(await server.record_codex_token_usage("a", {
            "thread_id": "thread-1", "turn_id": "turn-1", "run_id": "run-1",
            "token_usage": {"total_tokens": 10},
        }))
        save.assert_awaited_once_with(flush=False)

        save.reset_mock()
        self.store.sessions["b"].update({
            "claude_session_id": "claude-1", "session_id": "claude-1",
        })
        with patch.dict(server.ACTIVE, {"b": {
            "run_id": "run-1", "backend": "claude",
            "transport": server.CLAUDE_TRANSPORT_AGENT_SDK,
            "claude_sdk_owner_token": "owner",
        }}):
            self.assertTrue(await server.record_claude_context_usage(
                "b",
                {"run_id": "run-1", "provider_session_id": "claude-1", "input_tokens": 1},
                ownership_token="owner",
            ))
        save.assert_awaited_once_with(flush=False)


if __name__ == "__main__":
    unittest.main()
