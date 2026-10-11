"""Chat mail between chats on a hub and on the remote servers the hub manages.

A pair links one chat on one server with one chat on another. Only the hub
creates pairs (from a chat the user picked in the composer) and only the hub
moves mail: it reads every server's outbox and calls the target server, where
the message becomes an ordinary mailbox row. Remote servers never call the hub,
and the hub relays an item only when its own pair registry links exactly the
item's source and target, so a remote cannot reach a chat it was not paired with.

Storage functions take a connection inside a caller-owned transaction on the
cross-chat ledger, like chat_mailbox.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
import sqlite3
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger("agentsdock.cross_server_mail")

CAPABILITY = "cross_server_mail_v1"
ROUTE_ID_RE = re.compile(r"route_[0-9a-f]{32}\Z")
PAIR_ID_RE = re.compile(r"pair_[0-9a-f]{32}\Z")
MESSAGE_ID_RE = re.compile(r"handoff_[0-9a-f]{32}\Z")
OUTBOX_WAIT_SECONDS = 25.0
DELIVERY_TTL = timedelta(hours=24)
REMOTE_REQUEST_TIMEOUT = 15.0
SEARCH_TIMEOUT = 4.0
SEARCH_LIMIT = 500


class Refused(RuntimeError):
    """A server refused the request (unknown chat, pair or message); retrying cannot succeed."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(16)}"


def sender_key(server_identity: str, session_id: str) -> str:
    """The id a foreign chat has in this server's mailbox (its `--sender`).

    chat_mailbox.store_message builds the same string in SQL."""
    return f"{server_identity}/{session_id}"


def peer_key(route: dict) -> str:
    return sender_key(route["peer_server_identity"], route["peer_session_id"])


def peer_label(route: dict) -> str:
    """The composer's chip text for the route's peer, without the `@`; a chat on the hub has no server tag."""
    title = route["peer_title"].strip()
    return f"{title} · {route['peer_server_name']}" if route["peer_server_name"] else title


def names_peer(text: str, route: dict) -> bool:
    """Whether `text` holds the chip for the route's peer as a whole token.

    The chip never reaches the sender's server (only the hub pairs it), so its
    text in the user's own turn stands in for the span a local @Chat chip
    carries. Like the composer's chip check, the token starts the text or
    follows whitespace or an opening bracket, and ends the text or precedes
    whitespace. A hub peer titled "Launch" also matches "@Launch check"."""
    label = peer_label(route)
    return bool(route["peer_title"].strip()) and re.search(
        r"(?:^|(?<=[\s(\[{]))" + re.escape("@" + label) + r"(?=\s|$)", text) is not None


# -- storage -------------------------------------------------------------------

def initialize(connection: sqlite3.Connection) -> None:
    statements = (
        # This server's half of each pair: one row per local chat and peer.
        """CREATE TABLE IF NOT EXISTS cross_server_routes (
            route_id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, session_id TEXT NOT NULL,
            alias TEXT NOT NULL, peer_server_identity TEXT NOT NULL, peer_server_name TEXT NOT NULL,
            peer_session_id TEXT NOT NULL, peer_title TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(pair_id, session_id))""",
        # Mail this server's chats sent to foreign chats, and read receipts for
        # foreign mail its chats read. The hub drains it.
        """CREATE TABLE IF NOT EXISTS cross_server_outbox (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('mail','read')),
            pair_id TEXT NOT NULL, route_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL, source_title TEXT NOT NULL,
            source_run_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            target_server_identity TEXT NOT NULL, target_session_id TEXT NOT NULL,
            body TEXT NOT NULL, reply_to_message_id TEXT, message_id TEXT NOT NULL,
            source_user_instruction TEXT NOT NULL DEFAULT '', source_user_delegation_action TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL CHECK(state IN ('pending','delivered','failed')),
            error TEXT, finished_at TEXT, read_at TEXT,
            UNIQUE(source_run_id, idempotency_key))""",
        """CREATE INDEX IF NOT EXISTS cross_server_outbox_due
            ON cross_server_outbox(state, next_attempt_at)""",
        # Hub only: the authority for which chats may exchange mail.
        """CREATE TABLE IF NOT EXISTS cross_server_pairs (
            pair_id TEXT PRIMARY KEY,
            a_server_identity TEXT NOT NULL, a_session_id TEXT NOT NULL, a_route_id TEXT NOT NULL,
            b_server_identity TEXT NOT NULL, b_session_id TEXT NOT NULL, b_route_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(a_server_identity, a_session_id, b_server_identity, b_session_id))""",
    )
    for statement in statements:
        connection.execute(statement)


