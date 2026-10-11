"""The app can run `claude update` / `codex update` on a server with the binary its chats spawn, or install a missing CLI."""

import subprocess
import tempfile
import threading
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

    def chats_path(self, *directories):
        """The chats' HOME and PATH, limited to `directories`: no real CLI, curl or installer is reachable."""
        self.home = self.bin / "home"
        self.home.mkdir(exist_ok=True)
        path = ":".join([str(self.home / ".local" / "bin"), *map(str, directories)])
        self.enterContext(patch.object(server, "runner_env", lambda: {"HOME": str(self.home), "PATH": path}))
        self.enterContext(patch.object(server, "CLAUDE_BIN", "claude"))
        self.enterContext(patch.object(server, "CODEX_BIN", "codex"))

    def fake_curl(self, installer, *, before=""):
        """A `curl` that logs its arguments and serves `installer` (run by the pipe's shell) after `before` runs."""
        tools = Path(tempfile.mkdtemp(dir=self.bin))
        (tools / "installer.sh").write_text(installer)
        curl = tools / "curl"
        curl.write_text(f'#!/bin/sh\necho "$@" >> {tools}/curl.log\n{before}\ncat {tools}/installer.sh\n')
        curl.chmod(0o755)
        (tools / "bash").symlink_to("/bin/bash")
        # /bin for the installer's own sh, mkdir, cat and chmod; the fake curl comes first.
        self.chats_path(tools, "/bin")
        return tools

    def installer(self, name, *, into="$HOME/.local/bin"):
        """What an official installer does here: put a fake CLI reporting 2.0.0 in `into`."""
        return (
            f'mkdir -p "{into}"\n'
            f'printf \'#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "2.0.0"; fi\\n\' > "{into}/{name}"\n'
            f'chmod 755 "{into}/{name}"\n'
            'echo "non-interactive=${CODEX_NON_INTERACTIVE:-unset}"\n'
        )

    def test_a_missing_cli_is_installed_with_its_official_installer(self):
        for backend, url in (("claude", "https://claude.ai/install.sh"), ("codex", "https://chatgpt.com/codex/install.sh")):
            with self.subTest(backend):
                tools = self.fake_curl(self.installer(backend))
                self.refresh_codex.reset_mock()

                response = self.client.post(f"/api/admin/runtimes/{backend}/update", headers=HEADERS)

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual((tools / "curl.log").read_text(), f"-fsSL {url}\n")
                self.assertEqual(response.json()["action"], "install")
                self.assertEqual(response.json()["diagnostic"]["version"], "2.0.0")
                # Codex's installer would otherwise wait on prompts.
                self.assertEqual(response.json()["output"], f"non-interactive={1 if backend == 'codex' else 'unset'}")
                self.assertEqual(self.refresh_codex.await_count, 1 if backend == "codex" else 0)
                self.assertEqual(self.client.post(f"/api/admin/runtimes/{backend}/update", headers=HEADERS).json()["action"], "update")

    def test_a_failed_download_fails_the_install(self):
        self.fake_curl(self.installer("claude"), before='echo "curl: (22) The requested URL returned error: 403" >&2\nexit 22')

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "The claude installer exited with 22: curl: (22) The requested URL returned error: 403")

    def test_an_install_the_chats_cannot_find_is_an_error(self):
        self.fake_curl(self.installer("claude", into="$HOME/elsewhere"))

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.status_code, 500)
        self.assertTrue(response.json()["detail"].startswith(
            "The claude installer finished, but this server's chats still cannot find `claude` on their PATH: "), response.json())

    def test_an_install_holds_the_update_lock(self):
        started, go = self.bin / "started", self.bin / "go"
        self.fake_curl(self.installer("claude"), before=f": > {started}\nwhile [ ! -e {go} ]; do sleep 0.05; done")
        responses = []
        install = threading.Thread(target=lambda: responses.append(self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)))
        install.start()
        self.addCleanup(install.join)
        self.addCleanup(go.touch)
        for _ in range(200):
            if started.exists():
                break
            time.sleep(0.05)
        else:
            self.fail("the installer did not start")

        self.assertEqual(self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS).status_code, 409)
        go.touch()
        install.join()
        self.assertEqual(responses[0].status_code, 200, responses[0].text)

    def test_installing_needs_curl_and_bash(self):
        tools = Path(tempfile.mkdtemp(dir=self.bin))
        self.chats_path(tools)
        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "The claude CLI is not installed on this server, and installing it needs curl and bash.")

        (tools / "bash").symlink_to("/bin/bash")
        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)
        self.assertEqual(response.json()["detail"], "The codex CLI is not installed on this server, and installing it needs curl.")

    def test_unknown_backend(self):
        self.assertEqual(self.client.post("/api/admin/runtimes/cursor/update", headers=HEADERS).status_code, 422)

    def test_requires_the_native_admin_token(self):
        self.cli("claude", "exit 0")
        for headers in ({}, {"X-AgentsDock-Token": "wrong"}, {"Authorization": "Bearer test-secret"},
                        {**HEADERS, "Origin": "https://example.com"}):
            response = self.client.post("/api/admin/runtimes/claude/update", headers=headers)
            self.assertIn(response.status_code, {401, 403}, headers)


if __name__ == "__main__":
    unittest.main()
