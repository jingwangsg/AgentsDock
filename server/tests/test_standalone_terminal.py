import asyncio
import concurrent.futures
import os
import pty
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

os.environ.setdefault("AGENTSDOCK_AGENT_TOKEN", "standalone-terminal-test-token")
_STATE_DIR = tempfile.mkdtemp(prefix="agentsdock-standalone-terminal-")
os.environ["AGENTSDOCK_STATE_DIR"] = _STATE_DIR

import agent_server  # noqa: E402  (reads the state dir and token at import)
from anyio.from_thread import start_blocking_portal  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

PROTOCOLS = [agent_server.TERMINAL_WEBSOCKET_PROTOCOL]


class Utf8TerminalEnvironmentTests(unittest.TestCase):
    def test_keeps_an_existing_utf8_locale(self) -> None:
        env = {"LANG": "zh_CN.UTF-8"}
        agent_server.utf8_terminal_environment(env)
        self.assertEqual(env, {"LANG": "zh_CN.UTF-8"})
        env = {"LC_ALL": "en_US.utf8", "LANG": "C"}
        agent_server.utf8_terminal_environment(env)
        self.assertEqual(env, {"LC_ALL": "en_US.utf8", "LANG": "C"})

    def test_replaces_a_c_or_posix_locale(self) -> None:
        env = {"LC_ALL": "C", "LANG": "POSIX"}
        agent_server.utf8_terminal_environment(env)
        self.assertNotIn("LC_ALL", env)
        self.assertIn("UTF-8", env["LANG"])
        env = {}
        agent_server.utf8_terminal_environment(env)
        self.assertIn("UTF-8", env["LANG"])


class TerminalShellWorkdirTests(unittest.TestCase):
    """A terminal tab's shell starts where the tab says when that directory exists here, else at home."""

    def _spawned(self, requested: str | None, shell: str = "/bin/bash") -> tuple[str, list[str]]:
        with mock.patch.object(agent_server.subprocess, "Popen") as popen, \
             mock.patch.object(agent_server, "resolve_terminal_login_shell", return_value=shell):
            popen.return_value = mock.Mock(pid=4242)
            process, master_fd, name = agent_server.spawn_terminal_shell(requested, 80, 24)
            os.close(master_fd)
        self.assertEqual(name, os.path.basename(shell))
        return popen.call_args.kwargs["cwd"], popen.call_args.args[0]

    def test_an_existing_directory_is_honoured_and_the_shell_enters_it_itself(self) -> None:
        with tempfile.TemporaryDirectory(prefix="agentsdock-terminal-cwd-") as workdir:
            cwd, argv = self._spawned(workdir)
            self.assertEqual(cwd, workdir)
            # The login phase runs the profiles; the exec'd interactive shell then owns the directory and
            # keeps the server account's HOME, so a profile that re-exports PWD or HOME cannot leave the
            # prompt lying or point ~/.bashrc at another home.
            self.assertEqual(argv, ["/bin/bash", "-l", "-c", f"cd {workdir} && exec env HOME={os.path.expanduser('~')} /bin/bash"])

    def test_no_directory_or_a_missing_one_lands_at_home_not_agent_cwd(self) -> None:
        home = os.path.expanduser("~")
        with mock.patch.object(agent_server, "DEFAULT_CWD", "/tmp"):
            self.assertEqual(self._spawned(None)[0], home)
            self.assertEqual(self._spawned("/definitely/not/here/on/this/host")[0], home)

    def test_shells_that_reject_extra_login_arguments_run_plain(self) -> None:
        self.assertEqual(self._spawned(None, "/bin/tcsh")[1], ["/bin/tcsh", "-l"])


