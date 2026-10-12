"""Exercise the activity digest on synthetic events and a fake hub, never a live server."""
import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from zoneinfo import ZoneInfo

from scripts import activity_digest


SHANGHAI = ZoneInfo("Asia/Shanghai")
SINCE = datetime(2026, 10, 12, 19, 30, tzinfo=timezone.utc)
UNTIL = SINCE + timedelta(minutes=30)


def event(seq, kind, minute, **fields):
    """An event `minute` minutes after SINCE (negative: before the window)."""
    ts = (SINCE + timedelta(minutes=minute)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"seq": seq, "type": kind, "ts": ts, **fields}


class SummarizeChatTests(unittest.TestCase):
    def summarize(self, events, last_minute=29):
        return activity_digest.summarize_chat(events, SINCE, UNTIL, SINCE + timedelta(minutes=last_minute))

    def test_user_words_are_typed_queued_and_steered_messages(self):
        digest = self.summarize([
            event(1, "turn_started", 1, run_id="run_a", prompt="fix the tunnel", purpose=None),
            event(2, "turn_queued", 2, queued_id="queued_s", prompt="also the logs", purpose=None),
            event(3, "turn_steered", 2, run_id="run_a", queued_id="queued_s", prompt="also the logs"),
            event(4, "turn_queued", 3, queued_id="queued_q", prompt="then the dev log", purpose=None),
            event(5, "turn_queue_updated", 4, queued_id="queued_q", prompt="then the DEV_LOG"),
            event(6, "turn_finished", 10, run_id="run_a", result_text="Fixed both."),
            # The queued message runs later; it was already counted when queued.
            event(7, "turn_started", 10, run_id="run_b", prompt="then the DEV_LOG", queued_id="queued_q", purpose=None),
        ])

        self.assertEqual(
            [word["text"] for word in digest["words"]],
            ["fix the tunnel", "also the logs", "then the DEV_LOG"],
        )
        self.assertEqual(digest["words"][1]["run"]["result"], "Fixed both.")
        self.assertTrue(digest["words"][2]["run"]["running"])
        self.assertTrue(digest["running"])

    def test_agent_turns_and_imported_rows_are_not_user_words(self):
        digest = self.summarize([
            event(1, "turn_started", 1, run_id="run_job", prompt="check the queue", purpose="scheduled_job", job_title="Hourly check"),
            event(2, "turn_finished", 2, run_id="run_job", result_text="Queue empty."),
            event(3, "chat_conversation_message_received", 3, source_title="main thread", handoff_preview="Please merge"),
            event(4, "turn_started", 3, run_id="run_wake", prompt="", purpose="chat_mailbox_wake"),
            event(5, "turn_finished", 5, run_id="run_wake", result_text="Merged."),
            event(6, "turn_started", 6, run_id="import_1", prompt="typed in the CLI", imported=True),
        ], last_minute=6)

        self.assertEqual(digest["words"], [])
        self.assertEqual([run["purpose"] for run in digest["agent_runs"]], ["scheduled_job", "chat_mailbox_wake"])
        self.assertEqual(digest["mail"][0][1], "main thread")
        self.assertFalse(digest["running"])

    def test_run_without_turn_finished_ends_at_the_next_turn(self):
        digest = self.summarize([
            event(1, "turn_started", -50, run_id="run_lost", prompt="earlier", purpose=None),
            event(2, "turn_started", -40, run_id="run_next", prompt="later", purpose=None),
            event(3, "turn_finished", -35, run_id="run_next", result_text="Done."),
        ])

        # Both runs ended before the window: nothing is active in it.
        self.assertEqual(digest["active"], [])
        self.assertEqual(
            activity_digest.outcome(self.summarize([
                event(1, "turn_started", 1, run_id="run_lost", prompt="earlier", purpose=None),
                event(2, "turn_started", 5, run_id="run_next", prompt="later", purpose=None),
            ])["words"][0]["run"], SHANGHAI, 100),
            "ended without a recorded result",
        )

    def test_run_started_before_the_window_and_still_running_is_active(self):
        digest = self.summarize([
            event(1, "assistant_text", -90, run_id="run_long", text="Working on shard 5"),
        ])

        self.assertEqual(len(digest["active"]), 1)
        self.assertTrue(digest["running"])
        self.assertEqual(digest["words"], [])


class WindowBoundsTests(unittest.TestCase):
    def bounds(self, now, **values):
        args = argparse.Namespace(since=values.get("since"), day=values.get("day"))
        return activity_digest.window_bounds(args, now, SHANGHAI)

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

    def test_since_ends_now(self):
        self.assertEqual(self.bounds(UNTIL, since="30m"), (SINCE, UNTIL, "window"))


class DigestOutputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="activity-digest-")
        self.addCleanup(temporary.cleanup)
        self.env_file = Path(temporary.name) / "env"
        self.env_file.write_text("export AGENTSDOCK_AGENT_TOKEN=test-token\nexport AGENTSDOCK_AGENT_PORT=1\n")
        self.now = datetime.now(timezone.utc)
        self.responses = {}

    def iso(self, minutes_ago):
        return (self.now - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def run_digest(self, *args):
        def fake_get(hub, path, **query):
            response = self.responses[path]
            if isinstance(response, Exception):
                raise response
            return response

        output = io.StringIO()
        argv = ["activity_digest.py", "--env-file", str(self.env_file), *args]
        with mock.patch.object(activity_digest.Hub, "get", fake_get), \
                mock.patch("sys.argv", argv), contextlib.redirect_stdout(output):
            self.assertEqual(activity_digest.main(), 0)
        return output.getvalue()

    def test_idle_window_prints_only_the_no_activity_marker(self):
        self.responses = {
            "/api/admin/remote-servers": {"servers": []},
            "/api/sessions": {"sessions": [
                {"id": "sess_old", "title": "Old", "latest_event_at": self.iso(90)},
                {"id": "sess_digest", "title": "Digest", "latest_event_at": self.iso(1)},
            ]},
        }

        output = self.run_digest("--since", "30m", "--exclude", "sess_digest")

        self.assertIn("NO_ACTIVITY", output)
        self.assertNotIn("## ", output)

    def test_unreachable_remote_is_one_line_and_local_chats_still_appear(self):
        self.responses = {
            "/api/admin/remote-servers": {"servers": [
                {"id": "r1", "name": "gpu-box", "hidden": False},
                {"id": "r2", "name": "hidden-box", "hidden": True},
            ]},
            "/api/remote/r1/api/sessions": OSError("All connection attempts failed"),
            "/api/sessions": {"sessions": [
                {"id": "sess_a", "title": "Tunnel fix", "folder": "AgentsDock", "backend": "claude", "latest_event_at": self.iso(5)},
            ]},
            "/api/sessions/sess_a": {"events_omitted_before": 0, "events": [
                {"seq": 1, "type": "turn_started", "ts": self.iso(10), "run_id": "run_a", "prompt": "fix it, token=abc123", "purpose": None},
                {"seq": 2, "type": "turn_finished", "ts": self.iso(5), "run_id": "run_a", "result_text": "Fixed."},
            ]},
        }

        output = self.run_digest("--since", "30m")

        self.assertIn("gpu-box: unreachable (All connection attempts failed)", output)
        self.assertNotIn("hidden-box", output)
        self.assertIn("## Tunnel fix · local hub · folder AgentsDock", output)
        self.assertIn("「fix it, [redacted]」", output)
        self.assertIn("finished: Fixed.", output)


if __name__ == "__main__":
    unittest.main()
