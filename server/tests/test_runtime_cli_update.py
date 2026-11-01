"""The app can run `claude update` / `codex update` on a server with the binary its chats spawn, or install a missing CLI
or one `update` cannot manage."""

import shutil
import subprocess
import sys
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

    def chats_env(self, *directories):
        """The chats' HOME and PATH, limited to `directories`: no real CLI, curl or installer is reachable."""
        home = self.bin / "home"
        home.mkdir(exist_ok=True)
        path = ":".join([str(home / ".local" / "bin"), *map(str, directories)])
        self.enterContext(patch.object(server, "runner_env", lambda: {"HOME": str(home), "PATH": path}))
        self.enterContext(patch.object(server, "CLAUDE_BIN", "claude"))
        self.enterContext(patch.object(server, "CODEX_BIN", "codex"))

    def fake_curl(self, installer, *, before=""):
        """A `curl` that logs its arguments and serves `installer` (run by the pipe's shell) after `before` runs."""
        tools = Path(tempfile.mkdtemp(dir=self.bin))
        (tools / "installer.sh").write_text(installer)
        curl = tools / "curl"
        curl.write_text(f'#!/bin/sh\necho "$@" >> {tools}/curl.log\n{before}\ncat {tools}/installer.sh\n')
        curl.chmod(0o755)
        # /bin for bash and the installer's sh, mkdir and chmod; the fake curl comes first.
        self.chats_env(tools, "/bin")
        return tools

    def installer(self, name, *, into="$HOME/.local/bin"):
        """What an official installer does here: put a fake CLI reporting 2.0.0 in its releases directory, link it from
        `into` (Claude's, like the real one, leaves an existing `into/claude` in place), then print whether
        CODEX_NON_INTERACTIVE reached it."""
        releases = "$HOME/.codex/packages/standalone/releases" if name == "codex" else "$HOME/.local/share/claude/versions"
        unless_present = f'[ -e "{into}/claude" ] || ' if name == "claude" else ""
        return (
            f'mkdir -p "{releases}" "{into}"\n'
            f'cat > "{releases}/2.0.0" <<"EOF"\n'
            '#!/bin/sh\n'
            'if [ "$1" = "--version" ]; then echo "2.0.0"; fi\n'
            'EOF\n'
            f'chmod 755 "{releases}/2.0.0"\n'
            f'{unless_present}ln -sf "{releases}/2.0.0" "{into}/{name}"\n'
            'echo "non-interactive=${CODEX_NON_INTERACTIVE:-unset}"\n'
        )

    def native_binary(self, path, *, fails):
        """A native executable (no `#!`) at `path` that exits 1 if `fails`, else 0, whatever it is asked."""
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(shutil.which("false" if fails else "true"), path)
        if sys.platform == "darwin":
            # macOS kills a copied system binary that still carries Apple's platform signature.
            subprocess.run(["codesign", "-f", "-s", "-", str(path)], check=True, capture_output=True)
        return path

    def hand_installed(self, name):
        """A CLI unpacked by hand from a tarball and linked from ~/.local/bin, as on the server that showed the bug;
        it exits as that CLI's `update` did there (measured: codex 1, claude 0)."""
        home = self.bin / "home"
        binary = self.native_binary(home / ".local" / "lib" / f"{name}-1.0" / "bin" / name, fails=name == "codex")
        (home / ".local" / "bin").mkdir(parents=True, exist_ok=True)
        (home / ".local" / "bin" / name).symlink_to(binary)
        return binary

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

    def test_a_hand_installed_cli_is_replaced_by_the_official_installer(self):
        home = self.bin / "home"
        for backend in ("codex", "claude"):
            with self.subTest(backend):
                self.fake_curl(self.installer(backend))
                self.hand_installed(backend)
                self.refresh_codex.reset_mock()

                response = self.client.post(f"/api/admin/runtimes/{backend}/update", headers=HEADERS)

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["action"], "install")
                self.assertEqual(response.json()["diagnostic"]["version"], "2.0.0")
                self.assertEqual(self.refresh_codex.await_count, 1 if backend == "codex" else 0)
                # Claude's old launcher, moved aside for its installer, is gone.
                self.assertEqual(list((home / ".local" / "bin").glob(".*")), [])

    def test_a_failed_update_of_an_installer_npm_or_homebrew_cli_is_not_reinstalled(self):
        # Such a failure is the CLI's own (a network error, say): the installer would hit it too, or replace a working install.
        home = self.bin / "home"
        for backend, where in (
            ("codex", ".codex/packages/standalone/releases/1.0/codex"),
            ("claude", ".local/share/claude/versions/1.0"),
            ("claude", ".npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
            ("codex", "homebrew/Caskroom/codex/1.0/codex"),
        ):
            with self.subTest(where):
                tools = self.fake_curl(self.installer(backend))
                launcher = home / ".local" / "bin" / backend
                launcher.parent.mkdir(parents=True, exist_ok=True)
                launcher.unlink(missing_ok=True)
                launcher.symlink_to(self.native_binary(home / where, fails=True))

                response = self.client.post(f"/api/admin/runtimes/{backend}/update", headers=HEADERS)

                self.assertEqual(response.status_code, 500)
                self.assertEqual(response.json()["detail"], f"`{backend} update` exited with 1.")
                self.assertFalse((tools / "curl.log").exists())

    def test_a_wrapper_script_is_updated_not_replaced(self):
        tools = self.fake_curl(self.installer("codex"))
        wrapper = self.bin / "home" / ".local" / "bin" / "codex"
        wrapper.parent.mkdir(parents=True)
        wrapper.write_text('#!/bin/sh\necho "wrapped $1"\n')
        wrapper.chmod(0o755)

        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)

        self.assertEqual((response.status_code, response.json()["action"], response.json()["output"]), (200, "update", "wrapped update"))
        self.assertFalse((tools / "curl.log").exists())

    def test_a_configured_cli_is_never_replaced(self):
        tools = self.fake_curl(self.installer("codex"))
        binary = self.hand_installed("codex")
        (self.bin / "home" / ".local" / "bin" / "codex-nightly").symlink_to(binary)
        for configured in (str(binary), "codex-nightly"):
            with self.subTest(configured), patch.object(server, "CODEX_BIN", configured):
                response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)

                self.assertEqual(response.status_code, 500)
                self.assertEqual(response.json()["detail"], "`codex update` exited with 1.")
                self.assertFalse((tools / "curl.log").exists())

    def test_a_binary_the_server_cannot_read_is_updated_not_replaced(self):
        tools = self.fake_curl(self.installer("codex"))
        self.hand_installed("codex").chmod(0o111)

        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "`codex update` exited with 1.")
        self.assertFalse((tools / "curl.log").exists())

    def test_an_install_the_chats_do_not_run_is_an_error(self):
        # The installer linked its CLI from a directory later on the chats' PATH (as with CODEX_INSTALL_DIR).
        tools = self.fake_curl("")
        (tools / "installer.sh").write_text(self.installer("codex", into=str(tools)))
        self.hand_installed("codex")

        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], (
            f"The codex installer finished, but this server's chats still run {self.bin}/home/.local/bin/codex "
            "instead of the CLI it installed: non-interactive=1"
        ))

    def test_a_failed_install_puts_the_old_claude_launcher_back(self):
        self.fake_curl(self.installer("claude"), before='echo "curl: (6) Could not resolve host: claude.ai" >&2\nexit 6')
        binary = self.hand_installed("claude")

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "The claude installer exited with 6: curl: (6) Could not resolve host: claude.ai")
        launcher = self.bin / "home" / ".local" / "bin" / "claude"
        self.assertEqual(launcher.readlink(), binary)
        self.assertEqual([path.name for path in launcher.parent.iterdir()], ["claude"])

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
        # Cleanups run last-in first-out: on a failure, release the installer before joining its thread.
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
        self.chats_env(tools)

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "The claude CLI is not installed on this server, and installing it needs curl and bash.")

        (tools / "bash").symlink_to("/bin/bash")
        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "The codex CLI is not installed on this server, and installing it needs curl.")

    def test_replacing_a_hand_installed_cli_needs_curl_and_bash(self):
        self.chats_env(Path(tempfile.mkdtemp(dir=self.bin)))
        self.hand_installed("codex")

        response = self.client.post("/api/admin/runtimes/codex/update", headers=HEADERS)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], (
            f"The codex CLI at {self.bin}/home/.local/bin/codex is an install `codex update` cannot manage, "
            "and installing it needs curl and bash."
        ))

    def test_a_cli_configured_as_a_missing_path_is_not_installed(self):
        tools = self.fake_curl(self.installer("claude"))
        configured = self.bin / "absent" / "claude"
        self.enterContext(patch.object(server, "CLAUDE_BIN", str(configured)))

        response = self.client.post("/api/admin/runtimes/claude/update", headers=HEADERS)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], f"The claude CLI is configured as {configured}, which does not exist on this server.")
        self.assertFalse((tools / "curl.log").exists())

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