class SurfaceApiTests(unittest.TestCase):
    """Terminal and browser tabs live on the server so every client sees the same list."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(agent_server.app)
        cls.headers = {"Authorization": f"Bearer {agent_server.AGENT_TOKEN}"}

    def _revision(self) -> int:
        return self.client.get("/api/health", headers=self.headers).json()["surfaces_revision"]

    def test_create_rename_and_delete_bump_the_health_revision(self) -> None:
        before = self._revision()
        terminal = self.client.post("/api/surfaces", headers=self.headers, json={"kind": "terminal", "folder": " Research ", "cwd": "/tmp", "url": "ignored"}).json()["surface"]
        browser = self.client.post("/api/surfaces", headers=self.headers, json={"kind": "browser", "url": "https://example.com"}).json()["surface"]
        self.assertTrue(terminal["id"].startswith("term_"))
        self.assertEqual({k: terminal[k] for k in ("kind", "name", "folder", "cwd", "url", "page_title")}, {"kind": "terminal", "name": None, "folder": "Research", "cwd": "/tmp", "url": None, "page_title": None})
        self.assertTrue(browser["id"].startswith("browser_"))
        self.assertEqual((browser["folder"], browser["cwd"], browser["url"]), ("General", None, "https://example.com"))
        listed = self.client.get("/api/surfaces", headers=self.headers).json()
        self.assertEqual({item["id"] for item in listed["surfaces"]} & {terminal["id"], browser["id"]}, {terminal["id"], browser["id"]})
        self.assertGreater(listed["revision"], before)

        renamed = self.client.patch(f"/api/surfaces/{browser['id']}", headers=self.headers, json={"name": " Docs ", "page_title": "Example Domain"}).json()["surface"]
        self.assertEqual((renamed["name"], renamed["page_title"], renamed["url"]), ("Docs", "Example Domain", "https://example.com"))
        cleared = self.client.patch(f"/api/surfaces/{browser['id']}", headers=self.headers, json={"name": None}).json()["surface"]
        self.assertEqual((cleared["name"], cleared["page_title"]), (None, "Example Domain"))  # only sent fields change

        self.assertEqual(self.client.delete(f"/api/surfaces/{browser['id']}", headers=self.headers).json(), {"deleted": True})
        self.assertEqual(self.client.delete(f"/api/surfaces/{browser['id']}", headers=self.headers).status_code, 404)
        self.assertEqual(self.client.patch(f"/api/surfaces/{browser['id']}", headers=self.headers, json={"name": "x"}).status_code, 404)
        self.assertNotIn(browser["id"], {item["id"] for item in self.client.get("/api/surfaces", headers=self.headers).json()["surfaces"]})
        self.assertGreater(self._revision(), listed["revision"])
        self.client.delete(f"/api/surfaces/{terminal['id']}", headers=self.headers)

    def test_surfaces_survive_a_reload_from_disk(self) -> None:
        created = self.client.post("/api/surfaces", headers=self.headers, json={"kind": "browser"}).json()["surface"]
        try:
            self.assertEqual(agent_server.load_surfaces()[created["id"]], created)
        finally:
            self.client.delete(f"/api/surfaces/{created['id']}", headers=self.headers)


class StandaloneTerminalWebSocketTests(unittest.TestCase):
    """A terminal tab's shell belongs to the server: viewers attach, leave and come back."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(agent_server.app)
        # TestClient otherwise runs every websocket on its own short-lived event loop, which
        # would abandon the server-owned shell's output pump; production has one loop.
        cls.portal_scope = start_blocking_portal(backend="asyncio")
        cls.client.portal = cls.portal_scope.__enter__()
        cls.headers = {"Authorization": f"Bearer {agent_server.AGENT_TOKEN}"}
        cls.cwd = tempfile.mkdtemp(prefix="agentsdock-standalone-terminal-cwd-")
        # The account's real login shell may run rc files that exec another shell or
        # query the terminal and wait for replies only a terminal emulator sends.
        cls.home = tempfile.mkdtemp(prefix="agentsdock-standalone-terminal-home-")
        cls.patches = [
            mock.patch.dict(os.environ, {"HOME": cls.home}),
            mock.patch.object(agent_server, "resolve_terminal_login_shell", return_value="/bin/sh"),
        ]
        for patch in cls.patches:
            patch.start()
        cls.reader = concurrent.futures.ThreadPoolExecutor(max_workers=1)

    @classmethod
    def tearDownClass(cls) -> None:
        for patch in cls.patches:
            patch.stop()
        cls.reader.shutdown(wait=False, cancel_futures=True)
        cls.portal_scope.__exit__(None, None, None)
        shutil.rmtree(cls.cwd, ignore_errors=True)
        shutil.rmtree(cls.home, ignore_errors=True)

    def setUp(self) -> None:
        self.terminal_id = self.client.post("/api/surfaces", headers=self.headers, json={"kind": "terminal", "cwd": self.cwd}).json()["surface"]["id"]

    def tearDown(self) -> None:
        self.client.delete(f"/api/surfaces/{self.terminal_id}", headers=self.headers)

    def _attach(self, terminal_id: str | None = None):
        return self.client.websocket_connect(f"/api/sessions/{terminal_id or self.terminal_id}/terminal/ws?columns=80&rows=24", headers=self.headers, subprotocols=PROTOCOLS)

    def _receive(self, websocket, timeout: float = 20.0) -> dict:
        try:
            return self.reader.submit(websocket.receive).result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            self.fail(f"no websocket message within {timeout}s")

    def _read_until(self, websocket, marker: str) -> str:
        """Collect output bytes until `marker` appears; text frames are returned as the exception payload."""
        output = b""
        while True:
            message = self._receive(websocket)
            if message.get("type") == "websocket.disconnect":
                self.fail(f"socket closed ({message.get('code')}) before {marker!r}: {output[-800:]!r}")
            if message.get("text"):
                self.fail(f"unexpected control frame {message['text']!r} before {marker!r}")
            output += message.get("bytes") or b""
            text = output.decode("utf-8", errors="replace")
            if marker in text:
                return text

    def test_unknown_terminal_ids_are_rejected(self) -> None:
        with self._attach("term_does_not_exist") as websocket:
            with self.assertRaises(WebSocketDisconnect) as raised:
                websocket.receive_json()
            self.assertEqual(raised.exception.code, 4404)

    def test_shell_outlives_its_viewers_and_replays_scrollback_to_late_ones(self) -> None:
        with self._attach() as first:
            self.assertEqual(first.receive_json()["type"], "ready")
            # The pty echoes typed input, so markers are computed by the shell and never appear literally.
            first.send_bytes("printf '%s\\n' \"=中文 ok=\"; echo __first_$((1+1))\n".encode())
            seen = self._read_until(first, "__first_2")
            self.assertIn("=中文 ok=", seen)
            with self._attach() as second:
                self.assertEqual(second.receive_json()["type"], "ready")
                replay = self._read_until(second, "__first_2")
                self.assertIn("=中文 ok=", replay)
        with self._attach() as late:
            self.assertEqual(late.receive_json()["type"], "ready")
            self.assertIn("__first_2", self._read_until(late, "__first_2"))
            late.send_bytes(b"echo __late_$((2+2))\n")
            self.assertIn("__late_4", self._read_until(late, "__late_4"))

    def test_exit_tells_viewers_and_the_next_attach_starts_a_fresh_shell(self) -> None:
        with self._attach() as websocket:
            self.assertEqual(websocket.receive_json()["type"], "ready")
            websocket.send_bytes(b"echo __old_$((3+3)); exit\n")
            with self.assertRaises(WebSocketDisconnect) as raised:
                while True:
                    websocket.receive_bytes()
            self.assertEqual(raised.exception.code, agent_server.TERMINAL_SHELL_EXITED_CLOSE_CODE)
        with self._attach() as fresh:
            self.assertEqual(fresh.receive_json()["type"], "ready")
            fresh.send_bytes(b"echo __new_$((4+4))\n")
            self.assertNotIn("__old_6", self._read_until(fresh, "__new_8"))

    def test_resize_control_frame_reaches_the_pty(self) -> None:
        with self._attach() as websocket:
            self.assertEqual(websocket.receive_json()["type"], "ready")
            websocket.send_json({"type": "resize", "columns": 100, "rows": 30})
            websocket.send_bytes(b"stty size; echo __size_$((2+2))\n")
            self.assertIn("30 100", self._read_until(websocket, "__size_4"))

    def test_deleting_the_tab_ends_its_shell_and_closes_viewers(self) -> None:
        with self._attach() as websocket:
            self.assertEqual(websocket.receive_json()["type"], "ready")
            self.client.delete(f"/api/surfaces/{self.terminal_id}", headers=self.headers)
            frames = []
            while True:
                message = self._receive(websocket)
                frames.append(message)
                if message.get("type") in {"websocket.close", "websocket.disconnect"}:
                    break
            self.assertEqual(frames[-1].get("code"), agent_server.TERMINAL_SHELL_EXITED_CLOSE_CODE)
        self.assertNotIn(self.terminal_id, agent_server.TERMINAL_SHELLS)
        with self._attach() as gone:
            with self.assertRaises(WebSocketDisconnect) as raised:
                gone.receive_json()
            self.assertEqual(raised.exception.code, 4404)


