"""Every server start keeps a copy of sessions.json; the newest ten survive."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_server as server


class SessionsBackupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = Path(temporary.name) / "state"
        state.mkdir()
        self.sessions_file = state / "sessions.json"
        self.backups = state / "sessions-backups"
        for name, value in (("STATE_DIR", state), ("SESSIONS_FILE", self.sessions_file), ("SESSIONS_BACKUP_DIR", self.backups)):
            self.enterContext(patch.object(server, name, value))
        self.sessions_file.write_text(json.dumps({"sess_a": {"id": "sess_a", "title": "Kept"}}))

    async def load(self):
        store = server.SessionStore()
        with patch.object(server, "STORE", store):
            await store.load()
        return store

    async def test_start_copies_the_registry_and_keeps_the_newest_ten(self):
        self.backups.mkdir()
        for day in range(1, 13):
            (self.backups / f"sessions-202609{day:02d}T000000.json").write_text("{}")

        store = await self.load()

        self.assertEqual(store.sessions["sess_a"]["title"], "Kept")
        kept = sorted(path.name for path in self.backups.glob("sessions-*.json"))
        self.assertEqual(len(kept), 10)
        self.assertNotIn("sessions-20260901T000000.json", kept)
        self.assertEqual(json.loads((self.backups / kept[-1]).read_text()), {"sess_a": {"id": "sess_a", "title": "Kept"}})

    async def test_a_failed_backup_does_not_block_startup(self):
        with patch.object(server.shutil, "copy2", side_effect=OSError("disk full")):
            store = await self.load()
        self.assertEqual(store.sessions["sess_a"]["title"], "Kept")


if __name__ == "__main__":
    unittest.main()
