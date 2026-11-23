"""Exercise the SSH deploy's OS process identity, real health transport and on-disk admission fence."""
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
# Mirror the old bootstrap launcher and its state lock. Commands on other PIDs may match it too.
INCUMBENT = """
import fcntl, json, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
state = Path.cwd()
lock = (state / ".server-process.lock").open("w")
fcntl.flock(lock, fcntl.LOCK_EX)
status = state / "admin/server-update.json"
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer test-token":
            self.send_error(401)
            return
        update = json.loads(status.read_bytes()) if status.exists() else {}
        if update.get("phase") == "starting":
            (state / "fenced").touch()
            while (state / "hold-response").exists():
                time.sleep(0.02)
        counts = dict.fromkeys(("active_count", "provider_background_count", "restart_blocking_queued_count",
                                "server_maintenance_count", "mutation_count", "deleting_session_count"), 0)
        counts.update(codex_goals_reconfiguring=False, provider_background_count=int((state / "busy").exists()))
        data = json.dumps({"ok": True, "state_dir": str(state), "server_instance_id": "incumbent",
                           "claude_stop_fence_count": 0, "server_update": update,
                           "capabilities": {"server_restart": {"blocker_snapshot": counts}}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
def stop(*args):
    (state / ("interrupted" if (state / "busy").exists() else "stopped")).touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
"""


class RemoteDeployDrainTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name).resolve()
        (self.state / "admin").mkdir()
        self.status = self.state / "admin/server-update.json"
        self.previous = {"phase": "available", "target_version": "2.0", "attempt_history": [{"update_id": "old"}]}
        self.status.write_text(json.dumps(self.previous))
        script = self.state / "agent_server.py"
        script.write_text(INCUMBENT)
        self.server = subprocess.Popen([sys.executable, script, "serve"], cwd=self.state, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(self.cleanup_process, self.server)
        self.port = self.server.stdout.readline().strip()

    @staticmethod
    def cleanup_process(process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)

    def deploy(self, token="test-token", new_port=None):
        child = subprocess.Popen([sys.executable, ROOT / "remote_deploy_drain.py", self.port, str(new_port or self.port)],
                                 env={**os.environ, "AGENTSDOCK_STATE_DIR": str(self.state),
                                      "AGENTSDOCK_AGENT_TOKEN": token},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup_process, child)
        return child

    def test_busy_work_finishes_before_stop(self):
        busy = self.state / "busy"
        busy.touch()
        child = self.deploy()
        self.assertTrue(select.select([child.stdout], [], [], 25)[0], "No deploy progress")
        self.assertIn("Waiting for running work", child.stdout.readline())
        self.assertEqual(json.loads(self.status.read_bytes()), self.previous)
        self.assertIsNone(self.server.poll())
        busy.unlink()
        _, stderr = child.communicate(timeout=35)
        self.assertEqual(child.returncode, 0, stderr)
        self.assertTrue((self.state / "stopped").is_file())
        self.assertFalse((self.state / "interrupted").exists())
        self.assertEqual(json.loads(self.status.read_bytes()), self.previous)

    def test_rejected_auth_preserves_server_and_status(self):
        child = self.deploy(token="wrong")
        child.communicate(timeout=25)
        self.assertNotEqual(child.returncode, 0)
        self.assertIsNone(self.server.poll())
        self.assertEqual(json.loads(self.status.read_bytes()), self.previous)
        self.assertFalse((self.state / "fenced").exists())

    def test_crashed_deploy_recovers_only_its_own_status(self):
        (self.state / "hold-response").touch()
        child = self.deploy()
        deadline = time.monotonic() + 25
        while not (self.state / "fenced").exists():
            self.assertIsNone(child.poll())
            self.assertLess(time.monotonic(), deadline, "No deployment fence")
            time.sleep(0.02)
        child.kill()
        child.communicate(timeout=10)
        self.assertIsNone(self.server.poll())

        # Recovery must run before authentication, even if the retry itself cannot proceed.
        (self.state / "hold-response").unlink()
        retry = self.deploy(token="wrong")
        retry.communicate(timeout=25)
        self.assertNotEqual(retry.returncode, 0)
        self.assertEqual(json.loads(self.status.read_bytes()), self.previous)
        self.assertFalse(self.status.with_name(".remote-deploy-previous.json").exists())

    def test_occupied_new_port_preserves_both_services(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            child = self.deploy(new_port=listener.getsockname()[1])
            _, stderr = child.communicate(timeout=25)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn("outside this installation", stderr)
            with listener.accept()[0] as client:
                self.assertEqual(client.recv(100), b"")  # No credential was sent to this listener.
        self.assertIsNone(self.server.poll())
        self.assertEqual(json.loads(self.status.read_bytes()), self.previous)

    def test_lost_fence_preserves_its_new_owner(self):
        hold = self.state / "hold-response"
        hold.touch()
        child = self.deploy()
        deadline = time.monotonic() + 25
        while not (self.state / "fenced").exists():
            self.assertIsNone(child.poll())
            self.assertLess(time.monotonic(), deadline, "No deployment fence")
            time.sleep(0.02)
        other = {"phase": "starting", "update_id": "signed-update"}
        self.status.write_text(json.dumps(other))
        hold.unlink()
        child.communicate(timeout=25)
        self.assertNotEqual(child.returncode, 0)
        self.assertIsNone(self.server.poll())
        self.assertEqual(json.loads(self.status.read_bytes()), other)

    def test_concurrent_signed_update_retains_its_receipt(self):
        other = {"phase": "downloading", "update_id": "signed-update"}
        self.status.write_text(json.dumps(other))
        child = self.deploy()
        child.communicate(timeout=25)
        self.assertNotEqual(child.returncode, 0)
        self.assertIsNone(self.server.poll())
        self.assertEqual(json.loads(self.status.read_bytes()), other)


if __name__ == "__main__":
    unittest.main()
