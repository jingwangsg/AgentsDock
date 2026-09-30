set -eu
INSTALL_DIR="$1"
case "$INSTALL_DIR" in "~"*) INSTALL_DIR="$HOME${INSTALL_DIR#\~}" ;; esac
PORT="$2"
HOME_DIR="$3"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
log() { printf '[AgentsDock setup] %s\n' "$1"; }
mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/state"
# The server refuses a state directory that group/others can write (a host umask
# of 002 makes mkdir produce 775), so pin the two directories it checks. It also
# writes its config env (a Claude token saved in the app) only into a directory
# that group/others cannot write.
chmod go-w "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/state"
[ -d "$INSTALL_DIR/state/admin" ] && chmod 700 "$INSTALL_DIR/state/admin"
# Chat import verifies other instances under ~/.config and refuses group/other-writable
# ancestors of the state dir, the home directory included (Lustre homes are often
# created with umask 002). Warn for each offending directory so the operator can chmod it.
for check_dir in "$HOME_DIR" "$HOME_DIR/.config"; do
  if [ -d "$check_dir" ] && [ -n "$(find "$check_dir" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
    log "Warning: $check_dir is group/other-writable; chat import on this host will refuse to run until you chmod g-w,o-w it."
  fi
done
cd "$INSTALL_DIR"

UNPACKED=0
if [ -f upload.tgz ]; then
  log "Unpacking AgentsServer source"
  rm -rf server.new && mkdir server.new
  tar -xzf upload.tgz -C server.new 2>tar.err || { cat tar.err >&2; exit 2; }
  rm -f tar.err
  if [ -d server/.venv ]; then mv server/.venv server.new/.venv; fi
  rm -rf server.old; [ -d server ] && mv server server.old; mv server.new server; rm -rf server.old upload.tgz
  # The new source must replace the running instance; start.sh alone sees a
  # healthy port and leaves the old process serving. The [a] keeps the pattern
  # from matching a shell that carries it in its own command line.
  tmux kill-session -t "agentsdock-$PORT" 2>/dev/null || true
  pkill -f "[a]gent_server.py serve.*--port $PORT$" 2>/dev/null || true
  UNPACKED=1
elif [ ! -f server/agent_server.py ]; then
  printf 'No server source was uploaded to %s.\n' "$INSTALL_DIR" >&2
  exit 2
fi

# A hub attaching to an install another hub deployed runs this script without a
# tarball and must leave the install as it is: the runtime is synced only for new source.
if [ "$UNPACKED" = 1 ]; then
  if ! command -v uv >/dev/null 2>&1; then
    log "Installing uv"
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v uv >/dev/null 2>&1 || { printf 'uv could not be installed.\n' >&2; exit 2; }
  # The server needs 3.11+ (tomllib) although pyproject still says >=3.10; without
  # the pin uv happily picks an older managed interpreter it finds on the host.
  log "Preparing the Python runtime (uv sync)"
  ( cd server && uv sync --frozen --quiet --python '>=3.11' )
fi

# Agent CLIs. Claude Code has a dependency-free installer; install it under the
# server's HOME so the binary lands on a persistent path. Codex is left to the
# user (its login lives in $HOME_DIR/.codex and the CLI is usually already there).
if ! PATH="$HOME_DIR/.local/bin:$PATH" command -v claude >/dev/null 2>&1; then
  log "Installing Claude Code into $HOME_DIR/.local/bin"
  if ! HOME="$HOME_DIR" bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1; then
    log "Claude Code install failed; install it manually and reconnect"
  fi
fi

# Canvas compiles reports with node, which a non-interactive ssh PATH often lacks
# even when the user's own shell has it (conda, nvm). Install the current Node.js
# 22 LTS under the server's HOME, checked against nodejs.org's published checksums.
if ! PATH="$HOME_DIR/.local/bin:$PATH" command -v node >/dev/null 2>&1; then
  log "Installing Node.js into $HOME_DIR/.local (Canvas needs node)"
  NODE_DIST=https://nodejs.org/dist/latest-v22.x
  case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=unsupported ;; esac
  NODE_SUM="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" 2>/dev/null | grep -E " node-v[0-9.]+-linux-$NODE_ARCH\.tar\.gz\$" | head -1 || true)"
  if [ -n "$NODE_SUM" ] && curl -fsSL "$NODE_DIST/${NODE_SUM##* }" -o node.tgz \
    && [ "$(sha256sum node.tgz | cut -d' ' -f1)" = "${NODE_SUM%% *}" ] \
    && rm -rf "$HOME_DIR/.local/node" && mkdir -p "$HOME_DIR/.local/node" "$HOME_DIR/.local/bin" \
    && tar -xzf node.tgz -C "$HOME_DIR/.local/node" --strip-components=1; then
    ln -sf "$HOME_DIR/.local/node/bin/node" "$HOME_DIR/.local/bin/node"
  else
    log "Node.js install failed; Canvas stays unavailable until node is on the server PATH"
  fi
  rm -f node.tgz
