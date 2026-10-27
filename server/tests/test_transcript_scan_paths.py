"""Transcript readers skip the rows they will not return and still answer identically."""
import asyncio
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import agent_server


def event(seq: int, event_type: str, **fields) -> dict:
    return {
        "seq": seq, "id": f"evt_{seq}", "session_id": "scan-chat", "type": event_type,
        "ts": "2026-10-01T00:00:00Z", "run_id": f"run-{seq // 7}", **fields,
    }


def transcript_rows() -> list[dict]:
    rows = []
    for seq in range(1, 2001):
        kind = seq % 23
        if kind == 0:
            rows.append(event(seq, "_event_sequence_checkpoint"))
        elif kind == 1:
            rows.append(event(seq, "turn_started", purpose="cross_chat_handoff_delivery",
                              cross_chat_envelope_id="env-1"))
        elif kind == 2:
            rows.append(event(seq, "turn_started", forked=True, purpose="handoff_digest"))
        elif kind == 3:
            rows.append(event(seq, "assistant_text", forked=True))
        elif kind in (4, 5, 6):
            rows.append(event(seq, "raw_event", raw="{}"))
        elif kind == 7:
            rows.append(event(seq, "queue_snapshot"))
        elif kind == 8:
            rows.append(event(seq, "tool_started", tool={"name": "Bash", "id": f"tool-{seq}"}))
        else:
            rows.append(event(seq, "assistant_text"))
    return rows


class TranscriptScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_state_dir = agent_server.STATE_DIR
        agent_server.STATE_DIR = Path(self.temporary.name)
        self.clear_caches()
        self.session_id = "scan-chat"
        self.path = agent_server.events_path(self.session_id)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in transcript_rows()),
            encoding="utf-8",
        )
        agent_server.rebuild_event_index(self.path)

    def tearDown(self) -> None:
        self.clear_caches()
        agent_server.STATE_DIR = self.previous_state_dir
        self.temporary.cleanup()

    @staticmethod
    def clear_caches() -> None:
        agent_server.FORK_INTERNAL_RUN_CACHE.clear()
        agent_server.FORK_INTERNAL_RUN_LOCKS.clear()
        agent_server.VISIBLE_COUNT_CACHE.clear()
        agent_server.VISIBLE_COUNT_LOCKS.clear()

    def expected_tail_pages(self, limit: int) -> list[tuple]:
        """Reference tail pages computed from a plain full read: (client, timeline, compact)."""
        rows = [row for row in agent_server.read_events(self.session_id, limit=10_000, cap_to_response_limit=False)
                if agent_server.is_client_visible_event(row)]
        internal_runs = agent_server.fork_internal_run_ids(self.session_id)
        latest = rows[-1]["seq"] if rows else 0
        pages = []
        for compact in (None, False, True):
            kept = rows if compact is None else [
                row for row in rows if agent_server.is_visible_timeline_event(row, compact=compact, fork_internal_run_ids=internal_runs)]
            pages.append((kept[-limit:], latest, len(kept), max(0, len(kept) - limit), 0))
        return pages

    def actual_tail_pages(self, limit: int) -> list[tuple]:
        return [
            agent_server.read_client_events_page(self.session_id, limit=limit, tail=True),
            agent_server.read_visible_events_page(self.session_id, limit=limit, tail=True),
            agent_server.read_visible_events_page(self.session_id, limit=limit, tail=True, compact=True),
        ]

    def test_newest_page_matches_a_full_read_as_the_transcript_changes(self) -> None:
        self.assertEqual(self.actual_tail_pages(50), self.expected_tail_pages(50))
        counted_to = agent_server.VISIBLE_COUNT_CACHE[self.session_id]["offset"]
        self.assertEqual(counted_to, self.path.stat().st_size)

        with self.path.open("a", encoding="utf-8") as stream:
            for seq in range(2001, 2101):
                stream.write(json.dumps(event(seq, "assistant_text" if seq % 3 else "raw_event")) + "\n")
        self.assertEqual(self.actual_tail_pages(50), self.expected_tail_pages(50))
        self.assertGreater(agent_server.VISIBLE_COUNT_CACHE[self.session_id]["offset"], counted_to)

        # A later marker makes an already counted run fork-internal: counts must shrink.
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event(2101, "turn_started", run_id="run-10", forked=True, purpose="handoff_digest")) + "\n")
        before_marker = self.expected_tail_pages(50)
        self.assertEqual(self.actual_tail_pages(50), before_marker)
        self.assertLess(before_marker[1][2], 2101)

        # A rolled-back batch: same inode, shorter file, different rows afterwards.
        with self.path.open("r+b") as stream:
            stream.truncate(counted_to)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event(2001, "tool_started", tool={"name": "Bash", "id": "t"})) + "\n")
        self.assertEqual(self.actual_tail_pages(50), self.expected_tail_pages(50))
        self.assertEqual(self.actual_tail_pages(1)[0][1], 2001)

    def test_newest_page_rows_and_totals_describe_the_same_bytes(self) -> None:
        # A row appended between the count pass and the backward walk must not
        # appear in the page while the totals still exclude it.
        counted = dict(agent_server.visible_event_counts(
            self.session_id, self.path.open("rb"), agent_server.fork_internal_run_ids(self.session_id)))
        with self.path.open("a", encoding="utf-8") as stream:
            for seq in range(2001, 2006):
                stream.write(json.dumps(event(seq, "assistant_text")) + "\n")
        with patch.object(agent_server, "visible_event_counts", return_value=counted):
            events, latest_seq, total, omitted_before, omitted_after = agent_server.read_client_events_page(
                self.session_id, limit=3, tail=True)
        self.assertEqual(([row["seq"] for row in events], latest_seq, total), ([1998, 1999, 2000], 2000, counted["client"]))
        self.assertEqual((omitted_before, omitted_after), (counted["client"] - 3, 0))
        events, latest_seq, total, _, _ = agent_server.read_client_events_page(self.session_id, limit=3, tail=True)
        self.assertEqual(([row["seq"] for row in events], latest_seq, total), ([2003, 2004, 2005], 2005, counted["client"] + 5))

    def test_forward_windows_match_a_full_scan_at_every_checkpoint_edge(self) -> None:
        stride = agent_server.EVENT_INDEX_STRIDE
        for after in (0, 1, stride - 1, stride, stride + 1, 3 * stride, 1990, 2000):
            with self.subTest(after=after):
                queries = [
                    lambda: agent_server.read_client_events_page(self.session_id, after=after, limit=50),
                    lambda: agent_server.read_visible_events_page(self.session_id, after=after, limit=50),
                    lambda: agent_server.read_visible_events_page(
                        self.session_id, after=after, before=after + 80, limit=50, compact=True),
                    lambda: agent_server.read_events(self.session_id, after=after, limit=50),
                    lambda: agent_server.read_events(self.session_id, after=after, limit=50, visible=True),
                ]
                seeked = [query() for query in queries]
                with patch.object(agent_server, "event_index_resume_offset", return_value=0):
                    self.assertEqual(seeked, [query() for query in queries])
                offset = agent_server.event_index_resume_offset(self.path, after)
                self.assertEqual(offset > 0, after >= stride)

    def test_page_reads_stop_at_before_and_still_report_the_file_tail(self) -> None:
        # read_events keeps client-internal rows; the page readers drop them and the fork-internal runs.
        rows = [row for row in agent_server.read_events(self.session_id, limit=10_000, cap_to_response_limit=False)
                if agent_server.is_client_visible_event(row)]
        internal_runs = agent_server.fork_internal_run_ids(self.session_id)
        visible = [row for row in rows if agent_server.is_visible_timeline_event(row, fork_internal_run_ids=internal_runs)]
        for after, before in ((0, 1), (0, 300), (700, 900), (1990, 2001), (1999, 2000)):
            with self.subTest(after=after, before=before):
                expected = [row for row in visible if after < row["seq"] < before]
                events, latest_seq, count, omitted_before, omitted_after = agent_server.read_visible_events_page(
                    self.session_id, after=after, before=before, limit=50)
                self.assertEqual((events, latest_seq, count), (expected[:50], 2000, len(expected)))
                self.assertEqual((omitted_before, omitted_after), (0, max(0, len(expected) - 50)))
                events, latest_seq, count, omitted_before, omitted_after = agent_server.read_client_events_page(
                    self.session_id, before=before, limit=50, tail=True)
                expected = [row for row in rows if row["seq"] < before]
                self.assertEqual((events, latest_seq, count), (expected[-50:], 2000, len(expected)))
                self.assertEqual((omitted_before, omitted_after), (max(0, len(expected) - 50), 0))

    def test_tail_window_matches_the_end_of_the_forward_scan(self) -> None:
        everything = agent_server.read_events(self.session_id, limit=10_000, cap_to_response_limit=False)
        visible = agent_server.read_events(
            self.session_id, limit=10_000, cap_to_response_limit=False, visible=True)
        for limit in (1, 10, 240, 5000):
            window = min(limit, agent_server.MAX_EVENT_RESPONSE_LIMIT)
            with self.subTest(limit=limit):
                self.assertEqual(
                    agent_server.read_events(self.session_id, limit=limit, tail=True), everything[-window:])
                self.assertEqual(
                    agent_server.read_events(self.session_id, limit=limit, tail=True, visible=True),
                    visible[-window:])
        bounded = [row for row in everything if 700 < row["seq"] < 900]
        self.assertEqual(
            agent_server.read_events(self.session_id, after=700, before=900, limit=50, tail=True),
            bounded[-50:])
        self.assertEqual(agent_server.read_events(self.session_id, after=2000, limit=50, tail=True), [])
        self.path.write_text("", encoding="utf-8")
        self.assertEqual(agent_server.read_events(self.session_id, limit=5, tail=True), [])

    def test_tail_window_leaves_an_unterminated_last_row_to_the_json_filter(self) -> None:
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write('{"seq": 2001, "type": "assistant_te')
        tail = agent_server.read_events(self.session_id, limit=2, tail=True)
        self.assertEqual([row["seq"] for row in tail], [1999, 2000])


class SubagentFoldCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_state_dir = agent_server.STATE_DIR
        agent_server.STATE_DIR = Path(self.temporary.name)
        agent_server.CLAUDE_SUBAGENT_FOLD_CACHE.clear()
        agent_server.CLAUDE_SUBAGENT_FOLD_LOCKS.clear()
        self.session_id = "fold-chat"
        self.path = agent_server.events_path(self.session_id)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        agent_server.CLAUDE_SUBAGENT_FOLD_CACHE.clear()
        agent_server.CLAUDE_SUBAGENT_FOLD_LOCKS.clear()
        agent_server.STATE_DIR = self.previous_state_dir
        self.temporary.cleanup()

    def row(self, seq: int, event_type: str, **fields) -> str:
        return json.dumps({
            "seq": seq, "session_id": self.session_id, "type": event_type, "backend": "claude",
            "run_id": "run-1", "ts": f"2026-10-01T00:00:{seq:02d}Z", **fields,
        }) + "\n"

    def agent_start(self, seq: int, tool_id: str) -> str:
        return self.row(seq, "tool_started", tool={
            "name": "Agent", "id": tool_id, "input": {"description": f"Explore {tool_id}", "subagent_type": "Explore"},
        })

    def fresh_snapshot(self) -> dict:
        agent_server.CLAUDE_SUBAGENT_FOLD_CACHE.clear()
        return agent_server.build_claude_subagent_snapshot(self.session_id)

    def test_resumed_fold_equals_a_fresh_fold_after_appends(self) -> None:
        self.path.write_text(self.agent_start(1, "tool-a") + self.agent_start(2, "tool-b"))
        agent_server.build_claude_subagent_snapshot(self.session_id)
        self.assertEqual(agent_server.CLAUDE_SUBAGENT_FOLD_CACHE[self.session_id]["offset"], self.path.stat().st_size)

        with self.path.open("a") as stream:
            stream.write(self.row(3, "tool_finished", tool_id="tool-a"))
            stream.write(self.agent_start(4, "tool-c"))
            stream.write(self.row(5, "turn_finished", exit_code=0))
        resumed = agent_server.build_claude_subagent_snapshot(self.session_id)
        self.assertEqual(resumed, self.fresh_snapshot())

    def test_fold_restarts_when_the_file_shrinks_or_is_replaced(self) -> None:
        self.path.write_text(self.agent_start(1, "tool-a") + self.agent_start(2, "tool-b"))
        agent_server.build_claude_subagent_snapshot(self.session_id)

        self.path.write_text(self.agent_start(1, "tool-a"))
        self.assertEqual(agent_server.build_claude_subagent_snapshot(self.session_id), self.fresh_snapshot())
        self.assertEqual(agent_server.build_claude_subagent_snapshot(self.session_id)["count"], 1)

        replacement = self.path.with_suffix(".new")
        replacement.write_text(self.agent_start(1, "tool-a") + self.agent_start(2, "tool-b") + self.agent_start(3, "tool-c"))
        replacement.replace(self.path)
        self.assertEqual(agent_server.build_claude_subagent_snapshot(self.session_id)["count"], 3)

    def test_fold_restarts_when_a_rolled_back_batch_is_replaced_by_other_rows(self) -> None:
        self.path.write_text(self.agent_start(1, "tool-a"))
        original_size = self.path.stat().st_size
        with self.path.open("a") as stream:
            stream.write(self.agent_start(2, "tool-rolled-back"))
        agent_server.build_claude_subagent_snapshot(self.session_id)
        # append_imported_events_sync rolls a failed batch back in place: same inode, shorter file.
        with self.path.open("r+b") as stream:
            stream.truncate(original_size)
        with self.path.open("a") as stream:
            stream.write(self.agent_start(2, "tool-b") + self.agent_start(3, "tool-c"))
        resumed = agent_server.build_claude_subagent_snapshot(self.session_id)
        self.assertEqual(resumed, self.fresh_snapshot())
        self.assertEqual({state["subagent_tool_id"] for state in resumed["subagents"]}, {"tool-a", "tool-b", "tool-c"})

    def test_row_still_being_written_is_folded_once_complete(self) -> None:
        self.path.write_text(self.agent_start(1, "tool-a"))
        whole = self.agent_start(2, "tool-b")
        with self.path.open("a") as stream:
            stream.write(whole[:len(whole) // 2])
        self.assertEqual(agent_server.build_claude_subagent_snapshot(self.session_id)["count"], 1)
        with self.path.open("a") as stream:
            stream.write(whole[len(whole) // 2:].rstrip("\n"))
        # A complete row counts even before its newline lands, as the full re-read did.
        self.assertEqual(agent_server.build_claude_subagent_snapshot(self.session_id)["count"], 2)
        with self.path.open("a") as stream:
            stream.write("\n" + self.agent_start(3, "tool-c"))
        self.assertEqual(agent_server.build_claude_subagent_snapshot(self.session_id)["count"], 3)

    def test_missing_transcript_yields_an_empty_snapshot(self) -> None:
        snapshot = agent_server.build_claude_subagent_snapshot("no-such-chat")
        self.assertEqual((snapshot["count"], snapshot["latest_seq"]), (0, 0))
        self.assertNotIn("no-such-chat", agent_server.CLAUDE_SUBAGENT_FOLD_CACHE)


class ScanTranscriptTests(unittest.IsolatedAsyncioTestCase):
    SESSIONS = {
        "long-chat": {"id": "long-chat", "latest_event_seq": agent_server.LONG_CHAT_MIN_EVENT_SEQ},
        "short-chat": {"id": "short-chat", "latest_event_seq": 12},
    }

    async def test_scans_stay_within_the_scan_pool(self) -> None:
        running = {"long-chat": 0, "short-chat": 0}
        peak = dict(running)
        lock = threading.Lock()

        def scan(session_id: str) -> str:
            with lock:
                running[session_id] += 1
                peak[session_id] = max(peak[session_id], running[session_id])
            time.sleep(0.02)
            with lock:
                running[session_id] -= 1
            return session_id

        with patch.dict(agent_server.STORE.sessions, self.SESSIONS):
            results = await asyncio.gather(*(
                agent_server.scan_transcript(scan, session_id)
                for session_id in ["long-chat", "short-chat"] * 8
            ))
        self.assertEqual(results, ["long-chat", "short-chat"] * 8)
        self.assertLessEqual(max(peak.values()), agent_server.TRANSCRIPT_SCAN_WORKERS)
        if sys._is_gil_enabled():
            self.assertEqual(peak, {"long-chat": 1, "short-chat": 1})

    async def test_short_chat_scan_does_not_queue_behind_a_long_chat_scan(self) -> None:
        long_scan_started = threading.Event()
        release_long_scan = threading.Event()

        def long_scan(session_id: str) -> str:
            long_scan_started.set()
            release_long_scan.wait(10)
            return session_id

        with patch.dict(agent_server.STORE.sessions, self.SESSIONS):
            long_task = asyncio.create_task(agent_server.scan_transcript(long_scan, "long-chat"))
            try:
                self.assertTrue(await asyncio.to_thread(long_scan_started.wait, 5))
                short = await asyncio.wait_for(
                    agent_server.scan_transcript(lambda session_id: session_id, "short-chat"),
                    5,
                )
            finally:
                release_long_scan.set()
            self.assertEqual(short, "short-chat")
            self.assertEqual(await long_task, "long-chat")

    def history_sessions(self, backend: str, id_field: str) -> dict[str, dict[str, object]]:
        long_events = agent_server.LONG_CHAT_MIN_EVENT_SEQ
        sizes = {"long-chat": long_events, "proven-long-chat": long_events, "short-chat": 12}
        return {
            session_id: {
                "id": session_id, "backend": backend, "latest_event_seq": events,
                id_field: f"01a00000-0000-7000-8000-00000000000{index}",
            }
            for index, (session_id, events) in enumerate(sizes.items())
        }

    def native_cache(self, prove=lambda _session_id: False) -> SimpleNamespace:
        def prepare(session_id: str, *_args: object, proof_slot) -> bool:
            with proof_slot:
                return prove(session_id)

        return SimpleNamespace(is_prepared=lambda _session_id, _provider_id: False, prepare=prepare,
                               signature=lambda _session_id: frozenset())

    def test_a_long_chat_proof_waits_for_the_slot_and_a_short_chat_proof_does_not(self) -> None:
        proving = {"long-chat": threading.Event(), "short-chat": threading.Event()}
        cache = self.native_cache(lambda session_id: proving[session_id].set())
        with patch.dict(agent_server.STORE.sessions, self.history_sessions(agent_server.BACKEND_CODEX, "codex_thread_id")), \
                patch.object(agent_server, "CODEX_NATIVE_HISTORY_REPAIR_CACHE", cache), \
                patch.object(agent_server, "find_codex_history", return_value=None):
            proofs = {
                session_id: threading.Thread(target=agent_server.prepare_codex_native_history_repair, args=(session_id,))
                for session_id in proving
            }
            # Another long chat's proof holds the slot.
            with agent_server.LONG_CHAT_HISTORY_PROOF_SLOTS["codex_native"]:
                for proof in proofs.values():
                    proof.start()
                self.assertTrue(proving["short-chat"].wait(2), "a short chat waited for the slot")
                self.assertFalse(proving["long-chat"].wait(0.3), "two long chats proved at once")
            for proof in proofs.values():
                proof.join(5)
        self.assertTrue(proving["long-chat"].is_set())

    def test_neither_a_proven_long_claude_chat_nor_a_proof_under_its_lock_waits_for_the_slot(self) -> None:
        prepared = []
        cache = SimpleNamespace(
            is_prepared=lambda session_id, _provider_id: session_id == "proven-long-chat",
            prepare=lambda session_id, *_args, **_kwargs: prepared.append(session_id) or False,
        )
        # wait_for_slot=False: the caller holds one of the chat's locks (an import's refresh).
        calls = [("proven-long-chat", {}), ("long-chat", {"refresh": True, "wait_for_slot": False})]
        with patch.dict(agent_server.STORE.sessions, self.history_sessions(agent_server.BACKEND_CLAUDE, "claude_session_id")), \
                patch.object(agent_server, "CLAUDE_METADATA_REPAIR_CACHE", cache):
            with agent_server.LONG_CHAT_HISTORY_PROOF_SLOTS["claude"]:
                for session_id, kwargs in calls:
                    proof = threading.Thread(target=agent_server.prepare_claude_history_metadata_repair,
                                             args=(session_id,), kwargs=kwargs)
                    proof.start()
                    proof.join(2)
                    self.assertFalse(proof.is_alive(), f"{session_id} {kwargs} waited for the slot")
        # prepare() still ran for the proven chat: it keeps the proof's LRU place.
        self.assertEqual(prepared, ["proven-long-chat", "long-chat"])

    def test_a_codex_proof_under_the_chat_lock_does_not_wait_for_the_slots(self) -> None:
        goal_cache = SimpleNamespace(is_prepared=lambda _session_id, _provider_id: False, prepare=lambda *_args: False)
        with patch.dict(agent_server.STORE.sessions, self.history_sessions(agent_server.BACKEND_CODEX, "codex_thread_id")), \
                patch.object(agent_server, "CODEX_GOAL_HISTORY_REPAIR_CACHE", goal_cache), \
                patch.object(agent_server, "CODEX_NATIVE_HISTORY_REPAIR_CACHE", self.native_cache()), \
                patch.object(agent_server, "find_codex_history", return_value=None):
            # Other long chats' proofs hold both slots.
            with agent_server.LONG_CHAT_HISTORY_PROOF_SLOTS["codex_goal"], \
                    agent_server.LONG_CHAT_HISTORY_PROOF_SLOTS["codex_native"]:
                proof = threading.Thread(target=agent_server.prepare_provider_history_metadata_repair,
                                         args=("long-chat",), kwargs={"wait_for_slot": False})
                proof.start()
                proof.join(2)
                self.assertFalse(proof.is_alive(), "a proof under the chat's lock waited for a slot")

    def test_a_build_waiting_for_a_proof_slot_does_not_hold_the_chat_index_lock(self) -> None:
        cache = self.native_cache()
        with patch.dict(agent_server.STORE.sessions, self.history_sessions(agent_server.BACKEND_CODEX, "codex_thread_id")), \
                patch.object(agent_server, "CODEX_NATIVE_HISTORY_REPAIR_CACHE", cache), \
                patch.object(agent_server, "find_codex_history", return_value=None):
            build = threading.Thread(target=agent_server.build_timeline_index, args=("long-chat",))
            with agent_server.LONG_CHAT_HISTORY_PROOF_SLOTS["codex_native"]:
                build.start()
                build.join(0.3)
                self.assertTrue(build.is_alive())
                # A delete of the chat takes this lock to drop its cached index.
                index_lock = agent_server.timeline_index_session_lock("long-chat")
                self.assertTrue(index_lock.acquire(blocking=False))
                index_lock.release()
            build.join(5)

    def test_no_other_chat_waits_for_a_held_timeline_index_lock(self) -> None:
        held = agent_server.timeline_index_session_lock("long-chat")
        with held:
            self.assertIs(agent_server.timeline_index_session_lock("long-chat"), held)
            # 256 chats: with the former 64 shared locks, about 98% of runs put
            # one of them on the held lock.
            for index in range(256):
                other = agent_server.timeline_index_session_lock(f"short-chat-{index}")
                self.assertTrue(other.acquire(blocking=False), f"short-chat-{index}")
                other.release()

    def test_unreferenced_timeline_index_locks_are_dropped(self) -> None:
        with agent_server.timeline_index_session_lock("deleted-chat"):
            self.assertIn("deleted-chat", agent_server.TIMELINE_INDEX_SESSION_LOCKS)
        self.assertNotIn("deleted-chat", agent_server.TIMELINE_INDEX_SESSION_LOCKS)


if __name__ == "__main__":
    unittest.main()
