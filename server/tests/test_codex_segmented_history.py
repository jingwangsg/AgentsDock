"""Codex 0.158+ continues one thread in several rollout files; history follows their history_base chain."""

import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import agent_server
import tests.test_provider_history_sync as sync_fixtures

THREAD, SEG2, SEG3, SEG4 = (str(uuid.uuid5(uuid.NAMESPACE_URL, f"codex-segment-{n}")) for n in range(4))
user, assistant, provider_line = sync_fixtures.user, sync_fixtures.assistant, sync_fixtures.provider_line


def lines(items: list[dict]) -> str:
    return "".join(provider_line(agent_server.BACKEND_CODEX, item["kind"], item["text"]) for item in items)


def write_segment(root: Path, stamp: str, items: list[dict], *, mtime: int, segment: str | None = None,
                  base: tuple[str, int] | None = None, dropped: list[dict] = ()) -> tuple[Path, tuple[str, int]]:
    """Mirror Codex's layout: the first file is ``-<thread>.jsonl``, a later one ``-<thread>_<segment>.jsonl``
    whose history_base names its predecessor's own id and the offset where the thread's history ends there.
    ``dropped`` turns follow that offset. Returns the file and the link a successor puts in its history_base."""
    day = root / "2026" / "09" / "29"
    day.mkdir(parents=True, exist_ok=True)
    path = day / f"rollout-2026-09-29T{stamp}-{THREAD}{'_' + segment if segment else ''}.jsonl"
    payload = {"id": THREAD, "cwd": "/work"}
    if base:
        payload["history_base"] = {"thread_id": base[0], "end_ordinal_exclusive": 1, "end_byte_offset": base[1]}
    kept = json.dumps({"timestamp": "2026-09-29T07:47:19Z", "type": "session_meta", "payload": payload}) + "\n"
    # A reopened client writes settings only.
    kept += lines(items) or json.dumps({"type": "event_msg", "payload": {"type": "thread_settings_applied"}}) + "\n"
    path.write_bytes(kept.encode() + lines(dropped).encode())
    os.utime(path, (mtime, mtime))
    return path, (segment or THREAD, len(kept.encode()))


def pairs(items: list[dict]) -> list[tuple[str, str]]:
    return [(item["kind"], item["text"]) for item in items]


class CodexSegmentedHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.dir = Path(temporary.name)
        self.root = self.dir / "sessions"
        self.first = [user("find a clinic"), assistant("three clinics"), user("AIA")]
        self.second = [user("AIA, logged in too"), assistant("checking AIA")]
        _first, first_link = write_segment(self.root, "15-47-19", self.first, dropped=[user("backtracked draft")], mtime=1_000_100)
        _second, second_link = write_segment(self.root, "16-01-55", self.second, segment=SEG2, base=first_link,
                                             dropped=[assistant("aborted reply")], mtime=1_000_200)
        self.newest, _link = write_segment(self.root, "17-03-00", [], segment=SEG3, base=second_link, mtime=1_000_300)
        self.sess = {"id": "sess_segmented", "backend": agent_server.BACKEND_CODEX, "codex_thread_id": THREAD}
        self.enterContext(patch.object(agent_server, "CODEX_SESSIONS_ROOT", self.root))
        self.enterContext(patch.object(agent_server, "CODEX_SESSION_INDEX_PATH", self.dir / "no-index"))
        self.enterContext(patch.object(agent_server, "CLAUDE_PROJECTS_ROOT", self.dir / "no-claude"))

    def test_listing_shows_one_thread_with_the_newest_time_and_the_first_prompt(self):
        [row] = agent_server.local_codex_session_candidates(set())
        self.assertEqual(row["provider_session_id"], THREAD)
        self.assertEqual(row["updated_at"], agent_server.iso_from_timestamp(1_000_300))
        self.assertEqual(row["label"], "find a clinic")

    async def test_bulk_import_brings_the_chain_without_dropped_turns(self):
        append = AsyncMock(return_value={"imported": 5})
        with patch.object(agent_server.STORE, "sessions", {}), \
                patch.object(agent_server.STORE, "create", AsyncMock(return_value={"id": "sess_imported"})), \
                patch.object(agent_server, "append_staged_imported_history", append), \
                patch.object(agent_server, "commit_staged_history_import", AsyncMock()), \
                patch.object(agent_server, "other_local_instance_provider_keys", return_value=set()):
            result = await agent_server.bulk_import_sessions(agent_server.BulkImportSessionsRequest(items=[
                agent_server.BulkImportSessionItem(provider_session_id=THREAD, backend="codex", cwd="/work"),
            ]))

        self.assertTrue(result["results"][0]["ok"], result)
        _session, source_path, items = append.await_args.args
        self.assertEqual(source_path, self.newest.resolve())
        self.assertEqual(pairs(items), pairs(self.first + self.second))

    def test_the_chain_not_name_order_decides_the_thread(self):
        # After a timezone change the next segment's local-time name sorts before every earlier file.
        later = [user("after the flight")]
        write_segment(self.root, "05-00-00", later, segment=SEG4, base=(SEG3, self.newest.stat().st_size), mtime=1_000_400)

        _path, items = agent_server.provider_history(self.sess, None)
        [row] = agent_server.local_codex_session_candidates(set())

        self.assertEqual(pairs(items), pairs(self.first + self.second + later))
        self.assertEqual((row["label"], row["updated_at"]), ("find a clinic", agent_server.iso_from_timestamp(1_000_400)))

    async def test_sync_adds_only_new_turns_of_the_chain(self):
        harness = sync_fixtures.DurableHistoryCursorTests
        events = [harness.timeline_event(seq, item) for seq, item in enumerate(self.first + self.second, 1)]
        batches: list[list[tuple[str, dict]]] = []
        with patch.object(agent_server, "events_path", side_effect=lambda sid: self.dir / f"{sid}-events.jsonl"), \
                patch.object(agent_server.STORE, "sessions", {self.sess["id"]: dict(self.sess)}), \
                patch.object(agent_server.STORE, "save", AsyncMock()), \
                patch.object(agent_server, "read_events", side_effect=harness.fake_read_events(events)), \
                patch.object(agent_server, "history_timeline_message_keys", side_effect=sync_fixtures.fake_history_timeline_scan(events)), \
                patch.object(agent_server, "last_event_seq_from_file", side_effect=harness.last_seq(events)), \
                patch.object(agent_server, "append_durable_event_batch", side_effect=harness.fake_append_events(events, batches)):
            aligned = await agent_server.sync_provider_history(dict(self.sess))
            with self.newest.open("a", encoding="utf-8") as stream:
                stream.write(lines([user("try google.com"), assistant("no sandbox")]))
            os.utime(self.newest, (1_000_400, 1_000_400))
            appended = await agent_server.sync_provider_history(dict(self.sess))
            # The next segment continues before a turn the thread then dropped.
            end = self.newest.stat().st_size
            with self.newest.open("a", encoding="utf-8") as stream:
                stream.write(lines([user("aborted turn")]))
            os.utime(self.newest, (1_000_450, 1_000_450))
            write_segment(self.root, "18-00-00", [user("next day"), assistant("resumed")], segment=SEG4, base=(SEG3, end), mtime=1_000_500)
            rotated = await agent_server.sync_provider_history(dict(self.sess))
            unchanged = await agent_server.sync_provider_history(dict(self.sess))

        self.assertEqual([aligned["imported"], appended["imported"], rotated["imported"], unchanged["imported"]], [0, 2, 2, 0])
        added = [
            payload.get("prompt") or payload.get("text")
            for batch in batches for event_type, payload in batch
            if event_type in {"turn_started", "assistant_text"}
        ]
        self.assertEqual(added, ["try google.com", "no sandbox", "next day", "resumed"])


if __name__ == "__main__":
    unittest.main()
