"""Claude authenticates only with CLAUDE_CODE_OAUTH_TOKEN; the app can save it on the server."""

import asyncio
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import agent_server as server

TOKEN = "sk-ant-oat01-abc_DEF-123"


class ClaudeOAuthTokenTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.env_file = Path(temporary.name) / "env"
        self.env_file.write_text("export AGENTSDOCK_AGENT_PORT=7850\nexport CLAUDE_CODE_OAUTH_TOKEN=old\n")
        self.env_file.chmod(0o600)
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.enterContext(patch.object(server, "CONFIG_ENV_FILE", self.env_file))
        self.enterContext(patch.dict(os.environ))
        self.enterContext(patch.dict(server.RUNTIME_DIAGNOSTICS, {}, clear=True))
        self.enterContext(patch.dict(server.RUNTIME_DIAGNOSTIC_GENERATIONS, {}, clear=True))
        version = subprocess.CompletedProcess(["claude", "--version"], 0, "2.1.283 (Claude Code)", "")
        self.enterContext(patch.object(server.shutil, "which", return_value="/fixture/claude"))
        self.enterContext(patch.object(server, "runtime_command", return_value=version))
        os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        self.client = TestClient(server.app)

    def put(self, token, headers=None):
        return self.client.put(
            "/api/admin/claude/token",
            headers={"X-AgentsDock-Token": "test-secret"} if headers is None else headers,
            json={"token": token},
        )

    def test_save_replaces_the_env_line_and_applies_it_without_restart(self):
        response = self.put(f"  {TOKEN}  ")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"oauth_token_configured": True})
        self.assertEqual(
            self.env_file.read_text(),
            f"export AGENTSDOCK_AGENT_PORT=7850\nexport CLAUDE_CODE_OAUTH_TOKEN={TOKEN}\n",
        )
        self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o600)
        self.assertEqual(server.runner_env()["CLAUDE_CODE_OAUTH_TOKEN"], TOKEN)
        claude = server.runtime_diagnostics_snapshot()["claude"]
        self.assertTrue(claude["oauth_token_configured"])
        self.assertEqual(claude["status"], "unknown")

    def test_rejects_values_the_shell_would_interpret(self):
        for token in ("", "a b", "tok$(id)", "tok'x", "tok\nexport X=1"):
            with self.subTest(token=token[:16]):
                self.assertEqual(self.put(token).status_code, 400)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN=old", self.env_file.read_text())
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", os.environ)

    def test_requires_the_native_admin_token(self):
        for headers in ({}, {"X-AgentsDock-Token": "wrong"}, {"Origin": "https://example.com"}):
            with self.subTest(headers=headers):
                self.assertIn(self.put(TOKEN, headers).status_code, (401, 403))
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", os.environ)

    def test_no_claude_process_starts_without_the_token(self):
        with self.assertRaisesRegex(server.ClaudeSDKUnavailable, "CLAUDE_CODE_OAUTH_TOKEN is not set"):
            server.claude_sdk_cli_path(server.runner_env())
        with self.assertRaisesRegex(server.ClaudeSDKUnavailable, "CLAUDE_CODE_OAUTH_TOKEN is not set"):
            asyncio.run(server.run_claude_handoff_summarizer("prompt", model=None, effort=None))

    def test_missing_token_reports_unauthenticated_with_the_token_instruction(self):
        diagnostic = server.probe_runtime("claude")
        self.assertEqual(diagnostic["status"], "unauthenticated")
        self.assertIn("claude setup-token", diagnostic["action"])
        self.assertFalse(server.public_runtime_diagnostic(diagnostic)["oauth_token_configured"])

    def test_replaced_token_changes_the_sdk_configuration_key(self):
        def key():
            return server.claude_sdk_configuration_key({"model": "opus"}, "/tmp", "/fixture/claude", "prompt")

        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "first"
        first = key()
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "second"
        self.assertNotEqual(first, key())


if __name__ == "__main__":
    unittest.main()
