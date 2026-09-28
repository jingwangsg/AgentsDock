set -u
INSTALL_DIR="${1:-}"
case "$INSTALL_DIR" in "~"*) INSTALL_DIR="$HOME${INSTALL_DIR#\~}" ;; esac
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v python3 >/dev/null 2>&1; then
  printf 'python3 is required on the host.\n' >&2
  exit 78
fi
# The uv/claude installers and every start.sh health check go through curl.
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required on the host.\n' >&2
  exit 78
fi
# The server's HOME decides where claude/codex look for their logins. Prefer the
# install directory's parent when it already holds those logins (a persistent
# home on a network filesystem, chosen by the user), otherwise the shell HOME.
HOME_DIR="$HOME"
PARENT_DIR="$(dirname "$INSTALL_DIR")"
if [ -d "$PARENT_DIR/.claude" ] || [ -d "$PARENT_DIR/.codex" ]; then HOME_DIR="$PARENT_DIR"; fi
EXISTING_PORT=""
if [ -n "$INSTALL_DIR" ] && [ -r "$INSTALL_DIR/env" ]; then
  EXISTING_PORT="$(sed -n 's/^export AGENTSDOCK_AGENT_PORT=//p' "$INSTALL_DIR/env" | tail -n 1)"
fi
python3 - "$HOME_DIR" "$EXISTING_PORT" <<'PY'
import json, os, platform, shutil, socket, sys
home, existing = sys.argv[1], sys.argv[2]
def free_port(start=7850):
    for port in range(start, start + 400):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise SystemExit("no free port")
port = int(existing) if existing.isdigit() else free_port()
print("AGENTSDOCK_TUNNEL_PROBE=" + json.dumps({
    "os": platform.system(), "arch": platform.machine(), "uid": os.getuid(), "home": home,
    "tmux": shutil.which("tmux") is not None, "uv": shutil.which("uv") is not None,
    "node": shutil.which("node") is not None,
    "free_port": port, "existing_port": int(existing) if existing.isdigit() else None,
}))
PY
