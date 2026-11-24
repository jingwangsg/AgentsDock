"""Gemini CLI stream-json protocol and per-turn Inference Hub settings."""
from contextlib import contextmanager
import json
import os
import stat
import sys
from pathlib import Path
import re
import tempfile

from gemini_gateway import ARGON_EFFORTS, ARGON_MODEL, EFFORT_HEADER, MODEL, GatewayError
from gemini_history import local_sessions, public_messages, session_id

DEFAULT_MODEL = ARGON_MODEL
PERMISSIONS = {"default": "default", "plan": "plan", "full_access": "yolo"}
MCP_SERVER_NAME = "agentsdock_internal_provider_9f3a2c71"


class GeminiConfigurationError(ValueError):
    """A configuration error with a public, credential-free description."""


def read_native_settings(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, encoding="utf-8-sig") as source:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size > 4 * 1024 * 1024:
                raise ValueError("invalid settings file")
            raw = source.read(4 * 1024 * 1024 + 1)
        # Gemini supports JSON with comments. Quotes protect URLs and literal comment markers.
        raw = re.sub(r'"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/',
                     lambda m: " " if m[0].startswith("/") else m[0], raw)
        settings = json.loads(raw)
        if not isinstance(settings, dict):
            raise ValueError("invalid settings object")
        return settings
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise GeminiConfigurationError("Gemini CLI settings could not be read. Check the native settings file.") from None


@contextmanager
def native_environment(env, access, mcp=None, *, cwd, effort=None):
    if effort and (effort not in ARGON_EFFORTS or not access.get("supportsThinkingLevel")):
        raise GeminiConfigurationError("The Gemini gateway cannot apply this reasoning level. Update the hub or select Server default.")
    env = {
        **env,
        "GEMINI_CLI_AUTH_OVERRIDE": "gemini-api-key",
        "GEMINI_API_KEY": access["accessToken"],
        "GEMINI_API_KEY_AUTH_MECHANISM": "bearer",
        "GOOGLE_GENAI_API_VERSION": "v1beta",
        "GOOGLE_GENAI_USE_VERTEXAI": "false",
        "GOOGLE_GENAI_USE_GCA": "false",
        "GEMINI_CLI_CUSTOM_HEADERS": f"{EFFORT_HEADER}: {effort}" if effort else "",
        "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{access['port']}",
    }
    native_home = Path(env.get("GEMINI_CLI_HOME") or env["HOME"])
    native = native_home / ".gemini"
    system_dir = "/Library/Application Support/GeminiCli" if sys.platform == "darwin" else "/etc/gemini-cli"
    settings_paths = [Path(env.get("GEMINI_CLI_SYSTEM_SETTINGS_PATH") or Path(system_dir) / "settings.json")]
    if Path(cwd).resolve() != native_home.resolve() or mcp:
        settings_paths.append(Path(cwd) / ".gemini/settings.json")
    # System and trusted workspace selections take precedence over the native
    # user auth override. A conflicting selection could send work to Google.
    for settings_path in settings_paths:
        settings = read_native_settings(settings_path)
        auth = settings.get("security", {}).get("auth", {})
        if any(auth.get(k) not in (None, "gemini-api-key") for k in ("selectedType", "enforcedType")):
            raise GeminiConfigurationError("Gemini settings select an authentication method incompatible with Inference Hub.")
        if mcp and mcp[0] in settings.get("mcpServers", {}):
            raise GeminiConfigurationError("Gemini settings already define the internal MCP server.")
    if not mcp:
        yield env
        return

    # 0.71 has an in-memory auth override but accepts MCP definitions only in
    # settings files. Keep the broker bearer out of the actual user profile.
    settings = read_native_settings(native / "settings.json")
    servers = settings.setdefault("mcpServers", {})
    if mcp[0] in servers:
        raise GeminiConfigurationError("Gemini settings already define the internal MCP server.")
    servers[mcp[0]] = mcp[1]
    with tempfile.TemporaryDirectory(prefix="agentsdock-gemini-") as directory:
        home = Path(directory)
        profile = home / ".gemini"
        profile.mkdir(mode=0o700)
        for name in ("tmp", "history"):
            (native / name).mkdir(parents=True, mode=0o700, exist_ok=True)
        for name in ("tmp", "history", "projects.json", "GEMINI.md", "skills", "agents", "extensions",
                     "policies", "commands", "trustedFolders.json", "acknowledgments", "policy_integrity.json"):
            if (native / name).exists():
                (profile / name).symlink_to(native / name)
        if (native_home / ".agents").is_dir():
            (home / ".agents").symlink_to(native_home / ".agents", target_is_directory=True)
        if env.get("SANDBOX") == "sandbox-exec":
            runtime = native_home / ".cache/.gemini"
            runtime.mkdir(parents=True, mode=0o700, exist_ok=True)
            (home / ".cache").mkdir()
            (home / ".cache/.gemini").symlink_to(runtime, target_is_directory=True)
        settings_path = profile / "settings.json"
        settings_path.write_text(json.dumps(settings), encoding="utf-8")
        settings_path.chmod(0o600)
        yield {**env, "GEMINI_CLI_HOME": str(home)}


