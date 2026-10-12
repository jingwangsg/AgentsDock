import asyncio
import concurrent.futures
import json
import os
import pty
import re
import shutil
import signal
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

    def _attach(self, terminal_id: str | None = None, columns: int = 80, rows: int = 24, passive: bool = False):
        query = f"columns={columns}&rows={rows}" + ("&passive=1" if passive else "")
        return self.client.websocket_connect(f"/api/sessions/{terminal_id or self.terminal_id}/terminal/ws?{query}", headers=self.headers, subprotocols=PROTOCOLS)

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

    def test_ready_announces_the_length_of_the_replay_frame_that_follows(self) -> None:
        with self._attach() as first:
            self.assertEqual(first.receive_json()["replay_bytes"], 0)  # a new shell has nothing to replay
            first.send_bytes(b"echo __history_$((5+5))\n")
            self._read_until(first, "__history_10")
            with self._attach() as second:
                replay_bytes = second.receive_json()["replay_bytes"]
                replay = self._receive(second)["bytes"]
                self.assertEqual(len(replay), replay_bytes)
                self.assertIn(b"__history_10", replay)

    def test_the_replay_leaves_out_the_queries_the_live_output_carried(self) -> None:
        with self._attach() as first:
            self.assertEqual(first.receive_json()["type"], "ready")
            first.send_bytes(b"printf '\\033[6n\\033[c\\033]11;?\\007'; echo __asked_$((1+1))\n")
            self.assertIn("\x1b[6n\x1b[c\x1b]11;?\x07", self._read_until(first, "__asked_2"))
            with self._attach() as second:
                self.assertEqual(second.receive_json()["type"], "ready")
                replay = self._read_until(second, "__asked_2")
                for query in ("\x1b[6n", "\x1b[c", "\x1b]11;?"):
                    self.assertNotIn(query, replay)

    def test_a_query_no_output_has_followed_yet_ends_the_replay(self) -> None:
        # Like a new shell's startup probe while it waits for the answer: a joining terminal must see it.
        with self._attach() as first:
            self.assertEqual(first.receive_json()["type"], "ready")
            first.send_bytes(b"printf '__probe_%s\\033[c' sent; sleep 30\n")
            self._read_until(first, "__probe_sent")
            with self._attach() as second:
                self.assertTrue(self._receive(second)["text"])  # ready
                self.assertTrue(self._receive(second)["bytes"].endswith(b"__probe_sent\x1b[c"))
            first.send_bytes(b"\x03")

    def test_a_full_screen_program_is_asked_to_repaint_after_a_replay(self) -> None:
        script = os.path.join(self.cwd, "fullscreen.sh")
        with open(script, "w") as handle:
            handle.write("printf '\\033[?1049h__alt_%s\\n' ready\ntrap 'printf \"__winch_%s\\n\" seen' WINCH\nwhile :; do sleep 0.1; done\n")
        with self._attach() as first:
            self.assertEqual(first.receive_json()["type"], "ready")
            first.send_bytes(f"sh {script}\n".encode())
            self._read_until(first, "__alt_ready")
            # Same size as the first viewer: the kernel sends no SIGWINCH of its own.
            with self._attach() as second:
                self.assertEqual(second.receive_json()["type"], "ready")
                self._read_until(second, "__winch_seen")
                second.send_bytes(b"\x03")

    def test_input_waits_for_a_busy_program_and_an_oversized_frame_still_arrives(self) -> None:
        with self._attach() as websocket:
            self.assertEqual(websocket.receive_json()["type"], "ready")
            # The program reads nothing for longer than the old 5 s write timeout, and one frame is
            # over the old 1 MiB frame limit.
            websocket.send_bytes(b"sleep 6; wc -c; echo __counted_$((1+1))\n")
            websocket.send_bytes((b"p" * 99 + b"\n") * 12_000 + b"\x04")
            counted = self._read_until(websocket, "__counted_2")
            self.assertIn("1200000", counted)
            websocket.send_bytes(b"echo __still_$((3+3))\n")
            self._read_until(websocket, "__still_6")

    def _watch_size(self, websocket) -> None:
        """Run a program that prints the pty's size on every change, so the size shows without anyone typing."""
        script = os.path.join(self.cwd, "watch_size.sh")
        with open(script, "w") as handle:
            handle.write("trap 'echo \"__size $(stty size)\"' WINCH\necho __watching\nwhile :; do sleep 0.1; done\n")
        websocket.send_bytes(f"sh {script}\n".encode())
        self._read_until(websocket, "__watching")

    def test_a_passive_attach_keeps_the_size_until_that_viewer_resizes(self) -> None:
        with self._attach(columns=160, rows=45) as desktop:
            self.assertEqual(desktop.receive_json()["type"], "ready")
            self._watch_size(desktop)
            with self._attach(columns=50, rows=20, passive=True) as phone:
                self.assertEqual(phone.receive_json()["type"], "ready")
                phone.send_json({"type": "resize", "columns": 50, "rows": 21})  # a resize makes it active
                self.assertNotIn("__size 20 50", self._read_until(desktop, "__size 21 50"))  # the attach did not
                desktop.send_bytes(b" ")  # so does input
                self._read_until(desktop, "__size 45 160")
            desktop.send_bytes(b"\x03")

    def test_when_the_active_viewer_leaves_the_one_active_before_it_takes_over(self) -> None:
        with self._attach(columns=160, rows=45) as desktop:
            self.assertEqual(desktop.receive_json()["type"], "ready")
            self._watch_size(desktop)
            with self._attach(columns=70, rows=22, passive=True) as hidden:  # never active
                self.assertEqual(hidden.receive_json()["type"], "ready")
                with self._attach(columns=50, rows=20) as phone:
                    self.assertEqual(phone.receive_json()["type"], "ready")
                    self._read_until(desktop, "__size 20 50")
                output = self._read_until(desktop, "__size 45 160")
                self.assertNotIn("__size 22 70", output)
            desktop.send_bytes(b"\x03")


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
        self.assertEqual(shell.viewers, {})

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


