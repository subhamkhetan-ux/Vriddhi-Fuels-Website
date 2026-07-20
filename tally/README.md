# Vriddhi Fuels — Tally Voucher App

A mobile-first, installable PWA that lets a pump employee create sales vouchers
in seconds and export them as XML for import into **Tally Prime**
(Gateway of Tally → Import Data → Vouchers).

> This is a **third, separate app** in this repo — independent of the Master
> Ledger at `/index.html` and the Indent Management PWA at `/app/`. It lives
> entirely under `/tally/`, is fully static (no build step, no backend), and
> stores everything in the browser's localStorage.

## What it does

- **Voucher entry flow** (customer-first, minimal taps): initiate a voucher
  from the home screen → search & pick the **customer** → optional **vehicle
  number** → **product** (Diesel/Petrol) → **quantity** → **price** (preset
  to today's price, editable) → **amount** (auto-filled as quantity × price,
  editable). Editing the amount derives the quantity instead (the
  "₹20,000 ka diesel" case) — last-edited side wins, live in both directions.
- **Two independent invoice series**, matching the Tally voucher types:
  - Diesel → `HSD CREDIT`, item `High Speed Diesel`, ledger `SALE (HSD)`,
    plain numbers (`1639 → 1640`)
  - Petrol → `MS CREDIT`, item `Motor Spirit`, ledger `SALE (MS)`,
    prefixed numbers (`MS319 → MS320`)
- **Fully automatic invoice numbers** — displayed but **not editable** by the
  employee (Tally numbering is "Automatic (Manual Override)", so the app
  supplies `<VOUCHERNUMBER>`). Numbers already present in the pending queue
  or in old vouchers are skipped automatically. The owner can correct the
  counters in Settings.
- **Import Tally daybook XML** (home screen → "⬆ Import Tally daybook XML"):
  upload a DayBook export (UTF-16 or UTF-8; Tally artifacts like
  `&#4; Not Applicable` are handled) and the app loads all `HSD CREDIT` /
  `MS CREDIT` vouchers into **Old vouchers**, syncs both invoice counters to
  the highest number seen, adds any unknown party ledgers, and picks up the
  latest rates. Cancelled and non-sales vouchers are skipped; re-importing
  the same file is a no-op (duplicates detected per series + number).
- **Old vouchers screen**: searchable by customer / vehicle / invoice number.
  App vouchers moved here after a confirmed Tally import are kept too, so
  the full history stays in one place.
- **Round-off** to the whole rupee (default ON), posting the difference to the
  `R/off` ledger with the correct debit/credit sign; omitted when zero.
- **Vehicle number** is exported as `<BASICSHIPVEHICLENO>` plus a
  `Vehicle: …` narration, and shown in lists/search.
- **Pending queue → single XML download** (`Sales_YYYY-MM-DD_Nvch.xml`).
  Exported vouchers are *marked* exported (greyed out, timestamped) rather
  than deleted, so the file can be re-downloaded if lost; after confirming a
  successful Tally import the user moves them to Old vouchers. This protects
  against accidental double-import.
- **Settings**: company name, per-series last invoice no. + today's price
  (to fix counter drift if vouchers were entered directly in Tally), party
  management, and a read-only table of the fixed Tally names.
- **Persistence**: counters, prices, parties, queue and old vouchers survive
  restarts (localStorage). Installable to the home screen; works offline via
  a service worker.

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
