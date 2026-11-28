"""Read-only Cursor CLI discovery (verified with 2026.09.18).

Only the CLI's metadata and plaintext user-facing JSONL export are read. Never
open conversation blobs, decrypt data, invoke the CLI, or migrate native stores.
Cursor IDE and cloud histories are different formats and are not advertised.

The one write is ``copy_session`` (verified with 2026.11.22): a copy of a
session's store under another id, whose blob pages SQLite copies undecoded.
The session's own store is only read.

A chat's rewind (verified with 2026.11.22) is the one reader of conversation
blobs, and only of that chat's own session: ``prompt_roots`` reads its root
blobs and the messages the latest root lists, to place a turn whose root was
not recorded. ``latest_root_blob_id`` reads the store's metadata only, and
``has_blob`` looks up one blob id.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import unicodedata
from typing import Iterator

MAX_METADATA_BYTES = 64 * 1024
MAX_SCAN_ENTRIES = 10_000
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}")
# A root blob starts with one entry per message of the conversation, in order: the bytes 0a 20,
# then the 32-byte id of the message's blob.
ROOT_ENTRIES = re.compile(rb"(?:\x0a\x20.{32})*", re.DOTALL)


def native_title(value: object) -> str | None:
    """Bound display metadata before choosing between native naming sources.

    Cursor's default is New Agent. Other names (including a user's literal
    'New chat' or 'Untitled') are not generic AgentsDock placeholders here.
    """
    if not isinstance(value, str) or len(value) > 4096:
        return None
    clean = " ".join("".join(
        character for character in value
        if character.isspace()
        or unicodedata.category(character) not in {"Cc", "Cf", "Cs"}
    ).split())[:120]
    return clean if clean and clean.casefold() != "new agent" else None


def config_root(cwd: str | None = None) -> Path:
    config = os.environ.get("CURSOR_CONFIG_DIR", "").strip()
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    root = Path(config) if config else Path(xdg) / "cursor" if xdg else Path.home() / ".cursor"
    return Path(os.path.abspath(root if root.is_absolute() else Path(cwd or os.getcwd()) / root))


def data_root(cwd: str) -> Path:
    data = os.environ.get("CURSOR_DATA_DIR", "").strip()
    root = Path(data) if data else Path.home() / ".cursor"
    return Path(os.path.abspath(root if root.is_absolute() else Path(cwd) / root))


def project_slug(cwd: str) -> str:
    # Cursor utils/dist/workspace-paths.js; do not guess a cwd by reversing it.
    return re.sub(r"-+", "-", re.sub(r"[^a-zA-Z0-9]", "-", cwd)).strip("-")


def safe_path(path: Path, root: Path) -> bool:
    """Do not follow symlinks beneath the configured native root."""
    try:
        relative = path.relative_to(root)
        if ".." in relative.parts or root.is_symlink():
            return False
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                return False
        return True
    except (OSError, ValueError):
        return False


def read_json(path: Path, root: Path) -> dict | None:
    if not safe_path(path, root):
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return None
            raw = stream.read(MAX_METADATA_BYTES + 1)
        if len(raw) > MAX_METADATA_BYTES:
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, RecursionError):
        return None


def store_metadata(database: Path, root: Path) -> dict | None:
    if not safe_path(database, root) or not database.is_file():
        return None
    try:
        connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.05)
        try:
            connection.execute("PRAGMA query_only = ON")
            connection.execute("PRAGMA trusted_schema = OFF")
            connection.set_progress_handler(lambda: 1, 10000)
            row = connection.execute(
                "SELECT substr(value, 1, 32769) FROM meta WHERE key = '0' AND typeof(value) = 'text'",
            ).fetchone()
        finally:
            connection.close()
        if not row or len(row[0]) > 32768:
            return None
        value = json.loads(bytes.fromhex(row[0]))
        if not isinstance(value, dict):
            return None
        # Do not return encryption keys, root blobs, or unrelated metadata.
        return {
            "id": value.get("agentId"), "title": value.get("name"),
            "is_subagent": value.get("subagentInfo") is not None,
        }
    except (OSError, ValueError, RecursionError, sqlite3.Error):
        return None


@dataclass(frozen=True)
class LocalSession:
    provider_id: str
    cwd: str
    title: str | None
    updated_at: float
    transcript: Path


def read_session(directory: Path, root: Path, *, expected_cwd: str | None = None) -> LocalSession | None:
    provider_id = directory.name
    if not IDENTIFIER.fullmatch(provider_id) or not safe_path(directory, root):
        return None
    sidecar = read_json(directory / "meta.json", root)
    if not sidecar or type(sidecar.get("schemaVersion")) is not int or sidecar["schemaVersion"] != 1:
        return None
    if sidecar.get("hasConversation") is not True or sidecar.get("isSubagent") is True:
        return None
    cwd = sidecar.get("cwd")
    if (not isinstance(cwd, str) or not cwd or len(cwd) > 16384
            or any(ord(char) < 32 or ord(char) == 127 for char in cwd)
            or not Path(cwd).is_absolute() or os.path.normpath(cwd) != cwd):
        return None
    if expected_cwd is not None and cwd != expected_cwd:
        return None
    try:
        bucket = hashlib.md5(cwd.encode(), usedforsecurity=False).hexdigest()
        usable = Path(cwd).is_dir() and config_root(cwd).absolute() == root.absolute()
    except (OSError, ValueError):
        return None
    if bucket != directory.parent.name:
        return None
    # CLI resume is workspace-bound. Do not silently substitute DEFAULT_CWD
    # for a vanished temporary project, which would create an unrelated chat.
    if not usable:
        return None
    metadata = store_metadata(directory / "store.db", root)
    if not metadata or metadata["id"] != provider_id or metadata["is_subagent"]:
        return None
    # Native configuration and transcript data have independent roots.
    data = data_root(cwd)
    projects = data / "projects"
    slug = project_slug(cwd)
    if not slug:
        return None
    transcript = projects / slug / "agent-transcripts" / provider_id / f"{provider_id}.jsonl"
    if not safe_path(transcript, data):
        return None
    try:
        info = transcript.stat()
        if not stat.S_ISREG(info.st_mode):
            return None
    except OSError:
        return None
    updated = sidecar.get("updatedAtMs")
    timestamp = updated / 1000 if type(updated) is int and 0 < updated < 253402300800000 else info.st_mtime
    title = native_title(metadata["title"]) or native_title(sidecar.get("title"))
    return LocalSession(provider_id, cwd, title, timestamp, transcript)


def session_directory(provider_id: str, cwd: str) -> tuple[Path, dict]:
    """A session's directory and its sidecar, which a copy of the session needs too."""
    root = config_root(cwd)
    source = next((root / "chats").glob(f"*/{provider_id}"), None) if IDENTIFIER.fullmatch(provider_id) else None
    sidecar = read_json(source / "meta.json", root) if source is not None else None
    if not sidecar or not isinstance(sidecar.get("cwd"), str) or not safe_path(source / "store.db", root):
        raise FileNotFoundError("Cursor session store")
    return source, sidecar


