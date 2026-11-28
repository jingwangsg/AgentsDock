"""Cursor CLI import: public exports only, exact native identity, isolated state."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import agent_server as server
import cursor_history
from cursor_agent_client import build_cursor_cmd


def text_event(role, text):
    return {"role": role, "message": {"content": [{"type": "text", "text": text}]}}


def cursor_provider_envelope(prompt, *, memory=None, resumed=False):
    session = {"backend": "cursor", "cwd": "/tmp", "memory_seed": memory or ""}
    manifest = Path("/tmp/preview-fixture-manifest.json")
    if resumed:
        # A conversation that already holds the instructions and the memory: only the prompt is sent.
        session.update(cursor_session_id="resumed", memory_seed_used=True, cursor_instruction_version=server.CURSOR_PROMPT_POLICY_VERSION)
        session["cursor_instruction_hash"] = server.cursor_instruction_hash("sess_preview_fixture", session, manifest)
    return server.build_cursor_provider_prompt("sess_preview_fixture", session, prompt, manifest)[0]


def native_tool_binding():
    name = "plugin-agentsdock-" + "a" * 24 + "-native"
    return (
        "\n\n[AgentsDock tool binding]\n"
        f"For this turn only, use MCP server `{name}`, tool `run` "
        f"(Cursor tool `{name}-run`) for AgentsDock helpers. "
        "This supersedes older helper commands and earlier tool bindings. "
        "No shell fallback, credential lookup, or full-access permission is needed. "
        "Only this top-level agent may call it.\n[End AgentsDock tool binding]"
    )


def store_conversation(directory, prompts):
    """Give a fixture store a conversation in the CLI's layout: content-addressed blobs, a system and a
    context message, then each prompt with its answer, and one root per added message. Returns the id of
    each root by the number of messages it lists."""
    messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "<user_info>context</user_info>"}]
    for number, prompt in enumerate(prompts):
        # The request id and the answer's id keep messages with equal text distinct blobs, as in the CLI's store.
        messages += [
            {"role": "user", "providerOptions": {"cursor": {"requestId": number}}, "content": [
                {"type": "text", "text": f"<timestamp>Saturday, Nov 28, 2026, 2:23 PM (UTC+8)</timestamp>\n<user_query>\n{prompt}\n</user_query>"},
            ]},
            {"role": "assistant", "id": str(number), "content": [{"type": "text", "text": "answer"}]},
        ]
    roots = {}
    with sqlite3.connect(directory / "store.db") as db:
        db.execute("CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB)")

        def put(data):
            blob_id = hashlib.sha256(data).hexdigest()
            db.execute("INSERT INTO blobs VALUES (?, ?)", (blob_id, data))
            return blob_id

        entries = [b"\x0a\x20" + bytes.fromhex(put(json.dumps(message).encode())) for message in messages]
        for count in range(2, len(entries) + 1):
            roots[count] = put(b"".join(entries[:count]) + b"\x50\x01")
        metadata = json.loads(bytes.fromhex(db.execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))
        db.execute("UPDATE meta SET value = ? WHERE key = '0'",
                   (json.dumps({**metadata, "latestRootBlobId": roots[len(entries)]}).encode().hex(),))
    return roots


class CursorFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cursor-import-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / ".cursor"
        self.cwd = self.root / "workspace"
        self.cwd.mkdir()
        self.enterContext(patch.object(Path, "home", return_value=self.root))
        self.enterContext(patch.dict(os.environ, {"CURSOR_CONFIG_DIR": str(self.config), "CURSOR_DATA_DIR": ""}))
        self.enterContext(patch.object(server, "local_claude_session_candidates", return_value=[]))
        self.enterContext(patch.object(server, "local_codex_session_candidates", return_value=[]))
        self.enterContext(patch.object(server, "other_local_instance_provider_keys", return_value=set()))

    def fixture(self, provider_id="native-cursor", *, cwd=None, title="Cursor native title", sidecar=None, metadata=None, events=None):
        cwd = str(cwd or self.cwd)
        bucket = hashlib.md5(cwd.encode(), usedforsecurity=False).hexdigest()
        directory = self.config / "chats" / bucket / provider_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "meta.json").write_text(json.dumps({
            "schemaVersion": 1, "hasConversation": True, "cwd": cwd,
            "updatedAtMs": 1_790_000_000_000, **(sidecar or {}),
        }))
        with sqlite3.connect(directory / "store.db") as db:
            db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT OR REPLACE INTO meta VALUES ('0', ?)", (json.dumps({
                "agentId": provider_id, "name": title, **(metadata or {}),
            }).encode().hex(),))
        transcript = self.config / "projects" / cursor_history.project_slug(cwd) / "agent-transcripts" / provider_id / f"{provider_id}.jsonl"
        transcript.parent.mkdir(parents=True, exist_ok=True)
        records = events if events is not None else [
            text_event("user", "<timestamp>2026-09-20T00:00:00Z</timestamp>\n<user_query>Original question</user_query>"),
            text_event("assistant", "Original answer"),
        ]
        transcript.write_text("".join(json.dumps(event) + "\n" for event in records))
        return directory, transcript


FAKE_ASK_CLI = """#!PYTHON
import json, os, sqlite3, sys, time
from pathlib import Path
config = Path(CONFIG)
copy_id = sys.argv[sys.argv.index('--resume') + 1]
question = sys.stdin.read()
(store,) = config.glob('chats/*/' + copy_id + '/store.db')
agent = json.loads(bytes.fromhex(sqlite3.connect(store).execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))['agentId']
(transcript,) = config.glob('projects/*/agent-transcripts')
(transcript / copy_id).mkdir()
with open(config / 'runs', 'a') as runs:
    runs.write(str(os.getpid()) + chr(10))