class ScriptedViewer:
    """A viewer socket that records the output frames it is sent and receives what the test queues."""

    def __init__(self) -> None:
        self.frames: list[int] = []
        self.received = 0
        self.controls: list[dict] = []
        self.sent: list[dict | bytes] = []  # everything, in order
        self.messages: asyncio.Queue[dict] = asyncio.Queue()
        self.close_codes: list[int] = []

    async def accept(self, subprotocol: str | None = None) -> None:
        pass

    async def send_json(self, payload: dict) -> None:
        self.controls.append(payload)
        self.sent.append(payload)

    async def send_bytes(self, data: bytes) -> None:
        self.frames.append(len(data))
        self.received += len(data)
        self.sent.append(data)

    async def receive(self) -> dict:
        return await self.messages.get()

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        if self.close_codes:
            raise RuntimeError("already closed")  # as Starlette does
        self.close_codes.append(code)
        self.messages.put_nowait({"type": "websocket.disconnect", "code": code})

    def acknowledge(self, count: object) -> None:
        self.messages.put_nowait({"type": "websocket.receive", "text": json.dumps({"type": "ack", "bytes": count})})

    async def settled(self) -> int:
        """The byte count once output has stopped arriving."""
        while True:
            before = self.received
            await asyncio.sleep(0.3)
            if self.received == before:
                return before


