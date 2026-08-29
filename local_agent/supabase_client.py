"""Supabase REST client for the Mac daemon (read log-requests, write results).

Uses only urllib — no extra dependency, same style as ``agent/supabase_sync.py``.
Three jobs:
  - ``fetch_log_requested``  rows the app pressed "Log to Excel" on, not yet
    written (``log_requested=true & logged_at is null``).
  - ``mark_logged``          stamp a row ``logged_at`` + ``exported`` once written.
  - ``event``                append an activity row the /payments feed shows.

Unlike the cloud mirror, the daemon must know when a write genuinely fails (so it
doesn't record a row as logged when Supabase never got the mark). Read/event
failures are surfaced to the caller as exceptions; the daemon loop decides.
"""

from __future__ import annotations

import datetime as dt
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import Config


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


class SupabaseClient:
    def __init__(self, cfg: Config) -> None:
        self.url = cfg.supabase_url
        self.key = cfg.supabase_key

    def _request(
        self,
        method: str,
        path: str,
        body: object | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{path}", data=data, headers=headers, method=method
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else None

    # ---- reads --------------------------------------------------------

    def fetch_log_requested(self, limit: int = 500) -> list[dict]:
        """Rows the user pressed Log on that the daemon hasn't written yet."""
        q = (
            "pay_credit_queue?select=*"
            "&log_requested=eq.true&logged_at=is.null&status=eq.matched"
            "&order=date_serial.asc&limit=" + str(limit)
        )
        rows = self._request("GET", q)
        return rows or []

    # ---- writes -------------------------------------------------------

    def mark_logged(self, entry_id: str) -> None:
        """Stamp one row logged + exported (so it drops off the app's Ready list).

        Raises on failure — the caller must not treat a row as done unless this
        lands. Idempotent: re-stamping an already-logged row is harmless.
        """
        now = _now_iso()
        body = {"logged_at": now, "exported": True, "exported_at": now}
        self._request(
            "PATCH",
            f"pay_credit_queue?entry_id=eq.{urllib.parse.quote(entry_id)}",
            body=body,
            prefer="return=minimal",
        )

    def event(
        self,
        kind: str,
        *,
        entry_id: str | None = None,
        customer: str | None = None,
        amount: float | None = None,
        mode: str | None = None,
        detail: str | None = None,
    ) -> None:
        """Append one activity-feed row. Best-effort: never raise (a lost feed
        entry must not stop the daemon or, worse, a retry that double-posts)."""
        payload = {
            "kind": kind,
            "entry_id": entry_id,
            "customer": customer,
            "amount": amount,
            "mode": mode,
            "detail": detail,
        }
        try:
            self._request("POST", "pay_agent_events", body=payload, prefer="return=minimal")
        except Exception:
            pass
