"""Owned subprocess runs: no real processes, every spawn and signal is synthetic."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import isolated_process as proc_mod
from side_questions import SideQuestionError


def fake_process(stdout, stderr):
    proc = SimpleNamespace(pid=123456, returncode=None,
        stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()),
        stdout=SimpleNamespace(read=AsyncMock(side_effect=stdout)),
        stderr=SimpleNamespace(read=AsyncMock(side_effect=stderr)))
    async def wait():
        proc.returncode = 0
        return 0
    proc.wait = AsyncMock(side_effect=wait)
    return proc


class EnvironmentTests(unittest.TestCase):
    def test_environment_strips_authority_without_replacing_auth_home(self):
        env = {"HOME": "/synthetic/auth-home", "PATH": "/bin", "ANTHROPIC_API_KEY": "synthetic",
               "AGENTSDOCK_CHAT_ID": "parent", "AGENTSDOCK_TEAM_AUTHORITY": "secret",
               "ZENITHBOT_AGENT_TOKEN": "secret", "CODEX_THREAD_ID": "parent",
               "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1", "TMUX": "parent"}
        self.assertEqual(proc_mod.isolated_environment(env),
                         {"HOME": "/synthetic/auth-home", "PATH": "/bin", "ANTHROPIC_API_KEY": "synthetic"})


class RunIsolatedCommandTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        signals = patch.object(proc_mod.os, "killpg")
        self.killpg = signals.start()
        self.addCleanup(signals.stop)

    async def test_owned_process_reads_chunked_output_to_eof(self):
        proc = fake_process([b'{"res', b'ult":"ok"}', b''], [b'warning', b''])
        with patch.object(proc_mod.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            output = await proc_mod.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={})
        self.assertEqual(output, '{"result":"ok"}')
        self.assertEqual(proc.stdout.read.await_count, 3)
        self.assertEqual(proc.stderr.read.await_count, 2)

    async def test_process_has_no_default_elapsed_time_cutoff(self):
        started, release = asyncio.Event(), asyncio.Event()
        proc = fake_process([], [b""])

        async def read(_):
            started.set()
            await release.wait()
            proc.stdout.read = AsyncMock(return_value=b"")
            return b"Long answer"

        proc.stdout.read = read
        loop = asyncio.get_running_loop()
        clock = loop.time
        elapsed = 0
        with patch.object(proc_mod.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)), \
                patch.object(loop, "slow_callback_duration", 1000), \
                patch.object(loop, "time", side_effect=lambda: clock() + elapsed):
            task = asyncio.create_task(proc_mod.run_isolated_command(
                ["fake"], prompt="q", cwd="/synthetic", env={}))
            self.addAsyncCleanup(self._cancel_task, task)
            await started.wait()
            elapsed = 151
            await asyncio.sleep(0.01)
            self.assertFalse(task.done())
            self.killpg.assert_not_called()
            release.set()
            self.assertEqual(await task, "Long answer")

    async def _cancel_task(self, task):
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_output_limit_is_enforced_across_chunks(self):
        proc = fake_process([b'1234', b'5678', b''], [b''])
        with patch.object(proc_mod.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)), \
                patch.object(proc_mod, "MAX_OUTPUT_BYTES", 6):
            with self.assertRaises(SideQuestionError) as caught:
                await proc_mod.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={})
        self.assertEqual(caught.exception.status_code, 502)

    async def test_cancellation_during_spawn_joins_and_kills_only_owned_process(self):
        started, release = asyncio.Event(), asyncio.Event()
        proc = fake_process([b''], [b''])
        async def spawn(*args, **kwargs):
            self.assertTrue(kwargs["start_new_session"])
            started.set()
            await release.wait()
            return proc
        with patch.object(proc_mod.asyncio, "create_subprocess_exec", spawn):
            task = asyncio.create_task(proc_mod.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={}))
            await started.wait()
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual({call.args[0] for call in self.killpg.call_args_list}, {proc.pid})
        self.assertIsNotNone(proc.returncode)

    async def test_exited_leader_with_child_pipe_is_killed_on_cancellation(self):
        reading = asyncio.Event()
        proc = fake_process([], [b''])
        proc.returncode = 0
        async def read(_):
            reading.set()
            await asyncio.Event().wait()
        proc.stdout.read = read
        with patch.object(proc_mod.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            task = asyncio.create_task(proc_mod.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={}))
            await reading.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual({call.args[0] for call in self.killpg.call_args_list}, {proc.pid})
        self.assertEqual(self.killpg.call_count, 2)


if __name__ == "__main__":
    unittest.main()
