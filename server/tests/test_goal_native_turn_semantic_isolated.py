"""Every native turn of one Codex goal operation keeps its final answer on reload."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from tests.test_async_chat_timeline_index_isolated import load_index


def event(seq, kind, run_id, **fields):
    return {
        "id": f"event-{seq}", "seq": seq, "session_id": "chat", "run_id": run_id,
        "backend": "codex", "type": kind, "ts": f"2026-09-10T10:{seq // 60:02d}:{seq % 60:02d}Z",
        **fields,
    }


def goal(seq, kind, run_id, native=None, **fields):
    if native:
        fields["provider_turn_id"] = native
    return event(seq, kind, run_id, purpose="codex_goal_resume", **fields)


def final(seq, run_id, native, text):
    return goal(seq, "assistant_text", run_id, native, phase="final_answer", text=text)


def steer(seq, run_id, native, text):
    return goal(seq, "turn_steered", run_id, native, native_goal_steer=True, native_steer=True,
                provider_user_authored=True, prompt=text, queued_id=f"queued-{seq}")


GOAL = "codexgoal_monitor"
HANDOFF = "run_handoff"
EVENTS = [
    # Ordinary Codex run. Provider turn ids alone never split a non-goal run.
    event(1, "turn_started", "run_plain", prompt="Check the dashboard"),
    event(2, "reasoning_summary", "run_plain", phase="summary", text="Reading", provider_turn_id="p1"),
    event(3, "assistant_text", "run_plain", text="Interim note", provider_turn_id="p1"),
    event(4, "assistant_text", "run_plain", phase="final_answer", text="Dashboard is fine", provider_turn_id="p2"),
    event(5, "turn_finished", "run_plain", result_text="Dashboard is fine"),
    # Explicit goal resume: one AgentsDock run, one native turn per report.
    goal(10, "turn_started", GOAL, message="Resuming the persistent Codex goal."),
    goal(11, "reasoning_summary", GOAL, "t1", phase="commentary", text="Checking step 1"),
    goal(12, "tool_started", GOAL, "t1", tool="shell"),
    goal(13, "tool_finished", GOAL, "t1", tool="shell"),
    final(14, GOAL, "t1", "Report 1"),
    goal(20, "reasoning_summary", GOAL, "t2", phase="commentary", text="Checking step 2"),
    final(21, GOAL, "t2", "Report 2"),
    # A steer lands inside a running native turn and carries that turn's id.
    goal(25, "reasoning_summary", GOAL, "t3", phase="commentary", text="Checking step 3"),
    steer(30, GOAL, "t3", "Also plot the loss"),
    goal(31, "reasoning_summary", GOAL, "t3", phase="summary", text="Plotting"),
    final(32, GOAL, "t3", "Plot attached"),
    goal(40, "reasoning_summary", GOAL, "t4", phase="commentary", text="Checking step 4"),
    final(41, GOAL, "t4", "Report 4"),
    # Codex can continue the same native turn to a second final answer.
    goal(42, "reasoning_summary", GOAL, "t4", phase="summary", text="Pulling upstream"),
    final(43, GOAL, "t4", "Report 4 follow-up"),
    goal(50, "tool_started", GOAL, "t5", tool="shell"),
    final(51, GOAL, "t5", "Report 5"),
    goal(52, "turn_finished", GOAL, turn_id="t6", status="failed", message="Goal Resume failed."),
    # Ordinary turn handed off to goal continuation under the same run id.
    event(60, "turn_started", HANDOFF, prompt="/goal monitor training"),
    event(61, "reasoning_summary", HANDOFF, phase="summary", text="Setting up"),
    event(62, "assistant_text", HANDOFF, text="Monitoring is set up"),
    goal(70, "reasoning_summary", HANDOFF, "h1", phase="summary", text="Waiting"),
    final(71, HANDOFF, "h1", "Handoff report 1"),
    goal(80, "reasoning_summary", HANDOFF, "h2", phase="summary", text="Waiting"),
    final(81, HANDOFF, "h2", "Handoff report 2"),
    event(82, "turn_finished", HANDOFF, provider_turn_id="h2", result_text="Handoff report 2", stopped=True),
]
GOAL_ANSWERS = [14, 21, 32, 41, 43, 51]
HANDOFF_ANSWERS = [62, 71, 81]


class GoalNativeTurnSemanticTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="goal-native-turn-semantic-")
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "events.jsonl"
        self.write(EVENTS)
        self.ns = load_index(self.path)

    def write(self, events):
        self.path.write_text("".join(json.dumps(item) + "\n" for item in events), encoding="utf-8")

    def page(self, **kwargs):
        return self.ns["read_semantic_timeline_page"]("chat", **kwargs)

    def answers(self, events, run_id):
        return [
            item["seq"] for item in events
            if item["run_id"] == run_id and item["type"] == "assistant_text"
        ]

    def test_each_native_goal_turn_is_its_own_semantic_item(self):
        keys = [item["key"] for item in self.ns["_build_timeline_index_locked"]("chat")["landmarks"]]
        self.assertEqual(keys, [
            "turn:run_plain",
            f"turn:{GOAL}", f"turn:{GOAL}:start-20", f"turn:{GOAL}:start-25", f"turn:{GOAL}:start-30",
            f"turn:{GOAL}:start-40", f"turn:{GOAL}:start-42", f"turn:{GOAL}:start-50",
            f"turn:{HANDOFF}", f"turn:{HANDOFF}:start-70", f"turn:{HANDOFF}:start-80",
        ])
        events = self.page(limit=500)["events"]
        self.assertEqual(self.answers(events, GOAL), GOAL_ANSWERS)
        self.assertEqual(self.answers(events, HANDOFF), HANDOFF_ANSWERS)

    def test_narrow_after_window_and_backward_paging_keep_every_answer_once(self):
        # The reported reload window started at the steer and lost later reports.
        narrow = self.page(after=29, semantic_before=60, limit=500)["events"]
        self.assertEqual(self.answers(narrow, GOAL), [32, 41, 43, 51])
        seen, page = [], self.page(limit=2)
        seen.extend(page["events"])
        while page["next_semantic_before"]:
            page = self.page(semantic_before=page["next_semantic_before"], limit=2)
            seen.extend(page["events"])
        self.assertEqual(len(seen), len({item["id"] for item in seen}))
        self.assertEqual(sorted(self.answers(seen, GOAL)), GOAL_ANSWERS)
        self.assertEqual(sorted(self.answers(seen, HANDOFF)), HANDOFF_ANSWERS)

    def test_ordinary_run_output_is_unchanged(self):
        # Pinned from the pre-fix server: one item, same sampled events.
        ordinary = self.page(semantic_before=10, limit=500)
        self.assertEqual(ordinary["semantic_item_count"], 1)
        self.assertEqual([item["seq"] for item in ordinary["events"]], [1, 2, 4, 5])
        # Sharing a page with goal items only changes optional trace sampling;
        # the prompt, trace handle and final result always stay.
        full = {item["seq"] for item in self.page(limit=500)["events"] if item["run_id"] == "run_plain"}
        self.assertLessEqual({1, 2, 5}, full)

    def test_append_to_warm_index_matches_cold_reopen(self):
        self.write(EVENTS[:11])
        self.ns["_build_timeline_index_locked"]("chat")
        with self.path.open("a", encoding="utf-8") as target:
            for item in EVENTS[11:]:
                target.write(json.dumps(item) + "\n")
        warm = deepcopy(self.ns["_build_timeline_index_locked"]("chat"))
        warm_page = self.page(after=19, limit=500)
        self.ns["TIMELINE_INDEX_CACHE"].clear()
        self.assertEqual(self.ns["_build_timeline_index_locked"]("chat"), warm)
        self.assertEqual(self.page(after=19, limit=500), warm_page)
        self.assertEqual(self.answers(warm_page["events"], GOAL), [21, 32, 41, 43, 51])


if __name__ == "__main__":
    unittest.main()
