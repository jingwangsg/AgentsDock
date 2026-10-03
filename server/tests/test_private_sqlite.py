"""Owner-only SQLite opening: every unsafe inode or directory is refused before SQLite sees it."""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch

from private_sqlite import create_private_sqlite, open_private_sqlite


class PrivateSqliteTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())) / "store"
        self.root.mkdir(mode=0o700)
        self.path = self.root / "ledger.sqlite3"
        create_private_sqlite(self.path)
        with open_private_sqlite(self.path, write=True) as db:
            db.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO items(value) VALUES ('kept')")
        db.close()

    def test_create_is_owner_only_and_leaves_an_existing_file_alone(self):
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        create_private_sqlite(self.path)
        db = open_private_sqlite(self.path, write=False)
        try:
            self.assertEqual(db.execute("SELECT value FROM items").fetchone()["value"], "kept")
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA trusted_schema").fetchone()[0], 0)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("INSERT INTO items(value) VALUES ('denied')")
        finally:
            db.close()

    def test_missing_file_is_not_created_by_open(self):
        missing = self.root / "absent.sqlite3"
        with self.assertRaises(OSError):
            open_private_sqlite(missing, write=True)
        self.assertFalse(missing.exists())

    def test_symlinked_database_and_directory_are_refused(self):
        other = self.root.parent / "other"
        other.mkdir(mode=0o700)
        linked_file = other / "ledger.sqlite3"
        linked_file.symlink_to(self.path)
        with self.assertRaises(PermissionError):
            open_private_sqlite(linked_file, write=False)
        linked_root = self.root.parent / "linked-root"
        linked_root.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(PermissionError):
            open_private_sqlite(linked_root / "ledger.sqlite3", write=False)
        with self.assertRaises(PermissionError):
            create_private_sqlite(linked_root / "new.sqlite3")
        self.assertFalse((self.root / "new.sqlite3").exists())

    def test_loose_permissions_are_refused_without_being_repaired(self):
        self.path.chmod(0o644)
        with self.assertRaises(PermissionError):
            open_private_sqlite(self.path, write=True)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o644)
        self.path.chmod(0o600)
        self.root.chmod(0o755)
        try:
            with self.assertRaises(PermissionError):
                open_private_sqlite(self.path, write=False)
            with self.assertRaises(PermissionError):
                create_private_sqlite(self.root / "new.sqlite3")
            self.assertFalse((self.root / "new.sqlite3").exists())
        finally:
            self.root.chmod(0o700)

    def test_hard_links_fifos_and_foreign_owners_are_refused(self):
        linked = self.root / "twin.sqlite3"
        os.link(self.path, linked)
        try:
            with self.assertRaises(PermissionError):
                open_private_sqlite(self.path, write=False)
        finally:
            linked.unlink()
        fifo = self.root / "fifo.sqlite3"
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(PermissionError):
            open_private_sqlite(fifo, write=False)  # lstat rejects it; a blocking open never happens.
        with patch("private_sqlite.os.getuid", return_value=os.getuid() + 1):
            with self.assertRaises(PermissionError):
                open_private_sqlite(self.path, write=False)


if __name__ == "__main__":
    unittest.main()
