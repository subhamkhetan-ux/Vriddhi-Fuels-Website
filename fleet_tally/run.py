"""Turn parsed settlement rows into Tally journal vouchers.

Two independent kinds, each from its own Excel (either may be absent):
  * ``fleet`` — XtraPower fleet-card settlements: Dr Fleet Card Posting / Cr Customer
  * ``tds``   — TDS deducted by debtors: Dr TDS RECEIVABLE - DEBTORS / Cr Customer

Each valid row becomes one journal. A customer name not found in the known Tally
customer list is still posted but flagged (catches a typo before it makes a stray
ledger); unparseable rows are held back with their reason. Nothing is dropped.
"""

from __future__ import annotations

from . import generate as G


def _ymd(d) -> str:
    return f"{d.year}{d.month:02d}{d.day:02d}"


def _norm(s: str) -> str:
    return " ".join(str(s).strip().lower().split())


def _one_kind(kind, rows, known, vouchers, entries):
    n_ok = n_warn = n_err = 0
    total = 0.0
    for r in rows:
        base = {
            "kind": kind,
            "index": r.index,
            "date": r.date.strftime("%d-%m-%Y") if r.date else "",
            "customer": r.customer,
            "amount": f"{r.amount:.2f}",
        }
        if r.error:
            n_err += 1
            entries.append({**base, "status": "error", "note": r.error})
            continue
        vouchers.append(G.make_journal(kind, _ymd(r.date), r.customer, r.amount))
        total += r.amount
        if known and _norm(r.customer) not in known:
            n_warn += 1
            entries.append({**base, "status": "unknown-customer",
                            "note": "name not found in the customer list — check the spelling matches Tally"})
        else:
            n_ok += 1
            entries.append({**base, "status": "ok", "note": ""})
    return {"n_rows": len(rows), "n_vouchers": n_ok + n_warn, "n_ok": n_ok,
            "n_unknown": n_warn, "n_error": n_err, "total_amount": round(total, 2)}


def process(fleet_rows=None, tds_rows=None, customers=None):
    """Return ``(vouchers, entries, summary)`` for whichever sheets were given."""
    known = {_norm(c) for c in (customers or [])}
    vouchers, entries = [], []
    fleet = _one_kind("fleet", fleet_rows or [], known, vouchers, entries)
    tds = _one_kind("tds", tds_rows or [], known, vouchers, entries)

    summary = {
        "fleet": fleet,
        "tds": tds,
        "n_vouchers": len(vouchers),
        "n_error": fleet["n_error"] + tds["n_error"],
        "n_unknown": fleet["n_unknown"] + tds["n_unknown"],
        "total_amount": round(fleet["total_amount"] + tds["total_amount"], 2),
        "all_balance": all(G.voucher_balances(v) for v in vouchers),
    }
    return vouchers, entries, summary