def session_paths(directory: Path, sidecar: dict, cwd: str) -> list[Path]:
    """Every path a session leaves on disk, its directory first; the arguments are ``session_directory``'s."""
    return [directory, data_root(cwd) / "projects" / project_slug(sidecar["cwd"]) / "agent-transcripts" / directory.name]


def copy_session(provider_id: str, copy_id: str, cwd: str, root_blob_id: str | None = None) -> list[Path]:
    """Copy a session's store under another id, for the CLI to resume as a session of its own.

    SQLite's backup reads a consistent store while the session's own CLI writes it. Returns every path
    the copy and its resumed run leave on disk, the copy's directory first. With ``root_blob_id`` the
    copy resumes from that earlier root of the conversation instead of its latest one.
    """
    source, sidecar = session_directory(provider_id, cwd)
    copy = source.with_name(copy_id)
    copy.mkdir(mode=0o700)
    try:
        original = sqlite3.connect((source / "store.db").resolve().as_uri() + "?mode=ro", uri=True)
        target = sqlite3.connect(copy / "store.db")
        try:
            original.backup(target)
            metadata = json.loads(bytes.fromhex(target.execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))
            metadata["agentId"] = copy_id
            if root_blob_id is not None:
                # load-bearing: the CLI resumes a root the store lacks as an empty conversation, without an error.
                if target.execute("SELECT 1 FROM blobs WHERE id = ?", (root_blob_id,)).fetchone() is None:
                    raise FileNotFoundError("Cursor conversation root")
                metadata["latestRootBlobId"] = root_blob_id
            with target:
                target.execute("UPDATE meta SET value = ? WHERE key = '0'", (json.dumps(metadata).encode().hex(),))
        finally:
            original.close()
            target.close()
        shutil.copyfile(source / "meta.json", copy / "meta.json")
    except BaseException:
        shutil.rmtree(copy, ignore_errors=True)
        raise
    return session_paths(copy, sidecar, cwd)


def open_store(provider_id: str, cwd: str) -> sqlite3.Connection:
    """A session's store, read-only, opened as ``store_metadata`` opens one, without its step limit:
    ``prompt_roots`` reads every root of the store."""
    source, _sidecar = session_directory(provider_id, cwd)
    store = sqlite3.connect((source / "store.db").resolve().as_uri() + "?mode=ro", uri=True, timeout=0.05)
    store.execute("PRAGMA query_only = ON")
    store.execute("PRAGMA trusted_schema = OFF")
    return store


