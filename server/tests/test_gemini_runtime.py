from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import agent_server as server
import gemini_gateway


class GeminiRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_permission_patch_reaches_the_persisted_chat(self):
        store = server.SessionStore()
        store.sessions["chat"] = {"id": "chat", "backend": "gemini", "folder": "General"}
        with patch.object(store, "save", AsyncMock()):
            chat = await store.update("chat", {"gemini_permission_mode": "plan"})
        self.assertEqual(server.public_session(chat)["gemini_permission_mode"], "plan")
        self.assertEqual(store.sessions["chat"]["gemini_permission_mode"], "plan")

    def test_catalog_exhaustion_reports_the_hub_reason(self):
        with (patch.object(server, "HUB_PROVIDER_INSTALL", None),
              patch.object(server.shutil, "which", return_value="/fixture/gemini"),
              patch.object(server, "runtime_command", side_effect=[
                  SimpleNamespace(stdout="0.71.1"), SimpleNamespace(stdout="Gemini CLI --session-id --resume --approval-mode stream-json")
              ]),
              patch.object(gemini_gateway, "credential", return_value="fixture"),
              patch.object(gemini_gateway, "models", side_effect=gemini_gateway.GatewayError(422, budget=True))):
            diagnostic = server.probe_runtime("gemini")
        self.assertEqual(diagnostic["status"], "error")
        self.assertIn("budget", diagnostic["message"])
        self.assertNotIn("fixture", diagnostic["message"])
