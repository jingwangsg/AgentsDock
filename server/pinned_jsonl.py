"""Stream JSONL records from a file pinned to one (dev, ino, size, mtime_ns) stamp.

History repair proofs read provider transcripts this way: the file is checked
before, during and after the read, so one record stream can never mix bytes
from two revisions of the same path. Any doubt raises ``Unproven``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
from typing import Callable

Stamp = tuple[int, int, int, int]


class Unproven(ValueError):
    """The file moved, changed, is not a regular file, or holds a malformed record."""


def regular_stamp(path: Path) -> Stamp:
    """Pin a regular file without following symlinks; no total-size cutoff."""
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode):
        raise Unproven()
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


def pinned_records(path: Path, expected: Stamp, *, max_line_bytes: int, max_records: int | None = None,
                   end: int | None = None, check_budget: Callable[[], None] | None = None):
    """Yield ``(record, end_offset, line)`` for complete JSON-object lines up to ``end``.

    ``end`` defaults to the pinned size; a proof may stop at its newest
    checkpoint instead of parsing an unrelated tail. ``check_budget`` runs
    before the open, before every record and after the close so a caller can
    abort on cancellation or a deadline between individually bounded lines.
    """
    check_budget = check_budget or (lambda: None)
    check_budget()
    boundary = expected[2] if end is None else end
    if type(boundary) is not int or not 0 <= boundary <= expected[2]:
        raise Unproven()
    # O_NONBLOCK: a path swapped for a FIFO after the lstat must not block
    # the open; the fstat below then rejects it.
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != expected:
            raise Unproven()
        count = 0
        offset = 0
        while offset < boundary:
            check_budget()
            line = stream.readline(min(max_line_bytes + 1, boundary - offset))
            if not line or len(line) > max_line_bytes or not line.endswith(b"\n"):
                raise Unproven()
            count += 1
            if max_records is not None and count > max_records:
                raise Unproven()
            offset += len(line)
            record = json.loads(line)
            if not isinstance(record, dict):
                raise Unproven()
            yield record, offset, line
        final = os.fstat(stream.fileno())
        if (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns) != expected:
            raise Unproven()
    check_budget()
    if regular_stamp(path) != expected:
        raise Unproven()