def stored_root_blob_id(store: sqlite3.Connection) -> str:
    """The id of the root blob the store's metadata names."""
    root_blob_id = json.loads(bytes.fromhex(store.execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))["latestRootBlobId"]
    # load-bearing: a run records what this returns, and "" in that record means the chat had no conversation.
    if not isinstance(root_blob_id, str) or not root_blob_id:
        raise ValueError("Cursor conversation root")
    return root_blob_id


def latest_root_blob_id(provider_id: str, cwd: str) -> str:
    """The id of the root blob a resume of the session continues from."""
    with closing(open_store(provider_id, cwd)) as store:
        return stored_root_blob_id(store)


def new_session_root_blob_id(provider_id: str, cwd: str) -> str:
    """``latest_root_blob_id`` for a session that began with the CLI start that just ended, "" when that
    start stored nothing: the session has no directory, no store in it, or a store with an empty root.
    Any other store that cannot be read raises: what it holds is not known."""
    source = next((config_root(cwd) / "chats").glob(f"*/{provider_id}"), None) if IDENTIFIER.fullmatch(provider_id) else None
    if source is None or not os.path.lexists(source / "store.db"):
        return ""
    with closing(open_store(provider_id, cwd)) as store:
        if json.loads(bytes.fromhex(store.execute("SELECT value FROM meta WHERE key = '0'").fetchone()[0]))["latestRootBlobId"] == "":
            return ""
        return stored_root_blob_id(store)


def has_blob(provider_id: str, cwd: str, blob_id: str) -> bool:
    """Whether a session's store holds a blob with this id."""
    with closing(open_store(provider_id, cwd)) as store:
        return store.execute("SELECT 1 FROM blobs WHERE id = ?", (blob_id,)).fetchone() is not None


def prompt_roots(provider_id: str, cwd: str) -> list[tuple[str, str | None]]:
    """A session's user prompts, oldest first, each with the root of the conversation as it stood before it.

    The store keeps every earlier root, so the conversation before a prompt is the root whose entries
    are exactly the entries before that prompt's: None when the store holds no such root or more than
    one. The prompt a conversation begins with has "": no turn is before it.
    """
    with closing(open_store(provider_id, cwd)) as store:
        latest = store.execute("SELECT data FROM blobs WHERE id = ?", (stored_root_blob_id(store),)).fetchone()[0]
        before: dict[int, list[str]] = {}
        for blob_id, data in store.execute("SELECT id, data FROM blobs WHERE substr(data, 1, 2) = x'0a20'"):
            size = ROOT_ENTRIES.match(data).end()
            if data[:size] == latest[:size]:
                before.setdefault(size, []).append(blob_id)
        prompts = []
        for offset in range(0, ROOT_ENTRIES.match(latest).end(), 34):
            # A message that is not readable JSON raises: with a message unread, no prompt can be called the only one.
            message = json.loads(store.execute(
                "SELECT data FROM blobs WHERE id = ?", (latest[offset + 2:offset + 34].hex(),),
            ).fetchone()[0])
            if message["role"] != "user" or not isinstance(message["content"], list):
                continue
            # The CLI wraps a prompt like this; its other user messages (workspace context, tool results) are not prompts.
            query = re.fullmatch(
                r"(?:<timestamp>[^<>\r\n]{1,128}</timestamp>\s*)?<user_query>\n(.*)\n</user_query>\s*",
                "".join(block["text"] for block in message["content"] if block["type"] == "text"), flags=re.DOTALL,
            )
            if query is not None:
                roots = before.get(offset, [])
                # A conversation opens with a system message and a context message; a store without the
                # context message has its second prompt at this place.
                prompts.append((query[1], "" if offset == 2 * 34 and not prompts else roots[0] if len(roots) == 1 else None))
    return prompts


def find_session(provider_id: str, cwd: str) -> LocalSession | None:
    if not isinstance(provider_id, str) or not IDENTIFIER.fullmatch(provider_id) or not isinstance(cwd, str):
        return None
    root = config_root(cwd)
    try:
        bucket = hashlib.md5(cwd.encode(), usedforsecurity=False).hexdigest()
    except ValueError:
        return None
    return read_session(root / "chats" / bucket / provider_id, root, expected_cwd=cwd)


def local_sessions() -> Iterator[LocalSession]:
    root = config_root()
    chats = root / "chats"
    if not safe_path(chats, root):
        return
    remaining = MAX_SCAN_ENTRIES
    try:
        with os.scandir(chats) as buckets:
            for bucket in buckets:
                remaining -= 1
                if remaining < 0:
                    return
                if not re.fullmatch(r"[0-9a-f]{32}", bucket.name) or not bucket.is_dir(follow_symlinks=False):
                    continue
                try:
                    with os.scandir(bucket.path) as directories:
                        for entry in directories:
                            remaining -= 1
                            if remaining < 0:
                                return
                            if not entry.is_dir(follow_symlinks=False):
                                continue
                            session = read_session(Path(entry.path), root)
                            if session is not None:
                                yield session
                except OSError:
                    continue
    except OSError:
        return
