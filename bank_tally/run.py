"""Orchestrate several bank statements into one Tally import.

Given the month's statements (one per account), this:
  * classifies every line (Receipt / Payment / Contra), applying resolved aliases;
  * skips payments to IOCL (the PAD tool already posts those);
  * pairs inter-account transfers — a withdrawal in one account and the matching
    deposit in another are the SAME movement, so they become ONE Contra, not two;
  * generates the vouchers and lists whatever still needs a ledger, for in-app
    review before export.

Every generated voucher is also exposed as an *entry* with a stable key, so the
app can drop specific ones from the export (rare/manual transactions the user
prefers to key by hand). Dropped keys are passed back in on the next run.

A statement is ``(bank_ledger, rows)`` where ``rows`` come from
``statement.parse_excel``. ``bank_ledger`` is that account's Tally ledger name.
"""

from __future__ import annotations

import hashlib

from . import classify as C
from . import generate as G


def _ymd(d) -> str:
    return f"{d.year}{d.month:02d}{d.day:02d}"


def entry_key(account, date, amount, narration) -> str:
    """Stable short key identifying a generated voucher by its primary source
    row, so the app can drop/restore it across re-runs."""
    ymd = _ymd(date) if date else ""
    raw = f"{account}|{ymd}|{float(amount):.2f}|{narration or ''}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _pair_contras(items):
    """Pair an inter-account transfer's two legs (a withdrawal in account A and a
    same amount+date deposit in account B) into one source→dest Contra.

    ``items`` is a list of dicts for CONTRA-classified rows (excluding cash
    deposits). Returns ``(pairs, leftovers)`` where each pair is
    ``(date, amount, source_ledger, dest_ledger, narration)``."""
    pairs, used = [], set()
    withdrawals = [x for x in items if not x["row"].is_credit]
    deposits = [x for x in items if x["row"].is_credit]
    for w in withdrawals:
        match = None
        for d in deposits:
            if id(d) in used:
                continue
            if d["account"] == w["account"]:
                continue
            if d["row"].date == w["row"].date and abs(d["row"].amount - w["row"].amount) < 0.01:
                match = d
                break
        if match:
            used.add(id(match))
            used.add(id(w))
            pairs.append((w["row"].date, w["row"].amount, w["account"],
                          match["account"], w["row"].narration, w["row"].index))
    leftovers = [x for x in items if id(x) not in used]
    return pairs, leftovers


# Ledgers that make a resolved row a Contra (an own bank account or Cash) rather
# than a Receipt/Payment.
BANK_LEDGERS = set(C.OWN_ACCOUNTS.values()) | {"Cash"}