fi

# Chat terminals and a detached server session need tmux. Install it through the system
# package manager where this user may (root or passwordless sudo); start.sh below then uses it.
if ! command -v tmux >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then AS_ROOT=""; elif sudo -n true 2>/dev/null; then AS_ROOT="sudo -n"; else AS_ROOT=none; fi
  if [ "$AS_ROOT" != none ]; then
    log "Installing tmux"
    if command -v apt-get >/dev/null 2>&1; then
      # A fresh container often has no package lists yet.
      $AS_ROOT apt-get update -q >/dev/null 2>&1 || true
      $AS_ROOT env DEBIAN_FRONTEND=noninteractive apt-get install -y -q tmux >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
      $AS_ROOT dnf install -y -q tmux >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      $AS_ROOT yum install -y -q tmux >/dev/null 2>&1 || true
    fi
  fi
  command -v tmux >/dev/null 2>&1 || log "tmux could not be installed here; the server runs under nohup and chat terminals stay disabled"
fi

if [ ! -f env ]; then
  log "Generating access token"
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  umask 077
  {
    printf 'export AGENTSDOCK_AGENT_TOKEN=%s\n' "$TOKEN"
    printf 'export AGENTSDOCK_STATE_DIR=%s/state\n' "$INSTALL_DIR"
    printf 'export AGENTSDOCK_AGENT_BIND=127.0.0.1\n'
    printf 'export AGENTSDOCK_AGENT_PORT=%s\n' "$PORT"
    printf 'export HOME=%s\n' "$HOME_DIR"
    printf 'export AGENTSDOCK_AGENT_CWD=%s\n' "$HOME_DIR"
    printf 'export DISABLE_AUTOUPDATER=1\n'
    if [ "$(id -u)" = 0 ]; then printf 'export IS_SANDBOX=1\n'; fi
    # Keep the bootstrap PATH at the end: interpreters that live only there
    # (e.g. /opt/conda/bin) must stay visible to the server and start.sh.
    printf 'export PATH=%s/.local/bin:%s/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:%s\n' "$HOME_DIR" "$HOME" "$PATH"
  } > env
fi
# Keep the requested port even for an existing install that was moved.
sed -i.bak "s|^export AGENTSDOCK_AGENT_PORT=.*|export AGENTSDOCK_AGENT_PORT=$PORT|" env && rm -f env.bak
# The server saves settings such as a Claude token pasted in the app into its config env
# file; point that at this env so start.sh reads them back.
if ! grep -qxF "export AGENTS_SERVER_CONFIG_DIR=$INSTALL_DIR" env; then
  (umask 077; { grep -v '^export AGENTS_SERVER_CONFIG_DIR=' env || true; printf 'export AGENTS_SERVER_CONFIG_DIR=%s\n' "$INSTALL_DIR"; } > env.new && mv env.new env)
fi
# A home shared between machines (the probe picked it because it holds the logins) cannot
# hold Codex's SQLite state as well: WAL mode needs shared memory, so the second machine's
# `codex app-server` exits with "failed to initialize sqlite state runtime". Each install
# keeps its own copy; rollouts stay in the shared ~/.codex/sessions.
if [ "$HOME_DIR" != "$HOME" ] && ! grep -qxF "export CODEX_SQLITE_HOME=$INSTALL_DIR/codex-state" env; then
  (umask 077; { grep -v '^export CODEX_SQLITE_HOME=' env || true; printf 'export CODEX_SQLITE_HOME=%s/codex-state\n' "$INSTALL_DIR"; } > env.new && mv env.new env)
fi
# Start that state as a copy of the shared home's databases. Left empty, Codex rebuilds
# its thread index from every rollout file on the shared mount; that outlasts the 30 s
# it allows itself, and the interrupted rebuild leaves a "running" marker that makes
# every later start wait and fail. Logs are diagnostics only and the largest file.
if [ "$HOME_DIR" != "$HOME" ] && [ -d "$HOME_DIR/.codex" ] && [ ! -d "$INSTALL_DIR/codex-state" ]; then
  mkdir -p "$INSTALL_DIR/codex-state"
  python3 - "$HOME_DIR/.codex" "$INSTALL_DIR/codex-state" <<'PY'
