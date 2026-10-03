"""Owner-only SQLite files for ledgers that must never be shared or redirected.

Every open re-checks the directory and the database inode before SQLite sees
the path: no symlinks, no extra hard links, owner uid, no group/other bits.
A FIFO or device is rejected by lstat instead of being opened, and an unsafe
existing file is refused rather than chmodded. SQLite is pointed at the
checked path in ``ro``/``rw`` URI mode so it can never create an alternate file.
"""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import stat


def _check_directory(directory: Path) -> None:
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise PermissionError("Private SQLite storage must be a private, owned, non-symlink directory.")


def create_private_sqlite(path: str | os.PathLike[str]) -> None:
    """Create an empty 0600 database file; an existing path is left for open_private_sqlite to check."""
    path = Path(path).absolute()
    _check_directory(path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        return
    os.close(descriptor)


def open_private_sqlite(path: str | os.PathLike[str], *, write: bool, timeout: float = 5) -> sqlite3.Connection:
    """Validated connection with foreign keys on and untrusted schema; the caller closes it."""
    path = Path(path).absolute()
    _check_directory(path.parent)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise PermissionError("Private SQLite database must be a private, owned, single-link regular file.")
    connection = sqlite3.connect(f"{path.as_uri()}?mode={'rw' if write else 'ro'}", uri=True, timeout=timeout)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA trusted_schema = OFF")
        if write:
            connection.execute("PRAGMA synchronous = FULL")
    except BaseException:
        connection.close()
        raise
    return connection
