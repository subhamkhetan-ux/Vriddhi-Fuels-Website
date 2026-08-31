"""On-disk state for the monitor: last-known CCMS values and error de-dup.

State lives in a single JSON file next to the config. It survives restarts so
a reboot mid-monitoring doesn't re-baseline every account (which would swallow
the next real change). The structure:

    {
      "accounts": {
        "1005218882": {
          "ccms": "₹1,00,000.00",   # last-known raw CCMS text
          "updated_at": "2026-08-31T10:15:00+05:30",
          "last_error": "chrome-unreachable", # signature of the last alerted error
          "last_error_at": "..."
        }
      }
    }
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any


def load(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    data.setdefault("accounts", {})
    return data


def save(path: str, data: dict[str, Any]) -> None:
    """Atomic write so a crash mid-save can't corrupt the state file."""
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".state-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def account(data: dict[str, Any], customer_id: str) -> dict[str, Any]:
    return data["accounts"].setdefault(str(customer_id), {})


def should_alert_error(
    acct: dict[str, Any],
    signature: str,
    now_epoch: float,
    cooldown_seconds: float,
) -> bool:
    """Rate-limit repeated error alerts.

    A monitor that alerts every 2 minutes while Chrome is closed would bury the
    phone in duplicates. Alert when the error is *new* (a different signature
    than last time) or when ``cooldown_seconds`` has elapsed since the last
    alert for the same signature. A clean cycle should call
    :func:`clear_error` so the next occurrence alerts immediately.
    """
    if acct.get("last_error") != signature:
        return True
    last = acct.get("last_error_at_epoch")
    if last is None:
        return True
    return (now_epoch - last) >= cooldown_seconds


def record_error(acct: dict[str, Any], signature: str, now_epoch: float, iso: str) -> None:
    acct["last_error"] = signature
    acct["last_error_at_epoch"] = now_epoch
    acct["last_error_at"] = iso


def clear_error(acct: dict[str, Any]) -> None:
    acct.pop("last_error", None)
    acct.pop("last_error_at_epoch", None)
    acct.pop("last_error_at", None)
