"""Cross-server chat mail: the hub relays only what its pair registry links."""
import sqlite3
import unittest
from datetime import datetime, timedelta, timezone

import chat_mailbox
import cross_server_mail as xs

PAIR = "pair_" + "1" * 32
HUB_ROUTE = "route_" + "a" * 32
REMOTE_ROUTE = "route_" + "b" * 32
MESSAGE = "handoff_" + "c" * 32


def ledger() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("""CREATE TABLE cross_chat_envelopes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_session_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        source_user_instruction TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL,
        authorization_kind TEXT NOT NULL DEFAULT 'explicit_prompt', authorization_route_id TEXT,
        authorization_pair_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, target_run_id TEXT,
        delivery_mode TEXT NOT NULL DEFAULT '', reply_to_message_id TEXT, target_body TEXT,
        message_revision INTEGER NOT NULL DEFAULT 0, source_user_delegation_action TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '', attachments_json TEXT)""")
    chat_mailbox.initialize(connection)
    xs.initialize(connection)
    return connection


def mail(**overrides) -> dict:
    return {
        "id": MESSAGE, "message_id": MESSAGE, "kind": "mail", "pair_id": PAIR, "route_id": HUB_ROUTE,
        "source_session_id": "sess_hub", "source_title": "Hub chat", "source_run_id": "run_1",
        "idempotency_key": "key-00001", "target_server_identity": "srv-remote", "target_session_id": "sess_remote",
        "body": "Which features need to come back?", "reply_to_message_id": None, **overrides,
    }


class StorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = ledger()

    def test_a_route_install_is_idempotent_and_gets_the_next_free_alias(self) -> None:
        route = {"route_id": HUB_ROUTE, "pair_id": PAIR, "session_id": "sess_hub", "peer_server_identity": "srv-remote",
                 "peer_server_name": "osmo_dev_l40", "peer_session_id": "sess_remote", "peer_title": "Launch"}
        first = xs.install_route(self.db, route)
        self.assertEqual(first["alias"], "remote1")
        self.assertEqual(xs.install_route(self.db, route)["created_at"], first["created_at"])
        with self.assertRaises(xs.Refused):
            xs.install_route(self.db, {**route, "route_id": REMOTE_ROUTE})
        other = xs.install_route(self.db, {**route, "route_id": REMOTE_ROUTE, "pair_id": "pair_" + "2" * 32})
        self.assertEqual(other["alias"], "remote2")
        # Pairing again refreshes the peer's label, which delegation matches against.
        renamed = xs.install_route(self.db, {**route, "peer_title": "Launch v2", "peer_server_name": "osmo_dev_h100"})
        self.assertEqual((renamed["peer_title"], renamed["peer_server_name"]), ("Launch v2", "osmo_dev_h100"))
        self.assertEqual(xs.routes(self.db)[0]["peer_title"], "Launch v2")

    def test_a_retried_send_returns_the_first_message_and_a_reused_key_with_new_text_is_refused(self) -> None:
        item, created = xs.enqueue(self.db, mail())
        self.assertTrue(created)
        again, created = xs.enqueue(self.db, mail())
        self.assertFalse(created)
        self.assertEqual(again["id"], item["id"])
        with self.assertRaises(xs.Refused):
            xs.enqueue(self.db, mail(body="different"))

    def test_a_retry_waits_until_due_and_a_result_is_recorded_once(self) -> None:
        xs.enqueue(self.db, mail())
        now = xs.now_iso()
        self.assertEqual([row["id"] for row in xs.due_outbox(self.db, now)], [MESSAGE])
        self.assertIsNone(xs.record_result(self.db, MESSAGE, "pending", error="unreachable", retry_after=60))
        self.assertEqual(xs.due_outbox(self.db, now), [])
        self.assertGreater(xs.next_due_at(self.db), now)
        self.assertEqual(xs.record_result(self.db, MESSAGE, "delivered")["state"], "delivered")
        self.assertIsNone(xs.record_result(self.db, MESSAGE, "failed", error="late"))
        self.assertIsNone(xs.next_due_at(self.db))

    def test_a_servers_own_relay_takes_only_mail_of_pairs_it_created(self) -> None:
        xs.enqueue(self.db, mail())
        now = xs.now_iso()
        self.assertEqual(xs.due_outbox(self.db, now, paired_here=True), [])
        self.assertIsNone(xs.next_due_at(self.db, paired_here=True))
        xs.put_pair(self.db, {"pair_id": PAIR, "a_server_identity": "srv-hub", "a_session_id": "sess_hub",
                              "a_route_id": HUB_ROUTE, "b_server_identity": "srv-remote",
                              "b_session_id": "sess_remote", "b_route_id": REMOTE_ROUTE})
        self.assertEqual([row["id"] for row in xs.due_outbox(self.db, now, paired_here=True)], [MESSAGE])

    def test_removing_a_pair_fails_its_undelivered_mail(self) -> None:
        xs.install_route(self.db, {"route_id": HUB_ROUTE, "pair_id": PAIR, "session_id": "sess_hub",
                                   "peer_server_identity": "srv-remote", "peer_server_name": "",
                                   "peer_session_id": "sess_remote", "peer_title": "Launch"})
        xs.enqueue(self.db, mail())
        removed, failed = xs.delete_pair_routes(self.db, PAIR)
        self.assertEqual([route["route_id"] for route in removed], [HUB_ROUTE])
        self.assertEqual([row["id"] for row in failed], [MESSAGE])
        self.assertEqual(xs.due_outbox(self.db, xs.now_iso()), [])

    def test_a_read_receipt_marks_sent_mail_once_and_refuses_unknown_mail(self) -> None:
        xs.enqueue(self.db, mail())
        self.assertEqual(xs.mark_read(self.db, MESSAGE, "2026-10-11T00:00:00Z")["read_at"], "2026-10-11T00:00:00Z")
        self.assertIsNone(xs.mark_read(self.db, MESSAGE, "2026-10-11T00:01:00Z"))
        with self.assertRaises(xs.Refused):
            xs.mark_read(self.db, "handoff_" + "d" * 32, "2026-10-11T00:00:00Z")

    def test_a_reply_from_another_server_may_reference_mail_this_server_sent(self) -> None:
        xs.enqueue(self.db, mail())
        reply = "handoff_" + "e" * 32
        self.db.execute("""INSERT INTO cross_chat_envelopes (id, kind, source_session_id, source_run_id,
            target_session_id, action, body, idempotency_key, authorization_kind, authorization_route_id,
            authorization_pair_id, status, delivery_mode, reply_to_message_id)
            VALUES (?, 'instruction', 'srv-remote/sess_remote', 'run_r', 'sess_hub', 'instruction', 'Answer',
                    'key-r', 'configured_route', ?, ?, 'stored', 'mailbox', ?)""", (reply, HUB_ROUTE, PAIR, MESSAGE))
        stored = chat_mailbox.store_message(self.db, reply, now=xs.now_iso(), in_reply_to_message_id=MESSAGE)
        self.assertEqual(stored["in_reply_to_message_id"], MESSAGE)

    def test_a_reply_to_mail_sent_to_a_different_chat_is_refused(self) -> None:
        xs.enqueue(self.db, mail(target_session_id="sess_other"))
        reply = "handoff_" + "e" * 32
        self.db.execute("""INSERT INTO cross_chat_envelopes (id, kind, source_session_id, source_run_id,
            target_session_id, action, body, idempotency_key, authorization_kind, authorization_route_id,
            authorization_pair_id, status, delivery_mode, reply_to_message_id)
            VALUES (?, 'instruction', 'srv-remote/sess_remote', 'run_r', 'sess_hub', 'instruction', 'Answer',
                    'key-r', 'configured_route', ?, ?, 'stored', 'mailbox', ?)""", (reply, HUB_ROUTE, PAIR, MESSAGE))
        with self.assertRaises(chat_mailbox.MailboxConflict):
            chat_mailbox.store_message(self.db, reply, now=xs.now_iso(), in_reply_to_message_id=MESSAGE)


class FakeEnd(xs.End):
    def __init__(self, identity: str, name: str = "", *, refuse: str = "", down: bool = False) -> None:
        self.identity = identity
        self.name = name
        self.refuse = refuse
        self.down = down
        self.results: list[tuple] = []
        self.delivered: list[tuple] = []
        self.receipts: list[dict] = []

    async def record_result(self, item_id: str, state: str, error: str = "", retry_after: float = 0.0) -> None:
        self.results.append((item_id, state, error, retry_after))

    async def deliver(self, item: dict, source_identity: str, source_name: str) -> None:
        if self.down:
            raise ConnectionError("tunnel down")
        if self.refuse:
            raise xs.Refused(self.refuse)
        self.delivered.append((item["message_id"], source_identity, source_name))

    async def receipt(self, item: dict) -> None:
        self.receipts.append(item)


