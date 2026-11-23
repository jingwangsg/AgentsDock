"""Let work finish on a bootstrap-managed SSH server before replacing its source."""
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import sys
import time
import uuid

from execution_http import request_json
from server_instances import exclusive_lock


def state_locked(lock_path):
    """The serving process holds this lock through startup and shutdown, even with its port closed."""
    try:
        handle = lock_path.open("r+b")
    except FileNotFoundError:
        return False
    with handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def state_owner(lock_path):
    if sys.platform == "darwin":
        owners = subprocess.run(
            ["/usr/sbin/lsof", "-nP", "-t", "--", str(lock_path)], capture_output=True, text=True, check=True, timeout=5,
        ).stdout.split()
    else:
        # A shared install may have the same port in several network namespaces.
        # Restrict the PID lookup to AgentsServer processes with this exact inode open.
        pids = subprocess.run(["pgrep", "-u", str(os.getuid()), "-f", r"agent_server[.]py serve"],
                              capture_output=True, text=True, check=False, timeout=5).stdout.split()
        owners = []
        for candidate in pids:
            try:
                if any(fd.exists() and fd.samefile(lock_path) for fd in Path(f"/proc/{int(candidate)}/fd").iterdir()):
                    owners.append(candidate)
            except FileNotFoundError:
                continue
    if len(owners) != 1 or int(owners[0]) <= 1:
        raise RuntimeError("Could not identify the process holding this installation's state lock.")
    return int(owners[0])


def busy(snapshot):
    blockers = snapshot["capabilities"]["server_restart"]["blocker_snapshot"]
    # This cutover signals only one process, so tmux/systemd cgroup membership is irrelevant.
    counts = [blockers[name] for name in ("active_count", "provider_background_count", "restart_blocking_queued_count",
                                          "server_maintenance_count", "mutation_count", "deleting_session_count")]
    counts.append(snapshot["claude_stop_fence_count"])
    if any(type(count) is not int or count < 0 for count in counts) or type(blockers["codex_goals_reconfiguring"]) is not bool:
        raise RuntimeError("The running server could not verify its work counts.")
    return any(counts) or blockers["codex_goals_reconfiguring"] or blockers.get("snapshot_degraded")


def restore_status(status, journal):
    from update_runner import atomic_json, server_update_status_lock

    with server_update_status_lock(status):
        if journal.exists():
            saved = json.loads(journal.read_bytes())
            current = json.loads(status.read_bytes()) if status.exists() else {}
            if current.get("update_id") == saved["owner"]:
                if saved["previous"] is None:
                    status.unlink()
                else:
                    atomic_json(status, saved["previous"])
            journal.unlink()


def require_free_port(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=5):
            raise RuntimeError("The port is occupied by a process outside this installation.")
    except ConnectionRefusedError:
        pass


def stop_when_idle(port, state, token, new_port):
    state = state.resolve()
    state_lock = state / ".server-process.lock"
    status = state / "admin/server-update.json"
    journal = status.with_name(".remote-deploy-previous.json")
    with exclusive_lock(state / ".remote-deploy.lock"), ExitStack() as resources:
        if journal.exists():
            restore_status(status, journal)
        if port != new_port:
            require_free_port(new_port)
        if not state_locked(state_lock):
            require_free_port(port)
            return
        pid = state_owner(state_lock)

        from update_runner import atomic_json, server_update_status_lock, utc_now

        pidfd = os.pidfd_open(pid) if sys.platform.startswith("linux") else None
        if pidfd is not None:
            resources.callback(os.close, pidfd)

        def check_owner():
            if state_owner(state_lock) != pid:
                raise RuntimeError("The server owning this installation changed during deployment.")

        def health():
            snapshot = request_json(f"http://127.0.0.1:{port}/api/health", token, expected_pid=pid,
                                    platform=platform.system(), verify_owner=check_owner, timeout=20)
            if snapshot.get("ok") is not True or Path(snapshot["state_dir"]).resolve() != state:
                raise RuntimeError("The responding server does not own this installation.")
            return snapshot

        snapshot = health()
        instance = snapshot["server_instance_id"]
        if not instance:
            raise RuntimeError("The responding server has no instance identity.")
        owner = "remote-deploy-" + uuid.uuid4().hex
        while True:
            if snapshot["server_instance_id"] != instance:
                raise RuntimeError("The server instance changed during deployment.")
            if not busy(snapshot):
                # Wait for active runs before closing admission: an existing turn may itself need
                # authenticated server mutations to finish. A second snapshot covers admission races.
                try:
                    with server_update_status_lock(status):
                        previous = json.loads(status.read_bytes()) if status.exists() else None
                        if (previous or {}).get("phase", "idle") not in {
                            "idle", "current", "complete", "failed", "available", "unavailable", "cancelled",
                        } or (previous or {}).get("_activation_recovery") or (previous or {}).get("_execution_handoff"):
                            raise RuntimeError("Another update owns the running server.")
                        atomic_json(journal, {"owner": owner, "previous": previous})
                        atomic_json(status, {"phase": "starting", "update_id": owner, "updated_at": utc_now()})
                    fenced = health()
                    if (fenced["server_instance_id"] != instance or fenced["server_update"]["phase"] != "starting"
                            or fenced["server_update"]["update_id"] != owner):
                        raise RuntimeError("The running server did not acknowledge the deployment fence.")
                    if not busy(fenced):
                        # The incumbent can reconcile an abandoned update after its startup grace.
                        # Recheck ownership under its writer lock before signaling the verified process.
                        with server_update_status_lock(status):
                            current = json.loads(status.read_bytes())
                            if current.get("phase") != "starting" or current.get("update_id") != owner:
                                raise RuntimeError("The deployment lost its admission fence.")
                            check_owner()
                            if pidfd is None:
                                os.kill(pid, signal.SIGTERM)
                            else:
                                signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                        for _ in range(90):
                            if not state_locked(state_lock):
                                return
                            time.sleep(1)
                        raise RuntimeError("The idle server has not stopped; leaving its installation in place.")
                finally:
                    restore_status(status, journal)
            print("[AgentsDock setup] Waiting for running work before redeploy", flush=True)
            time.sleep(5)
            snapshot = health()


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise SystemExit(1)

    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    stop_when_idle(int(sys.argv[1]), Path(os.environ.get("AGENTSDOCK_STATE_DIR") or "state"),
                   os.environ.get("AGENTSDOCK_AGENT_TOKEN", ""), int(sys.argv[2]))