def has_native_history(cwd, native_id):
    # The native selector ignores first turns rewound to the setup prompt.
    # Read the durable home, whose project markers survive the MCP overlay.
    sessions = list(local_sessions(cwd=cwd, provider_id=native_id))
    if len(sessions) != 1:
        return False
    try:
        messages = public_messages(sessions[0], max_bytes=64 * 1024 * 1024,
                                   max_line_bytes=16 * 1024 * 1024, max_records=100_000)
        return any(role == "assistant" or not text.lstrip().startswith(("/", "?")) for role, text in messages)
    except (ValueError, OSError, RecursionError):
        return False


def command(executable, model, permission, native_id, resume):
    if not MODEL.fullmatch(model) or not session_id(native_id) or permission not in PERMISSIONS:
        raise ValueError("Invalid Gemini model, permission or session identifier.")
    return [
        executable, "--model", model, "--approval-mode", PERMISSIONS[permission],
        "--output-format", "stream-json", "--resume" if resume else "--session-id", native_id, "-p", "",
    ]


def failure_message(native_message):
    """Return only known public errors. Native stderr can contain the entire prompt."""
    if "Gemini CLI is not running in a trusted directory" in native_message:
        return "Open Gemini CLI in this workspace, choose Trust folder, then retry the turn."
    if "The enforced authentication type is" in native_message:
        return "The Gemini administrator's authentication policy does not allow Inference Hub."
    if ("No previous sessions found for this project" in native_message or
            "No sessions found for this project" in native_message or "Use --list-sessions" in native_message):
        return "Gemini CLI could not resume this session in its original workspace."
    for error in [GatewayError(422, budget=True), *(GatewayError(status) for status in (400, 401, 403, 422, 429, 502))]:
        if str(error) in native_message:
            return str(error)
    return None


