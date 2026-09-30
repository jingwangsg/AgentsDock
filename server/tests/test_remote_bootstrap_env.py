"""remote_bootstrap.sh env file, run against a stubbed host in a temporary directory."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "remote_bootstrap.sh"


class RemoteBootstrapEnvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="bootstrap-env-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.shared = self.root / "shared"
        # The env file puts $HOME/.local/bin before the system PATH, so stubs there win in start.sh too.
        bin_dir = self.home / ".local" / "bin"
        for path in (self.shared / ".codex", bin_dir):
            path.mkdir(parents=True)
        # claude, node and tmux present; curl answers health, so start.sh finds a server running.
        for name in ("claude", "node", "tmux", "curl"):
            stub = bin_dir / name
            stub.write_text("#!/bin/sh\nexit 0\n")
            stub.chmod(0o755)
        self.path = f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def bootstrap(self, home_dir: Path) -> str:
        install = home_dir / ".agentsdock-server-test"
        (install / "server" / ".venv" / "bin").mkdir(parents=True, exist_ok=True)
        (install / "server" / "agent_server.py").touch()
        python = install / "server" / ".venv" / "bin" / "python"
        if not python.exists():
            python.symlink_to(sys.executable)
        subprocess.run(["bash", str(SCRIPT), str(install), "7850", str(home_dir)], check=True, capture_output=True,
                       env={"HOME": str(self.home), "PATH": self.path})
        return (install / "env").read_text()

    def test_a_shared_home_keeps_codex_sqlite_state_in_the_install(self) -> None:
        # Two machines mounting one home cannot both open Codex's WAL-mode SQLite state.
        env = self.bootstrap(self.shared)
        expected = f"export CODEX_SQLITE_HOME={self.shared}/.agentsdock-server-test/codex-state\n"
        self.assertIn(expected, env)
        # An install set up before this line gets it on the next deploy, once.
        env_path = self.shared / ".agentsdock-server-test" / "env"
        env_path.write_text(env.replace(expected, ""))
        self.assertEqual(self.bootstrap(self.shared).count("CODEX_SQLITE_HOME"), 1)
        self.assertEqual(self.bootstrap(self.shared).count("CODEX_SQLITE_HOME"), 1)

    def test_the_machines_own_home_leaves_codex_state_where_codex_puts_it(self) -> None:
        self.assertNotIn("CODEX_SQLITE_HOME", self.bootstrap(self.home))


if __name__ == "__main__":
    unittest.main()
