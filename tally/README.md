# Tally Prime connection

The app now includes **Tally connection & reports**: a Windows bridge, durable voucher queue, Tally data explorer and cached native reports. Apply the separate bridge migration before pairing a PC. See [Windows setup and supported scope](../tally_bridge/README.md). The manual workflows below remain available for installations that have not paired a bridge.

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

- **Ledger / Decant glass theme** — warm orange accents, frosted panels and
  product-coloured voucher cards. The header theme button cycles **Dark → Light
  → Auto** and remembers the choice on that device. Desktop shows the products
  side by side; phones keep a single-column layout. Printed bills stay on white
  A4 pages.
- **Voucher entry flow** (customer-first, minimal taps): initiate a voucher
  from the home screen → search & pick the **customer** → optional **vehicle
  number** → **product** (Diesel/Petrol) → **quantity** → **price** (preset
  to the customer's last price for that product, else today's price;
  editable) → **amount** (auto-filled as quantity × price,
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
    receipts…) are skipped. **Tally is the source of truth**: a voucher
    already in the app with the same series + number is **overwritten** with
    the imported version (even an app-made pending one), so re-uploading a
    fresh daybook reconciles the app to Tally. Uses a plain-text scan rather
    than a DOM parser, so a full-year ~100 MB daybook imports in about a
    second.
  - **Masters (ledgers) export**: adds the ledgers under the **Sundry
    Debtors** group (subgroups such as RCP COMPANIES included) to the
    customer list. The merge is **additive** — existing customers are kept
    and only new ones are added, so re-uploading the whole file whenever new
    customers appear is always safe.
- **Auto-clear old vouchers** (Settings toggle, off by default): when on,
  vouchers older than 2 days are removed each time the app opens (today,
  yesterday and the day before are always kept). Invoice numbering advances
  as vouchers are exported/cleared, so a cleared number is **never reused**.
