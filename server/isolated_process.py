"""Fresh-process-group runs of provider CLIs with bounded output and exact reaping.

Callers pass an environment already stripped by ``isolated_environment`` so a
child inherits local CLI authentication but no chat, run or terminal
authority. Failures surface as ``SideQuestionError`` with the HTTP status the
side-question and title routes expose.
"""
from __future__ import annotations

import asyncio
from contextlib import suppress
import os
import signal

from side_questions import MAX_OUTPUT_BYTES, SideQuestionError


def isolated_environment(env: dict[str, str]) -> dict[str, str]:
    """Retain local CLI authentication but no chat/run/terminal authority."""
    return {key: value for key, value in env.items()
            if not key.startswith(("AGENTSDOCK", "ZENITHDOCK", "ZENITHBOT", "CLAUDECODE", "CLAUDE_CODE_",
                                   "CODEX_THREAD", "CODEX_SESSION"))
            and key not in {"AGENT_TOKEN", "AGENT_SERVER_TOKEN", "TMUX", "TMUX_PANE"}}


async def terminate_isolated_process(proc, *, force_group: bool = False):
    """Reap an exact fresh start_new_session child; never pass a shared provider."""
    if proc is None or (proc.returncode is not None and not force_group):
        return
    with suppress(ProcessLookupError):
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGTERM)
        else:
            proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), 1)
    except asyncio.TimeoutError:
        pass
    finally:
        # The leader can exit first while a child holds the pipes open.
        with suppress(ProcessLookupError):
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            elif proc.returncode is None:
                proc.kill()
        await proc.wait()


async def run_isolated_command(command, *, prompt: str, cwd: str, env: dict,
                               timeout: float | None = None) -> str:
    """Own only this fresh process group, including cancellation during spawn."""
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(
        *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, cwd=cwd, env=env, start_new_session=True,
    ))
    proc = None
    tasks = []
    completed = False

    async def read(stream):
        value = bytearray()
        while True:
            chunk = await stream.read(min(65536, MAX_OUTPUT_BYTES + 1 - len(value)))
            if not chunk:
                return bytes(value)
            value.extend(chunk)
            if len(value) > MAX_OUTPUT_BYTES:
                raise SideQuestionError(502, "Side question response exceeded the output limit")

    async def write():
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

    async def join_cleanup(task):
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
        return task.result()

    try:
        proc = await asyncio.shield(spawn)
        tasks = [asyncio.create_task(read(proc.stdout)), asyncio.create_task(read(proc.stderr)),
                 asyncio.create_task(write()), asyncio.create_task(proc.wait())]
        stdout, _stderr, _, _ = await asyncio.wait_for(asyncio.gather(*tasks), timeout)
        completed = True
        if proc.returncode != 0:
            raise SideQuestionError(503, "Side question provider failed; check its installation and sign-in")
        return stdout.decode("utf-8", "replace")
    except asyncio.CancelledError:
        # Cancellation can win before create_subprocess_exec returns its
        # handle. Join that spawn so the exact new child can still be reaped.
        if proc is None:
            with suppress(Exception):
                proc = await join_cleanup(spawn)
        raise
    except asyncio.TimeoutError:
        raise SideQuestionError(504, "Side question timed out") from None
    except OSError:
        raise SideQuestionError(503, "Side question provider is unavailable") from None
    finally:
        cleanup = asyncio.create_task(terminate_isolated_process(proc, force_group=not completed))
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            await join_cleanup(cleanup)
            raise
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
