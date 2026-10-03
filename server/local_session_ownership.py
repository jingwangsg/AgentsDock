"""Same-user provider-history ownership across local server instances.

Registry, path and lock primitives come from server_instances; this module adds
only the read-only ownership discovery and the import guard that agent_server
uses. Discovery reads only; the import guard creates a private shared lock.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path

from server_instances import Registry, check_path, exclusive_lock, read_config, read_regular

PROVIDER_ID_FIELDS = {
    "claude": "claude_session_id", "codex": "codex_thread_id",
    "cursor": "cursor_session_id", "opencode": "opencode_session_id",
}
MAX_IMPORT_INDEX_BYTES = 64 * 1024 * 1024
MAX_IMPORT_INDEX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_IMPORT_INSTANCES = 256


def provider_session_keys(session: dict, default_backend: str = "claude") -> set[tuple[str, str]]:
    """Include parked provider identities as well as the active legacy ID."""
    backend = str(session.get("backend") or default_backend).strip().lower()
    keys = set()
    for provider, field in PROVIDER_ID_FIELDS.items():
        value = session.get(field)
        if not value and provider == backend:
            value = session.get("provider_session_id") or session.get("session_id")
        if isinstance(value, str) and value.strip():
            keys.add((provider, value.strip()))
    return keys


def other_instance_provider_keys(current_state: Path, *, registry: Registry | None = None) -> set[tuple[str, str]]:
    """Read installed instances' indexes, never transcripts or another service API.

    Stopped services and archived chats still own their provider IDs. Removed
    instances with preserved history do not. No registry/configuration writes
    occur during discovery. Bad or unsafe indexes fail closed, not silently open.
    """
    registry = registry or Registry()
    instances = registry.instances()
    if len(instances) > MAX_IMPORT_INSTANCES:
        raise ValueError("Too many local instances to verify import ownership.")
    keys = set()
    remaining = MAX_IMPORT_INDEX_TOTAL_BYTES
    current_state = current_state.resolve()
    for instance in instances:
        check_path(instance.config, registry.home)
        config = read_config(instance)
        configured_state = (config.get("AGENTSDOCK_STATE_DIR")
                            or config.get("AGENTS_SERVER_STATE_DIR")
                            or config.get("ZENITHBOT_AGENT_DIR"))
        state = Path(configured_state) if configured_state else instance.state
        if instance.name != "default" and state != instance.state:
            raise ValueError(f"{instance.name}: unexpected state binding.")
        if not state.is_absolute() or ".." in state.parts:
            raise ValueError(f"{instance.name}: unsafe state binding.")
        if state == current_state:
            continue  # The current process has the authoritative in-memory map.
        check_path(state / "sessions.json", registry.home)
        try:
            data = read_regular(state / "sessions.json", max_bytes=min(MAX_IMPORT_INDEX_BYTES, remaining))
        except FileNotFoundError:
            continue  # A registered/new instance may not have any chats yet.
        remaining -= len(data)
        sessions = json.loads(data)
        if not isinstance(sessions, dict) or any(not isinstance(row, dict) for row in sessions.values()):
            raise ValueError(f"{instance.name}: invalid sessions index.")
        default_backend = config.get("AGENTSDOCK_BACKEND") or config.get("ZENITHBOT_BACKEND") or "claude"
        for session in sessions.values():
            keys.update(provider_session_keys(session, default_backend))
    return keys


@contextmanager
def history_import_lock(*, registry: Registry | None = None):
    """Serialize cooperating local imports until their index writes have landed.

    Separate from service-management locks; nonblocking and OS-released on exit
    or crash. Older servers do not participate, so this is not a provider lock.
    """
    registry = registry or Registry()
    check_path(registry.root, registry.home)
    registry.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with exclusive_lock(registry.root / "history-import.lock"):
        yield
