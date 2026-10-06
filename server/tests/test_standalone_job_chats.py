"""Standalone scheduled jobs run in their own chat, like Codex cron automations.

Regression for a standalone job that never ran while its parent chat held a
days-long goal: the per-chat busy check deferred it every minute and posted a
DEFERRED card each time.
"""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

import agent_server


PARENT = "sess_parent_goal"


def parent_session() -> dict:
    return {
        "id": PARENT,
        "title": "Training goal",
        "folder": "Research",
        "cwd": "/tmp/work",
        "backend": agent_server.BACKEND_CODEX,
        "model": "gpt-5.6-sol",
        "effort": "high",
        "system_prompt": "Be brief.",
        "archived": False,
    }


def due_job(job_id: str, context_mode: str) -> dict:
    return {
        "id": job_id,
        "session_id": PARENT,
        "title": f"Monitor {context_mode}",
        "prompt": "Check the training run.",
        "schedule_kind": "interval",
        "interval_seconds": 1800,
        "timezone": "UTC",
        "enabled": True,
        "loop": True,
        "run_count": 0,
        "next_run_at": 1.0,
        "scheduled_run_at": 1.0,
        "context_mode": context_mode,
        "backend": agent_server.BACKEND_CODEX,
        "_revision": agent_server.new_job_revision(),
    }


