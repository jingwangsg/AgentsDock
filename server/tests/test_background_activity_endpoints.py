"""Background activity: a loaded Codex thread's background terminals, listed and stopped without starting Codex."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

import agent_server


class BackgroundActivityEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_lists_and_stops_loaded_codex_terminals_without_starting_codex(self):
        codex = SimpleNamespace(ready=True, is_thread_loaded=Mock(return_value=True),
            list_background_terminals=AsyncMock(return_value=[{"itemId": "i1", "processId": "p1", "command": "npm run dev", "cwd": "/w"}]),
            terminate_background_terminal=AsyncMock(return_value=True))
        stop = agent_server.BackgroundActivityStopRequest
        with patch.dict(agent_server.STORE.sessions, {"chat": {"id": "chat", "backend": "codex"}}), \
                patch.object(agent_server, "session_codex_thread_id", return_value="thread"), \
                patch.object(agent_server, "existing_codex_app_server_manager", return_value=codex):
            self.assertEqual(await agent_server.get_background_activity("chat"), {"items": [{"id": "p1", "command": "npm run dev"}]})
            self.assertEqual(await agent_server.post_background_activity_stop("chat", stop(id="p1")), {"stopped": True})
            codex.terminate_background_terminal.assert_awaited_once_with("thread", "p1")
            # A process that already exited, or a thread unloaded meanwhile, is reported as not stopped.
            codex.terminate_background_terminal.side_effect = RuntimeError("thread not loaded")
            self.assertEqual(await agent_server.post_background_activity_stop("chat", stop(id="p1")), {"stopped": False})
            codex.list_background_terminals.side_effect = RuntimeError("method not found")
            self.assertEqual(await agent_server.get_background_activity("chat"), {"items": []})
            # Not loaded, or shutting down (a request would start it again): Codex is never asked.
            codex.list_background_terminals.reset_mock()
            codex.terminate_background_terminal.reset_mock()
            for loaded, ready in ((False, True), (True, False)):
                codex.is_thread_loaded.return_value, codex.ready = loaded, ready
                self.assertEqual(await agent_server.get_background_activity("chat"), {"items": []})
                self.assertEqual(await agent_server.post_background_activity_stop("chat", stop(id="p1")), {"stopped": False})
            codex.list_background_terminals.assert_not_awaited()
            codex.terminate_background_terminal.assert_not_awaited()
        with self.assertRaises(HTTPException) as missing:
            await agent_server.get_background_activity("missing-chat")
        self.assertEqual(missing.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
