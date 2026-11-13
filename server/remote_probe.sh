set -u
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
# The arguments are candidate install directories, in order: the hub's choice, then the target's
# earlier install (a deploy into an OSMO pool home), then the next configured cluster homes and the
# container's own ~. The install is the first that holds one (its env: an earlier install keeps its
# chats), else the first whose parent exists (not every cluster mounts a configured home), else $1.
expand() { case "$1" in "~"*) printf '%s\n' "$HOME${1#\~}" ;; *) printf '%s\n' "$1" ;; esac; }
CANDIDATE="" index=0
for dir in "$@"; do
  if [ -z "$CANDIDATE" ] && [ -r "$(expand "$dir")/env" ]; then CANDIDATE=$index; fi
  index=$((index + 1))
done
index=0
for dir in "$@"; do
  if [ -z "$CANDIDATE" ] && [ -d "$(dirname "$(expand "$dir")")" ]; then CANDIDATE=$index; fi
  index=$((index + 1))
done
CANDIDATE="${CANDIDATE:-0}" INSTALL_DIR=""
if [ "$#" -gt 0 ]; then shift "$CANDIDATE"; INSTALL_DIR="$(expand "$1")"; fi
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
python3 - "$HOME_DIR" "$ENV_FILE" "$INSTALL_DIR" "$CANDIDATE" <<'PY'
import json, os, platform, shutil, socket, sys
home, env_file, install_dir, candidate = sys.argv[1:5]
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
    "free_port": port, "existing_port": int(existing) if existing.isdigit() else None, "install_dir": install_dir,
    "candidate": int(candidate),
}))
PY