class SchedulerBusyParentTests(unittest.IsolatedAsyncioTestCase):
    async def test_busy_parent_runs_standalone_and_silently_defers_chat_job(self) -> None:
        store = agent_server.JobStore()
        store.jobs = {
            "job_standalone": due_job("job_standalone", "standalone"),
            "job_chat": due_job("job_chat", "chat"),
        }
        iterations = 0

        async def one_iteration(_delay: float) -> None:
            nonlocal iterations
            iterations += 1
            if iterations > 1:
                raise asyncio.CancelledError

        events = AsyncMock()
        with (
            patch.object(agent_server.STORE, "sessions", {PARENT: parent_session()}),
            patch.object(agent_server, "BUSY_SESSIONS", {PARENT}),
            patch.object(agent_server, "SERVER_MAINTENANCE_SESSIONS", set()),
            patch.object(agent_server, "managed_server_update_scheduled_job_blocker", return_value=None),
            patch.object(agent_server, "turn_start_blocker", AsyncMock(return_value=None)),
            patch.object(agent_server, "host_pressure_snapshot", return_value={"available_mem_mb": 65536}),
            patch.object(agent_server, "JOB_DEFER_EVENT_MIN_SECONDS", 0),
            patch.object(agent_server.time, "time", return_value=2.0),
            patch.object(agent_server.asyncio, "sleep", side_effect=one_iteration),
            patch.object(store, "save", new_callable=AsyncMock),
            patch.object(store, "run_job", new_callable=AsyncMock) as run_job,
            patch.object(agent_server, "append_event", events),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await store.scheduler_loop()

        run_job.assert_awaited_once_with("job_standalone")
        chat_job = store.jobs["job_chat"]
        self.assertEqual(chat_job["last_defer_reason"], agent_server.JOB_CHAT_BUSY_DETAIL)
        self.assertEqual(chat_job["scheduled_run_at"], 1.0)
        self.assertNotIn("job_deferred", [call.args[1] for call in events.await_args_list])


class StandaloneRunChatTests(unittest.IsolatedAsyncioTestCase):
    async def test_standalone_run_starts_a_new_chat_with_parent_settings(self) -> None:
        store = agent_server.JobStore()
        store.jobs = {"job_standalone": due_job("job_standalone", "standalone")}
        sessions = {PARENT: parent_session()}
        start_turn = AsyncMock(return_value={"run_id": "run_standalone"})
        events = AsyncMock()
        with (
            patch.object(agent_server.STORE, "sessions", sessions),
            patch.object(agent_server.STORE, "save", new_callable=AsyncMock),
            patch.object(agent_server, "BUSY_SESSIONS", {PARENT}),
            patch.object(agent_server, "start_turn", start_turn),
            patch.object(agent_server, "append_event", events),
            patch.object(store, "save", new_callable=AsyncMock),
        ):
            result = await store.run_job("job_standalone")

        self.assertEqual(result["run_id"], "run_standalone")
        run_chat_id = start_turn.await_args.args[0]
        self.assertNotEqual(run_chat_id, PARENT)
        self.assertEqual(start_turn.await_args.kwargs["scheduled_job_owner_session_id"], PARENT)
        self.assertNotIn("provider_context_mode", start_turn.await_args.kwargs)
        run_chat = sessions[run_chat_id]
        self.assertEqual(
            {key: run_chat[key] for key in ("title", "folder", "cwd", "backend", "model", "effort", "system_prompt")},
            {
                "title": "Monitor standalone",
                "folder": "Research",
                "cwd": "/tmp/work",
                "backend": agent_server.BACKEND_CODEX,
                "model": "gpt-5.6-sol",
                "effort": "high",
                "system_prompt": "Be brief.",
            },
        )
        marker = {"job_id": "job_standalone", "session_id": PARENT}
        self.assertEqual(run_chat["scheduled_job_run"], marker)
        self.assertEqual(agent_server.public_session(run_chat, summary=True)["scheduled_job_run"], marker)
        self.assertNotIn("scheduled_job_run", agent_server.public_session(sessions[PARENT], summary=True))
        ran = [call.args for call in events.await_args_list if call.args[1] == "job_ran"]
        self.assertEqual(len(ran), 1)
        self.assertEqual(ran[0][0], PARENT)
        self.assertEqual(ran[0][2]["run_session_id"], run_chat_id)
        self.assertEqual(ran[0][2]["run_id"], "run_standalone")

    async def test_failed_admission_deletes_the_empty_run_chat(self) -> None:
        store = agent_server.JobStore()
        store.jobs = {"job_standalone": due_job("job_standalone", "standalone")}
        sessions = {PARENT: parent_session()}
        failure = agent_server.HTTPException(status_code=503, detail="runtime unavailable")
        delete_session = AsyncMock()
        with (
            patch.object(agent_server.STORE, "sessions", sessions),
            patch.object(agent_server.STORE, "save", new_callable=AsyncMock),
            patch.object(agent_server, "start_turn", AsyncMock(side_effect=failure)),
            patch.object(agent_server, "delete_session", delete_session),
            patch.object(agent_server, "append_event", new_callable=AsyncMock),
            patch.object(store, "save", new_callable=AsyncMock),
        ):
            with self.assertRaises(agent_server.HTTPException):
                await store.run_job("job_standalone")

        run_chat_ids = [sid for sid in sessions if sid != PARENT]
        self.assertEqual(len(run_chat_ids), 1)
        delete_session.assert_awaited_once_with(run_chat_ids[0])

    async def test_admission_checks_the_dispatch_revision_against_the_owner(self) -> None:
        run_chat = {**parent_session(), "id": "sess_run", "scheduled_job_run": {"job_id": "job_standalone", "session_id": PARENT}}

        class Stop(Exception):
            pass

        assert_revision = AsyncMock()
        with (
            patch.object(agent_server.STORE, "sessions", {PARENT: parent_session(), "sess_run": run_chat}),
            patch.object(agent_server.JOBS, "assert_dispatch_revision", assert_revision),
            patch.object(agent_server, "validate_scheduled_job_chat_references", side_effect=Stop),
        ):
            with self.assertRaises(Stop):
                await agent_server._start_turn_locked(
                    "sess_run",
                    agent_server.TurnRequest(
                        prompt="Check the training run.",
                        purpose="scheduled_job",
                        job_id="job_standalone",
                        job_title="Monitor standalone",
                    ),
                    queue_if_busy=False,
                    scheduled_job_owner_session_id=PARENT,
                    scheduled_job_chat_references=True,
                    scheduled_job_revision="job_rev_test",
                )
        assert_revision.assert_awaited_once_with("job_standalone", PARENT, "job_rev_test")


class StandaloneRunReportTests(unittest.IsolatedAsyncioTestCase):
    def sessions(self) -> dict:
        return {
            PARENT: parent_session(),
            "sess_run": {
                **parent_session(),
                "id": "sess_run",
                "scheduled_job_run": {"job_id": "job_standalone", "session_id": PARENT},
            },
        }

    async def test_finished_run_reports_its_result_to_the_owning_chat(self) -> None:
        appended: list[tuple] = []

        async def record(session_id, event_type, payload=None):
            appended.append((session_id, event_type, dict(payload or {})))
            return {"seq": len(appended), "type": event_type, "session_id": session_id, **(payload or {})}

        terminal = {
            "run_id": "run_standalone",
            "exit_code": 0,
            "result_text": "Training is at step 1200.",
            "purpose": "scheduled_job",
            "job_id": "job_standalone",
            "job_title": "Monitor standalone",
        }
        with (
            patch.object(agent_server.STORE, "sessions", self.sessions()),
            patch.object(agent_server, "append_event", side_effect=record),
            patch.object(agent_server, "refresh_native_session_title", AsyncMock()),
            patch.object(agent_server, "schedule_generated_session_title", Mock()),
            patch.object(agent_server, "finalize_cross_chat_terminal", AsyncMock()),
            patch.object(agent_server, "schedule_model_capacity_resend", Mock()),
        ):
            await agent_server.append_turn_finished_event("sess_run", terminal)
            # A later turn the user sends in the run chat is not the job's run.
            await agent_server.append_turn_finished_event(
                "sess_run", {"run_id": "run_followup", "exit_code": 0, "result_text": "ok"},
            )

        reports = [entry for entry in appended if entry[1] == "job_finished"]
        self.assertEqual(len(reports), 1)
        session_id, _type, payload = reports[0]
        self.assertEqual(session_id, PARENT)
        self.assertEqual(payload["run_session_id"], "sess_run")
        self.assertEqual(payload["run_id"], "run_standalone")
        self.assertEqual(payload["result_text"], "Training is at step 1200.")
        self.assertEqual(agent_server.scheduled_job_run_status({"type": "job_finished", **payload}), "completed")

    async def test_stopped_run_closes_the_owning_chat_card_as_stopped(self) -> None:
        sessions = self.sessions()
        with (
            patch.object(agent_server.STORE, "sessions", sessions),
            patch.object(agent_server, "finalize_cross_chat_terminal", AsyncMock()),
        ):
            for session_id in sessions:
                agent_server.ensure_dirs(session_id)
            await agent_server.append_event("sess_run", "turn_stopped", {
                "run_id": "run_standalone",
                "stopped": True,
                "purpose": "scheduled_job",
                "job_id": "job_standalone",
                "job_title": "Monitor standalone",
            })
        parent_events = [
            json.loads(line)
            for line in agent_server.events_path(PARENT).read_text().splitlines()
        ]
        reports = [event for event in parent_events if event["type"] == "job_finished"]
        self.assertEqual(len(reports), 1)
        self.assertTrue(reports[0]["stopped"])
        self.assertEqual(agent_server.scheduled_job_run_status(reports[0]), "stopped")

    def test_job_summary_keeps_the_run_chat_link(self) -> None:
        landmark = {"key": "job:job_standalone", "job_id": "job_standalone", "start_seq": 1, "end_seq": 2}
        state = agent_server.new_semantic_job_state(landmark)
        for seq, event_type in ((1, "job_ran"), (2, "job_finished")):
            agent_server.add_semantic_job_event(state, {
                "seq": seq,
                "type": event_type,
                "job_id": "job_standalone",
                "run_id": "run_standalone",
                "run_session_id": "sess_run",
            })
        summary = agent_server.semantic_job_summary_event(PARENT, state)
        self.assertEqual(summary["run_session_id"], "sess_run")
        self.assertEqual(summary["job_status"], "completed")


class StandaloneRestartRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_scans_the_newest_run_chat_for_standalone_jobs(self) -> None:
        store = agent_server.JobStore()
        store.jobs = {
            "job_standalone": due_job("job_standalone", "standalone"),
            "job_chat": due_job("job_chat", "chat"),
        }
        marker = {"job_id": "job_standalone", "session_id": PARENT}
        sessions = {
            PARENT: parent_session(),
            "sess_run_old": {"id": "sess_run_old", "created_at": "2026-10-06T10:00:00Z", "scheduled_job_run": marker},
            "sess_run_new": {"id": "sess_run_new", "created_at": "2026-10-06T10:30:00Z", "scheduled_job_run": marker},
        }
        scan = Mock(return_value={})
        with (
            patch.object(agent_server.STORE, "sessions", sessions),
            patch.object(agent_server, "durable_scheduled_job_admissions", scan),
        ):
            await store.reconcile_admitted_runs_after_restart()
        scanned = scan.call_args.args[0]
        self.assertEqual(scanned["job_standalone"]["session_id"], "sess_run_new")
        self.assertEqual(scanned["job_chat"]["session_id"], PARENT)
        self.assertEqual(store.jobs["job_standalone"]["session_id"], PARENT)


if __name__ == "__main__":
    unittest.main()