- **Customer price memory**: a new voucher is pre-filled with the price of
  the customer's last invoice for that product, up to the voucher's date,
  even when that invoice was cleared long ago. The cloud table
  `tally_customer_prices` keeps one row per customer, product and billing
  day (the day's last invoice by number), written by a database trigger on
  every way a voucher arrives or changes: saving, editing an old voucher,
  DayBook import and the Tally bridge. Auto-clear and **Reset ALL vouchers**
  leave it alone; a pending voucher deleted in the app, or a voucher
  cancelled/deleted in Tally, gives back that day's earlier price. Invoices
  Tally has not settled yet are not offered. Saving a voucher never changes
  the default price in Settings. (Cloud mode: re-run
  `supabase/tally-schema.sql` once to create the table; it is filled from
  the vouchers already there. Until then prices come from the kept vouchers
  alone.)
- **Danger zone** (Settings): **Reset ALL vouchers** clears every voucher but
  keeps customers, prices (including the customer price memory) and
  numbering (the next number continues); **Reset
  ALL customers** clears the customer list to start afresh. Both require
  typing `DELETE`.
- **Stock summary screen** (was *Old vouchers*): laid out like Tally Prime's
  Stock Summary. It opens on the products — High Speed Diesel, Motor Spirit
  and XtraGreen Diesel — with quantity (LTR), value and a grand total; tap a
  product for its dates (Tally shows months; the app keeps days), and a date
  for that day's vouchers with a day total. Back steps up one level, like Esc
  in Tally. Values are the stock-item value before round-off; vouchers
  deleted in Tally are listed but not counted. Pending vouchers and old ones
  are both included. The search box on the first level still finds vouchers
  by customer / vehicle / invoice number across every product and date.
  App vouchers moved here after a confirmed Tally import are kept too, so
  the full history stays in one place. Each voucher carries 🧾 to raise its
  customer bill and ✎ to **alter the voucher behind a confirmation** —
  both work on daybook-imported vouchers as well (see below).
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
- **Tally company name and the financial year**: the XML's
  `SVCURRENTCOMPANY` must match the Tally company, which carries the year
  (`VRIDDHI FUELS (2026-27)`). Tick **Add the financial year automatically**
  in Settings and keep just the name: each day's XML then goes to that day's
  year — `VRIDDHI FUELS (2027-28)` from 1 April 2027 — and the home screen
  shows the company under the download button. Untick it to use the name
  exactly as typed. (Cloud mode: re-run `supabase/tally-schema.sql` once for
  the `company_fy` switch; until then the app says so.)
- **Settings**: company name, per-series last invoice no. + today's price
  (to fix counter drift if vouchers were entered directly in Tally), party
  management, and a read-only table of the fixed Tally names.
- **Customer bill from the voucher** — the tanker-billing module, moved into
  this app: one tap on the voucher screen opens the printable A4 bill with
  every field already filled (see [below](#customer-bill-the-billing-module)).
- **Persistence**: counters, prices, parties, queue and old vouchers survive
  restarts (localStorage). Installable to the home screen; works offline via
  a service worker.

## Customer bill (the billing module)

The tanker-billing module now lives in this app, so the printable customer
bill is raised from the voucher instead of a second app. On the voucher
screen, **"🧾 Create bill — fill the invoice from this voucher"** opens the
bill with every field already filled:

| Bill field | Comes from |
|---|---|
| Date, Vehicle, Quantity, Price/Ltr, Amount | the voucher being created (or the saved voucher you tapped 🧾 on) |
| Product | the voucher's series — Diesel → *High Speed Diesel*, Petrol → *Motor Spirit*, XtraGreen → *XtraGreen Diesel* |
| Customer name, address, GSTIN, P.O. label | the customer's row in the Tanker Billing sheet, matched to the Tally party ledger |
| P.O. number | the customer's **open PO from the Ledger app**: the first PO in its list with enough litres left, by the Ledger's own rule (`ledger/js/po.js`), counting this app's vouchers the Ledger has not imported yet. Falls back to the sheet row when the Ledger is not connected or the customer has no PO list there. Editable; a number typed by hand is kept. |
| Payment / bank block | the same row |
| Density- / Seal No- lines | shown for diesel loads over 3 000 L, exactly as before |
| Bill no. | **the voucher's own invoice number** — `1640`, `MS320`, `XG7` — so the bill and the Tally invoice carry one reference |

**Ledger connection for open POs.** The Ledger app has its own Supabase project and members list. Signing into this app also signs into the Ledger when the same login is a Ledger member; otherwise the bill screen shows **Connect the Ledger** once per device (the session is stored separately from this app's). Petrol and XtraGreen bills get no PO automatically, as in the Ledger; the open POs are offered in the field's suggestions. Unit-wise customers pick the unit's PO.

The data is `state/tanker_billing.json` — the file the hourly
[tanker sync](../tanker/README.md) Action commits from the
`Tanker Billing.xlsm` workbook. You keep editing the workbook exactly as
today; the app follows.

- **Everything stays editable** on the bill screen, and editing a bill never
  changes the voucher, the day's XML export or the invoice numbering — a
  bill and a Tally voucher are two separate documents.
- **The bill opens on the voucher's rate and amount**, so the printed bill
  and the Tally invoice always agree. When the sheet's tier rate for that
  customer differs it is shown underneath with a one-tap *use sheet rate*.
- **The bill number is the voucher's invoice number.** Raised from a saved
  voucher it is that voucher's number exactly; raised from a voucher still
  being typed it is the number the app is about to allocate, so save the
  voucher first if it must be guaranteed (in cloud mode the final number is
  assigned by the server on save). Editing it by hand is allowed and the
  screen then says what the voucher's number was. The `/tanker/` app's own
  running counter is never written to.
- **Party ledger → sheet customer matching** ignores case, spacing,
  punctuation and the usual `M/s` / `Private` / `Limited` / `&` variations.
  If a party is not in the sheet the screen says so and offers the full
  customer list to pick from — the bill still prints, with those fields blank
  until one is chosen.
- **Print / Save PDF** gives the same two A4 pages as before (customer copy
  + greyscale "Receiving Copy"), and **Export Word (.docx)** the same
  editable document.
- **iPhone / iPad**: a home-screen web app cannot open the print dialog and
  has nowhere to put a download, so on iOS every print and PDF button (bill,
  fuel slips, Word export) makes the file first and shows a small **Ready to
  print / PDF ready** sheet. Its button opens the iOS share sheet, which
  has **Print**, **Save to Files**, WhatsApp and Mail. The PDF is made in
  the phone and uses the system's Times New Roman.
- 🧾 next to a voucher — in the day list **or in old vouchers** — raises its
  bill later, including for vouchers that came in from a **DayBook XML
  import**: the import carries the party, date, vehicle (`UDF:EIVEHNO`),
  quantity, rate and amount, and the rest of the bill comes from the
  Tanker Billing sheet as usual.

The standalone app at `/tanker/` is unchanged and keeps working — both read
the same data file, and this app reuses the tanker app's letterhead, stamp,
fonts and `.docx` builder rather than keeping a second copy of them.

## Fuel slips (Print Bills)

The Ledger app's **Print Bills** — the HSD Bill sheet's A5 credit memo —
for every voucher in this app: pending, exported and old, including the
ones a **DayBook import** brought in.

- **🎫 next to any voucher** (day list or old vouchers) makes that voucher's
  slip and shows it straight away: **Download PDF** or **Print**.
- **On the voucher screen** (a new voucher, or one opened by tapping it or
  ✎ — old vouchers too) **🎫 Download fuel slip (PDF)** and **🖨 Print fuel
  slip** give that one voucher's slip in one tap, from what is on the form.
  For a new voucher, save it first so the slip carries its final number.
- **🎫 Fuel slips — every voucher of <day>** (home, under the XML button)
  makes the whole day's slips; **🎫 Fuel slips — any dates / customer**
  (Records & imports) takes any From..To range and, optionally, one
  customer (exact name, any case).
- Exactly like the Ledger app: one A5 page per voucher, **one PDF per
  customer** (`<Customer> Slips <date>.pdf`; diesel first, then petrol, then
  XtraGreen), **Download all PDFs (.zip)** in a `Fuel Bills <from> to <to>`
  folder, **Print all**, and a PDF / Print / Preview per customer.
- The slip shows the voucher's number, date, customer, vehicle, product,
  quantity, rate and **party total** (the amount the DayBook's Debit column
  — and so the Ledger app's slip — carries).
- **Signature:** *Choose signature* uploads the picture printed above
  "Sign.of Salesman" (where the Ledger app puts its stamp; PNG/JPEG under
  500 KB), *Change signature* replaces it and *Remove* deletes it. The
  **Print the signature on the slips** tick box leaves it off without
  removing it (remembered on that device).
- **Slip heading:** the top of the slip (title, mobile, up to 7 lines) is
  editable under *Slip heading*; until one is saved it prints the standard
  Vriddhi Fuels heading. The first line is the company name: with **End the
  first line with each bill's financial year** ticked (the standard heading
  does) it prints `VRIDDHI FUELS (2026-27)` for bills up to 31 March and
  `(2027-28)` from 1 April — nothing to change for a new year. Untick it to
  print the line exactly as typed.
- In cloud mode the signature and heading are shared by every employee.
  This needs the new `slip_header` / `slip_stamp` columns, so re-run
  [`../supabase/tally-schema.sql`](../supabase/tally-schema.sql) in the
  Supabase SQL Editor once (safe to re-run). Until then the screen says so
  and keeps them on that device only — slips still work.

The drawing and grouping are in [`slips.js`](./slips.js), a port of the
Ledger app's own code (the Pages site serves only `/tanker/` and `/tally/`);
`tests/ledger_web/tally_slips.test.mjs` checks that both produce exactly the
same slips and PDFs. The PDF and zip libraries (jsPDF, JSZip) load from
cdnjs the first time slips are downloaded, as in the Ledger app.

## Altering an old voucher

Vouchers in **Old vouchers** — both the ones moved there after a Tally
import and the ones a **DayBook XML import** brought in — can be corrected
with ✎, behind a confirmation. This exists mainly so a bill prints right
when the daybook is missing a detail (a vehicle number, say) or a figure
was wrong.

- **The confirmation spells out what does not happen:** the voucher is
  already in Tally and the app cannot change it there.
  - A **daybook-imported** voucher is not part of the day's XML export, so
    it has to be corrected in Tally by hand.
  - A voucher the **app made** and later moved to old vouchers stays in the
    day's export, so re-downloading the day's XML carries the correction —
    the copy already imported into Tally still has to be corrected or
    re-imported there.
- **The invoice number and the product are locked.** The voucher exists in
  Tally under that voucher type and number; renumbering it here would only
  put the two out of step. Everything else — customer, vehicle, date,
  quantity, price, amount, round-off — is editable, with the same
  quantity ⇄ amount behaviour as a new voucher.
- Invoice numbering is untouched: nothing is allocated or freed, and the
  voucher stays in old vouchers with its source.

> **Cloud mode:** this uses a new `tally_edit_history_voucher` function, so
> re-run [`../supabase/tally-schema.sql`](../supabase/tally-schema.sql) in
> the Supabase SQL Editor once (it is safe to re-run). Until then the app
> says so instead of failing silently.

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
