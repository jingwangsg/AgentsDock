"""Exercise Gemini's stream-json contract through the guarded subprocess and Stop path."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import agent_server as server
import gemini_agent_client as gemini


CLI = """#!PYTHON
import hashlib, json, os, sys, time
from pathlib import Path

def emit(**fields):
    print(json.dumps(fields), flush=True)

prompt = sys.stdin.read()
mode = prompt.split('[Current user prompt]' + chr(10))[-1].splitlines()[0]
flag = '--resume' if '--resume' in sys.argv else '--session-id'
session = sys.argv[sys.argv.index(flag) + 1]
Path('child.pid').write_text(str(os.getpid()))
if mode == 'trust':
    print('Gemini CLI is not running in a trusted directory. SECRET-STDERR', file=sys.stderr)
    sys.exit(55)
emit(type='init', session_id=session)
emit(type='message', role='user', content='SECRET-USER-ECHO')
if mode in ('failure', 'bad-stream'):
    print('SECRET-STDERR' * 20000, file=sys.stderr)
    if mode == 'failure':
        emit(type='result', status='error', error={'message':'The NVIDIA Inference Hub budget for this credential is exhausted. SECRET'})
    else:
        print('SECRET-BAD-STREAM', flush=True)
    sys.exit(1)
if mode == 'copy':
    # A resumed copy answers with what its own records and argv say.
    project = Path(os.environ.get('GEMINI_CLI_HOME') or os.environ['HOME']) / '.gemini/tmp/workspace'
    (copy,) = [path for path in (project / 'chats').iterdir() if path.name.endswith('-' + session[:8] + '.jsonl')]
    header, question = [json.loads(line) for line in copy.read_text().splitlines()]
    (project / 'tool-outputs' / ('session-' + session)).mkdir(parents=True)
    emit(type='message', role='assistant', delta=True, content=json.dumps(
        [header['sessionId'] == session, question['id'], sys.argv[sys.argv.index('--approval-mode') + 1], '--include-directories' in sys.argv]))
    emit(type='result', status='success', stats={'total_tokens':1, 'input_tokens':1, 'output_tokens':0, 'cached':0})
    sys.exit(0)
if mode != 'no-history':
    native = Path(os.environ.get('GEMINI_CLI_HOME') or os.environ['HOME']) / '.gemini/tmp/workspace'
    chats = native / 'chats'
    chats.mkdir(parents=True, exist_ok=True)
    cwd = str(Path.cwd().resolve())
    (native / '.project_root').write_text(cwd)
    (chats / f'session-test-{session[:8]}.jsonl').write_text(json.dumps({
        'sessionId': session, 'kind': 'main', 'projectHash': hashlib.sha256(cwd.encode()).hexdigest()
    }) + chr(10) + json.dumps({'id':'user-turn','type':'user','content':prompt}) + chr(10))
    if mode == 'large-history':
        with (chats / f'session-test-{session[:8]}.jsonl').open('a') as transcript:
            for i in range(4):
                transcript.write(json.dumps({'id': f'reply-{i}', 'type': 'gemini', 'content': 'A',
                                             'toolCalls': [{'resultDisplay': 'x' * (17 * 1024 * 1024)}]}) + chr(10))
emit(type='message', role='assistant', content='A', delta=True)
if mode == 'wait':
    emit(type='tool_use', tool_name='read_file', tool_id='read_file__read_file_1_0', parameters={'file_path':'marker.txt'})
    while not Path('continue').exists():
        time.sleep(.01)
    emit(type='tool_result', tool_id='read_file__read_file_1_0', status='success', output='')
if mode == 'delta':
    key = os.environ['GEMINI_API_KEY']
    for chunk in (' ', 'A', key[:20], key[20:]):
        emit(type='message', role='assistant', content=chunk, delta=True)
