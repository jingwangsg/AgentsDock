"""Carry a chat's canvases, files and side chat over from a sibling install.

A cluster remote moved to a new install directory leaves its old install, and
the server-side state of every chat in it, behind in the same cluster home:
the hub installs each cluster remote there as ``.agentsdock-server-<cluster>``.
Importing a provider transcript on the new install creates a new chat that
starts without the canvases, published files and side chat of the earlier
chat that used the conversation. When exactly one chat in a sibling install
owns the same provider conversation, this copies that state to the new chat.
It also gives Resume chat the title, model and effort the conversation had in
a sibling install.
Sibling installs are only read, never changed.
"""
from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import uuid

import agentsdock_canvas
from local_session_ownership import provider_session_keys

SIBLING_INSTALL_PATTERN = ".agentsdock-server*"
# A carried file is a full copy on the same disk, and one upload alone may be
# 25 GiB; a larger file set stays behind with a log note.
MAX_CARRIED_FILE_BYTES = 1024 ** 3


def regular_files(directory: Path) -> list[Path]:
    # A symlink could point anywhere outside the install; copy only plain files.
    if not directory.is_dir():
        return []
    return [path for path in directory.iterdir() if not path.is_symlink() and path.is_file()]


def sibling_states(state_dir: Path) -> list[Path]:
    install = state_dir.parent.resolve()
    return sorted(
        path / "state" for path in install.parent.glob(SIBLING_INSTALL_PATTERN)
        if path.resolve() != install and (path / "state" / "sessions.json").is_file()
    )


def earlier_chat_titles(state_dir: Path, default_backend: str) -> dict[tuple[str, str], str]:
    """The title of the most recently updated sibling-install chat that used each provider conversation.

    The resume list would otherwise name a moved remote's chats by their provider
    titles, not by the names the user knows. A remote moved more than once leaves
    the conversation in several installs; the latest of them has the current name.
    """
    owners: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for old_state in sibling_states(state_dir):
        for row in json.loads((old_state / "sessions.json").read_text(encoding="utf-8")).values():
            title = str(row.get("title") or "").strip()
            if title:
                for key in provider_session_keys(row, default_backend):
                    owners.setdefault(key, []).append((str(row.get("updated_at") or ""), title))
    return {key: max(found)[1] for key, found in owners.items()}


def earlier_chat_runtimes(state_dir: Path, default_backend: str) -> dict[tuple[str, str], tuple[str | None, str | None]]:
    """The model and effort of the most recently updated sibling-install chat that used each provider conversation.

    They are what the user last picked in AgentsDock, so Resume chat continues with them.
    """
    owners: dict[tuple[str, str], list[tuple[str, str | None, str | None]]] = {}
    for old_state in sibling_states(state_dir):
        for row in json.loads((old_state / "sessions.json").read_text(encoding="utf-8")).values():
            backend = str(row.get("backend") or default_backend).lower()
            for key in provider_session_keys(row, default_backend):
                # A parked identity of another backend never ran on this chat's model.
                if key[0] == backend:
                    owners.setdefault(key, []).append((str(row.get("updated_at") or ""), row.get("model"), row.get("effort")))
    # Compare updated_at only: on a tie, a None model cannot be compared with a model name.
    return {key: max(found, key=lambda owner: owner[0])[1:] for key, found in owners.items()}


def carry_over(
    state_dir: Path,
    session_id: str,
    provider_keys: set[tuple[str, str]],
    default_backend: str,
) -> tuple[str | None, dict | None]:
    """Copy the earlier chat's canvases and file records to ``session_id``.

    Returns a summary for the server log (None when no sibling install has
    chats) and the earlier chat's side chat, which the caller stores through
    the live side-chat store.
    """
    siblings = sibling_states(state_dir)
    if not siblings:
        return None, None
    owners = [
        (old_state, old_id)
        for old_state in siblings
        for old_id, row in json.loads((old_state / "sessions.json").read_text(encoding="utf-8")).items()
        if provider_keys & provider_session_keys(row, default_backend)
    ]
    if len(owners) != 1:
        found = ", ".join(f"{old_state.parent.name}/{old_id}" for old_state, old_id in owners)
        summary = f"nothing carried owners={len(owners)} sibling_installs={len(siblings)}"
        return summary + (f" ({found})" if found else ""), None
    old_state, old_id = owners[0]
    notes = []

    canvas_dir = agentsdock_canvas.session_dir(state_dir, session_id)
    canvases = 0
    for path in regular_files(agentsdock_canvas.session_dir(old_state, old_id)):
        target = canvas_dir / path.name
        # The new chat is usable before this runs; never replace what it wrote since.
        if target.exists():
            continue
        canvas_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        if path.name.endswith(agentsdock_canvas.CANVAS_SUFFIX):
            canvases += 1

    files_root = state_dir / "files"
    old_files = old_state / "files"
    entries = list(old_files.iterdir()) if old_files.is_dir() else []
    records = []
    for entry in entries:
        # A dot-named directory is the staging leftover of an interrupted write.
        if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
            continue
        try:
            meta = json.loads((entry / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        # The copy points meta["path"] into the new record directory, so only a
        # record whose file sits in its own directory stays downloadable.
        if (
            meta.get("session_id") == old_id
            and (entry / Path(str(meta.get("path") or "")).name).is_file()
            and not (files_root / entry.name).exists()
        ):
            records.append((entry, meta))
    size = sum(path.stat().st_size for entry, _ in records for path in regular_files(entry))
    if size > MAX_CARRIED_FILE_BYTES:
        notes.append(f"files_left_behind={len(records)} bytes={size} limit={MAX_CARRIED_FILE_BYTES}")
        records = []
    files = 0
    for entry, meta in records:
        target = files_root / entry.name
        # Same staging shape as a forked file: a dot-named sibling renamed into place.
        staging = files_root / f".{entry.name}-{uuid.uuid4().hex}"
        staging.mkdir(parents=True)
        try:
            for path in regular_files(entry):
                shutil.copy2(path, staging / path.name)
            meta.update(session_id=session_id, path=str(target / Path(meta["path"]).name))
            (staging / "meta.json").write_text(json.dumps(meta, indent=2))
            staging.rename(target)
        except OSError as exc:
            shutil.rmtree(staging, ignore_errors=True)
            notes.append(f"file_not_copied={entry.name} ({exc})")
            continue
        files += 1

    side_chat = None
    database = old_state / "side_chats.sqlite3"
    if database.is_file():
        try:
            with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as connection:
                rows = connection.execute("SELECT document FROM chats WHERE session=?", (old_id,)).fetchall()
        except sqlite3.Error as exc:
            notes.append(f"side_chat=unreadable ({exc})")
        else:
            # Opening the side chat panel saves an empty document; a second
            # non-empty one means the server token changed, and either could be current.
            documents = [document for (raw,) in rows if (document := json.loads(raw))["exchanges"]]
            if len(documents) == 1:
                side_chat = documents[0]
            elif documents:
                notes.append(f"side_chat=left_behind copies={len(documents)}")

    summary = f"from={old_state.parent.name}/{old_id} canvases={canvases} files={files}"
    return " ".join([summary, *notes]), side_chat
