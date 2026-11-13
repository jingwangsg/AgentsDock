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
# The arguments are candidate install directories, in order: the hub's first choice, then the target's
# directories in the other configured homes (the earlier install of a workflow whose pool got its own
# home, and the next homes: not every cluster mounts every configured home). The probe takes the first
# that holds an install (an env file), so a deploy keeps its chats; else the first whose home exists;
# else what the search below finds; else the first, whose mkdir then names the missing directory.
# The search is an argument without a leading / or ~, "<name>/<install directory name>", used only
# when no candidate's home exists (a site whose home the hub's environment does not name yet). It
# looks for <name> on the host's NFS and Lustre mounts, as <mount>/<name> or <mount>/<dir>/<name>,
# where the ssh user can write, in mount-table order: the first that holds the install, else the
# first that holds a Claude or Codex login (the user's home on that storage), else the first.
expand() { case "$1" in "~"*) printf '%s\n' "$HOME${1#\~}" ;; *) printf '%s\n' "$1" ;; esac; }
HELD=""
MOUNTED=""
SEARCH=""
index=0
for dir in "$@"; do
  case "$dir" in
    /*|"~"*)
      dir="$(expand "$dir")"
      if [ -z "$HELD" ] && [ -r "$dir/env" ]; then HELD=$index; fi
      if [ -z "$MOUNTED" ] && [ -d "$(dirname "$dir")" ]; then MOUNTED=$index; fi
      ;;
    *) SEARCH=$index; SEARCH_NAME="${dir%/*}"; SEARCH_INSTALL="${dir##*/}" ;;
  esac
  index=$((index + 1))
done
WITH_INSTALL=""
WITH_LOGIN=""
WRITABLE=""
# An install's home exists, so an empty MOUNTED also means no candidate holds an install.
if [ -z "$MOUNTED" ] && [ -n "$SEARCH" ]; then
  while read -r _ mount type _; do
    case "$type" in nfs|nfs4|lustre) ;; *) continue ;; esac
    for found in "$mount/$SEARCH_NAME" "$mount"/*/"$SEARCH_NAME"; do
      if [ ! -d "$found" ] || [ ! -w "$found" ]; then continue; fi
      if [ -z "$WITH_INSTALL" ] && [ -r "$found/$SEARCH_INSTALL/env" ]; then WITH_INSTALL="$found"; fi
      if [ -z "$WITH_LOGIN" ] && { [ -d "$found/.claude" ] || [ -d "$found/.codex" ]; }; then WITH_LOGIN="$found"; fi
      if [ -z "$WRITABLE" ]; then WRITABLE="$found"; fi
    done
  done < /proc/mounts
fi
FOUND="${WITH_INSTALL:-${WITH_LOGIN:-$WRITABLE}}"
CANDIDATE="${HELD:-${MOUNTED:-0}}"
INSTALL_DIR=""
if [ -n "$FOUND" ]; then
  CANDIDATE=$SEARCH
  INSTALL_DIR="$FOUND/$SEARCH_INSTALL"
elif [ "$#" -gt 0 ]; then shift "$CANDIDATE"; INSTALL_DIR="$(expand "$1")"; fi
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
