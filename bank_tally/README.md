# Bank statements → Tally (work in progress)

Turns bank statements (Excel now; PDF later) into Tally vouchers — a **Receipt**
for money in, a **Payment** for money out, and a **Contra** for transfers between
the firm's own accounts — one voucher per statement line.

```
  statement.xlsx ──► statement.parse ──► classify ──► (next) generate vouchers
                     rows + reconcile    voucher type + counter ledger
```

## Status

| Piece | State |
|---|---|
| Excel parser + balance-chain reconciliation | ✅ works for HDFC (`.xls`) and ICICI (`.xlsx`) |
| Classify Receipt / Payment / Contra | ✅ |
| Counter-ledger: Contra (own accounts), IOCL, keyword rules | ✅ |
| Counter-ledger: customer matching (reuses the payments matcher + aliases) | ✅ HDFC |
| **ICICI narration profile** (`/`-separated: `INF/NEFT`, `MMT/IMPS`, `FT-EZY QR`) | ⏳ next |
| Voucher XML generation (clone real Receipt/Payment/Contra templates) | ⏳ |
| Review screen + alias learning + local app | ⏳ |

Verified on real statements (private, not committed): HDFC C/A 336 rows, HDFC OD
249 rows, ICICI 230 rows — **all reconcile to the paise**. On HDFC C/A ~79% of
lines auto-map on the first run, with the review items collapsing to ~20 distinct
counterparties that become aliases.

## How the counter-ledger is decided (per the owner's choice)

1. **Contra** — a transfer naming another own account (`OWN_ACCOUNTS` in
   `classify.py`) → that account's ledger.
2. **Payment rules** — narration keywords (`INDIAN OIL`, `CBDT`, `SALARY`,
   credit card, electricity) → fixed ledgers.
3. **Receipt** — the remitter, parsed from the narration and resolved to a
   customer ledger by the proven payments matcher (`agent/matcher.py`) with
   learned aliases; unresolved names go to **review**.
4. Anything else → **review**, where the owner picks the ledger once and it is
   remembered as an alias.

Narration parsing is **bank-specific** — the format differs sharply between HDFC
(`-` separated) and ICICI (`/` separated), so each bank gets its own extractor.

## Files

| Path | Role |
|---|---|
| `statement.py` | Parse a bank Excel into rows; reconcile the running balance |
| `classify.py` | Row → voucher type + counter ledger (matcher + rules) |

Tests: `python3 -m pytest tests/test_bank_tally.py` (synthetic fixtures; real
statements are private).
