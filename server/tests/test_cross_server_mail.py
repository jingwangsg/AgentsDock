"""Cross-server chat mail: the hub relays only what its pair registry links."""
import asyncio
import json
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

import agent_server
import chat_mailbox
import cross_server_mail as xs

PAIR = "pair_" + "1" * 32
HUB_ROUTE = "route_" + "a" * 32
REMOTE_ROUTE = "route_" + "b" * 32
MESSAGE = "handoff_" + "c" * 32
TOKEN = "t" * 32


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

    def test_items_a_hub_skips_are_left_out_of_its_reads_only(self) -> None:
        other = "handoff_" + "d" * 32
        xs.enqueue(self.db, mail())
        xs.enqueue(self.db, mail(id=other, message_id=other, idempotency_key="key-00002"))
        now = xs.now_iso()
        self.assertEqual([row["id"] for row in xs.due_outbox(self.db, now, skipped=[MESSAGE])], [other])
        # A skipped item that is due must not count as due, or the long poll would wake at once.
        self.assertIsNone(xs.next_due_at(self.db, skipped=[MESSAGE, other]))
        self.assertEqual({row["id"] for row in xs.due_outbox(self.db, now)}, {MESSAGE, other})

    def test_attachment_metadata_is_kept_and_hidden_from_a_hub_that_predates_it(self) -> None:
        attachment = {"filename": "data.bin", "size": 3, "sha256": "0" * 64, "content_type": "application/octet-stream"}
        xs.enqueue(self.db, mail(attachments=[attachment]))
        now = xs.now_iso()
        self.assertEqual([row["attachments"] for row in xs.due_outbox(self.db, now)], [[attachment]])
        self.assertEqual(xs.outbox_item(self.db, MESSAGE)["attachments"], [attachment])
        self.assertEqual(xs.due_outbox(self.db, now, with_attachments=False), [])
        self.assertIsNone(xs.next_due_at(self.db, with_attachments=False))
        text_only_id = "handoff_" + "d" * 32
        xs.enqueue(self.db, mail(id=text_only_id, message_id=text_only_id, idempotency_key="key-00002"))
        self.assertEqual([row["id"] for row in xs.due_outbox(self.db, xs.now_iso(), with_attachments=False)],
                         [text_only_id])
        self.assertIsNone(xs.outbox_item(self.db, "handoff_" + "e" * 32))

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
        self.calls: list[str] = []  # transfers and deliveries in order
        self.snapshot_missing = False
        self.server = identity  # what the relay probes again

    async def record_result(self, item_id: str, state: str, error: str = "", retry_after: float = 0.0,
                            hub: str = "") -> None:
        self.results.append((item_id, state, error, retry_after) + ((hub,) if hub else ()))

    async def deliver(self, item: dict, source_identity: str, source_name: str) -> None:
        if self.down:
            raise ConnectionError("tunnel down")
        if self.refuse:
            raise xs.Refused(self.refuse)
        self.delivered.append((item["message_id"], source_identity, source_name))
        self.calls.append("deliver")

    async def attachment(self, item: dict, index: int, folder: Path) -> Path:
        if self.snapshot_missing:
            raise xs.Refused("The sending server no longer has this attachment.")
        path = folder / str(index)
        path.write_text(item["attachments"][index]["filename"])
        return path

    async def put_attachment(self, item: dict, index: int, path: Path) -> None:
        if self.down:
            raise ConnectionError("tunnel down")
        self.calls.append(f"put {index} {path.read_text()}")

    async def receipt(self, item: dict) -> None:
        self.receipts.append(item)


