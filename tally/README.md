# Vriddhi Fuels — Tally Voucher App

A mobile-first, installable PWA that lets a pump employee create sales vouchers
in seconds and export them as XML for import into **Tally Prime**
(Gateway of Tally → Import Data → Vouchers).

> This is a **third, separate app** in this repo — independent of the Master
> Ledger at `/index.html` and the Indent Management PWA at `/app/`. It lives
> entirely under `/tally/`, is fully static, and has two modes:
>
> - **Multi-employee (cloud) mode** — the intended production setup. A
>   dedicated Supabase project (separate from the indent app's) holds one
>   shared live dataset; every employee signs in with a username+password,
>   sees the same pending vouchers/customers/prices instantly (realtime),
>   and invoice numbers are allocated **on the server inside a lock**, so
>   two employees saving at the same moment can never get the same number.
> - **Single-device (local) mode** — if `config.js` is left with its
>   placeholders, the app runs exactly as before: no login, everything in
>   that browser's localStorage. Fine for one shared counter device.

## Multi-employee setup (one time)

1. Create a **new** Supabase project (free tier) — do NOT reuse the indent
   app's project.
2. In its **SQL Editor**, run [`../supabase/tally-schema.sql`](../supabase/tally-schema.sql)
   (safe to re-run; seeds series counters/prices verified from the daybook).
3. **Authentication → Users → Add user** for each employee:
   email `<username>@vriddhi.local` (e.g. `ramesh@vriddhi.local`), a 6+ char
   password, tick *Auto Confirm User*. Employees sign in with just the
   username + password.
4. Paste the project's **URL** and **anon/publishable key**
   (Project Settings → API) into [`config.js`](./config.js) and deploy.
5. On each phone: open `/tally/`, sign in, Add to Home Screen.

Every signed-in employee has equal rights (create/edit/export/import), per
the owner's decision. All writes go through server-side functions with
sign-in checks + Row Level Security; the anon key alone can read/write
nothing.

## What it does

- **Voucher entry flow** (customer-first, minimal taps): initiate a voucher
  from the home screen → search & pick the **customer** → optional **vehicle
  number** → **product** (Diesel/Petrol) → **quantity** → **price** (preset
  to today's price, editable) → **amount** (auto-filled as quantity × price,
  editable). Editing the amount derives the quantity instead (the
  "₹20,000 ka diesel" case) — last-edited side wins, live in both directions.
- **Three independent invoice series**, matching the Tally voucher types
  (all verified against the client's real daybook):
  - Diesel → `HSD CREDIT`, item `High Speed Diesel`, ledger `SALE (HSD)`,
    plain numbers (`1639 → 1640`)
  - Petrol → `MS CREDIT`, item `Motor Spirit`, ledger `SALE (MS)`,
    prefixed numbers (`MS319 → MS320`)
  - XtraGreen → `XG CREDIT`, item `XtraGreen Diesel`, ledger **`SALE (HSD)`**
    (XG books to the HSD sales ledger in Tally), prefixed numbers (`XG6 → XG7`)
- **Fully automatic invoice numbers** — displayed but **not editable** by the
  employee (Tally numbering is "Automatic (Manual Override)", so the app
  supplies `<VOUCHERNUMBER>`). Numbers already present in the pending queue
  or in old vouchers are skipped automatically. The owner can correct the
  counters in Settings.
- **Import Tally XML** (home screen → "⬆ Import Tally XML (DayBook / Master)",
  auto-detects which file was given):
  - **DayBook export** (UTF-16 or UTF-8; Tally artifacts like
    `&#4; Not Applicable` are handled): loads all `HSD CREDIT` / `MS CREDIT` /
    `XG CREDIT` vouchers into **Old vouchers**, syncs all three invoice
    counters to the highest number seen, adds any unknown party ledgers, and
    picks up the latest rates. Cancelled and other voucher types (cash,
    receipts…) are skipped; re-importing the same file is a no-op (duplicates
    detected per series + number). Uses a plain-text scan rather than a DOM
    parser, so a full-year ~100 MB daybook imports in about a second.
  - **Masters (ledgers) export**: adds the ledgers under the **Sundry
    Debtors** group (subgroups such as RCP COMPANIES included) to the
    customer list. The merge is **additive** — existing customers are kept
    and only new ones are added, so re-uploading the whole file whenever new
    customers appear is always safe.
- **Auto-clear old vouchers** (Settings toggle, off by default): when on,
  vouchers older than 2 days are removed each time the app opens (today,
  yesterday and the day before are always kept). Invoice numbering advances
  as vouchers are exported/cleared, so a cleared number is **never reused**.
- **Danger zone** (Settings): **Reset ALL vouchers** clears every voucher but
  keeps customers, prices and numbering (the next number continues); **Reset
  ALL customers** clears the customer list to start afresh. Both require
  typing `DELETE`.
- **Old vouchers screen**: searchable by customer / vehicle / invoice number.
  App vouchers moved here after a confirmed Tally import are kept too, so
  the full history stays in one place.
- **Round-off is user-entered only** (never automatic): an optional
  "Round off (₹)" field (+ or −) posts to the `R/off` ledger with the correct
  debit/credit sign; party total = amount + round-off. Omitted from the XML
  when zero; values ≥ ₹1 ask for confirmation (typo guard).
- **Vehicle number** is exported into the company's existing Tally UDF
  (`UDF:EIVEHNO`, the "Vehicle No" field at the top of the voucher screen —
  exact structure copied from the real daybook), and shown in lists/search.
- **Party GST details in every export**: each voucher carries the party's
  `PARTYGSTIN`, registration type, state, place of supply, pincode and the
  consignee fields (plus the company's GST identity), sourced from the
  party's ledger in the Master import — so GSTR reports classify the sale
  correctly. Parties without a GSTIN are emitted as Unregistered/Consumer,
  matching how Tally itself records them.
- **Saved vouchers stay editable**: tap any voucher in the day list (or its
  ✎) to reopen it in the entry form — it keeps its invoice number, and
  amount-driven vouchers reopen amount-driven so resaving changes nothing.
  Switching the product while editing assigns the next number of the new
  series and frees the old number for reuse — invoice numbering is gap-free:
  the next number is computed from the numbers actually in use above the
  per-series baseline set by import/Settings.
- **Whole-day, repeatable export**: the home screen shows one day at a time
  (date picker, default today). "Download XML" always produces the complete
  file for that day — every app voucher of the date, including ones exported
  earlier or already moved to old vouchers — and can be downloaded again and
  again (`Sales_YYYY-MM-DD_Nvch.xml`, vouchers ordered by series + number).
  Duplicate-import management in Tally is deliberately left to the operator.
  After a day is confirmed imported, an optional "move day to old vouchers"
  tidies the list; the day remains exportable afterwards.
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
