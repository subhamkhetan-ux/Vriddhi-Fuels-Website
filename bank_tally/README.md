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
   `classify.py`) → that account's ledger. The account may be named by its full
   number, by bank + last digits (`ICICICA4716`, `ICIC-XXXXXXXX4716`), or not at
   all: the two legs of a transfer between two of our accounts are also paired
   when they carry the **same reference** (ICICI "Tran. Id", an IMPS number, a
   NEFT/RTGS UTR, a net-banking reference), the same amount, and land within two
   days (`run._link_by_txn_id`). An account that has been closed (`CLOSED_AFTER`
   in `classify.py`, e.g. the HDFC OD after 18-Nov-2026) stops making its bank's
   IFSC ambiguous for later dates.
2. **Payments to IOCL** (`INDIAN OIL` / `IOCL`) are skipped, because the IOCL PAD
   tool posts them as ECollection journals. If the IOCL app has processed a PAD,
   each one is checked against the PAD (by its UTR, else by amount and date): a
   payment the PAD covers but does **not** show — money left the bank, IOCL has not
   credited it in SAP — is posted as a Bank Payment to the **Suspense** ledger
   (`run.SUSPENSE_LEDGER`) with the remark `PAID TO IOCL - NOT IN SAP/PAD …`,
   numbered `BPI/<date>/<n>`; the bank and every ledger balance, and the item is
   easy to find. When a later PAD shows it, the bank file stops including it and
   the page reminds you to move or clear the Suspense entry (the IOCL journal now
   covers it); a refund arrives as an ordinary receipt to resolve.
3. **Payment rules** — narration keywords (`CBDT`, `SALARY`,
   credit card, electricity) → fixed ledgers.
4. **Receipt** — the remitter, parsed from the narration and resolved to a
   customer ledger by the proven payments matcher (`agent/matcher.py`) with
   learned aliases; unresolved names go to **review**.
5. Anything else → **review**, where the owner picks the ledger once and it is
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
