"""Chat mail attachments through the actual send, read and cancel handlers on synthetic state; never import the server."""
from __future__ import annotations

import ast
from copy import deepcopy
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
import uuid

from tests import test_chat_mailbox_runtime_isolated as mailbox_fixture
from tests.test_chat_mailbox_runtime_isolated import HTTPException, ROUTE


FUNCTIONS = {
    "stage_chat_mail_attachments", "provider_team_attachment_paths", "prepare_artifact_records", "artifact_record",
    "remove_artifact_records", "remove_artifact_records_async", "safe_name", "guess_content_type",
    "effective_content_type", "copy_fork_file_data", "list_session_file_records", "cancel_queued_cross_chat_handoff",
}
CONSTANTS = {"CHAT_MAIL_ATTACHMENT_MAX_FILE_BYTES", "CHAT_MAIL_ATTACHMENT_MAX_TOTAL_BYTES", "PROVIDER_TEAM_ATTACHMENT_LIMIT"}


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
        self.assertEqual(self.ns["list_session_file_records"]("sender"), [])

        message = (await self.mail.read())["messages"][0]
        self.assertEqual(message["body"], "Files for review.")
        by_name = {item["filename"]: item for item in message["attachments"]}
        self.assertEqual(set(by_name), {"raw_data_.bin", "notes 中文.md"})
        binary = by_name["raw_data_.bin"]
        self.assertEqual((binary["size"], binary["content_type"], binary["session_id"]),
                         (256 * 64, "application/octet-stream", "recipient"))
        self.assertEqual(by_name["notes 中文.md"]["content_type"], "text/markdown")
        for item, original in ((binary, self.binary), (by_name["notes 中文.md"], self.text)):
            path = Path(item["path"])
            self.assertEqual(path.parent.parent, self.files)
            self.assertEqual(path.read_bytes(), original.read_bytes())
        # The sender's files are only read.
        self.assertEqual({path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before}, before)
        # The inbox list the desktop renders carries the same entries.
        record = await self.mail.ledger.get(receipt["message_id"])
        self.assertEqual(json.loads(record["attachments_json"]), message["attachments"])
        self.mail.assert_no_execution()

    async def test_retry_keeps_one_copy_and_a_changed_file_conflicts(self):
        first = await self.send([self.binary])
        copies = self.stored_copies()
        repeated = await self.send([self.binary])
        self.assertEqual((repeated["message_id"], repeated["duplicate"], repeated["attachments"]),
                         (first["message_id"], True, 1))
        self.assertEqual(self.stored_copies(), copies)
        with self.assertRaises(HTTPException) as conflict:
            await self.send([self.text])
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(self.stored_copies(), copies)

    async def test_limits_and_protected_paths_refuse_before_any_message_or_copy(self):
        self.ns["CHAT_MAIL_ATTACHMENT_MAX_FILE_BYTES"] = 1024
        with self.assertRaises(HTTPException) as too_large:
            await self.send([self.binary], key="too-large")
        self.assertEqual(too_large.exception.status_code, 413)
        self.ns["CHAT_MAIL_ATTACHMENT_MAX_FILE_BYTES"] = 256 * 64
        self.ns["CHAT_MAIL_ATTACHMENT_MAX_TOTAL_BYTES"] = 256 * 64
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
        with self.mail.ledger._transaction() as connection:
            connection.execute("DROP TABLE chat_mailbox_messages")
        with self.assertRaises(Exception):
            await self.send([self.binary])
        self.assertEqual(self.stored_copies(), [])

    async def test_cancelling_unread_mail_removes_its_files(self):
        receipt = await self.send([self.binary, self.text])
        self.assertEqual(len(self.stored_copies()), 2)
        cancelled = await self.ns["cancel_queued_cross_chat_handoff"](receipt["message_id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.stored_copies(), [])
        self.assertEqual(self.ns["list_session_file_records"]("recipient"), [])

    async def test_a_chat_on_another_server_refuses_attachments(self):
        self.ns["CROSS_SERVER_ROUTES"][ROUTE] = {"route_id": ROUTE}
        self.ns["send_cross_server_mail"] = AsyncMock()
        with self.assertRaises(HTTPException) as refused:
            await self.send([self.binary])
        self.assertEqual(refused.exception.status_code, 409)
        self.ns["send_cross_server_mail"].assert_not_awaited()
        self.assertEqual(self.stored_copies(), [])


if __name__ == "__main__":
    unittest.main()
