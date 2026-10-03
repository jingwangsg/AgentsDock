"""Codex model picker rows mirrored from the app-server ``model/list`` result.

Catalog reads never start a process: rows come from a live shared app-server
or from the durable copy an earlier one left behind. Only bounded model ids,
labels, descriptions and reasoning-effort options are retained.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import unicodedata
from typing import Any

from native_model_store import NativeModelStore

MAX_MODELS = 512
MAX_EFFORTS = 16
MAX_DESCRIPTION = 200
CACHE_LIMIT = 4
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\-]{0,255}")
EFFORT_ID = re.compile(r"[a-z][a-z0-9_\-]{0,31}")


class CodexModelCatalogUnavailable(RuntimeError):
    """A model/list result was unusable; never include provider output here."""


def _safe_text(value: Any, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        return ""
    if any(unicodedata.category(char).startswith("C") for char in value):
        return ""
    return value.strip()


def _clean_row(row: Any) -> dict[str, Any] | None:
    """One picker row in the shape stored on disk; None when unusable.

    Applied to freshly parsed rows and again to every persisted row so a
    damaged file cannot reach the UI.
    """
    if not isinstance(row, dict):
        return None
    value = row.get("value")
    if not isinstance(value, str) or not MODEL_ID.fullmatch(value):
        return None
    clean: dict[str, Any] = {"value": value, "label": _safe_text(row.get("label"), 160) or value}
    description = _safe_text(row.get("description"), MAX_DESCRIPTION)
    if description:
        clean["description"] = description
    efforts: list[dict[str, str]] = []
    raw_efforts = row.get("efforts")
    if not isinstance(raw_efforts, list) or len(raw_efforts) > MAX_EFFORTS:
        return None
    for effort in raw_efforts:
        # One odd effort entry must not hide the whole model from the picker.
        effort_value = effort.get("value") if isinstance(effort, dict) else None
        if (not isinstance(effort_value, str) or not EFFORT_ID.fullmatch(effort_value)
                or any(item["value"] == effort_value for item in efforts)):
            continue
        option = {"value": effort_value}
        effort_description = _safe_text(effort.get("description"), MAX_DESCRIPTION)
        if effort_description:
            option["description"] = effort_description
        efforts.append(option)
    clean["efforts"] = efforts
    default_effort = row.get("default_effort")
    if isinstance(default_effort, str) and any(item["value"] == default_effort for item in efforts):
        clean["default_effort"] = default_effort
    if row.get("is_default") is True:
        clean["is_default"] = True
    service_tier = _safe_text(row.get("service_tier"), 64)
    if service_tier:
        clean["service_tier"] = service_tier
    return clean


def parse_model_list(result: Any) -> list[dict[str, Any]]:
    """Rows of a v2 ``model/list`` response in CLI order, hidden rows omitted."""
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, list):
        raise CodexModelCatalogUnavailable("Codex model metadata is unavailable")
    if len(data) > MAX_MODELS:
        raise CodexModelCatalogUnavailable("Codex model metadata exceeds its limit")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for model in data:
        if not isinstance(model, dict):
            continue
        options = model.get("supportedReasoningEfforts")
        row = _clean_row({
            # ``model`` is the slug a thread is started with; ``id`` names the
            # picker preset and only differs for aliases of the same model.
            "value": model.get("model") or model.get("id"),
            "label": model.get("displayName"),
            "description": model.get("description"),
            "efforts": [
                {"value": option.get("reasoningEffort"), "description": option.get("description")}
                for option in (options if isinstance(options, list) else ())
                if isinstance(option, dict)
            ],
            "default_effort": model.get("defaultReasoningEffort"),
            "is_default": model.get("isDefault"),
            "service_tier": model.get("defaultServiceTier"),
        })
        if row is None or row["value"] in seen:
            continue
        seen.add(row["value"])
        if model.get("hidden") is True:
            continue
        rows.append(row)
    if data and not seen:
        raise CodexModelCatalogUnavailable("Codex model metadata is invalid")
    return rows


def _clean_rows(rows: Any) -> list[dict[str, Any]] | None:
    if not isinstance(rows, list) or len(rows) > MAX_MODELS:
        return None
    clean = [_clean_row(row) for row in rows]
    return clean if all(row is not None for row in clean) else None


# The durable copy lets a restarted hub serve the CLI's picker before any
# Codex chat starts a shared app-server. The key changes with the launcher
# build and the signed-in account, so no TTL is needed.
_STORE = NativeModelStore(validate_rows=_clean_rows, limit=CACHE_LIMIT)


def configure_native_models_store(path: Path | None) -> None:
    _STORE.configure(path)


def native_catalog_key(binary_identity: tuple[Any, ...], account_identity: Any) -> str:
    raw = json.dumps([list(binary_identity), account_identity], sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def remember_native_models(rows: list[dict[str, Any]], *, key: str) -> None:
    clean = _clean_rows(rows)
    if clean is None:
        raise CodexModelCatalogUnavailable("Codex model metadata is invalid")
    _STORE.remember(key, clean)


def cached_native_models(key: str) -> list[dict[str, Any]] | None:
    return _STORE.cached(key)


def clear_native_models() -> None:
    _STORE.clear()
