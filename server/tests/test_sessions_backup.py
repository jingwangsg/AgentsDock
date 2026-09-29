"""Every server start keeps a copy of sessions.json; the ten most recent distinct copies survive."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_server as server

INDEX = {"sess_a": {"id": "sess_a", "title": "Kept"}}


class SessionsBackupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.sessions_file = Path(temporary.name) / "sessions.json"
        self.backups = Path(temporary.name) / "sessions-backups"
        self.enterContext(patch.object(server, "SESSIONS_FILE", self.sessions_file))
        self.enterContext(patch.object(server, "SESSIONS_BACKUP_DIR", self.backups))
        self.sessions_file.write_text(json.dumps(INDEX))

    async def load(self):
        store = server.SessionStore()
        with patch.object(server, "STORE", store):
            await store.load()
        return store

    def by_age(self):
        return sorted(self.backups.glob("sessions-*.json"), key=lambda path: path.stat().st_mtime)

    async def test_start_copies_the_registry_and_keeps_the_ten_most_recent(self):
        self.backups.mkdir()
        # Named as if written in a later timezone: order must come from mtime, not the name.
        for day in range(1, 13):
            old = self.backups / f"sessions-202609{day:02d}T230000Z.json"
            old.write_text("{}")
            os.utime(old, (1_700_000_000 + day, 1_700_000_000 + day))

        store = await self.load()

        self.assertEqual(store.sessions["sess_a"]["title"], "Kept")
        kept = self.by_age()
        self.assertEqual(len(kept), 10)
        self.assertEqual(json.loads(kept[-1].read_text()), INDEX)
        self.assertNotIn("sessions-20260901T230000Z.json", [path.name for path in kept])

    async def test_an_unchanged_registry_adds_no_copy(self):
        await self.load()
        await self.load()
        self.assertEqual(len(self.by_age()), 1)

    async def test_a_failed_backup_does_not_block_startup(self):
        with patch.object(server.shutil, "copyfile", side_effect=OSError("disk full")):
            store = await self.load()
        self.assertEqual(store.sessions["sess_a"]["title"], "Kept")


if __name__ == "__main__":
    unittest.main()
