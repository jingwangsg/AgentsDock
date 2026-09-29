"""Selection rule for releasing Codex threads held by stale app-server processes."""
from __future__ import annotations

import unittest

from agent_server import select_stale_codex_app_servers

ME = 500
CODEX = "/root/.codex/bin/codex app-server --stdio"


class StaleCodexAppServerSelectionTests(unittest.TestCase):
    def test_orphans_and_other_agents_servers_children_are_selected(self) -> None:
        processes = [
            (1, 0, "/sbin/init"),
            (ME, 1, ".venv/bin/python agent_server.py serve --bind 127.0.0.1 --port 7850"),
            (600, ME, CODEX),                         # our own app-server: keep
            (700, 1, CODEX),                          # orphan from a dead server: kill
            (710, 700, "/usr/bin/bash -c helper"),   # descendant of the orphan: kill
            (800, 1, ".venv/bin/python agent_server.py serve --bind 127.0.0.1 --port 7852"),
            (810, 800, CODEX),                        # child of another AgentsServer: kill
        ]
        self.assertEqual(select_stale_codex_app_servers(processes, ME), [700, 710, 810])

    def test_codex_owned_by_other_apps_is_left_alone(self) -> None:
        processes = [
            (ME, 1, "python agent_server.py serve --port 7850"),
            (900, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
            (910, 900, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex -c x app-server"),
            (950, 1, "/Applications/Zed.app/Contents/MacOS/zed"),
            (960, 950, "/usr/local/bin/codex app-server"),
            (970, 1, "/bin/zsh"),
            (980, 970, "codex app-server"),           # a user's terminal session: keep
            (990, 1, "codex exec something"),         # not an app-server: keep
        ]
        self.assertEqual(select_stale_codex_app_servers(processes, ME), [])


if __name__ == "__main__":
    unittest.main()
