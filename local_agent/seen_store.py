"""Mac-local guard of entry_ids already written into Master Paid.

This lives OUTSIDE the git repo (default ``~/.vriddhi-payment-agent/``) on
purpose: it's per-machine state, and committing it would fight the cloud agent's
own ``state/`` commits. It's a belt-and-braces second guard behind Supabase's
``logged_at`` column — if the Supabase mark fails to land after a successful
Excel write, this file still remembers the row so the next loop won't re-post it.

Each ``add`` is flushed immediately and atomically, so a crash never loses a
just-written id or leaves a half-written file.
"""

from __future__ import annotations

import json
import os


class SeenStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._ids: set[str] = set()
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                self._ids = {str(x) for x in data}
        except (FileNotFoundError, json.JSONDecodeError):
            self._ids = set()

    def __contains__(self, entry_id: str) -> bool:
        return entry_id in self._ids

    def add(self, entry_id: str) -> None:
        if entry_id in self._ids:
            return
        self._ids.add(entry_id)
        self._flush()

    def _flush(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(sorted(self._ids), fh)
        os.replace(tmp, self.path)  # atomic
