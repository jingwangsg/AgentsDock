"""Codex 0.158+ continues one thread in several rollout files; history reads all of them."""

import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import agent_server
import tests.test_provider_history_sync as sync_fixtures

THREAD = str(uuid.uuid5(uuid.NAMESPACE_URL, "codex-segmented-thread"))
user, assistant, provider_line = sync_fixtures.user, sync_fixtures.assistant, sync_fixtures.provider_line


def write_segment(root: Path, stamp: str, items: list[dict], *, segment: str | None, mtime: int) -> Path:
    """Mirror Codex's layout: the first file is ``-<id>.jsonl``, later ones ``-<id>_<segment>.jsonl``."""
    day = root / "2026" / "09" / "29"
    day.mkdir(parents=True, exist_ok=True)
    path = day / f"rollout-2026-09-29T{stamp}-{THREAD}{'_' + segment if segment else ''}.jsonl"
    meta = {"timestamp": "2026-09-29T07:47:19Z", "type": "session_meta", "payload": {"id": THREAD, "cwd": "/work"}}
    lines = [json.dumps(meta) + "\n"] + [provider_line(agent_server.BACKEND_CODEX, item["kind"], item["text"]) for item in items]
    if not items:  # A reopened client writes settings only.
        lines.append(json.dumps({"type": "event_msg", "payload": {"type": "thread_settings_applied"}}) + "\n")
    path.write_text("".join(lines), encoding="utf-8")
    os.utime(path, (mtime, mtime))
    return path


class CodexSegmentedHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.dir = Path(temporary.name)
        self.root = self.dir / "sessions"
        self.first = [user("find a clinic"), assistant("three clinics"), user("AIA")]
        self.second = [user("AIA, logged in too"), assistant("checking AIA")]
        self.newest = write_segment(self.root, "17-03-00", [], segment="01a0ec67", mtime=1_000_300)
        write_segment(self.root, "15-47-19", self.first, segment=None, mtime=1_000_100)
        write_segment(self.root, "16-01-55", self.second, segment="01a0ec2f", mtime=1_000_200)
        self.enterContext(patch.object(agent_server, "CODEX_SESSIONS_ROOT", self.root))
        self.enterContext(patch.object(agent_server, "CODEX_SESSION_INDEX_PATH", self.dir / "no-index"))
        self.enterContext(patch.object(agent_server, "CLAUDE_PROJECTS_ROOT", self.dir / "no-claude"))

    def test_listing_shows_one_thread_with_the_newest_time_and_the_first_prompt(self):
        [row] = agent_server.local_codex_session_candidates(set())
        self.assertEqual(row["provider_session_id"], THREAD)
        self.assertEqual(row["updated_at"], agent_server.iso_from_timestamp(1_000_300))
        self.assertEqual(row["label"], "find a clinic")

    async def test_bulk_import_brings_every_segment_in_order(self):
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
        self.assertEqual([(item["kind"], item["text"]) for item in items],
                         [(item["kind"], item["text"]) for item in self.first + self.second])

    async def test_sync_adds_only_new_turns_including_after_a_new_segment(self):
        harness = sync_fixtures.DurableHistoryCursorTests
        imported = self.first + self.second
        events = [harness.timeline_event(seq, item) for seq, item in enumerate(imported, 1)]
        batches: list[list[tuple[str, dict]]] = []
        sess = {"id": "sess_segmented", "backend": agent_server.BACKEND_CODEX, "codex_thread_id": THREAD}
        live = {sess["id"]: dict(sess)}
        with patch.object(agent_server, "events_path", side_effect=lambda sid: self.dir / f"{sid}-events.jsonl"), \
                patch.object(agent_server.STORE, "sessions", live), \
                patch.object(agent_server.STORE, "save", AsyncMock()), \
                patch.object(agent_server, "read_events", side_effect=harness.fake_read_events(events)), \
                patch.object(agent_server, "history_timeline_message_keys", side_effect=sync_fixtures.fake_history_timeline_scan(events)), \
                patch.object(agent_server, "last_event_seq_from_file", side_effect=harness.last_seq(events)), \
                patch.object(agent_server, "append_durable_event_batch", side_effect=harness.fake_append_events(events, batches)):
            aligned = await agent_server.sync_provider_history(dict(sess))
            with self.newest.open("a", encoding="utf-8") as stream:
                stream.write(provider_line("codex", "user", "try google.com") + provider_line("codex", "assistant", "no sandbox"))
            os.utime(self.newest, (1_000_400, 1_000_400))
            appended = await agent_server.sync_provider_history(dict(sess))
            write_segment(self.root, "18-00-00", [user("next day"), assistant("resumed")], segment="01a0ec99", mtime=1_000_500)
            rotated = await agent_server.sync_provider_history(dict(sess))
            unchanged = await agent_server.sync_provider_history(dict(sess))

        self.assertEqual([aligned["imported"], appended["imported"], rotated["imported"], unchanged["imported"]], [0, 2, 2, 0])
        added = [
            payload.get("prompt") or payload.get("text")
            for batch in batches for event_type, payload in batch
            if event_type in {"turn_started", "assistant_text"}
        ]
        self.assertEqual(added, ["try google.com", "no sandbox", "next day", "resumed"])


if __name__ == "__main__":
    unittest.main()
