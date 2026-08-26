"""Best-effort Supabase mirror of the queue + aliases (for the /payments app).

The repo-committed ``state/*.json`` files remain the agent's source of truth and
idempotency guard. When ``SUPABASE_URL`` + ``SUPABASE_KEY`` are set, the agent
ALSO:
  - reads learned aliases the user saved in the app (so names resolved on the
    phone auto-match on the next ingest), and
  - upserts newly-queued rows into ``pay_credit_queue`` for the app to show.

Everything here is best-effort: any failure is swallowed so a Supabase outage
never breaks ingest (the repo state still updates). Uses only urllib — no extra
dependency.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

URL_ENV = "SUPABASE_URL"
KEY_ENV = "SUPABASE_KEY"


def _config() -> tuple[str, str] | None:
    url = (os.environ.get(URL_ENV) or "").rstrip("/")
    key = os.environ.get(KEY_ENV) or ""
    if not url or not key or "PASTE_" in url or "PASTE_" in key:
        return None
    return url, key


def enabled() -> bool:
    return _config() is not None


def _request(method: str, path: str, key: str, url: str,
             body: object | None = None, prefer: str | None = None) -> object:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{url}/rest/v1/{path}", data=data,
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else None


def fetch_aliases() -> dict[str, str]:
    """Return {alias_key: canonical} saved from the app (empty on any error)."""
    cfg = _config()
    if not cfg:
        return {}
    url, key = cfg
    try:
        rows = _request("GET", "pay_credit_aliases?select=alias_key,canonical",
                        key, url) or []
        return {r["alias_key"]: r["canonical"] for r in rows if r.get("alias_key")}
    except Exception:
        return {}


def fetch_done_entry_ids() -> set[str]:
    """Return entry_ids the user has finished with in the app (exported or
    dropped — both carry ``exported=true``). Empty on any error."""
    cfg = _config()
    if not cfg:
        return set()
    url, key = cfg
    try:
        rows = _request("GET", "pay_credit_queue?select=entry_id&exported=eq.true",
                        key, url) or []
        return {r["entry_id"] for r in rows if r.get("entry_id")}
    except Exception:
        return set()


def _row_payload(row: dict) -> dict:
    """Map an internal queue row to the Supabase column shape."""
    return {
        "entry_id": row["entry_id"],
        "gmail_msg_id": row.get("gmail_msg_id"),
        "account": row.get("account"),
        "bank": row.get("bank"),
        "mode": row.get("mode"),
        "date_str": row.get("date_str"),
        "date_serial": row.get("date_serial"),
        "amount": row.get("amount"),
        "raw_payer": row.get("raw_payer"),
        "customer": row.get("customer"),
        "candidates": row.get("candidates", []),
        "match_tier": row.get("match_tier"),
        "status": row.get("status", "review"),
        "flags": row.get("flags", {}),
        "raw_text": row.get("raw_text"),
        "queued_at": row.get("queued_at"),
    }


def claim_consignment(note: dict) -> dict | None:
    """Idempotently claim a consignment note for one invoice via the DB RPC.

    Returns the note row (with its assigned ``serial_str``) or ``None`` if
    Supabase isn't configured / the call fails. Safe to call repeatedly for the
    same invoice — the RPC returns the existing note without spending a serial.
    """
    cfg = _config()
    if not cfg:
        return None
    url, key = cfg
    body = {
        "p_id": note["id"],
        "p_gmail_msg_id": note.get("gmail_msg_id"),
        "p_invoice_no": note.get("invoice_no"),
        "p_invoice_date": note.get("invoice_date"),
        "p_tt_no": note.get("tt_no"),
        "p_product": note.get("product"),
        "p_column_key": note.get("column_key"),
        "p_qty": note.get("qty"),
        "p_value": note.get("value"),
    }
    try:
        # PostgREST returns the function's row result; ask for the JSON object.
        res = _request("POST", "rpc/pay_claim_consignment", key, url, body=body)
        if isinstance(res, list):
            return res[0] if res else None
        return res
    except Exception:
        return None


def upsert_rows(rows: list[dict]) -> int:
    """Insert new queue rows; ignore ones already present (so app edits — a
    resolved name, an exported flag — are never clobbered). Returns count sent.
    Best-effort: returns 0 on any error."""
    cfg = _config()
    if not cfg or not rows:
        return 0
    url, key = cfg
    payload = [_row_payload(r) for r in rows]
    try:
        # on_conflict=entry_id + ignore-duplicates => insert-if-absent only.
        _request("POST", "pay_credit_queue?on_conflict=entry_id", key, url,
                 body=payload,
                 prefer="resolution=ignore-duplicates,return=minimal")
        return len(payload)
    except Exception:
        return 0