emit(type='result', status='success', stats={'total_tokens':23, 'input_tokens':15, 'output_tokens':8, 'cached':3})
"""


class GeminiRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.script = self.root / "gemini"
        self.script.write_text(CLI.replace("#!PYTHON", "#!" + sys.executable))
        self.script.chmod(0o700)
        self.sid = "gemini-" + str(uuid4())
        self.session = {"id": self.sid, "backend": "gemini", "cwd": str(self.root),
                        "_gemini_executable": str(self.script), "_gemini_default_model": gemini.DEFAULT_MODEL}
        self.enterContext(patch.dict(os.environ, {"HOME": str(self.root / "home"),
            "GEMINI_CLI_HOME": str(self.root / "home"), "GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(self.root / "system.json")}))
        self.enterContext(patch.multiple(server, STATE_DIR=self.root / "state", SESSIONS_FILE=self.root / "sessions.json",
                                        CONFIG_ENV_FILE=self.root / "config/config.env", HUB_PROVIDER_INSTALL=None,
                                        ACTIVE={}, CURRENT_TURNS={}, BUSY_SESSIONS=set(), STOPPED_RUNS=set(),
                                        STOP_REQUESTS=set(), CROSS_CHAT_AUTHORITY_ROOT=self.root / "authority", CROSS_CHAT_CAPABILITIES={}, CROSS_CHAT=server.CrossChatStore(self.root / "cross-chat.sqlite"), QUEUED_TURNS={}, RUN_NOW_TURNS={}))
        self.enterContext(patch.object(server.STORE, "sessions", {self.sid: self.session}))

        await server.CROSS_CHAT.initialize()

    def run_turn(self, prompt, *, standalone=False, run_id=None):
        run_id = run_id or str(uuid4())
        server.BUSY_SESSIONS.add(self.sid)
        server.CURRENT_TURNS[self.sid] = {"run_id": run_id, "backend": "gemini", "prompt": prompt}
        task = asyncio.create_task(server.run_gemini(
            self.sid, run_id, prompt, self.session.copy(), self.root / "manifest.json",
            standalone_provider_context=standalone,
        ))
        return run_id, task

    def events(self, run_id):
        path = server.events_path(self.sid)
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        return [row for row in rows if row.get("run_id") == run_id]

    async def wait_for_tool(self, run_id, task):
        for _ in range(500):
            if task.done():
                await task
                self.fail(str([e.get("message") for e in self.events(run_id) if e["type"] == "error"]))
            if any(e["type"] == "tool_started" for e in self.events(run_id)):
                return
            await asyncio.sleep(.01)
        self.fail("Gemini test tool did not start")

    async def test_tool_permissions_default_to_full_access_and_respect_explicit_modes(self):
        for selected, expected in ((None, "yolo"), ("plan", "plan"), ("default", "default")):
            with self.subTest(selected=selected):
                if selected is not None:
                    self.session["gemini_permission_mode"] = selected
                run, task = self.run_turn("ok")
                await task
                argv = next(e["argv"] for e in self.events(run) if e["type"] == "process_started")
                self.assertEqual(argv[argv.index("--approval-mode") + 1], expected)

    async def test_streamed_content_usage_repeated_text_and_native_resume(self):
        run, task = self.run_turn("delta")
        await task
        events = self.events(run)
        text = [e for e in events if e["type"] == "assistant_text"]
        self.assertEqual("".join(e["text"] for e in text), "A A[redacted]")
        self.assertEqual(len({e["item_id"] for e in text}), 1)
        self.assertTrue(all(e["delta"] for e in text))
        self.assertNotIn("SECRET-USER-ECHO", str(events))
        terminal = events[-1]
        self.assertFalse(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "A A[redacted]")
        self.assertEqual([terminal[k] for k in ("total_tokens", "input_tokens", "output_tokens", "cached_input_tokens")],
                         [23, 15, 8, 3])
        native_id = self.session["gemini_session_id"]
        for standalone in (False, True):
            run, task = self.run_turn("ok", standalone=standalone)
            await task
            events = self.events(run)
            argv = next(e["argv"] for e in events if e["type"] == "process_started")
            self.assertIn("--session-id" if standalone else "--resume", argv)
            self.assertEqual(native_id in argv, not standalone)
            self.assertEqual(self.session["gemini_session_id"], native_id)

    async def test_first_turn_with_a_large_native_transcript_keeps_its_result_and_native_id(self):
        # Each record is above 16 MiB and the file above 64 MiB: the limits that rejected a real 96 MiB transcript.
        run, task = self.run_turn("large-history")
        await task
        terminal = self.events(run)[-1]
        self.assertEqual((terminal["is_error"], terminal["result_text"]), (False, "A"))
        self.assertTrue(self.session["gemini_session_id"])

    async def test_a_canvas_question_is_answered_in_a_copy_of_the_session_deleted_once_its_answer_returns(self):
        _, task = self.run_turn("ok")
        await task
        project = self.root / "home/.gemini/tmp/workspace"
        (original,) = (project / "chats").iterdir()
        before = original.read_bytes()
        runtime = {"_executable": str(self.script), "_gemini_models": [gemini.DEFAULT_MODEL]}
        with patch.object(server, "ensure_runtime_available", AsyncMock(return_value=runtime)):
            answer = await server.CopiedSessionSideChat(self.sid).ask("copy", history=[])
            # The copy carried the session's records under its own id, and the CLI ran without write tools.
            self.assertEqual(json.loads(answer["answer"]), [True, "user-turn", "default", True])
            self.assertEqual(answer["backend"], "gemini")
            # Nothing of the copy is left, and the chat's session was only read.
            self.assertEqual(list((project / "chats").iterdir()), [original])
            self.assertEqual(list((project / "tool-outputs").iterdir()), [])
            self.assertEqual(original.read_bytes(), before)
            with self.assertRaises(server.side_questions.SideQuestionError) as failed:
                await server.CopiedSessionSideChat(self.sid).ask("failure", history=[])
        self.assertEqual(failed.exception.status_code, 503)
        self.assertEqual(list((project / "chats").iterdir()), [original])

    async def test_an_edit_request_runs_in_a_copy_in_the_chats_permission_mode_deleted_once_its_answer_returns(self):
        _, task = self.run_turn("ok")
        await task
        project = self.root / "home/.gemini/tmp/workspace"
        (original,) = (project / "chats").iterdir()
        before = original.read_bytes()
        runtime = {"_executable": str(self.script), "_gemini_models": [gemini.DEFAULT_MODEL]}
        with patch.object(server, "ensure_runtime_available", AsyncMock(return_value=runtime)):
            for selected, expected in ((None, "yolo"), ("plan", "plan"), ("default", "default")):
                self.session["gemini_permission_mode"] = selected
                answer = await server.CopiedSessionSideChat(self.sid).ask("copy", history=[], edit=True)
                self.assertEqual(json.loads(answer["answer"]), [True, "user-turn", expected, True])
        self.assertEqual(list((project / "chats").iterdir()), [original])
        self.assertEqual(list((project / "tool-outputs").iterdir()), [])
        self.assertEqual(original.read_bytes(), before)

    async def test_a_question_stopped_while_its_session_is_copied_leaves_no_copy(self):
        _, task = self.run_turn("ok")
        await task
        chats = self.root / "home/.gemini/tmp/workspace/chats"
        copied, release = threading.Event(), threading.Event()
        copy_session = server.gemini_history.copy_session

        def slow_copy(session, copy_id):
            paths = copy_session(session, copy_id)
            copied.set()
            release.wait(5)
            return paths

        runtime = {"_executable": str(self.script), "_gemini_models": [gemini.DEFAULT_MODEL]}
        with patch.object(server, "ensure_runtime_available", AsyncMock(return_value=runtime)), \
                patch.object(server.gemini_history, "copy_session", slow_copy):
            asking = asyncio.create_task(server.CopiedSessionSideChat(self.sid).ask("copy", history=[]))
            await asyncio.to_thread(copied.wait, 5)
            self.assertEqual(len(list(chats.iterdir())), 2)
            # The worker thread still holds the copy when the question is stopped.
            asking.cancel()
            await asyncio.gather(asking, return_exceptions=True)
            release.set()
            for _ in range(500):
                if len(list(chats.iterdir())) == 1:
                    break
                await asyncio.sleep(0.01)
        self.assertEqual(len(list(chats.iterdir())), 1)

    async def test_a_native_side_chat_gets_the_threads_earlier_exchanges_where_it_does_not_replay_them(self):
        asked = []

        class Native:
            async def ask(self, question, *, history, on_step=None):
                asked.append((question, history))
                return {"answer": "A"}

            async def close(self):
                pass

        history = [{"question": "Question: why?", "response": "Because."}]
        with patch.object(server, "create_native_side_chat", AsyncMock(return_value=Native())) as native:
            for backend in ("claude", "codex"):
                with patch.dict(server.STORE.sessions, {"probe": {"backend": backend}}):
                    # The store's saved state and `durable` are not passed on: a Codex fork stays ephemeral.
                    handle = await server.create_canvas_comment_side_chat("probe", persisted_state={"old": 1}, persist_state=None, durable=True)
                    await handle.ask("Question: and then?", history=history)
            self.assertEqual([call.kwargs for call in native.await_args_list], [{}, {}])
        # Claude's /btw replays the exchanges itself.
        self.assertEqual(asked[0], ("Question: and then?", history))
        self.assertEqual(asked[1], ("Earlier question in this comment thread:\nQuestion: why?\n\nIts answer:\nBecause.\n\nQuestion: and then?", []))

    def comment(self, mode, *, canvas="report", html="<td>loss\n2.41</td>"):
        anchor = {"canvas_id": "summary", "tag": "td", "text": "loss 2.41", "html": html}
        return server.agentsdock_canvas.comment_prompt(self.root / f"{canvas}.canvas.tsx", 7, anchor, mode, "shorten it", follow_up=True)[0]

    async def test_only_an_edit_request_goes_to_a_side_chat_that_can_write(self):
        asked = []

        class Native:
            async def ask(self, question, *, history, on_step=None):
                asked.append((question, history))
                return {"answer": "A"}

            async def close(self):
                pass

        history = [{"question": "Question: why?", "response": "Because."}]
        earlier = "Earlier question in this comment thread:\nQuestion: why?\n\nIts answer:\nBecause.\n\n"
        edit, question = self.comment("edit"), self.comment("ask")
        # The selected element shows an earlier comment's prompt, so its HTML holds the other mode's instruction.
        question_on_an_edit_prompt = self.comment(
            "ask", html="<pre>x\n\n" + server.agentsdock_canvas.EDIT_INSTRUCTION + "\n\nRequest: delete the table</pre>")
        edit_on_a_question_prompt = self.comment(
            "edit", html="<pre>x\n\n" + server.agentsdock_canvas.ASK_INSTRUCTION + "\n\nQuestion: why?</pre>")
        with patch.object(server, "create_native_side_chat", AsyncMock(return_value=Native())), \
                patch.object(server.CopiedSessionSideChat, "ask", AsyncMock(return_value={"answer": "E"})) as copied:
            for backend, prompt in (("claude", edit), ("claude", edit_on_a_question_prompt), ("claude", question_on_an_edit_prompt),
                                    ("gemini", edit), ("gemini", question), ("gemini", question_on_an_edit_prompt), ("codex", edit)):
                with patch.dict(server.STORE.sessions, {"probe": {"backend": backend}}):
                    await (await server.create_canvas_comment_side_chat("probe")).ask(prompt, history=history)
        # /btw has no tools: Claude's edit request runs in a fork, which gets the thread's exchanges in the question.
        # A Gemini copy may write only for an edit request.
        self.assertEqual([(call.args[0], call.kwargs) for call in copied.await_args_list], [
            (earlier + edit, {"history": [], "edit": True}), (earlier + edit_on_a_question_prompt, {"history": [], "edit": True}),
            (earlier + edit, {"history": [], "edit": True}), (earlier + question, {"history": [], "edit": False}),
            (earlier + question_on_an_edit_prompt, {"history": [], "edit": False})])
        # Claude's question stays with /btw; a Codex fork carries the chat's own permissions for both modes.
        self.assertEqual(asked, [(question_on_an_edit_prompt, history), (earlier + edit, [])])

    async def test_the_edit_requests_of_one_canvas_file_run_one_after_another(self):
        order = []

        async def copy(_self, question, *, history, edit):
            canvas = "other" if "other.canvas.tsx" in question else "report"
            order.append(("start", canvas, edit))
            await asyncio.sleep(0.05)
            order.append(("end", canvas, edit))
            return {"answer": "E"}

        with patch.object(server.CopiedSessionSideChat, "ask", copy), patch.dict(server.STORE.sessions, {"probe": {"backend": "gemini"}}):
            handle = await server.create_canvas_comment_side_chat("probe")
            await asyncio.gather(*(handle.ask(prompt, history=[]) for prompt in (
                self.comment("edit"), self.comment("edit"), self.comment("ask"), self.comment("edit", canvas="other"))))
        # Two copies that changed one canvas file at once lost a change: the file's second edit request waits for
        # the first, while a question and another file's edit request start at once.
        self.assertEqual(order[:3], [("start", "report", True), ("start", "report", False), ("start", "other", True)])
        self.assertEqual(order[-2:], [("start", "report", True), ("end", "report", True)])
        # A file's lock is kept only while one of its edit requests runs or waits.
        self.assertEqual(len(server.CANVAS_EDIT_LOCKS), 0)

    async def test_a_codex_fork_without_an_answer_ends_at_the_time_bound_and_frees_the_canvas_file(self):
        class Native:
            async def ask(self, question, *, history, on_step=None):
                await asyncio.Event().wait()  # as a fork that waits for an approval nobody gives

            async def close(self):
                pass

        with patch.object(server, "create_native_side_chat", AsyncMock(return_value=Native())), \
                patch.object(server, "CANVAS_COMMENT_SIDE_CHAT_SECONDS", 0.05), \
                patch.dict(server.STORE.sessions, {"probe": {"backend": "codex"}}):
            handle = await server.create_canvas_comment_side_chat("probe")
            started = asyncio.get_running_loop().time()
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(handle.ask(self.comment("edit"), history=[]), 5)
            self.assertLess(asyncio.get_running_loop().time() - started, 2)
        self.assertEqual(len(server.CANVAS_EDIT_LOCKS), 0)

    def test_a_copied_session_leaves_out_a_record_still_being_appended_and_renames_only_the_session(self):
        native_id, copy_id = str(uuid4()), str(uuid4())
        chats = self.root / "chats"
        chats.mkdir()
        path = chats / f"session-test-{native_id[:8]}.jsonl"
        records = [{"sessionId": native_id, "kind": "main"}, {"id": "a", "type": "user", "content": "about " + native_id},
                   {"$set": {"sessionId": native_id, "lastUpdated": "t"}}]
        path.write_text("".join(json.dumps(row) + "\n" for row in records) + '{"id": "b", "type": "gem')
        copy, *_ = server.gemini_history.copy_session(server.gemini_history.Session(native_id, str(self.root), path, 0, 0), copy_id)
        copied = [json.loads(line) for line in copy.read_text().splitlines()]
        self.assertEqual(copy.name, f"session-copy-{copy_id[:8]}.jsonl")
        self.assertEqual(copied, [{"sessionId": copy_id, "kind": "main"}, records[1], {"$set": {"sessionId": copy_id, "lastUpdated": "t"}}])

    def test_a_canvas_question_gets_a_side_chat_only_where_a_copy_of_the_chat_can_answer(self):
        def available(session, prompt="why?"):
            with patch.dict(server.STORE.sessions, {"probe": session}):
                return server.canvas_comment_side_chat_available("probe", prompt)

        with patch.object(server, "CLAUDE_TRANSPORT", server.CLAUDE_TRANSPORT_AGENT_SDK), \
                patch.object(server, "claude_sdk_dependency_available", return_value=True):
            for backend, native in (("codex", "codex_thread_id"), ("claude", "claude_session_id"),
                                    ("gemini", "gemini_session_id"), ("cursor", "cursor_session_id")):
                with self.subTest(backend=backend):
                    self.assertTrue(available({"backend": backend, native: "native-1"}))
                    # Nothing to copy before the chat's native conversation starts.
                    self.assertFalse(available({"backend": backend}))
            self.assertFalse(available({"backend": "opencode", "opencode_session_id": "native-1"}))
            limit = server.side_questions.MAX_QUESTION_CHARS
            self.assertFalse(available({"backend": "claude", "claude_session_id": "native-1"}, "x" * (limit + 1)))
            self.assertTrue(available({"backend": "gemini", "gemini_session_id": "native-1"}, "x" * (limit + 1)))
            with patch.object(server, "CLAUDE_TRANSPORT", server.CLAUDE_TRANSPORT_PRINT):
                self.assertFalse(available({"backend": "claude", "claude_session_id": "native-1"}))

    def test_a_claude_edit_request_gets_a_side_chat_only_for_a_chat_with_full_access(self):
        def available(session, prompt, *, cli_keeps_the_fork_in_memory=True):
            with patch.dict(server.STORE.sessions, {"probe": session}), \
                    patch.object(server, "claude_supports_no_session_persistence", return_value=cli_keeps_the_fork_in_memory):
                return server.canvas_comment_side_chat_available("probe", prompt)

        edit, question = self.comment("edit"), self.comment("ask")
        claude = {"backend": "claude", "claude_session_id": "native-1"}
        with patch.object(server, "CLAUDE_TRANSPORT", server.CLAUDE_TRANSPORT_AGENT_SDK), \
                patch.object(server, "claude_sdk_dependency_available", return_value=True):
            # A chat's default mode is full access.
            self.assertTrue(available(claude, edit))
            self.assertTrue(available({**claude, "claude_permission_mode": "bypassPermissions"}, edit))
            for mode in ("plan", "dontAsk", "auto", "default", "acceptEdits"):
                with self.subTest(mode=mode):
                    # The fork would run with full access, so the edit request starts a turn in the chat's mode.
                    self.assertFalse(available({**claude, "claude_permission_mode": mode}, edit))
                    # /btw has no tools.
                    self.assertTrue(available({**claude, "claude_permission_mode": mode}, question))
            # A CLI without the flag would write the fork's transcript beside the chat's.
            self.assertFalse(available(claude, edit, cli_keeps_the_fork_in_memory=False))
            self.assertTrue(available(claude, question, cli_keeps_the_fork_in_memory=False))
            # The other backends' copies run with the chat's own permissions.
            for backend, native, mode in (("codex", "codex_thread_id", "codex_approval_policy"),
                                          ("gemini", "gemini_session_id", "gemini_permission_mode"), ("cursor", "cursor_session_id", "cursor_permission_mode")):
                self.assertTrue(available({"backend": backend, native: "native-1", mode: "plan"}, edit))

    async def test_canvas_contract_is_scoped_to_the_chat_and_kept_out_of_imported_prompts(self):
        run, task = self.run_turn("Create a Canvas")
        await task
        directory = server.STATE_DIR / "canvases" / self.sid
        self.assertTrue((directory / "AUTHORING.md").is_file())
        self.assertTrue((directory / "sdk.d.ts").is_file())
        argv = next(e["argv"] for e in self.events(run) if e["type"] == "process_started")
        self.assertEqual(argv[argv.index("--include-directories") + 1], str(directory))
        source, items = server.gemini_initial_history(self.session["gemini_session_id"], str(self.root))
        self.assertIn(str(directory / "AUTHORING.md"), source.read_text())
        self.assertEqual(items, [{"kind": "user", "text": "Create a Canvas"}])

    async def test_history_import_projects_only_the_user_prompt(self):
        self.session.update(memory_seed="PRIVATE MEMORY", system_prompt="PRIVATE INSTRUCTIONS")
        _, task = self.run_turn("original user message")
        await task
        provider_id = server.STORE.sessions[self.sid]["gemini_session_id"]
        source, items = server.gemini_initial_history(provider_id, str(self.root))
        self.assertIn("PRIVATE MEMORY", source.read_text())
        self.assertIn("PRIVATE INSTRUCTIONS", source.read_text())
        self.assertEqual(items, [{"kind": "user", "text": "original user message"}])

    async def test_failure_after_init_preserves_retry_and_redacts_stderr(self):
        for prompt, message in (("failure", "budget"), ("bad-stream", "invalid stream"), ("trust", "Trust folder"),
                                ("no-history", "without saving")):
            run, task = self.run_turn(prompt)
            await task
            events = self.events(run)
            terminal = events[-1]
            self.assertTrue(terminal["is_error"])
            self.assertIn(message, terminal["message"])
            self.assertNotIn("SECRET", str(events))
            self.assertNotIn("gemini_session_id", self.session)
            self.assertNotIn(self.sid, server.BUSY_SESSIONS)
        run, task = self.run_turn("ok")
        await task
        self.assertFalse(self.events(run)[-1]["is_error"])

    async def test_stop_and_cancellation_reap_child_and_close_partial_tool(self):
        for cancel in (False, True):
            run, task = self.run_turn("wait")
            try:
                await self.wait_for_tool(run, task)
                events = self.events(run)
                self.assertEqual([e["type"] for e in events][-2:], ["assistant_text", "tool_started"])
                guard_pid = server.ACTIVE[self.sid]["pid"]
                cli_pid = int((self.root / "child.pid").read_text())
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(task, 8)
                else:
                    stop = await asyncio.wait_for(server.stop_turn(
                        self.sid, schedule_queue=False, cascade_codex_subagents=False, cascade_claude_subagents=False,
                    ), 8)
                    self.assertTrue(stop["stopped"])
                    await asyncio.wait_for(task, 8)
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            events = self.events(run)
            terminal = [e for e in events if e["type"] == "turn_finished"]
            self.assertEqual(len(terminal), 1)
            self.assertTrue(terminal[0]["stopped"])
            self.assertFalse(terminal[0]["is_error"])
            self.assertEqual([e["tool_id"] for e in events if e["type"] in ("tool_started", "tool_finished")],
                             ["read_file__read_file_1_0"] * 2)
            self.assertNotIn(self.sid, server.ACTIVE)
            self.assertNotIn(self.sid, server.BUSY_SESSIONS)
            for pid in (guard_pid, cli_pid):
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    async def test_helper_authority_requires_exact_gemini_process_and_run(self):
        run = "run_" + uuid4().hex
        grant = await server.issue_cross_chat_capability(self.sid, run, [], actions={"publish"})
        self.assertTrue(grant)
        _, task = self.run_turn("wait", run_id=run)
        try:
            await self.wait_for_tool(run, task)
            owner = server.ACTIVE[self.sid]["cursor_mcp_owner_token"]
            for token, run_id in (("wrong-owner", run), (owner, "different-run")):
                with self.assertRaises(server.ProviderToolError):
                    await server.provider_tool_capability_snapshot(
                        self.sid, run_id, backend="gemini", cursor_owner_token=token,
                    )
            path, _ = await server.provider_tool_capability_snapshot(
                self.sid, run, backend="gemini", cursor_owner_token=owner,
            )
            self.assertEqual(path, grant)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        with self.assertRaises(server.ProviderToolError):
            await server.provider_tool_capability_snapshot(self.sid, run, backend="gemini", cursor_owner_token=owner)
        self.assertFalse(grant.exists())

    async def test_prebind_stop_does_not_deliver_prompt(self):
        run, task = self.run_turn("wait")
        server.STOPPED_RUNS.add(run)
        await asyncio.wait_for(task, 8)
        self.assertFalse((self.root / "child.pid").exists())
        self.assertTrue(self.events(run)[-1]["stopped"])


class GeminiProtocolTests(unittest.TestCase):
    def test_duplicate_or_unsolicited_tool_result_fails_closed(self):
        for messages in (
            [{"type": "tool_result", "tool_id": "missing", "status": "success"}],
            [{"type": "tool_use", "tool_id": "read_1", "tool_name": "read_file", "parameters": {}},
             {"type": "tool_result", "tool_id": "read_1", "status": "error"},
             {"type": "tool_use", "tool_id": "read_1", "tool_name": "read_file", "parameters": {}}],
        ):
            native_id = str(uuid4())
            stream = gemini.GeminiStream(native_id)
            stream.consume(json.dumps({"type": "init", "session_id": native_id}))
            with self.assertRaises(ValueError):
                for item in messages:
                    stream.consume(json.dumps(item))

    def test_first_turn_rewind_and_same_basename_do_not_bind_another_native_session(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"GEMINI_CLI_HOME": temp, "SANDBOX": ""}):
            root = Path(temp).resolve()
            sessions = []
            for i, name in enumerate(("left", "right")):
                cwd = root / name / "work"
                cwd.mkdir(parents=True)
                project = root / ".gemini/tmp" / ("work-1" if i else "work")
                chats = project / "chats"
                chats.mkdir(parents=True)
                (project / ".project_root").write_text(str(cwd))
                native_id = str(uuid4())
                records = [
                    {"sessionId": native_id, "kind": "main", "projectHash": hashlib.sha256(str(cwd).encode()).hexdigest()},
                    {"type": "user", "id": "setup", "content": "<session_context>native setup</session_context>"},
                    {"type": "user", "id": "question", "content": "read marker.txt"},
                ]
                if i:
                    records.append({"$rewindTo": "question"})
                (chats / f"session-test-{native_id[:8]}.jsonl").write_text(
                    "".join(json.dumps(row) + "\n" for row in records)
                )
                sessions.append((str(cwd), native_id))
            self.assertTrue(gemini.has_native_history(*sessions[0]))
            self.assertFalse(gemini.has_native_history(*sessions[1]))
            self.assertFalse(gemini.has_native_history(sessions[1][0], sessions[0][1]))

    def test_credentials_settings_history_and_native_permission_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native = root / ".gemini"
            native.mkdir()
            workspace = root / "workspace"
            workspace.mkdir()
            path = native / "settings.json"
            original = '// comments are native\n{"security":{"auth":{"selectedType":"oauth-personal"}}, "ui":{"theme":"x://y"}}'
            path.write_text(original)
            system_path = root / "system.json"
            env = {"HOME": directory, "GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(system_path)}
            access = {"port": 123, "accessToken": "synthetic"}
            with gemini.native_environment(env, access, cwd=workspace) as child:
                self.assertNotIn("GEMINI_CLI_HOME", child)
                self.assertEqual(child["GEMINI_CLI_AUTH_OVERRIDE"], "gemini-api-key")
            with gemini.native_environment(env, access, ("test-helper", {"command":"fixture"}), cwd=workspace) as child:
                profile = Path(child["GEMINI_CLI_HOME"]) / ".gemini"
                self.assertEqual((profile / "history").resolve(), (native / "history").resolve())
                self.assertEqual((profile / "tmp").resolve(), (native / "tmp").resolve())
                self.assertEqual(child["GEMINI_CLI_SYSTEM_SETTINGS_PATH"], str(system_path))
                settings = json.loads((profile / "settings.json").read_text())
                self.assertEqual(settings["ui"]["theme"], "x://y")
                self.assertEqual(settings["mcpServers"], {"test-helper": {"command": "fixture"}})
            self.assertFalse(profile.exists())
            self.assertEqual(path.read_text(), original)
            system_path.write_text('{"security":{"auth":{"enforcedType":"oauth-personal"}}}')
            with self.assertRaises(gemini.GeminiConfigurationError):
                with gemini.native_environment(env, access, cwd=workspace):
                    pass
            native_id = str(uuid4())
            for permission, mode in (("default", "default"), ("plan", "plan"), ("full_access", "yolo")):
                cmd = gemini.command("gemini", gemini.DEFAULT_MODEL, permission, native_id, False)
                self.assertEqual(cmd[cmd.index("--approval-mode") + 1], mode)
                self.assertNotIn("--skip-trust", cmd)
