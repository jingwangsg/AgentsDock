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
# An attach with the default directory passes install.sh's config directory as $2
# (remote_servers.INSTALL_SH_CONFIG_DIR); it becomes the install only when $1 has no env.
FALLBACK_DIR="${2:-}"
case "$FALLBACK_DIR" in "~"*) FALLBACK_DIR="$HOME${FALLBACK_DIR#\~}" ;; esac
if [ -n "$FALLBACK_DIR" ] && [ ! -r "$INSTALL_DIR/env" ] && [ -r "$FALLBACK_DIR/env" ]; then INSTALL_DIR="$FALLBACK_DIR"; fi
# The server's HOME decides where claude/codex look for their logins. Prefer the
# install directory's parent when it already holds those logins (a persistent
# home on a network filesystem, chosen by the user), otherwise the shell HOME.
# A deploy into a configured cluster home always uses that home (see _deploy in
# remote_servers.py).
HOME_DIR="$HOME"
PARENT_DIR="$(dirname "$INSTALL_DIR")"
if [ -d "$PARENT_DIR/.claude" ] || [ -d "$PARENT_DIR/.codex" ]; then HOME_DIR="$PARENT_DIR"; fi
ENV_FILE=""
if [ -n "$INSTALL_DIR" ] && [ -r "$INSTALL_DIR/env" ]; then ENV_FILE="$INSTALL_DIR/env"; fi
python3 - "$HOME_DIR" "$ENV_FILE" "$INSTALL_DIR" <<'PY'
import json, os, platform, shutil, socket, sys
home, env_file, install_dir = sys.argv[1:4]
# A hub-deployed env writes `export NAME=value`, install.sh `NAME=value`; the last line wins.
values = {}
if env_file:
    with open(env_file) as handle:
        for line in handle:
            line = line.strip()
            if line.startswith("export") and line[6:7].isspace():
                line = line[7:].lstrip()
            name, sep, value = line.partition("=")
            if sep:
                values[name.strip()] = value.strip().strip("'\"")
existing = values.get("AGENTSDOCK_AGENT_PORT", "")
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
    "existing_token": values.get("AGENTSDOCK_AGENT_TOKEN") or None, "install_dir": install_dir,
}))
PY
