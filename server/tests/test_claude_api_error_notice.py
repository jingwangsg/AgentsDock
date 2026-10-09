"""A Claude API error frame mid-turn is a notice, not the turn's failure."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from claude_agent_sdk.types import AssistantMessage, TextBlock

import agent_server


class ApiErrorFrameTest(unittest.TestCase):
    def test_an_api_error_frame_adds_no_error_event(self) -> None:
        # 2026-10-09: a turn kept running for hours after "API Error: The response stopped
        # arriving", but its error event kept the desktop composer on "Latest chat error".
        append_event = AsyncMock()
        message = AssistantMessage(
            content=[TextBlock(text="API Error: The response stopped arriving. The response above may be incomplete.")],
            model="claude-test",
            error="server_error",
        )
        text_parts: list[str] = []
        with patch.object(agent_server, "append_event", append_event):
            asyncio.run(agent_server.project_claude_sdk_message(
                "chat", "run", message, text_parts=text_parts, current_tools={}, changed_paths=set(),
            ))
        projected = [(call.args[1], call.args[2]) for call in append_event.await_args_list]
        self.assertEqual([kind for kind, _payload in projected], ["reasoning_summary"])
        self.assertTrue(projected[0][1]["text"].startswith("API Error: The response stopped arriving"))
        self.assertEqual(len(text_parts), 1)


if __name__ == "__main__":
    unittest.main()
