"""Exercise the activity digest on synthetic events and a fake hub, never a live server."""
import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import activity_digest


SINCE = datetime(2026, 10, 12, 19, 30, tzinfo=timezone.utc)
UNTIL = SINCE + timedelta(minutes=30)


def event(seq, kind, minute, **fields):
    """An event `minute` minutes after SINCE (negative: before the window)."""
    ts = (SINCE + timedelta(minutes=minute)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"seq": seq, "type": kind, "ts": ts, **fields}


class SummarizeChatTests(unittest.TestCase):
    def summarize(self, events, last_minute=29):
        return activity_digest.summarize_chat(events, SINCE, UNTIL, SINCE + timedelta(minutes=last_minute))

    def test_user_messages_are_typed_queued_and_steered_turns(self):
        digest = self.summarize([
            event(1, "turn_started", 1, run_id="run_a", prompt="fix the tunnel", purpose=None),
            event(2, "turn_queued", 2, queued_id="queued_s", prompt="also the logs", purpose=None),
            event(3, "turn_steered", 2, run_id="run_a", queued_id="queued_s", prompt="also the logs"),
            event(4, "turn_queued", 3, queued_id="queued_q", prompt="then the dev log", purpose=None),
            event(5, "turn_queue_updated", 4, queued_id="queued_q", prompt="then the DEV_LOG"),
            event(6, "turn_queued", 4, queued_id="queued_x", prompt="never mind", purpose=None),
            event(7, "turn_unqueued", 5, queued_id="queued_x", message="Removed queued message."),
            # A steer into a running Codex goal is fenced first, then delivered.
            event(8, "turn_queued", 6, queued_id="queued_g", prompt="also check goal", purpose=None),
            event(9, "turn_unqueued", 6, queued_id="queued_g", reason="native_delivery_fence"),
            event(10, "turn_steered", 6, run_id="run_a", queued_id="queued_g", prompt="also check goal"),
            event(11, "turn_finished", 10, run_id="run_a", result_text="Fixed both."),
            # The queued message runs later; it was already counted when queued.
            event(12, "turn_started", 10, run_id="run_b", prompt="then the DEV_LOG", queued_id="queued_q", purpose=None),
        ])

        self.assertEqual(
            [message["text"] for message in digest["messages"]],
            ["fix the tunnel", "also the logs", "then the DEV_LOG", "also check goal"],
        )
        self.assertEqual(digest["messages"][1]["run"]["result"], "Fixed both.")
        self.assertTrue(digest["messages"][2]["run"]["running"])
        self.assertTrue(digest["running"])

    def test_agent_turns_and_imported_rows_are_not_user_messages(self):
        digest = self.summarize([
            event(1, "turn_started", 1, run_id="run_job", prompt="check the queue", purpose="scheduled_job", job_title="Hourly check"),
            event(2, "turn_finished", 2, run_id="run_job", result_text="Queue empty."),
            event(3, "chat_conversation_message_received", 3, source_title="main thread", handoff_preview="Please merge"),
            event(4, "turn_started", 3, run_id="run_wake", prompt="", purpose="chat_mailbox_wake"),
            event(5, "turn_finished", 5, run_id="run_wake", result_text="Merged."),
            event(6, "turn_started", 6, run_id="import_1", prompt="typed in the CLI", imported=True),
        ], last_minute=6)

        self.assertEqual(digest["messages"], [])
        self.assertEqual([run["purpose"] for run in digest["agent_runs"]], ["scheduled_job", "chat_mailbox_wake"])
        self.assertEqual(digest["mail"][0][1], "main thread")
        self.assertFalse(digest["running"])

    def test_turn_stopped_ends_a_run(self):
        digest = self.summarize([
            event(1, "turn_started", 2, run_id="run_a", prompt="long task", purpose=None),
            event(2, "turn_stopped", 5, run_id="run_a", stopped=True, recovered_after_restart=True),
        ])

        self.assertFalse(digest["running"])
        self.assertEqual(activity_digest.outcome(digest["messages"][0]["run"], 100), "03:35 stopped")

    def test_run_without_an_end_event_ends_at_the_next_turn(self):
        digest = self.summarize([
            event(1, "turn_started", -50, run_id="run_lost", prompt="earlier", purpose=None),
            event(2, "turn_started", -40, run_id="run_next", prompt="later", purpose=None),
            event(3, "turn_finished", -35, run_id="run_next", result_text="Done."),
        ])

        # Both runs ended before the window: nothing is active in it.
        self.assertEqual(digest["active"], [])

    def test_run_without_an_end_event_has_no_recorded_result(self):
        digest = self.summarize([
            event(1, "turn_started", 1, run_id="run_lost", prompt="earlier", purpose=None),
            event(2, "turn_started", 5, run_id="run_next", prompt="later", purpose=None),
        ])

        lost_run = digest["messages"][0]["run"]
        self.assertEqual(activity_digest.outcome(lost_run, 100), "ended without a recorded result")

    def test_run_started_before_the_window_and_still_running_is_active(self):
        digest = self.summarize([
            event(1, "assistant_text", -90, run_id="run_long", text="Working on shard 5"),
        ])

        self.assertEqual(len(digest["active"]), 1)
        self.assertTrue(digest["running"])
        self.assertEqual(digest["messages"], [])


