"""Subprocess-level lifecycle regressions for the production Cursor runner.

The fake CLIs emit captured Cursor stream-json shapes through real OS pipes,
so these tests exercise spawn, concurrent stderr drain, protocol validation,
timeouts, stop/teardown, provider persistence, and terminal projection rather
than mocking the runner's internals.
"""

import asyncio
import json
import os
import re
import sqlite3
import stat
import subprocess
import tempfile
import time
import unittest
from collections import OrderedDict, deque
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import agent_server

FAKE_AGENT_CLI = """#!/usr/bin/env python3
import json, os, sys

cwd = os.getcwd()
session_id = "cursor-sess-abc123"
hello_path = os.path.join(cwd, "hello.py")
events = [
    {"type": "system", "subtype": "init", "apiKeySource": "login", "cwd": cwd,
     "session_id": session_id, "model": "Auto", "permissionMode": "default"},
    {"type": "tool_call", "subtype": "started", "call_id": "call-edit-1",
     "tool_call": {"editToolCall": {"args": {"path": hello_path, "streamContent": "print(1)"}}},
     "session_id": session_id},
    {"type": "tool_call", "subtype": "completed", "call_id": "call-edit-1",
     "tool_call": {"editToolCall": {"args": {"path": hello_path},
                                     "result": {"success": {"path": hello_path,
                                                             "linesAdded": 1,
                                                             "linesRemoved": 0}}}},
     "session_id": session_id},
    {"type": "assistant",
     "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]},
     "session_id": session_id},
    {"type": "result", "subtype": "success", "duration_ms": 123, "is_error": False,
     "result": "Done.", "session_id": session_id,
     "usage": {"inputTokens": 10, "outputTokens": 2}},
]
for event in events:
    print(json.dumps(event), flush=True)
sys.exit(0)
"""

FAKE_AGENT_CLI_REJECTED_SHELL = """#!/usr/bin/env python3
import json, sys

session_id = "cursor-sess-rejected"
events = [
    {"type": "system", "subtype": "init", "cwd": ".", "session_id": session_id, "model": "Auto"},
    {"type": "tool_call", "subtype": "completed", "call_id": "call-shell-1",
     "tool_call": {"shellToolCall": {"result": {"rejected": {"command": "rm -rf /",
                                                              "reason": "not trusted"}}}},
     "session_id": session_id},
    {"type": "result", "subtype": "success", "duration_ms": 5, "is_error": False,
     "result": "I can't run that without permission.", "session_id": session_id},
]
for event in events:
    print(json.dumps(event), flush=True)
sys.exit(0)
"""


