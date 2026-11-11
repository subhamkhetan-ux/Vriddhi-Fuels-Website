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
import re
import traceback

from . import state_store
from .config import ACCOUNTS, LOOKBACK_DAYS, OWN_TRANSFER
from .matcher import _GENERIC, MatchResult, _canon, match_name
from .normalize import clean_remitter, norm
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


_OWN_SUFFIX = {"prop", "proprietor", "proprietorship", "firm"}


def _info_text(body: str) -> str:
    """The transaction details: the text after ICICI's "Info" / HDFC's
    "Reference Details" label (empty when the alert has neither)."""
    m = re.search(r"(?:\bInfo\b|Reference Details)\s*:?(.*)", body or "", re.I | re.S)
    return m.group(1) if m else ""


# Fields of the transaction details: "INF*INFT*<ref>*DIESEL*ORISSA METALIKS",
# "RTGS-<utr>-<NAME>", "UPI/<rrn>/<purpose>/<NAME>", "NEFT Cr-<ifsc>-<NAME>-…".
_FIELD_SPLIT = re.compile(r"[*/|:\n]+|-")


def _strong(field: str, canonical: str) -> bool:
    """A field names a customer outright: it IS the start of their name — whole
    or cut short by the bank ("ORISSA METALIKS" / "EKDANT LOGIS") — and is long
    enough to mean it. A lone remark word ("COAL", "DIESEL") that merely occurs
    inside one customer's name is not enough."""
    q = _canon(clean_remitter(field) or field)
    if len(q.replace(" ", "")) >= 6 and _canon(canonical).replace(" ", "").startswith(q.replace(" ", "")):
        return True
    # …or every distinctive word of the name is in the field ("TRF FROM ORISSA
    # METALIKS PVT LTD"): at least two words, generic ones (private, limited…) aside
    sig = {w for w in _canon(canonical).split() if w not in _GENERIC and len(w) >= 3}
    return len(sig) >= 2 and sum(map(len, sig)) >= 8 and sig <= set(q.split())


def _scan_info(body: str, customers, aliases) -> tuple[tuple[str, str] | None, list[str]]:
    """Look through every field of the transaction details for the customer —
    for when the payer patterns can't read the alert's wording, or read the
    wrong field. A field counts on strong evidence only: a name resolved before
    in the app (alias), an exact customer name, or the start of one customer's
    name (see _strong). Exactly one customer found -> ``((canonical, field),
    candidates)``; none or several -> ``(None, candidates)`` for review. Our own
    firm's name is skipped (HDFC references name us as the beneficiary)."""
    own = {norm(n) for n in OWN_TRANSFER["names"]}
    hits: dict[str, str] = {}
    cands: list[str] = []
    for f in _FIELD_SPLIT.split(_info_text(body)):
        f = f.strip(" .,;")
        if sum(ch.isalpha() for ch in f) < 3 or norm(f) in own:
            continue
        m = match_name(f, customers, aliases)
        # suggestions only from name-like fields, not codes (BIL, INFT, MMT, NEFT…)
        if " " in f or sum(ch.isalpha() for ch in f) >= 6:
            cands += [c for c in m.candidates if c not in cands]
        if m.status == "matched" and m.canonical and (m.tier in ("alias", "exact") or _strong(f, m.canonical)):
            hits.setdefault(m.canonical, f)
    if len(hits) == 1:
        return next(iter(hits.items())), cands
    return None, cands


def past_amounts(queue: list[dict]) -> dict[float, set[str]]:
    """{amount: customers who paid exactly that before}, from matched queue rows."""
    idx: dict[float, set[str]] = {}
    for r in queue:
        if r.get("status") == "matched" and r.get("customer") and r.get("amount"):
            idx.setdefault(round(float(r["amount"]), 2), set()).add(r["customer"])
    return idx


def _amount_hint(past: dict | None, amount) -> str | None:
    """The one customer who has paid exactly this amount before (a suggestion
    for a review row — never an auto-match), else None."""
    who = (past or {}).get(round(float(amount), 2)) if amount else None
    return next(iter(who)) if who and len(who) == 1 else None


def _own_transfer(body: str, raw_payer: str | None) -> bool:
    """True when a credit is money moved from one of our own accounts (see
    config.OWN_TRANSFER): its remitter is our own firm, or its Info / reference
    names one of our listed accounts. Looks at the remitter and the text after
    the "Info" / "Reference Details" label only — not the account the alert is
    for, nor our name as the beneficiary."""
    if raw_payer:
        words = norm(clean_remitter(raw_payer)).split()
        while words and words[-1] in _OWN_SUFFIX:
            words.pop()
        if " ".join(words) in {norm(n) for n in OWN_TRANSFER["names"]}:
            return True
    info = _info_text(body)
    return any(re.search(rf"X{{2,}}\d{{0,12}}{re.escape(a)}\b", info, re.I)
               for a in OWN_TRANSFER["accounts"])


