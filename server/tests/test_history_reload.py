"""Reload drops what history sync appended after the chat's first own turn, then syncs again."""

import json
from unittest.mock import AsyncMock, patch

import agent_server as server
from tests.test_session_rewind import RewindFixture


def row(seq: int, type_: str, run_id: str, **extra) -> dict:
    return {"seq": seq, "id": f"e{seq}", "type": type_, "run_id": run_id, "ts": f"2026-09-08T10:{seq:02d}:00Z", **extra}


class HistoryReloadTests(RewindFixture):
    def events(self):
        return [
            # The batch Resume created: the chat's beginning.
            row(1, "history_imported", "import_a", imported=True), row(2, "turn_started", "import_a", prompt="resumed", imported=True),
            row(3, "turn_finished", "import_a", imported=True),
            row(4, "turn_started", "first", prompt="asked here"), row(5, "assistant_text", "first", text="answer"),
            row(6, "turn_finished", "first", exit_code=0, result_text="answer"),
            # A sync re-imported the answer above, then another turn ran, then a sync added a card at the tail.
            row(7, "history_imported", "import_b", imported=True), row(8, "assistant_text", "import_b", text="answer", imported=True),
            row(9, "turn_finished", "import_b", imported=True),
            row(10, "turn_started", "second", prompt="again"), row(11, "turn_finished", "second", exit_code=0, result_text="ok"),
            row(12, "history_imported", "import_c", imported=True), row(13, "provider_interruption", "import_c", imported=True),
            row(14, "turn_finished", "import_c", imported=True),
        ]

    def test_rewind_and_reload_are_registered_routes(self) -> None:
        endpoints = {route.path: route.endpoint.__name__ for route in server.app.routes if hasattr(route, "endpoint")}
        self.assertEqual(endpoints["/api/sessions/{session_id}/rewind"], "rewind_session")
        self.assertEqual(endpoints["/api/sessions/{session_id}/history/reload"], "reload_session_history")

    async def test_reload_drops_synced_batches_keeps_the_resume_batch_and_syncs_again(self) -> None:
        sess = self.chat(latest_event_seq=14, latest_agent_event_seq=14, last_read_agent_event_seq=14, _history_sync_cursor={"version": 1})
        sync = AsyncMock(return_value={"imported": 0})
        with patch.object(server, "sync_provider_history", sync):
            result = await server.reload_session_history("chat")

        self.assertEqual(result["removed"], [{"from_seq": 7, "through_seq": 9}, {"from_seq": 12, "through_seq": 14}])
        self.assertEqual(result["session"]["id"], "chat")
        stored = self.stored_events()
        self.assertEqual([event["seq"] for event in stored if event["type"] != "_event_sequence_checkpoint"], [1, 2, 3, 4, 5, 6, 10, 11, 15, 16])
        self.assertEqual([event["type"] for event in stored][-3:], ["_event_sequence_checkpoint", "history_rewound", "history_rewound"])
        self.assertEqual(
            [(event["from_seq"], event["through_seq"], event["removed_events"], event["reason"]) for event in stored if event["type"] == "history_rewound"],
            [(7, 9, 3, "history_reload"), (12, 14, 3, "history_reload")],
        )
        self.assertNotIn("_history_sync_cursor", sess)
        self.assertEqual(sess["latest_event_seq"], 16)
        sync.assert_awaited_once()

    async def test_a_chat_with_no_own_turns_only_syncs_again(self) -> None:
        sess = self.chat(latest_event_seq=3, _history_sync_cursor={"version": 1})
        server.events_path("chat").write_text("".join(json.dumps({"session_id": "chat", **event}) + "\n" for event in self.events()[:3]), encoding="utf-8")
        sync = AsyncMock(return_value={"imported": 0})
        with patch.object(server, "sync_provider_history", sync):
            result = await server.reload_session_history("chat")

        self.assertEqual(result["removed"], [])
        self.assertEqual([event["seq"] for event in self.stored_events()], [1, 2, 3])
        self.assertNotIn("_history_sync_cursor", sess)
        sync.assert_awaited_once()
