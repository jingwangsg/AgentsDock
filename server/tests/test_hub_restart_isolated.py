"""Update & redeploy all's hub restart: launchd ownership proof and the detached kickstart.

The functions are compiled out of agent_server.py's AST because importing that module builds the whole app.
"""
from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

SOURCE = (Path(__file__).resolve().parents[1] / "agent_server.py")
FUNCTIONS = {"macos_launchd_owns_current_process", "hub_launchd_label", "restart_hub_process"}


def load(environ: dict[str, str], launchctl_stdout: str | None, launchctl_timeout: bool = False):
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in FUNCTIONS]
    assert len(selected) == len(FUNCTIONS)
    spawned: list[dict] = []

    class TimeoutExpired(Exception):
        pass

    def run(argv, **_kwargs):
        if launchctl_timeout:
            raise TimeoutExpired()
        return SimpleNamespace(returncode=0 if launchctl_stdout is not None else 113, stdout=launchctl_stdout or "")

    def popen(argv, **kwargs):
        spawned.append({"argv": argv, **kwargs})

    namespace = {
        "sys": SimpleNamespace(platform="darwin"), "os": SimpleNamespace(environ=environ, getuid=lambda: 501, getpid=lambda: 4242),
        "Path": lambda _path: SimpleNamespace(is_file=lambda: True), "re": __import__("re"), "shlex": __import__("shlex"),
        "asyncio": asyncio,
        "subprocess": SimpleNamespace(run=run, Popen=popen, TimeoutExpired=TimeoutExpired, SubprocessError=OSError, DEVNULL=-3),
        "server_instances": SimpleNamespace(launchd_label=lambda name: f"official.{name}"), "SERVER_INSTANCE_NAME": "default",
        "logger": SimpleNamespace(warning=mock.Mock()),
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace, spawned


class HubRestartTests(unittest.TestCase):
    def test_the_label_launchd_gave_the_process_is_proven_by_its_pid(self) -> None:
        ns, _ = load({"XPC_SERVICE_NAME": "com.example.hub"}, "\tpid = 4242\n")
        self.assertEqual(ns["hub_launchd_label"](), "com.example.hub")

    def test_another_pid_no_label_or_a_launchctl_timeout_means_no_restart(self) -> None:
        ns, _ = load({"XPC_SERVICE_NAME": "com.example.hub"}, "\tpid = 1\n")
        self.assertIsNone(ns["hub_launchd_label"]())
        ns, _ = load({}, "\tpid = 4242\n")
        self.assertIsNone(ns["hub_launchd_label"]())
        ns, _ = load({"XPC_SERVICE_NAME": "com.example.hub"}, None, launchctl_timeout=True)
        self.assertIsNone(ns["hub_launchd_label"]())

    def test_restart_kickstarts_the_owning_job_from_a_detached_shell_or_says_why_not(self) -> None:
        ns, spawned = load({"XPC_SERVICE_NAME": "com.example.hub"}, "\tpid = 4242\n")
        self.assertIsNone(asyncio.run(ns["restart_hub_process"]()))
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0]["argv"][:2], ["/bin/sh", "-c"])
        self.assertIn("exec /bin/launchctl kickstart -k gui/501/com.example.hub", spawned[0]["argv"][2])
        self.assertTrue(spawned[0]["start_new_session"])
        ns, spawned = load({}, "\tpid = 4242\n")
        self.assertEqual(asyncio.run(ns["restart_hub_process"]()), "This server is not run by launchd, so it cannot restart itself; restart it by hand.")
        self.assertEqual(spawned, [])


if __name__ == "__main__":
    unittest.main()