def _row_from_alert(account_id, profile, alert, customers, aliases, history, past=None) -> dict | None:
    """Build a queue row from one alert (parse + match + flags).

    Returns ``None`` when the profile's gate rejects the email (a debit alert, a
    non-target account, non-credit noise) — the caller then drops it entirely."""
    res = parse(profile, alert.subject, alert.body)
    if res.ignore:
        return None
    if _own_transfer(alert.body, res.raw_payer):
        print(f"  skip {alert.msg_id}: transfer from our own account ({res.raw_payer or 'Info'})")
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

    if not res.ok and (res.amount is None or res.date_serial is None):
        row["status"] = "review"
        row["match_tier"] = "parse_error"
        row["error"] = res.error
        row["raw_text"] = res.raw_text
        return row

    m: MatchResult | None = match_name(res.raw_payer, customers, aliases) if res.ok else None
    if m is None or m.status != "matched":
        # The payer patterns couldn't read this wording, or read a field that
        # isn't a customer: look through every field of the details instead.
        found, cands = _scan_info(alert.body, customers, aliases)
        if found:
            canonical, field = found
            m = MatchResult("matched", "info_scan", canonical=canonical, candidates=[canonical])
            row["raw_payer"] = field
        else:
            base = m.candidates if m else []
            hint = _amount_hint(past, res.amount)
            merged = ([hint] if hint else []) + [c for c in base + cands if c != hint]
            m = MatchResult("review", m.tier if m else "nomatch", candidates=merged[:8])
            if hint:
                row["flags"]["amount_hint"] = hint
            if not res.ok:
                row["error"] = res.error
                row["raw_text"] = res.raw_text
                # a name-like last field, so resolving it in the app teaches an alias
                fields = [f.strip(" .,;") for f in _FIELD_SPLIT.split(_info_text(alert.body))]
                names = [f for f in fields if sum(ch.isalpha() for ch in f) >= 3]
                row["raw_payer"] = names[-1] if names else None
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
            row = _row_from_alert(acc_id, profile, alert, customers, aliases, history,
                                  past_amounts(queue))
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
    # The app's Tally-XML upload keeps the live roster in Supabase; when present
    # it's authoritative, but union it with the committed file so a bad/empty
    # upload can never shrink the matchable set below the seed.
    cloud_customers = supabase_sync.fetch_customers()
    if cloud_customers:
        seen_lower = {c.lower() for c in customers}
        customers = customers + [c for c in cloud_customers if c.lower() not in seen_lower]
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

    # Consignment notes: detect new IOCL invoices for our own TT and queue a
    # note for the app. Best-effort and isolated — never sinks credit ingest.
    from . import consignment
    try:
        cn_created, cn_errors = consignment.run(seen)
        if cn_created:
            print(f"Consignment: queued {cn_created} note(s).")
        errors.extend(cn_errors)
    except Exception as exc:  # last-resort guard
        msg = f"consignment: FAILED: {exc}"
        print(msg)
        traceback.print_exc()
        errors.append(msg)

    # Credit/dues: sum EVERY IOCL invoice (all trucks) into Supabase for the
    # /payments Credit section. Best-effort and isolated.
    from . import credit
    cr_detected = False

    def invoice_detected():
        nonlocal cr_detected
        cr_detected = True

    try:
        cr_created, cr_errors = credit.run(seen, on_detected=invoice_detected)
        if cr_created:
            print(f"Credit: upserted {cr_created} fuel invoice(s).")
        errors.extend(cr_errors)
    except Exception as exc:  # last-resort guard
        msg = f"credit: FAILED: {exc}"
        print(msg)
        traceback.print_exc()
        errors.append(msg)

    # The dependent PAD workflow checks the portal only after invoice mail was
    # processed. Export a boolean, never invoice/customer data or credentials.
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"iocl_invoices_detected={'true' if cr_detected else 'false'}\n")

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

    # Tanker decanting (/decant): every IOCL invoice with its chamber table,
    # written to the decanting app's OWN Supabase project. It runs after all
    # the payments work above is saved and synced, and its problems are only
    # logged — they never fail this run or send the payments alert.
    try:
        from . import decant
        dc_sent, dc_errors = decant.run(seen)
        if dc_sent:
            print(f"Decant: stored {dc_sent} invoice(s).")
        for msg in dc_errors:
            print(f"Decant (not a payments error): {msg}")
        state_store.save_seen(seen)
    except Exception as exc:  # last-resort guard
        print(f"Decant (not a payments error): FAILED: {exc}")
        traceback.print_exc()

    if errors:
        notify("Vriddhi payment agent errors:\n" + "\n".join(errors))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
