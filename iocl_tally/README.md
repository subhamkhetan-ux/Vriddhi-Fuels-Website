# IOCL PAD statement → Tally import XML

Turns the monthly IndianOil **PAD** (Periodic Account of Dealer) statement into
**Tally import XML** — one voucher per statement line against the
`M/s Indian Oil Corporation Limited` ledger — so the IOCL account is entered
automatically instead of by hand.

```
  PAD.pdf ──► iocl_tally.run ──►  IOCL_import.xml   (import into Tally)
             parse · reconcile     IOCL_review.csv   (every line + status)
             · clone templates
```

## Run

```bash
python3 -m iocl_tally.run --pad IOCL_PAD_Statement.pdf --out out/
# out/IOCL_import.xml   -> Tally: Gateway > Import > Vouchers
# out/IOCL_review.csv   -> every PAD line, its mapping, OK / SKIPPED
```

Only dependency is `pymupdf` (already in the repo's `requirements.txt`).

**Before the first real import, test on a BACKUP company:** import one voucher,
confirm it posts against the IOCL ledger, then import the rest.

## How it works

**1. Parse + reconcile (`pad_parser.py`).** The PAD is a fixed IndianOil layout
whose column headers have been stable across statements. Each line becomes a
record with its document type, number, date, and debit / credit / balance. Two
properties make the parse self-checking:

- **Date anchor** — every record has exactly one `dd.mm.yy` date.
- **Balance chain** — `balance = prev + debit − credit` to the paise. The parser
  *locks* each record's money triple by this identity, so a mis-read can't slip
  through; a broken chain is flagged in the review sheet.

The stated closing balance minus the last transactional balance is the
non-transactional **"Open Delivery value in all CCA"** add-on, reported
separately and never posted.

**2. Generate (`xml_generator.py`).** Each category has a **real exported
voucher** in `templates/` (genuine Tally output, carrying every GST / address /
party field). Generating a voucher is surgical:

- strip identity fields (GUID / REMOTEID / VCHKEY / ALTERID / MASTERID /
  VOUCHERKEY / VOUCHERRETAINKEY / VOUCHERNUMBER) so each imports as a fresh
  **Create** and Tally assigns its own auto number;
- set the date fields to the line's date;
- replace only the two ledger amounts, **keeping the template's sign** — which
  reproduces that category's Dr/Cr convention exactly;
- record the PAD/SAP document number in `<REFERENCE>`.

Both ledger amounts come from one magnitude with opposite signs, so every
generated voucher **balances Dr = Cr = 0** by construction.

## The mapping (PAD line → voucher)

| PAD line | Voucher | Counter ledger |
|---|---|---|
| TDS Credit note | Journal | `TDS CREDIT NOTE IOCL 2025-26` |
| Fleet- Card Posting | Journal | `Fleet Card Posting` |
| Customer ECollection | Journal | `HDFC BANK OD A/C - 50200110712542` (C/A `59217010101010` when the line names it) |
| K1 Participation Fee | Journal | `K1 PARTICIPATION FEE` |
| License Fee (SSLF) Recovery | Journal | `License Fee Recovery` |
| Dealer Margin | Journal | `Dealer Margin 2026-27` |
| NFR / NFRBaltrnsfrtoRO | Journal | `NFR Fee IOCL` |
| Interest | Journal | `Interest Paid` |
| Product Supply Invoice (fuel) | Purchase | from the **invoice PDF** — `PURCHASE HSD MS & XG` + HSD/MS VAT + R/off |

## Purchases need the invoice PDF

A fuel Product Supply Invoice line can't be split into base + VAT + rounding from
the PAD alone (freight is baked in and a flat VAT % is off by thousands on
petrol). Each purchase must be joined to its invoice by
**SAP Entry no. == PAD document number** and the base / per-product VAT / ZRND
round-off read straight off the invoice. Until that invoice matching is wired in,
purchase lines are **SKIPPED and flagged** in the review sheet; every other
voucher still generates. (This is the next phase — the invoices are already
available in the iCloud folder the `consign/` app reads.)

## Verified against the real export

Checked against a real July–August 2026 statement and the company's own Tally
export (`Master.xml` / `Transactions.xml` / the IOCL ledger report):

- **350 transactions parsed, reconciles to the paise**; open-delivery add-on
  `34,580.00` accounts for the stated-closing difference exactly.
- Category counts match the export: `TDS 71, Fleet 156, Collection 44 (43 OD +
  1 C/A), K1 2, License 2, Dealer Margin 2, NFR 1, Interest 1`, `Purchase 71`.
- **279 journal vouchers generated, every one balances Dr = Cr = 0**, all
  identity fields stripped; 71 purchases await their invoices.

## Files

| Path | Role |
|---|---|
| `run.py` | CLI orchestrator — `python3 -m iocl_tally.run --pad X.pdf --out DIR` |
| `pad_parser.py` | Parse + classify + reconcile the PAD |
| `xml_generator.py` | Build vouchers by cloning `templates/` + substituting |
| `templates/*.xml` | Real Tally-exported voucher skeletons (one per category) — load-bearing |

Tests: `python3 -m pytest tests/test_iocl_tally.py` (synthetic PAD fixture; the
real statement is private and not committed).
