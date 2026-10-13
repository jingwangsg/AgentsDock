"""Carry a chat's canvases, files and side chat over from a sibling install.

A cluster remote moved to a new install directory leaves its old install, and
the server-side state of every chat in it, behind in the same cluster home:
the hub installs each cluster remote there as ``.agentsdock-server-<cluster>``.
Importing a provider transcript on the new install creates a new chat that
starts without the canvases, published files and side chat of the chat that
used the conversation before. When exactly one chat in a sibling install owns
the same provider conversation, this copies that state to the new chat.
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
# One bulk import carries up to 25 chats in a single request, and one upload
# alone may be 25 GiB; larger file sets stay behind with a log line.
MAX_CARRIED_FILE_BYTES = 1024 ** 3


def regular_files(directory: Path) -> list[Path]:
    # A symlink could point anywhere outside the install; copy only plain files.
    if directory.is_symlink() or not directory.is_dir():
        return []
    return [path for path in directory.iterdir() if not path.is_symlink() and path.is_file()]


def carry_over(
    state_dir: Path,
    session_id: str,
    provider_keys: set[tuple[str, str]],
    default_backend: str,
) -> tuple[str | None, dict | None]:
    """Copy the previous chat's canvases and file records to ``session_id``.

    Returns a summary for the server log (None when no sibling install has
    chats) and the previous chat's side chat, which the caller stores through
    the live side-chat store.
    """
    install = state_dir.parent.resolve()
    siblings = sorted(
        path / "state" for path in install.parent.glob(SIBLING_INSTALL_PATTERN)
        if not path.is_symlink() and path.resolve() != install and (path / "state" / "sessions.json").is_file()
    )
    if not siblings:
        return None, None
    owners = [
        (state, old_id)
        for state in siblings
        for old_id, row in json.loads((state / "sessions.json").read_text(encoding="utf-8")).items()
        if isinstance(row, dict) and provider_keys & provider_session_keys(row, default_backend)
    ]
    if len(owners) != 1:
        found = ", ".join(f"{state.parent.name}/{old_id}" for state, old_id in owners)
        return (f"nothing carried: {len(owners)} chats in {len(siblings)} sibling installs "
                f"own this conversation {found}").rstrip(), None
    state, old_id = owners[0]
    notes = []

    canvas_dir = agentsdock_canvas.session_dir(state_dir, session_id)
    canvases = 0
    for path in regular_files(agentsdock_canvas.session_dir(state, old_id)):
        target = canvas_dir / path.name
        if target.exists():
            continue
        canvas_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        if path.name.endswith(agentsdock_canvas.CANVAS_SUFFIX):
            canvases += 1

    files_root = state_dir / "files"
    old_files = state / "files"
    records = []
    for entry in sorted(old_files.iterdir()) if old_files.is_dir() and not old_files.is_symlink() else ():
        if entry.is_symlink() or not entry.is_dir():
            continue
        try:
            meta = json.loads((entry / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        # The download route serves meta["path"], so the file must be the one
        # in this record's own directory to be served from its copy.
        if (
            meta.get("session_id") == old_id
            and (entry / Path(str(meta.get("path") or "")).name).is_file()
            and not (files_root / entry.name).exists()
        ):
            records.append((entry, meta))
    size = sum(path.stat().st_size for entry, _ in records for path in regular_files(entry))
    if size > MAX_CARRIED_FILE_BYTES:
        notes.append(f"{len(records)} files left behind ({size} bytes, limit {MAX_CARRIED_FILE_BYTES})")
        records = []
    for entry, meta in records:
        final = files_root / entry.name
        # Same staging shape as a forked file: a dot-named sibling renamed into place.
        staging = files_root / f".{entry.name}-{uuid.uuid4().hex}"
        staging.mkdir(parents=True)
        try:
            for path in regular_files(entry):
                shutil.copy2(path, staging / path.name)
            meta.update(session_id=session_id, path=str(final / Path(meta["path"]).name))
            (staging / "meta.json").write_text(json.dumps(meta, indent=2))
            staging.rename(final)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    side_chat = None
    database = state / "side_chats.sqlite3"
    if database.is_file():
        try:
            with closing(sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)) as connection:
                rows = connection.execute("SELECT document FROM chats WHERE session=?", (old_id,)).fetchall()
        except sqlite3.Error as exc:
            notes.append(f"side chat unreadable: {exc}")
        else:
            # Opening the side chat panel saves an empty document; a second
            # non-empty one means the server token changed, and either could be current.
            documents = [document for (raw,) in rows if (document := json.loads(raw))["exchanges"]]
            if len(documents) == 1:
                side_chat = documents[0]
            elif documents:
                notes.append(f"side chat left behind: {len(documents)} copies")

    summary = f"from {state.parent}/{old_id}: canvases {canvases}, files {len(records)}"
    return "; ".join([summary, *notes]), side_chat