class RelayRoutingTests(unittest.IsolatedAsyncioTestCase):
    def relay(self, pair: dict | None, remote: FakeEnd) -> tuple[xs.Relay, FakeEnd]:
        hub = FakeEnd("srv-hub")

        async def ledger(name: str, *args):
            self.assertEqual(name, "get_pair")
            return pair

        relay = xs.Relay(local=hub, remotes=None, ledger=ledger)
        relay.remote_ends = {"r1": remote}
        return relay, hub

    PAIR_ROW = {"pair_id": PAIR, "a_server_identity": "srv-hub", "a_session_id": "sess_hub",
                "b_server_identity": "srv-remote", "b_session_id": "sess_remote"}

    def item(self, **overrides) -> dict:
        return {**mail(), "created_at": xs.now_iso(), "attempts": 0, **overrides}

    async def test_paired_mail_is_delivered_with_the_source_server_named_by_the_hub(self) -> None:
        remote = FakeEnd("srv-remote", "osmo_dev_l40")
        relay, hub = self.relay(self.PAIR_ROW, remote)
        await relay._route(hub, self.item(), set())
        self.assertEqual(remote.delivered, [(MESSAGE, "srv-hub", "")])
        self.assertEqual(hub.results, [(MESSAGE, "delivered", "", 0.0)])

    async def test_a_remote_cannot_claim_to_be_another_chat_of_the_pair(self) -> None:
        # The source server is the end the hub read the item from, never a field of the item.
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(self.PAIR_ROW, remote)
        await relay._route(remote, self.item(source_session_id="sess_hub", target_server_identity="srv-hub"), set())
        self.assertEqual(hub.delivered, [])
        self.assertEqual(remote.results, [(MESSAGE, "pending", "this hub has no such chat pair", 300.0)])

    async def test_an_unknown_pair_waits_for_another_hub_then_fails_after_a_day(self) -> None:
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(None, remote)
        await relay._route(hub, self.item(), set())
        old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        await relay._route(hub, self.item(created_at=old), set())
        self.assertEqual([result[1] for result in hub.results], ["pending", "failed"])
        self.assertEqual(remote.delivered, [])

    async def test_a_refusal_fails_at_once_and_an_unreachable_target_is_retried_with_backoff(self) -> None:
        relay, hub = self.relay(self.PAIR_ROW, FakeEnd("srv-remote", refuse="chat was not found"))
        await relay._route(hub, self.item(), set())
        self.assertEqual(hub.results, [(MESSAGE, "failed", "chat was not found", 0.0)])

        relay, hub = self.relay(self.PAIR_ROW, FakeEnd("srv-remote", down=True))
        await relay._route(hub, self.item(attempts=2), set())
        self.assertEqual(hub.results, [(MESSAGE, "pending", "tunnel down", 60.0)])

    async def test_one_failure_spares_the_rest_of_the_batch_a_call_to_the_same_target(self) -> None:
        remote = FakeEnd("srv-remote", down=True)
        relay, hub = self.relay(self.PAIR_ROW, remote)
        unreachable: set[str] = set()
        await relay._route(hub, self.item(), unreachable)
        remote.down = False
        await relay._route(hub, self.item(id="handoff_" + "f" * 32, message_id="handoff_" + "f" * 32), unreachable)
        self.assertEqual(remote.delivered, [])
        self.assertEqual([result[1] for result in hub.results], ["pending", "pending"])

    async def test_a_remote_reporting_this_servers_identity_is_not_relayed_to(self) -> None:
        class Server:
            def __init__(self, server_id: str) -> None:
                self.id = server_id
                self.name = server_id

        class Remotes:
            servers = {"r-spoof": Server("r-spoof"), "r-ok": Server("r-ok")}
            http = None

            async def probe_health(self, server):
                identity = "srv-hub" if server.id == "r-spoof" else "srv-remote"
                return {"server_identity": identity, "capabilities": {xs.CAPABILITY: {"available": True}}}

        relay = xs.Relay(local=FakeEnd("srv-hub"), remotes=Remotes(), ledger=None)
        await relay.refresh()
        self.assertEqual(set(relay.remote_ends), {"r-ok"})
        self.assertIs(relay.ends()["srv-hub"], relay.local)

    async def test_a_read_receipt_goes_back_to_the_sender(self) -> None:
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(self.PAIR_ROW, remote)
        await relay._route(hub, self.item(id="read_" + "c" * 32, kind="read", body=""), set())
        self.assertEqual([receipt["message_id"] for receipt in remote.receipts], [MESSAGE])
        self.assertEqual(hub.results, [("read_" + "c" * 32, "delivered", "", 0.0)])


if __name__ == "__main__":
    unittest.main()
