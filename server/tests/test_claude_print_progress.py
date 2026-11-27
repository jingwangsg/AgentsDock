import asyncio
import json
import os
import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import agent_server


def setUpModule():
    # Claude runs and probes require the token (require_claude_oauth_token).
    unittest.enterModuleContext(patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": "test-token"}))


class FakeStdin:
    def __init__(self) -> None:
        self.writes: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.writes.append(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


class FakeStream:
    def __init__(self, records: list[dict[str, object]]) -> None:
        self.chunks = deque(
            (json.dumps(record) + "\n").encode()
            for record in records
        )

    async def readline(self) -> bytes:
        return self.chunks.popleft() if self.chunks else b""

    async def read(self, size: int = -1) -> bytes:
        data = b"".join(self.chunks)
        self.chunks.clear()
        return data


class FakeProcess:
    def __init__(self, records: list[dict[str, object]]) -> None:
        self.pid = 4242
        self.returncode = 0
        self.stdin = FakeStdin()
        self.stdout = FakeStream(records)
        self.stderr = FakeStream([])


async def wait_forever(*_args: object, **_kwargs: object) -> None:
    await asyncio.Event().wait()


# Reports its argv and prompt in stream-json, and creates the directory the real CLI leaves for a session's hooks.
FORK_CLI = """#!PYTHON
import json, sys
from pathlib import Path
(Path(ROOT) / 'session-env' / sys.argv[sys.argv.index('--session-id') + 1]).mkdir(parents=True)
print(json.dumps({'type': 'system', 'subtype': 'init'}))
print(json.dumps({'type': 'result', 'is_error': False, 'result': json.dumps([sys.argv[1:], sys.stdin.read()])}))
"""


class ClaudeEditRequestForkTests(unittest.IsolatedAsyncioTestCase):
    """A Canvas edit request on Claude runs the print CLI, so it is tested beside the print transport.

    The CLI here is a fake: the test shows the command the server starts and what the server removes. That
    the real CLI writes no transcript with these flags was measured on CLI 2.1.332 and is not shown here.
    """

    async def test_an_edit_request_starts_the_print_cli_as_a_fork_and_removes_the_directory_the_fake_leaves(self) -> None:
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        cwd = root / "workspace"
        cwd.mkdir()
        projects = root / ".claude" / "projects"
        script = root / "claude"
        script.write_text(FORK_CLI.replace("#!PYTHON", "#!" + sys.executable).replace("ROOT", repr(str(projects.parent))))
        script.chmod(0o700)
        session = {"id": "chat", "backend": "claude", "cwd": str(cwd), "claude_session_id": "native-claude", "model": "opus"}
        prompt = agent_server.agentsdock_canvas.comment_prompt(
            root / "report.canvas.tsx", 7, {"canvas_id": "summary", "tag": "td", "text": "loss 2.41", "html": ""},
            "edit", "shorten it", follow_up=False)[0]
        history = [{"question": "Question: why?", "response": "Because."}]
        with patch.object(agent_server, "STATE_DIR", root / "state"), patch.dict(agent_server.STORE.sessions, {"chat": session}), \
                patch.object(agent_server, "CLAUDE_BIN", str(script)), patch.object(agent_server, "CLAUDE_PROJECTS_ROOT", projects):
            handle = await agent_server.create_canvas_comment_side_chat("chat")
            # Nothing to fork: the CLI is not started on an empty conversation.
            with self.assertRaises(agent_server.side_questions.SideQuestionError):
                await handle.ask(prompt, history=history)
            self.assertFalse((projects.parent / "session-env").exists())
            transcript = agent_server.claude_resume_file_for_cwd("native-claude", str(cwd))
            transcript.parent.mkdir(parents=True)
            transcript.write_text('{"type":"user"}\n')
            argv, question = json.loads((await handle.ask(prompt, history=history))["answer"])
        # A fork under an id of its own that is not saved, with the print transport's permissions and the chat's model.
        self.assertEqual(argv[-6:-2] + argv[-1:], ["--resume", "native-claude", "--fork-session", "--session-id", "--no-session-persistence"])
        self.assertNotEqual(argv[-2], "native-claude")
        self.assertIn("--dangerously-skip-permissions", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "opus")
        # /btw replays a thread's exchanges; the fork gets them in the question.
        self.assertEqual(question, "Earlier question in this comment thread:\nQuestion: why?\n\nIts answer:\nBecause.\n\n" + prompt)
        # The server removed the directory named after the fork's id, and wrote nothing beside the chat's transcript.
        self.assertEqual(list((projects.parent / "session-env").iterdir()), [])
        self.assertEqual([path.name for path in transcript.parent.iterdir()], ["native-claude.jsonl"])
        self.assertEqual(transcript.read_text(), '{"type":"user"}\n')


class ClaudePrintProgressTests(unittest.IsolatedAsyncioTestCase):
    async def run_print(
        self,
        records: list[dict[str, object]],
        *,
        stopped: bool = False,
    ) -> tuple[AsyncMock, AsyncMock]:
        run_id = "run-print"
        process = FakeProcess(records)
        append_event = AsyncMock(return_value={})
        finalize = AsyncMock(return_value=True)
        metadata = {
            "purpose": "scheduled_job",
            "job_id": "job-1",
        }

        with tempfile.TemporaryDirectory() as cwd, patch.object(
            agent_server,
            "STOPPED_RUNS",
            {run_id} if stopped else set(),
        ), patch.dict(
            agent_server.RUN_METADATA,
            {run_id: metadata},
            clear=True,
        ), patch.multiple(
            agent_server,
            resolve_claude_resume_provider=Mock(return_value=(None, None)),
            capture_git_baseline=AsyncMock(return_value={"head": "base"}),
            build_claude_cmd=Mock(return_value=["claude", "-p"]),
            agent_runner_env=Mock(return_value={}),
            process_group_for_pid=Mock(return_value=4242),
            bind_active_turn=AsyncMock(return_value=(True, stopped)),
            watch_manifest_artifacts=wait_forever,
            append_event=append_event,
            append_active_stdout=AsyncMock(),
            mark_provider_turn_ready=AsyncMock(),
            persist_run_provider_session=AsyncMock(),
            terminate_process_tree=AsyncMock(),
            clear_active_process=AsyncMock(),
            collect_manifest=AsyncMock(),
            collect_recent_leftover_manifests=AsyncMock(),
            publish_turn_code_diff=AsyncMock(),
            record_runtime_success=Mock(),
            record_runtime_failure=Mock(),
            finalize_owned_turn_finished=finalize,
        ), patch.object(
            agent_server.asyncio,
            "create_subprocess_exec",
            AsyncMock(return_value=process),
        ):
            await agent_server.run_claude_print(
                "chat-print",
                run_id,
                "Prompt",
                {
                    "id": "chat-print",
                    "backend": agent_server.BACKEND_CLAUDE,
                    "cwd": cwd,
                },
                Path(cwd) / ".manifest.json",
            )

        return append_event, finalize

    async def test_text_blocks_are_commentary_and_result_is_final_output(self) -> None:
        append_event, finalize = await self.run_print([
            {
                "type": "assistant",
                "session_id": "provider-session",
                "message": {
                    "content": [{
                        "type": "text",
                        "text": "I am checking the release.",
                    }],
                },
            },
            {
                "type": "result",
                "session_id": "provider-session",
                "result": "The release is ready.",
            },
        ])

        commentary = [
            call.args[2]
            for call in append_event.await_args_list
            if call.args[1] == "reasoning_summary"
        ]
        self.assertEqual(commentary, [{
            "run_id": "run-print",
            "text": "I am checking the release.",
            "phase": "commentary",
            "backend": agent_server.BACKEND_CLAUDE,
            "purpose": "scheduled_job",
            "job_id": "job-1",
        }])
        self.assertFalse(any(
            call.args[1] == "assistant_text"
            for call in append_event.await_args_list
        ))
        terminal = finalize.await_args.kwargs["payload"]
        self.assertEqual(terminal["result_text"], "The release is ready.")
        self.assertIs(terminal["stopped"], False)

    async def test_stopped_turn_without_result_does_not_promote_commentary(self) -> None:
        append_event, finalize = await self.run_print([
            {
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "text",
                        "text": "Partial progress before Stop.",
                    }],
                },
            },
        ], stopped=True)

        self.assertTrue(any(
            call.args[1] == "reasoning_summary"
            and call.args[2].get("phase") == "commentary"
            and call.args[2].get("text") == "Partial progress before Stop."
            for call in append_event.await_args_list
        ))
        self.assertFalse(any(
            call.args[1] == "assistant_text"
            for call in append_event.await_args_list
        ))
        terminal = finalize.await_args.kwargs["payload"]
        self.assertEqual(terminal["result_text"], "")
        self.assertIs(terminal["stopped"], True)

    async def test_clean_stream_exit_without_result_is_a_failure(self) -> None:
        append_event, finalize = await self.run_print([{
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "Read",
                    "input": {"file_path": "/tmp/example"},
                }],
            },
        }])

        self.assertTrue(any(
            call.args[1] == "error"
            and "before a terminal result" in call.args[2].get("message", "")
            for call in append_event.await_args_list
        ))
        terminal = finalize.await_args.kwargs["payload"]
        self.assertEqual(terminal["exit_code"], 1)
        self.assertEqual(terminal["result_text"], "")
        self.assertIs(terminal["stopped"], False)


if __name__ == "__main__":
    unittest.main()
