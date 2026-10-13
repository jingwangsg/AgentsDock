"""Chat mail attachments through the actual send, read and cancel handlers on synthetic state; never import the server."""
from __future__ import annotations

import ast
from copy import deepcopy
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
import uuid

import cross_server_mail
from tests import test_chat_mailbox_runtime_isolated as mailbox_fixture
from tests.test_chat_mailbox_runtime_isolated import HTTPException, ROUTE


FUNCTIONS = {
    "stage_chat_mail_attachments", "provider_team_attachment_paths", "prepare_artifact_records", "artifact_record",
    "remove_artifact_records", "remove_artifact_records_async", "safe_name", "guess_content_type",
    "effective_content_type", "copy_fork_file_data", "list_session_file_records", "cancel_queued_cross_chat_handoff",
    "cross_server_attachment_dir", "stage_cross_server_attachments", "receive_cross_server_attachments",
    "put_cross_server_inbox_attachment", "refused_as_http",
}
CONSTANTS = {"MAX_CHAT_MAIL_ATTACHMENT_FILE_BYTES", "MAX_CHAT_MAIL_ATTACHMENT_TOTAL_BYTES", "PROVIDER_TEAM_ATTACHMENT_LIMIT",
             "MAX_CROSS_SERVER_MAIL_ATTACHMENT_BYTES"}
MESSAGE = "handoff_" + "c" * 32


def selected(node: ast.stmt) -> bool:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return node.name in FUNCTIONS
    if isinstance(node, ast.ClassDef):
        return node.name == "ArtifactPublicationError"
    return isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in CONSTANTS
                                                for target in node.targets)


class ChatMailAttachmentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mail = mailbox_fixture.ChatMailboxRuntimeTests()
        await self.mail.asyncSetUp()
        self._cleanups.extend(self.mail._cleanups)
        self.mail._cleanups.clear()
        temporary = tempfile.TemporaryDirectory(prefix="isolated-mail-attachments-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        state = self.root / "state"
        self.files = state / "files"
        self.ns = self.mail.ns
        self.ns.update(
            ctypes=ctypes, fcntl=fcntl, os=os, re=re, shutil=shutil, sys=sys, uuid=uuid, Path=Path,
            MAX_UPLOAD_BYTES=25 * 1024 ** 3,
            STATE_DIR=state, FILES_ROOT=self.files, CROSS_CHAT_AUTHORITY_ROOT=state / "cross_chat_authority",
            CROSS_SERVER_ATTACHMENTS_ROOT=state / "cross-server-attachments", require_native_admin_control=lambda _request: None,
            iter_session_events=lambda _session_id: [], append_cross_chat_terminal_lifecycle=AsyncMock(),
        )
        nodes = [deepcopy(node) for node in mailbox_fixture.TREE.body if selected(node)]
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                node.decorator_list = []
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
                     "<isolated-chat-mail-attachments>", "exec"), self.ns)
        self.mail.set_recipient("busy")
        self.outbox = self.root / "sender-files"
        self.outbox.mkdir()
        self.binary = self.outbox / "..raw$data;.bin"
        self.binary.write_bytes(bytes(range(256)) * 64)
        self.text = self.outbox / "notes 中文.md"
        self.text.write_text("# Findings\nAll checks passed.\n", encoding="utf-8")

    async def send(self, attachments, key="attachment-message"):
        req = SimpleNamespace(mode="async_route_v1", action="instruction", artifact_grants=[],
                              body="Files for review.", idempotency_key=key, attachments=[str(path) for path in attachments],
                              wait_for_response=False, response_timeout_seconds=None, reply_to_message_id=None)
        return await self.ns["submit_provider_route_handoff"](ROUTE, req, SimpleNamespace(owner="sender"))

    def stored_copies(self):
        return sorted(path.name for path in self.files.iterdir()) if self.files.exists() else []

    async def test_attachments_land_in_the_recipient_chat_and_read_with_local_paths(self):
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in (self.binary, self.text)}
        receipt = await self.send([self.binary, self.text])
        self.assertEqual((receipt["attachments"], receipt["state"], receipt["duplicate"]), (2, "unread", False))

        files = self.ns["list_session_file_records"]("recipient")
        self.assertEqual(sorted(record["filename"] for record in files), ["notes 中文.md", "raw_data_.bin"])
        self.assertEqual({record["session_id"] for record in files}, {"recipient"})
        # Media & files offers the copy, never a path to the sender's file.
        self.assertFalse(any("source_path" in record for record in files))
        self.assertEqual(self.ns["list_session_file_records"]("sender"), [])

        message = (await self.mail.read())["messages"][0]
        self.assertEqual(message["body"], "Files for review.")
        by_name = {item["filename"]: item for item in message["attachments"]}
        self.assertEqual(set(by_name), {"raw_data_.bin", "notes 中文.md"})
        binary = by_name["raw_data_.bin"]
        self.assertEqual((binary["size"], binary["content_type"], binary["session_id"]),
                         (self.binary.stat().st_size, "application/octet-stream", "recipient"))
        self.assertEqual(by_name["notes 中文.md"]["content_type"], "text/markdown")
        for item, original in ((binary, self.binary), (by_name["notes 中文.md"], self.text)):
            path = Path(item["path"])
            self.assertEqual(path.parent.parent, self.files)
            self.assertEqual(path.read_bytes(), original.read_bytes())
        # The sender's files are only read.
        self.assertEqual({path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before}, before)
        # The ledger row that the inbox list and timeline events decode holds the same entries.
        record = await self.mail.ledger.get(receipt["message_id"])
        self.assertEqual(json.loads(record["attachments_json"]), message["attachments"])
        self.mail.assert_no_execution()

    async def test_same_key_retry_is_answered_from_the_stored_message_without_copying(self):
        first = await self.send([self.binary])
        copies = self.stored_copies()
        self.ns["stage_chat_mail_attachments"] = Mock(side_effect=AssertionError("a retry must not copy again"))
        repeated = await self.send([self.binary])
        self.assertEqual((repeated["message_id"], repeated["duplicate"], repeated["attachments"]),
                         (first["message_id"], True, 1))
        self.assertEqual(self.stored_copies(), copies)

    async def test_limits_and_protected_paths_refuse_before_any_message_or_copy(self):
        size = self.binary.stat().st_size
        self.ns["MAX_CHAT_MAIL_ATTACHMENT_FILE_BYTES"] = size - 1
        with self.assertRaises(HTTPException) as too_large:
            await self.send([self.binary], key="too-large")
        self.assertEqual(too_large.exception.status_code, 413)
        self.ns["MAX_CHAT_MAIL_ATTACHMENT_FILE_BYTES"] = size
        self.ns["MAX_CHAT_MAIL_ATTACHMENT_TOTAL_BYTES"] = size
        with self.assertRaises(HTTPException) as too_much:
            await self.send([self.binary, self.text], key="too-much")
        self.assertEqual(too_much.exception.status_code, 413)
        authority = self.ns["CROSS_CHAT_AUTHORITY_ROOT"] / "run-authority.json"
        authority.parent.mkdir(parents=True)
        authority.write_text("{}")
        with self.assertRaises(HTTPException) as protected:
            await self.send([authority], key="protected")
        self.assertEqual(protected.exception.status_code, 403)
        for bad in (Path("relative.txt"), self.outbox, self.outbox / "missing.bin"):
            with self.subTest(path=str(bad)), self.assertRaises(HTTPException) as refused:
                await self.send([bad], key="bad-path")
            self.assertEqual(refused.exception.status_code, 422)
        self.assertEqual(self.stored_copies(), [])
        with self.mail.ledger._transaction() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM cross_chat_envelopes").fetchone()[0], 0)

    async def test_refused_message_removes_its_staged_copies(self):
        # Storing the message fails after its files were copied.
        with self.mail.ledger._transaction() as connection:
            connection.execute("DROP TABLE chat_mailbox_messages")
        with self.assertRaises(sqlite3.OperationalError):
            await self.send([self.binary])
        self.assertEqual(self.stored_copies(), [])

    async def test_a_failed_copy_is_a_clear_refusal_without_a_message(self):
        self.files.parent.mkdir(parents=True)
        self.files.write_text("not a directory")
        with self.assertRaises(HTTPException) as refused:
            await self.send([self.binary])
        self.assertEqual(refused.exception.status_code, 409)
        with self.mail.ledger._transaction() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM cross_chat_envelopes").fetchone()[0], 0)

    async def test_cancelling_unread_mail_removes_its_files(self):
        receipt = await self.send([self.binary, self.text])
        self.assertEqual(len(self.stored_copies()), 2)
        cancelled = await self.ns["cancel_queued_cross_chat_handoff"](receipt["message_id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.stored_copies(), [])
        self.assertEqual(self.ns["list_session_file_records"]("recipient"), [])

    async def test_mail_to_a_chat_on_another_server_leaves_its_files_to_the_hub_relay(self):
        self.ns["CROSS_SERVER_ROUTES"][ROUTE] = {"route_id": ROUTE}
        self.ns["send_cross_server_mail"] = AsyncMock(return_value={"ok": True})
        await self.send([self.binary])
        self.ns["send_cross_server_mail"].assert_awaited_once()
        self.assertEqual(self.stored_copies(), [])  # nothing is copied into a chat on this server

    def digest(self, path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    async def test_mail_to_another_server_keeps_a_snapshot_with_digests_until_delivery(self):
        attachments = self.ns["stage_cross_server_attachments"](MESSAGE, [str(self.binary), str(self.text)])
        self.assertEqual(attachments, [
            {"filename": "raw_data_.bin", "size": self.binary.stat().st_size, "sha256": self.digest(self.binary),
             "content_type": "application/octet-stream"},
            {"filename": "notes 中文.md", "size": self.text.stat().st_size, "sha256": self.digest(self.text),
             "content_type": "text/markdown"},
        ])
        snapshot = self.ns["cross_server_attachment_dir"]("outbox", MESSAGE) / "0" / "raw_data_.bin"
        self.assertEqual(snapshot.read_bytes(), self.binary.read_bytes())
        self.ns["MAX_CROSS_SERVER_MAIL_ATTACHMENT_BYTES"] = self.binary.stat().st_size
        other = "handoff_" + "d" * 32
        with self.assertRaises(HTTPException) as too_much:
            self.ns["stage_cross_server_attachments"](other, [str(self.binary), str(self.text)])
        self.assertEqual(too_much.exception.status_code, 413)
        self.assertFalse(self.ns["cross_server_attachment_dir"]("outbox", other).exists())
        with self.assertRaises(cross_server_mail.Refused):
            self.ns["cross_server_attachment_dir"]("inbox", "../escape")

    async def upload(self, index: int, chunks: list[bytes], message_id: str = MESSAGE):
        async def stream():
            for chunk in chunks:
                yield chunk
        return await self.ns["put_cross_server_inbox_attachment"](message_id, index, SimpleNamespace(stream=stream))

    def delivered_item(self) -> dict:
        return {"message_id": MESSAGE, "attachments": [
            {"filename": "..raw$data;.bin", "size": self.binary.stat().st_size, "sha256": self.digest(self.binary)},
            {"filename": "notes 中文.md", "size": self.text.stat().st_size, "sha256": self.digest(self.text)},
        ]}

    async def test_files_the_hub_uploaded_become_copies_in_the_receiving_chat(self):
        data = self.binary.read_bytes()
        await self.upload(0, [data[:1000], data[1000:]])
        await self.upload(1, [self.text.read_bytes()])
        inbox = self.ns["cross_server_attachment_dir"]("inbox", MESSAGE)
        copies = await self.ns["receive_cross_server_attachments"](self.delivered_item(), "recipient", inbox)
        self.assertEqual([(copy["filename"], copy["session_id"]) for copy in copies],
                         [("raw_data_.bin", "recipient"), ("notes 中文.md", "recipient")])
        self.assertEqual(Path(copies[0]["path"]).read_bytes(), data)
        self.assertEqual(sorted(record["id"] for record in self.ns["list_session_file_records"]("recipient")),
                         sorted(copy["id"] for copy in copies))

    async def test_an_incomplete_upload_waits_for_the_hubs_next_attempt(self):
        await self.upload(0, [self.binary.read_bytes()[:-1]])
        await self.upload(1, [self.text.read_bytes()])
        inbox = self.ns["cross_server_attachment_dir"]("inbox", MESSAGE)
        with self.assertRaises(HTTPException) as incomplete:
            await self.ns["receive_cross_server_attachments"](self.delivered_item(), "recipient", inbox)
        self.assertEqual(incomplete.exception.status_code, 503)
        self.assertEqual(self.stored_copies(), [])

    async def test_a_redelivered_message_gets_no_second_copies(self):
        stored = await self.send([self.binary])
        before = self.stored_copies()
        item = {**self.delivered_item(), "message_id": stored["message_id"]}
        inbox = self.ns["cross_server_attachment_dir"]("inbox", stored["message_id"])
        self.assertEqual(await self.ns["receive_cross_server_attachments"](item, "recipient", inbox), [])
        self.assertEqual(self.stored_copies(), before)

    async def test_an_upload_is_bounded_and_names_only_its_own_slot(self):
        self.ns["MAX_CROSS_SERVER_MAIL_ATTACHMENT_BYTES"] = 10
        with self.assertRaises(HTTPException) as too_large:
            await self.upload(0, [b"x" * 6, b"x" * 6])
        self.assertEqual(too_large.exception.status_code, 413)
        inbox = self.ns["cross_server_attachment_dir"]("inbox", MESSAGE)
        self.assertEqual(list(inbox.iterdir()), [])  # no partial file is left
        with self.assertRaises(HTTPException) as slot:
            await self.upload(16, [b"x"])
        self.assertEqual(slot.exception.status_code, 404)
        with self.assertRaises(HTTPException) as escape:
            await self.upload(0, [b"x"], message_id="..")
        self.assertEqual(escape.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
