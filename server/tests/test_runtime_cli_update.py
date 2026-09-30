"""The app can run `claude update` / `codex update` on a server with the binary its chats spawn."""

import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import agent_server as server

HEADERS = {"X-AgentsDock-Token": "test-secret"}


class RuntimeCliUpdateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.bin = Path(temporary.name)
        self.enterContext(patch.object(server, "AGENT_TOKEN", "test-secret"))
        self.enterContext(patch.dict(server.RUNTIME_DIAGNOSTICS, {}, clear=True))
        self.enterContext(patch.dict(server.RUNTIME_DIAGNOSTIC_GENERATIONS, {}, clear=True))
        self.refresh_codex = self.enterContext(patch.object(server, "refresh_codex_app_server_binary", AsyncMock()))
        self.client = TestClient(server.app)

    def cli(self, name, update_script):
        """A fake CLI: `--version` reports 2.0.0, `update` runs `update_script`."""
        path = self.bin / name
        path.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = "--version" ]; then echo "2.0.0"; exit 0; fi\n'
            'if [ "$1" = "update" ]; then\n' + update_script + "\nfi\n"
            "exit 0\n"
        )
        path.chmod(0o755)
        self.enterContext(patch.object(server, "CLAUDE_BIN" if name == "claude" else "CODEX_BIN", str(path)))

    def test_update_runs_the_cli_and_returns_its_output_and_refreshed_version(self):
        self.cli("claude", 'echo "Checking for updates"\necho "Successfully updated from 1.9.0 to version 2.0.0"')

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["output"], "Checking for updates\nSuccessfully updated from 1.9.0 to version 2.0.0")
        self.assertEqual(response.json()["diagnostic"]["version"], "2.0.0")
        self.assertEqual(server.runtime_diagnostics_snapshot()["claude"]["version"], "2.0.0")
        self.refresh_codex.assert_not_awaited()

    def test_codex_update_moves_new_turns_to_the_new_binary(self):
        self.cli("codex", 'echo "Codex is up to date"')

        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)

        self.assertEqual(response.status_code, 200)
        self.refresh_codex.assert_awaited_once_with(force=True)

    def test_a_failed_update_reports_its_exit_code_and_output(self):
        self.cli("claude", 'echo "npm ERR! EACCES: permission denied" >&2\nexit 3')

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "`claude update` exited with 3: npm ERR! EACCES: permission denied")

    def test_the_tail_keeps_the_cli_output_order(self):
        self.cli("claude", 'for n in 1 2 3 4 5 6; do echo "npm WARN old dep$n" >&2; done\necho "Successfully updated"')

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.json()["output"].splitlines()[-1], "Successfully updated")

    def test_a_timeout_stops_the_cli_and_the_install_it_started(self):
        child = self.bin / "child.pid"
        self.cli("claude", f'sleep 60 &\necho $! > {child}\nsleep 60')
        self.enterContext(patch.object(server, "RUNTIME_CLI_UPDATE_TIMEOUT_SECONDS", 3))
        # macOS can hold a new executable's first run for seconds under load; run it once outside the timer.
        subprocess.run([str(self.bin / "claude"), "--version"], capture_output=True, check=True)

        started = time.monotonic()
        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        # A surviving child keeps the output pipe open, so the response would wait for it.
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(response.status_code, 500)
        self.assertIn("did not finish within", response.json()["detail"])
        self.assertTrue(child.exists(), (response.json(), time.monotonic() - started))
        pid = int(child.read_text())
        for _ in range(20):
            if subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip() in {"", "Z"}:
                break
            time.sleep(0.1)
        else:
            self.fail(f"the update's child process {pid} is still running")

    def test_missing_cli_and_unknown_backend(self):
        self.enterContext(patch.object(server, "CLAUDE_BIN", str(self.bin / "absent")))
        self.assertEqual(self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS).status_code, 404)
        self.assertEqual(self.client.post("/api/admin/runtimes/cursor/update", headers=HEADERS).status_code, 422)

    def test_requires_the_native_admin_token(self):
        self.cli("claude", "exit 0")
        for headers in ({}, {"X-AgentsDock-Token": "wrong"}, {"Authorization": "Bearer test-secret"},
                        {**HEADERS, "Origin": "https://example.com"}):
            response = self.client.post("/api/admin/runtimes/claude/update", headers=headers)
            self.assertIn(response.status_code, {401, 403}, headers)


if __name__ == "__main__":
    unittest.main()
