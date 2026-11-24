"""Exercise Gemini's stream-json contract through the guarded subprocess and Stop path."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
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
if mode != 'no-history':
    native = Path(os.environ.get('GEMINI_CLI_HOME') or os.environ['HOME']) / '.gemini/tmp/workspace'
    chats = native / 'chats'
    chats.mkdir(parents=True, exist_ok=True)
    cwd = str(Path.cwd().resolve())
    (native / '.project_root').write_text(cwd)
    (chats / f'session-test-{session[:8]}.jsonl').write_text(json.dumps({
        'sessionId': session, 'kind': 'main', 'projectHash': hashlib.sha256(cwd.encode()).hexdigest()
    }) + chr(10) + json.dumps({'id':'user-turn','type':'user','content':prompt}) + chr(10))
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
