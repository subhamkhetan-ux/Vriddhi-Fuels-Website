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

## Run — the app (no terminal)

```bash
iocl_tally/run_app.sh          # starts the local web app, opens the browser
```

Drop the month's **PAD PDF** in, point the settings at your **IOCL invoice
folder** (the same iCloud folder the `consign/` app reads), and click
**Generate**. You get the reconciliation summary, a per-line review (OK /
SKIPPED with reasons), the list of purchases still waiting on an invoice, and a
**download** for `IOCL_import.xml`. Everything runs on your Mac — nothing leaves
the machine.

## Run — the CLI

```bash
python3 -m iocl_tally.run --pad IOCL_PAD_Statement.pdf --out out/ --invoices INVOICE_DIR/
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

## Purchases: matched to the invoice PDF

A fuel Product Supply Invoice line can't be split into base + VAT + rounding from
the PAD alone (freight is baked in and a flat VAT % is off by thousands on
petrol). So each purchase is **joined to its invoice PDF by document number**
(`invoice_parser.py` reads the base / per-product VAT / ZRND round-off straight
off the invoice), and the purchase voucher is built from those figures — mapping
`HSD-BSVI → High Speed Diesel + HSD VAT` and `EBMS → Motor Spirit + MS VAT`, with
`R/off = −ZRND` so the voucher balances. As a guard, a purchase is only generated
when the **invoice total equals the PAD amount**; otherwise (no invoice, an
unreadable invoice, a total mismatch, or a product mix without a template) the
line is **SKIPPED and flagged**, and every other voucher still generates.

Point the app/CLI at the folder where the invoices accumulate (the same iCloud
folder the `consign/` app watches) and drop new invoices in as they arrive.

## Verified against the real export

Checked against a real July–August 2026 statement and the company's own Tally
export (`Master.xml` / `Transactions.xml` / the IOCL ledger report):

- **350 transactions parsed, reconciles to the paise**; open-delivery add-on
  `34,580.00` accounts for the stated-closing difference exactly.
- Category counts match the export: `TDS 71, Fleet 156, Collection 44 (43 OD +
  1 C/A), K1 2, License 2, Dealer Margin 2, NFR 1, Interest 1`, `Purchase 71`.
- **279 journal vouchers generated, every one balances Dr = Cr = 0**, all
  identity fields stripped.
- With 5 sample invoices supplied, **5 purchase vouchers generated — each an
  exact match to the company's own Tally voucher** for that invoice (per-product
  base + VAT, party total, R/off, rate, quantity), including the 2-product
  Diesel + Petrol edge case; the remaining 66 purchases are flagged as awaiting
  their invoice.

## Files

| Path | Role |
|---|---|
| `server.py` / `index.html` | The local web app (`iocl_tally/run_app.sh`) |
| `run.py` | CLI orchestrator — `python3 -m iocl_tally.run --pad X.pdf --out DIR` |
| `pad_parser.py` | Parse + classify + reconcile the PAD |
| `invoice_parser.py` | Read base / per-product VAT / round-off off an invoice |
| `xml_generator.py` | Build vouchers by cloning `templates/` + substituting |
| `templates/*.xml` | Real Tally-exported voucher skeletons (one per category) |

Tests: `python3 -m pytest tests/test_iocl_tally.py` (synthetic PAD + invoice
fixtures; the real statement and invoices are private and not committed).
