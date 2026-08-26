"""Cloud half orchestrator — runs on GitHub Actions on a cron.

For each account: read new credit alerts, parse, match the payer, and append a
row to ``state/queue.json`` with status ``matched`` or ``review`` (never
blocks/drops). Advances the per-account high-water mark only past alerts that
were actually queued (spec §6, idempotency layer 1). On any failure it alerts
via Telegram and writes a log artifact — never fails silently (spec §2, §8).

Run:  python -m agent.run   (writes/updates state/*.json; commit them after)
"""

from __future__ import annotations

import datetime as dt
import json
import os
import traceback

from . import state_store
from .config import ACCOUNTS, LOOKBACK_DAYS
from .matcher import MatchResult, match_name
from .parser import parse
from .telegram import notify

# Optional per-customer amount history for the sanity check (spec §9).
# {norm_customer_name: [past_amount, ...]}. Absent -> the check is skipped.
HISTORY_PATH = os.path.join(state_store.STATE_DIR, "history.json")


def _load_history() -> dict[str, list[float]]:
    try:
        with open(HISTORY_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _is_outlier(history: dict, customer: str, amount: float) -> bool:
    from .normalize import norm

    amts = history.get(norm(customer)) if customer else None
    if not amts or len(amts) < 3 or not amount > 0:
        return False
    arr = sorted(amts)
    med = arr[len(arr) // 2]
    if med <= 0:
        return False
    return amount > med * 6 or amount < med / 6


def _row_from_alert(account_id, profile, alert, customers, aliases, history) -> dict | None:
    """Build a queue row from one alert (parse + match + flags).

    Returns ``None`` when the profile's gate rejects the email (a debit alert, a
    non-target account, non-credit noise) — the caller then drops it entirely."""
    res = parse(profile, alert.subject, alert.body)
    if res.ignore:
        return None
    row = {
        "entry_id": state_store.entry_id(alert.msg_id),
        "gmail_msg_id": alert.msg_id,
        "account": account_id,
        "bank": profile.bank,
        "mode": res.mode,
        "date_str": res.date_str,
        "date_serial": res.date_serial,
        "amount": res.amount,
        "raw_payer": res.raw_payer,
        "customer": None,
        "candidates": [],
        "match_tier": None,
        "flags": {"outlier": False},
        "queued_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }

    if not res.ok:
        row["status"] = "review"
        row["match_tier"] = "parse_error"
        row["error"] = res.error
        row["raw_text"] = res.raw_text
        return row

    m: MatchResult = match_name(res.raw_payer, customers, aliases)
    row["candidates"] = m.candidates
    row["match_tier"] = m.tier
    row["customer"] = m.canonical

    outlier = res.amount is not None and _is_outlier(history, m.canonical, res.amount)
    row["flags"]["outlier"] = outlier

    # Confident match, but an order-of-magnitude-off amount -> review (spec §9).
    if m.status == "matched" and not outlier:
        row["status"] = "matched"
    else:
        row["status"] = "review"
    return row


def process_account(account, customers, aliases, history, queue, seen) -> tuple[int, int]:
    """Ingest one mailbox. Returns (queued, reviewed) counts. Raises on hard
    failures (auth, network) so the caller can alert and still commit progress."""
    from .gmail_client import build_service, fetch_alerts

    acc_id = account["id"]
    profile = account["profile"]
    token = os.environ.get(account["token_env"])
    if not token:
        raise RuntimeError(f"missing secret {account['token_env']} for {acc_id}")

    acc_state = seen.setdefault(acc_id, {"high_water": 0, "ids": []})
    after_ms = acc_state.get("high_water") or None
    if after_ms is None:
        # cold start: look back a bounded window instead of the whole mailbox
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LOOKBACK_DAYS)
        after_ms = int(cutoff.timestamp() * 1000)
    seen_ids = set(acc_state.get("ids", []))
    existing_entry_ids = {r["entry_id"] for r in queue}

    service = build_service(token)
    alerts = fetch_alerts(service, profile.gmail_query, after_ms, seen_ids)

    queued = reviewed = 0
    for alert in alerts:  # oldest first
        eid = state_store.entry_id(alert.msg_id)
        # Advance the mark past this alert regardless (we've now handled it),
        # but only append a row if it's a target alert and isn't already queued.
        if eid not in existing_entry_ids:
            row = _row_from_alert(acc_id, profile, alert, customers, aliases, history)
            if row is not None:  # None == gated out (debit / other account); drop
                queue.append(row)
                existing_entry_ids.add(eid)
                queued += 1
                if row["status"] == "review":
                    reviewed += 1
        acc_state["high_water"] = max(acc_state.get("high_water", 0), alert.internal_ms)
        if alert.msg_id not in acc_state["ids"]:
            acc_state["ids"].append(alert.msg_id)

    # keep the id list bounded — the high-water mark is the primary guard
    acc_state["ids"] = acc_state["ids"][-500:]
    return queued, reviewed


def main() -> int:
    from . import supabase_sync

    customers = state_store.load_customers()
    aliases = state_store.load_aliases()
    # Overlay aliases the user resolved in the /payments app (live source).
    aliases.update(supabase_sync.fetch_aliases())
    history = _load_history()
    queue = state_store.load_queue()
    seen = state_store.load_seen()

    # Reconcile app-side completions (exported OR dropped in the /payments app)
    # into the repo's permanent "materialized" flag. This makes them stop being
    # re-synced to Supabase, so they can never reappear or be double-exported —
    # even after Supabase's 7-day history purge removes them there.
    done_ids = supabase_sync.fetch_done_entry_ids()
    if done_ids:
        stamp = dt.datetime.now(dt.timezone.utc).isoformat()
        for r in queue:
            if r["entry_id"] in done_ids and not r.get("materialized"):
                r["materialized"] = True
                r["materialized_at"] = stamp

    if not customers:
        print("WARNING: state/customers.json is empty — everything will be 'review'. "
              "Run export_customers.py on the Mac to populate it.")

    errors: list[str] = []
    totals = {"queued": 0, "reviewed": 0}
    for account in ACCOUNTS:
        try:
            q, r = process_account(account, customers, aliases, history, queue, seen)
            totals["queued"] += q
            totals["reviewed"] += r
            print(f"[{account['id']}] queued {q} ({r} review)")
        except Exception as exc:  # isolate accounts: one failure doesn't sink the other
            msg = f"[{account['id']}] FAILED: {exc}"
            print(msg)
            traceback.print_exc()
            errors.append(msg)

    # Persist whatever progress we made, even on partial failure.
    state_store.save_queue(queue)
    state_store.save_seen(seen)

    # Mirror the live (un-materialized) queue to Supabase for the /payments app.
    # Idempotent insert-if-absent every run: backfills anything missed and never
    # clobbers app edits (a resolved name, an exported flag). Materialized rows
    # (already imported via materialize.py) are excluded. Best-effort.
    live_rows = [r for r in queue if not r.get("materialized")]
    if supabase_sync.enabled():
        sent = supabase_sync.upsert_rows(live_rows)
        print(f"Supabase: enabled; synced {sent}/{len(live_rows)} live row(s).")
    else:
        print("Supabase: not configured (SUPABASE_URL/SUPABASE_KEY unset).")

    print(f"Total queued {totals['queued']} ({totals['reviewed']} review); "
          f"{len(errors)} account error(s).")

    if errors:
        notify("Vriddhi payment agent errors:\n" + "\n".join(errors))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
