"""Env-driven configuration for the Mac logging daemon.

Everything the daemon needs comes from environment variables, so the launchd
plist (``com.vriddhi.paymentagent.plist``) is the single place you set it up —
no secrets in the repo. Only ``MASTER_LEDGER_PATH``, ``SUPABASE_URL`` and
``SUPABASE_KEY`` are required; the rest have sane defaults.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_key: str
    ledger_path: str
    sheet_name: str = "Master Paid"
    poll_seconds: int = 20
    heartbeat_seconds: int = 120
    seen_path: str = os.path.expanduser(
        "~/.vriddhi-payment-agent/posted_entry_ids.json"
    )

    @property
    def configured(self) -> bool:
        return bool(
            self.supabase_url
            and self.supabase_key
            and self.ledger_path
            and "PASTE_" not in self.supabase_url
            and "PASTE_" not in self.supabase_key
        )


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def from_env() -> Config:
    """Build a Config from the process environment (the launchd plist)."""
    return Config(
        supabase_url=(os.environ.get("SUPABASE_URL") or "").rstrip("/"),
        supabase_key=os.environ.get("SUPABASE_KEY") or "",
        ledger_path=os.path.expanduser(os.environ.get("MASTER_LEDGER_PATH") or ""),
        sheet_name=os.environ.get("MASTER_PAID_SHEET") or "Master Paid",
        poll_seconds=_int_env("AGENT_POLL_SECONDS", 20),
        heartbeat_seconds=_int_env("AGENT_HEARTBEAT_SECONDS", 120),
        seen_path=os.path.expanduser(
            os.environ.get("AGENT_SEEN_PATH")
            or "~/.vriddhi-payment-agent/posted_entry_ids.json"
        ),
    )