def _write_fake_cli(directory: Path, body: str) -> Path:
    script = directory / "fake_agent_cli.py"
    script.write_text(body, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _event_script(
    events: list[dict],
    *,
    exit_code: int = 0,
    stderr_bytes: int = 0,
    stderr_text: str = "",
    hang_after: float = 0,
) -> str:
    payload = json.dumps(events)
    return f'''#!/usr/bin/env python3
import json, sys, time
events = json.loads({payload!r})
if {stderr_bytes}:
    sys.stderr.write("x" * {stderr_bytes})
    sys.stderr.flush()
for event in events:
    print(json.dumps(event), flush=True)
if {hang_after!r}:
    time.sleep({hang_after!r})
sys.stderr.write({stderr_text!r})
sys.exit({exit_code})
'''


def _init_event(session_id: str = "cursor-sess-test") -> dict:
    return {
        "type": "system",
        "subtype": "init",
        "cwd": ".",
        "session_id": session_id,
        "model": "Auto",
    }


def _result_event(
    text: str = "Done.",
    *,
    session_id: str = "cursor-sess-test",
    is_error: bool = False,
) -> dict:
    return {
        "type": "result",
        "subtype": "error" if is_error else "success",
        "duration_ms": 5,
        "is_error": is_error,
        "result": text,
        "session_id": session_id,
    }


# How the CLI ends when Cursor's model provider returned RESOURCE_EXHAUSTED, and one tool call that came before.
EXHAUSTED = {"exit": 1, "stderr": "RetriableError: [resource_exhausted] Error\n"}
TOOL_CALL = [
    {"type": "tool_call", "subtype": subtype, "call_id": "call-1", "session_id": "cursor-sess-test",
     "tool_call": {"readToolCall": {"args": {"path": "a.txt"}, **({"result": {"success": {}}} if subtype == "completed" else {})}}}
    for subtype in ("started", "completed")
]
# One step per start of the CLI: the events after its init event ("init": False leaves that one out), the
# root it moves the conversation to, what it does to the store's files ("store": "no sidecar", "symlink",
# "no store" or "no directory"), a file it writes, how long it hangs, its exit code and stderr. Each start's
# arguments and prompt are recorded.
RETRIED_CLI = """#!/usr/bin/env python3
import json, os, pathlib, shutil, sqlite3, sys, time
calls = pathlib.Path(CALLS)
step = json.loads(STEPS)[len(calls.read_text().splitlines()) if calls.exists() else 0]
with calls.open("a") as out:
    out.write(json.dumps({"argv": sys.argv[1:], "prompt": sys.stdin.read()}) + "\\n")
if "root" in step:
    with sqlite3.connect(STORE) as db:
        db.execute("INSERT OR IGNORE INTO blobs VALUES (?, x'')", (str(step["root"]),))
        db.execute("UPDATE meta SET value = ? WHERE key = '0'", (json.dumps({"latestRootBlobId": step["root"]}).encode().hex(),))
if step.get("store") == "no sidecar":
    pathlib.Path(STORE).with_name("meta.json").unlink()
if step.get("store") == "symlink":
    os.rename(STORE, STORE + ".moved")
    os.symlink(STORE + ".moved", STORE)
if step.get("store") == "no store":
    os.unlink(STORE)
if step.get("store") == "no directory":
    shutil.rmtree(pathlib.Path(STORE).parent)
if "write" in step:
    pathlib.Path(step["write"]).write_text("changed\\n")
init = {"type": "system", "subtype": "init", "session_id": SESSION, "cwd": ".", "model": "Auto"}
for event in [*([init] if step.get("init", True) else []), *step.get("events", [])]:
    print(json.dumps(event), flush=True)
time.sleep(step.get("hang", 0))
sys.stderr.write(step.get("stderr", ""))
sys.exit(step.get("exit", 0))
"""


class RunCursorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.previous_sessions = agent_server.STORE.sessions
        self.previous_active = agent_server.ACTIVE
        self.previous_busy = agent_server.BUSY_SESSIONS
        self.previous_current = agent_server.CURRENT_TURNS
        self.previous_stop_requests = agent_server.STOP_REQUESTS
        self.previous_stopped_runs = agent_server.STOPPED_RUNS
        self.previous_queued = agent_server.QUEUED_TURNS
        self.previous_run_now = agent_server.RUN_NOW_TURNS
        self.previous_run_metadata = agent_server.RUN_METADATA
        self.previous_runtime_diagnostics = dict(
            agent_server.RUNTIME_DIAGNOSTICS
        )
        self.previous_runtime_diagnostic_generations = dict(
            agent_server.RUNTIME_DIAGNOSTIC_GENERATIONS
        )
        self.previous_state_dir = agent_server.STATE_DIR
        self.previous_sessions_file = agent_server.SESSIONS_FILE
        self.previous_cursor_bin = agent_server.CURSOR_BIN
        self.previous_startup_timeout = agent_server.CURSOR_STARTUP_TIMEOUT_SECONDS
        self.previous_turn_timeout = agent_server.CURSOR_TURN_TIMEOUT_SECONDS
        self.previous_idle_timeout = agent_server.CURSOR_IDLE_TIMEOUT_SECONDS
        self.previous_idle_warn = agent_server.CURSOR_IDLE_WARN_SECONDS
        self.previous_post_terminal = agent_server.CURSOR_POST_TERMINAL_EXIT_SECONDS
        self.previous_accumulated_text = agent_server.CURSOR_ACCUMULATED_TEXT_MAX_CHARS
        self.previous_max_tool_calls = agent_server.CURSOR_MAX_TOOL_CALLS
        self.previous_max_stream_events = agent_server.CURSOR_MAX_STREAM_EVENTS
        self.previous_max_stream_bytes = agent_server.CURSOR_MAX_STREAM_BYTES

        self.tempdir = tempfile.TemporaryDirectory()
        self.cwd = str(Path(self.tempdir.name) / "workspace")
        os.makedirs(self.cwd, exist_ok=True)
        agent_server.STATE_DIR = Path(self.tempdir.name) / "state"
        agent_server.SESSIONS_FILE = agent_server.STATE_DIR / "sessions.json"

        self.session_id = "chat-cursor-test"
        self.session = {
            "id": self.session_id,
            "backend": agent_server.BACKEND_CURSOR,
            "cwd": self.cwd,
        }
        agent_server.STORE.sessions = {self.session_id: self.session}
        agent_server.ACTIVE = {}
        agent_server.BUSY_SESSIONS = {self.session_id}
        agent_server.CURRENT_TURNS = {
            self.session_id: {
                "run_id": "run-cursor-1",
                "prompt": "hello",
                "file_ids": [],
                "backend": agent_server.BACKEND_CURSOR,
            }
        }
        agent_server.STOP_REQUESTS = set()
        agent_server.STOPPED_RUNS = set()
        agent_server.QUEUED_TURNS = {}
        agent_server.RUN_NOW_TURNS = {}
        agent_server.RUN_METADATA = {}

    async def asyncTearDown(self) -> None:
        agent_server.STORE.sessions = self.previous_sessions
        agent_server.ACTIVE = self.previous_active
        agent_server.BUSY_SESSIONS = self.previous_busy
        agent_server.CURRENT_TURNS = self.previous_current
        agent_server.STOP_REQUESTS = self.previous_stop_requests
        agent_server.STOPPED_RUNS = self.previous_stopped_runs
        agent_server.QUEUED_TURNS = self.previous_queued
        agent_server.RUN_NOW_TURNS = self.previous_run_now
        agent_server.RUN_METADATA = self.previous_run_metadata
        agent_server.RUNTIME_DIAGNOSTICS.clear()
        agent_server.RUNTIME_DIAGNOSTICS.update(
            self.previous_runtime_diagnostics
        )
        agent_server.RUNTIME_DIAGNOSTIC_GENERATIONS.clear()
        agent_server.RUNTIME_DIAGNOSTIC_GENERATIONS.update(
            self.previous_runtime_diagnostic_generations
        )
        agent_server.STATE_DIR = self.previous_state_dir
        agent_server.SESSIONS_FILE = self.previous_sessions_file
        agent_server.CURSOR_BIN = self.previous_cursor_bin
        agent_server.CURSOR_STARTUP_TIMEOUT_SECONDS = self.previous_startup_timeout
        agent_server.CURSOR_TURN_TIMEOUT_SECONDS = self.previous_turn_timeout
        agent_server.CURSOR_IDLE_TIMEOUT_SECONDS = self.previous_idle_timeout
        agent_server.CURSOR_IDLE_WARN_SECONDS = self.previous_idle_warn
        agent_server.CURSOR_POST_TERMINAL_EXIT_SECONDS = self.previous_post_terminal
        agent_server.CURSOR_ACCUMULATED_TEXT_MAX_CHARS = self.previous_accumulated_text
        agent_server.CURSOR_MAX_TOOL_CALLS = self.previous_max_tool_calls
        agent_server.CURSOR_MAX_STREAM_EVENTS = self.previous_max_stream_events
        agent_server.CURSOR_MAX_STREAM_BYTES = self.previous_max_stream_bytes
        self.tempdir.cleanup()

    def _read_events(self) -> list[dict]:
        path = agent_server.events_path(self.session_id)
        if not path.exists():
            return []
        with path.open("r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def _arm_run(self, run_id: str, prompt: str = "hello") -> None:
        agent_server.BUSY_SESSIONS.add(self.session_id)
        agent_server.CURRENT_TURNS[self.session_id] = {
            "run_id": run_id,
            "prompt": prompt,
            "file_ids": [],
            "backend": agent_server.BACKEND_CURSOR,
        }

    def test_cursor_mutation_tool_aliases_are_attributed(self) -> None:
        self.assertEqual(
            agent_server.tool_changed_paths({
                "name": "deleteFile",
                "input": {"path": "gone.py"},
            }),
            {"gone.py"},
        )
        self.assertEqual(
            agent_server.tool_changed_paths({
                "name": "renameFile",
                "input": {"old_path": "old.py", "new_path": "new.py"},
            }),
            {"old.py", "new.py"},
        )
        self.assertEqual(
            agent_server.tool_changed_paths({
                "name": "shell",
                "input": {"command": "apply_patch <<'PATCH'\n*** Update File: app.py\nPATCH"},
            }),
            {"app.py"},
        )

    async def _run_script(
        self,
        body: str,
        *,
        run_id: str = "run-cursor-1",
        prompt: str = "hello",
        session_patch: dict | None = None,
        standalone: bool = False,
    ) -> list[dict]:
        script = _write_fake_cli(Path(self.tempdir.name), body)
        runner_session = {**self.session, **(session_patch or {})}
        runner_session["_cursor_executable"] = str(script)
        self._arm_run(run_id, prompt)
        await agent_server.run_cursor(
            self.session_id,
            run_id,
            prompt,
            runner_session,
            Path(self.tempdir.name) / "manifest.json",
            standalone_provider_context=standalone,
        )
        return [
            event
            for event in self._read_events()
            if event.get("run_id") == run_id
        ]

    async def test_run_scoped_mcp_uses_live_owner_and_revokes_after_native_exit(self):
        run_id = "run-cursor-1"
        capability = {
            "source_session_id": self.session_id, "source_run_id": run_id,
            "authority_path": str(agent_server.CROSS_CHAT_AUTHORITY_ROOT / (run_id + "-" + "0" * 32 + ".json")),
            "provider_runtime_env": {},
        }
        probe = Path(self.tempdir.name) / "endpoint.json"
        body = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
prompt = sys.stdin.read()
assert "--force" not in sys.argv and "--approve-mcps" not in sys.argv
assert "--disable-project-configs" in sys.argv
plugin = pathlib.Path(sys.argv[sys.argv.index("--plugin-dir") + 1])
config = json.loads((plugin / "mcp.json").read_text())["mcpServers"]["provider"]
assert config["env"]["AGENTSDOCK_CURSOR_TOOL_SECRET"] not in prompt
print(json.dumps({"type":"system","subtype":"init","session_id":"native-mcp","cwd":os.getcwd()}), flush=True)
child = subprocess.Popen([config["command"], *config["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, **config["env"]})
try:
    for _ in range(2):
        child.stdin.write(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{"helper":"chats","arguments":["inbox"]}}}) + "\n")
        child.stdin.flush()
        response = json.loads(child.stdout.readline())
        assert response["result"]["isError"] is False, response
finally:
    child.stdin.close()
    child.wait(timeout=5)
pathlib.Path(PROBE).write_text(json.dumps({"port":config["env"]["AGENTSDOCK_CURSOR_TOOL_PORT"], "plugin":str(plugin)}))
print(json.dumps({"type":"result","subtype":"success","session_id":"native-mcp","is_error":False,"result":"MCP_OK"}), flush=True)
'''.replace("PROBE", repr(str(probe)))
        executor = AsyncMock(return_value=("inbox-empty", False))
        with patch.object(agent_server, "CROSS_CHAT_CAPABILITIES", {"fake": capability}), patch.object(
            agent_server, "execute_provider_tool", executor
        ):
            # The server default mode (full_access) adds --force; the script
            # asserts the MCP is admitted through the config overlay alone.
            events = await self._run_script(body, session_patch={"cursor_permission_mode": "default"})
        terminal = [e for e in events if e.get("type") == "turn_finished"]
        self.assertEqual(len(terminal), 1, events)
        self.assertFalse(terminal[0]["is_error"], events)
        self.assertEqual(terminal[0]["result_text"], "MCP_OK")
        self.assertEqual(executor.await_count, 1)  # same MCP request ID replays
        kwargs = executor.await_args.kwargs
        self.assertEqual(kwargs["backend"], agent_server.BACKEND_CURSOR)
        self.assertTrue(kwargs["cursor_owner_token"])
        recorded = json.loads(probe.read_text())
        self.assertFalse(Path(recorded["plugin"]).exists())
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", int(recorded["port"]))
        with self.assertRaises(agent_server.ProviderToolError):
            await agent_server.provider_tool_capability_snapshot(self.session_id, run_id, **kwargs)

    async def test_full_turn_emits_tool_and_assistant_and_terminal_events(self) -> None:
        script = _write_fake_cli(Path(self.tempdir.name), FAKE_AGENT_CLI)
        self.session["_cursor_executable"] = str(script)

        await agent_server.run_cursor(
            self.session_id,
            "run-cursor-1",
            "hello",
            dict(self.session),
            Path(self.tempdir.name) / "manifest.json",
        )

        events = self._read_events()
        types = [e["type"] for e in events]

        self.assertIn("process_started", types)
        self.assertIn("tool_started", types)
        self.assertIn("tool_finished", types)
        self.assertIn("assistant_text", types)
        self.assertIn("turn_finished", types)

        assistant_events = [e for e in events if e["type"] == "assistant_text"]
        self.assertEqual(assistant_events[0]["text"], "Done.")

        tool_started = next(e for e in events if e["type"] == "tool_started")
        self.assertEqual(tool_started["tool"]["name"], "edit")

        tool_finished = next(e for e in events if e["type"] == "tool_finished")
        self.assertEqual(tool_finished["tool"]["name"], "edit")
        self.assertIn("linesAdded", str(tool_finished["output"]))

        turn_finished = next(e for e in events if e["type"] == "turn_finished")
        self.assertEqual(turn_finished["backend"], agent_server.BACKEND_CURSOR)
        self.assertEqual(turn_finished["exit_code"], 0)
        self.assertEqual(turn_finished["input_tokens"], 10)
        self.assertEqual(turn_finished["output_tokens"], 2)
        self.assertEqual(turn_finished["total_tokens"], 12)

        # persist_run_provider_session should have bound the resumed id.
        self.assertEqual(
            agent_server.STORE.sessions[self.session_id].get("cursor_session_id"),
            "cursor-sess-abc123",
        )
        self.assertEqual(
            len([event for event in events if event["type"] == "provider_session"]),
            1,
        )

        # A successful turn must release the slot it was holding.
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)
        self.assertNotIn(self.session_id, agent_server.CURRENT_TURNS)

    async def test_a_chat_with_no_model_runs_the_default_model_where_the_account_offers_it(self) -> None:
        script = '''#!/usr/bin/env python3
import json, sys
sys.stdin.read()
print(json.dumps({"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}), flush=True)
print(json.dumps({"type":"result","subtype":"success","is_error":False,"result":"ok","session_id":"cursor-sess-test"}), flush=True)
'''
        for offered, own_model, expected in [
            (True, None, "gemini-4-neon-xhigh"),
            (False, None, None),
            (True, "composer-2.5", "composer-2.5"),
        ]:
            run_id = f"run-default-{offered}-{own_model}"
            with self.subTest(offered=offered, own_model=own_model), \
                    patch.object(agent_server, "CURSOR_DEFAULT_MODEL_OFFERED", offered):
                events = await self._run_script(script, run_id=run_id, session_patch={"model": own_model})
                argv = next(event for event in events if event["type"] == "process_started")["argv"]
                self.assertEqual(argv[argv.index("--model") + 1] if "--model" in argv else None, expected)

    async def test_composed_prompt_is_delivered_only_over_stdin(self) -> None:
        secret = "AUTHORITY-SENTINEL-STDIN-CURSOR"
        captured = Path(self.tempdir.name) / "captured-prompt.txt"
        script = f'''#!/usr/bin/env python3
import json, pathlib, sys
prompt = sys.stdin.read()
pathlib.Path({str(captured)!r}).write_text(prompt, encoding="utf-8")
session_id = "cursor-sess-test"
print(json.dumps({{"type":"system","subtype":"init","session_id":session_id,"cwd":".","model":"Auto"}}), flush=True)
print(json.dumps({{"type":"result","subtype":"success","is_error":False,"result":"received","session_id":session_id}}), flush=True)
'''
        events = await self._run_script(
            script,
            prompt=f"--model fake\nUnicode ✓\n{secret}",
        )
        started = next(event for event in events if event["type"] == "process_started")
        self.assertNotIn(secret, json.dumps(started["argv"]))
        self.assertNotIn("--model fake", started["argv"])
        written = captured.read_text(encoding="utf-8")
        self.assertIn(secret, written)
        self.assertIn("--model fake", written)
        self.assertIn("Unicode ✓", written)

    async def test_current_lifecycle_events_do_not_abort_or_leak_payloads(self) -> None:
        secret = "LIFECYCLE-SECRET"
        events = await self._run_script(_event_script([
            _init_event(),
            {"type": "retry", "subtype": "starting", "session_id": "cursor-sess-test", "attempt": 1},
            {"type": "connection", "subtype": "reconnecting", "session_id": "cursor-sess-test", "attempt": 2, "endpoint_url": secret},
            {"type": "connection", "subtype": "reconnected", "session_id": "cursor-sess-test"},
            {"type": "interaction_query", "subtype": "request", "session_id": "cursor-sess-test", "query_type": "permission", "query": {"prompt": secret}},
            {"type": "interaction_query", "subtype": "response", "session_id": "cursor-sess-test", "query_type": "permission", "response": {"answer": secret}},
            {"type": "system", "subtype": "task_notification", "session_id": "cursor-sess-test", "title": secret},
            {"type": "system", "subtype": "background_shell_timeout", "session_id": "cursor-sess-test", "aborted_count": 1, "timeout_ms": 1_000},
            _result_event("lifecycle complete"),
        ]))
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertFalse(terminal["is_error"])
        self.assertFalse(any(event["type"] == "raw_event" for event in events))
        self.assertNotIn(secret, json.dumps(events))

    async def test_nonzero_shell_tool_exit_is_preserved(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "failed-shell",
                "tool_call": {"shellToolCall": {
                    "args": {"command": "false"},
                    "result": {"failure": {"exitCode": 7, "stderr": "failed"}},
                }},
                "session_id": "cursor-sess-test",
            },
            _result_event("handled failure"),
        ]))
        finished = next(event for event in events if event["type"] == "tool_finished")
        self.assertEqual(finished["exit_code"], 7)
        self.assertEqual(finished["tool"]["input"], {"command": "false"})

    async def test_current_tool_timeout_is_not_projected_as_success(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "timed-out-shell",
                "tool_call": {"shellToolCall": {
                    "args": {"command": "sleep 10"},
                    "result": {"timeout": {
                        "command": "sleep 10",
                        "timeoutMs": 1000,
                    }},
                }},
                "session_id": "cursor-sess-test",
            },
            _result_event("handled timeout"),
        ]))
        finished = next(event for event in events if event["type"] == "tool_finished")
        self.assertEqual(finished["exit_code"], 1)
        self.assertIn("timeoutMs", finished["output"])

    async def test_cache_usage_buckets_count_toward_total_tokens(self) -> None:
        result = _result_event("cached")
        result["usage"] = {
            "inputTokens": 5,
            "outputTokens": 2,
            "cacheReadTokens": 10,
            "cacheWriteTokens": 3,
        }
        events = await self._run_script(_event_script([
            _init_event(),
            result,
        ]))
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertEqual(terminal["input_tokens"], 5)
        self.assertEqual(terminal["cached_input_tokens"], 10)
        self.assertEqual(terminal["cache_write_input_tokens"], 3)
        self.assertEqual(terminal["output_tokens"], 2)
        self.assertEqual(terminal["total_tokens"], 20)

    async def test_unfinished_tool_is_closed_and_turn_fails_protocol(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "started",
                "call_id": "open-edit",
                "tool_call": {"writeToolCall": {"args": {"path": "hello.py"}}},
                "session_id": "cursor-sess-test",
            },
            _result_event("premature result"),
        ]))
        finished = next(event for event in events if event["type"] == "tool_finished")
        self.assertEqual(finished["tool_id"], "open-edit")
        self.assertEqual(finished["exit_code"], 1)
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")

    async def test_write_tool_projects_an_actual_code_diff(self) -> None:
        target = Path(self.cwd) / "hello.py"
        target.write_text("print('before')\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.cwd, check=True)
        subprocess.run(["git", "add", "hello.py"], cwd=self.cwd, check=True)
        subprocess.run(
            ["git", "-c", "user.name=AgentsDock Test", "-c",
             "user.email=test@agentsdock.invalid", "commit", "-qm", "baseline"],
            cwd=self.cwd,
            check=True,
        )
        script = f'''#!/usr/bin/env python3
import json, pathlib, sys
sys.stdin.read()
path = {str(target)!r}
pathlib.Path(path).write_text("print('after')\\n", encoding="utf-8")
session_id = "cursor-sess-test"
events = [
  {{"type":"system","subtype":"init","session_id":session_id,"cwd":{self.cwd!r},"model":"Auto"}},
  {{"type":"tool_call","subtype":"started","call_id":"write-1","tool_call":{{"writeToolCall":{{"args":{{"path":path}}}}}},"session_id":session_id}},
  {{"type":"tool_call","subtype":"completed","call_id":"write-1","tool_call":{{"writeToolCall":{{"args":{{"path":path}},"result":{{"success":{{"path":path}}}}}}}},"session_id":session_id}},
  {{"type":"result","subtype":"success","is_error":False,"result":"updated","session_id":session_id}},
]
for event in events:
    print(json.dumps(event), flush=True)
'''
        events = await self._run_script(script, run_id="run-cursor-code-diff")
        diff = next(event for event in events if event["type"] == "code_diff")
        self.assertEqual(diff["attributed_paths"], ["hello.py"])
        self.assertEqual(diff["files_changed"], 1)
        self.assertEqual(diff["diff_files"][0]["path"], "hello.py")

    async def test_rejected_shell_call_is_reported_as_tool_finished_not_dropped(
        self,
    ) -> None:
        script = _write_fake_cli(Path(self.tempdir.name), FAKE_AGENT_CLI_REJECTED_SHELL)
        self.session["_cursor_executable"] = str(script)

        await agent_server.run_cursor(
            self.session_id,
            "run-cursor-1",
            "run rm -rf /",
            dict(self.session),
            Path(self.tempdir.name) / "manifest.json",
        )

        events = self._read_events()
        tool_finished = next(e for e in events if e["type"] == "tool_finished")
        self.assertEqual(tool_finished["tool"]["name"], "shell")
        self.assertEqual(tool_finished["exit_code"], 1)
        self.assertIn("not trusted", tool_finished["output"])

    async def test_cursor_tool_status_is_neutral_not_successful(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "started",
                "call_id": "await-1",
                "tool_call": {"awaitToolCall": {"args": {"task": "job-1"}}},
                "session_id": "cursor-sess-test",
            },
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "await-1",
                "tool_call": {"awaitToolCall": {
                    "args": {"task": "job-1"},
                    "result": {"stillRunning": {}},
                }},
                "session_id": "cursor-sess-test",
            },
            _result_event("The task is still running."),
        ]), run_id="run-cursor-neutral-tool-status")

        finished = next(event for event in events if event["type"] == "tool_finished")
        self.assertIsNone(finished["exit_code"])
        self.assertIn("still running", finished["output"].lower())

    async def test_confirmation_required_fails_closed_without_bridge(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "started",
                "call_id": "pr-1",
                "tool_call": {"prManagementToolCall": {"args": {}}},
                "session_id": "cursor-sess-test",
            },
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "pr-1",
                "tool_call": {"prManagementToolCall": {
                    "args": {},
                    "result": {"needsConfirmation": {}},
                }},
                "session_id": "cursor-sess-test",
            },
            _result_event("Done."),
        ]), run_id="run-cursor-confirmation-required")

        finished = next(event for event in events if event["type"] == "tool_finished")
        self.assertEqual(finished["exit_code"], 1)
        self.assertIn("requires confirmation", finished["output"].lower())
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("not supported", error["message"].lower())
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])

    async def test_logical_error_exit_zero_is_failed_with_empty_result(self) -> None:
        agent_server.RUN_METADATA["run-cursor-1"] = {
            "purpose": "scheduled_job",
            "job_id": "job-cursor-failure",
        }
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "partial secret"}],
                },
                "session_id": "cursor-sess-test",
            },
            _result_event("provider rejected request", is_error=True),
        ]))

        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")
        self.assertEqual(
            agent_server.scheduled_job_run_status(terminal),
            "failed",
        )
        self.assertTrue(any(event["type"] == "error" for event in events))

    async def test_logical_auth_failure_marks_runtime_unauthenticated(self) -> None:
        secret = "private-account-identity"
        with patch.object(
            agent_server,
            "cursor_auth_probe_state",
            return_value="unauthenticated",
        ) as confirm:
            events = await self._run_script(_event_script([
                _init_event(),
                _result_event(
                    f"Authentication failed. Please sign in. {secret}",
                    is_error=True,
                ),
            ]), run_id="run-cursor-logical-auth")

        diagnostic = agent_server.RUNTIME_DIAGNOSTICS[
            agent_server.BACKEND_CURSOR
        ]
        self.assertEqual(diagnostic["status"], "unauthenticated")
        self.assertFalse(diagnostic["authenticated"])
        self.assertNotIn(secret, json.dumps(events))
        self.assertNotIn(secret, json.dumps(diagnostic))
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("authentication failed", error["message"].lower())
        confirm.assert_called_once()

    async def test_stderr_auth_failure_marks_runtime_unauthenticated(self) -> None:
        secret = "private-auth-stderr"
        with patch.object(
            agent_server,
            "cursor_auth_probe_state",
            return_value="unauthenticated",
        ) as confirm:
            events = await self._run_script(
                f'''#!/usr/bin/env python3
import json, sys
sys.stdin.read()
print(json.dumps({{"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}}), flush=True)
sys.stderr.write("Authentication required. Please sign in. {secret}")
sys.stderr.flush()
sys.exit(7)
''',
                run_id="run-cursor-stderr-auth",
            )

        diagnostic = agent_server.RUNTIME_DIAGNOSTICS[
            agent_server.BACKEND_CURSOR
        ]
        self.assertEqual(diagnostic["status"], "unauthenticated")
        self.assertFalse(diagnostic["authenticated"])
        self.assertNotIn(secret, json.dumps(events))
        self.assertNotIn(secret, json.dumps(diagnostic))
        confirm.assert_called_once()

    async def test_project_auth_text_does_not_disable_cursor_without_confirmation(
        self,
    ) -> None:
        agent_server.store_runtime_diagnostic(
            agent_server.runtime_diagnostic_payload(
                agent_server.BACKEND_CURSOR,
                "ready",
                installed=True,
                authenticated=True,
                executable="/bin/agent",
            )
        )
        script = '''#!/usr/bin/env python3
import json, sys
sys.stdin.read()
print(json.dumps({"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}), flush=True)
sys.stderr.write("project says 401 Unauthorized")
sys.stderr.flush()
sys.exit(7)
'''
        with patch.object(
            agent_server,
            "cursor_auth_probe_state",
            return_value="ready",
        ) as confirm:
            events = await self._run_script(
                script,
                run_id="run-cursor-project-401",
            )

        diagnostic = agent_server.RUNTIME_DIAGNOSTICS[
            agent_server.BACKEND_CURSOR
        ]
        self.assertEqual(diagnostic["status"], "ready")
        self.assertTrue(diagnostic["authenticated"])
        error = next(event for event in events if event["type"] == "error")
        self.assertNotIn("authentication failed", error["message"].lower())
        confirm.assert_called_once()

    async def test_project_auth_result_uses_generic_error_when_login_is_ready(
        self,
    ) -> None:
        with patch.object(
            agent_server,
            "cursor_auth_probe_state",
            return_value="ready",
        ) as confirm:
            events = await self._run_script(_event_script([
                _init_event(),
                _result_event(
                    "Project endpoint returned 401 Unauthorized",
                    is_error=True,
                ),
            ]), run_id="run-cursor-project-result-401")

        error = next(event for event in events if event["type"] == "error")
        self.assertEqual(
            error["message"],
            "Cursor reported a logical provider error.",
        )
        confirm.assert_called_once()

    async def test_ambiguous_api_key_failure_is_runtime_error_not_auth_failure(
        self,
    ) -> None:
        with patch.object(
            agent_server,
            "cursor_auth_probe_state",
            return_value="error",
        ) as confirm:
            events = await self._run_script(_event_script([
                _init_event(),
                _result_event("Invalid API key", is_error=True),
            ]), run_id="run-cursor-ambiguous-api-key")

        diagnostic = agent_server.RUNTIME_DIAGNOSTICS[
            agent_server.BACKEND_CURSOR
        ]
        self.assertEqual(diagnostic["status"], "error")
        self.assertIsNone(diagnostic["authenticated"])
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("could not validate", error["message"].lower())
        self.assertNotIn("authentication failed", error["message"].lower())
        confirm.assert_called_once()

    async def test_admitted_executable_is_spawned_without_reresolution(self) -> None:
        with patch.object(
            agent_server,
            "resolve_cursor_executable",
            side_effect=AssertionError("admitted executable must be fenced"),
        ):
            events = await self._run_script(
                _event_script([_init_event(), _result_event("fenced")])
            )

        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertFalse(terminal["is_error"])
        started = next(event for event in events if event["type"] == "process_started")
        self.assertEqual(started["argv"][0], str(Path(self.tempdir.name) / "fake_agent_cli.py"))

    async def test_exit_zero_without_terminal_after_partial_text_fails(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "partial"}],
                },
                "session_id": "cursor-sess-test",
            },
        ]))

        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("without a terminal result", error["message"])

    async def test_unknown_schema_after_partial_text_fails_closed(self) -> None:
        sensitive_unknown_payload = "AUTHORITY-SENTINEL-DO-NOT-PERSIST"
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "partial"}],
                },
                "session_id": "cursor-sess-test",
            },
            {
                "type": sensitive_unknown_payload,
                "subtype": sensitive_unknown_payload,
                "session_id": "cursor-sess-test",
                sensitive_unknown_payload: sensitive_unknown_payload,
            },
        ]))

        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")
        raw_event = next(event for event in events if event["type"] == "raw_event")
        self.assertNotIn(sensitive_unknown_payload, json.dumps(raw_event))
        self.assertNotIn("raw", raw_event)
        self.assertEqual(raw_event["diagnostic"]["json_type"], "dict")
        self.assertTrue(raw_event["diagnostic"]["has_type_field"])
        self.assertTrue(raw_event["diagnostic"]["has_subtype_field"])
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("unsupported stream-json", error["message"])
        self.assertNotIn(sensitive_unknown_payload, json.dumps(error))

    async def test_invalid_outer_tool_id_uses_valid_nested_id(self) -> None:
        nested_call_id = "Shell_0_mailbox-wake"
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "started",
                "call_id": "",
                "tool_call": {
                    "shellToolCall": {
                        "args": {
                            "command": "agentsdock-chats inbox",
                            "toolCallId": nested_call_id,
                        },
                    },
                },
                "session_id": "cursor-sess-test",
            },
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": " invalid-leading-space",
                "tool_call": {
                    "shellToolCall": {
                        "args": {
                            "command": "agentsdock-chats inbox",
                            "toolCallId": nested_call_id,
                        },
                        "result": {
                            "success": {
                                "exitCode": 0,
                                "stdout": "{}",
                                "stderr": "",
                            },
                        },
                    },
                },
                "session_id": "cursor-sess-test",
            },
            _result_event("mail checked"),
        ]))

        tool_started = next(
            event for event in events if event["type"] == "tool_started"
        )
        tool_finished = next(
            event for event in events if event["type"] == "tool_finished"
        )
        terminal = next(
            event for event in events if event["type"] == "turn_finished"
        )

        self.assertEqual(tool_started["tool"]["id"], nested_call_id)
        self.assertEqual(tool_finished["tool_id"], nested_call_id)
        self.assertFalse(terminal["is_error"])
        self.assertEqual(terminal["exit_code"], 0)
        self.assertFalse(any(event["type"] == "raw_event" for event in events))

    async def test_malformed_stream_and_stderr_cannot_leak_prompt_material(
        self,
    ) -> None:
        secret = "AUTHORITY-SENTINEL-MALFORMED-CURSOR"
        malformed_script = f'''#!/usr/bin/env python3
import json
print(json.dumps({{"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}}), flush=True)
print('{{"type":"future_schema","payload":"{secret}"', flush=True)
'''
        with self.assertLogs(agent_server.logger, level="WARNING") as captured:
            events = await self._run_script(
                malformed_script,
                run_id="run-malformed-private",
            )

        raw_event = next(event for event in events if event["type"] == "raw_event")
        terminal = next(event for event in events if event["type"] == "turn_finished")
        error = next(event for event in events if event["type"] == "error")
        self.assertTrue(terminal["is_error"])
        self.assertNotIn(secret, json.dumps(events))
        self.assertNotIn(secret, "\n".join(captured.output))
        self.assertNotIn(secret, json.dumps(raw_event))
        self.assertNotIn(secret, json.dumps(error))
        self.assertNotIn(
            secret,
            json.dumps(
                agent_server.RUNTIME_DIAGNOSTICS.get(
                    agent_server.BACKEND_CURSOR,
                    {},
                )
            ),
        )

        stderr_events = await self._run_script(
            f'''#!/usr/bin/env python3
import json, sys
print(json.dumps({{"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}}), flush=True)
sys.stderr.write("{secret}")
sys.stderr.flush()
sys.exit(7)
''',
            run_id="run-stderr-private",
        )
        self.assertNotIn(secret, json.dumps(stderr_events))
        stderr_error = next(
            event for event in stderr_events if event["type"] == "error"
        )
        self.assertIn("stderr was omitted", stderr_error["message"])

    async def test_provider_resource_exhaustion_reaches_the_terminal_without_exposing_details(self) -> None:
        private = "private-provider-detail"
        for case, events, stderr, code in (
            ("exit", [_init_event()], "RetriableError: [resource_exhausted] Error\n", 1),
            ("result", [_init_event(), _result_event(f"[resource_exhausted] {private}", is_error=True)], "", 0),
            ("empty-result", [_init_event(), _result_event("", is_error=True)],
             f"\x1b[31mConnectError: [resource_exhausted] {private}\x1b[0m\n", 1),
        ):
            # The script fails the same way at every start. A schedule of one wait of 0 seconds keeps this to
            # one retry, after which the turn fails: the notice must not expose the details either.
            with self.subTest(case=case), patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
                script = _event_script(events, exit_code=code, stderr_text=stderr)
                received = await self._run_script(script, run_id=f"run-exhausted-{case}")
                error = next(event for event in received if event["type"] == "error")
                terminal = next(event for event in received if event["type"] == "turn_finished")
                self.assertIn("RESOURCE_EXHAUSTED", error["message"])
                self.assertEqual(terminal["message"], error["message"])
                self.assertTrue(terminal["is_error"])
                self.assertEqual(terminal["result_text"], "")
                self.assertNotIn(private, json.dumps(received))

    async def test_exhausted_first_turn_can_resume_only_a_durable_native_session(self) -> None:
        script = _event_script([_init_event()], exit_code=1, stderr_text="RetriableError: [resource_exhausted] Error\n")
        saved = agent_server.cursor_history.LocalSession(
            "cursor-sess-test", self.cwd, None, 0.0, Path(self.cwd) / "transcript.jsonl",
        )
        for outcome in (None, OSError("store unavailable"), saved):
            # An empty schedule: the turn fails at its first start, as it does once its retries are used up.
            # test_a_new_conversation_is_bound_to_the_chat_before_the_wait_only_when_it_holds_the_prompt
            # covers a start that is retried.
            with self.subTest(outcome=outcome), patch.object(
                agent_server.cursor_history, "find_session",
                side_effect=[outcome],
            ) as lookup, patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", ()):
                events = await self._run_script(script)
                lookup.assert_called_once_with("cursor-sess-test", self.cwd)
                self.assertTrue(next(e for e in events if e["type"] == "turn_finished")["is_error"])
                self.assertNotIn("cursor_instruction_hash", self.session)
                self.assertEqual(self.session.get("cursor_session_id"), "cursor-sess-test" if outcome is saved else None)

    def _retried_cli(self, *steps: dict, root: str = "") -> str:
        """RETRIED_CLI for these steps, and the conversation store they move (session cursor-sess-test)."""
        directory = Path(tempfile.mkdtemp(dir=self.tempdir.name))
        self.calls = directory / "calls.jsonl"
        self.store = directory / "cursor-config" / "chats" / "bucket" / "cursor-sess-test" / "store.db"
        self.store.parent.mkdir(parents=True)
        with sqlite3.connect(self.store) as db:
            db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
            db.execute("CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB)")
            db.execute("INSERT INTO meta VALUES ('0', ?)", (json.dumps({"latestRootBlobId": root}).encode().hex(),))
            db.execute("INSERT INTO blobs VALUES (?, x'')", (root,))
        (self.store.parent / "meta.json").write_text(json.dumps({"cwd": self.cwd}))
        self.enterContext(patch.dict(os.environ, {"CURSOR_CONFIG_DIR": str(directory / "cursor-config")}))
        return (RETRIED_CLI.replace("CALLS", repr(str(self.calls))).replace("STEPS", repr(json.dumps(steps)))
                .replace("STORE", repr(str(self.store))).replace("SESSION", repr("cursor-sess-test")))

    def _cli_starts(self) -> list[dict]:
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def _waiting(self) -> bool:
        """Whether the turn waits for a retry: it then holds a record without a process."""
        return "proc" not in agent_server.ACTIVE.get(self.session_id, {"proc": None})

    @contextmanager
    def _retry_clock(self):
        """Fake time for the wait before a retry: inside agent_server a sleep of the waiting turn returns at
        once and moves the clock by its length. Yields the seconds skipped so far, as a list of one number."""
        skipped = [0.0]

        async def sleep(seconds: float) -> None:
            if self._waiting():
                skipped[0] += seconds
                seconds = 0
            await asyncio.sleep(seconds)

        def seen_by_server(module, **replaced):
            return SimpleNamespace(**{name: getattr(module, name) for name in dir(module)} | replaced)

        with patch.object(agent_server, "asyncio", seen_by_server(asyncio, sleep=sleep)), patch.object(
            agent_server, "time", seen_by_server(time, monotonic=lambda: time.monotonic() + skipped[0]),
        ):
            yield skipped

    @staticmethod
    def _notices(events: list[dict]) -> list[str]:
        """Each wait's notice, without the clock time in it."""
        return [
            re.sub(r", at \d\d:\d\d:\d\d [+-]\d{4}\.", ".", event["text"])
            for event in events if event.get("phase") == "commentary"
        ]

    async def test_an_exhausted_provider_does_not_fail_the_turn_and_the_cli_is_started_again_in_the_same_run(self) -> None:
        script = self._retried_cli(
            {"events": TOOL_CALL, "root": "root-1", **EXHAUSTED},
            {"events": [_result_event("Done.")], "root": "root-2"},
        )
        with self._retry_clock() as skipped, patch.object(agent_server, "record_runtime_failure") as failure:
            events = await self._run_script(script, session_patch={"model": "composer-2.5"})

        # Every row of the chat carries the one run id: a retry opens no second run.
        self.assertEqual(events, self._read_events())
        self.assertEqual([event["type"] for event in events], [
            "process_started", "tool_started", "tool_finished", "reasoning_summary",
            "process_started", "provider_session", "turn_finished",
        ])
        self.assertRegex(events[3]["text"], (
            r"^Cursor's model provider returned RESOURCE_EXHAUSTED\. The turn is retried in 30 seconds, at "
            r"\d\d:\d\d:\d\d [+-]\d{4}\. This is retry 1 of at most 8 in a row without progress\.$"
        ))
        # The clock moved by the wait, less the real time the wait took.
        self.assertTrue(25 < skipped[0] <= 30, skipped)
        terminal = events[-1]
        self.assertEqual((terminal["is_error"], terminal["exit_code"], terminal["result_text"]), (False, 0, "Done."))
        self.assertNotIn("message", terminal)
        failure.assert_not_called()
        # The conversation held the prompt and the tool call, so the retry resumed it, on the model of the
        # first start, and was told to go on. Those words are the server's: no row of the timeline carries them.
        first, second = self._cli_starts()
        self.assertTrue(first["prompt"].endswith("[Current user prompt]\nhello"))
        self.assertNotIn("--resume", first["argv"])
        self.assertEqual(second["argv"][second["argv"].index("--resume") + 1], "cursor-sess-test")
        self.assertEqual([start["argv"][start["argv"].index("--model") + 1] for start in (first, second)], ["composer-2.5"] * 2)
        self.assertEqual(second["prompt"], "go on")
        self.assertNotIn('"go on"', json.dumps(events))
        # Each start records the root the conversation stood at; the instructions sent with the first count as delivered.
        self.assertEqual([event.get("cursor_root_blob_id") for event in events if event["type"] == "process_started"], ["", "root-1"])
        self.assertEqual(self.session.get("cursor_session_id"), "cursor-sess-test")
        self.assertIn("cursor_instruction_hash", self.session)
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)

    async def test_a_retry_gives_the_cli_the_prompt_again_unless_the_conversation_holds_it(self) -> None:
        bound = {"cursor_session_id": "cursor-sess-test", "session_id": "cursor-sess-test"}
        done = {"events": [_result_event("Done.")]}
        for case, steps, root, session_patch, expected in (
            # The start stored nothing: the retry gets the same prompt, on the chat's conversation if it has one.
            ("new chat", [EXHAUSTED, done], "", None, lambda prompt: [(prompt, False), (prompt, False)]),
            ("new chat, no store yet", [{"store": "no store", **EXHAUSTED}, done], "", None, lambda prompt: [(prompt, False), (prompt, False)]),
            ("new chat, no directory yet", [{"store": "no directory", **EXHAUSTED}, done], "", None, lambda prompt: [(prompt, False), (prompt, False)]),
            ("resumed chat", [EXHAUSTED, done], "root-0", bound, lambda prompt: [(prompt, True), (prompt, True)]),
            # The same when the CLI ended before it named its conversation; what it stored by then counts.
            ("resumed chat, no init", [{"init": False, **EXHAUSTED}, done], "root-0", bound, lambda prompt: [(prompt, True), (prompt, True)]),
            ("resumed chat, stored before init", [{"init": False, "root": "root-1", **EXHAUSTED}, done], "root-0", bound,
             lambda prompt: [(prompt, True), ("go on", True)]),
            # A retry that stored nothing is followed by one that is told the same.
            ("second retry", [{"root": "root-1", **EXHAUSTED}, EXHAUSTED, done], "", None,
             lambda prompt: [(prompt, False), ("go on", True), ("go on", True)]),
        ):
            with self.subTest(case=case), patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0, 0)):
                self.session.pop("cursor_session_id", None)  # The case before bound the chat when it finished.
                events = await self._run_script(self._retried_cli(*steps, root=root), run_id=f"run-{case}", session_patch=session_patch)
                starts = self._cli_starts()
                self.assertEqual([(start["prompt"], "--resume" in start["argv"]) for start in starts], expected(starts[0]["prompt"]))
                self.assertFalse(events[-1]["is_error"], events)

    async def test_a_retry_carries_the_provider_instructions_only_with_the_prompt_and_the_turn_records_them_once(self) -> None:
        instructions = "[AgentsDock provider instructions]"
        # A chat whose recorded instructions are not the current ones gets them again at its next turn.
        outdated = {
            "cursor_session_id": "cursor-sess-test", "session_id": "cursor-sess-test",
            "cursor_instruction_hash": "outdated", "cursor_instruction_version": agent_server.CURSOR_PROMPT_POLICY_VERSION,
        }
        done = {"events": [_result_event("Done.")]}
        for case, first, root, chat, again in (
            # The conversation did not store the prompt: the retry gets it again, instructions included.
            ("new chat, nothing stored", EXHAUSTED, "", {}, True),
            ("outdated instructions, nothing stored", EXHAUSTED, "root-0", outdated, True),
            # The conversation holds the prompt with its instructions: the retry is told to go on, without them.
            ("new chat, stored", {"root": "root-1", **EXHAUSTED}, "", {}, False),
            ("outdated instructions, stored", {"root": "root-1", **EXHAUSTED}, "root-0", outdated, False),
        ):
            with self.subTest(case=case), patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)), patch.object(
                agent_server, "persist_run_provider_session", wraps=agent_server.persist_run_provider_session,
            ) as persist:
                for key in outdated:
                    self.session.pop(key, None)  # The case before bound the chat and recorded its instructions.
                self.session.update(chat)
                script = self._retried_cli(first, done, done, root=root)
                await self._run_script(script, run_id=f"run-{case}")
                first_start, retry = (start["prompt"] for start in self._cli_starts())
                self.assertIn(instructions, first_start)
                self.assertEqual(retry, first_start if again else "go on")
                # The turn records the instructions once, when it succeeds, and the turn after it sends none.
                recorded = [call.kwargs["cursor_instruction_hash"] for call in persist.await_args_list]
                self.assertEqual([value for value in recorded if value], [self.session["cursor_instruction_hash"]])
                self.assertNotEqual(self.session["cursor_instruction_hash"], "outdated")
                await self._run_script(script, run_id=f"run-{case}-next")
                self.assertEqual(self._cli_starts()[2]["prompt"], "[Current user prompt]\nhello")

    async def test_the_waits_grow_to_five_minutes_and_after_eight_retries_without_progress_the_turn_fails(self) -> None:
        with self._retry_clock() as skipped:
            events = await self._run_script(self._retried_cli(*[EXHAUSTED] * 9))

        self.assertEqual(self._notices(events), [
            f"Cursor's model provider returned RESOURCE_EXHAUSTED. The turn is retried in {wait} seconds. "
            f"This is retry {number} of at most 8 in a row without progress."
            for number, wait in enumerate((30, 60, 120, 240, 300, 300, 300, 300), 1)
        ])
        # The clock moved by the eight waits, less the real time they took.
        self.assertTrue(1600 < skipped[0] <= 1650, skipped)
        self.assertEqual(len(self._cli_starts()), 9)
        error, terminal = (next(event for event in events if event["type"] == kind) for kind in ("error", "turn_finished"))
        self.assertEqual(error["message"], (
            "Cursor's model provider kept returning RESOURCE_EXHAUSTED: 8 retries in a row made no progress, after "
            "1650 seconds of waiting. Try again later, or select another available model in this chat."
        ))
        self.assertEqual((terminal["message"], terminal["is_error"], terminal["result_text"]), (error["message"], True, ""))
        # The Codex and Claude resend of "go on" keys on these words in an error row.
        self.assertIsNone(agent_server.MODEL_CAPACITY_ERROR_RE.search(error["message"]))

    async def test_a_tool_call_or_text_from_a_retry_starts_the_count_again(self) -> None:
        text = {"type": "assistant", "session_id": "cursor-sess-test", "message": {"role": "assistant", "content": [{"type": "text", "text": "Step two is next."}]}}
        with self._retry_clock():
            events = await self._run_script(self._retried_cli(
                EXHAUSTED, EXHAUSTED, {"events": TOOL_CALL, **EXHAUSTED}, EXHAUSTED, {"events": [text], **EXHAUSTED},
                {"events": [_result_event("Done.")]},
            ))
        self.assertEqual([notice.split("The turn is retried in ")[1].split(" of at most")[0] for notice in self._notices(events)], [
            "30 seconds. This is retry 1", "60 seconds. This is retry 2",
            "30 seconds. This is retry 1", "60 seconds. This is retry 2",
            "30 seconds. This is retry 1",
        ])
        self.assertFalse(events[-1]["is_error"])

    async def test_a_usage_limit_in_the_providers_message_is_named_without_quoting_the_message(self) -> None:
        limit = {"exit": 1, "stderr": "RetriableError: [resource_exhausted] You have hit your usage limit for account-7\n"}
        with patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
            events = await self._run_script(self._retried_cli(limit, limit))
        named = " Its message names a usage or rate limit: check the Cursor account."
        self.assertEqual(self._notices(events), [
            f"Cursor's model provider returned RESOURCE_EXHAUSTED.{named} The turn is retried in 0 seconds. "
            "This is retry 1 of at most 1 in a row without progress."
        ])
        self.assertIn(f"after 0 seconds of waiting.{named} Try again later", events[-1]["message"])
        self.assertNotIn("account-7", json.dumps(events))

    async def test_other_failures_are_not_retried(self) -> None:
        bound = {"cursor_session_id": "cursor-sess-test", "session_id": "cursor-sess-test"}
        refused = {"exit": 1, "stderr": "NonRetriableError: [resource_exhausted] Error\n"}
        logical = {"events": [_result_event("provider failure", is_error=True)]}
        exhausted = (
            "Cursor's model provider returned RESOURCE_EXHAUSTED. Wait briefly and try again. "
            "If it recurs, select another available model in this chat."
        )
        for case, steps, session_patch, starts, message in (
            # Cursor's service marked the error as not retryable, at the first start or at a retry: the
            # failure keeps its own message, which counts no retries.
            ("refused", [refused], None, 1, exhausted),
            ("refused at a retry", [{"root": "root-1", **EXHAUSTED}, refused], None, 2, exhausted),
            # A retry that fails in another way fails the turn in that way.
            ("another failure", [{"root": "root-1", **EXHAUSTED}, logical], None, 2, "Cursor reported a logical provider error."),
            # The chat's conversation could not be read when the turn started, or after the CLI ended, with
            # or without naming it: what the CLI stored is not known, and the prompt is not sent into the
            # conversation a second time.
            ("unread before", [EXHAUSTED], bound, 1, exhausted),
            ("unread after", [{"store": "no sidecar", **EXHAUSTED}], bound, 1, exhausted),
            ("unread after, no init", [{"init": False, "store": "no sidecar", **EXHAUSTED}], bound, 1, exhausted),
        ):
            with self.subTest(case=case), patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0, 0)):
                script = self._retried_cli(*steps, root="root-0")
                if case == "unread before":
                    self.store.unlink()
                events = await self._run_script(script, run_id=f"run-{case}", session_patch=session_patch)
                self.assertEqual(len(self._cli_starts()), starts)
                self.assertEqual(len(self._notices(events)), starts - 1)
                self.assertEqual(next(event for event in events if event["type"] == "error")["message"], message)
                self.assertTrue(events[-1]["is_error"])

    async def test_a_new_conversation_whose_store_cannot_be_read_is_not_given_the_prompt_again(self) -> None:
        # The start ran a tool and moved the root, so the conversation holds the prompt, but its store cannot
        # be read afterwards. A retry with the prompt would begin a second conversation and repeat the work.
        for standalone in (False, True):
            for left in ("no sidecar", "symlink"):
                with self.subTest(standalone=standalone, left=left), patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
                    script = self._retried_cli({"events": TOOL_CALL, "root": "root-1", "store": left, **EXHAUSTED}, {})
                    events = await self._run_script(script, run_id=f"run-{standalone}-{left}", standalone=standalone)
                    self.assertEqual(len(self._cli_starts()), 1)
                    self.assertEqual(self._notices(events), [])
                    self.assertIn("returned RESOURCE_EXHAUSTED", next(event for event in events if event["type"] == "error")["message"])
                    self.assertTrue(events[-1]["is_error"])

    async def test_a_new_conversation_is_bound_to_the_chat_before_the_wait_only_when_it_holds_the_prompt(self) -> None:
        saved = agent_server.cursor_history.LocalSession(
            "cursor-sess-test", self.cwd, None, 0.0, Path(self.cwd) / "transcript.jsonl",
        )
        append_event = agent_server.append_event
        for case, first, bound_in_the_wait, resumed in (
            # The conversation holds the prompt: the chat keeps it from the first failure on, whatever ends
            # the turn, and the retry resumes it.
            ("stored", {"root": "root-1", **EXHAUSTED}, "cursor-sess-test", True),
            # Nothing was stored: the retry begins another conversation, and the chat must not point at this one.
            ("nothing stored", EXHAUSTED, None, False),
        ):
            in_the_wait = []

            async def append_and_note_the_binding(session_id: str, event_type: str, payload: dict | None = None) -> dict:
                if (payload or {}).get("phase") == "commentary":
                    in_the_wait.append(self.session.get("cursor_session_id"))
                return await append_event(session_id, event_type, payload)

            with self.subTest(case=case), patch.object(
                agent_server.cursor_history, "find_session", return_value=saved,
            ), patch.object(agent_server, "append_event", append_and_note_the_binding), patch.object(
                agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,),
            ):
                self.session.pop("cursor_session_id", None)  # The case before bound the chat.
                events = await self._run_script(self._retried_cli(first, {"events": [_result_event("Done.")]}), run_id=f"run-{case}")
                self.assertEqual(in_the_wait, [bound_in_the_wait])
                self.assertEqual("--resume" in self._cli_starts()[1]["argv"], resumed)
                # The turn's success binds the chat in both cases. The binding is reported once per turn.
                self.assertEqual(self.session.get("cursor_session_id"), "cursor-sess-test")
                self.assertEqual([event["type"] for event in events].count("provider_session"), 1)

    async def test_a_retried_turn_reports_its_working_directory_once(self) -> None:
        gone = str(Path(self.tempdir.name) / "gone")
        with patch.object(agent_server, "DEFAULT_CWD", self.cwd), patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0, 0)):
            events = await self._run_script(
                self._retried_cli(EXHAUSTED, EXHAUSTED, {"events": [_result_event("Done.")]}), session_patch={"cwd": gone},
            )
        self.assertEqual(len(self._cli_starts()), 3)
        self.assertEqual([(event["requested_cwd"], event["cwd"]) for event in events if event["type"] == "cwd_fallback"], [(gone, self.cwd)])

    async def test_the_result_of_a_retried_turn_holds_the_text_of_every_start(self) -> None:
        def text(part: str) -> dict:
            return {"type": "assistant", "session_id": "cursor-sess-test", "message": {"role": "assistant", "content": [{"type": "text", "text": part}]}}

        script = self._retried_cli(
            {"events": [text("Part one."), *TOOL_CALL], "root": "root-1", **EXHAUSTED},
            # The CLI's result is the text of its own start, joined without a separator.
            {"events": [text("Part two."), *TOOL_CALL, text("Part three."), _result_event("Part two.Part three.")]},
        )
        with patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
            events = await self._run_script(script)
        self.assertEqual([event["text"] for event in events if event["type"] == "assistant_text"], ["Part one.", "Part two.", "Part three."])
        # The apps and shared chats show the terminal text in place of the text rows only when it holds them all.
        self.assertEqual(events[-1]["result_text"], "Part one.Part two.Part three.")

    async def test_a_provider_error_that_leaves_a_tool_call_open_is_retried_and_the_call_is_closed(self) -> None:
        script = self._retried_cli({"events": TOOL_CALL[:1], "root": "root-1", **EXHAUSTED}, {"events": [_result_event("Done.")]})
        with patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
            events = await self._run_script(script)
        self.assertEqual([event["type"] for event in events], [
            "process_started", "tool_started", "tool_finished", "reasoning_summary",
            "process_started", "provider_session", "turn_finished",
        ])
        # The call's row is closed as failed before the notice, so it does not read as running during the wait.
        self.assertEqual(
            (events[2]["tool_id"], events[2]["exit_code"], events[2]["output"]),
            ("call-1", 1, "Cursor tool did not emit a completion event."),
        )
        self.assertFalse(events[-1]["is_error"])

    async def test_the_absolute_turn_timeout_bounds_a_turn_whose_every_start_makes_progress(self) -> None:
        agent_server.CURSOR_TURN_TIMEOUT_SECONDS = 100
        # Each start runs a tool before the provider fails, so every wait is the first of the schedule, 30
        # seconds: the fourth wait reaches the timeout.
        with self._retry_clock():
            events = await self._run_script(self._retried_cli(*[{"events": TOOL_CALL, **EXHAUSTED}] * 5))
        self.assertEqual(len(self._cli_starts()), 4)
        self.assertEqual(len(self._notices(events)), 4)
        error, = (event for event in events if event["type"] == "error")
        terminal, = (event for event in events if event["type"] == "turn_finished")
        self.assertEqual(error["message"], "Cursor exceeded the absolute turn timeout of 100 seconds.")
        self.assertEqual((terminal["is_error"], terminal["message"]), (True, error["message"]))
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)

    async def test_the_absolute_turn_timeout_of_a_retry_counts_the_wait_before_it(self) -> None:
        agent_server.CURSOR_TURN_TIMEOUT_SECONDS = 34
        # The wait takes 30 of the 34 seconds, so the retry, which hangs, is ended about 4 seconds after it
        # starts. A timeout counted from the retry's own start would end it after 34.
        began = time.monotonic()
        with self._retry_clock():
            events = await self._run_script(self._retried_cli({"events": TOOL_CALL, **EXHAUSTED}, {"hang": 60}))
        self.assertLess(time.monotonic() - began, 20)
        self.assertEqual(len(self._cli_starts()), 2)
        self.assertEqual(
            [event["message"] for event in events if event["type"] == "error"],
            ["Cursor exceeded the absolute turn timeout of 34 seconds."],
        )
        self.assertTrue(events[-1]["is_error"])

    async def test_a_retry_that_cannot_be_started_ends_the_turn_with_what_the_earlier_starts_produced(self) -> None:
        target = Path(self.cwd) / "hello.py"
        target.write_text("before\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.cwd, check=True)
        subprocess.run(["git", "add", "hello.py"], cwd=self.cwd, check=True)
        subprocess.run(
            ["git", "-c", "user.name=AgentsDock Test", "-c", "user.email=test@agentsdock.invalid", "commit", "-qm", "baseline"],
            cwd=self.cwd, check=True,
        )
        write = [
            {"type": "tool_call", "subtype": subtype, "call_id": "write-1", "session_id": "cursor-sess-test",
             "tool_call": {"writeToolCall": {"args": {"path": str(target)}, **({"result": {"success": {"path": str(target)}}} if subtype == "completed" else {})}}}
            for subtype in ("started", "completed")
        ]
        # The hub answers the first start's request for a token and fails the retry's; in the second case
        # Stop was requested by then.
        for stop_requested in (False, True):
            answered = []

            def hub_env(env: dict) -> dict:
                answered.append(env)
                if len(answered) == 1:
                    return env
                if stop_requested:
                    agent_server.STOP_REQUESTS.add(self.session_id)
                raise RuntimeError("hub sign-in expired")

            with self.subTest(stop_requested=stop_requested), patch.object(
                agent_server, "HUB_PROVIDER_INSTALL", Path(self.tempdir.name),
            ), patch.object(agent_server, "cursor_hub_env", side_effect=hub_env), patch.object(
                agent_server, "collect_manifest", wraps=agent_server.collect_manifest,
            ) as manifest, patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
                target.write_text("before\n", encoding="utf-8")
                self.session.pop("cursor_session_id", None)
                events = await self._run_script(
                    self._retried_cli({"events": write, "write": str(target), "root": "root-1", **EXHAUSTED}),
                    run_id=f"run-{stop_requested}",
                )
                self.assertEqual(len(self._cli_starts()), 1)
                # The diff and the artifacts of the start that ran are published.
                self.assertEqual(next(event for event in events if event["type"] == "code_diff")["attributed_paths"], ["hello.py"])
                self.assertEqual([call.kwargs["final"] for call in manifest.await_args_list].count(True), 1)
                errors = [event["message"] for event in events if event["type"] == "error"]
                terminal = events[-1]
                if stop_requested:
                    self.assertEqual((terminal["type"], terminal["stopped"], terminal["is_error"], errors), ("turn_finished", True, False, []))
                else:
                    self.assertEqual(errors, ["failed to start Cursor: hub sign-in expired"])
                    self.assertEqual((terminal["type"], terminal["is_error"], terminal["message"]), ("turn_finished", True, errors[0]))
                self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)

    def _start_script(self, body: str, run_id: str) -> asyncio.Task:
        """The run as start_turn starts it: supervised, with the turn's row already recorded on the chat."""
        script = _write_fake_cli(Path(self.tempdir.name), body)
        self._arm_run(run_id)
        self.session["active_run"] = {"run_id": run_id}
        return asyncio.create_task(agent_server.supervise_provider_turn_task(
            self.session_id, run_id, agent_server.BACKEND_CURSOR,
            agent_server.run_cursor(
                self.session_id, run_id, "hello", {**self.session, "_cursor_executable": str(script)},
                Path(self.tempdir.name) / "manifest.json",
            ),
        ))

    async def _reach_the_wait(self, task: asyncio.Task) -> None:
        for _ in range(500):
            if self._waiting():
                return
            await asyncio.sleep(0.01)
        task.cancel()
        self.fail("the turn never reached its wait")

    async def test_stop_during_the_wait_ends_the_turn_as_stopped_without_waiting_for_its_diff(self) -> None:
        async def slow_diff(*_args: object) -> None:
            await asyncio.sleep(1)

        # The real schedule: the wait is 30 seconds, and Stop ends it. The turn's diff takes longer than Stop
        # waits for a turn to end (5 seconds, shortened here).
        with patch.object(agent_server, "publish_turn_code_diff", slow_diff), patch.object(agent_server, "STOP_CONFIRM_TIMEOUT_SECONDS", 0.5):
            task = self._start_script(self._retried_cli({"events": TOOL_CALL, "root": "root-1", **EXHAUSTED}), "run-stop-wait")
            await self._reach_the_wait(task)
            try:
                result = await asyncio.wait_for(agent_server.stop_turn(
                    self.session_id, schedule_queue=False, cascade_codex_subagents=False, cascade_claude_subagents=False,
                ), timeout=3)
                await asyncio.wait_for(task, timeout=3)
            finally:
                task.cancel()
        self.assertTrue(result["stopped"])
        self.assertNotIn("hard_stop", result)
        events = self._read_events()
        self.assertEqual((events[-1]["type"], events[-1]["stopped"], events[-1]["is_error"]), ("turn_finished", True, False))
        self.assertNotIn("message", events[-1])
        self.assertEqual([event["type"] for event in events if event["type"] in ("error", "turn_stopped")], [])
        self.assertEqual(len(self._cli_starts()), 1)
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)

    async def test_send_now_during_the_wait_stops_the_turn_and_starts_the_queued_message(self) -> None:
        agent_server.QUEUED_TURNS[self.session_id] = deque([
            {"queued_id": "queued-1", "prompt": "next", "file_ids": [], "backend": agent_server.BACKEND_CURSOR},
        ])
        with patch.object(agent_server, "append_durable_event", AsyncMock(return_value={})), patch.object(
            agent_server, "_start_turn_locked", AsyncMock(return_value={}),
        ) as start_turn, patch.object(agent_server, "STEERING_SESSIONS", set()), patch.object(
            agent_server, "STEERING_WAIT_TASKS", {},
        ), patch.object(agent_server, "RUN_NOW_REQUESTS", {}), patch.object(agent_server, "RUN_NOW_COMPLETED_RESULTS", OrderedDict()):
            task = self._start_script(self._retried_cli({"events": TOOL_CALL, "root": "root-1", **EXHAUSTED}), "run-send-now")
            await self._reach_the_wait(task)
            try:
                result = await asyncio.wait_for(agent_server.run_queued_turn_now(self.session_id, "queued-1"), timeout=3)
                await asyncio.wait_for(task, timeout=3)
                for _ in range(300):
                    if start_turn.await_count:
                        break
                    await asyncio.sleep(0.01)
            finally:
                task.cancel()
        self.assertEqual((result["ok"], result["interrupted"], result["deferred"]), (True, True, False))
        events = self._read_events()
        self.assertEqual((events[-1]["type"], events[-1]["stopped"]), ("turn_finished", True))
        self.assertEqual(len(self._cli_starts()), 1)
        # The queued message starts once the stopped turn has released the chat.
        start_turn.assert_awaited_once()
        self.assertEqual((start_turn.await_args.args[0], start_turn.await_args.kwargs["queued_id"]), (self.session_id, "queued-1"))
        self.assertIn("next", start_turn.await_args.args[1].prompt)

    async def test_a_server_shutdown_ends_the_wait_and_no_retry_is_started(self) -> None:
        task = self._start_script(self._retried_cli({"events": TOOL_CALL, "root": "root-1", **EXHAUSTED}), "run-shutdown")
        await self._reach_the_wait(task)
        try:
            with patch.object(agent_server, "SERVER_SHUTTING_DOWN", True):
                await asyncio.wait_for(task, timeout=3)
        finally:
            task.cancel()
        self.assertEqual(len(self._cli_starts()), 1)
        # The turn ends with the provider's error, which its last start returned.
        terminal = self._read_events()[-1]
        self.assertEqual((terminal["type"], terminal["is_error"], terminal["stopped"]), ("turn_finished", True, False))
        self.assertIn("returned RESOURCE_EXHAUSTED", terminal["message"])

    async def test_a_retried_standalone_run_resumes_its_own_conversation(self) -> None:
        parent = {"cursor_session_id": "parent-chat", "session_id": "parent-chat"}
        self.session.update(parent)
        script = self._retried_cli(
            {"events": TOOL_CALL, "root": "root-1", **EXHAUSTED}, {"events": [_result_event("Done.")], "root": "root-2"},
        )
        with patch.object(agent_server, "CURSOR_PROVIDER_RETRY_WAITS_SECONDS", (0,)):
            events = await self._run_script(script, standalone=True, session_patch=parent)
        self.assertFalse(events[-1]["is_error"], events)
        first, second = self._cli_starts()
        # The run starts without the chat's conversation, and its retry resumes the one the run began.
        self.assertNotIn("--resume", first["argv"])
        self.assertEqual((second["argv"][second["argv"].index("--resume") + 1], second["prompt"]), ("cursor-sess-test", "go on"))
        # Neither start records a root for a rewind of the chat, and the chat keeps its own conversation.
        self.assertEqual([event.get("cursor_root_blob_id") for event in events if event["type"] == "process_started"], [None, None])
        self.assertEqual(self.session["cursor_session_id"], "parent-chat")

    async def test_session_id_is_pinned_across_every_projected_event(self) -> None:
        for event in (
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "wrong"}],
                },
                "session_id": "different-session",
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "missing"}],
                },
            },
        ):
            run_id = "run-" + (event.get("session_id") or "missing")
            events = await self._run_script(
                _event_script([_init_event(), event, _result_event()]),
                run_id=run_id,
            )
            terminal = next(
                item for item in events if item["type"] == "turn_finished"
            )
            self.assertTrue(terminal["is_error"])
            self.assertEqual(terminal["result_text"], "")
            self.assertTrue(any(item["type"] == "error" for item in events))

    async def test_concurrent_stderr_drain_prevents_pipe_deadlock(self) -> None:
        events = await asyncio.wait_for(
            self._run_script(
                _event_script(
                    [_init_event(), _result_event("drained")],
                    stderr_bytes=2 * 1024 * 1024,
                )
            ),
            timeout=5,
        )
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertFalse(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "drained")

    async def test_terminal_event_with_hung_process_is_not_committed_as_resumable(self) -> None:
        agent_server.CURSOR_POST_TERMINAL_EXIT_SECONDS = 0.05
        self.session["backend_locked"] = True
        started = time.monotonic()
        events = await self._run_script(
            _event_script(
                [_init_event(), _result_event("complete before hang")],
                hang_after=10,
            )
        )
        self.assertLess(time.monotonic() - started, 2)
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")
        self.assertNotIn("cursor_session_id", self.session)
        self.assertTrue(self.session["backend_locked"])
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("did not exit cleanly", error["message"])

    async def test_failed_first_turn_never_commits_a_provisional_cursor_session(self) -> None:
        self.session["backend_locked"] = True
        events = await self._run_script(_event_script([
            _init_event("provisional-cursor-id"),
            _result_event(
                "provider failure",
                session_id="provisional-cursor-id",
                is_error=True,
            ),
        ]))

        self.assertTrue(next(
            event for event in events if event["type"] == "turn_finished"
        )["is_error"])
        self.assertNotIn("cursor_session_id", self.session)
        self.assertNotIn("session_id", self.session)
        self.assertTrue(self.session["backend_locked"])
        self.assertFalse(any(
            event["type"] == "provider_session" for event in events
        ))

    async def test_failed_resumed_turn_preserves_original_cursor_binding(self) -> None:
        self.session.update({
            "backend_locked": True,
            "cursor_session_id": "existing-cursor-id",
            "session_id": "existing-cursor-id",
            "cursor_instruction_hash": "existing-hash",
            "cursor_instruction_version": "existing-version",
        })
        before = dict(self.session)
        events = await self._run_script(_event_script([
            _init_event("existing-cursor-id"),
            _result_event(
                "provider failure",
                session_id="existing-cursor-id",
                is_error=True,
            ),
        ]), session_patch=self.session)

        self.assertTrue(next(
            event for event in events if event["type"] == "turn_finished"
        )["is_error"])
        for key in (
            "backend_locked",
            "cursor_session_id",
            "session_id",
            "cursor_instruction_hash",
            "cursor_instruction_version",
        ):
            self.assertEqual(self.session.get(key), before.get(key))

    async def test_a_run_records_the_root_its_chats_conversation_stood_at(self) -> None:
        config = Path(self.tempdir.name) / "cursor-config"
        store = config / "chats" / "bucket" / "existing-cursor-id"
        store.mkdir(parents=True)
        with sqlite3.connect(store / "store.db") as db:
            db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO meta VALUES ('0', ?)", (json.dumps({
                "agentId": "existing-cursor-id", "latestRootBlobId": "ab" * 32,
            }).encode().hex(),))
        (store / "meta.json").write_text(json.dumps({"cwd": self.cwd}))
        bound = {"cursor_session_id": "existing-cursor-id", "session_id": "existing-cursor-id"}
        resumed = _event_script([_init_event("existing-cursor-id"), _result_event(session_id="existing-cursor-id")])

        def recorded(events: list[dict]) -> str | None:
            return next(event for event in events if event["type"] == "process_started").get("cursor_root_blob_id")

        with patch.dict(os.environ, {"CURSOR_CONFIG_DIR": str(config)}):
            # No conversation yet: a rewind to this run starts a new one.
            self.assertEqual(recorded(await self._run_script(_event_script([_init_event(), _result_event()]))), "")
            self.assertEqual(recorded(await self._run_script(resumed, run_id="run-cursor-2", session_patch=bound)), "ab" * 32)
            # A standalone run is handed a clone of the chat without its conversation. It records nothing:
            # "" would let a rewind onto it take the chat's conversation for one this run began.
            self.assertIsNone(recorded(await self._run_script(
                _event_script([_init_event("standalone-id"), _result_event(session_id="standalone-id")]),
                run_id="run-cursor-3", standalone=True,
                session_patch=agent_server.standalone_provider_session({**self.session, **bound}),
            )))
            # Metadata that names no root is a store that cannot be read: "" would say the chat had no conversation.
            with sqlite3.connect(store / "store.db") as db:
                db.execute("UPDATE meta SET value = ? WHERE key = '0'", (json.dumps({
                    "agentId": "existing-cursor-id", "latestRootBlobId": "",
                }).encode().hex(),))
            self.assertIsNone(recorded(await self._run_script(resumed, run_id="run-cursor-5", session_patch=bound)))
            # Nothing is recorded for a store that cannot be read, and the turn still runs.
            (store / "store.db").unlink()
            events = await self._run_script(resumed, run_id="run-cursor-4", session_patch=bound)
            self.assertIsNone(recorded(events))
            self.assertEqual(next(event for event in events if event["type"] == "turn_finished")["exit_code"], 0)

    async def test_active_cursor_turn_stops_and_releases_process(self) -> None:
        script = _write_fake_cli(
            Path(self.tempdir.name),
            """#!/usr/bin/env python3
import json, time
print(json.dumps({"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}), flush=True)
while True:
    print("heartbeat", flush=True)
    time.sleep(0.01)
""",
        )
        runner_session = {**self.session, "_cursor_executable": str(script)}
        self._arm_run("run-cursor-stop")
        task = asyncio.create_task(
            agent_server.run_cursor(
                self.session_id,
                "run-cursor-stop",
                "hello",
                runner_session,
                Path(self.tempdir.name) / "manifest.json",
            )
        )
        try:
            for _ in range(200):
                active = agent_server.ACTIVE.get(self.session_id)
                if active and active.get("provider_turn_ready"):
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("Cursor runner never reached its active ready state")

            result = await asyncio.wait_for(
                agent_server.stop_turn(
                    self.session_id,
                    schedule_queue=False,
                    cascade_codex_subagents=False,
                    cascade_claude_subagents=False,
                ),
                timeout=3,
            )
            await asyncio.wait_for(task, timeout=3)
        finally:
            if not task.done():
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        self.assertTrue(result["stopped"])
        self.assertNotIn(self.session_id, agent_server.ACTIVE)
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)
        terminal = next(
            event
            for event in self._read_events()
            if event.get("run_id") == "run-cursor-stop"
            and event["type"] == "turn_finished"
        )
        self.assertTrue(terminal["stopped"])
        self.assertFalse(terminal["is_error"])

    async def test_process_endpoint_never_exposes_cursor_prompt_or_user_echo(
        self,
    ) -> None:
        secret = "AUTHORITY-SENTINEL-CURSOR-PROCESS-LEAK"
        script = _write_fake_cli(
            Path(self.tempdir.name),
            """#!/usr/bin/env python3
import json, sys, time
prompt = sys.stdin.read()
session_id = "cursor-sess-test"
print(json.dumps({"type":"system","subtype":"init","session_id":session_id,"cwd":".","model":"Auto"}), flush=True)
print(json.dumps({"type":"user","message":{"role":"user","content":prompt},"session_id":session_id}), flush=True)
while True:
    time.sleep(0.01)
""",
        )
        runner_session = {
            **self.session,
            "system_prompt": f"System {secret}",
            "_cursor_executable": str(script),
        }
        self._arm_run("run-cursor-private")
        task = asyncio.create_task(
            agent_server.run_cursor(
                self.session_id,
                "run-cursor-private",
                f"User {secret}",
                runner_session,
                Path(self.tempdir.name) / "manifest.json",
            )
        )
        try:
            for _ in range(200):
                active = agent_server.ACTIVE.get(self.session_id)
                if active and active.get("provider_turn_ready"):
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("Cursor runner never reached its active ready state")

            pid = int(active["pid"])
            pgid = int(active["pgid"])
            leaked_args = f"{script} -p --output-format stream-json --trust"
            process_row = {
                "pid": pid,
                "ppid": 1,
                "pgid": pgid,
                "sid": pgid,
                "stat": "S",
                "elapsed_seconds": 1,
                "cpu_percent": 0.0,
                "mem_percent": 0.0,
                "rss_kb": 1024,
                "command": str(script),
                "args": leaked_args,
            }
            with patch.object(
                agent_server,
                "ps_process_rows",
                return_value=[process_row],
            ), patch.object(
                agent_server,
                "proc_cwd",
                return_value=self.cwd,
            ), patch.object(
                agent_server,
                "fd_log_hints",
                return_value=[],
            ):
                snapshot = await agent_server.get_session_processes(
                    self.session_id
                )
        finally:
            await agent_server.stop_turn(
                self.session_id,
                emit_event=False,
                schedule_queue=False,
                cascade_codex_subagents=False,
                cascade_claude_subagents=False,
            )
            await asyncio.wait_for(task, timeout=3)

        serialized = json.dumps(snapshot)
        self.assertNotIn(secret, serialized)
        self.assertNotIn("AgentsDock provider instructions", serialized)
        self.assertNotIn("<prompt>", serialized)
        self.assertTrue(snapshot["processes"][0]["args_redacted"])
        self.assertNotIn(secret, snapshot["stdout_tail"]["text"])
        self.assertNotIn("Current user prompt", snapshot["stdout_tail"]["text"])

    async def test_cursor_prebind_stop_hard_terminalizes_stale_runner(self) -> None:
        self._arm_run("run-cursor-prebind")

        async def never_binds() -> None:
            await asyncio.Future()

        stale_runner = asyncio.create_task(never_binds())
        turn_tasks = {self.session_id: {stale_runner}}
        try:
            with patch.object(agent_server, "SESSION_TURN_TASKS", turn_tasks), patch.object(
                agent_server,
                "STOP_CONFIRM_TIMEOUT_SECONDS",
                0.02,
            ):
                result = await agent_server.stop_turn(
                    self.session_id,
                    schedule_queue=False,
                    cascade_codex_subagents=False,
                    cascade_claude_subagents=False,
                )
        finally:
            if not stale_runner.done():
                stale_runner.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await stale_runner

        self.assertTrue(result["stopped"])
        self.assertTrue(result["hard_stop"])
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)
        stopped = next(
            event
            for event in self._read_events()
            if event.get("run_id") == "run-cursor-prebind"
            and event["type"] == "turn_stopped"
        )
        self.assertEqual(stopped["backend"], agent_server.BACKEND_CURSOR)

    async def test_cursor_does_not_deliver_prompt_when_binding_is_stale(self) -> None:
        script = _write_fake_cli(
            Path(self.tempdir.name),
            "#!/usr/bin/env python3\nimport sys, time\nsys.stdin.read()\ntime.sleep(60)\n",
        )
        runner_session = {**self.session, "_cursor_executable": str(script)}
        self._arm_run("run-cursor-stale-bind", "do not deliver")

        with patch.object(
            agent_server,
            "bind_active_turn",
            return_value=(False, False),
        ), patch.object(
            agent_server,
            "write_cursor_process_stdin",
        ) as write_stdin:
            await asyncio.wait_for(
                agent_server.run_cursor(
                    self.session_id,
                    "run-cursor-stale-bind",
                    "do not deliver",
                    runner_session,
                    Path(self.tempdir.name) / "manifest.json",
                ),
                timeout=3,
            )

        write_stdin.assert_not_awaited()

    async def test_cursor_cancelled_during_binding_cleans_up_without_prompt(self) -> None:
        child_pid_file = Path(self.tempdir.name) / "prebind-child.pid"
        script = _write_fake_cli(
            Path(self.tempdir.name),
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys, time\n"
            f"pathlib.Path({str(child_pid_file)!r}).write_text(str(os.getpid()))\n"
            "sys.stdin.read()\n"
            "time.sleep(60)\n",
        )
        runner_session = {**self.session, "_cursor_executable": str(script)}
        self._arm_run("run-cursor-cancelled-bind", "do not deliver")
        bind_entered = asyncio.Event()

        async def blocked_bind(*_args: object, **_kwargs: object) -> tuple[bool, bool]:
            bind_entered.set()
            await asyncio.Future()

        with patch.object(
            agent_server,
            "bind_active_turn",
            side_effect=blocked_bind,
        ), patch.object(
            agent_server,
            "write_cursor_process_stdin",
        ) as write_stdin:
            task = asyncio.create_task(agent_server.run_cursor(
                self.session_id,
                "run-cursor-cancelled-bind",
                "do not deliver",
                runner_session,
                Path(self.tempdir.name) / "manifest.json",
            ))
            await asyncio.wait_for(bind_entered.wait(), timeout=2)
            deadline = time.monotonic() + 2
            while not child_pid_file.exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            self.assertTrue(child_pid_file.exists())
            child_pid = int(child_pid_file.read_text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=3)

        write_stdin.assert_not_awaited()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.02)
        else:
            try:
                os.kill(child_pid, 9)
            except ProcessLookupError:
                pass
            self.fail("Cursor child survived cancellation during bind")

    async def test_cursor_does_not_deliver_prompt_for_a_preexisting_stop(self) -> None:
        script = _write_fake_cli(
            Path(self.tempdir.name),
            "#!/usr/bin/env python3\nimport sys, time\nsys.stdin.read()\ntime.sleep(60)\n",
        )
        runner_session = {**self.session, "_cursor_executable": str(script)}
        self._arm_run("run-cursor-prestopped", "do not deliver")
        agent_server.STOP_REQUESTS.add(self.session_id)

        with patch.object(
            agent_server,
            "write_cursor_process_stdin",
        ) as write_stdin:
            await asyncio.wait_for(
                agent_server.run_cursor(
                    self.session_id,
                    "run-cursor-prestopped",
                    "do not deliver",
                    runner_session,
                    Path(self.tempdir.name) / "manifest.json",
                ),
                timeout=3,
            )

        write_stdin.assert_not_awaited()

    async def test_startup_timeout_fails_and_releases_turn(self) -> None:
        agent_server.CURSOR_STARTUP_TIMEOUT_SECONDS = 0.05
        agent_server.CURSOR_TURN_TIMEOUT_SECONDS = 1
        events = await self._run_script(
            """#!/usr/bin/env python3
import time
time.sleep(10)
"""
        )
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")
        self.assertNotIn(self.session_id, agent_server.BUSY_SESSIONS)

    async def test_absolute_timeout_applies_despite_continuous_output(self) -> None:
        agent_server.CURSOR_STARTUP_TIMEOUT_SECONDS = 0.2
        agent_server.CURSOR_TURN_TIMEOUT_SECONDS = 0.15
        events = await self._run_script(
            """#!/usr/bin/env python3
import json, time
print(json.dumps({"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}), flush=True)
while True:
    print("heartbeat", flush=True)
    time.sleep(0.01)
"""
        )
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        error = next(event for event in events if event["type"] == "error")
        self.assertIn("absolute turn timeout", error["message"])

    async def test_pending_live_cross_chat_wait_pauses_cursor_watchdogs(self) -> None:
        agent_server.CURSOR_STARTUP_TIMEOUT_SECONDS = 0.05
        agent_server.CURSOR_TURN_TIMEOUT_SECONDS = 0.05
        agent_server.CURSOR_IDLE_WARN_SECONDS = 0.01
        agent_server.CURSOR_IDLE_TIMEOUT_SECONDS = 0.03
        with patch.object(
            agent_server,
            "provider_run_owns_pending_cross_chat_live_wait",
            return_value=True,
        ):
            events = await self._run_script(
                """#!/usr/bin/env python3
import json, sys, time
sys.stdin.read()
session_id = "cursor-sess-test"
print(json.dumps({"type":"system","subtype":"init","session_id":session_id,"cwd":".","model":"Auto"}), flush=True)
time.sleep(0.12)
print(json.dumps({"type":"result","subtype":"success","is_error":False,"result":"peer answered","session_id":session_id}), flush=True)
"""
            )

        terminal = next(
            event for event in events if event["type"] == "turn_finished"
        )
        self.assertFalse(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "peer answered")
        self.assertFalse(any(
            event["type"] in {"error", "idle_warning"}
            for event in events
        ))

    async def test_idle_warning_is_emitted_once_per_idle_period(self) -> None:
        # Process/guard startup is a separate idle period. Arm the short
        # thresholds only after init so slow CI startup cannot add a warning
        # before the single post-init idle period this test exercises.
        startup_idle_deadline = (
            agent_server.CURSOR_STARTUP_TIMEOUT_SECONDS
            + agent_server.CURSOR_TURN_TIMEOUT_SECONDS
        )
        agent_server.CURSOR_IDLE_WARN_SECONDS = startup_idle_deadline
        agent_server.CURSOR_IDLE_TIMEOUT_SECONDS = startup_idle_deadline
        mark_ready = agent_server.mark_provider_turn_ready

        async def arm_idle_after_ready(session_id, run_id, provider_session_id=None):
            await mark_ready(session_id, run_id, provider_session_id)
            self.assertTrue(agent_server.ACTIVE[session_id]["provider_turn_ready"])
            agent_server.CURSOR_IDLE_WARN_SECONDS = 0.02
            agent_server.CURSOR_IDLE_TIMEOUT_SECONDS = 0.12

        with patch.object(
            agent_server, "mark_provider_turn_ready", side_effect=arm_idle_after_ready,
        ) as ready:
            events = await self._run_script(
                """#!/usr/bin/env python3
import json, sys, time
sys.stdin.read()
print(json.dumps({"type":"system","subtype":"init","session_id":"cursor-sess-test","cwd":".","model":"Auto"}), flush=True)
time.sleep(5)
"""
            )
        ready.assert_awaited_once_with(self.session_id, "run-cursor-1", "cursor-sess-test")
        warnings = [event for event in events if event["type"] == "idle_warning"]
        self.assertEqual(len(warnings), 1)
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])

    async def test_missing_runtime_is_a_failed_terminal(self) -> None:
        self._arm_run("run-cursor-1")
        with patch.object(agent_server, "resolve_cursor_executable", return_value=None):
            await agent_server.run_cursor(
                self.session_id,
                "run-cursor-1",
                "hello",
                dict(self.session),
                Path(self.tempdir.name) / "manifest.json",
            )
        events = self._read_events()
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")

    async def test_spawn_failure_is_a_failed_terminal(self) -> None:
        runner = {
            **self.session,
            "_cursor_executable": str(Path(self.tempdir.name) / "missing-agent"),
        }
        self._arm_run("run-cursor-1")
        await agent_server.run_cursor(
            self.session_id,
            "run-cursor-1",
            "hello",
            runner,
            Path(self.tempdir.name) / "manifest.json",
        )
        terminal = next(
            event
            for event in self._read_events()
            if event["type"] == "turn_finished"
        )
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")

    async def test_tool_state_and_payloads_are_bounded(self) -> None:
        huge_id = "call-" + ("z" * 235)
        huge_args = {"nested": {"value": "a" * 100_000}}
        huge_reason = "r" * 100_000
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "started",
                "call_id": huge_id,
                "tool_call": {"shellToolCall": {"args": huge_args}},
                "session_id": "cursor-sess-test",
            },
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": huge_id,
                "tool_call": {
                    "shellToolCall": {
                        "result": {"rejected": {"reason": huge_reason}}
                    }
                },
                "session_id": "cursor-sess-test",
            },
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "without-start",
                "tool_call": {
                    (("n" * 1000) + "ToolCall"): {
                        "result": {"success": {"output": "o" * 100_000}}
                    }
                },
                "session_id": "cursor-sess-test",
            },
            _result_event(),
        ]))
        started = next(event for event in events if event["type"] == "tool_started")
        self.assertLessEqual(len(started["tool"]["id"]), 240)
        self.assertLess(len(json.dumps(started["tool"]["input"])), 20_000)
        completed = [event for event in events if event["type"] == "tool_finished"]
        self.assertTrue(completed)
        self.assertTrue(all(len(event["tool_id"]) <= 240 for event in completed))
        self.assertTrue(all(len(event["tool"]["name"]) <= 240 for event in completed))
        self.assertTrue(all(len(str(event["output"])) < 150_000 for event in completed))

    async def test_invalid_tool_call_id_fails_closed_without_projection(self) -> None:
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "tool_call",
                "subtype": "started",
                "tool_call": {"readToolCall": {"args": {"path": "a"}}},
                "session_id": "cursor-sess-test",
            },
            _result_event(),
        ]))
        self.assertFalse(any(event["type"] == "tool_started" for event in events))
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")

    async def test_tool_cardinality_ceiling_fails_visibly(self) -> None:
        agent_server.CURSOR_MAX_TOOL_CALLS = 2
        tool_events = []
        for index in range(3):
            tool_events.append({
                "type": "tool_call",
                "subtype": "started",
                "call_id": f"call-{index}",
                "tool_call": {"readToolCall": {"args": {"path": str(index)}}},
                "session_id": "cursor-sess-test",
            })
        events = await self._run_script(
            _event_script([_init_event(), *tool_events, _result_event()])
        )
        self.assertEqual(
            len([event for event in events if event["type"] == "tool_started"]),
            2,
        )
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        self.assertEqual(terminal["result_text"], "")

    async def test_stream_event_ceiling_bounds_durable_output(self) -> None:
        agent_server.CURSOR_MAX_STREAM_EVENTS = 3
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "thinking",
                "subtype": "delta",
                "text": "one",
                "session_id": "cursor-sess-test",
            },
            {
                "type": "thinking",
                "subtype": "delta",
                "text": "two",
                "session_id": "cursor-sess-test",
            },
            {
                "type": "thinking",
                "subtype": "delta",
                "text": "three",
                "session_id": "cursor-sess-test",
            },
            _result_event(),
        ]))
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertTrue(terminal["is_error"])
        # Deltas are buffered into one reasoning block, so the ceiling is
        # asserted on retained content rather than event count: the two
        # deltas admitted before the ceiling are published, and the third
        # one never reaches durable output.
        reasoning = [
            event for event in events if event["type"] == "reasoning_summary"
        ]
        self.assertEqual(len(reasoning), 1)
        self.assertEqual(reasoning[0]["text"], "onetwo")
        self.assertNotIn("three", reasoning[0]["text"])

    async def test_thinking_deltas_publish_one_block_per_completed_thought(
        self,
    ) -> None:
        # Cursor streams reasoning token-by-token. Publishing each delta as
        # its own durable event made one thought render as a burst of
        # answer-looking blocks that the timeline then reconciled away
        # (the "reasoning flashes then disappears" report).
        def delta(text: str) -> dict:
            return {
                "type": "thinking",
                "subtype": "delta",
                "text": text,
                "session_id": "cursor-sess-test",
            }

        events = await self._run_script(_event_script([
            _init_event(),
            delta("The user wants "),
            delta("a logo, so I "),
            delta("will draft one."),
            {
                "type": "thinking",
                "subtype": "completed",
                "session_id": "cursor-sess-test",
            },
            delta("Second thought."),
            {
                "type": "thinking",
                "subtype": "completed",
                "session_id": "cursor-sess-test",
            },
            _result_event(),
        ]))

        reasoning = [
            event for event in events if event["type"] == "reasoning_summary"
        ]
        self.assertEqual(len(reasoning), 2)
        self.assertEqual(
            reasoning[0]["text"],
            "The user wants a logo, so I will draft one.",
        )
        self.assertEqual(reasoning[1]["text"], "Second thought.")
        # A thought is the model's reasoning, not a message to the user. Like
        # a Claude thinking block it carries no public `commentary` phase, so
        # the clients keep it inside the collapsed trace.
        for event in reasoning:
            self.assertNotIn("phase", event)

    async def test_buffered_reasoning_is_published_before_the_answer(
        self,
    ) -> None:
        # Cursor does not always send `thinking/completed`; the pending
        # thought must still reach the timeline, and must stay ordered
        # before the answer it produced.
        events = await self._run_script(_event_script([
            _init_event(),
            {
                "type": "thinking",
                "subtype": "delta",
                "text": "Working it out.",
                "session_id": "cursor-sess-test",
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Here it is."}],
                },
                "session_id": "cursor-sess-test",
            },
            _result_event("Here it is."),
        ]))

        ordered = [
            event["type"] for event in events
            if event["type"] in {"reasoning_summary", "assistant_text"}
        ]
        self.assertEqual(ordered, ["reasoning_summary", "assistant_text"])
        reasoning = next(
            event for event in events if event["type"] == "reasoning_summary"
        )
        self.assertEqual(reasoning["text"], "Working it out.")
        self.assertNotIn("phase", reasoning)

    async def test_accumulated_assistant_fallback_is_bounded(self) -> None:
        agent_server.CURSOR_ACCUMULATED_TEXT_MAX_CHARS = 10
        assistant = lambda text: {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
            },
            "session_id": "cursor-sess-test",
        }
        events = await self._run_script(
            _event_script([
                _init_event(),
                assistant("abcdefgh"),
                assistant("ijklmnop"),
                _result_event(""),
            ])
        )
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertFalse(terminal["is_error"])
        self.assertLessEqual(len(terminal["result_text"]), 10)

    async def test_standalone_turn_does_not_mutate_parent_provider_state(self) -> None:
        parent = agent_server.STORE.sessions[self.session_id]
        parent.update({
            "cursor_session_id": "parent-cursor-id",
            "session_id": "parent-cursor-id",
            "cursor_instruction_hash": "parent-hash",
            "cursor_instruction_version": "old-version",
            "memory_seed": "parent memory",
            "memory_seed_used": False,
        })
        before = dict(parent)
        events = await self._run_script(
            _event_script([_init_event("standalone-id"), _result_event(
                "standalone",
                session_id="standalone-id",
            )]),
            session_patch=before,
            standalone=True,
        )
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertFalse(terminal["is_error"])
        for key in (
            "session_id",
            "cursor_session_id",
            "cursor_instruction_hash",
            "cursor_instruction_version",
            "memory_seed_used",
        ):
            self.assertEqual(parent.get(key), before.get(key))

    async def test_start_turn_pins_the_compatibility_probed_cursor_executable(self) -> None:
        pinned = str(Path(self.tempdir.name) / "verified-cursor-agent")
        captured_session: dict = {}

        async def capture_cursor(
            _session_id: str,
            _run_id: str,
            _prompt: str,
            runner_session: dict,
            _manifest_path: Path,
            **_kwargs: object,
        ) -> None:
            captured_session.update(runner_session)

        agent_server.BUSY_SESSIONS.clear()
        agent_server.CURRENT_TURNS.clear()
        with patch.object(
            agent_server,
            "ensure_runtime_available",
            return_value={"status": "ready", "_executable": pinned},
        ), patch.object(
            agent_server,
            "run_cursor",
            side_effect=capture_cursor,
        ), patch.object(
            agent_server,
            "resolve_cursor_executable",
        ) as resolve_cursor, patch.object(
            agent_server,
            "scrub_tmux_global_secret_environment",
        ):
            await agent_server.start_turn(
                self.session_id,
                agent_server.TurnRequest(
                    prompt="Use the admitted Cursor executable",
                    backend=agent_server.BACKEND_CURSOR,
                ),
            )
            for _ in range(300):
                if captured_session:
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("Cursor runner was not scheduled")
            for _ in range(300):
                if self.session_id not in agent_server.BUSY_SESSIONS:
                    break
                await asyncio.sleep(0.01)

        self.assertEqual(captured_session.get("_cursor_executable"), pinned)
        resolve_cursor.assert_not_called()

    async def test_start_turn_scheduled_standalone_cursor_override_isolated_from_parent(
        self,
    ) -> None:
        script = _write_fake_cli(
            Path(self.tempdir.name),
            _event_script([
                _init_event("standalone-cursor-job"),
                _result_event(
                    "scheduled standalone complete",
                    session_id="standalone-cursor-job",
                ),
            ]),
        )
        parent = agent_server.STORE.sessions[self.session_id]
        parent.update({
            "title": "Claude parent",
            "backend": agent_server.BACKEND_CLAUDE,
            "backend_locked": True,
            "session_id": "claude-parent-provider",
            "claude_session_id": "claude-parent-provider",
            "cursor_session_id": None,
            "cursor_instruction_hash": "parked-cursor-hash",
            "cursor_instruction_version": "parked-version",
            "memory_seed": "parent memory remains untouched",
            "memory_seed_used": False,
        })
        before = dict(parent)
        agent_server.BUSY_SESSIONS.clear()
        agent_server.CURRENT_TURNS.clear()

        with patch.object(
            agent_server,
            "ensure_runtime_available",
            return_value={
                "status": "ready",
                "_executable": str(script),
            },
        ), patch.object(
            agent_server,
            "scrub_tmux_global_secret_environment",
        ):
            admitted = await agent_server.start_turn(
                self.session_id,
                agent_server.TurnRequest(
                    prompt="Run scheduled Cursor work",
                    backend=agent_server.BACKEND_CURSOR,
                    purpose="scheduled_job",
                    job_id="job-cursor-standalone",
                ),
                provider_context_mode="standalone",
            )
            # finalize_owned_turn_finished releases the busy slot before it
            # appends turn_finished; wait for the event too, not only the slot.
            for _ in range(500):
                finished = any(event.get("run_id") == admitted["run_id"] and event.get("type") == "turn_finished"
                               for event in self._read_events())
                if finished and self.session_id not in agent_server.BUSY_SESSIONS:
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("standalone Cursor job did not reach terminal state")

        self.assertFalse(admitted["queued"])
        events = [
            event
            for event in self._read_events()
            if event.get("run_id") == admitted["run_id"]
        ]
        terminal = next(event for event in events if event["type"] == "turn_finished")
        self.assertFalse(terminal["is_error"])
        self.assertEqual(terminal["backend"], agent_server.BACKEND_CURSOR)
        self.assertEqual(terminal["job_context_mode"], "standalone")
        for key in (
            "backend",
            "backend_locked",
            "session_id",
            "claude_session_id",
            "cursor_session_id",
            "cursor_instruction_hash",
            "cursor_instruction_version",
            "memory_seed_used",
        ):
            self.assertEqual(parent.get(key), before.get(key))

    async def test_failed_policy_and_fork_memory_are_reinjected_until_success(
        self,
    ) -> None:
        session = agent_server.STORE.sessions[self.session_id]
        session.update({
            "system_prompt": "Always preserve the test contract.",
            "memory_seed": "bounded fork memory sentinel",
            "memory_seed_used": False,
        })
        captured_prompts: list[str] = []
        real_write_cursor_stdin = agent_server.write_cursor_process_stdin

        async def capture_stdin(proc: object, provider_prompt: str) -> None:
            captured_prompts.append(provider_prompt)
            await real_write_cursor_stdin(proc, provider_prompt)

        with patch.object(
            agent_server,
            "write_cursor_process_stdin",
            side_effect=capture_stdin,
        ):
            failed = await self._run_script(
                _event_script([
                    _init_event(),
                    _result_event("provider failure", is_error=True),
                ]),
                run_id="run-policy-failed",
                session_patch=session,
            )
            self.assertTrue(next(
                event for event in failed if event["type"] == "turn_finished"
            )["is_error"])
            self.assertFalse(session["memory_seed_used"])
            self.assertNotIn("cursor_instruction_hash", session)

            succeeded = await self._run_script(
                _event_script([_init_event(), _result_event("success")]),
                run_id="run-policy-success",
                session_patch=session,
            )
            self.assertFalse(next(
                event for event in succeeded if event["type"] == "turn_finished"
            )["is_error"])
            self.assertTrue(session["memory_seed_used"])
            self.assertIn("cursor_instruction_hash", session)

            resumed = await self._run_script(
                _event_script([_init_event(), _result_event("resumed")]),
                run_id="run-policy-resumed",
                session_patch=session,
            )
            self.assertFalse(next(
                event for event in resumed if event["type"] == "turn_finished"
            )["is_error"])

        self.assertEqual(len(captured_prompts), 3)
        self.assertIn("Always preserve the test contract.", captured_prompts[0])
        self.assertIn("bounded fork memory sentinel", captured_prompts[0])
        self.assertIn("Always preserve the test contract.", captured_prompts[1])
        self.assertIn("bounded fork memory sentinel", captured_prompts[1])
        self.assertNotIn("[AgentsDock provider instructions]", captured_prompts[2])
        self.assertNotIn("bounded fork memory sentinel", captured_prompts[2])


class CursorFileDeliveryInstructionTests(unittest.TestCase):
    def test_instructions_route_file_delivery_around_blocked_shell(self) -> None:
        # Real failure this guards (observed in a live chat): Cursor
        # generated an image, its publish command was rejected four times by
        # the permission policy, and it told the user to open the file from
        # disk instead - the image never reached the chat. Writing the
        # manifest needs no shell, so it must be named as the route to use
        # when the publish command cannot run.
        manifest = Path("/tmp/agentsdock-state/sessions/chat-x/manifest.json")
        instructions = agent_server.cursor_provider_instructions(
            "chat-x", {}, manifest
        )

        self.assertIn(str(manifest), instructions)
        self.assertIn('{"files":["/absolute/path.ext"]}', instructions)
        self.assertIn("needs no shell", instructions)
        self.assertIn("generated images", instructions)
        self.assertIn("run on MCP server plugin-agentsdock-internal-9f3a2c71-provider", instructions)
        self.assertNotIn("Use the `agentsdock` provider tool", instructions)
        self.assertNotIn("generated per-turn authority block", instructions)

        authority = agent_server.cross_chat_provider_authority_block(
            [],
            Path("/tmp/run_cursor-authority.json"),
            "chat-x",
            {"publish"},
        )
        self.assertIn('"$AGENTSDOCK_PUBLISH_CLI"', authority)
        self.assertIn("--authority-file", authority)

    def test_instruction_hash_changes_so_live_sessions_reinject(self) -> None:
        # Instructions are only re-sent when their hash changes, so a policy
        # text change has to move the hash or existing chats keep running on
        # the old guidance forever.
        manifest = Path("/tmp/agentsdock-state/sessions/chat-x/manifest.json")
        with patch.object(
            agent_server,
            "CURSOR_FILE_DELIVERY_ADDENDUM",
            "Delivering files: old guidance.\n",
        ):
            previous = agent_server.cursor_instruction_hash(
                "chat-x", {}, manifest
            )
        current = agent_server.cursor_instruction_hash("chat-x", {}, manifest)
        self.assertNotEqual(previous, current)

    def test_policy_version_changes_so_resumed_sessions_reinject(self) -> None:
        manifest = Path("/tmp/agentsdock-state/sessions/chat-x/manifest.json")
        with patch.object(agent_server, "CURSOR_PROMPT_POLICY_VERSION", "2"):
            previous = agent_server.cursor_instruction_hash(
                "chat-x", {}, manifest
            )
        current = agent_server.cursor_instruction_hash("chat-x", {}, manifest)

        self.assertEqual(agent_server.CURSOR_PROMPT_POLICY_VERSION, "6")
        self.assertNotEqual(previous, current)


class CursorCanvasInstructionTests(unittest.TestCase):
    # Real failure this guards (observed in a live chat): a Cursor chat asked
    # for a Canvas searched its skills for the word, then published a single
    # HTML file. Its instructions never said what a Canvas is or where the
    # chat's Canvas directory is; Codex, Claude and Gemini chats are told.
    def setUp(self) -> None:
        self.state = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(agent_server, "STATE_DIR", self.state))
        # The section depends on node being installed; these tests must not.
        self.enterContext(patch.object(
            agent_server.agentsdock_canvas, "node_binary", lambda: "/fake/node"
        ))
        self.manifest = self.state / "manifest.json"

    def test_instructions_name_the_canvas_directory_and_check_command(self) -> None:
        instructions = agent_server.cursor_provider_instructions(
            "chat-x", {}, self.manifest
        )

        directory = self.state / "canvases" / "chat-x"
        self.assertIn(
            f"## Canvas\nThis chat has a managed Canvas directory: {directory}\n",
            instructions,
        )
        self.assertIn(
            f"agentsdock_canvas.py check {directory}/<name>.canvas.tsx",
            instructions,
        )
        self.assertTrue((directory / "AUTHORING.md").is_file())

    def test_existing_chat_gets_the_canvas_section_once(self) -> None:
        # The hash a chat stored while its instructions had no Canvas section.
        with patch.object(
            agent_server.agentsdock_canvas, "prompt_section", lambda *_a, **_k: ""
        ):
            stored = agent_server.cursor_instruction_hash(
                "chat-x", {}, self.manifest
            )
        session = {
            "backend": agent_server.BACKEND_CURSOR,
            "cursor_session_id": "cursor-sess-test",
            "cursor_instruction_hash": stored,
            "cursor_instruction_version": agent_server.CURSOR_PROMPT_POLICY_VERSION,
        }

        prompt, current, injected, _memory = agent_server.build_cursor_provider_prompt(
            "chat-x", session, "hello", self.manifest
        )

        self.assertNotEqual(stored, current)
        self.assertTrue(injected)
        self.assertIn("## Canvas\n", prompt)

        # A successful turn stores the new hash; the turn after it sends the
        # prompt alone.
        session["cursor_instruction_hash"] = current
        self.assertEqual(
            agent_server.build_cursor_provider_prompt(
                "chat-x", session, "hello", self.manifest
            ),
            ("[Current user prompt]\nhello", current, False, False),
        )

    def test_unavailable_canvas_is_named_with_its_reason(self) -> None:
        available = agent_server.cursor_instruction_hash(
            "chat-x", {}, self.manifest
        )
        with patch.object(
            agent_server.agentsdock_canvas, "node_binary", lambda: None
        ):
            instructions = agent_server.cursor_provider_instructions(
                "chat-x", {}, self.manifest
            )
            unavailable = agent_server.cursor_instruction_hash(
                "chat-x", {}, self.manifest
            )

        self.assertIn(
            "Canvas is unavailable on this server: Canvas needs `node`",
            instructions,
        )
        self.assertIn("tell them it is unavailable and why", instructions)
        self.assertNotIn("managed Canvas directory", instructions)
        # A chat is told again when node is installed or removed.
        self.assertNotEqual(available, unavailable)


if __name__ == "__main__":
    unittest.main()
