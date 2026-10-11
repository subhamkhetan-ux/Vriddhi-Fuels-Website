# Shree Shyam Fleet — the Trip Register in the cloud (`/fleet/`)

A web app, in the ledger app's look, for the 10 bulkers that run on contract
with **SS Freight Carrier (SSFC)**. You keep the **Trip Register** workbook in
Excel as before; upload it here (from any phone or computer) and the app shows:

| Tab | What it shows | From the workbook |
|---|---|---|
| **Home** | *On the road now*: every vehicle loaded → destination / empty → loading port / idle, with its trip and days on the road. *Needs a look*: trips loaded > 7 days and not unloaded, short weight in the last 45 days, vehicles > 300 L over their diesel allowance, SSFC invoices pending > 90 days, dates that look mistyped. The SSFC balance. *Business* for any period (this month, last month, last 3 months, this / last FY, all time, custom months): freight, trips, SSFC net, profit before EMI, EMI, net after EMI, diesel, weight short; **where every ₹100 of freight goes**; month by month (chart + table); vehicles ranked; routes (avg load, ₹/T, diesel a trip, days, profit a trip). | Trip Register, On-Trip Dashboard rules |
| **Trips** | Every trip, newest first: filter by on the road / unloaded / short weight / loss before EMI / dates to check, by vehicle, month, route, or search trip no. & remarks. Tap a trip for its timeline, weights, the full bhada → SSFC net → income working, diesel issued vs allotted, its HSD fills and urea. | Trip Register, HSD Data, Urea DEF |
| **Vehicles** | A card per vehicle (status, net, freight, before EMI, diesel recon); tap for its month-by-month, EMI, trips. | Trip Register |
| **SSFC** | What SSFC owes (with and without GST), how much should come in the SSL account vs be settled in cash, every invoice cleared oldest first with its age, earned vs received by month, payments received, the Bridgestone notes. | Ledger sheet |
| **Diesel** | Litres and ₹ by pump (SSFC / Vriddhi Fuels / SSL Own Filling / Extra / Other), per month and per place; the diesel recon per vehicle and trip by trip; urea by vendor. | HSD Data, Diesel Recon / Recon Engine, Rates, Urea DEF |
| **Upload** | Choose the workbook → a preview with checks → **Save**. | everything |

## The rules (the workbook's own)

- A trip counts in the **month it was loaded** (the sheet's *Month* column).
- The workbook's saved values are used as they are (Trip Bhada, SSFC Net
  Amount, Income/Trip, the SSFC diesel looked up from HSD Data…). If a cell has
  no value, the same formula fills it: bhada = load × rate; SSFC net = bhada −
  SSFC diesel − driver SSFC payment − SSFC misc − fastag − maintenance − tyre −
  less over/unload − RTO entry − RTO challan − shortage − document expense;
  income = SSFC net − extra HSD − own diesel − urea − extra driver pay − trip
  driver payment − own document − own misc − installment.
- **EMI** is charged to one trip a month, so the app shows *profit before EMI*
  next to *net after EMI* (Income/Trip) everywhere.
- **SSFC account**: SSFC net + GST, less everything received (paid in the SSL
  account + own diesel + cash), clears the not-invoiced months first and then
  each invoice oldest first — the Ledger sheet's clearance table. *To come in
  account* = invoices with GST − paid in account; *to settle in cash* = GST +
  the cash balance.
- **Diesel recon**: for every trip the Recon Engine sheet covers, Excel's own
  figures are used (the underload rule changed from 56 T to 58 T during the
  year and some allowances are typed by hand). Trips after the end of that
  sheet get the newest rule: the route's diesel (Rates) + 5 L a tonne over
  58 T gross − 5 L a tonne under the underload limit (not from Gangavaram);
  issued = SSFC litres + own trip litres.
- On upload the app checks itself against the workbook: the SSFC total against
  the Ledger sheet's *TOTAL* and the recon against the *Diesel Recon* total
  (✓ when they match). It also lists trips whose dates can't be right (unloaded
  after today, before loading, or more than 60 days on the road — usually a
  day and month typed the wrong way round).

## Where the data lives

In the **ledger's Supabase project** (same URL and key as `ledger/config.js`),
in its own `fleet_uploads` table. Only logins on the ledger's member list can
read or write it; the public key gets nothing. You sign in with your ledger
login (if you're signed in to the ledger in the same browser, you're already
signed in here). The newest 10 uploads are kept.

No trip data is ever written to this repository: the workbook is read in the
browser and only the figures the app needs are saved to the database.

## One-time setup

1. In the ledger's Supabase project: **SQL Editor** → paste all of
   [`supabase/fleet-schema.sql`](../supabase/fleet-schema.sql) → **Run**.
   (Safe to run again.)
2. Open **`/fleet/`**, sign in with your ledger login, **Upload** the Trip
   Register and **Save**.

Anyone else who should see it needs a ledger login
(`select ledger_add_member('them@example.com');`).

Before step 1, the app still opens a Trip Register **just on this device**
(nothing saved), and **`/fleet/?demo`** shows made-up data.

## Day to day

Keep entering trips, HSD, urea and the SSFC ledger in Excel. Save the workbook,
then upload it here (from the phone too). The app always shows the latest
upload.

## Files

| File | What |
|---|---|
| `index.html` | The page (the ledger's styles + the fleet's) |
| `config.js` | Supabase URL + publishable key (the ledger project's) |
| `js/app.js` | The screens |
| `js/parse.js` | Reads the workbook: every sheet by its headings, every column by its name |
| `js/analyse.js` | The figures: periods, totals, costs, routes, live status, diesel recon, SSFC clearance, fuel, alerts |
| `js/charts.js` | SVG charts and their tooltips |
| `js/store.js` | Talks to the database (`fleet_*` functions); in-memory demo store |
| `js/demo.js` | Made-up demo data |
| `js/util.js` | Dates, numbers, names |
| `../supabase/fleet-schema.sql` | The table, row-level security and `fleet_*` functions |

## Tests

```bash
node --test 'tests/fleet_web/*.test.mjs'
python -m pytest tests/test_fleet_schema.py -q    # needs a local Postgres; skipped otherwise
```

All test data is made up.
