# Vriddhi Fuels — Tally Voucher App

A mobile-first, installable PWA that lets a pump employee create sales vouchers
in seconds and export them as XML for import into **Tally Prime**
(Gateway of Tally → Import Data → Vouchers).

> This is a **third, separate app** in this repo — independent of the Master
> Ledger at `/index.html` and the Indent Management PWA at `/app/`. It lives
> entirely under `/tally/`, is fully static (no build step, no backend), and
> stores everything in the browser's localStorage.

## What it does

- **Two independent invoice series**, matching the Tally voucher types:
  - Diesel → `HSD CREDIT`, item `High Speed Diesel`, ledger `SALE (HSD)`,
    plain numbers (`1639 → 1640`)
  - Petrol → `MS CREDIT`, item `Motor Spirit`, ledger `SALE (MS)`,
    prefixed numbers (`MS319 → MS320`)
- **Auto-incrementing invoice numbers** per series (Tally numbering is
  "Automatic (Manual Override)", so the app supplies `<VOUCHERNUMBER>`).
  The number is editable on every voucher; saving a manual override advances
  the counter from that number.
- **Amount ₹ / Litres toggle** — enter either one, the other is derived live
  (customers usually ask for "₹20,000 ka diesel"). Amount-driven vouchers keep
  the round amount and derive a 3-decimal quantity, exactly the way the
  client's real Tally data stores them.
- **Round-off** to the whole rupee (default ON), posting the difference to the
  `R/off` ledger with the correct debit/credit sign; omitted when zero.
- **Searchable party picker** seeded with the 14 ledgers from the client's
  daybook, with inline "add new party" (names must match Tally masters
  exactly — including `&`, case and spacing).
- **Pending queue → single XML download** (`Sales_YYYY-MM-DD_Nvch.xml`).
  Exported vouchers are *marked* exported (greyed out, timestamped) rather
  than deleted, so the file can be re-downloaded if lost; the user clears them
  only after confirming a successful Tally import. This protects against
  accidental double-import.
- **Settings**: company name, per-series last invoice no. + rate (to fix
  counter drift if vouchers were entered directly in Tally), party
  management, and a read-only table of the fixed Tally names.
- **Persistence**: counters, rates, parties and the queue survive restarts
  (localStorage). Installable to the home screen; works offline via a
  service worker.

## XML format

The export follows the structure verified against the client's real DayBook
export (see `TALLY_VOUCHER_APP_REQUIREMENTS.md` handoff doc):

- UTF-8 envelope with `SVCURRENTCOMPANY` = `VRIDDHI FUELS (2026-27)`
  (editable in Settings).
- One `TALLYMESSAGE` per voucher, `ACTION="Create"`, Invoice Voucher View,
  Item Invoice mode.
- Sign convention: party debit = `ISDEEMEDPOSITIVE Yes` + negative amount;
  sales/item credit = `ISDEEMEDPOSITIVE No` + positive amount; round-off
  signed by direction. Party + round-off + item always balance to 0.00.
- Quantities as `" 600.000 LTR"` (3 dp), rates as `100.74/LTR` (2 dp),
  amounts 2 dp. Godown `Main Location`, batch `Primary Batch`.
- No GUID/REMOTEID/VCHKEY (Tally assigns them on import). No tax ledgers
  (petroleum products are outside GST).

## First-run verification (important)

Before daily use: create **one** test voucher, download the XML, import it
into a **backup** Tally company, and compare the resulting voucher against a
manually entered one. Only then go live.

## Hosting

Static — serve the `/tally/` folder anywhere (it deploys along with the rest
of this repo on GitHub Pages). On a phone, open it in Chrome/Safari and
**Add to Home Screen** to install.