import glob, os, sqlite3, sys
legacy, target = sys.argv[1:]
for path in glob.glob(os.path.join(legacy, "*.sqlite")):
    name = os.path.basename(path)
    if name.startswith("logs_"):
        continue
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    copy = sqlite3.connect(os.path.join(target, name))
    source.backup(copy)
    copy.close()
    source.close()
PY
fi
# The hub's Claude token (RemoteServerManager._deploy); the server uses no other Claude auth.
if [ -n "${AGENTSDOCK_CLAUDE_TOKEN:-}" ] && ! grep -qxF "export CLAUDE_CODE_OAUTH_TOKEN=$AGENTSDOCK_CLAUDE_TOKEN" env; then
  (umask 077; { grep -v '^export CLAUDE_CODE_OAUTH_TOKEN=' env || true; printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$AGENTSDOCK_CLAUDE_TOKEN"; } > env.new && mv env.new env)
  log "Installed the Claude token from the hub"
  # A running server keeps its old environment: stop it so start.sh below starts one
  # with the token, and wait, or start.sh would still find the old one healthy.
  tmux kill-session -t "agentsdock-$PORT" 2>/dev/null || true
  pkill -f "[a]gent_server.py serve.*--port $PORT$" 2>/dev/null || true
  for _ in $(seq 1 30); do pgrep -f "[a]gent_server.py serve.*--port $PORT$" >/dev/null || break; sleep 1; done
fi

cat > start.sh <<'START'
#!/usr/bin/env bash
# Start AgentsServer for this install in a tmux session (nohup without tmux). Idempotent.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
source "$DIR/env"
HEALTH="http://127.0.0.1:$AGENTSDOCK_AGENT_PORT/api/health"
if curl -fsS -m 3 -H "Authorization: Bearer $AGENTSDOCK_AGENT_TOKEN" "$HEALTH" >/dev/null 2>&1; then
  echo "AgentsServer already listening on port $AGENTSDOCK_AGENT_PORT"; exit 0
fi
# A dead default tmux socket left by a container's startup makes new-session fail.
sock="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default"
if [[ -S "$sock" ]] && ! tmux -S "$sock" list-sessions >/dev/null 2>&1; then rm -f "$sock"; fi
# The command lives in a file so tmux never expands $AGENTSDOCK_* itself: a
# tmux server started earlier from a login shell has no env file loaded, and
# `bash -c "... --bind \"$AGENTSDOCK_AGENT_BIND\" ..."` collapsed to `--bind --port`.
cat > "$DIR/run.sh" <<RUN
#!/usr/bin/env bash
cd '$DIR/server' && source '$DIR/env' && exec .venv/bin/python agent_server.py serve --bind "\${AGENTSDOCK_AGENT_BIND:-127.0.0.1}" --port "\${AGENTSDOCK_AGENT_PORT:-7850}" >> '$DIR/logs/server.log' 2>&1
RUN
chmod +x "$DIR/run.sh"
SESSION="agentsdock-$AGENTSDOCK_AGENT_PORT"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" "bash '$DIR/run.sh'"
else
  setsid nohup bash "$DIR/run.sh" >/dev/null 2>&1 < /dev/null &
fi
for _ in $(seq 1 60); do
  sleep 1
  if curl -fsS -m 3 -H "Authorization: Bearer $AGENTSDOCK_AGENT_TOKEN" "$HEALTH" >/dev/null 2>&1; then
    echo "AgentsServer started on port $AGENTSDOCK_AGENT_PORT (tmux session $SESSION)"; exit 0
  fi
done
echo "AgentsServer did not become healthy; log tail:" >&2
tail -30 "$DIR/logs/server.log" >&2
exit 1
START
chmod +x start.sh

log "Starting AgentsServer on port $PORT"
bash start.sh

. ./env
VERSION="$(tr -d '[:space:]' < server/VERSION 2>/dev/null || true)"
# The venv interpreter exists after uv sync; python3 depends on the PATH env just replaced.
printf 'AGENTSDOCK_SETUP_RESULT=%s\n' "$(server/.venv/bin/python -c 'import json,sys; print(json.dumps({"server_url": "http://127.0.0.1:" + sys.argv[1], "access_token": sys.argv[2], "service": "ssh-tunnel", "tailscale_ip": "", "server_version": sys.argv[3], "remote_port": int(sys.argv[1]), "install_dir": sys.argv[4]}))' "$PORT" "$AGENTSDOCK_AGENT_TOKEN" "$VERSION" "$INSTALL_DIR")"
