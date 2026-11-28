"""Both side chat entry points against a carrier that exists only here.

The composer's Side chat and Canvas comment threads reach a backend through side_questions.SideChatCarrier and
the server's SIDE_CHAT_CARRIERS alone. A backend that registers a carrier therefore needs nothing else: these
tests register one for a backend the server does not know and use nothing but the entry points.
"""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent_server as server
from side_questions import SideChatCarrier, SideQuestionError, SyncedSideChats


class Carrier(SideChatCarrier):
    """Keeps its side conversation, as a native fork would, and can wait for an approval."""

    approvals = True
    made: list["Carrier"] = []

    @staticmethod
    def provider_id(session):
        return str(session.get("fake_session_id") or "")

    @classmethod
    def available(cls, session, question, *, edit):
        return bool(cls.provider_id(session)) and (not edit or session.get("fake_edits") is True)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.asked, self.closed, self.conversation = [], 0, self.saved_state
        Carrier.made.append(self)

    def lacks(self, history, *, edit=False):
        return bool(history) and self.conversation is None

    async def ask(self, question, *, history, edit=False, on_step=None):
        self.asked.append((question, history, edit))
        self.conversation = self.conversation or {"side": f"conversation of {self.binding['parent_id']}"}
        await self.save_state(self.conversation)
        if on_step is not None:
            await on_step({"id": "step-1", "kind": "tool", "title": "look", "status": "completed"})
        if question.endswith("hold"):
            await asyncio.Event().wait()  # as a run that waits for an approval nobody gives
        return {"answer": f"answer {len(self.asked)}", "context_note": "Fake context"}

    async def close(self):
        self.closed += 1


class SideChatCarrierTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.chat = {"id": "chat", "backend": "fake", "fake_session_id": "parent-1"}
        self.enterContext(patch.dict(server.SIDE_CHAT_CARRIERS, {"fake": Carrier}))
        self.enterContext(patch.dict(server.STORE.sessions, {"chat": self.chat}))
        self.enterContext(patch.object(Carrier, "made", []))

    def comment(self, mode, body):
        anchor = {"canvas_id": "summary", "tag": "td", "text": "loss 2.41", "html": ""}
        return server.agentsdock_canvas.comment_prompt(self.root / "report.canvas.tsx", 7, anchor, mode, body, follow_up=False)[0]

    async def test_the_capability_lists_a_composer_carrier_while_it_is_usable(self):
        async def listed():
            with patch.object(server, "working_tmux_bin", return_value=None):
                return "fake" in (await server.health())["capabilities"]["side_questions"]["backends"]

        self.assertTrue(await listed())
        with patch.object(Carrier, "usable", staticmethod(lambda: False)):
            self.assertFalse(await listed())
        with patch.object(Carrier, "composer", False):
            self.assertFalse(await listed())

    async def test_the_composers_side_chat_keeps_one_carrier_for_the_conversation_and_closes_it_when_it_ends(self):
        key = ("owner", "chat")
        chats = SyncedSideChats(self.root / "side.sqlite3", native_factory=server.create_native_side_chat)
        self.addAsyncCleanup(chats.close)
        side_chat = (await chats.snapshot(*key))["side_chat_id"]

        async def answered(request_id, question, after):
            await chats.submit(*key, request_id, question, side_chat, after)
            await asyncio.gather(chats.tasks[key], return_exceptions=True)
            return (await chats.snapshot(*key))["exchanges"][-1]

        first = await answered("one", "which?", None)
        self.assertEqual([first[field] for field in ("status", "backend", "answer", "context_note")], ["completed", "fake", "answer 1", "Fake context"])
        # A step that any carrier reports is recorded with the exchange.
        self.assertEqual([step["title"] for step in first["steps"]], ["look"])
        await answered("two", "and then?", "one")
        (carrier,) = Carrier.made
        # The carrier keeps the conversation, so the follow-up reaches it as typed, with the exchanges so far.
        self.assertEqual(carrier.asked, [("which?", [], False), ("and then?", [{"question": "which?", "response": "answer 1"}], False)])
        self.assertEqual((carrier.durable, carrier.closed), (True, 0))
        # A stopped message: the task that awaits `ask` is cancelled, then the carrier is closed.
        await chats.submit(*key, "three", "hold", side_chat, "two")
        while len(carrier.asked) < 3:
            await asyncio.sleep(0.01)
        self.assertEqual((await chats.cancel(*key, "three"))["exchanges"][-1]["status"], "cancelled")
        self.assertEqual(carrier.closed, 1)
        # The next message gets a new carrier with what the closed one saved: it takes the conversation up again.
        await answered("four", "still there?", "three")
        self.assertEqual((len(Carrier.made), Carrier.made[1].saved_state), (2, {"side": "conversation of parent-1"}))
        self.assertEqual(Carrier.made[1].asked[0][0], "still there?")
        # Clear ends the conversation: the carrier is closed, and the next one starts with nothing saved.
        side_chat = (await chats.clear(*key, side_chat))["side_chat_id"]
        self.assertEqual(Carrier.made[1].closed, 1)
        await answered("five", "again?", None)
        self.assertEqual((len(Carrier.made), Carrier.made[2].saved_state), (3, None))
        # The chat's provider conversation is another one now: the side conversation ends instead of answering.
        self.chat["fake_session_id"] = "parent-2"
        refused = await answered("six", "stale?", "five")
        self.assertEqual((refused["status"], refused["error"], len(Carrier.made[2].asked)), ("failed", "side_question_http_410", 1))

    async def test_a_canvas_comment_asks_the_carrier_whether_and_how_it_can_answer(self):
        history = [{"question": "Question: why?", "response": "Because."}]
        earlier = "Earlier question in this comment thread:\nQuestion: why?\n\nIts answer:\nBecause.\n\n"
        question, edit = self.comment("ask", "which one?"), self.comment("edit", "shorten it")
        available = lambda prompt: server.canvas_comment_side_chat_available("chat", prompt)
        # The carrier decides per mode, for the chat as it is; a backend without a carrier starts a turn.
        self.assertEqual((available(question), available(edit)), (True, False))
        self.chat["fake_edits"] = True
        self.assertTrue(available(edit))
        with patch.dict(self.chat, {"fake_session_id": ""}):
            self.assertFalse(available(question))
        with patch.dict(self.chat, {"backend": "unknown"}):
            self.assertFalse(available(question))
        # Every comment gets a new carrier that is told the mode. The store's saved state is not passed on, so
        # the carrier starts from the chat alone and the thread's earlier exchanges are in the question.
        for prompt in (question, edit):
            handle = await server.create_canvas_comment_side_chat("chat", persisted_state={"fake": {"old": 1}}, durable=True)
            self.assertEqual((await handle.ask(prompt, history=history))["answer"], "answer 1")
            await handle.close()
        self.assertEqual([(carrier.asked, carrier.durable, carrier.saved_state, carrier.closed) for carrier in Carrier.made], [
            ([(earlier + question, [], False)], False, None, 1), ([(earlier + edit, [], True)], False, None, 1)])
        # A carrier that can wait for an approval is bounded, so an unanswered one frees the Canvas file.
        with patch.object(server, "CANVAS_COMMENT_SIDE_CHAT_SECONDS", 0.05), self.assertRaises(TimeoutError):
            await (await server.create_canvas_comment_side_chat("chat")).ask(self.comment("edit", "hold"), history=[])
        self.assertEqual(len(server.CANVAS_EDIT_LOCKS), 0)
        # A carrier for Canvas comments only: the composer's Side chat refuses it, a comment thread does not.
        with patch.object(Carrier, "composer", False):
            with self.assertRaises(SideQuestionError) as refused:
                await server.create_native_side_chat("chat")
            self.assertEqual(refused.exception.status_code, 503)
            await (await server.create_canvas_comment_side_chat("chat")).ask(question, history=[])


if __name__ == "__main__":
    unittest.main()
