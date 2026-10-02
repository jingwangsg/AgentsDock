"""POST /api/sessions/{id}/rewind and the workspace checkpoint restore guard."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import agent_server as server


def rewind_request(**overrides):
    payload = {"to_run_id": "third", "expected_latest_seq": 10, "confirmed": True}
    payload.update(overrides)
    return server.RewindSessionRequest(**payload)


class RewindFixture(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.state = Path(self._temp.name) / "state"
        self.sessions: dict[str, dict] = {}
        self._patches = [
            patch.object(server, "STATE_DIR", self.state),
            patch.object(server, "CODE_DIFFS_ROOT", self.state / "code_diffs"),
            patch.object(server, "EVENT_SEQ_CACHE", {}),
            patch.object(server, "EVENT_SEQ_LOCK", asyncio.Lock()),
            patch.object(server, "EVENT_SEQ_REPAIR_LOCKS", {}),
            patch.object(server, "EVENT_DELIVERY_LOCKS", {}),
            patch.object(server, "ACTIVE", {}),
            patch.object(server, "BUSY_SESSIONS", set()),
            patch.object(server, "QUEUED_TURNS", {}),
            patch.object(server, "SESSION_TURN_TASKS", {}),
            patch.object(server, "SERVER_MAINTENANCE_SESSIONS", set()),
            patch.object(server, "CODEX_THREAD_SESSION_INDEX", {}),
            patch.object(server, "ABANDONED_FORK_PROVIDER_THREADS", set()),
            patch.object(server, "ABANDONED_FORK_THREADS_FILE", self.state / "abandoned-forks.json"),
            patch.object(server, "broadcast_provider_runtime_changed", new=AsyncMock()),
            patch.object(server, "prepare_codex_login_turn", new=AsyncMock()),
            patch.object(server, "REWIND_ADMISSION_RETRY_SECONDS", 0),
            patch.object(server, "ensure_dirs", return_value=None),
            patch.object(server.STORE, "sessions", self.sessions),
            patch.object(server.STORE, "save", new=AsyncMock()),
            patch.object(server.HUB, "broadcast", new=AsyncMock()),
        ]
        for item in self._patches:
            item.start()
        self.addCleanup(self._temp.cleanup)
        for item in reversed(self._patches):
            self.addCleanup(item.stop)

    def events(self):
        return [
            {"seq": 1, "id": "e1", "type": "turn_started", "run_id": "first", "ts": "2026-09-08T10:00:00Z", "prompt": "Earlier question"},
            {"seq": 2, "id": "e2", "type": "reasoning_summary", "phase": "commentary", "run_id": "first", "ts": "2026-09-08T10:00:30Z", "text": "Completed answer"},
            {"seq": 3, "id": "e3", "type": "turn_finished", "run_id": "first", "ts": "2026-09-08T10:01:00Z", "exit_code": 0, "result_text": "Completed answer",
             "provider_thread_id": "thread-1", "provider_turn_id": "turn-1"},
            {"seq": 4, "id": "e4", "type": "turn_started", "run_id": "second", "ts": "2026-09-08T10:02:00Z", "prompt": "Second question"},
            {"seq": 5, "id": "e5", "type": "assistant_text", "run_id": "second", "ts": "2026-09-08T10:02:30Z", "text": "Second answer"},
            {"seq": 6, "id": "e6", "type": "turn_finished", "run_id": "second", "ts": "2026-09-08T10:03:00Z", "exit_code": 0, "result_text": "Second answer",
             "provider_thread_id": "thread-1", "provider_turn_id": "turn-2"},
            {"seq": 7, "id": "e7", "type": "code_diff", "run_id": "second", "ts": "2026-09-08T10:03:01Z", "checkpoint_commit": "a" * 40},
            {"seq": 8, "id": "e8", "type": "turn_started", "run_id": "third", "ts": "2026-09-08T10:04:00Z", "prompt": "Third question"},
            {"seq": 9, "id": "e9", "type": "assistant_text", "run_id": "third", "ts": "2026-09-08T10:04:30Z", "text": "Third answer"},
            {"seq": 10, "id": "e10", "type": "turn_finished", "run_id": "third", "ts": "2026-09-08T10:05:00Z", "exit_code": 0, "result_text": "Third answer",
             "provider_thread_id": "thread-1", "provider_turn_id": "turn-3"},
        ]

    def chat(self, backend: str = "claude", **overrides) -> dict:
        sess = {
            "id": "chat", "backend": backend, "cwd": self._temp.name, "title": "Chat",
            "claude_session_id": "claude-parent", "codex_thread_id": "thread-1", "created_at": "2026-09-08T10:00:00Z",
            "latest_event_seq": 10, "latest_event_type": "turn_finished",
            "latest_agent_event_seq": 10, "last_read_agent_event_seq": 10,
        }
        sess.update(overrides)
        self.sessions["chat"] = sess
        path = server.events_path("chat")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps({"session_id": "chat", **event}) + "\n" for event in self.events()), encoding="utf-8")
        return sess

    def stored_events(self) -> list[dict]:
        return [json.loads(line) for line in server.events_path("chat").read_text(encoding="utf-8").splitlines() if line.strip()]

    def claude_transcript(self, *records):
        native = {"type": "assistant", "uuid": "second-uuid", "timestamp": "2026-09-08T10:02:40Z",
                  "message": {"content": [{"type": "text", "text": "Second answer"}]}}
        older = {**native, "uuid": "first-uuid", "timestamp": "2026-09-08T10:00:40Z", "message": {"content": [{"type": "text", "text": "Completed answer"}]}}
        return patch.multiple(
            server,
            claude_resume_file_for_cwd=Mock(return_value=Mock(is_file=Mock(return_value=True))),
            bounded_jsonl_events=Mock(return_value=[older, native, *records]),
        )

    async def persisting_bind(self, session_id, thread_id, _sess, **_kwargs):
        await server.STORE.save_provider_session(session_id, thread_id, server.BACKEND_CODEX, codex_instruction_hash="policy-hash")
        return thread_id, "policy-hash"

    async def assertRewindRejected(self, request, status: int, code: str | None = None):
        with self.assertRaises(server.HTTPException) as raised:
            await server.rewind_session("chat", request)
        self.assertEqual(raised.exception.status_code, status)
        if code is not None:
            self.assertEqual(raised.exception.detail["code"], code)
        return raised.exception


class SessionRewindTests(RewindFixture):
    async def test_claude_rewind_selects_previous_completed_boundary_and_truncates(self) -> None:
        sess = self.chat()
        diff_root = server.code_diffs_dir("chat")
        server.checkpoints_dir("chat").mkdir(parents=True)
        for run_id in ("second", "third"):
            (diff_root / f"{run_id}.patch").write_text("patch")
            (diff_root / f"{run_id}.json").write_text("{}")
            (server.checkpoints_dir("chat") / run_id).write_text("b" * 40)
        server.write_timeline_pin_state_sync("chat", {
            "revision": 3, "updated_at": None, "tombstones": {}, "legacy_imports_closed": False,
            "pins": {
                "message:e2": {"id": "message:e2", "sessionId": "chat", "kind": "message", "eventId": "e2", "title": "kept", "createdAt": 1},
                "message:e9": {"id": "message:e9", "sessionId": "chat", "kind": "message", "eventId": "e9", "title": "gone", "createdAt": 2},
            },
        })

        with self.claude_transcript():
            result = await server.rewind_session("chat", rewind_request())

        self.assertEqual({key: result[key] for key in ("ok", "from_seq", "through_seq", "removed_events", "provider_rewind")},
                         {"ok": True, "from_seq": 8, "through_seq": 10, "removed_events": 3, "provider_rewind": "claude_fork"})
        self.assertEqual(sess["fork_from"], "claude-parent")
        self.assertEqual(sess["fork_resume_session_at"], "second-uuid")
        self.assertEqual(sess["claude_session_id"], "claude-parent")
        stored = self.stored_events()
        self.assertEqual([event["seq"] for event in stored], [1, 2, 3, 4, 5, 6, 7, 10, 11])
        self.assertEqual(stored[-2]["type"], "_event_sequence_checkpoint")
        tombstone = stored[-1]
        self.assertEqual(tombstone["type"], "history_rewound")
        self.assertEqual({key: tombstone[key] for key in ("from_seq", "through_seq", "to_run_id", "removed_events", "provider_rewind")},
                         {"from_seq": 8, "through_seq": 10, "to_run_id": "third", "removed_events": 3, "provider_rewind": "claude_fork"})
        self.assertEqual(server.HUB.broadcast.await_args.args[1]["type"], "history_rewound")
        self.assertEqual(sess["latest_event_seq"], 11)
        self.assertEqual(sess["latest_event_type"], "history_rewound")
        self.assertEqual((sess["latest_agent_event_seq"], sess["latest_agent_event_type"]), (6, "turn_finished"))
        self.assertEqual(sess["last_read_agent_event_seq"], 6)
        self.assertNotIn("active_run", sess)
        self.assertEqual(result["session"]["latest_event_seq"], 11)
        self.assertEqual(sorted(path.name for path in diff_root.iterdir() if path.is_file()), ["second.json", "second.patch"])
        self.assertEqual([path.name for path in server.checkpoints_dir("chat").iterdir()], ["second"])
        pins = server.read_timeline_pin_state_sync("chat")
        self.assertEqual(list(pins["pins"]), ["message:e2"])
        self.assertEqual(pins["revision"], 4)
        self.assertTrue(server.should_bump_session_updated_at("history_rewound", tombstone))
        self.assertTrue(server.is_visible_timeline_event(tombstone, compact=True))

    async def test_claude_rewind_to_first_turn_resets_provider_session(self) -> None:
        sess = self.chat(latest_agent_event_seq=9)
        result = await server.rewind_session("chat", rewind_request(to_run_id="first"))
        self.assertEqual(result["provider_rewind"], "claude_reset")
        self.assertEqual((sess["claude_session_id"], sess["session_id"], sess["fork_from"]), (None, None, None))
        self.assertNotIn("fork_resume_session_at", sess)
        self.assertNotIn("latest_agent_event_seq", sess)
        self.assertEqual(sess["last_read_agent_event_seq"], 0)
        self.assertEqual([(event["seq"], event["type"]) for event in self.stored_events()],
                         [(10, "_event_sequence_checkpoint"), (11, "history_rewound")])

    async def test_claude_provider_failures_leave_history_unchanged(self) -> None:
        self.chat(claude_session_id=None, session_id=None)
        await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_unavailable")
        self.chat()
        duplicate = {"type": "assistant", "uuid": "twin-uuid", "timestamp": "2026-09-08T10:02:50Z",
                     "message": {"content": [{"type": "text", "text": "Second answer"}]}}
        with self.claude_transcript(duplicate):
            await self.assertRewindRejected(rewind_request(), 409, "rewind_boundary_ambiguous")
        with patch.object(server, "claude_completed_fork_boundary", side_effect=OSError("gone")):
            await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_unavailable")
        self.assertEqual(len(self.stored_events()), 10)
        self.assertNotIn("fork_from", self.sessions["chat"])

    async def test_codex_rewind_forks_at_previous_completed_turn_and_rebinds_same_chat(self) -> None:
        sess = self.chat(backend="codex", codex_token_usage={"total_tokens": 5})
        server.CODEX_THREAD_SESSION_INDEX["thread-1"] = "chat"
        order: list[str] = []

        async def fork(*_args, **_kwargs):
            # The real fork journals its thread in the abandoned-fork ledger
            # before returning; save_provider_session refuses a fenced thread.
            self.assertTrue(await server.persist_abandoned_fork_provider_thread("forked-thread"))
            order.append("fork")
            return "forked-thread"

        async def bind(session_id, thread_id, bound_sess, **_kwargs):
            # The chat must already own the fork and the fence must be gone,
            # otherwise the real bind's save_provider_session raises 409.
            self.assertEqual(bound_sess["codex_thread_id"], "forked-thread")
            self.assertNotIn("forked-thread", server.ABANDONED_FORK_PROVIDER_THREADS)
            order.append("bind")
            await server.STORE.save_provider_session(session_id, thread_id, server.BACKEND_CODEX, codex_instruction_hash="policy-hash")
            return thread_id, "policy-hash"

        with patch.object(server, "fork_codex_thread", AsyncMock(side_effect=fork)) as fork_mock, patch.object(
            server, "bind_forked_codex_thread", AsyncMock(side_effect=bind),
        ) as bind_mock:
            result = await server.rewind_session("chat", rewind_request())
        fork_mock.assert_awaited_once_with("thread-1", sess, last_turn_id="turn-2")
        bind_mock.assert_awaited_once_with("chat", "forked-thread", sess, require_goal_support=False, expected_goal=None)
        self.assertEqual(order, ["fork", "bind"])
        self.assertEqual(server.ABANDONED_FORK_PROVIDER_THREADS, set())
        self.assertNotIn("forked-thread", (self.state / "abandoned-forks.json").read_text(encoding="utf-8"))
        self.assertEqual((result["from_seq"], result["through_seq"], result["removed_events"], result["provider_rewind"]), (8, 10, 3, "codex_fork"))
        self.assertEqual((sess["codex_thread_id"], sess["session_id"], sess["codex_instruction_hash"]), ("forked-thread", "forked-thread", "policy-hash"))
        self.assertNotIn("codex_token_usage", sess)
        self.assertEqual(server.CODEX_THREAD_SESSION_INDEX, {"forked-thread": "chat"})
        self.assertEqual([event["seq"] for event in self.stored_events()], [1, 2, 3, 4, 5, 6, 7, 10, 11])
        self.assertEqual(self.stored_events()[-1]["provider_rewind"], "codex_fork")

    def replayed_chat_with_failed_turn(self) -> list[dict]:
        # A chat resumed from Codex's own history: every completed turn is a replay without a native
        # turn id, and the newest turn failed before thread/resume.
        return [
            {"seq": 1, "id": "e1", "type": "history_imported", "run_id": "import_a", "ts": "2026-09-08T10:00:00Z", "imported": True},
            {"seq": 2, "id": "e2", "type": "turn_started", "run_id": "import_a", "ts": "2026-09-08T10:00:01Z", "prompt": "Earlier question", "imported": True},
            {"seq": 3, "id": "e3", "type": "assistant_text", "run_id": "import_a", "ts": "2026-09-08T10:00:30Z", "text": "Earlier answer", "imported": True},
            {"seq": 4, "id": "e4", "type": "turn_finished", "run_id": "import_a", "ts": "2026-09-08T10:01:00Z", "imported": True},
            {"seq": 5, "id": "e5", "type": "turn_started", "run_id": "failed", "ts": "2026-09-08T10:02:00Z", "prompt": "New question"},
            {"seq": 6, "id": "e6", "type": "error", "run_id": "failed", "ts": "2026-09-08T10:02:10Z", "message": "409: another writer"},
            {"seq": 7, "id": "e7", "type": "turn_finished", "run_id": "failed", "ts": "2026-09-08T10:02:10Z", "exit_code": 1, "provider_thread_id": "thread-1"},
        ]

    def write_events(self, events: list[dict]) -> dict:
        sess = self.chat(backend="codex", latest_event_seq=7, latest_agent_event_seq=7, last_read_agent_event_seq=7)
        server.events_path("chat").write_text("".join(json.dumps({"session_id": "chat", **event}) + "\n" for event in events), encoding="utf-8")
        return sess

    async def test_codex_rewind_of_a_turn_that_never_reached_the_thread_leaves_it_bound(self) -> None:
        sess = self.write_events(self.replayed_chat_with_failed_turn())
        with patch.object(server, "fork_codex_thread", AsyncMock()) as fork:
            result = await server.rewind_session("chat", rewind_request(to_run_id="failed", expected_latest_seq=7))
        fork.assert_not_awaited()
        self.assertIsNone(result["provider_rewind"])
        self.assertEqual(sess["codex_thread_id"], "thread-1")
        self.assertEqual([(event["seq"], event["type"]) for event in self.stored_events()],
                         [(1, "history_imported"), (2, "turn_started"), (3, "assistant_text"), (4, "turn_finished"), (7, "_event_sequence_checkpoint"), (8, "history_rewound")])

    async def test_codex_rewind_of_a_delivery_unknown_turn_still_needs_the_fork(self) -> None:
        # The failed turn's turn/start answer was lost, so it may have run on the thread; the fork
        # it then needs has no cutoff in a replayed history.
        events = self.replayed_chat_with_failed_turn()
        events[5]["delivery_unknown"] = True
        sess = self.write_events(events)
        await self.assertRewindRejected(rewind_request(to_run_id="failed", expected_latest_seq=7), 409, "rewind_provider_unavailable")
        self.assertEqual(sess["codex_thread_id"], "thread-1")

    def standalone_job_run(self, run_id: str, seq: int, provider: dict) -> list[dict]:
        job = {"purpose": "scheduled_job", "job_id": "job-1", "provider_context_mode": "standalone"}
        return [
            {"seq": seq, "id": f"e{seq}", "type": "turn_started", "run_id": run_id, "ts": "2026-09-08T10:03:30Z", "prompt": "Check the training run", **job},
            {"seq": seq + 1, "id": f"e{seq + 1}", "type": "turn_finished", "run_id": run_id, "ts": "2026-09-08T10:03:40Z", "exit_code": 0,
             "result_text": "Still running", **job, **provider},
        ]

    async def test_a_standalone_scheduled_run_before_the_edit_is_not_the_codex_cutoff(self) -> None:
        # The chat's scheduled job ran on its own thread between the second turn and the edited one;
        # the fork still has to happen at the chat thread's own last completed turn.
        base = self.events()
        events = [*base[:7], *self.standalone_job_run("job", 8, {"provider_thread_id": "job-thread", "provider_turn_id": "job-turn"}),
                  *[{**event, "seq": event["seq"] + 2, "id": f"e{event['seq'] + 2}"} for event in base[7:10]]]
        sess = self.write_events(events)
        sess.update(latest_event_seq=12, latest_agent_event_seq=12, last_read_agent_event_seq=12)
        server.CODEX_THREAD_SESSION_INDEX["thread-1"] = "chat"
        with patch.object(server, "fork_codex_thread", AsyncMock(return_value="forked-thread")) as fork, patch.object(
            server, "bind_forked_codex_thread", AsyncMock(side_effect=self.persisting_bind),
        ):
            result = await server.rewind_session("chat", rewind_request(expected_latest_seq=12))
        fork.assert_awaited_once_with("thread-1", sess, last_turn_id="turn-2")
        self.assertEqual(result["provider_rewind"], "codex_fork")

    async def test_removing_only_a_standalone_scheduled_run_leaves_the_codex_thread_alone(self) -> None:
        events = [*self.events()[:7], *self.standalone_job_run("job", 8, {"provider_thread_id": "job-thread", "provider_turn_id": "job-turn"})]
        sess = self.write_events(events)
        sess.update(latest_event_seq=9, latest_agent_event_seq=9, last_read_agent_event_seq=9)
        with patch.object(server, "fork_codex_thread", AsyncMock()) as fork:
            result = await server.rewind_session("chat", rewind_request(to_run_id="job", expected_latest_seq=9))
        fork.assert_not_awaited()
        self.assertIsNone(result["provider_rewind"])
        self.assertEqual(sess["codex_thread_id"], "thread-1")

    async def test_a_standalone_scheduled_run_before_the_edit_is_not_the_claude_cutoff(self) -> None:
        base = self.events()
        events = [*base[:7], *self.standalone_job_run("job", 8, {"provider_session_id": "job-session"}),
                  *[{**event, "seq": event["seq"] + 2, "id": f"e{event['seq'] + 2}"} for event in base[7:10]]]
        sess = self.chat(latest_event_seq=12, latest_agent_event_seq=12, last_read_agent_event_seq=12)
        server.events_path("chat").write_text("".join(json.dumps({"session_id": "chat", **event}) + "\n" for event in events), encoding="utf-8")
        with self.claude_transcript():
            result = await server.rewind_session("chat", rewind_request(expected_latest_seq=12))
        self.assertEqual(result["provider_rewind"], "claude_fork")
        self.assertEqual(sess["fork_resume_session_at"], "second-uuid")

    async def test_codex_rewind_to_first_turn_resets_provider_thread(self) -> None:
        sess = self.chat(backend="codex", codex_instruction_hash="policy-hash", codex_instruction_version=3)
        server.CODEX_THREAD_SESSION_INDEX["thread-1"] = "chat"
        with patch.object(server, "fork_codex_thread", AsyncMock()) as fork:
            result = await server.rewind_session("chat", rewind_request(to_run_id="first"))
        fork.assert_not_awaited()
        self.assertEqual(result["provider_rewind"], "codex_reset")
        self.assertEqual((sess["codex_thread_id"], sess["session_id"]), (None, None))
        self.assertNotIn("codex_instruction_hash", sess)
        self.assertNotIn("codex_instruction_version", sess)
        self.assertEqual(server.CODEX_THREAD_SESSION_INDEX, {})
        self.assertEqual([(event["seq"], event["type"]) for event in self.stored_events()],
                         [(10, "_event_sequence_checkpoint"), (11, "history_rewound")])

    async def test_codex_provider_failures_leave_history_unchanged(self) -> None:
        self.chat(backend="codex", codex_thread_id="rotated-thread")
        with patch.object(server, "fork_codex_thread", AsyncMock()) as fork:
            await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_unavailable")
        fork.assert_not_awaited()

        sess = self.chat(backend="codex")
        server.CODEX_THREAD_SESSION_INDEX["thread-1"] = "chat"
        with patch.object(server, "fork_codex_thread", AsyncMock(side_effect=RuntimeError("provider down"))), patch.object(server.logger, "warning") as warning:
            await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_unavailable")
        # The client gets a generic message; the log keeps the cause.
        self.assertIn("provider down", str(warning.call_args))

        retire = AsyncMock(return_value=True)

        async def failing_bind(session_id, thread_id, *_args, **_kwargs):
            await server.STORE.save_provider_session(session_id, thread_id, server.BACKEND_CODEX)
            raise RuntimeError("bind failed")

        with patch.object(server, "fork_codex_thread", AsyncMock(return_value="forked-thread")), patch.object(
            server, "bind_forked_codex_thread", AsyncMock(side_effect=failing_bind),
        ), patch.object(server, "retire_or_record_failed_codex_fork", retire):
            await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_unavailable")
        retire.assert_awaited_once_with("forked-thread")
        self.assertEqual((sess["codex_thread_id"], sess["session_id"]), ("thread-1", "thread-1"))
        self.assertEqual(server.CODEX_THREAD_SESSION_INDEX.get("thread-1"), "chat")

        # The fence could not be released: fail closed before binding.
        retire.reset_mock()
        with patch.object(server, "fork_codex_thread", AsyncMock(return_value="forked-thread")), patch.object(
            server, "forget_abandoned_fork_provider_thread", AsyncMock(return_value=False),
        ), patch.object(server, "bind_forked_codex_thread", AsyncMock()) as bind, patch.object(
            server, "retire_or_record_failed_codex_fork", retire,
        ):
            await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_unavailable")
        bind.assert_not_awaited()
        retire.assert_awaited_once_with("forked-thread")
        self.assertEqual((sess["codex_thread_id"], sess["session_id"]), ("thread-1", "thread-1"))
        self.assertEqual(len(self.stored_events()), 10)

    async def test_rewind_admission_rejections(self) -> None:
        self.chat()
        await self.assertRewindRejected(rewind_request(confirmed=False), 400, "rewind_confirmation_required")
        await self.assertRewindRejected(rewind_request(expected_latest_seq=None), 428, "latest_seq_required")
        stale = await self.assertRewindRejected(rewind_request(expected_latest_seq=9), 409, "stale_latest_seq")
        self.assertEqual(stale.detail["latest_seq"], 10)
        self.assertIn("latest_seq from GET /api/sessions/{id}", stale.detail["message"])
        await self.assertRewindRejected(rewind_request(to_run_id="missing"), 409, "rewind_target_not_found")
        server.BUSY_SESSIONS.add("chat")
        await self.assertRewindRejected(rewind_request(), 409, "session_busy")
        server.BUSY_SESSIONS.clear()
        server.QUEUED_TURNS["chat"] = [{"id": "queued"}]
        await self.assertRewindRejected(rewind_request(), 409, "turn_queue_not_empty")
        server.QUEUED_TURNS.clear()
        for backend in ("cursor", "opencode"):
            self.chat(backend=backend)
            await self.assertRewindRejected(rewind_request(), 409, "rewind_unsupported_backend")
        self.chat()
        path = server.events_path("chat")
        path.write_text(path.read_text(encoding="utf-8").replace('"run_id": "third", "ts": "2026-09-08T10:04:00Z"',
                                                                 '"run_id": "third", "ts": "2026-09-08T10:04:00Z", "secure_peer_envelope_id": "env-1"'), encoding="utf-8")
        await self.assertRewindRejected(rewind_request(), 409, "rewind_cross_chat_history")
        with self.assertRaises(server.HTTPException) as missing:
            await server.rewind_session("absent", rewind_request())
        self.assertEqual(missing.exception.status_code, 404)
        self.assertEqual(len(self.stored_events()), 10)

    async def test_expected_latest_seq_is_the_durable_file_tail_not_session_metadata(self) -> None:
        # Provider status rows and turn checkpoints can sit above
        # sessions.json's latest_event_seq; the client saw them, so the file
        # tail is the value it must echo back.
        self.chat(latest_event_seq=8)
        await self.assertRewindRejected(rewind_request(expected_latest_seq=8), 409, "stale_latest_seq")
        result = await server.rewind_session("chat", rewind_request(to_run_id="first", expected_latest_seq=10))
        self.assertEqual((result["from_seq"], result["through_seq"]), (1, 10))

    async def test_codex_admission_wait_is_retried_then_succeeds(self) -> None:
        sess = self.chat(backend="codex")
        waiting = server.TransientAdmissionWait(409, "Refreshing Codex sign-in. Wait, then retry.")
        fork = AsyncMock(side_effect=[waiting, waiting, "forked-thread"])
        with patch.object(server, "fork_codex_thread", fork), patch.object(
            server, "bind_forked_codex_thread", AsyncMock(side_effect=self.persisting_bind),
        ):
            result = await server.rewind_session("chat", rewind_request())
        self.assertEqual(result["provider_rewind"], "codex_fork")
        self.assertEqual(fork.await_count, 3)
        self.assertEqual(server.prepare_codex_login_turn.await_count, 3)
        self.assertEqual(sess["codex_thread_id"], "forked-thread")

    async def test_codex_admission_wait_beyond_budget_is_a_busy_409(self) -> None:
        self.chat(backend="codex")
        waiting = server.TransientAdmissionWait(409, "Refreshing Codex sign-in. Wait, then retry.")
        with patch.object(server, "fork_codex_thread", AsyncMock(side_effect=waiting)) as fork, patch.object(
            server, "bind_forked_codex_thread", AsyncMock(),
        ) as bind:
            busy = await self.assertRewindRejected(rewind_request(), 409, "rewind_provider_busy")
        self.assertEqual(busy.detail, {
            "code": "rewind_provider_busy",
            "message": "Refreshing Codex sign-in. Wait, then retry.",
            "retry_after_seconds": 5,
        })
        self.assertEqual(fork.await_count, server.REWIND_ADMISSION_RETRY_ATTEMPTS)
        bind.assert_not_awaited()
        self.assertEqual(len(self.stored_events()), 10)
        self.assertEqual(self.sessions["chat"]["codex_thread_id"], "thread-1")

    async def test_codex_admission_wait_during_bind_retires_fork_and_retries(self) -> None:
        sess = self.chat(backend="codex")
        waiting = server.TransientAdmissionWait(409, "Refreshing Codex sign-in. Wait, then retry.")
        retire = AsyncMock(return_value=True)
        attempts: list[str] = []

        async def bind_waits_once(session_id, thread_id, bound_sess, **kwargs):
            attempts.append(thread_id)
            if len(attempts) == 1:
                raise waiting
            return await self.persisting_bind(session_id, thread_id, bound_sess, **kwargs)

        with patch.object(server, "fork_codex_thread", AsyncMock(return_value="forked-thread")) as fork, patch.object(
            server, "bind_forked_codex_thread", AsyncMock(side_effect=bind_waits_once),
        ), patch.object(server, "retire_or_record_failed_codex_fork", retire):
            result = await server.rewind_session("chat", rewind_request())
        self.assertEqual(result["provider_rewind"], "codex_fork")
        self.assertEqual(fork.await_count, 2)
        retire.assert_awaited_once_with("forked-thread")
        self.assertEqual((sess["codex_thread_id"], sess["session_id"]), ("forked-thread", "forked-thread"))
        self.assertEqual(server.CODEX_THREAD_SESSION_INDEX, {"forked-thread": "chat"})

    async def test_successive_codex_rewinds_accept_cutoffs_from_ancestor_threads(self) -> None:
        # This chat already lives on thread-1 after an earlier fork; run
        # "first" completed on the ancestor thread-0.
        sess = self.chat(backend="codex", codex_thread_lineage=["thread-0"])
        path = server.events_path("chat")
        events = [{"session_id": "chat", **event} for event in self.events()]
        events[2]["provider_thread_id"] = "thread-0"
        path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        fork = AsyncMock(side_effect=["thread-2", "thread-3"])
        with patch.object(server, "fork_codex_thread", fork), patch.object(
            server, "bind_forked_codex_thread", AsyncMock(side_effect=self.persisting_bind),
        ):
            first = await server.rewind_session("chat", rewind_request(to_run_id="third"))
            self.assertEqual(fork.await_args_list[-1].args[0], "thread-1")
            self.assertEqual(fork.await_args_list[-1].kwargs, {"last_turn_id": "turn-2"})
            self.assertEqual(sess["codex_thread_lineage"], ["thread-0", "thread-1"])
            latest = server.last_event_seq_from_file(path)
            second = await server.rewind_session("chat", rewind_request(to_run_id="second", expected_latest_seq=latest))
        self.assertEqual((first["provider_rewind"], second["provider_rewind"]), ("codex_fork", "codex_fork"))
        # The second cutoff is turn-1, recorded on ancestor thread-0, forked
        # from the current thread-2 because forks keep ancestor turn ids.
        self.assertEqual(fork.await_args_list[-1].args[0], "thread-2")
        self.assertEqual(fork.await_args_list[-1].kwargs, {"last_turn_id": "turn-1"})
        self.assertEqual(sess["codex_thread_id"], "thread-3")
        self.assertEqual(sess["codex_thread_lineage"], ["thread-0", "thread-1", "thread-2"])
        self.assertEqual([event["seq"] for event in self.stored_events()], [1, 2, 3, 11, 12])
        # A reset forgets the lineage along with the thread.
        latest = server.last_event_seq_from_file(path)
        with patch.object(server, "fork_codex_thread", AsyncMock()) as reset_fork:
            reset = await server.rewind_session("chat", rewind_request(to_run_id="first", expected_latest_seq=latest))
        reset_fork.assert_not_awaited()
        self.assertEqual(reset["provider_rewind"], "codex_reset")
        self.assertNotIn("codex_thread_lineage", sess)


class CheckpointRestoreGuardTests(RewindFixture):
    async def test_guard_requires_idle_writable_chat_with_checkpoint_then_records_restore(self) -> None:
        self.chat()
        with self.assertRaises(server.HTTPException) as missing:
            async with server.session_checkpoint_restore("chat", "second"):
                pass
        self.assertEqual((missing.exception.status_code, missing.exception.detail["code"]), (404, "checkpoint_not_found"))

        server.checkpoints_dir("chat").mkdir(parents=True)
        (server.checkpoints_dir("chat") / "second").write_text("c" * 40 + "\n")
        server.BUSY_SESSIONS.add("chat")
        with self.assertRaises(server.HTTPException) as busy:
            async with server.session_checkpoint_restore("chat", "second"):
                pass
        self.assertEqual((busy.exception.status_code, busy.exception.detail["code"]), (409, "session_busy"))
        server.BUSY_SESSIONS.clear()

        self.sessions["chat"]["archived"] = True
        with self.assertRaises(server.HTTPException) as archived:
            async with server.session_checkpoint_restore("chat", "second"):
                pass
        self.assertEqual((archived.exception.status_code, archived.exception.detail["code"]), (409, "workspace_read_only"))
        self.sessions["chat"]["archived"] = False

        async with server.session_checkpoint_restore("chat", "second") as (commit, objects_dir):
            self.assertEqual(commit, "c" * 40)
            self.assertEqual(objects_dir, server.checkpoint_objects_dir("chat"))
            self.assertEqual(len(self.stored_events()), 10)
        recorded = self.stored_events()[-1]
        self.assertEqual((recorded["type"], recorded["run_id"], recorded["checkpoint_commit"]), ("workspace_checkpoint_restored", "second", "c" * 40))

    async def test_guard_does_not_record_a_failed_restore(self) -> None:
        self.chat()
        server.checkpoints_dir("chat").mkdir(parents=True)
        (server.checkpoints_dir("chat") / "second").write_text("c" * 40)
        with self.assertRaises(RuntimeError):
            async with server.session_checkpoint_restore("chat", "second"):
                raise RuntimeError("git failed")
        self.assertEqual(len(self.stored_events()), 10)


class RewindEditTests(RewindFixture):
    async def test_claude_rewind_evicts_the_chats_connected_sdk_process(self) -> None:
        # A connected process keeps the options it started with; only a new one
        # can resume at the cutoff.
        self.chat()
        manager = Mock(evict=AsyncMock(return_value=True))
        with self.claude_transcript(), patch.object(server, "CLAUDE_SDK_MANAGER", manager):
            result = await server.rewind_session("chat", rewind_request())
        self.assertEqual(result["provider_rewind"], "claude_fork")
        manager.evict.assert_awaited_once_with("chat")

    def imported_batch(self) -> list[dict]:
        return [
            {"seq": 1, "id": "e1", "type": "history_imported", "run_id": "import_a", "ts": "2026-09-08T10:00:00Z", "imported": True},
            {"seq": 2, "id": "e2", "type": "turn_started", "run_id": "import_a", "ts": "2026-09-08T09:00:00Z", "prompt": "First", "imported": True},
            {"seq": 3, "id": "e3", "type": "assistant_text", "run_id": "import_a", "ts": "2026-09-08T09:00:30Z", "text": "One", "imported": True},
            {"seq": 4, "id": "e4", "type": "turn_started", "run_id": "import_a", "ts": "2026-09-08T09:01:00Z", "prompt": "Second", "imported": True},
            {"seq": 5, "id": "e5", "type": "assistant_text", "run_id": "import_a", "ts": "2026-09-08T09:01:30Z", "text": "Two", "imported": True},
            {"seq": 6, "id": "e6", "type": "turn_finished", "run_id": "import_a", "ts": "2026-09-08T09:01:30Z", "imported": True},
        ]

    async def test_editing_a_later_imported_message_keeps_the_imported_turns_before_it(self) -> None:
        # Every imported turn shares the import's run id, so the target is the message itself.
        self.chat(backend="codex", latest_event_seq=6, latest_agent_event_seq=6, last_read_agent_event_seq=6)
        server.events_path("chat").write_text("".join(json.dumps({"session_id": "chat", **event}) + "\n" for event in self.imported_batch()), encoding="utf-8")

        result = await server.rewind_session("chat", server.RewindSessionRequest(to_run_id="import_a", to_seq=4, expected_latest_seq=6, confirmed=True))

        self.assertEqual({key: result[key] for key in ("from_seq", "through_seq", "removed_events", "provider_rewind")},
                         {"from_seq": 4, "through_seq": 6, "removed_events": 3, "provider_rewind": "codex_reset"})
        self.assertEqual([event["seq"] for event in self.stored_events() if event["type"] != "_event_sequence_checkpoint"], [1, 2, 3, 7])
        await self.assertRewindRejected(server.RewindSessionRequest(to_run_id="import_a", to_seq=3, expected_latest_seq=7, confirmed=True), 409, "rewind_target_not_found")

    def test_a_fork_binding_is_dropped_once_the_source_session_ran_a_turn_after_the_rewind(self) -> None:
        sess = self.chat(fork_from="claude-parent", fork_resume_session_at="second-uuid")
        # The source session's own turns before the rewind made it resumable; they must not drop the binding.
        events = self.events() + [
            {"seq": 11, "id": "e11", "type": "provider_session", "run_id": "third", "ts": "2026-09-08T10:05:00Z",
             "backend": "claude", "provider_session_id": "claude-parent"},
            {"seq": 12, "id": "e12", "type": "history_rewound", "ts": "2026-09-08T10:06:00Z", "to_run_id": "third"},
            {"seq": 13, "id": "e13", "type": "turn_started", "run_id": "fourth", "ts": "2026-09-08T10:07:00Z", "prompt": "Edited"},
        ]
        path = server.events_path("chat")
        path.write_text("".join(json.dumps({"session_id": "chat", **event}) + "\n" for event in events), encoding="utf-8")
        server.drop_stale_claude_fork_binding("chat", sess)
        self.assertEqual((sess["fork_from"], sess["fork_resume_session_at"]), ("claude-parent", "second-uuid"))
        # The turn ran in the source session itself: the fork never happened.
        ran = {"seq": 14, "id": "e14", "type": "provider_session", "run_id": "fourth", "ts": "2026-09-08T10:07:05Z",
               "backend": "claude", "provider_session_id": "claude-parent"}
        path.write_text(path.read_text(encoding="utf-8") + json.dumps({"session_id": "chat", **ran}) + "\n", encoding="utf-8")
        server.drop_stale_claude_fork_binding("chat", sess)
        self.assertIsNone(sess["fork_from"])
        self.assertNotIn("fork_resume_session_at", sess)


if __name__ == "__main__":
    unittest.main()


class RewindOutputsTests(RewindFixture):
    """Canvases and published files follow the rewound history."""

    def setUp(self) -> None:
        super().setUp()
        files_patch = patch.object(server, "FILES_ROOT", self.state / "files")
        files_patch.start()
        self.addCleanup(files_patch.stop)

    def canvas_dir(self) -> Path:
        directory = self.state / "canvases" / "chat"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def snapshot(self, run_id: str, **canvases: str) -> Path:
        directory = server.canvas_checkpoints_dir("chat") / run_id
        directory.mkdir(parents=True, exist_ok=True)
        for name, source in canvases.items():
            (directory / f"{name}.canvas.tsx").write_text(source)
        return directory

    def publish_artifact(self) -> Path:
        artifact_dir = self.state / "files" / "art_0123456789abcdef"
        artifact_dir.mkdir(parents=True)
        (artifact_dir / "plot.png").write_bytes(b"png")
        (artifact_dir / "meta.json").write_text(json.dumps({"id": "art_0123456789abcdef", "session_id": "chat", "kind": "artifact"}))
        with server.events_path("chat").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"session_id": "chat", "seq": 11, "id": "e11", "type": "artifact_created", "run_id": "third",
                                     "ts": "2026-09-08T10:05:30Z", "artifact": {"id": "art_0123456789abcdef", "filename": "plot.png"}}) + "\n")
        return artifact_dir

    def test_snapshot_starts_with_the_first_canvas_and_records_empty_turns_after(self) -> None:
        server.snapshot_session_canvases_sync("chat", "first")
        self.assertFalse(server.canvas_checkpoints_dir("chat").exists())
        directory = self.canvas_dir()
        (directory / "board.canvas.tsx").write_text("v2")
        (directory / "board.canvas.data.json").write_text("{}")
        server.snapshot_session_canvases_sync("chat", "second")
        self.assertEqual([path.name for path in (server.canvas_checkpoints_dir("chat") / "second").iterdir()], ["board.canvas.tsx"])
        (directory / "board.canvas.tsx").unlink()
        server.snapshot_session_canvases_sync("chat", "third")
        self.assertEqual(list((server.canvas_checkpoints_dir("chat") / "third").iterdir()), [])
        with patch.object(server, "CODE_DIFF_CHECKPOINT_MAX_PER_SESSION", 1):
            server.snapshot_session_canvases_sync("chat", "fourth")
        self.assertEqual(sorted(path.name for path in server.canvas_checkpoints_dir("chat").iterdir()), ["fourth"])

    async def test_rewind_restores_canvases_and_deletes_published_files(self) -> None:
        sess = self.chat(latest_event_seq=11)
        self.snapshot("second", board="v2")
        self.snapshot("third", board="v3", extra="extra")
        directory = self.canvas_dir()
        (directory / "board.canvas.tsx").write_text("v3")
        (directory / "board.canvas.data.json").write_text('{"kept": true}')
        # Comment threads are the user's, like UI state: kept with a surviving canvas, gone with a removed one.
        (directory / "board.canvas.comments.json").write_text('{"threads": []}')
        (directory / "extra.canvas.tsx").write_text("extra")
        (directory / "extra.canvas.data.json").write_text("{}")
        (directory / ".extra.canvas.build.json").write_text("{}")
        (directory / "extra.canvas.comments.json").write_text('{"threads": []}')
        artifact_dir = self.publish_artifact()

        with self.claude_transcript():
            result = await server.rewind_session("chat", rewind_request(expected_latest_seq=11))

        self.assertEqual(result["provider_rewind"], "claude_fork")
        self.assertEqual((directory / "board.canvas.tsx").read_text(), "v2")
        self.assertEqual((directory / "board.canvas.data.json").read_text(), '{"kept": true}')
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ["board.canvas.comments.json", "board.canvas.data.json", "board.canvas.tsx"])
        self.assertFalse(artifact_dir.exists())
        self.assertEqual(sorted(path.name for path in server.canvas_checkpoints_dir("chat").iterdir()), ["second"])
        tombstone = self.stored_events()[-1]
        self.assertEqual(tombstone["type"], "history_rewound")
        self.assertEqual(tombstone["outputs_reverted"], {"canvases": 2, "artifacts": 1})
        self.assertEqual(sess["latest_event_type"], "history_rewound")

    async def test_rewind_before_the_first_canvas_removes_every_canvas(self) -> None:
        self.chat()
        self.snapshot("third", board="v3")
        directory = self.canvas_dir()
        (directory / "board.canvas.tsx").write_text("v3")

        with self.claude_transcript():
            await server.rewind_session("chat", rewind_request())

        self.assertEqual(list(directory.iterdir()), [])
        self.assertEqual(self.stored_events()[-1]["outputs_reverted"], {"canvases": 1, "artifacts": 0})

    async def test_rewind_leaves_untracked_canvases_alone(self) -> None:
        self.chat()
        directory = self.canvas_dir()
        (directory / "board.canvas.tsx").write_text("legacy")

        with self.claude_transcript():
            await server.rewind_session("chat", rewind_request())

        self.assertEqual((directory / "board.canvas.tsx").read_text(), "legacy")
        self.assertEqual(self.stored_events()[-1]["outputs_reverted"], {"canvases": 0, "artifacts": 0})
