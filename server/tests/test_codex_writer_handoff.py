"""Codex thread writer handoff: catalog refresh admission and resume waits."""
import unittest
from unittest.mock import AsyncMock, Mock, patch

import agent_server
from codex_app_server import CodexAppServerRequestError


def writer_conflict(thread_id: str) -> CodexAppServerRequestError:
    return CodexAppServerRequestError(
        "thread/resume", {"code": -32600, "message": f"thread {thread_id} already has an active writer"})


class FakeManager:
    def __init__(self, failures: int, loaded: set[str] | None = None) -> None:
        self.failures = failures
        self.loaded = set(loaded or ())
        self.resume_calls: list[tuple[str, dict]] = []

    def is_thread_loaded(self, thread_id: str) -> bool:
        return thread_id in self.loaded

    def active_turn(self, thread_id: str):
        return None

    async def resume_thread(self, thread_id: str, params=None) -> str:
        self.resume_calls.append((thread_id, dict(params or {})))
        if self.failures:
            self.failures -= 1
            raise writer_conflict(thread_id)
        self.loaded.add(thread_id)
        return thread_id


class RuntimeCatalogRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def run_catalog(self, **query):
        binary, login, claude_native = AsyncMock(), AsyncMock(), AsyncMock()
        with patch.object(agent_server, "refresh_codex_app_server_binary", binary), \
                patch.object(agent_server, "refresh_codex_app_server_login", login), \
                patch.object(agent_server, "refresh_claude_native_models", claude_native), \
                patch.object(agent_server, "discover_runtime_catalog", Mock(return_value={"backends": {}})):
            await agent_server.runtime_catalog(**query)
        return binary, login, claude_native

    async def test_plain_refresh_reprobes_without_retiring_the_codex_process(self):
        binary, login, claude_native = await self.run_catalog(refresh=True)
        binary.assert_awaited_once_with(force=True)
        login.assert_awaited_once_with(request_handoff=False)
        claude_native.assert_awaited_once_with(explicit=False)

    async def test_explicit_recheck_requests_the_handoff(self):
        _binary, login, claude_native = await self.run_catalog(refresh=True, handoff=True)
        login.assert_awaited_once_with(request_handoff=True)
        claude_native.assert_awaited_once_with(explicit=True)

    async def test_cached_catalog_touches_neither(self):
        binary, login, claude_native = await self.run_catalog()
        binary.assert_not_awaited()
        login.assert_not_awaited()
        claude_native.assert_not_awaited()


class ResumeAwaitingWriterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.evict = AsyncMock(return_value=True)
        self.drain = Mock()
        self.others: list = []
        for item in (
            patch.object(agent_server, "CODEX_WRITER_RELEASE_RETRY_DELAYS", (0.0, 0.0)),
            patch.object(agent_server, "evict_codex_app_server_thread", self.evict),
            patch.object(agent_server, "schedule_codex_manager_drain", self.drain),
            patch.object(agent_server, "codex_app_server_managers", lambda: tuple(self.others)),
        ):
            item.start()
            self.addCleanup(item.stop)

    async def test_resume_retries_while_the_previous_process_releases_the_writer(self):
        manager = FakeManager(failures=2)
        holder = FakeManager(failures=0, loaded={"thread-1"})
        self.others[:] = [manager, holder]
        resolved = await agent_server.resume_codex_thread_with_retry(manager, "thread-1", {"excludeTurns": True})
        self.assertEqual(resolved, "thread-1")
        self.assertEqual(len(manager.resume_calls), 3)
        self.evict.assert_any_await(holder, "thread-1", reinsert_on_failure=False)
        self.assertTrue(self.drain.called)

    async def test_persistent_writer_conflict_becomes_a_transient_admission_wait(self):
        manager = FakeManager(failures=99)
        self.others[:] = [manager]
        with self.assertRaises(agent_server.TransientAdmissionWait) as caught:
            await agent_server.resume_codex_thread_with_retry(manager, "thread-1", {})
        self.assertEqual(caught.exception.status_code, 409)
        # A writer that outlasts the retries is another process, such as a `codex resume` left open.
        self.assertEqual(caught.exception.detail, agent_server.CODEX_FOREIGN_WRITER_DETAIL)
        self.assertEqual(len(manager.resume_calls), 3)  # one attempt per delay, then the final one
        self.evict.assert_not_awaited()

    async def test_a_thread_that_never_finishes_closing_reports_the_unload(self):
        manager = FakeManager(failures=0)

        async def resume(thread_id, params=None):
            raise CodexAppServerRequestError("thread/resume", {"code": -32600, "message":
                f"thread {thread_id} is closing; retry thread/resume after the thread is closed"})
        manager.resume_thread = resume
        self.others[:] = [manager]
        with self.assertRaises(agent_server.TransientAdmissionWait) as caught:
            await agent_server.resume_codex_thread_with_retry(manager, "thread-1", {})
        self.assertEqual(caught.exception.detail, agent_server.CODEX_THREAD_CLOSING_DETAIL)

    async def test_resume_retries_while_the_same_process_is_still_closing_the_thread(self):
        manager = FakeManager(failures=0)
        attempts = []

        async def resume(thread_id, params=None):
            attempts.append(thread_id)
            if len(attempts) == 1:
                raise CodexAppServerRequestError("thread/resume", {"code": -32600, "message":
                    f"thread {thread_id} is closing; retry thread/resume after the thread is closed"})
            return thread_id
        manager.resume_thread = resume
        self.others[:] = [manager]
        self.assertEqual(await agent_server.resume_codex_thread_with_retry(manager, "thread-1", {}), "thread-1")
        self.assertEqual(len(attempts), 2)
        self.evict.assert_not_awaited()

    async def test_other_request_errors_propagate_at_once(self):
        manager = FakeManager(failures=0)

        async def resume(thread_id, params=None):
            raise CodexAppServerRequestError("thread/resume", {"code": -32602, "message": "bad params"})
        manager.resume_thread = resume
        with self.assertRaises(CodexAppServerRequestError):
            await agent_server.resume_codex_thread_with_retry(manager, "thread-1", {})
        self.assertFalse(self.drain.called)


if __name__ == "__main__":
    unittest.main()
