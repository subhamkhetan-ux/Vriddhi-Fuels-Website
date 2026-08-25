#!/usr/bin/env python3
"""Local half of the Gmail -> Master Paid agent (runs on the Mac).

Pulls the repo-committed queue, lets the user resolve any ``review`` rows once
(each resolution is remembered as an alias so it never asks again), and writes a
``PaymentEntries_YYYY-MM-DD.xlsx`` in Master Paid's exact shape containing every
``matched`` row not yet materialized. Materialized rows are flipped to
``materialized`` and committed, so a re-run — or the Mac being off for a week —
can never produce a duplicate .xlsx entry (spec §6, idempotency layer 2).

Typical use on the Mac:

    git pull
    python3 materialize.py
    # ...resolve any review rows when prompted...
    # -> PaymentEntries_2026-08-25.xlsx  (import into Master Ledger.xlsm)
    git add state/queue.json state/aliases.json && git commit -m "materialize"

Flags:
    --no-input      don't prompt; materialize only already-``matched`` rows,
                    leave ``review`` rows for a later interactive run.
    --dry-run       show what would be exported; write nothing, change nothing.
    --output-dir D  where to write the .xlsx (default: current directory).
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

from agent import state_store
from agent.matcher import alias_key, match_name


def _prompt_review(rows: list[dict], customers: list[str], aliases: dict[str, str]) -> None:
    """Resolve each ``review`` row interactively, writing learned aliases."""
    review_rows = [r for r in rows if r.get("status") == "review"]
    if not review_rows:
        return
    print(f"\n{len(review_rows)} row(s) need review:\n")
    for r in review_rows:
        amount = r.get("amount")
        print("-" * 60)
        print(f"  Bank/mode : {r.get('mode', '')}")
        print(f"  Date      : {r.get('date_str', '?')}  (serial {r.get('date_serial')})")
        print(f"  Amount    : {amount}")
        print(f"  Remitter  : {r.get('raw_payer', '')}")
        if r.get("raw_text") and not r.get("date_serial"):
            print(f"  Raw text  : {r['raw_text'][:200]}")
        cands = r.get("candidates") or []
        if cands:
            print("  Candidates:")
            for i, c in enumerate(cands, start=1):
                print(f"    [{i}] {c}")
        print("  Enter a candidate number, type a canonical name, or")
        print("  's' to skip (leave for later), 'x' to drop this alert.")
        choice = input("  > ").strip()
        if choice.lower() == "s" or choice == "":
            continue
        if choice.lower() == "x":
            r["status"] = "dropped"
            continue
        canonical: str | None = None
        if choice.isdigit() and 1 <= int(choice) <= len(cands):
            canonical = cands[int(choice) - 1]
        else:
            # typed name: accept if it resolves to a real canonical customer
            res = match_name(choice, customers)
            if res.canonical:
                canonical = res.canonical
            elif choice in customers:
                canonical = choice
            else:
                print(f"  '{choice}' is not a known customer — skipping.")
                continue
        r["customer"] = canonical
        r["status"] = "matched"
        r["match_tier"] = "resolved"
        aliases[alias_key(r.get("raw_payer", ""))] = canonical
        print(f"  -> {canonical}  (remembered; will auto-match next time)")


def _flag_batch_dups(rows: list[dict]) -> None:
    """Flag rows sharing date+customer+amount within this batch (spec §9).

    Two real payments can legitimately coincide, so we flag — never drop."""
    seen: dict[tuple, int] = {}
    for r in rows:
        key = (r.get("date_serial"), r.get("customer"), r.get("amount"))
        seen[key] = seen.get(key, 0) + 1
    for r in rows:
        key = (r.get("date_serial"), r.get("customer"), r.get("amount"))
        r.setdefault("flags", {})["dup_in_batch"] = seen[key] > 1


def _print_analysis(batch: list[dict]) -> None:
    total = sum(r["amount"] for r in batch)
    print("\n===== Batch summary =====")
    print(f"  Entries : {len(batch)}")
    print(f"  Total   : {total:,.0f}")

    by_customer: dict[str, float] = {}
    for r in batch:
        by_customer[r["customer"]] = by_customer.get(r["customer"], 0) + r["amount"]
    print("\n  Running total per customer:")
    for name, amt in sorted(by_customer.items(), key=lambda t: -t[1]):
        print(f"    {amt:>14,.0f}  {name}")

    by_mode: dict[str, float] = {}
    for r in batch:
        by_mode[r.get("mode", "")] = by_mode.get(r.get("mode", ""), 0) + r["amount"]
    print("\n  By bank / mode:")
    for mode, amt in sorted(by_mode.items(), key=lambda t: -t[1]):
        print(f"    {amt:>14,.0f}  {mode or '(unspecified)'}")

    dups = [r for r in batch if r.get("flags", {}).get("dup_in_batch")]
    if dups:
        print(f"\n  ⚠ {len(dups)} row(s) share date+customer+amount with another row")
        print("    (kept — two real payments can coincide; verify before import).")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Materialize the payment queue to .xlsx")
    ap.add_argument("--no-input", action="store_true", help="don't prompt for review rows")
    ap.add_argument("--dry-run", action="store_true", help="write nothing, change nothing")
    ap.add_argument("--output-dir", default=".", help="directory for the .xlsx (default: .)")
    args = ap.parse_args(argv)

    rows = state_store.load_queue()
    customers = state_store.load_customers()
    aliases = state_store.load_aliases()

    if not rows:
        print("Queue is empty — nothing to materialize.")
        return 0

    interactive = not args.no_input and sys.stdin.isatty() and not args.dry_run
    if interactive:
        _prompt_review(rows, customers, aliases)
    else:
        pending = [r for r in rows if r.get("status") == "review"]
        if pending:
            print(f"Note: {len(pending)} review row(s) left unresolved "
                  f"({'dry-run' if args.dry_run else 'non-interactive'} mode).")

    # The batch = matched rows not yet materialized (idempotency guard).
    batch = [r for r in rows if r.get("status") == "matched" and not r.get("materialized")]
    if not batch:
        print("No matched, un-materialized rows to export.")
        if not args.dry_run:
            state_store.save_queue(rows)
            state_store.save_aliases(aliases)
        return 0

    _flag_batch_dups(batch)
    _print_analysis(batch)

    today = dt.date.today().isoformat()
    out_path = os.path.join(args.output_dir, f"PaymentEntries_{today}.xlsx")

    if args.dry_run:
        print(f"\n[dry-run] would write {len(batch)} row(s) to {out_path}")
        print("[dry-run] queue and aliases left unchanged.")
        return 0

    from agent.xlsx_writer import write_xlsx  # imported late so --dry-run needs no openpyxl

    os.makedirs(args.output_dir, exist_ok=True)
    write_xlsx(out_path, batch)

    for r in batch:
        r["materialized"] = True
        r["materialized_at"] = dt.datetime.now(dt.timezone.utc).isoformat()

    state_store.save_queue(rows)
    state_store.save_aliases(aliases)

    print(f"\nWrote {len(batch)} entr{'y' if len(batch) == 1 else 'ies'} -> {out_path}")
    print("Import it into Master Ledger.xlsm, then commit state/queue.json + state/aliases.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
