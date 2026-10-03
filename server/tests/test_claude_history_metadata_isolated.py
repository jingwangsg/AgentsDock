"""Claude history projection checks without importing the server runtime."""

from __future__ import annotations

import ast
from collections import deque
from datetime import datetime
import hashlib
import hmac
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock
from claude_history_provenance import ClaudeInterruptionTracker


SOURCE = (Path(__file__).resolve().parents[1] / "agent_server.py")
FUNCTIONS = {
    "compact_import_text",
    "is_import_boilerplate",
    "text_from_content",
    "message_text",
    "normalized_history_item",
    "normalized_history_provider_origin",
    "add_history_item",
    "normalized_history_import_limit",
    "claude_history_event_is_task_notification",
    "is_claude_task_notification_history_event",
    "claude_history_event_item",
    "append_claude_history_event",
    "parse_claude_history_events",
    "claude_transcript_preview",
    "history_item_cursor_digest",
    "history_dedup_key",
    "parse_provider_history_delta",
}
CONSTANTS = {
    "CLAUDE_TASK_NOTIFICATION_ORIGIN",
    "CLAUDE_TASK_NOTIFICATION_PROMPT_SOURCES",
    "CLAUDE_TASK_NOTIFICATION_RE",
}


def load_projection() -> dict:
    """Compile only explicit pure helpers; no server imports or module startup."""

    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    selected = []
    found_functions = set()
    found_constants = set()
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            selected.append(node)
            found_functions.add(node.name)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if names and names <= CONSTANTS:
                selected.append(node)
                found_constants.update(names)
    if found_functions != FUNCTIONS or found_constants != CONSTANTS:
        raise AssertionError("The isolated history helper allowlist is incomplete")
    annotations = ast.ImportFrom(
        module="__future__", names=[ast.alias(name="annotations")], level=0
    )
    module = ast.fix_missing_locations(ast.Module(body=[annotations, *selected], type_ignores=[]))
    namespace = {
        "re": re,
        "datetime": datetime,
        "ClaudeInterruptionTracker": ClaudeInterruptionTracker,
        "json": json,
        "hashlib": hashlib,
        "hmac": hmac,
        "deque": deque,
        "MAX_IMPORTED_TEXT_CHARS": 100_000,
        "MAX_IMPORT_MESSAGES": 400,
        "CLAUDE_TRANSCRIPT_CWD_LINE_BYTES": 4 * 1024 * 1024,
        "BACKEND_CLAUDE": "claude",
        "BACKEND_CODEX": "codex",
        # Authority-envelope stripping is unrelated to metadata classification.
        "strip_agentsdock_generated_user_text": Mock(side_effect=lambda text, **_kwargs: text),
    }
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace


COMMAND = "<command-message>example-skill</command-message>\n<command-name>/example-skill</command-name>"
REFERENCE = "Base directory for this skill: /example/skills/example-skill\n\n# Skill reference"


def user_event(text: str, **metadata) -> dict:
    return {"type": "user", "message": {"role": "user", "content": text}, **metadata}


class ClaudeHistoryMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.projection = load_projection()

    def setUp(self) -> None:
        self.projection["strip_agentsdock_generated_user_text"].reset_mock()

    def item(self, event: dict):
        return self.projection["claude_history_event_item"](event)

    def test_generated_command_and_skill_reference_are_not_user_turns(self) -> None:
        events = [
            user_event(COMMAND, isMeta=True),
            {
                "type": "user", "isMeta": True,
                "message": {"role": "user", "content": [{"type": "text", "text": REFERENCE}]},
            },
        ]
        for event in events:
            with self.subTest(content=event["message"]["content"]):
                before = json.dumps(event, sort_keys=True)
                self.assertIsNone(self.item(event))
                self.assertEqual(json.dumps(event, sort_keys=True), before)
        self.projection["strip_agentsdock_generated_user_text"].assert_not_called()

    def test_user_quotes_and_untyped_metadata_remain_visible(self) -> None:
        for text in (COMMAND, REFERENCE, "Please explain this wrapper:\n" + COMMAND):
            for metadata in ({}, {"isMeta": False}, {"isMeta": "true"}, {"isMeta": 1}, {"origin": {"kind": "human"}}):
                with self.subTest(text=text, metadata=metadata):
                    self.assertEqual(self.item(user_event(text, **metadata)), {"kind": "user", "text": text})

    def test_compact_summary_flag_not_summary_wording_decides_user_origin(self) -> None:
        text = "This session is being continued from a previous conversation. Summary: a real user may quote this."
        self.assertIsNone(self.item(user_event(text, isCompactSummary=True)))
        for flag in (None, False, "true", 1):
            self.assertEqual(self.item(user_event(text, isCompactSummary=flag)), {"kind": "user", "text": text})

    def test_sidechain_scope_is_not_parent_user_input_but_marker_quotes_remain(self) -> None:
        marker = "[Request interrupted by user for tool use]"
        self.assertIsNone(self.item(user_event(marker, isSidechain=True)))
        self.assertIsNone(self.item({"type": "assistant", "isSidechain": True, "message": {"content": "Child output"}}))
        for flag in (None, False, "true", 1):
            self.assertEqual(self.item(user_event(marker, isSidechain=flag)), {"kind": "user", "text": marker})

    def test_assistant_text_and_non_user_events_are_unchanged(self) -> None:
        self.assertEqual(self.item({
            "type": "assistant", "isMeta": True,
            "message": {"content": COMMAND},
        }), {"kind": "assistant", "text": COMMAND})
        self.assertIsNone(self.item({"type": "system", "message": {"content": REFERENCE}}))

    def test_existing_task_notification_filter_remains_effective(self) -> None:
        self.assertIsNone(self.item(user_event(
            "Provider task completed", origin={"kind": "task-notification"},
        )))
        self.assertEqual(self.item(user_event(
            "Provider task completed", origin={"kind": "human"},
        )), {"kind": "user", "text": "Provider task completed"})

    def test_full_parser_omits_metadata_without_consuming_message_limit(self) -> None:
        events = [
            user_event("Actual request"),
            user_event(COMMAND, isMeta=True),
            user_event(REFERENCE, isMeta=True),
            {"type": "assistant", "message": {"content": "Actual answer"}},
        ]
        self.assertEqual(self.projection["parse_claude_history_events"](events, 2), [
            {"kind": "user", "text": "Actual request"},
            {"kind": "assistant", "text": "Actual answer"},
        ])

    def test_slash_command_rows_read_as_the_command_and_their_local_output_is_omitted(self) -> None:
        wrapper = ("<command-name>/review</command-name>\n            <command-message>review</command-message>\n"
                   "            <command-args> staged files </command-args>")
        events = [
            user_event("Actual request"),
            {"type": "assistant", "message": {"content": "Actual answer"}},
            user_event(wrapper, uuid="cmd-1", sessionId="s-1"),
            user_event("<local-command-stdout>Review queued</local-command-stdout>", uuid="out-1", parentUuid="cmd-1", sessionId="s-1"),
            user_event("<local-command-stderr>Denied</local-command-stderr>", uuid="out-2", parentUuid="cmd-1", sessionId="s-1"),
            user_event("Next request"),
        ]
        self.assertEqual(self.projection["parse_claude_history_events"](events, None), [
            {"kind": "user", "text": "Actual request"},
            {"kind": "assistant", "text": "Actual answer"},
            {"kind": "user", "text": "/review staged files"},
            {"kind": "user", "text": "Next request"},
        ])
        # Custom commands and skills are stored message-first, sometimes without args.
        for text, command in (
            ("<command-message>paper-research</command-message>\n<command-name>/paper-research</command-name>\n"
             "<command-args>read: paper.pdf</command-args>", "/paper-research read: paper.pdf"),
            ("<command-message>echo-test</command-message>\n<command-name>/echo-test</command-name>", "/echo-test"),
        ):
            self.assertEqual(self.projection["parse_claude_history_events"]([user_event(text)], None), [{"kind": "user", "text": command}])

    def test_local_output_without_its_wrapper_parent_stays_as_submitted(self) -> None:
        wrapper = "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"
        output = "<local-command-stdout>Compacted </local-command-stdout>"
        for events in (
            [user_event(output, uuid="out-1", parentUuid="cmd-1", sessionId="s-1")],
            [user_event(wrapper, uuid="cmd-1", sessionId="s-1"), user_event(output, uuid="out-1", parentUuid="cmd-1", sessionId="s-2")],
            [user_event(wrapper, uuid="cmd-1", sessionId="s-1"), user_event(output, uuid="out-1", parentUuid="other", sessionId="s-1")],
        ):
            with self.subTest(events=events):
                self.assertEqual(self.projection["parse_claude_history_events"](events, None)[-1], {"kind": "user", "text": output})
        quoted = "Claude printed:\n" + wrapper
        self.assertEqual(self.projection["parse_claude_history_events"]([user_event(quoted)], None), [{"kind": "user", "text": quoted}])

    def test_delta_finds_the_wrapper_written_before_its_cursor(self) -> None:
        wrapper = user_event("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
                             uuid="cmd-1", sessionId="s-1")
        output = user_event("<local-command-stdout>Compacted </local-command-stdout>", uuid="out-1", parentUuid="cmd-1", sessionId="s-1")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transcript.jsonl"
            first = json.dumps(wrapper).encode("utf-8") + b"\n"
            path.write_bytes(first + json.dumps(output).encode("utf-8") + b"\n")
            end = path.stat().st_size
            self.projection["bounded_jsonl_records_range"] = Mock(return_value=iter([(output, end)]))
            self.assertEqual(self.projection["parse_provider_history_delta"](
                path, "claude", len(first), end, limit=None,
                expected_stat={}, previous_last_item_digest="previous",
            ), ([], end, "previous", False))

    def test_preview_skips_generated_skill_context(self) -> None:
        events = [user_event(COMMAND, isMeta=True), user_event(REFERENCE, isMeta=True), user_event("Real preview")]
        region = b"\n".join(json.dumps(event).encode("utf-8") for event in events) + b"\n"
        self.projection["bounded_claude_transcript_regions"] = Mock(return_value=iter([region]))
        self.assertEqual(self.projection["claude_transcript_preview"](Path("unused.jsonl")), "Real preview")

    def test_delta_consumes_metadata_and_preserves_next_unseen_user(self) -> None:
        records = [
            (user_event(COMMAND, isMeta=True), 10),
            (user_event("First request"), 20),
            (user_event(REFERENCE, isMeta=True), 30),
            (user_event("Next request"), 40),
        ]
        self.projection["bounded_jsonl_records_range"] = Mock(return_value=iter(records))
        items, offset, digest, blocked = self.projection["parse_provider_history_delta"](
            Path("unused.jsonl"), "claude", 0, 40, limit=1,
            expected_stat={}, previous_last_item_digest="",
        )
        self.assertEqual(items, [{"kind": "user", "text": "First request"}])
        self.assertEqual(offset, 30)
        self.assertEqual(digest, self.projection["history_item_cursor_digest"](items[0]))
        self.assertTrue(blocked)

    def test_metadata_only_delta_advances_cursor_without_changing_digest(self) -> None:
        self.projection["bounded_jsonl_records_range"] = Mock(return_value=iter([
            (user_event(COMMAND, isMeta=True), 10),
            (user_event(REFERENCE, isMeta=True), 20),
        ]))
        self.assertEqual(self.projection["parse_provider_history_delta"](
            Path("unused.jsonl"), "claude", 0, 20, limit=1,
            expected_stat={}, previous_last_item_digest="previous",
        ), ([], 20, "previous", False))


if __name__ == "__main__":
    unittest.main()
