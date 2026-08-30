"""Orchestrate several bank statements into one Tally import.

Given the month's statements (one per account), this:
  * classifies every line (Receipt / Payment / Contra), applying resolved aliases;
  * skips payments to IOCL (the PAD tool already posts those);
  * pairs inter-account transfers — a withdrawal in one account and the matching
    deposit in another are the SAME movement, so they become ONE Contra, not two;
  * generates the vouchers and lists whatever still needs a ledger, for in-app
    review before export.

A statement is ``(bank_ledger, rows)`` where ``rows`` come from
``statement.parse_excel``. ``bank_ledger`` is that account's Tally ledger name.
"""

from __future__ import annotations

from . import classify as C
from . import generate as G


def _ymd(d) -> str:
    return f"{d.year}{d.month:02d}{d.day:02d}"


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
                          match["account"], w["row"].narration))
    leftovers = [x for x in items if id(x) not in used]
    return pairs, leftovers


def process(statements, customers, aliases=None):
    """Return ``(vouchers, review, summary)``.

    ``review`` lists rows whose counter ledger is unresolved (skip/self-transfer
    handled) — the app resolves these before export.
    """
    aliases = aliases or {}
    classified = []          # (account_ledger, row, classification)
    for bank_ledger, rows in statements:
        for r in rows:
            classified.append((bank_ledger, r, C.classify(r, customers, aliases)))

    vouchers, review = [], []
    counts = {"Receipt": 0, "Payment": 0, "Contra": 0}
    skipped_iocl = 0

    # --- Contra: cash deposits post directly; inter-account transfers pair. ----
    contra_items, cash_items = [], []
    for acct, row, cl in classified:
        if cl.vtype == C.CONTRA:
            (cash_items if cl.tier == "cash-deposit" else contra_items).append(
                {"account": acct, "row": row, "cl": cl})
    pairs, leftovers = _pair_contras(contra_items)
    for date, amount, src, dst, narr in pairs:
        vouchers.append(G.make_contra(_ymd(date), amount, src, dst, narr))
        counts["Contra"] += 1
    for it in cash_items:      # Bank Dr / Cash Cr — source is Cash, dest the bank
        r = it["row"]
        vouchers.append(G.make_contra(_ymd(r.date), r.amount, "Cash", it["account"], r.narration))
        counts["Contra"] += 1

    # --- Receipts / Payments / IOCL-skip / leftovers ---
    leftover_ids = {id(x) for x in leftovers}
    for acct, row, cl in classified:
        if cl.vtype == C.CONTRA:
            # A leftover self-transfer we couldn't pair (other leg absent, or
            # ambiguous) — surface for review rather than guess the account.
            for lo in leftovers:
                if lo["row"] is row and lo["account"] == acct:
                    review.append(_review_row(acct, row, cl,
                                              "unpaired transfer — pick the other account"))
                    break
            continue
        if cl.skip:
            skipped_iocl += 1
            continue
        if cl.counter_ledger is None:
            review.append(_review_row(acct, row, cl, "needs a ledger"))
            continue
        ymd = _ymd(row.date)
        if cl.vtype == C.RECEIPT:
            vouchers.append(G.make_receipt(ymd, row.amount, acct, cl.counter_ledger, row.narration))
            counts["Receipt"] += 1
        else:
            vouchers.append(G.make_payment(ymd, row.amount, acct, cl.counter_ledger, row.narration))
            counts["Payment"] += 1

    summary = {
        "n_lines": len(classified),
        "n_vouchers": len(vouchers),
        "counts": counts,
        "skipped_iocl": skipped_iocl,
        "n_review": len(review),
        "reconciles": all(r.reconciles for _, r, _ in classified),
    }
    return vouchers, review, summary


def _review_row(account, row, cl, note):
    return {
        "account": account,
        "date": row.date.strftime("%d-%m-%Y") if row.date else "",
        "type": cl.vtype,
        "amount": f"{row.amount:.2f}",
        "direction": "credit" if row.is_credit else "debit",
        "parsed_name": cl.counterparty_raw,
        "narration": row.narration,
        "note": note,
    }