def routes(connection: sqlite3.Connection) -> list[dict]:
    return [dict(row) for row in connection.execute("SELECT * FROM cross_server_routes ORDER BY created_at, route_id")]


def install_route(connection: sqlite3.Connection, route: dict) -> dict:
    """Idempotent on the exact route (refreshing the peer's label); another route for the same pair and chat is a conflict."""
    if not ROUTE_ID_RE.fullmatch(route["route_id"]) or not PAIR_ID_RE.fullmatch(route["pair_id"]):
        raise Refused("Invalid pair or route id")
    existing = connection.execute("SELECT * FROM cross_server_routes WHERE pair_id=? AND session_id=?",
                                  (route["pair_id"], route["session_id"])).fetchone()
    if existing is not None:
        if existing["route_id"] != route["route_id"]:
            raise Refused("This chat already has another route for the pair")
        connection.execute("UPDATE cross_server_routes SET peer_title=?, peer_server_name=? WHERE route_id=?",
                           (route["peer_title"], route["peer_server_name"], route["route_id"]))
        return {**dict(existing), "peer_title": route["peer_title"], "peer_server_name": route["peer_server_name"]}
    used = {row["alias"] for row in connection.execute(
        "SELECT alias FROM cross_server_routes WHERE session_id=?", (route["session_id"],))}
    alias = next(f"remote{index}" for index in range(1, len(used) + 2) if f"remote{index}" not in used)
    connection.execute("""INSERT INTO cross_server_routes (route_id, pair_id, session_id, alias,
        peer_server_identity, peer_server_name, peer_session_id, peer_title, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", (route["route_id"], route["pair_id"], route["session_id"], alias,
                                        route["peer_server_identity"], route["peer_server_name"],
                                        route["peer_session_id"], route["peer_title"], now_iso()))
    return dict(connection.execute("SELECT * FROM cross_server_routes WHERE route_id=?",
                                   (route["route_id"],)).fetchone())


def delete_pair_routes(connection: sqlite3.Connection, pair_id: str) -> tuple[list[dict], list[dict]]:
    """Remove this server's halves of a pair; its undelivered mail fails. Returns (routes, failed mail)."""
    removed = [dict(row) for row in connection.execute(
        "SELECT * FROM cross_server_routes WHERE pair_id=?", (pair_id,))]
    connection.execute("DELETE FROM cross_server_routes WHERE pair_id=?", (pair_id,))
    failed = [dict(row) for row in connection.execute(
        "SELECT * FROM cross_server_outbox WHERE pair_id=? AND state='pending' AND kind='mail'", (pair_id,))]
    connection.execute("UPDATE cross_server_outbox SET state='failed', error=?, finished_at=? "
                       "WHERE pair_id=? AND state='pending'", ("This chat pair was removed.", now_iso(), pair_id))
    return removed, [{**row, "state": "failed", "error": "This chat pair was removed."} for row in failed]


def rename_peer(connection: sqlite3.Connection, route_id: str, title: str, server_name: str) -> None:
    connection.execute("UPDATE cross_server_routes SET peer_title=?, peer_server_name=? WHERE route_id=?",
                       (title, server_name, route_id))


def enqueue(connection: sqlite3.Connection, item: dict) -> tuple[dict, bool]:
    """Store one outgoing item; a retry with the same (run, key) returns the first one."""
    existing = connection.execute("SELECT * FROM cross_server_outbox WHERE source_run_id=? AND idempotency_key=?",
                                  (item["source_run_id"], item["idempotency_key"])).fetchone()
    if existing is not None:
        if any(existing[key] != item[key] for key in ("kind", "route_id", "body", "reply_to_message_id")):
            raise Refused("idempotency key was already used for a different message")
        return dict(existing), False
    timestamp = now_iso()
    connection.execute("""INSERT INTO cross_server_outbox (id, kind, pair_id, route_id, source_session_id,
        source_title, source_run_id, idempotency_key, target_server_identity, target_session_id, body,
        reply_to_message_id, message_id, source_user_instruction, source_user_delegation_action,
        created_at, next_attempt_at, state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')""",
        (item["id"], item["kind"], item["pair_id"], item["route_id"], item["source_session_id"],
         item["source_title"], item["source_run_id"], item["idempotency_key"], item["target_server_identity"],
         item["target_session_id"], item["body"], item.get("reply_to_message_id"), item["message_id"],
         item.get("source_user_instruction", ""), item.get("source_user_delegation_action", ""),
         timestamp, timestamp))
    return dict(connection.execute("SELECT * FROM cross_server_outbox WHERE id=?", (item["id"],)).fetchone()), True


# A server's own relay takes only mail of pairs it created as a hub. The rest
# waits for the hub that created its pair, which reads this outbox remotely.
_PAIRED_HERE = " AND pair_id IN (SELECT pair_id FROM cross_server_pairs)"


def due_outbox(connection: sqlite3.Connection, now: str, limit: int = 20, *, paired_here: bool = False) -> list[dict]:
    return [dict(row) for row in connection.execute(
        "SELECT * FROM cross_server_outbox WHERE state='pending' AND next_attempt_at<=?"
        + (_PAIRED_HERE if paired_here else "") + " ORDER BY next_attempt_at, created_at LIMIT ?", (now, limit))]


def next_due_at(connection: sqlite3.Connection, *, paired_here: bool = False) -> str | None:
    row = connection.execute("SELECT MIN(next_attempt_at) AS due FROM cross_server_outbox WHERE state='pending'"
                             + (_PAIRED_HERE if paired_here else "")).fetchone()
    return row["due"] if row is not None else None


def record_result(connection: sqlite3.Connection, item_id: str, state: str, *, error: str = "",
                  retry_after: float = 0.0) -> dict | None:
    """Record the hub's result: `pending` reschedules the item (any number of times), a final state is kept once."""
    row = connection.execute("SELECT * FROM cross_server_outbox WHERE id=?", (item_id,)).fetchone()
    if row is None or row["state"] != "pending":
        return None
    timestamp = now_iso()
    if state == "pending":
        due = (datetime.now(timezone.utc) + timedelta(seconds=retry_after)).isoformat().replace("+00:00", "Z")
        connection.execute("UPDATE cross_server_outbox SET attempts=attempts+1, next_attempt_at=?, error=? WHERE id=?",
                           (due, error or None, item_id))
        return None
    if state not in ("delivered", "failed"):
        raise Refused("Invalid outbox result")
    connection.execute("UPDATE cross_server_outbox SET state=?, error=?, finished_at=? WHERE id=?",
                       (state, error or None, timestamp, item_id))
    return dict(connection.execute("SELECT * FROM cross_server_outbox WHERE id=?", (item_id,)).fetchone())


def mark_read(connection: sqlite3.Connection, message_id: str, read_at: str) -> dict | None:
    """Source side of a read receipt; returns the sent mail the first time only."""
    row = connection.execute("SELECT * FROM cross_server_outbox WHERE id=? AND kind='mail'", (message_id,)).fetchone()
    if row is None:
        raise Refused("No message with this id was sent from this server")
    if row["read_at"]:
        return None
    connection.execute("UPDATE cross_server_outbox SET read_at=? WHERE id=?", (read_at, message_id))
    return {**dict(row), "read_at": read_at}


def get_pair(connection: sqlite3.Connection, pair_id: str) -> dict | None:
    row = connection.execute("SELECT * FROM cross_server_pairs WHERE pair_id=?", (pair_id,)).fetchone()
    return dict(row) if row is not None else None


def find_pair(connection: sqlite3.Connection, one: tuple[str, str], other: tuple[str, str]) -> dict | None:
    row = connection.execute("""SELECT * FROM cross_server_pairs WHERE
        (a_server_identity=? AND a_session_id=? AND b_server_identity=? AND b_session_id=?) OR
        (a_server_identity=? AND a_session_id=? AND b_server_identity=? AND b_session_id=?)""",
        (*one, *other, *other, *one)).fetchone()
    return dict(row) if row is not None else None


def put_pair(connection: sqlite3.Connection, pair: dict) -> None:
    connection.execute("""INSERT INTO cross_server_pairs (pair_id, a_server_identity, a_session_id, a_route_id,
        b_server_identity, b_session_id, b_route_id, created_at) VALUES (?,?,?,?,?,?,?,?)""",
        (pair["pair_id"], pair["a_server_identity"], pair["a_session_id"], pair["a_route_id"],
         pair["b_server_identity"], pair["b_session_id"], pair["b_route_id"], now_iso()))


def delete_pair(connection: sqlite3.Connection, pair_id: str) -> dict | None:
    pair = get_pair(connection, pair_id)
    connection.execute("DELETE FROM cross_server_pairs WHERE pair_id=?", (pair_id,))
    return pair


def pairs_for(connection: sqlite3.Connection, server_identity: str, session_id: str) -> list[dict]:
    return [dict(row) for row in connection.execute("""SELECT * FROM cross_server_pairs WHERE
        (a_server_identity=? AND a_session_id=?) OR (b_server_identity=? AND b_session_id=?)
        ORDER BY created_at""", (server_identity, session_id, server_identity, session_id))]


# -- hub relay -----------------------------------------------------------------

class End:
    """One server as the hub sees it: the hub itself or a remote behind its tunnel."""

    identity: str
    name: str  # "" for the hub: the composer shows no server tag for its chats

    async def outbox(self, wait: float) -> list[dict]: raise NotImplementedError
    async def record_result(self, item_id: str, state: str, error: str = "", retry_after: float = 0.0) -> None: raise NotImplementedError
    async def deliver(self, item: dict, source_identity: str, source_name: str) -> None: raise NotImplementedError
    async def receipt(self, item: dict) -> None: raise NotImplementedError
    async def describe(self, session_id: str) -> dict: raise NotImplementedError
    async def install(self, route: dict) -> None: raise NotImplementedError
    async def uninstall(self, pair_id: str) -> None: raise NotImplementedError
    async def chats(self) -> list[dict]: raise NotImplementedError
    async def create(self, chat: dict) -> dict: raise NotImplementedError


class RemoteEnd(End):
    def __init__(self, http: httpx.AsyncClient, server: Any, identity: str) -> None:
        self.http = http
        self.server = server
        self.identity = identity
        self.name = server.name

    async def _request(self, method: str, path: str, *, timeout: float = REMOTE_REQUEST_TIMEOUT, **kwargs: Any) -> Any:
        response = await self.http.request(
            method, f"http://127.0.0.1:{self.server.local_port}{path}",
            headers={"X-AgentsDock-Token": self.server.token}, timeout=timeout, **kwargs,
        )
        if response.status_code in (404, 409, 422):
            detail = ""
            with suppress(ValueError):
                detail = str((response.json() or {}).get("detail") or "")
            raise Refused(detail or f"HTTP {response.status_code}")
        response.raise_for_status()
        return response.json()

    async def outbox(self, wait: float) -> list[dict]:
        data = await self._request("GET", "/api/admin/cross-server/outbox", params={"wait": wait}, timeout=wait + 10)
        return list(data.get("items") or [])

    async def record_result(self, item_id: str, state: str, error: str = "", retry_after: float = 0.0) -> None:
        await self._request("POST", f"/api/admin/cross-server/outbox/{item_id}/result",
                            json={"state": state, "error": error, "retry_after": retry_after})

    async def deliver(self, item: dict, source_identity: str, source_name: str) -> None:
        # Never the source's retry bookkeeping or anything beyond the message itself.
        fields = ("message_id", "pair_id", "source_session_id", "source_title", "source_run_id",
                  "idempotency_key", "target_session_id", "body", "reply_to_message_id",
                  "source_user_instruction", "source_user_delegation_action")
        await self._request("POST", "/api/admin/cross-server/inbox",
                            json={**{key: item.get(key) for key in fields},
                                  "source_server_identity": source_identity, "source_server_name": source_name})

    async def receipt(self, item: dict) -> None:
        await self._request("POST", "/api/admin/cross-server/receipts",
                            json={"message_id": item["message_id"], "read_at": item["created_at"]})

    async def describe(self, session_id: str) -> dict:
        return await self._request("GET", f"/api/admin/cross-server/sessions/{session_id}")

    async def install(self, route: dict) -> None:
        await self._request("POST", "/api/admin/cross-server/routes", json=route)

    async def uninstall(self, pair_id: str) -> None:
        await self._request("DELETE", f"/api/admin/cross-server/pairs/{pair_id}")

    async def chats(self) -> list[dict]:
        data = await self._request("GET", "/api/chats/search", params={"limit": SEARCH_LIMIT}, timeout=SEARCH_TIMEOUT)
        return list(data.get("chats") or [])

    async def create(self, chat: dict) -> dict:
        try:
            return dict((await self._request("POST", "/api/sessions", json=chat)).get("session") or {})
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 400:
                raise
            # A 400 is the server's own refusal (model, directory): its detail reaches the user
            # as Refused; any other status stays a transport error (502 upstream).
            detail = ""
            with suppress(ValueError):
                detail = str((exc.response.json() or {}).get("detail") or "")
            raise Refused(detail or "HTTP 400") from exc


class Relay:
    """Move outbox items between the hub and its remotes; the hub's pair registry decides."""

    def __init__(self, *, local: End, remotes: Any, ledger: Callable[..., Awaitable[Any]]) -> None:
        self.local = local
        self.remotes = remotes  # remote_servers.RemoteServerManager
        self.ledger = ledger    # CrossChatStore.cross_server_call
        self.remote_ends: dict[str, RemoteEnd] = {}  # remote id -> end, only remotes that advertise mail
        self.pumps: dict[str, asyncio.Task] = {}
        self.supervisor: asyncio.Task | None = None

    def start(self) -> None:
        self.supervisor = asyncio.create_task(self._supervise(), name="cross-server-mail-relay")

    async def stop(self) -> None:
        tasks = [task for task in (self.supervisor, *self.pumps.values()) if task is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError, Exception):
                await task
        self.pumps.clear()

    def ends(self) -> dict[str, End]:
        """Every server the relay last found reachable and supporting mail, by identity; never probes."""
        # The source of relayed mail is the end it was read from, so no remote may
        # stand in for this server (refresh also refuses duplicate identities).
        return {**{end.identity: end for end in self.remote_ends.values()}, self.local.identity: self.local}

    async def refresh(self) -> None:
        """Probe remotes not yet known to support mail; forget removed or re-registered ones."""
        current = dict(self.remotes.servers)
        for remote_id in [key for key, end in self.remote_ends.items() if current.get(key) is not end.server]:
            self.remote_ends.pop(remote_id)
            # Its pump holds the old port and token.
            if (pump := self.pumps.pop(remote_id, None)) is not None:
                pump.cancel()
        unknown = [server for remote_id, server in current.items() if remote_id not in self.remote_ends]
        for server, health in zip(unknown, await asyncio.gather(*(self.remotes.probe_health(server) for server in unknown))):
            identity = (health or {}).get("server_identity")
            if (server.id in self.remote_ends or not isinstance(identity, str)
                    or not (((health or {}).get("capabilities") or {}).get(CAPABILITY) or {}).get("available")):
                continue
            if identity in self.ends():
                logger.warning("remote server %s reports another server's identity; cross-server mail skips it", server.name)
                continue
            self.remote_ends[server.id] = RemoteEnd(self.remotes.http, server, identity)

    async def _supervise(self) -> None:
        self.pumps["local"] = asyncio.create_task(self._pump(self.local), name="cross-server-mail:local")
        while True:
            with suppress(Exception):
                await self.refresh()
            for remote_id, end in self.remote_ends.items():
                task = self.pumps.get(remote_id)
                if task is None or task.done():
                    self.pumps[remote_id] = asyncio.create_task(self._pump(end), name=f"cross-server-mail:{remote_id}")
            for remote_id in [key for key in self.pumps if key != "local" and key not in self.remote_ends]:
                self.pumps.pop(remote_id).cancel()
            # Registry changes are rare; an unreachable remote is probed again here.
            await asyncio.sleep(30)

    async def _pump(self, end: End) -> None:
        backoff = 1.0
        while True:
            try:
                items = await end.outbox(OUTBOX_WAIT_SECONDS)
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("cross-server outbox of %s unavailable: %s", end.name or "this server", exc)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue
            # A target that failed in this batch is not called again for the rest of it.
            unreachable: set[str] = set()
            for item in items:
                try:
                    await self._route(end, item, unreachable)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning("cross-server item %s from %s could not be routed", item.get("id"),
                                   end.name or "this server", exc_info=True)

    async def _route(self, source: End, item: dict, unreachable: set[str]) -> None:
        expired = (datetime.now(timezone.utc) - datetime.fromisoformat(str(item["created_at"]).replace("Z", "+00:00"))
                   > DELIVERY_TTL)
        pair = await self.ledger("get_pair", str(item.get("pair_id") or ""))
        sides = {(pair["a_server_identity"], pair["a_session_id"]),
                 (pair["b_server_identity"], pair["b_session_id"])} if pair else set()
        if sides != {(source.identity, item.get("source_session_id")),
                     (item.get("target_server_identity"), item.get("target_session_id"))}:
            # A removed pair fails its mail when its halves are uninstalled. Not
            # failing here leaves the item to another hub that attached this
            # remote and created the pair.
            if expired:
                await source.record_result(item["id"], "failed", "No hub delivered this message within 24 hours.")
            else:
                await source.record_result(item["id"], "pending", "this hub has no such chat pair", retry_after=300.0)
            return
        target_identity = item["target_server_identity"]
        target = self.ends().get(target_identity)
        try:
            if target_identity in unreachable:
                raise ConnectionError("target server did not answer earlier in this batch")
            if target is None:
                # A remote that came up after the relay last probed the registry.
                await self.refresh()
                target = self.ends().get(target_identity)
            if target is None:
                raise ConnectionError("target server is not reachable from the hub")
            if item["kind"] == "mail":
                await target.deliver(item, source.identity, source.name)
            else:
                await target.receipt(item)
        except Refused as exc:
            await source.record_result(item["id"], "failed", str(exc))
            return
        except Exception as exc:
            unreachable.add(target_identity)
            if expired:
                await source.record_result(item["id"], "failed", "The other chat's server was unreachable for 24 hours.")
            else:
                await source.record_result(item["id"], "pending", str(exc)[:300],
                                    retry_after=min(15.0 * 2 ** int(item.get("attempts") or 0), 600.0))
            return
        await source.record_result(item["id"], "delivered")
