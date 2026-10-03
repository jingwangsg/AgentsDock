"""Pinned JSONL reads: any change, link, partial line or budget stop fails closed as Unproven."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest

from pinned_jsonl import Unproven, pinned_records, regular_stamp


def encode(rows):
    return b"".join(json.dumps(row).encode() + b"\n" for row in rows)


class PinnedJsonlTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "events.jsonl"
        self.rows = [{"seq": 1, "type": "user"}, {"seq": 2, "type": "assistant"}, {"seq": 3, "type": "tool"}]
        self.path.write_bytes(encode(self.rows))
        self.stamp = regular_stamp(self.path)

    def read(self, **kwargs):
        return list(pinned_records(self.path, self.stamp, max_line_bytes=4096, **kwargs))

    def test_records_carry_end_offsets_and_raw_lines(self):
        records = self.read()
        self.assertEqual([record for record, _offset, _line in records], self.rows)
        self.assertEqual([offset for _record, offset, _line in records],
                         [len(encode(self.rows[:n])) for n in range(1, 4)])
        self.assertEqual(b"".join(line for _record, _offset, line in records), encode(self.rows))

    def test_symlink_and_swapped_inode_are_unproven(self):
        linked = self.root / "linked.jsonl"
        linked.symlink_to(self.path)
        with self.assertRaises(Unproven):
            regular_stamp(linked)
        replacement = self.root / "replacement.jsonl"
        replacement.write_bytes(encode(self.rows))
        os.replace(replacement, self.path)  # Same bytes, different inode.
        with self.assertRaises(Unproven):
            self.read()

    def test_fifo_at_the_pinned_path_fails_closed_instead_of_blocking(self):
        # No writer ever opens the FIFO: a blocking open would hang this test.
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaises(Unproven):
            regular_stamp(self.path)
        with self.assertRaises(Unproven):
            self.read()

    def test_growth_after_the_stamp_or_during_the_read_is_unproven(self):
        with self.path.open("ab") as stream:
            stream.write(encode([{"seq": 4}]))
        with self.assertRaises(Unproven):
            self.read()
        self.path.write_bytes(encode(self.rows))
        self.stamp = regular_stamp(self.path)
        stream = pinned_records(self.path, self.stamp, max_line_bytes=4096)
        next(stream)
        with self.path.open("ab") as appended:
            appended.write(encode([{"seq": 4}]))
        with self.assertRaises(Unproven):
            list(stream)

    def test_incomplete_oversized_or_non_object_lines_are_unproven(self):
        for raw in (encode(self.rows)[:-1], encode([{"seq": 1}, [1, 2]]), b'{"seq": 1}\n{"x": "' + b"y" * 5000 + b'"}\n'):
            with self.subTest(raw=raw[:16]):
                self.path.write_bytes(raw)
                self.stamp = regular_stamp(self.path)
                with self.assertRaises(Unproven):
                    self.read()

    def test_record_limit_and_prefix_boundary(self):
        with self.assertRaises(Unproven):
            self.read(max_records=2)
        self.assertEqual(len(self.read(max_records=3)), 3)
        first_two = len(encode(self.rows[:2]))
        self.assertEqual([record["seq"] for record, _o, _l in self.read(end=first_two)], [1, 2])
        self.assertEqual(self.read(end=0), [])
        for end in (first_two - 1, self.stamp[2] + 1, -1):
            with self.subTest(end=end), self.assertRaises(Unproven):
                self.read(end=end)

    def test_budget_runs_before_each_record_and_around_the_read(self):
        calls = []
        self.assertEqual(len(self.read(check_budget=lambda: calls.append(1))), 3)
        self.assertEqual(len(calls), 5)  # open, three records, close
        class Stop(Exception):
            pass
        remaining = [2]
        def budget():
            remaining[0] -= 1
            if remaining[0] < 0:
                raise Stop()
        stream = pinned_records(self.path, self.stamp, max_line_bytes=4096, check_budget=budget)
        self.assertEqual(next(stream)[0], self.rows[0])
        with self.assertRaises(Stop):
            next(stream)


if __name__ == "__main__":
    unittest.main()