class GeminiStream:
    """Validate one native turn and project public content in stream order."""

    def __init__(self, native_id, secrets=()):
        self.native_id = native_id
        self.secrets = tuple(secret for secret in secrets if secret)
        self.started = False
        self.done = False
        self.failed = False
        self.failure = None
        self.calls = {}
        self.call_ids = set()
        self.parts = []
        self.block = 0
        self.suffix = ""
        self.size = 0
        self.usage = {}

    def text_events(self, delta="", *, end=False):
        # A native delta can end inside a bearer. Delay just that suffix until
        # the next delta so streamed and persisted text have identical redaction.
        text = self.suffix + delta
        self.suffix = ""
        for secret in self.secrets:
            text = text.replace(secret, "[redacted]")
        if not end:
            tail = max((n for secret in self.secrets for n in range(1, min(len(text) + 1, len(secret)))
                        if text.endswith(secret[:n])), default=0)
            if tail:
                self.suffix, text = text[-tail:], text[:-tail]
        if not text:
            return []
        self.parts.append(text)
        return [("assistant_text", {"text": text, "delta": True, "item_id": f"gemini-text-{self.block}"})]

    def consume(self, line):
        e = json.loads(line)
        kind = e["type"]
        if self.done or (not self.started and kind not in ("init", "error", "result")):
            raise ValueError("Unexpected Gemini event order.")
        if kind == "init" and not self.started and e.get("session_id") == self.native_id:
            self.started = True
            return []
        if kind == "message" and e.get("role") == "user":
            return []
        if kind == "message" and e.get("role") == "assistant" and e.get("delta") is True:
            delta = e["content"]
            if not isinstance(delta, str):
                raise ValueError("Invalid Gemini text delta.")
            self.size += len(delta)
            if self.size > 2_000_000:
                raise ValueError("Gemini response exceeds the output limit.")
            return self.text_events(delta)
        events = self.text_events(end=True)
        if kind in ("tool_use", "tool_result"):
            # Decode escapes before matching a bearer in tool inputs or output.
            if self.secrets:
                public = json.dumps(e, ensure_ascii=False)
                for secret in self.secrets:
                    public = public.replace(secret, "[redacted]")
                e = json.loads(public)
            call = e.get("tool_id")
            if not isinstance(call, str) or not re.fullmatch(r"[\w.:-]{1,256}", call):
                raise ValueError("Invalid Gemini tool identifier.")
            self.block += 1
            if kind == "tool_use" and call not in self.call_ids and len(self.call_ids) < 2048:
                if not isinstance(e.get("tool_name"), str) or not isinstance(e.get("parameters"), dict):
                    raise ValueError("Invalid Gemini tool request.")
                tool = {"id": call, "name": e["tool_name"][:256], "input": e["parameters"]}
                self.call_ids.add(call)
                self.calls[call] = tool
                return events + [("tool_started", {"tool_id": call, "tool": tool})]
            if kind == "tool_result" and call in self.calls and e.get("status") in ("success", "error"):
                failed = e["status"] == "error" or bool(e.get("error"))
                output = e.get("output") or ("Gemini CLI reported a tool error." if failed else "")
                if not isinstance(output, str):
                    raise ValueError("Invalid Gemini tool result.")
                return events + [("tool_finished", {
                    "tool_id": call, "tool": self.calls.pop(call), "output": output[:12000],
                    "exit_code": int(failed),
                })]
            raise ValueError("Unmatched Gemini tool event.")
        if kind == "error" and e.get("severity") in ("warning", "error"):
            self.failed |= e["severity"] == "error"
            return events
        if kind == "result" and e.get("status") in ("success", "error"):
            self.failed |= e["status"] == "error"
            if not self.failed and (not self.started or self.calls):
                raise ValueError("Incomplete Gemini turn.")
            self.done = True
            if self.failed:
                self.failure = failure_message(str((e.get("error") or {}).get("message", "")))
            stats = e.get("stats") or {}
            for target, source in (("total_tokens", "total_tokens"), ("input_tokens", "input_tokens"),
                                   ("output_tokens", "output_tokens"), ("cached_input_tokens", "cached")):
                if type(stats.get(source)) is int and stats[source] >= 0:
                    self.usage[target] = stats[source]
            return events
        raise ValueError("Unrecognized Gemini stream event.")


def install_cli():
    """Install a new npm release beside running versions, then switch the managed launcher."""
    import shutil
    import subprocess
    home = Path.home()
    root = home / ".local/share/agentsdock-gemini-cli"
    launcher = home / ".local/bin/gemini"
    current = shutil.which(os.environ.get("GEMINI_BIN") or "gemini")
    if (current and not Path(current).resolve().is_relative_to(root.resolve())) or (
        os.path.lexists(launcher) and not (launcher.is_symlink() and launcher.resolve().is_relative_to(root.resolve()))
    ):
        raise RuntimeError("Update this externally managed Gemini CLI with its own package manager.")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    launcher.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    version = subprocess.check_output(["npm", "view", "@google/gemini-cli@latest", "version"], text=True).strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("Could not determine the current Gemini CLI release.")
    release = root / version
    with tempfile.TemporaryDirectory(dir=root, prefix=".install-") as scratch:
        stage = Path(scratch) / "package"
        if not release.exists():
            subprocess.run(["npm", "install", "--prefix", str(stage), "--no-audit", "--no-fund",
                            "@google/gemini-cli@" + version], check=True)
            binary = stage / "node_modules/.bin/gemini"
            if subprocess.check_output([binary, "--version"], text=True).strip() != version:
                raise RuntimeError("Gemini CLI installation verification failed.")
            try:
                stage.rename(release)
            except OSError:
                if not release.is_dir():
                    raise
        binary = release / "node_modules/.bin/gemini"
        if subprocess.check_output([binary, "--version"], text=True).strip() != version:
            raise RuntimeError("Gemini CLI release is incomplete.")
        temp_link = Path(scratch) / "gemini"
        temp_link.symlink_to(binary)
        if os.path.lexists(launcher) and not (launcher.is_symlink() and launcher.resolve().is_relative_to(root.resolve())):
            raise RuntimeError("The Gemini CLI launcher changed during installation.")
        os.replace(temp_link, launcher)
    print("Gemini CLI " + version)


if __name__ == "__main__":
    if sys.argv[1:] != ["--install"]:
        raise SystemExit(2)
    install_cli()