class ScriptedShellTests(unittest.IsolatedAsyncioTestCase):
    """Viewers attach to a shell running `command` in a real pty."""

    command = "yes"

    def setUp(self) -> None:
        self.terminal_id = "term_scripted_test"
        self.patches = [
            mock.patch.dict(agent_server.SURFACES, {self.terminal_id: {"id": self.terminal_id, "kind": "terminal", "cwd": None}}),
            mock.patch.dict(agent_server.TERMINAL_SHELLS, {}, clear=True),
            mock.patch.object(agent_server, "TERMINAL_SHELLS_LOCK", asyncio.Lock()),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def asyncSetUp(self) -> None:
        process, master_fd = pty_process(self.command)
        self.shell = agent_server.TERMINAL_SHELLS[self.terminal_id] = agent_server.TerminalShell(process, master_fd, "sh")
        self.addAsyncCleanup(self.shell.kill)

    def _attach(self, viewer: ScriptedViewer, flow_control: bool, passive: bool = False, columns: int = 80, rows: int = 24) -> asyncio.Task:
        attach = asyncio.create_task(agent_server.standalone_terminal_websocket(viewer, self.terminal_id, columns, rows, None, None, flow_control, passive))  # type: ignore[arg-type]
        self.addAsyncCleanup(self._detach, viewer, attach)
        return attach

    async def _detach(self, viewer: ScriptedViewer, attach: asyncio.Task) -> None:
        viewer.messages.put_nowait({"type": "websocket.disconnect", "code": 1000})
        await asyncio.wait_for(attach, 5)

    async def _replayed(self, viewer: ScriptedViewer) -> int:
        while not viewer.controls:
            await asyncio.sleep(0.01)
        return viewer.controls[0]["replay_bytes"]


class FlowControlTests(ScriptedShellTests):
    """A viewer that attaches with flow_control=1 holds the pty's output to what it has acknowledged."""

    async def test_output_waits_for_acknowledgements(self) -> None:
        viewer = ScriptedViewer()
        self._attach(viewer, flow_control=True)
        paused_at = await viewer.settled()
        # `yes` never stops, so a settled count means the pty is not being read.
        self.assertLessEqual(paused_at, agent_server.TERMINAL_SCROLLBACK_BYTES + agent_server.TERMINAL_OUTPUT_WINDOW_BYTES + agent_server.TERMINAL_READ_BYTES)
        viewer.acknowledge(paused_at)
        resumed_at = await viewer.settled()
        self.assertGreater(resumed_at, paused_at)
        self.assertLessEqual(resumed_at - paused_at, agent_server.TERMINAL_OUTPUT_WINDOW_BYTES + agent_server.TERMINAL_READ_BYTES)

    async def test_a_viewer_whose_acknowledgements_advance_slowly_is_never_closed(self) -> None:
        viewer = ScriptedViewer()
        with mock.patch.object(agent_server, "TERMINAL_VIEWER_STALL_SECONDS", 0.5):
            attach = self._attach(viewer, flow_control=True)
            acked = await self._replayed(viewer)
            viewer.acknowledge(acked)
            for _ in range(8):  # 2.4 s, well past the stall limit, acknowledging a little at a time
                await asyncio.sleep(0.3)
                viewer.acknowledge(4096)
                acked += 4096
        self.assertFalse(attach.done())
        self.assertEqual(viewer.close_codes, [])

    async def test_a_viewer_that_stops_acknowledging_is_closed_and_the_others_continue(self) -> None:
        silent, plain = ScriptedViewer(), ScriptedViewer()
        with mock.patch.object(agent_server, "TERMINAL_VIEWER_STALL_SECONDS", 0.5):
            silent_attach = self._attach(silent, flow_control=True)
            silent.acknowledge(await self._replayed(silent))
            self._attach(plain, flow_control=False, passive=True)  # the silent one stays active
            await asyncio.wait_for(silent_attach, 5)
        self.assertEqual(silent.close_codes, [agent_server.TERMINAL_VIEWER_STALLED_CLOSE_CODE])
        before = plain.received
        await asyncio.sleep(0.3)
        self.assertGreater(plain.received, before)

    async def test_a_viewer_still_receiving_its_replay_is_not_timed(self) -> None:
        # The replay is one frame, acknowledged only once all of it has arrived, however slow the link.
        while not self.shell.scrollback.replay():
            await asyncio.sleep(0.01)
        viewer = ScriptedViewer()
        with mock.patch.object(agent_server, "TERMINAL_VIEWER_STALL_SECONDS", 0.3):
            attach = self._attach(viewer, flow_control=True)
            self.assertGreater(await self._replayed(viewer), 0)
            await asyncio.sleep(1.5)
        self.assertFalse(attach.done())
        self.assertEqual(viewer.close_codes, [])

    async def test_malformed_acknowledgements_are_ignored(self) -> None:
        viewer = ScriptedViewer()
        attach = self._attach(viewer, flow_control=True)
        paused_at = await viewer.settled()
        for count in (float("inf"), -5, True, "4096", paused_at + 1):
            viewer.acknowledge(count)
        self.assertEqual(await viewer.settled(), paused_at)  # still paused: none of them counted
        self.assertFalse(attach.done())
        viewer.acknowledge(paused_at)
        self.assertGreater(await viewer.settled(), paused_at)

    async def test_a_shell_that_exits_while_output_is_paused_tells_its_viewers_at_once(self) -> None:
        viewer = ScriptedViewer()
        attach = self._attach(viewer, flow_control=True)
        await viewer.settled()
        os.killpg(self.shell.process.pid, signal.SIGKILL)
        await asyncio.wait_for(attach, 3)
        self.assertEqual(viewer.close_codes, [agent_server.TERMINAL_SHELL_EXITED_CLOSE_CODE])


class ActiveViewerTests(ScriptedShellTests):
    """Only the active viewer's size reaches the pty: the last to type or resize, or a non-passive attach."""

    command = "trap 'echo \"__size $(stty size)\"' WINCH; echo __watching; while :; do sleep 0.1; done"

    def _sizes(self, viewer: ScriptedViewer) -> list[str]:
        return re.findall(r"__size (\d+ \d+)", b"".join(item for item in viewer.sent if isinstance(item, bytes)).decode())

    async def _sizes_after_a_moment(self, viewer: ScriptedViewer) -> list[str]:
        await asyncio.sleep(0.5)
        return self._sizes(viewer)

    async def test_a_passive_viewer_takes_the_size_only_once_it_types_and_its_reports_do_not_count(self) -> None:
        desktop, phone = ScriptedViewer(), ScriptedViewer()
        while b"__watching" not in self.shell.scrollback.replay():  # the trap is set
            await asyncio.sleep(0.01)
        self._attach(desktop, flow_control=False, columns=160, rows=45)
        self.assertEqual(await self._sizes_after_a_moment(desktop), ["45 160"])
        self._attach(phone, flow_control=False, passive=True, columns=50, rows=20)
        phone.messages.put_nowait({"type": "websocket.receive", "bytes": b"\x1b[?62;22c\x1b[12;1R\x1b[O"})
        self.assertEqual(await self._sizes_after_a_moment(desktop), ["45 160"])
        phone.messages.put_nowait({"type": "websocket.receive", "bytes": b"x"})
        self.assertEqual(await self._sizes_after_a_moment(desktop), ["45 160", "20 50"])


class ResyncTests(ScriptedShellTests):
    """A flow-controlled viewer that is not active and falls behind no longer paces the shell; it is resynced instead."""

    command = "i=0; while :; do i=$((i+1)); echo $i; done"

    async def _keep_acknowledging(self, viewer: ScriptedViewer) -> None:
        acked = 0
        while True:
            await asyncio.sleep(0.02)
            if viewer.received > acked:
                viewer.acknowledge(viewer.received - acked)
                acked = viewer.received

    def _acknowledging(self, viewer: ScriptedViewer) -> None:
        self.addCleanup(asyncio.create_task(self._keep_acknowledging(viewer)).cancel)

    @staticmethod
    def _numbers(items: list[dict | bytes]) -> list[int]:
        output = b"".join(item for item in items if isinstance(item, bytes))
        # macOS's pty now and then ends a line with "\r\r\n"; every viewer gets it so.
        return [int(number) for number in re.findall(rb"(?m)^(\d+)\r+$", output)]

    async def test_a_lagging_viewer_does_not_pause_the_shell_and_resumes_after_a_clean_resync(self) -> None:
        active, plain, lagging = ScriptedViewer(), ScriptedViewer(), ScriptedViewer()
        self._attach(active, flow_control=True)
        self._acknowledging(active)
        self._attach(plain, flow_control=False, passive=True)
        self._attach(lagging, flow_control=True, passive=True)
        behind = await lagging.settled()
        self.assertLessEqual(behind - await self._replayed(lagging), agent_server.TERMINAL_OUTPUT_WINDOW_BYTES + agent_server.TERMINAL_READ_BYTES)
        before = active.received
        await asyncio.sleep(0.5)
        self.assertGreater(active.received, before)  # the shell keeps running for the active viewer
        self.assertEqual(lagging.received, behind)

        self._acknowledging(lagging)  # it wakes up
        while len(lagging.controls) < 2:
            await asyncio.sleep(0.01)
        self.assertEqual(lagging.controls[1]["type"], "resync")
        resync = lagging.sent.index(lagging.controls[1])
        replay = lagging.sent[resync + 1]
        self.assertEqual(len(replay), lagging.controls[1]["replay_bytes"])
        await asyncio.sleep(0.5)
        # From the replay on, every line the shell printed arrives once and in order, the live ones included.
        after = lagging.sent[resync + 1:]
        if len(lagging.controls) > 2:  # it fell behind again
            after = after[:after.index(lagging.controls[2])]
        numbers = self._numbers(after)
        self.assertGreater(len(numbers) - len(self._numbers([replay])), 1000)
        self.assertEqual(numbers, list(range(numbers[0], numbers[0] + len(numbers))))
        # A viewer without flow control got all of it live.
        everything = self._numbers(plain.sent)
        self.assertEqual(everything, list(range(everything[0], everything[0] + len(everything))))
        self.assertEqual([control["type"] for control in plain.controls], ["ready"])

    async def test_a_viewer_that_keeps_up_is_never_resynced_however_long_its_replay(self) -> None:
        active, passive = ScriptedViewer(), ScriptedViewer()
        self._attach(active, flow_control=True)
        self._acknowledging(active)
        while len(self.shell.scrollback.replay()) <= 2 * agent_server.TERMINAL_OUTPUT_WINDOW_BYTES:
            await asyncio.sleep(0.01)
        self._attach(passive, flow_control=True, passive=True)
        self._acknowledging(passive)
        await asyncio.sleep(1.0)
        self.assertEqual([control["type"] for control in passive.controls], ["ready"])
        self.assertGreater(passive.received - passive.controls[0]["replay_bytes"], 2 * agent_server.TERMINAL_OUTPUT_WINDOW_BYTES)

    async def test_the_active_viewer_paces_the_shell_until_another_one_types(self) -> None:
        desktop, phone = ScriptedViewer(), ScriptedViewer()
        self._attach(desktop, flow_control=True)  # never acknowledges
        self._attach(phone, flow_control=True, passive=True)
        self._acknowledging(phone)
        paused_at = await desktop.settled()  # `echo` never stops, so a settled count means the pty is not read
        self.assertLessEqual(paused_at, agent_server.TERMINAL_SCROLLBACK_BYTES + agent_server.TERMINAL_OUTPUT_WINDOW_BYTES + agent_server.TERMINAL_READ_BYTES)
        phone.messages.put_nowait({"type": "websocket.receive", "bytes": b"x"})
        resumed_at = phone.received
        await asyncio.sleep(0.5)
        self.assertGreater(phone.received - resumed_at, 2 * agent_server.TERMINAL_OUTPUT_WINDOW_BYTES)
        self.assertEqual(desktop.received, paused_at)  # behind and no longer active: no live output

    async def test_a_lagging_viewer_that_stops_acknowledging_is_closed(self) -> None:
        active, lagging = ScriptedViewer(), ScriptedViewer()
        close = lagging.close

        async def typed_then_closed(code: int = 1000, reason: str | None = None) -> None:
            # Input the viewer sent just before the close is read after the server dropped it.
            lagging.messages.put_nowait({"type": "websocket.receive", "bytes": b"x"})
            await close(code, reason)

        lagging.close = typed_then_closed  # type: ignore[method-assign]
        with mock.patch.object(agent_server, "TERMINAL_VIEWER_STALL_SECONDS", 0.5):
            self._attach(active, flow_control=True)
            self._acknowledging(active)
            lagging_attach = self._attach(lagging, flow_control=True, passive=True)
            lagging.acknowledge(await self._replayed(lagging))
            await asyncio.wait_for(lagging_attach, 5)
        self.assertEqual(lagging.close_codes, [agent_server.TERMINAL_VIEWER_STALLED_CLOSE_CODE])
        self.assertIs(self.shell.active, active)


class ReplayTests(ScriptedShellTests):
    command = "sleep 30"

    async def test_the_replay_is_one_frame_of_the_announced_length(self) -> None:
        self.shell.scrollback.record(b"".join(b"line %06d\r\n" % k for k in range(30_000)))
        viewer = ScriptedViewer()
        self._attach(viewer, flow_control=True)
        replay_bytes = await self._replayed(viewer)
        await asyncio.sleep(0.2)
        self.assertEqual(viewer.frames, [replay_bytes])
        self.assertGreater(replay_bytes, agent_server.TERMINAL_READ_BYTES)

    async def test_no_signal_is_sent_when_the_pty_has_no_foreground_group(self) -> None:
        self.shell.scrollback.record(b"\x1b[?1049h")
        viewer = ScriptedViewer()
        with mock.patch.object(agent_server.os, "tcgetpgrp", return_value=0), \
                mock.patch.object(agent_server.os, "killpg") as killpg:
            self._attach(viewer, flow_control=False)
            await self._replayed(viewer)
            await asyncio.sleep(0.1)
        killpg.assert_not_called()


class TerminalScrollbackTests(unittest.TestCase):
    """What a joining viewer is sent: recent output without what a replay must not repeat, with its modes."""

    FISH_PROBE = b"\x1b[?u\x1b[>0q\x1b]11;?\x1b\\\x1b[?1049h\x1bP+q696e646e\x1b\\\x1b[?1049l\x1b[0c"

    def setUp(self) -> None:
        self.scrollback = agent_server.TerminalScrollback()

    def test_queries_and_clipboard_writes_are_left_out_even_when_split_across_reads(self) -> None:
        queries = [
            b"\x1b[5n", b"\x1b[6n", b"\x1b[?6n", b"\x1b[?996n", b"\x1b[c", b"\x1b[0c", b"\x1b[>c", b"\x1b[>0c", b"\x1b[=c",
            b"\x1b[>q", b"\x1b[>0q", b"\x1b[?2004$p", b"\x1b[4$p", b"\x1b[?u", b"\x1b[11t", b"\x1b[14;2t", b"\x1b[18t", b"\x1b[21t",
            b"\x1bP$qm\x1b\\", b"\x1bP+q696e646e\x1b\\", b"\x1b]11;?\x07", b"\x1b]10;?\x1b\\", b"\x1b]4;1;?\x07", b"\x1b]52;c;?\x07",
            b"\x1b]52;c;aGVsbG8=\x07", b"\x1b]52;c;aGVsbG8=\x1b\\",
        ]
        kept = [
            b"\x1b[0m", b"\x1b[2 q", b"\x1b]0;title\x07", b"\x1b]11;rgb:0000/0000/0000\x07", b"\x1b[?2004h", b"\x1b[>4;1m",
            b"\x1b[8;24;80t", b"\x1b[u", b"\x1b[2J", "中".encode(),
        ]
        expected = b""
        for sequence in queries + kept:
            for split in range(len(sequence) + 1):
                self.scrollback.record(b"<" + sequence[:split])
                self.scrollback.record(sequence[split:] + b">")
                expected += b"<" + (b"" if sequence in queries else sequence) + b">"
        self.assertEqual(self.scrollback.replay(), expected)

    def test_queries_in_the_sequences_that_end_the_output_are_kept_until_more_output_follows(self) -> None:
        # The same rule as the desktop renderer's terminal-replay.ts, which answers exactly these.
        for chunk in (b"hello\r\n" + self.FISH_PROBE[:9], self.FISH_PROBE[9:]):
            self.scrollback.record(chunk)
        self.assertEqual(self.scrollback.replay(), b"hello\r\n" + self.FISH_PROBE)
        self.scrollback.record(b"\r\n> ")
        self.assertEqual(self.scrollback.replay(), b"hello\r\n\x1b[?1049h\x1b[?1049l\r\n> ")
        self.scrollback.record(b"a\x1b[c b\x1b[0m\x1b]0;title\x07")
        self.assertTrue(self.scrollback.replay().endswith(b"> a b\x1b[0m\x1b]0;title\x07"))

    def test_a_clipboard_write_of_any_length_is_left_out(self) -> None:
        write = b"\x1b]52;c;" + b"QUJD" * 50_000 + b"\x1b\\"
        output = b"before " + write + b" after " + b"\x1b]52;c;cGFydA==\x1b[0m aborted by a new sequence"
        for start in range(0, len(output), 1000):
            self.scrollback.record(output[start:start + 1000])
        self.assertEqual(self.scrollback.replay(), b"before  after \x1b[0m aborted by a new sequence")

    def test_a_replay_taken_during_a_clipboard_write_swallows_the_rest_of_it(self) -> None:
        self.scrollback.record(b"before \x1b]52;c;QUJD")
        self.assertEqual(self.scrollback.replay(), b"before " + agent_server.TERMINAL_IGNORED_OSC_OPENER)
        self.scrollback.record(b"QUJD\x1b")  # the viewer gets "\" live: with this ESC it is the ST
        self.assertEqual(self.scrollback.replay(), b"before " + agent_server.TERMINAL_IGNORED_OSC_OPENER + b"\x1b")
        self.scrollback.record(b"\\after")
        self.assertEqual(self.scrollback.replay(), b"before after")

    def test_one_long_line_does_not_empty_the_history(self) -> None:
        self.scrollback.record(b"".join(b"history %d\r\n" % k for k in range(100)))
        self.scrollback.record("中".encode() * 200_000 + b"\r\nafter\r\n")
        replay = self.scrollback.replay()
        self.assertGreater(len(replay), agent_server.TERMINAL_SCROLLBACK_BYTES - 4)
        self.assertTrue(replay.decode("utf-8").endswith("中\r\nafter\r\n"))

    def test_a_trim_starts_at_a_nearby_newline_else_an_escape(self) -> None:
        self.scrollback.record(b"".join(b"line %06d " % k + b"." * 88 + b"\n" for k in range(6000)))
        self.assertTrue(self.scrollback.replay().startswith(b"line "))
        self.scrollback.record((b"\x1b[31m" + b"x" * 1000) * 600)
        self.assertTrue(self.scrollback.replay().startswith(b"\x1b[31mx"))

    def test_the_replay_sets_again_the_modes_whose_sequences_were_trimmed(self) -> None:
        def alternate_screen() -> bool:
            modes = agent_server.TerminalModes()
            modes.apply(self.scrollback.replay())
            return "screen" in modes.sets

        self.scrollback.record(b"\x1b[?1049h\x1b[?1h\x1b=\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[5 q\x1b[2;29r")
        self.scrollback.record((b"\x1b[1;1H" + b"z" * 1000) * 600)
        prefix = b"\x1b[?1049h\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[5 q\x1b[2;29r"
        self.assertTrue(self.scrollback.replay().startswith(prefix + b"\x1b[1;1Hz"))
        self.assertTrue(alternate_screen())
        self.scrollback.record(b"\x1b[?1049l\x1b[?2004l\x1b[?1000l")
        self.assertFalse(alternate_screen())
        self.scrollback.record(b"z" * agent_server.TERMINAL_SCROLLBACK_BYTES)
        self.assertTrue(self.scrollback.replay().startswith(b"\x1b[?1h\x1b=\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[5 q\x1b[2;29rz"))


class TerminalModesTests(unittest.TestCase):
    def _prefix(self, output: bytes) -> bytes:
        modes = agent_server.TerminalModes()
        modes.apply(output)
        return modes.prefix()

    def test_the_last_mode_set_in_a_group_wins_and_resetting_any_clears_it(self) -> None:
        self.assertEqual(self._prefix(b"\x1b[?1000h\x1b[?1003h\x1b[?1006;1015h"), b"\x1b[?1003h\x1b[?1015h")
        self.assertEqual(self._prefix(b"\x1b[?1003h\x1b[?1000l\x1b[?47h\x1b[?1049l"), b"")

    def test_soft_and_hard_resets(self) -> None:
        self.assertEqual(self._prefix(b"\x1b[?1049;1;1000h\x1b=\x1b[?25l\x1b[3;9r\x1b[!p"), b"\x1b[?1049h\x1b[?1000h")
        self.assertEqual(self._prefix(b"\x1b[?1049;2004h\x1b[4 q\x1bc"), b"")

    def test_defaults_set_explicitly_leave_nothing_to_restore(self) -> None:
        self.assertEqual(self._prefix(b"\x1b[?25l\x1b[?25h\x1b[4 q\x1b[0 q\x1b[3;9r\x1b[r\x1b=\x1b>"), b"")


def tearDownModule() -> None:
    shutil.rmtree(_STATE_DIR, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
