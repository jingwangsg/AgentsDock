import tempfile
import unittest
from pathlib import Path

import agent_server


class ToolOutputTextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_state_dir = agent_server.STATE_DIR
        agent_server.STATE_DIR = Path(self.temporary.name)

    def tearDown(self) -> None:
        agent_server.STATE_DIR = self.previous_state_dir
        self.temporary.cleanup()

    def test_mcp_tool_result_egresses_as_its_text_not_the_json_envelope(self) -> None:
        # Codex stores an MCP call result verbatim: {content, structuredContent, _meta}.
        event = {
            "id": "event-1",
            "session_id": "mcp-output-chat",
            "seq": 1,
            "type": "tool_finished",
            "ts": "2026-10-03T00:00:01Z",
            "tool": {"name": "_agentsdock_internal_provider_0000/run"},
            "output": {
                "content": [{"type": "text", "text": '{\n  "jobs": []\n}'}],
                "structuredContent": None,
                "_meta": {},
            },
        }
        self.assertEqual(agent_server.client_safe_event(event)["output"], '{\n  "jobs": []\n}')

    def test_mcp_tool_result_joins_text_blocks_and_marks_images(self) -> None:
        output = agent_server.event_output_text({
            "content": [
                {"type": "text", "text": "first"},
                {"type": "image", "data": "...", "mimeType": "image/png"},
                {"type": "text", "text": "second"},
            ],
        })
        self.assertEqual(output, "first\n[image result]\nsecond")

    def test_mcp_tool_result_with_only_structured_content_keeps_its_data(self) -> None:
        output = agent_server.event_output_text({
            "content": [],
            "structuredContent": {"jobs": [{"id": "job_1"}]},
        })
        self.assertEqual(output, "jobs:\n  - id: job_1")

    def test_mcp_status_text_is_followed_by_the_structured_payload(self) -> None:
        # Codex connector apps answer "Action completed." and put the data in structuredContent.
        output = agent_server.event_output_text({
            "content": [{"type": "text", "text": "Action completed."}],
            "structuredContent": {"file_id": "F1", "title": "image.png"},
        })
        self.assertEqual(output, "Action completed.\nfile_id: F1\ntitle: image.png")

    def test_mcp_text_that_already_serialises_the_structured_payload_is_not_repeated(self) -> None:
        output = agent_server.event_output_text({
            "content": [{"type": "text", "text": '{"a": 1}'}],
            "structuredContent": {"a": 1},
        })
        self.assertEqual(output, '{"a": 1}')

    def test_mcp_structured_payload_that_is_itself_a_tool_result_shows_its_text(self) -> None:
        output = agent_server.event_output_text({
            "content": [{"type": "text", "text": "Action completed."}],
            "structuredContent": {
                "meta": None,
                "content": [{"type": "text", "text": '{"plugins": []}'}],
                "structuredContent": None,
                "isError": False,
            },
        })
        self.assertEqual(output, 'Action completed.\n{"plugins": []}')


    def test_codex_file_change_list_reads_as_a_patch(self) -> None:
        output = agent_server.event_output_text([
            {"path": "src/a.ts", "kind": {"type": "update", "move_path": None}, "diff": "@@ -1 +1 @@\n-old\n+new"},
            {"path": "src/b.ts", "kind": {"type": "add"}, "diff": "export const b = 1\n"},
            {"path": "src/c.ts", "kind": {"type": "delete"}, "diff": "gone"},
        ])
        self.assertEqual(
            output,
            "*** Update File: src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n"
            "*** Add File: src/b.ts\nexport const b = 1\n\n"
            "*** Delete File: src/c.ts\ngone",
        )

    def test_codex_file_change_move_names_the_destination(self) -> None:
        output = agent_server.event_output_text([
            {"path": "old.md", "kind": {"type": "update", "move_path": "new.md"}, "diff": "@@ -1 +1 @@\n-a\n+b"},
        ])
        self.assertEqual(output, "*** Update File: old.md\n*** Move to: new.md\n@@ -1 +1 @@\n-a\n+b")

    def test_codex_web_search_actions_read_as_sentences(self) -> None:
        self.assertEqual(
            agent_server.event_output_text({"type": "search", "query": None, "queries": ["uscis policy manual"]}),
            "Searched the web for: uscis policy manual",
        )
        self.assertEqual(
            agent_server.event_output_text({"type": "search", "query": None, "queries": ["first", "second"]}),
            "Searched the web for:\n  first\n  second",
        )
        self.assertEqual(
            agent_server.event_output_text({"type": "openPage", "url": "https://example.com/a"}),
            "Opened page: https://example.com/a",
        )
        self.assertEqual(
            agent_server.event_output_text({"type": "findInPage", "url": "https://example.com/a", "pattern": "TEMPLATE"}),
            "Searched page https://example.com/a for: TEMPLATE",
        )
        self.assertEqual(agent_server.event_output_text({"type": "other"}), "Web search")

    def test_other_dicts_read_as_indented_key_value_lines(self) -> None:
        self.assertEqual(
            agent_server.event_output_text({"type": "search", "results": [1]}),
            "type: search\nresults:\n  - 1",
        )
        self.assertEqual(
            agent_server.readable_structured_text({
                "items": [{"id": 1, "tags": ["a", "b"], "meta": {}}, {"id": 2, "note": "line 1\nline 2"}],
                "ok": True,
                "missing": None,
            }),
            "items:\n  - id: 1\n    tags:\n      - a\n      - b\n    meta: {}\n  - id: 2\n    note:\n      line 1\n      line 2\nok: true\nmissing: null",
        )

if __name__ == "__main__":
    unittest.main()