class RelayRoutingTests(unittest.IsolatedAsyncioTestCase):
    def relay(self, pair: dict | None, remote: FakeEnd, *, remote_health: dict | None = None) -> tuple[xs.Relay, FakeEnd]:
        hub = FakeEnd("srv-hub")

        async def ledger(name: str, *args):
            self.assertEqual(name, "get_pair")
            return pair

        async def probe_health(server):
            return remote_health

        relay = xs.Relay(local=hub, remotes=SimpleNamespace(probe_health=probe_health), ledger=ledger)
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
        self.assertEqual(remote.results, [(MESSAGE, "pending", "this hub has no such chat pair", 300.0, "srv-hub")])

    async def test_an_unknown_pair_waits_for_another_hub_then_fails_after_a_day(self) -> None:
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(None, remote)
        await relay._route(hub, self.item(), set())
        old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        await relay._route(hub, self.item(created_at=old), set())
        # The pending result names this hub, so only this hub's reads skip the item.
        self.assertEqual(hub.results, [(MESSAGE, "pending", "this hub has no such chat pair", 300.0, "srv-hub"),
                                       (MESSAGE, "failed", "No hub delivered this message within 24 hours.", 0.0)])
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
                return {"server_identity": identity, "capabilities": {xs.CAPABILITY: {"available": True}},
                        "default_cwd": "/home/remote"}

        relay = xs.Relay(local=FakeEnd("srv-hub"), remotes=Remotes(), ledger=None)
        await relay.refresh()
        self.assertEqual(set(relay.remote_ends), {"r-ok"})
        self.assertIs(relay.ends()["srv-hub"], relay.local)
        # A remote that does not advertise attachments predates them.
        self.assertFalse(relay.remote_ends["r-ok"].accepts_attachments)
        # The hub's chat list names it as that server's home directory.
        self.assertEqual(relay.remote_ends["r-ok"].default_cwd, "/home/remote")

    ATTACHMENTS = [{"filename": name, "size": 1, "sha256": "0" * 64, "content_type": "text/plain"}
                   for name in ("first.txt", "second.txt")]

    async def test_attachments_reach_the_target_before_their_message(self) -> None:
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(self.PAIR_ROW, remote)
        await relay._route(hub, self.item(attachments=self.ATTACHMENTS), set())
        self.assertEqual(remote.calls, ["put 0 first.txt", "put 1 second.txt", "deliver"])
        self.assertEqual(hub.results, [(MESSAGE, "delivered", "", 0.0)])

    async def test_a_target_that_predates_attachments_fails_the_message_at_once(self) -> None:
        remote = FakeEnd("srv-remote")
        remote.accepts_attachments = False
        relay, hub = self.relay(self.PAIR_ROW, remote, remote_health={"capabilities": {xs.CAPABILITY: {"available": True}}})
        await relay._route(hub, self.item(attachments=self.ATTACHMENTS), set())
        await relay._route(hub, self.item(id="handoff_" + "f" * 32, message_id="handoff_" + "f" * 32), set())
        self.assertEqual(remote.calls, ["deliver"])  # mail without attachments still goes through
        self.assertEqual([result[1] for result in hub.results], ["failed", "delivered"])
        self.assertIn("update it", hub.results[0][2])

    async def test_a_target_updated_since_its_first_probe_gets_the_files(self) -> None:
        remote = FakeEnd("srv-remote")
        remote.accepts_attachments = False
        health = {"capabilities": {xs.CAPABILITY: {"available": True, "attachments": True}}}
        relay, hub = self.relay(self.PAIR_ROW, remote, remote_health=health)
        await relay._route(hub, self.item(attachments=self.ATTACHMENTS), set())
        self.assertEqual(remote.calls, ["put 0 first.txt", "put 1 second.txt", "deliver"])
        self.assertTrue(remote.accepts_attachments)

    async def test_text_mail_from_a_source_that_predates_attachments_lists_none(self) -> None:
        sent: list[dict] = []

        class Http:
            async def request(self, method, url, **kwargs):
                sent.append(kwargs["json"])
                return SimpleNamespace(status_code=200, json=lambda: {"ok": True}, raise_for_status=lambda: None)

        end = xs.RemoteEnd(Http(), SimpleNamespace(name="remote", local_port=1, token="t" * 32), "srv-remote")
        item = {key: value for key, value in self.item().items() if key != "attachments"}
        await end.deliver(item, "srv-hub", "")
        self.assertEqual(sent[0]["attachments"], [])
        self.assertEqual(json.loads(json.dumps(sent[0]))["body"], item["body"])

    async def test_a_lost_snapshot_fails_and_a_failed_upload_is_retried(self) -> None:
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(self.PAIR_ROW, remote)
        hub.snapshot_missing = True
        await relay._route(hub, self.item(attachments=self.ATTACHMENTS), set())
        self.assertEqual(hub.results[-1][:2], (MESSAGE, "failed"))
        hub.snapshot_missing, remote.down = False, True
        await relay._route(hub, self.item(attachments=self.ATTACHMENTS), set())
        self.assertEqual(hub.results[-1], (MESSAGE, "pending", "tunnel down", 15.0))
        self.assertEqual(remote.delivered, [])

    async def test_a_read_receipt_goes_back_to_the_sender(self) -> None:
        remote = FakeEnd("srv-remote")
        relay, hub = self.relay(self.PAIR_ROW, remote)
        await relay._route(hub, self.item(id="read_" + "c" * 32, kind="read", body=""), set())
        self.assertEqual([receipt["message_id"] for receipt in remote.receipts], [MESSAGE])
        self.assertEqual(hub.results, [("read_" + "c" * 32, "delivered", "", 0.0)])