class FakeViewer:
    """A viewer socket whose `ready` send can be held until the shell has ended."""

    def __init__(self, hold_ready_until: "asyncio.Future | None" = None) -> None:
        self.hold_ready_until = hold_ready_until
        self.sent: list[dict] = []
        self.close_codes: list[int] = []
        self.closed = asyncio.Event()

    async def accept(self, subprotocol: str | None = None) -> None:
        pass

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)
        if payload["type"] == "ready" and self.hold_ready_until is not None:
            await self.hold_ready_until

    async def send_bytes(self, _data: bytes) -> None:
        pass

    async def receive(self) -> dict:
        await self.closed.wait()
        return {"type": "websocket.disconnect"}

    async def close(self, code: int = 1000) -> None:
        if self.closed.is_set():
            raise RuntimeError("already closed")  # as Starlette does
        self.close_codes.append(code)
        self.closed.set()


def pty_process(command: str) -> tuple[subprocess.Popen[bytes], int]:
    master_fd, slave_fd = pty.openpty()
    process = subprocess.Popen(["/bin/sh", "-c", command], stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True, start_new_session=True)
    os.close(slave_fd)
    os.set_blocking(master_fd, False)
    return process, master_fd


class AttachRaceTests(unittest.IsolatedAsyncioTestCase):
    """An attach racing the shell's exit or the tab's deletion must not strand a viewer or a shell."""

    def setUp(self) -> None:
        self.terminal_id = "term_race_test"
        self.patches = [
            mock.patch.dict(agent_server.SURFACES, {self.terminal_id: {"id": self.terminal_id, "kind": "terminal", "cwd": None}}),
            mock.patch.dict(agent_server.TERMINAL_SHELLS, {}, clear=True),
            mock.patch.object(agent_server, "TERMINAL_SHELLS_LOCK", asyncio.Lock()),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def test_a_viewer_joining_as_the_shell_exits_is_told_so(self) -> None:
        process, master_fd = pty_process("exit 0")
        shell = agent_server.TERMINAL_SHELLS[self.terminal_id] = agent_server.TerminalShell(process, master_fd, "sh")
        viewer = FakeViewer(hold_ready_until=shell.pump)
        await agent_server.standalone_terminal_websocket(viewer, self.terminal_id, 80, 24, None, None)  # type: ignore[arg-type]
        self.assertEqual([frame["type"] for frame in viewer.sent], ["ready"])
        self.assertEqual(viewer.close_codes, [agent_server.TERMINAL_SHELL_EXITED_CLOSE_CODE])
        self.assertEqual(shell.viewers, set())

    async def test_a_tab_deleted_during_an_attach_does_not_keep_a_shell(self) -> None:
        spawning = threading.Event()
        may_finish = threading.Event()

        def slow_spawn(_cwd, _columns, _rows):
            spawning.set()
            may_finish.wait(5)
            process, master_fd = pty_process("sleep 30")
            return process, master_fd, "sh"

        viewer = FakeViewer()
        with mock.patch.object(agent_server, "spawn_terminal_shell", slow_spawn):
            attach = asyncio.create_task(agent_server.standalone_terminal_websocket(viewer, self.terminal_id, 80, 24, None, None))  # type: ignore[arg-type]
            await asyncio.to_thread(spawning.wait, 5)
            delete = asyncio.create_task(agent_server.delete_surface(self.terminal_id))
            await asyncio.sleep(0.05)  # DELETE is now queued on the lock behind the spawn
            may_finish.set()
            self.assertEqual(await delete, {"deleted": True})
            await asyncio.wait_for(attach, 10)
        self.assertNotIn(self.terminal_id, agent_server.TERMINAL_SHELLS)
        self.assertEqual(viewer.close_codes, [agent_server.TERMINAL_SHELL_EXITED_CLOSE_CODE])


def tearDownModule() -> None:
    shutil.rmtree(_STATE_DIR, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
