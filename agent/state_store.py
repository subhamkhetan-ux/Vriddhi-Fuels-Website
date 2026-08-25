"""Repo-committed state that bridges the cloud and local halves.

All four files live under ``state/`` and are plain JSON so a human can read a
diff and Git can merge them:

- ``queue.json``     the buffer of parsed alerts (the offline buffer itself)
- ``seen.json``      per-account ingest high-water mark (idempotency layer 1)
- ``aliases.json``   learned remitter -> canonical map (auto-match forever)
- ``customers.json`` snapshot of the canonical customer list (matching source)

The queue is the single source of truth for what has been ingested and what has
been materialized; see §6 of the build spec for the two-layer idempotency model.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

# state/ sits next to the agent/ package, at the repo root.
STATE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state")

QUEUE_PATH = os.path.join(STATE_DIR, "queue.json")
SEEN_PATH = os.path.join(STATE_DIR, "seen.json")
ALIASES_PATH = os.path.join(STATE_DIR, "aliases.json")
CUSTOMERS_PATH = os.path.join(STATE_DIR, "customers.json")


def _load(path: str, default: Any) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False, sort_keys=False)
        fh.write("\n")
    os.replace(tmp, path)  # atomic; never leaves a half-written state file


# ---- queue.json : {"rows": [ ...queue rows... ]} ----

def load_queue() -> list[dict]:
    return _load(QUEUE_PATH, {"rows": []}).get("rows", [])


def save_queue(rows: list[dict]) -> None:
    _save(QUEUE_PATH, {"rows": rows})


# ---- seen.json : {account: {"high_water": <ms>, "ids": [msg_id, ...]}} ----

def load_seen() -> dict:
    return _load(SEEN_PATH, {})


def save_seen(seen: dict) -> None:
    _save(SEEN_PATH, seen)


# ---- aliases.json : {alias_key: canonical_name} ----

def load_aliases() -> dict[str, str]:
    return _load(ALIASES_PATH, {})


def save_aliases(aliases: dict[str, str]) -> None:
    _save(ALIASES_PATH, aliases)


# ---- customers.json : [canonical_name, ...] ----

def load_customers() -> list[str]:
    data = _load(CUSTOMERS_PATH, [])
    # tolerate {"customers": [...]} too, in case the export helper wraps it
    if isinstance(data, dict):
        data = data.get("customers", [])
    return [str(c) for c in data if str(c).strip()]


def save_customers(names: list[str]) -> None:
    _save(CUSTOMERS_PATH, sorted(set(names)))


def entry_id(gmail_msg_id: str) -> str:
    """Stable per-alert id — hash of the Gmail message id (spec §6, layer 2)."""
    return hashlib.sha1(str(gmail_msg_id).encode("utf-8")).hexdigest()[:16]
