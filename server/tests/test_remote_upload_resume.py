"""The hub's source upload survives a forwarded ssh hop that drops mid-transfer.

A fake ``ssh`` binary plays the host: ``wc -c`` reports the bytes it holds,
``cat >``/``cat >>`` store stdin, and a per-session plan makes it drop after N
bytes or refuse the connection outright (exit 255, like the real ssh).
"""

from __future__ import annotations

import asyncio
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import remote_servers as rs  # noqa: E402

FAKE_SSH = r'''#!{python}
import os, sys
state = {state!r}
command = sys.argv[-1]
upload = os.path.join(state, "upload.tgz")
with open(os.path.join(state, "commands.log"), "a") as log:
    log.write(command + "\n")
if command.startswith("wc -c"):
    print(os.path.getsize(upload) if os.path.exists(upload) else 0)
    sys.exit(0)
plan_path = os.path.join(state, "plan")
plan = open(plan_path).read().split() if os.path.exists(plan_path) else []
step = plan.pop(0) if plan else "ok"
open(plan_path, "w").write(" ".join(plan))
if step == "refuse":
    sys.stderr.write("ssh: connect to host 127.0.0.1 port 9000: Connection refused\n")
    sys.exit(255)
limit = int(step[5:]) if step.startswith("drop:") else None
received = 0
with open(upload, "ab" if "cat >>" in command else "wb") as out:
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        if limit is not None and received + len(chunk) > limit:
            out.write(chunk[: limit - received])
            out.flush()
            sys.stderr.write("Connection to 127.0.0.1 closed by remote host.\n")
            sys.exit(255)
        out.write(chunk)
        received += len(chunk)
sys.exit(0)
'''


class UploadResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.state = self.tmp / "host"
        self.state.mkdir()
        script = self.tmp / "ssh"
        script.write_text(FAKE_SSH.format(python=sys.executable, state=str(self.state)))
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        self.manager = rs.RemoteServerManager(self.tmp / "state", source_dir=self.tmp, manage_tunnels=False)
        self.addCleanup(lambda: asyncio.run(self.manager.http.aclose()))
        for patch in (
            mock.patch.object(rs, "ssh_binary", return_value=str(script)),
            mock.patch.object(rs, "UPLOAD_RETRY_DELAY", 0),
            mock.patch.object(rs, "UPLOAD_RETRIES", 3),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def commands(self) -> list[str]:
        return (self.state / "commands.log").read_text().splitlines()

    def test_upload_resumes_from_the_bytes_the_host_holds(self) -> None:
        data = os.urandom(3 * rs.UPLOAD_CHUNK + 1234)
        # session 1 drops after 400 000 bytes, session 2 finds the hop down, session 3 finishes.
        (self.state / "plan").write_text("drop:400000 refuse ok")
        job = rs.DeployJob(job_id="job")

        asyncio.run(self.manager._upload(job, rs.SSHRoute([], "fake-host", rs.ssh_env()), "~/.agentsdock-server", data))

        self.assertEqual((self.state / "upload.tgz").read_bytes(), data)
        cats = [c for c in self.commands() if c.startswith(("mkdir", "cat"))]
        self.assertTrue(cats[0].startswith("mkdir -p ~/.agentsdock-server && cat > "))
        self.assertEqual(cats[1:], ["cat >> ~/.agentsdock-server/upload.tgz"] * 2)
        resumes = [entry["message"] for entry in job.log if "resuming the upload" in entry["message"]]
        self.assertEqual(len(resumes), 2)
        self.assertIn("closed by remote host", resumes[0])
        self.assertIn("Connection refused", resumes[1])

    def test_upload_gives_up_after_the_retry_budget(self) -> None:
        data = os.urandom(2 * rs.UPLOAD_CHUNK)
        (self.state / "plan").write_text(" ".join(["drop:1000"] * 10))
        job = rs.DeployJob(job_id="job")

        with self.assertRaises(rs.SSHConnectionLost):
            asyncio.run(self.manager._upload(job, rs.SSHRoute([], "fake-host", rs.ssh_env()), "~/.agentsdock-server", data))

        self.assertEqual(sum("resuming the upload" in entry["message"] for entry in job.log), 3)

    def test_upload_without_drops_keeps_the_single_session_path(self) -> None:
        data = os.urandom(rs.UPLOAD_CHUNK // 2)
        job = rs.DeployJob(job_id="job")

        asyncio.run(self.manager._upload(job, rs.SSHRoute([], "fake-host", rs.ssh_env()), "~/.agentsdock-server", data))

        self.assertEqual((self.state / "upload.tgz").read_bytes(), data)
        self.assertEqual(len(self.commands()), 1)  # no size probe when nothing dropped


if __name__ == "__main__":
    unittest.main()