def process(statements, customers, aliases=None, dropped=None, resolved=None):
    """Return ``(vouchers, review, summary)``.

    ``vouchers`` is the XML for every generated voucher NOT in ``dropped``.
    ``review`` lists rows whose counter ledger is unresolved (skip/self-transfer
    handled) — the app resolves these before export.
    ``resolved`` maps an entry key -> a ledger the user picked in review for that
    exact transaction; it wins over classification (so force-review and
    unpaired-transfer rows, which ignore aliases, can still be resolved by hand).
    ``summary["entries"]`` lists every generated voucher (dropped or not) with a
    stable key, for the app's drop/restore list.
    """
    aliases = aliases or {}
    dropped = set(dropped or ())
    resolved = dict(resolved or {})
    # Bank priority = order the statements were given, so that on a shared date
    # each bank's lines stay grouped in the order they appear on that statement.
    acct_prio = {led: i for i, (led, _) in enumerate(statements)}
    classified = []          # (account_ledger, row, classification)
    for bank_ledger, rows in statements:
        for r in rows:
            classified.append((bank_ledger, r, C.classify(r, customers, aliases)))

    entries, review = [], []
    skipped_iocl = 0

    def _sort_key(account, date, index):
        # Emit vouchers in the order the lines appear in the bank account: by
        # date, then by which statement, then by the row's position in it.
        return (date.toordinal() if date else 0,
                acct_prio.get(account, 0),
                index if index is not None else 0)

    def add_entry(vtype, xml, account, date, amount, direction, narration,
                  counter, index, srclines=1):
        entries.append({
            "key": entry_key(account, date, amount, narration),
            "type": vtype,
            "account": account,
            "date": date.strftime("%d-%m-%Y") if date else "",
            "amount": f"{float(amount):.2f}",
            "direction": direction,
            "narration": narration or "",
            "counter_ledger": counter,
            "xml": xml,
            "srclines": srclines,       # statement lines this voucher covers (2 = paired transfer)
            "_sort": _sort_key(account, date, index),
        })

    # --- Per-transaction resolutions (a ledger the user picked in review) win
    #     over classification, so force-review / unpaired-transfer rows resolve. -
    handled = set()
    for acct, row, cl in classified:
        k = entry_key(acct, row.date, row.amount, row.narration)
        if k not in resolved:
            continue
        handled.add(id(row))
        led = resolved[k]
        ymd = _ymd(row.date)
        if led in BANK_LEDGERS:                 # transfer -> Contra
            if row.is_credit:                   # money in: source(Cr)=led, dest(Dr)=acct
                xml = G.make_contra(ymd, row.amount, led, acct, row.narration)
                add_entry("Contra", xml, acct, row.date, row.amount, "credit",
                          row.narration, led, row.index)
            else:                               # money out: source(Cr)=acct, dest(Dr)=led
                xml = G.make_contra(ymd, row.amount, acct, led, row.narration)
                add_entry("Contra", xml, acct, row.date, row.amount, "debit",
                          row.narration, led, row.index)
        elif row.is_credit:
            xml = G.make_receipt(ymd, row.amount, acct, led, row.narration)
            add_entry("Receipt", xml, acct, row.date, row.amount, "credit",
                      row.narration, led, row.index)
        else:
            xml = G.make_payment(ymd, row.amount, acct, led, row.narration)
            add_entry("Payment", xml, acct, row.date, row.amount, "debit",
                      row.narration, led, row.index)
    classified = [(a, r, c) for a, r, c in classified if id(r) not in handled]

    # --- Contra: cash deposits post directly; inter-account transfers pair. ----
    contra_items, cash_items = [], []
    for acct, row, cl in classified:
        if cl.vtype == C.CONTRA:
            (cash_items if cl.tier == "cash-deposit" else contra_items).append(
                {"account": acct, "row": row, "cl": cl})
    pairs, leftovers = _pair_contras(contra_items)
    for date, amount, src, dst, narr, w_index in pairs:
        xml = G.make_contra(_ymd(date), amount, src, dst, narr)
        add_entry("Contra", xml, src, date, amount, "debit", narr, dst, w_index,
                  srclines=2)      # one voucher covers both legs (withdrawal + deposit)
    for it in cash_items:      # Bank Dr / Cash Cr — source is Cash, dest the bank
        r = it["row"]
        xml = G.make_contra(_ymd(r.date), r.amount, "Cash", it["account"], r.narration)
        add_entry("Contra", xml, it["account"], r.date, r.amount, "credit",
                  r.narration, "Cash", r.index)

    # An unpaired transfer whose destination is already known (e.g. CGTMS -> OD,
    # or an ICICI-IFSC self-transfer) posts directly; the rest go to review.
    leftover_reviewed = []
    for it in leftovers:
        acct, r, cl = it["account"], it["row"], it["cl"]
        dest = cl.counter_ledger
        if (not r.is_credit) and dest and dest != acct:
            xml = G.make_contra(_ymd(r.date), r.amount, acct, dest, r.narration)
            add_entry("Contra", xml, acct, r.date, r.amount, "debit", r.narration,
                      dest, r.index)
        else:
            leftover_reviewed.append(it)

    # --- Receipts / Payments / IOCL-skip / unresolved leftovers ---
    skipped = []
    for it in leftover_reviewed:
        review.append(_review_row(it["account"], it["row"], it["cl"],
                                  "unpaired transfer — pick the other account"))
    for acct, row, cl in classified:
        if cl.vtype == C.CONTRA:
            continue
        if cl.skip:
            skipped_iocl += 1
            skipped.append({
                "account": acct,
                "date": row.date.strftime("%d-%m-%Y") if row.date else "",
                "amount": f"{row.amount:.2f}",
                "direction": "credit" if row.is_credit else "debit",
                "narration": row.narration or "",
                "reason": cl.skip_reason or "already posted by the IOCL PAD tool",
            })
            continue
        if cl.counter_ledger is None:
            review.append(_review_row(acct, row, cl, "needs a ledger"))
            continue
        ymd = _ymd(row.date)
        if cl.vtype == C.RECEIPT:
            xml = G.make_receipt(ymd, row.amount, acct, cl.counter_ledger, row.narration)
            add_entry("Receipt", xml, acct, row.date, row.amount, "credit",
                      row.narration, cl.counter_ledger, row.index)
        else:
            xml = G.make_payment(ymd, row.amount, acct, cl.counter_ledger, row.narration)
            add_entry("Payment", xml, acct, row.date, row.amount, "debit",
                      row.narration, cl.counter_ledger, row.index)

    # Emit in bank-statement order (date, statement, row position) so the export
    # mirrors the account rather than grouping by voucher type.
    entries.sort(key=lambda e: e["_sort"])

    # Mark drops and collect the export (non-dropped) vouchers + counts.
    vouchers = []
    counts = {"Receipt": 0, "Payment": 0, "Contra": 0}
    for e in entries:
        e["dropped"] = e["key"] in dropped
        if not e["dropped"]:
            vouchers.append(e["xml"])
            counts[e["type"]] += 1

    # A review row the user has dropped is one they'll key by hand — flag it so
    # the app can hide it and stop counting it as "needs a ledger".
    for rr in review:
        rr["dropped"] = rr["key"] in dropped
    n_review = sum(1 for rr in review if not rr["dropped"])
    n_dropped = (sum(1 for e in entries if e["dropped"])
                 + sum(1 for rr in review if rr["dropped"]))

    # Reconciliation: every statement line is either covered by a voucher (a
    # paired transfer covers 2 lines), waiting in review, or an IOCL skip. This
    # must equal the number of statement lines — proof nothing was silently lost.
    lines_in_vouchers = sum(e["srclines"] for e in entries)
    lines_accounted = lines_in_vouchers + len(review) + skipped_iocl
    n_paired = sum(1 for e in entries if e["srclines"] == 2)

    summary = {
        "n_lines": len(classified),
        "n_vouchers": len(vouchers),
        "counts": counts,
        "skipped_iocl": skipped_iocl,
        "n_review": n_review,
        "n_dropped": n_dropped,
        "n_paired": n_paired,
        "lines_accounted": lines_accounted,
        "accounted_ok": lines_accounted == len(classified),
        "reconciles": all(r.reconciles for _, r, _ in classified),
        "entries": [{k: v for k, v in e.items() if k not in ("xml", "_sort")}
                    for e in entries],
        "skipped": skipped,
    }
    return vouchers, review, summary


def _review_row(account, row, cl, note):
    return {
        "key": entry_key(account, row.date, row.amount, row.narration),
        "tier": cl.tier,
        "account": account,
        "date": row.date.strftime("%d-%m-%Y") if row.date else "",
        "type": cl.vtype,
        "amount": f"{row.amount:.2f}",
        "direction": "credit" if row.is_credit else "debit",
        "parsed_name": cl.counterparty_raw,
        "narration": row.narration,
        "note": note,
    }
