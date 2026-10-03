"""One provider's native model picker rows: a bounded LRU in memory plus a durable JSON copy.

Keys are 64-hex fingerprints owned by the provider catalog module. Rows are
re-validated by the provider's validator on every read from disk, so a
damaged file cannot reach the UI. Readers always receive deep copies.
"""
from __future__ import annotations

from collections import OrderedDict
import copy
import json
import os
from pathlib import Path
import threading
import time
from typing import Any, Callable

STORE_MAX_BYTES = 4 * 1024 * 1024


class NativeModelStore:
    def __init__(self, *, validate_rows: Callable[[Any], list | None], limit: int, ttl: float | None = None):
        self._validate_rows = validate_rows
        self._limit = limit
        self._ttl = ttl
        self._lock = threading.Lock()
        self.cache: OrderedDict[str, tuple[float, list]] = OrderedDict()
        self.path: Path | None = None

    def configure(self, path: Path | None) -> None:
        with self._lock:
            self.path = path

    def _read(self) -> OrderedDict[str, list]:
        store: OrderedDict[str, list] = OrderedDict()
        if self.path is None:
            return store
        try:
            with self.path.open("rb") as stream:
                raw = stream.read(STORE_MAX_BYTES + 1)
            payload = json.loads(raw) if len(raw) <= STORE_MAX_BYTES else None
        except (OSError, ValueError):
            payload = None
        if isinstance(payload, dict):
            for key, rows in payload.items():
                clean = self._validate_rows(rows)
                if isinstance(key, str) and len(key) == 64 and clean is not None:
                    store[key] = clean
        return store

    def _write(self, store: OrderedDict[str, list]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(store, stream)
        os.replace(tmp, self.path)

    def remember(self, key: str, rows: list) -> None:
        """Rows must already be validated by the caller."""
        with self._lock:
            self.cache[key] = (time.monotonic(), rows)
            self.cache.move_to_end(key)
            while len(self.cache) > self._limit:
                self.cache.popitem(last=False)
            if self.path is not None:
                store = self._read()
                store[key] = rows
                store.move_to_end(key)
                while len(store) > self._limit:
                    store.popitem(last=False)
                try:
                    self._write(store)
                except OSError:
                    pass  # Best effort: the in-memory copy above already serves this process.

    def cached(self, key: str) -> list | None:
        with self._lock:
            entry = self.cache.get(key)
            if entry is not None and self._ttl is not None and time.monotonic() - entry[0] >= self._ttl:
                del self.cache[key]
                entry = None
            if entry is None:
                rows = self._read().get(key)
                if rows is None:
                    return None
                entry = self.cache[key] = (time.monotonic(), rows)
            return copy.deepcopy(entry[1])

    def clear(self) -> None:
        with self._lock:
            self.cache.clear()
            if self.path is not None:
                try:
                    self.path.unlink()
                except OSError:
                    pass