if question.endswith('hold'):
    time.sleep(60)
print('progress that is not the result')
print(json.dumps({'type': 'result', 'is_error': 'fail' in question, 'result': json.dumps([agent == copy_id, sys.argv[1:], question])}))
"""


class CursorDiscoveryTests(CursorFixture, unittest.TestCase):
    def test_a_copied_session_is_a_session_of_its_own_and_its_source_is_only_read(self):
        directory, transcript = self.fixture()
        before = {path: path.read_bytes() for path in (directory / "meta.json", directory / "store.db")}
        copy, copy_transcript = cursor_history.copy_session("native-cursor", "copy-1", str(self.cwd))
        self.assertEqual((copy, copy_transcript), (directory.with_name("copy-1"), transcript.parent.with_name("copy-1")))
        with sqlite3.connect(copy / "store.db") as db:
            metadata = json.loads(bytes.fromhex(db.execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))
        self.assertEqual(metadata, {"agentId": "copy-1", "name": "Cursor native title"})
        self.assertEqual((copy / "meta.json").read_bytes(), before[directory / "meta.json"])
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        with self.assertRaises(FileNotFoundError):
            cursor_history.copy_session("missing", "copy-2", str(self.cwd))
        self.assertFalse(directory.with_name("copy-2").exists())

    def test_a_copy_with_a_root_resumes_from_that_root_and_the_source_keeps_its_own(self):
        directory, _transcript = self.fixture()
        roots = store_conversation(directory, ["first prompt", "second prompt"])
        before = (directory / "store.db").read_bytes()
        copy, _copy_transcript = cursor_history.copy_session("native-cursor", "copy-1", str(self.cwd), roots[4])
        self.assertEqual(cursor_history.latest_root_blob_id("copy-1", str(self.cwd)), roots[4])
        self.assertEqual(cursor_history.latest_root_blob_id("native-cursor", str(self.cwd)), roots[6])
        self.assertEqual((directory / "store.db").read_bytes(), before)
        # Every blob is in the copy, so a root recorded for an earlier turn stays usable there.
        self.assertEqual(cursor_history.copy_session("copy-1", "copy-2", str(self.cwd), roots[6])[0], copy.with_name("copy-2"))
        with self.assertRaises(FileNotFoundError):
            cursor_history.copy_session("native-cursor", "copy-3", str(self.cwd), "ab" * 32)
        self.assertFalse(directory.with_name("copy-3").exists())

    def test_a_store_is_read_for_a_rewind_only_while_its_session_can_be_copied(self):
        directory, _transcript = self.fixture()
        roots = store_conversation(directory, ["first prompt"])
        self.assertTrue(cursor_history.has_blob("native-cursor", str(self.cwd), roots[4]))
        self.assertFalse(cursor_history.has_blob("native-cursor", str(self.cwd), "ab" * 32))
        # A copy needs the session's sidecar: without it a rewind could not adopt anything it finds here.
        (directory / "meta.json").unlink()
        for read in (cursor_history.latest_root_blob_id, cursor_history.prompt_roots):
            with self.assertRaises(FileNotFoundError):
                read("native-cursor", str(self.cwd))
        with self.assertRaises(FileNotFoundError):
            cursor_history.has_blob("native-cursor", str(self.cwd), roots[4])
        # Nor is a store behind a symlink read or copied.
        linked, _transcript = self.fixture("linked")
        store_conversation(linked, ["first prompt"])
        (linked / "store.db").rename(self.root / "elsewhere.db")
        (linked / "store.db").symlink_to(self.root / "elsewhere.db")
        for use in (cursor_history.latest_root_blob_id, lambda provider_id, cwd: cursor_history.copy_session(provider_id, "copy-1", cwd)):
            with self.assertRaises(FileNotFoundError):
                use("linked", str(self.cwd))

    def test_metadata_that_names_no_root_is_an_unreadable_store_not_a_chat_without_a_conversation(self):
        # A run records what latest_root_blob_id returns, and "" in that record means the chat had no conversation.
        for number, value in enumerate(("", None, 7)):
            directory, _transcript = self.fixture(f"rootless-{number}")
            store_conversation(directory, ["first prompt"])
            with sqlite3.connect(directory / "store.db") as db:
                db.execute("UPDATE meta SET value = ? WHERE key = '0'", (json.dumps({"latestRootBlobId": value}).encode().hex(),))
            for read in (cursor_history.latest_root_blob_id, cursor_history.prompt_roots):
                with self.subTest(value=value, read=read.__name__), self.assertRaises(ValueError):
                    read(f"rootless-{number}", str(self.cwd))

    def test_each_prompt_is_paired_with_the_one_root_that_lists_the_messages_before_it(self):
        directory, _transcript = self.fixture()
        roots = store_conversation(directory, ["first prompt", "second prompt", "third prompt"])
        # No turn is before the prompt the conversation begins with.
        self.assertEqual(cursor_history.prompt_roots("native-cursor", str(self.cwd)),
                         [("first prompt", ""), ("second prompt", roots[4]), ("third prompt", roots[6])])
        with sqlite3.connect(directory / "store.db") as db:
            # A second root over the same four messages, and no root left over the first six.
            (four,) = db.execute("SELECT data FROM blobs WHERE id = ?", (roots[4],)).fetchone()
            twin = four[:-2] + b"\x50\x02"
            db.execute("INSERT INTO blobs VALUES (?, ?)", (hashlib.sha256(twin).hexdigest(), twin))
            db.execute("DELETE FROM blobs WHERE id = ?", (roots[6],))
        self.assertEqual(cursor_history.prompt_roots("native-cursor", str(self.cwd)),
                         [("first prompt", ""), ("second prompt", None), ("third prompt", None)])

    def test_a_prompt_in_the_opening_place_does_not_begin_the_conversation_when_one_is_before_it(self):
        directory, _transcript = self.fixture()
        roots = store_conversation(directory, ["first prompt", "second prompt"])
        with sqlite3.connect(directory / "store.db") as db:
            # The same store without a context message and without the first answer: system, first prompt,
            # second prompt, its answer. The second prompt stands where a conversation's first one does.
            (six,) = db.execute("SELECT data FROM blobs WHERE id = ?", (roots[6],)).fetchone()
            entries = [six[offset:offset + 34] for offset in range(0, 6 * 34, 34)]
            ids = {}
            for name, listed in (("before the second prompt", [0, 2]), ("latest", [0, 2, 4, 5])):
                data = b"".join(entries[index] for index in listed) + six[6 * 34:]
                ids[name] = hashlib.sha256(data).hexdigest()
                db.execute("INSERT INTO blobs VALUES (?, ?)", (ids[name], data))
            metadata = json.loads(bytes.fromhex(db.execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))
            db.execute("UPDATE meta SET value = ? WHERE key = '0'",
                       (json.dumps({**metadata, "latestRootBlobId": ids["latest"]}).encode().hex(),))
        self.assertEqual(cursor_history.prompt_roots("native-cursor", str(self.cwd)),
                         [("first prompt", None), ("second prompt", ids["before the second prompt"])])

    def test_native_title_and_exact_identity_are_read_only(self):
        directory, transcript = self.fixture()
        paths = [directory / "meta.json", directory / "store.db", transcript]
        before = [path.read_bytes() for path in paths]
        found = server.local_cursor_session_candidates(set())
        self.assertEqual([(row["backend"], row["provider_session_id"], row["label"], row["cwd"]) for row in found],
                         [("cursor", "native-cursor", "Cursor native title", str(self.cwd))])
        self.assertEqual(before, [path.read_bytes() for path in paths])
        self.assertEqual(server.local_cursor_session_candidates({"native-cursor"}), [])

    def test_placeholder_falls_back_to_sidecar_then_human_prompt(self):
        self.fixture(title=" New Agent ", sidecar={"title": "Sidecar title"})
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "Sidecar title")
        self.fixture(title="New Agent")
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "Original question")

    def test_native_title_wins_over_sidecar_and_prompt(self):
        self.fixture(title="Original Cursor name", sidecar={"title": "Stale sidecar name"})
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "Original Cursor name")

    def test_sanitize_before_falling_back_to_sidecar(self):
        for title in (None, 42, "\x00\u200b", "New\u200b Agent", "x" * 4097):
            with self.subTest(title_type=type(title).__name__):
                self.fixture(title=title, sidecar={"title": "Native\x00 sidecar\n title"})
                self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"],
                                 "Native sidecar title")

    def test_cursor_names_are_not_agentsdock_placeholders(self):
        for title in ("New chat", "Untitled", "New session - 2026-09-21"):
            with self.subTest(title=title):
                self.fixture(title=title)
                self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], title)
                self.assertEqual(server.cursor_native_session_title("native-cursor", str(self.cwd)), title)

    def test_fallback_uses_first_human_message_not_internal_or_latest_text(self):
        self.fixture(title="New Agent", events=[
            text_event("user", "Internal context, not a human message"),
            {"role": "user", "message": {"content": [{"type": "tool_result", "content": "Tool result"}]}},
            text_event("assistant", "Earlier assistant content"),
            text_event("user", "<user_query>" + "\n " * 100 + "First request\n continued</user_query>"),
            text_event("assistant", "An answer"),
            text_event("user", "<user_query>Latest request</user_query>"),
        ])
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"],
                         "First request continued")

    def test_preview_is_message_text_not_a_placeholder_title(self):
        for message, expected in (("New chat", "New chat"), ("New Agent", "New Agent"),
                                  ("Fix\x00 the\n issue\u202e", "Fix the issue")):
            with self.subTest(message=message):
                self.fixture(title="New Agent", events=[text_event("user", f"<user_query>{message}</user_query>")])
                candidate = server.local_cursor_session_candidates(set())[0]
                self.assertEqual(candidate["label"], expected)
                self.assertEqual(candidate["cwd"], str(self.cwd))

    def test_no_native_title_or_user_text_uses_identity_not_project(self):
        self.fixture(title="New Agent", events=[text_event("assistant", "Assistant-only export")])
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "Cursor chat native-c")

    def test_identical_previews_in_different_projects_stay_distinct(self):
        other = self.root / "another-project"
        other.mkdir()
        self.fixture("first", title="New Agent")
        self.fixture("second", title="New Agent", cwd=other)
        rows = server.local_cursor_session_candidates(set())
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["label"] for row in rows}, {"Original question"})
        self.assertEqual({row["cwd"] for row in rows}, {str(self.cwd), str(other)})

    def test_actual_server_envelope_is_not_the_first_message_preview(self):
        wrapped = cursor_provider_envelope("Fix the real issue")
        event = text_event("user", f"<user_query>\n{wrapped}\n</user_query>")
        directory, transcript = self.fixture(title="New Agent", events=[event])
        paths = [directory / "store.db", directory / "meta.json", transcript]
        before = [path.read_bytes() for path in paths]
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "Fix the real issue")
        self.assertEqual(server.cursor_history_event_item(event, for_preview=True)["text"], "Fix the real issue")
        # This change is display-only; do not silently alter history projection.
        self.assertTrue(server.cursor_history_event_item(event)["text"].startswith("[AgentsDock provider instructions]"))
        self.assertEqual(before, [path.read_bytes() for path in paths])

    def test_preview_uses_real_prompt_after_length_delimited_memory(self):
        prompt = "[Current user prompt]\nThis marker is part of my example"
        wrapped = cursor_provider_envelope(prompt, memory="Context with [Current user prompt] inside it")
        self.assertEqual(server.cursor_import_user_preview(wrapped), prompt)

    def test_resumed_current_prompt_requires_exact_tool_binding(self):
        wrapped = "[Current user prompt]\nActual request" + native_tool_binding()
        self.assertEqual(server.cursor_import_user_preview(wrapped), "Actual request")
        for malformed in (wrapped.replace("plugin-agentsdock-", "plugin-other-", 1),
                          wrapped.removesuffix("[End AgentsDock tool binding]")):
            self.assertEqual(server.cursor_import_user_preview(malformed), malformed)

    def test_current_prompt_with_generated_authority_suffix(self):
        authority = server.cross_chat_provider_authority_block(
            [], server.cross_chat_authority_path("run_preview_fixture", "a" * 32),
            "sess_preview_fixture", {"publish"}, "blocked", compact=True,
        )
        wrapped = "[Current user prompt]\nActual request" + authority
        self.assertEqual(server.cursor_import_user_preview(wrapped), "Actual request")

    def test_quoted_and_incomplete_envelopes_are_preserved(self):
        valid = cursor_provider_envelope("Actual request")
        for text in (
            "[Current user prompt]\nA native CLI user quotation",
            "Please explain this:\n" + valid,
            "```text\n" + valid + "\n```",
            valid.replace("[End AgentsDock provider instructions]", "[Other footer]"),
            valid.replace("You are operating through AgentsDock, backed by AgentsServer.", "Quoted instructions"),
            cursor_provider_envelope("Actual request", memory="abc").replace("chars=3", "chars=99"),
        ):
            with self.subTest(prefix=text[:35]):
                self.assertEqual(server.cursor_import_user_preview(text), text)

    def test_native_title_wins_even_when_first_message_has_policy(self):
        self.fixture(title="Original name", events=[text_event("user", "<user_query>" + cursor_provider_envelope("Actual request") + "</user_query>")])
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "Original name")

    def test_empty_generated_prompt_does_not_hide_the_first_real_message(self):
        self.fixture(title="New Agent", events=[
            text_event("user", "<user_query>" + cursor_provider_envelope("") + "</user_query>"),
            text_event("user", "<user_query>First real request</user_query>"),
        ])
        self.assertEqual(server.local_cursor_session_candidates(set())[0]["label"], "First real request")

    def test_invalid_entries_do_not_hide_a_valid_main_session(self):
        self.fixture("valid")
        for index, values in enumerate([
            {"sidecar": {"hasConversation": False}}, {"sidecar": {"isSubagent": True}},
            {"sidecar": {"schemaVersion": 2}}, {"metadata": {"subagentInfo": {"parentId": "parent"}}},
            {"metadata": {"agentId": "foreign"}}, {"sidecar": {"cwd": "/wrong-workspace"}},
            {"sidecar": {"cwd": "relative"}}, {"sidecar": {"cwd": "\ud800"}},
            {"cwd": self.root / "deleted-project"},
        ]):
            self.fixture(f"invalid-{index}", **values)
        self.assertEqual([row.provider_id for row in cursor_history.local_sessions()], ["valid"])

    def test_missing_or_corrupt_sources_are_skipped(self):
        for file in ("meta.json", "store.db", "transcript"):
            with self.subTest(file=file):
                directory, transcript = self.fixture()
                target = transcript if file == "transcript" else directory / file
                saved = target.read_bytes()
                target.unlink()
                self.assertEqual(list(cursor_history.local_sessions()), [])
                target.write_bytes(saved)
        (directory / "meta.json").write_text("{" + "x" * cursor_history.MAX_METADATA_BYTES)
        self.assertEqual(list(cursor_history.local_sessions()), [])

    def test_symlinked_transcript_is_not_followed(self):
        _, transcript = self.fixture()
        outside = self.root / "unrelated.jsonl"
        transcript.rename(outside)
        transcript.symlink_to(outside)
        self.assertEqual(list(cursor_history.local_sessions()), [])

    def test_repeated_titles_are_not_identity_and_copied_ids_are_ambiguous(self):
        self.fixture("first")
        self.fixture("second")
        self.assertEqual(len(server.local_cursor_session_candidates(set())), 2)
        another = self.root / "another-workspace"
        another.mkdir()
        self.fixture("first", cwd=another)
        self.assertEqual([row["provider_session_id"] for row in server.local_cursor_session_candidates(set())], ["second"])

    def test_known_and_other_instance_ids_are_removed_before_limit(self):
        self.fixture("owned")
        self.fixture("available", sidecar={"updatedAtMs": 1_780_000_000_000})
        with patch.object(server, "other_local_instance_provider_keys", return_value={("cursor", "owned")}):
            found = server.local_session_candidates(1, set(), include_cursor=True)
        self.assertEqual([row["provider_session_id"] for row in found], ["available"])
        self.assertEqual(server.local_session_candidates(100, set()), [])
        self.assertEqual(server.local_session_candidates(100, {("cursor", "owned"), ("cursor", "available")}, include_cursor=True), [])

    def test_custom_root_keeps_native_home_export_location(self):
        directory, _ = self.fixture()
        custom = self.root / "custom-config"
        custom.mkdir()
        (self.config / "chats").rename(custom / "chats")
        with patch.dict(os.environ, {"CURSOR_CONFIG_DIR": str(custom)}):
            self.assertEqual(len(list(cursor_history.local_sessions())), 1)
            self.assertIsNotNone(cursor_history.find_session(directory.name, str(self.cwd)))

    def test_resume_rejects_wrong_workspace_and_invalid_ids(self):
        self.fixture()
        for provider_id, cwd in (("../native-cursor", str(self.cwd)), ("native-cursor", str(self.root)), ("native-cursor", "\ud800")):
            self.assertIsNone(cursor_history.find_session(provider_id, cwd))

    def test_custom_data_root_is_independent_from_configuration(self):
        self.fixture()
        data = self.root / "native-data"
        data.mkdir()
        (self.config / "projects").rename(data / "projects")
        with patch.dict(os.environ, {"CURSOR_DATA_DIR": str(data)}):
            self.assertEqual(len(list(cursor_history.local_sessions())), 1)
            self.assertEqual(len(server.cursor_initial_history("native-cursor", str(self.cwd))[1]), 2)

    def test_public_projection_preserves_repeats_and_omits_internal_content(self):
        events = [
            text_event("user", "unwrapped runtime context"),
            {"role": "user", "message": {"content": [{"type": "tool_result", "content": "not a user"}]}},
            text_event("user", "<user_query>Quote </user_query> literally</user_query>"),
            text_event("assistant", "Same reply"), text_event("assistant", "Same reply"),
            {"role": "assistant", "message": {"content": [{"type": "thinking", "text": "private"}, {"type": "tool_use", "text": "tool"}]}},
        ]
        self.fixture(events=events)
        _, items = server.cursor_initial_history("native-cursor", str(self.cwd))
        self.assertEqual([(item["kind"], item["text"]) for item in items], [
            ("user", "Quote </user_query> literally"), ("assistant", "Same reply"), ("assistant", "Same reply"),
        ])

    def test_initial_snapshot_ignores_partial_record_and_detects_changes(self):
        _, transcript = self.fixture()
        with transcript.open("ab") as output:
            output.write(b'{"role":"assistant"')
        self.assertEqual(len(server.cursor_initial_history("native-cursor", str(self.cwd))[1]), 2)
        original = server.provider_history_source_snapshot
        def changed(*args):
            result = original(*args)
            with transcript.open("ab") as output:
                output.write(b'changed')
            return result
        with patch.object(server, "provider_history_source_snapshot", side_effect=changed):
            with self.assertRaises(ValueError):
                server.cursor_initial_history("native-cursor", str(self.cwd))


class CursorImportTests(CursorFixture, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        state = self.root / "server-state"
        state.mkdir()
        self.enterContext(patch.object(server, "STATE_DIR", state))
        self.enterContext(patch.object(server, "SESSIONS_FILE", state / "sessions.json"))
        self.store = server.SessionStore()
        self.enterContext(patch.object(server, "STORE", self.store))
        self.enterContext(patch.object(server, "ensure_dirs", side_effect=lambda session_id=None:
            (server.session_dir(session_id) if session_id else state).mkdir(parents=True, exist_ok=True)))
        self.enterContext(patch.object(server, "ensure_codex_thread_not_pending_fork_cleanup"))
        self.fixture()

    def request(self, **kwargs):
        return server.BulkImportSessionsRequest(items=[{
            "provider_session_id": "native-cursor", "backend": "cursor", "cwd": str(self.cwd), **kwargs,
        }])

    async def test_a_canvas_question_is_answered_in_a_copy_of_the_session_deleted_once_its_answer_returns(self):
        directory = self.config / "chats" / hashlib.md5(str(self.cwd).encode(), usedforsecurity=False).hexdigest()
        transcripts = self.config / "projects" / cursor_history.project_slug(str(self.cwd)) / "agent-transcripts"
        before = (directory / "native-cursor" / "store.db").read_bytes()
        script = self.root / "agent"
        script.write_text(FAKE_ASK_CLI.replace("#!PYTHON", "#!" + sys.executable).replace("CONFIG", repr(str(self.config))))
        script.chmod(0o700)
        self.store.sessions["chat"] = {"id": "chat", "backend": "cursor", "cwd": str(self.cwd), "cursor_session_id": "native-cursor", "model": "auto"}
        with patch.object(server, "resolve_cursor_executable", return_value=str(script)):
            handle = await server.create_canvas_comment_side_chat("chat")
            # Cursor has no native replay: the thread's earlier exchange arrives in the question.
            answer = await handle.ask("Question: and then?", history=[{"question": "Question: why?", "response": "Because."}])
            is_own_chat, argv, question = json.loads(answer["answer"])
            self.assertTrue(is_own_chat)
            # Without the copy's id: read-only ask mode on the chat's model.
            self.assertEqual(argv[:4] + argv[5:], ["-p", "--output-format", "json", "--resume", "--trust", "--mode", "ask", "--model", "auto"])
            self.assertEqual(question, "Earlier question in this comment thread:\nQuestion: why?\n\nIts answer:\nBecause.\n\nQuestion: and then?")
            # Nothing of the copy is left, and the chat's store was only read.
            self.assertEqual([path.name for path in directory.iterdir()], ["native-cursor"])
            self.assertEqual([path.name for path in transcripts.iterdir()], ["native-cursor"])
            self.assertEqual((directory / "native-cursor" / "store.db").read_bytes(), before)
            with self.assertRaises(server.side_questions.SideQuestionError) as failed:
                await handle.ask("fail", history=[])
            self.assertEqual(failed.exception.status_code, 503)
            self.assertEqual([path.name for path in directory.iterdir()], ["native-cursor"])
            # Cursor finds a session by its workspace: with the chat's gone, no copy is made to resume elsewhere.
            self.store.sessions["chat"]["cwd"] = str(self.root / "gone")
            with self.assertRaises(server.side_questions.SideQuestionError):
                await handle.ask("Question: why?", history=[])
        self.assertEqual([path.name for path in directory.iterdir()], ["native-cursor"])

    async def test_a_side_chat_asks_each_question_in_a_new_copy_while_the_chats_turn_runs(self):
        directory = self.config / "chats" / hashlib.md5(str(self.cwd).encode(), usedforsecurity=False).hexdigest()
        transcripts = self.config / "projects" / cursor_history.project_slug(str(self.cwd)) / "agent-transcripts"
        script = self.root / "agent"
        script.write_text(FAKE_ASK_CLI.replace("#!PYTHON", "#!" + sys.executable).replace("CONFIG", repr(str(self.config))))
        script.chmod(0o700)
        session = self.store.sessions["chat"] = {"id": "chat", "backend": "cursor", "cwd": str(self.cwd), "cursor_session_id": "native-cursor", "model": "auto"}
        # The chat's own turn runs for the whole side chat.
        turns = {"chat": {"run_id": "run-1", "backend": "cursor"}}
        before = (directory / "native-cursor" / "store.db").read_bytes(), json.dumps(session, sort_keys=True), json.dumps(turns)
        key = ("owner", "chat")
        chats = server.side_questions.SyncedSideChats(self.root / "side.sqlite3", native_factory=server.create_native_side_chat)
        self.addAsyncCleanup(chats.close)
        side_chat = (await chats.snapshot(*key))["side_chat_id"]
        leftovers = lambda: ([path.name for path in directory.iterdir()], [path.name for path in transcripts.iterdir()])

        async def answered(request_id, question, after):
            await chats.submit(*key, request_id, question, side_chat, after)
            await chats.tasks[key]
            exchange = (await chats.snapshot(*key))["exchanges"][-1]
            self.assertEqual((exchange["request_id"], exchange["status"], exchange["backend"]), (request_id, "completed", "cursor"))
            self.assertEqual(exchange["context_note"], "The chat's native session from when the message was sent.")
            return exchange["answer"]

        with patch.object(server, "resolve_cursor_executable", return_value=str(script)), \
                patch.object(server, "CURRENT_TURNS", turns), patch.object(server, "BUSY_SESSIONS", {"chat"}):
            first = await answered("one", "which?", None)
            is_own_chat, argv, question = json.loads(first)
            self.assertTrue(is_own_chat)
            # Read-only ask mode on the chat's model, as for a Canvas question.
            self.assertEqual(argv[:4] + argv[5:], ["-p", "--output-format", "json", "--resume", "--trust", "--mode", "ask", "--model", "auto"])
            self.assertEqual(question, server.SIDE_QUESTION_INSTRUCTION + "Question:\nwhich?")
            # The same request again is the same exchange: no second run.
            await chats.submit(*key, "one", "which?", side_chat)
            # Nothing is kept on the provider's side, so the follow-up carries the earlier exchange.
            second = await answered("two", "and then?", "one")
            self.assertEqual(json.loads(second)[2], server.SIDE_QUESTION_INSTRUCTION
                             + f"Earlier question in this side chat:\nwhich?\n\nYour answer:\n{first}\n\nQuestion:\nand then?")
            self.assertEqual(leftovers(), (["native-cursor"], ["native-cursor"]))
            # A stopped question: its process ends, and its copy and what the run left are deleted.
            await chats.submit(*key, "three", "hold", side_chat, "two")
            for _ in range(500):
                if (self.config / "runs").read_text().count("\n") == 3:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual([len(names) for names in leftovers()], [2, 2])
            held = int((self.config / "runs").read_text().split()[-1])
            self.assertEqual((await chats.cancel(*key, "three"))["exchanges"][-1]["status"], "cancelled")
            self.assertEqual(leftovers(), (["native-cursor"], ["native-cursor"]))
            for _ in range(500):
                try:
                    os.kill(held, 0)
                except ProcessLookupError:
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("The stopped question's CLI still runs")
            # Clear arrives before a delayed question: the question is refused and nothing runs.
            await chats.clear(*key, side_chat)
            with self.assertRaises(server.side_questions.SideQuestionError) as refused:
                await chats.submit(*key, "four", "late", side_chat, "three")
            self.assertEqual(refused.exception.status_code, 409)
            # Another client's credential has a side chat of its own.
            self.assertEqual((await chats.snapshot("other", "chat"))["exchanges"], [])
        self.assertEqual((self.config / "runs").read_text().count("\n"), 3)
        # The chat's native store, its settings and its running turn were not touched.
        self.assertEqual(((directory / "native-cursor" / "store.db").read_bytes(), json.dumps(session, sort_keys=True), json.dumps(turns)), before)
        self.assertEqual(server.read_events("chat"), [])

    async def test_the_side_chat_capability_lists_cursor_only_where_its_cli_is_usable(self):
        # No check has run since the server started (None), or the last one left the CLI's state unknown.
        for status, listed in ((None, ["cursor"]), ("unknown", ["cursor"]), ("ready", ["cursor"]),
                               ("missing", []), ("unauthenticated", []), ("error", [])):
            checked = {"cursor": server.runtime_diagnostic_payload("cursor", status, installed=None, authenticated=None)} if status else {}
            with self.subTest(status=status), patch.dict(server.RUNTIME_DIAGNOSTICS, checked, clear=True), \
                    patch.object(server, "working_tmux_bin", return_value=None):
                capability = (await server.health())["capabilities"]["side_questions"]
            self.assertEqual(capability["backends"], ["codex", "claude", *listed])

    async def test_an_edit_request_runs_in_a_copy_with_the_permission_flags_of_the_chats_turns(self):
        directory = self.config / "chats" / hashlib.md5(str(self.cwd).encode(), usedforsecurity=False).hexdigest()
        transcripts = self.config / "projects" / cursor_history.project_slug(str(self.cwd)) / "agent-transcripts"
        script = self.root / "agent"
        script.write_text(FAKE_ASK_CLI.replace("#!PYTHON", "#!" + sys.executable).replace("CONFIG", repr(str(self.config))))
        script.chmod(0o700)
        self.store.sessions["chat"] = {"id": "chat", "backend": "cursor", "cwd": str(self.cwd), "cursor_session_id": "native-cursor", "model": "auto"}
        prompt = server.agentsdock_canvas.comment_prompt(
            self.root / "report.canvas.tsx", 7, {"canvas_id": "summary", "tag": "td", "text": "loss 2.41", "html": ""},
            "edit", "shorten it", follow_up=False)[0]
        with patch.object(server, "resolve_cursor_executable", return_value=str(script)):
            handle = await server.create_canvas_comment_side_chat("chat")
            # Unattended edits by default; a chat that only plans gets a plan.
            for selected, flags in ((None, ["--trust", "--force"]), ("plan", ["--trust", "--mode", "plan"]), ("default", ["--trust"])):
                self.store.sessions["chat"]["cursor_permission_mode"] = selected
                is_own_chat, argv, question = json.loads((await handle.ask(prompt, history=[]))["answer"])
                self.assertTrue(is_own_chat)
                self.assertEqual(argv[:4] + argv[5:], ["-p", "--output-format", "json", "--resume", *flags, "--model", "auto"])
                self.assertEqual(question, prompt)
        # Nothing of the copies is left.
        self.assertEqual([path.name for path in directory.iterdir()], ["native-cursor"])
        self.assertEqual([path.name for path in transcripts.iterdir()], ["native-cursor"])

    async def test_legacy_and_opt_in_picker(self):
        self.assertEqual((await server.get_local_sessions(limit=100))["sessions"], [])
        self.assertEqual((await server.get_local_sessions(limit=100, include_cursor=True))["sessions"][0]["backend"], "cursor")

    async def test_bulk_import_persists_history_and_native_resume_identity(self):
        results = (await server.bulk_import_sessions_guarded(self.request(), set()))["results"]
        self.assertTrue(results[0]["ok"], results)
        self.assertEqual(results[0]["imported"], 2)
        session = self.store.sessions[results[0]["session_id"]]
        self.assertEqual(session["cursor_session_id"], "native-cursor")
        self.assertEqual(session["cwd"], str(self.cwd))
        self.assertEqual(session["title"], "Cursor native title")
        self.assertNotIn("_history_import_initializing", session)
        command = build_cursor_cmd(session)
        self.assertEqual(command[command.index("--resume") + 1], "native-cursor")
        events = server.read_events(session["id"])
        self.assertEqual([event["prompt"] for event in events if event["type"] == "turn_started"], ["Original question"])
        self.assertEqual([event["text"] for event in events if event["type"] == "assistant_text"], ["Original answer"])
        self.assertEqual(events[-1]["type"], "turn_finished")
        self.assertTrue(events[-1]["imported"])
        self.assertEqual((await server.import_session_history(session, force=True))["imported"], 0)
        again = (await server.bulk_import_sessions_guarded(self.request(), set()))["results"][0]
        self.assertEqual(again["code"], "already_imported")
        self.assertEqual(len(self.store.sessions), 1)
        persisted = json.loads(server.SESSIONS_FILE.read_text())
        self.assertEqual(persisted[session["id"]]["cursor_session_id"], "native-cursor")

    async def test_manual_resume_import_and_explicit_name(self):
        session = await self.store.create(server.CreateSessionRequest(
            backend="cursor", provider_session_id="native-cursor", cwd=str(self.cwd), title="My name",
        ))
        self.assertEqual((await server.import_session_history(session))["imported"], 2)
        self.assertEqual(session["title"], "My name")
        self.assertEqual((await server.import_session_history(session, force=True))["imported"], 0)

    async def test_bulk_import_keeps_unwrapped_picker_title(self):
        self.fixture(title="New Agent", events=[
            text_event("user", "<user_query>" + cursor_provider_envelope("The first actual question") + "</user_query>"),
            text_event("assistant", "An answer"),
        ])
        picker = await server.get_local_sessions(limit=100, include_cursor=True)
        self.assertEqual(picker["sessions"][0]["label"], "The first actual question")
        result = (await server.bulk_import_sessions_guarded(self.request(), set()))["results"][0]
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.store.sessions[result["session_id"]]["title"], "The first actual question")

    async def test_picker_name_is_preserved_on_import_without_generation(self):
        cases = [
            ("Original Cursor name", "Original Cursor name"),
            ("New Agent", "Original question"),
            ("New chat", "New chat"),
            ("Untitled", "Untitled"),
        ]
        with patch.object(server, "generate_session_title", new_callable=AsyncMock) as generate:
            for index, (native_title, expected) in enumerate(cases):
                with self.subTest(title=native_title):
                    provider_id = f"named-cursor-{index}"
                    self.fixture(provider_id, title=native_title)
                    picker = await server.get_local_sessions(limit=100, include_cursor=True)
                    candidate = next(row for row in picker["sessions"] if row["provider_session_id"] == provider_id)
                    self.assertEqual(candidate["label"], expected)
                    request = server.BulkImportSessionsRequest(items=[{
                        "provider_session_id": provider_id, "backend": "cursor", "cwd": str(self.cwd),
                    }])
                    result = (await server.bulk_import_sessions_guarded(request, set()))["results"][0]
                    self.assertTrue(result["ok"], result)
                    session = self.store.sessions[result["session_id"]]
                    self.assertEqual(session["title"], expected)
                    self.assertEqual(session["_title_source"], "manual")
                    self.assertFalse(server.generated_title_eligible(session))
                    persisted = json.loads(server.SESSIONS_FILE.read_text())
                    self.assertEqual(persisted[session["id"]]["title"], expected)
            generate.assert_not_called()

    async def test_foreign_claim_and_changed_workspace_do_not_create_sessions(self):
        result = (await server.bulk_import_sessions_guarded(self.request(), {("cursor", "native-cursor")}))["results"][0]
        self.assertEqual(result["code"], "already_imported")
        result = (await server.bulk_import_sessions_guarded(self.request(cwd=str(self.root)), set()))["results"][0]
        self.assertEqual(result["code"], "candidate_changed")
        self.assertEqual(self.store.sessions, {})

    async def test_failed_staging_rolls_back_only_agentsdock_entry(self):
        with patch.object(server, "append_staged_imported_history", side_effect=OSError("test write failure")):
            result = (await server.bulk_import_sessions_guarded(self.request(), set()))["results"][0]
        self.assertEqual(result["code"], "import_failed")
        self.assertEqual(self.store.sessions, {})
        self.assertIsNotNone(cursor_history.find_session("native-cursor", str(self.cwd)))

    async def test_empty_export_creates_no_chat(self):
        self.fixture(events=[])
        result = (await server.bulk_import_sessions_guarded(self.request(), set()))["results"][0]
        self.assertEqual(result["code"], "no_messages")
        self.assertEqual(self.store.sessions, {})