class TwoHubOutboxTests(unittest.IsolatedAsyncioTestCase):
    """Two hubs attached one server: each hub's relay reads its outbox through the server's endpoints."""

    async def asyncSetUp(self) -> None:
        self.db = ledger()  # the attached server's ledger
        self.queries: list[str] = []
        # Runs once, after the next next_due_at query and before it returns: a change during a poll's queries.
        self.during_next_due = None
        test = self

        class CrossChat:
            async def cross_server_call(self, name: str, *args, **kwargs):
                test.queries.append(name)
                result = getattr(xs, name)(test.db, *args, **kwargs)
                if name == "next_due_at" and test.during_next_due is not None:
                    during, test.during_next_due = test.during_next_due, None
                    await during()
                return result

        attachments = tempfile.TemporaryDirectory()
        self.addCleanup(attachments.cleanup)
        for name, value in (("CROSS_CHAT", CrossChat()), ("CROSS_SERVER_OUTBOX_CHANGED", asyncio.Event()),
                            ("CROSS_SERVER_OUTBOX_SKIPPED", {}), ("AGENT_TOKEN", TOKEN),
                            ("CROSS_SERVER_ATTACHMENTS_ROOT", Path(attachments.name))):
            patcher = patch.object(agent_server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=agent_server.app))
        self.addAsyncCleanup(self.http.aclose)
        pair = {"pair_id": PAIR, "a_server_identity": "srv-a", "a_session_id": "sess_a",
                "b_server_identity": "srv-remote", "b_session_id": "sess_remote"}
        # Hub A created the pair; hub B attached the same server and has no pair.
        self.hub_a, self.relay_a, self.remote_a = self.hub("srv-a", pair)
        self.hub_b, self.relay_b, self.remote_b = self.hub("srv-b", None)

    def hub(self, identity: str, pair: dict | None) -> tuple[FakeEnd, xs.Relay, xs.RemoteEnd]:
        async def get_pair(name: str, *args):
            return pair

        local = FakeEnd(identity)
        relay = xs.Relay(local=local, remotes=SimpleNamespace(), ledger=get_pair)
        remote = xs.RemoteEnd(self.http, SimpleNamespace(name="remote", local_port=1, token=TOKEN), "srv-remote",
                              accepts_attachments=True)
        relay.remote_ends = {"r1": remote}
        return local, relay, remote

    def enqueue(self, item_id: str = MESSAGE) -> None:
        xs.enqueue(self.db, mail(id=item_id, message_id=item_id, idempotency_key=f"key-{item_id}",
                                 route_id=REMOTE_ROUTE, source_session_id="sess_remote",
                                 target_server_identity="srv-a", target_session_id="sess_a"))

    async def test_a_hub_without_the_pair_leaves_the_mail_to_the_hub_that_has_it(self) -> None:
        self.enqueue()
        # Hub B reads first and skips the item; only its own reads leave it out afterwards.
        [item] = await self.remote_b.outbox(0, "srv-b")
        await self.relay_b._route(self.remote_b, item, set())
        self.assertEqual(await self.remote_b.outbox(0, "srv-b"), [])
        [item] = await self.remote_a.outbox(0, "srv-a")
        await self.relay_a._route(self.remote_a, item, set())
        self.assertEqual(self.hub_a.delivered, [(MESSAGE, "srv-remote", "remote")])
        row = xs.outbox_item(self.db, MESSAGE)
        self.assertEqual((row["state"], row["attempts"], row["error"]), ("delivered", 0, None))

    async def test_a_hub_that_predates_hub_skipping_still_delays_the_item_for_every_hub(self) -> None:
        self.enqueue()
        [item] = await self.remote_b.outbox(0, "srv-b")
        await self.relay_b._route(self.remote_b, item, set())
        # An older hub sends no `hub`: it reads every due item, and its wait applies to every hub.
        old = {"X-AgentsDock-Token": TOKEN}
        response = await self.http.get("http://127.0.0.1:1/api/admin/cross-server/outbox",
                                       params={"wait": 0, "attachments": True}, headers=old)
        self.assertEqual([item["id"] for item in response.json()["items"]], [MESSAGE])
        response = await self.http.post(f"http://127.0.0.1:1/api/admin/cross-server/outbox/{MESSAGE}/result", headers=old,
                                        json={"state": "pending", "error": "this hub has no such chat pair",
                                              "retry_after": 300})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(await self.remote_a.outbox(0, "srv-a"), [])
        self.assertEqual(xs.outbox_item(self.db, MESSAGE)["attempts"], 1)

    async def test_a_long_poll_returns_new_mail_at_once_and_does_not_spin_on_mail_it_skips(self) -> None:
        polls = [asyncio.create_task(end.outbox(5, hub)) for end, hub in ((self.remote_a, "srv-a"),
                                                                           (self.remote_b, "srv-b"))]
        await asyncio.sleep(0.1)
        self.enqueue()
        started = time.monotonic()
        agent_server.CROSS_SERVER_OUTBOX_CHANGED.set()  # what the send endpoint does after storing the mail
        items_a, items_b = await asyncio.gather(*polls)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(([item["id"] for item in items_a], [item["id"] for item in items_b]), ([MESSAGE], [MESSAGE]))
        await self.relay_b._route(self.remote_b, items_b[0], set())
        # The skipped item stays due, but hub B's poll neither returns it nor wakes for it.
        self.queries.clear()
        started = time.monotonic()
        self.assertEqual(await self.remote_b.outbox(1, "srv-b"), [])
        self.assertGreaterEqual(time.monotonic() - started, 0.9)
        self.assertEqual(self.queries, ["due_outbox", "next_due_at", "due_outbox"])  # the last one at the deadline
        self.assertEqual([item["id"] for item in await self.remote_a.outbox(0, "srv-a")], [MESSAGE])

    async def test_mail_stored_during_one_hubs_queries_wakes_its_poll_after_another_hub_took_the_change(self) -> None:
        waiting_a = asyncio.create_task(self.remote_a.outbox(5, "srv-a"))
        await asyncio.sleep(0.1)

        async def mail_arrives() -> None:
            self.enqueue()
            agent_server.CROSS_SERVER_OUTBOX_CHANGED.set()
            # Hub A's poll wakes and starts its next round before hub B's poll begins to wait.
            for _ in range(20):
                await asyncio.sleep(0)

        # Hub B's poll is between its queries and its wait when the mail arrives.
        self.during_next_due = mail_arrives
        started = time.monotonic()
        items_b = await self.remote_b.outbox(3, "srv-b")
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual([item["id"] for item in items_b], [MESSAGE])
        self.assertEqual([item["id"] for item in await waiting_a], [MESSAGE])


if __name__ == "__main__":
    unittest.main()