class WindowBoundsTests(unittest.TestCase):
    def bounds(self, now, since=None, day=None):
        return activity_digest.window_bounds(argparse.Namespace(since=since, day=day), now)

    def test_half_hour_window_ends_at_the_last_slot(self):
        # A run that starts at 04:07:49 in Shanghai covers 03:30-04:00.
        now = datetime(2026, 10, 12, 20, 7, 49, tzinfo=timezone.utc)

        self.assertEqual(self.bounds(now, since="30m"), (SINCE, UNTIL, "window"))

    def test_day_is_local_midnight_to_midnight(self):
        since, until, mode = self.bounds(SINCE, day="2026-10-13")

        self.assertEqual(mode, "day")
        self.assertEqual(since, datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc))
        self.assertEqual(until, datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc))

    def test_yesterday_just_after_local_midnight_is_the_day_that_ended(self):
        # 00:00:05 on 13 October in Shanghai is still 12 October in UTC.
        now = datetime(2026, 10, 12, 16, 0, 5, tzinfo=timezone.utc)

        since, until, _ = self.bounds(now, day="yesterday")

        self.assertEqual(since, datetime(2026, 10, 11, 16, 0, tzinfo=timezone.utc))
        self.assertEqual(until, datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc))


class RedactionTests(unittest.TestCase):
    def test_secrets_are_redacted_and_ordinary_content_is_kept(self):
        for text, expected in [
            ("fix it, token=abc123", "fix it, [redacted]"),
            ("export AGENTSDOCK_AGENT_TOKEN=abc123", "export AGENTSDOCK_AGENT_[redacted]"),
            ('{"password": "hunter2"}', '{"[redacted]"}'),
            ("密码：hunter2", "[redacted]"),
            ("login --password hunter2 now", "login [redacted] now"),
            ("Authorization: Bearer abc.def", "Authorization: [redacted]"),
            ("clone https://jing:S3cret@github.com/x", "clone https://[redacted]@github.com/x"),
            ("key sk-1234567890abcdefghij", "key [redacted]"),
            ("max_tokens=4096,temperature=0.7", None),
            ("tokenizer: Qwen/Qwen3-8B", None),
            ("/data/wam_admitted_l40_window_filter_20261013/run.py", None),
            ("Qwen3-VL-235B-A22B-Instruct-2507", None),
            ("第一轮去重约50022小时第二轮约48112小时固定Stage2只含第一轮最初16批目标表", None),
        ]:
            with self.subTest(text=text):
                self.assertEqual(activity_digest.clip(text, 200), expected or text)


class DigestOutputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="activity-digest-")
        self.addCleanup(temporary.cleanup)
        env_file = Path(temporary.name) / "env"
        env_file.write_text("export AGENTSDOCK_AGENT_TOKEN=test-token\nexport AGENTSDOCK_AGENT_PORT=1\n")
        patcher = mock.patch.object(activity_digest, "ENV_FILE", env_file)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Fake chats live in the half hour that ended at the last :00 or :30.
        now = datetime.now(timezone.utc)
        self.until = datetime.fromtimestamp(now.timestamp() // 1800 * 1800, timezone.utc)
        self.responses = {"/api/admin/remote-servers": {"servers": []}}

    def before_until(self, minutes):
        """A timestamp `minutes` minutes before the end of the window."""
        return (self.until - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def run_digest(self, *args):
        def fake_get(hub, path, **query):
            response = self.responses[path]
            if callable(response):
                response = response(query)
            if isinstance(response, Exception):
                raise response
            return response

        output = io.StringIO()
        with mock.patch.object(activity_digest.Hub, "get", fake_get), \
                mock.patch("sys.argv", ["activity_digest.py", *args]), contextlib.redirect_stdout(output):
            self.assertEqual(activity_digest.main(), 0)
        return output.getvalue()

    def test_idle_window_prints_only_the_no_activity_marker(self):
        self.responses["/api/sessions"] = {"sessions": [
            {"id": "sess_old", "title": "Old", "latest_event_at": self.before_until(90)},
            {"id": "sess_digest", "title": "Digest", "latest_event_at": self.before_until(1)},
        ]}

        output = self.run_digest("--since", "30m", "--exclude", "sess_digest")

        self.assertIn("NO_ACTIVITY", output)
        self.assertNotIn("## ", output)

    def test_unreadable_local_chat_is_reported_instead_of_no_activity(self):
        self.responses["/api/sessions"] = {"sessions": [
            {"id": "sess_a", "title": "Busy chat", "latest_event_at": self.before_until(5)},
        ]}
        self.responses["/api/sessions/sess_a"] = TimeoutError("timed out")

        output = self.run_digest("--since", "30m")

        self.assertIn("local hub chat “Busy chat” unreadable (timed out)", output)
        self.assertIn("READ_ERRORS", output)
        self.assertNotIn("NO_ACTIVITY", output)

    def test_unreachable_remote_is_one_entry_and_local_chats_still_appear(self):
        self.responses.update({
            "/api/admin/remote-servers": {"servers": [
                {"id": "r1", "name": "gpu-box", "hidden": False},
                {"id": "r2", "name": "hidden-box", "hidden": True},
            ]},
            "/api/remote/r1/api/sessions": OSError("All connection attempts failed"),
            "/api/sessions": {"sessions": [
                {"id": "sess_a", "title": "Tunnel fix", "folder": "AgentsDock", "latest_event_at": self.before_until(5)},
            ]},
            "/api/sessions/sess_a": {"events_omitted_before": 0, "events": [
                {"seq": 1, "type": "turn_started", "ts": self.before_until(10), "run_id": "run_a", "prompt": "fix it", "purpose": None},
                {"seq": 2, "type": "turn_finished", "ts": self.before_until(5), "run_id": "run_a", "result_text": "Fixed."},
            ]},
        })

        output = self.run_digest("--since", "30m")

        self.assertIn("gpu-box: unreachable (All connection attempts failed)", output)
        self.assertNotIn("hidden-box", output)
        self.assertNotIn("READ_ERRORS", output)
        self.assertIn("## Tunnel fix · local hub · folder AgentsDock · idle at the end", output)
        self.assertIn("「fix it」", output)
        self.assertIn("finished: Fixed.", output)

    def test_chat_without_user_messages_appears_only_with_agent_work_in_the_window(self):
        def chat(text_minutes_before_until):
            def respond(query):
                if query.get("visible") == "true":
                    return {"events": [{
                        "seq": 3, "type": "reasoning_summary", "ts": self.before_until(text_minutes_before_until),
                        "run_id": "run_a", "text": "Running shard 5",
                    }]}
                return {"events_omitted_before": 0, "events": [
                    {"seq": 1, "type": "turn_started", "ts": self.before_until(90), "run_id": "run_a", "prompt": "run tests", "purpose": None},
                ]}
            return respond

        self.responses.update({
            "/api/sessions": {"sessions": [
                {"id": "sess_working", "title": "Working", "latest_event_at": self.before_until(2)},
                {"id": "sess_quiet", "title": "Quiet", "latest_event_at": self.before_until(2)},
            ]},
            "/api/sessions/sess_working": chat(text_minutes_before_until=2),
            "/api/sessions/sess_quiet": chat(text_minutes_before_until=60),
        })

        output = self.run_digest("--since", "30m")

        self.assertIn("## Working · local hub · folder - · running at the end\nLatest model text: Running shard 5", output)
        self.assertNotIn("## Quiet", output)

    def test_a_long_chat_cannot_push_later_chats_out_of_the_output(self):
        long_events = [
            {"seq": seq, "type": "turn_started", "ts": self.before_until(29 - seq), "run_id": f"run_{seq}",
             "prompt": "很长的消息" * 200, "purpose": None}
            for seq in range(1, 25)
        ]
        self.responses.update({
            "/api/sessions": {"sessions": [
                {"id": "sess_long", "title": "Long", "latest_event_at": self.before_until(1)},
                {"id": "sess_short", "title": "Short", "latest_event_at": self.before_until(1)},
            ]},
            "/api/sessions/sess_long": {"events_omitted_before": 0, "events": long_events},
            "/api/sessions/sess_short": {"events_omitted_before": 0, "events": [
                {"seq": 1, "type": "turn_started", "ts": self.before_until(1), "run_id": "run_s", "prompt": "short one", "purpose": None},
            ]},
        })

        output = self.run_digest("--since", "30m")

        self.assertLessEqual(len(output.encode()), activity_digest.LIMITS["window"]["output_bytes"] + 1000)
        self.assertIn("more lines left out to fit the output limit", output)
        self.assertIn("「short one」", output)


if __name__ == "__main__":
    unittest.main()
