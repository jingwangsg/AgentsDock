"""Releasing Codex threads held by stale app-servers or by another process with the rollout open."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from agent_server import codex_rollout_writers_sync, descendant_pids, select_stale_codex_app_servers

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


    def test_an_npm_shims_native_app_server_counts_as_this_servers_own(self) -> None:
        processes = [
            (ME, 1, "python agent_server.py serve --port 7850"),
            (600, ME, "node /usr/lib/node_modules/@openai/codex/bin/codex.js app-server"),
            (601, 600, "/usr/lib/node_modules/@openai/codex/vendor/codex app-server"),
            (700, 1, "codex -a never resume"),
        ]
        self.assertEqual(descendant_pids(processes, ME), {600, 601})


class RolloutWriterTests(unittest.TestCase):
    def test_writers_of_the_rollout_are_found_but_readers_and_this_servers_own_are_not(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rollout = Path(tmp) / "rollout-2026-10-01T00-00-00-01a0abf6-f46a-7721-b8d3-bf43b6f71c82.jsonl"
            rollout.write_text("{}\n")
            # This test process plays the holder: a reader such as `tail -f` is left alone, a
            # `codex resume` appending to the file is found unless it belongs to the server.
            with rollout.open("r"):
                self.assertEqual(codex_rollout_writers_sync(rollout, own=set()), [])
            with rollout.open("a"):
                self.assertEqual(codex_rollout_writers_sync(rollout, own=set()), [os.getpid()])
                self.assertEqual(codex_rollout_writers_sync(rollout, own={os.getpid()}), [])


if __name__ == "__main__":
    unittest.main()
