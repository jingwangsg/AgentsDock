"""remote_bootstrap.sh env file, run against a stubbed host in a temporary directory."""
import os
import subprocess
import sys
import tarfile
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
        # claude, node, tmux and uv present; curl answers health, so start.sh finds a server running.
        for name in ("claude", "node", "tmux", "curl", "uv"):
            stub = bin_dir / name
            stub.write_text("#!/bin/sh\nexit 0\n")
            stub.chmod(0o755)
        self.path = f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def bootstrap(self, home_dir: Path, install_parent: Path | None = None, upload: bool = False) -> str:
        install = (install_parent or home_dir) / ".agentsdock-server-test"
        (install / "server" / ".venv" / "bin").mkdir(parents=True, exist_ok=True)
        (install / "server" / "agent_server.py").touch()
        python = install / "server" / ".venv" / "bin" / "python"
        if not python.exists():
            python.symlink_to(sys.executable)
        # A deploy uploads the source; without it the run is an attach. Unpacking stops whatever
        # serves the port, so an upload uses one no local server listens on.
        port = "7850"
        if upload:
            with tarfile.open(install / "upload.tgz", "w:gz") as tar:
                tar.add(install / "server" / "agent_server.py", arcname="agent_server.py")
            port = "59871"
        subprocess.run(["bash", str(SCRIPT), str(install), port, str(home_dir)], check=True, capture_output=True,
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

    def test_a_shared_home_seeds_the_install_state_from_its_databases_once(self) -> None:
        import sqlite3
        legacy = self.shared / ".codex"
        with sqlite3.connect(legacy / "state_5.sqlite") as db:
            db.execute("create table threads (id text)"); db.execute("insert into threads values ('t1')")
        (legacy / "logs_2.sqlite").write_bytes(b"")
        self.bootstrap(self.shared)
        state = self.shared / ".agentsdock-server-test" / "codex-state"
        with sqlite3.connect(f"file:{state / 'state_5.sqlite'}?mode=ro", uri=True) as db:
            self.assertEqual(db.execute("select id from threads").fetchall(), [("t1",)])
        self.assertFalse((state / "logs_2.sqlite").exists())
        # An install whose state exists (backfilled or seeded) is left alone.
        (state / "state_5.sqlite").write_bytes(b"kept")
        self.bootstrap(self.shared)
        self.assertEqual((state / "state_5.sqlite").read_bytes(), b"kept")

    def test_an_existing_install_follows_the_home_this_deploy_chose(self) -> None:
        # Deployed while the shared home held no login yet, the install ran with the machine's own ~.
        env = self.bootstrap(self.home, install_parent=self.shared)
        self.assertIn(f"export HOME={self.home}\n", env)
        # start.sh's health check then runs with the shared home's PATH, where the stubs must be too.
        (self.shared / ".local").mkdir()
        (self.shared / ".local" / "bin").symlink_to(self.home / ".local" / "bin")
        # An attach leaves the HOME the owning hub chose.
        self.assertIn(f"export HOME={self.home}\n", self.bootstrap(self.shared))
        env = self.bootstrap(self.shared, upload=True)
        self.assertIn(f"export HOME={self.shared}\n", env)
        self.assertIn(f"export AGENTSDOCK_AGENT_CWD={self.shared}\n", env)
        self.assertIn(f"export PATH={self.shared}/.local/bin:{self.shared}/.local/bin:", env)
        self.assertNotIn(f"{self.home}/.local/bin", env)
        self.assertIn("CODEX_SQLITE_HOME", env)
        # The move never goes back to the machine's own ~, even on a deploy that offers it.
        self.assertIn(f"export HOME={self.shared}\n", self.bootstrap(self.home, install_parent=self.shared, upload=True))
        # A working directory the user chose is not the old home and stays.
        env_path = self.shared / ".agentsdock-server-test" / "env"
        env_path.write_text(env.replace(f"HOME={self.shared}\n", f"HOME={self.home}\n", 1).replace(f"AGENTSDOCK_AGENT_CWD={self.shared}", "AGENTSDOCK_AGENT_CWD=/work"))
        env = self.bootstrap(self.shared, upload=True)
        self.assertIn(f"export HOME={self.shared}\n", env)
        self.assertIn("export AGENTSDOCK_AGENT_CWD=/work\n", env)

    def test_the_machines_own_home_leaves_codex_state_where_codex_puts_it(self) -> None:
        self.assertNotIn("CODEX_SQLITE_HOME", self.bootstrap(self.home))
        self.assertFalse((self.home / ".agentsdock-server-test" / "codex-state").exists())


if __name__ == "__main__":
    unittest.main()
