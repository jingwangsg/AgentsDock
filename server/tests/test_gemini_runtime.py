import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import agent_server as server
import gemini_agent_client as gemini
import gemini_gateway
import hub_provider_auth as auth


class GeminiRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_change_clears_incompatible_effort_and_rejects_an_explicit_pair(self):
        store = server.SessionStore()
        store.sessions["chat"] = {"id": "chat", "backend": "gemini", "folder": "General"}
        other = "gcp/google/gemini-fixture"
        with patch.object(store, "save", AsyncMock()):
            selected = await store.update("chat", {"model": gemini.DEFAULT_MODEL, "effort": "medium"})
            self.assertEqual(server.public_session(selected)["effort"], "medium")
            with self.assertRaises(server.HTTPException) as raised:
                await store.update("chat", {"model": other, "effort": "high"})
            self.assertEqual(raised.exception.status_code, 400)
            self.assertEqual(store.sessions["chat"]["model"], gemini.DEFAULT_MODEL)
            changed = await store.update("chat", {"model": other})
            self.assertIsNone(server.public_session(changed)["effort"])

    async def test_rejected_reasoning_does_not_lock_first_turn_backend(self):
        store = server.SessionStore()
        chat = {"id": "gemini-effort", "backend": "gemini", "folder": "General", "effort": "low"}
        store.sessions[chat["id"]] = chat
        legacy = {"_gemini_models": [gemini.DEFAULT_MODEL], "_executable": "/fixture/gemini"}
        with (patch.object(server, "STORE", store), patch.object(store, "save", AsyncMock()),
              patch.object(server, "ensure_runtime_available", AsyncMock(return_value=legacy))):
            with self.assertRaises(server.HTTPException) as raised:
                await server.start_turn(chat["id"], server.TurnRequest(prompt="hello"), queue_if_busy=False)
            self.assertEqual(raised.exception.status_code, 409)
            self.assertIn("reasoning", raised.exception.detail)
            self.assertFalse(server.session_backend_locked(chat))

    async def test_managed_hub_grant_controls_catalog_and_native_environment(self):
        root = Path(self.enterContext(TemporaryDirectory(dir="/tmp")))
        grant = {"accessToken": "fixture", "port": 12345}
        socket_path = root / "relay.sock"

        async def issue(reader, writer):
            await reader.readline()
            writer.write(json.dumps(grant).encode() + b"\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        fixture = await asyncio.start_unix_server(issue, socket_path)
        self.enterContext(patch.object(auth, "socket_path", return_value=socket_path))
        self.enterContext(patch.multiple(server, HUB_PROVIDER_INSTALL=root, RUNTIME_DIAGNOSTICS={}, RUNTIME_DIAGNOSTIC_GENERATIONS={}))
        self.enterContext(patch.object(server.shutil, "which", return_value="/fixture/gemini"))
        help_text = "Gemini CLI --session-id --resume --approval-mode stream-json"
        output = {"--version": "0.71.1", "--help": help_text}
        self.enterContext(patch.object(server, "runtime_command", side_effect=lambda cmd: SimpleNamespace(stdout=output[cmd[-1]])))
        self.enterContext(patch.object(gemini_gateway, "models", return_value=[gemini.DEFAULT_MODEL, "gcp/google/gemini-fixture"]))
        env = {"HOME": str(root), "GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(root / "settings.json")}
        async with fixture:
            for field, supported in (({}, False), ({"supportsThinkingLevel": "true"}, False), ({"supportsThinkingLevel": True}, True)):
                grant.update(field)
                with self.subTest(grant=field):
                    catalog = await asyncio.to_thread(server.discover_runtime_backend_catalog, "gemini", force_runtime_probe=True)
                    self.assertTrue(catalog["available"])
                    self.assertEqual(catalog["default_model"], gemini.DEFAULT_MODEL)
                    choices = {model: [row["value"] for row in rows] for model, rows in catalog.get("model_efforts", {}).items()}
                    self.assertEqual(choices, {gemini.DEFAULT_MODEL: ["low", "medium", "high"]} if supported else {})
                    access = await asyncio.to_thread(auth.request, root, "gemini")
                    with gemini.native_environment(env, access, cwd=root) as child:
                        self.assertEqual(child["GEMINI_CLI_CUSTOM_HEADERS"], "")
                    if supported:
                        with gemini.native_environment(env, access, cwd=root, effort="high") as child:
                            self.assertEqual(child["GEMINI_CLI_CUSTOM_HEADERS"], f"{gemini_gateway.EFFORT_HEADER}: high")
                    else:
                        with self.assertRaises(gemini.GeminiConfigurationError):
                            with gemini.native_environment(env, access, cwd=root, effort="high"):
                                pass

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
