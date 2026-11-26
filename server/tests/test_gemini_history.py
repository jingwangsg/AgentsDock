"""Native main-session discovery and revision-aware public transcript import."""
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import gemini_history


def test_native_discovery_resume_and_revised_public_text(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_CLI_HOME", str(tmp_path))
    monkeypatch.delenv("SANDBOX", raising=False)
    cwd = tmp_path / "workspace"
    cwd.mkdir()
    project = tmp_path / ".gemini/tmp/project"
    chats = project / "chats"
    chats.mkdir(parents=True)
    (project / ".project_root").write_text(str(cwd))
    native_id = str(uuid4())
    header = {"kind": "main", "projectHash": hashlib.sha256(str(cwd).encode()).hexdigest(),
              "sessionId": native_id}
    path = chats / f"session-2026-10-01T10-15-{native_id[:8]}.jsonl"
    records = [
        header,
        {"id": "init", "type": "user", "content": [{"text": "<session_context>native context</session_context>"}]},
        {"id": "1", "type": "user", "content": [{"text": "Which file?"}]},
        {"id": "2", "type": "gemini", "content": "stale draft", "thoughts": ["private"]},
        {"id": "3", "type": "user", "content": [{"functionResponse": {"response": "private tool result"}}]},
        {"id": "4", "type": "gemini", "content": "removed"},
        {"$rewindTo": "4"},
        {"id": "2", "type": "gemini", "content": "revised"},
        {"$patch": {"updates": [{"id": "2", "content": [{"text": "private", "thought": True}, {"text": "marker.txt"}]}],
                    "removeIds": ["3"], "orderIds": ["1", "2"]}},
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in records))
    (chats / path.name.replace("10-15", "10-16")).symlink_to(path)
    rows = list(gemini_history.local_sessions(cwd=str(cwd), provider_id=native_id))
    assert len(rows) == 1 and not list(gemini_history.local_sessions(cwd=str(tmp_path)))
    assert list(gemini_history.public_messages(rows[0], max_bytes=65536, max_line_bytes=4096, max_records=50)) == [
        ("user", "Which file?"), ("assistant", "marker.txt"),
    ]
    path.write_text(json.dumps({**header, "kind": "subagent"}) + "\n")
    assert not list(gemini_history.local_sessions())


def test_picker_labels_follow_final_public_revision_and_bulk_skips_owned_sessions(tmp_path, monkeypatch):
    import asyncio
    import os

    import agent_server as server

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("GEMINI_CLI_HOME", str(tmp_path))
    monkeypatch.delenv("SANDBOX", raising=False)
    monkeypatch.setattr(server, "CLAUDE_PROJECTS_ROOT", tmp_path / "claude")
    monkeypatch.setattr(server, "CODEX_SESSIONS_ROOT", tmp_path / "codex")
    monkeypatch.setattr(server, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(server, "SESSIONS_FILE", server.STATE_DIR / "sessions.json")
    monkeypatch.setattr(server, "STORE", server.SessionStore())
    project = tmp_path / ".gemini/tmp/workspace"
    chats = project / "chats"
    chats.mkdir(parents=True)
    (project / ".project_root").write_text(str(tmp_path))
    digest = hashlib.sha256(str(tmp_path).encode()).hexdigest()

    def write_chat(index, *rows):
        uid = str(uuid4())
        path = chats / f"session-2026-10-01T10-15-{uid[:8]}.jsonl"
        header = {"kind": "main", "projectHash": digest, "sessionId": uid}
        path.write_text("".join(json.dumps(row) + "\n" for row in (header, *rows)))
        os.utime(path, (index, index))
        return uid, path

    named, _ = write_chat(3, {"id": "u", "type": "user", "content": "Public question"},
                          {"$set": {"summary": "Named\nconversation"}})
    ctx = "private deployment context"
    managed = f"[{gemini_history.CONTEXT_LABEL}; chars={len(ctx)}]\n{ctx}\n[End {gemini_history.CONTEXT_LABEL}]\n\n[Current user prompt]\nVisible question"
    safe, _ = write_chat(2, {"id": "u", "type": "user", "content": managed},
                         {"$set": {"summary": "Model summary of private deployment context"}})
    keeper, path = write_chat(1, {"id": "old", "type": "user", "content": "Discarded question"},
                              {"$set": {"summary": "Discarded summary"}}, {"$rewindTo": "old"},
                              {"id": "internal", "type": "user", "content": "<hook_context>private"},
                              {"id": "u", "type": "user", "content": "Remaining question"})
    labels = {row["provider_session_id"]: row["label"] for row in server.local_session_candidates(3, set(), include_gemini=True)}
    assert labels == {named: "Named conversation", safe: "Visible question", keeper: "Remaining question"}

    with monkeypatch.context() as m:
        m.setattr(gemini_history, "MAX_PICKER_TOTAL_BYTES", path.stat().st_size - 1)
        assert server.local_session_candidates(1, {("gemini", safe), ("gemini", named)}, include_gemini=True)[0]["label"] == f"Gemini chat {keeper[:8]}"

    monkeypatch.setattr(server, "MAX_LOCAL_SESSION_LIST_ITEMS", 1)
    server.STORE.sessions = {uid: {"id": uid, "backend": "gemini", "gemini_session_id": uid} for uid in (named, safe)}
    assert asyncio.run(server.get_local_sessions(limit=1, include_gemini=True))["sessions"][0]["provider_session_id"] == keeper
    req = server.BulkImportSessionsRequest(items=[{"backend": "gemini", "cwd": str(tmp_path), "provider_session_id": keeper}])
    result = asyncio.run(server.bulk_import_sessions_guarded(req, set()))["results"][0]
    assert result["ok"], result
    assert server.STORE.sessions[result["session_id"]]["title"] == "Remaining question"
