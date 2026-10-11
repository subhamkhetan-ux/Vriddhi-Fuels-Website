# Shree Shyam Fleet — the Trip Register in the cloud (`/fleet/`)

A web app, in the ledger app's look, for the 10 bulkers that run on contract
with **SS Freight Carrier (SSFC)**. You keep the **Trip Register** workbook in
Excel as before; upload it here (from any phone or computer) and the app shows:

| Tab | What it shows | From the workbook |
|---|---|---|
| **Home** | *On the road now*: every vehicle loaded → destination / empty → loading port / idle, with its trip and days on the road. *Needs a look*: trips loaded > 7 days and not unloaded, short weight in the last 45 days, vehicles > 300 L over their diesel allowance, SSFC invoices pending > 90 days, dates that look mistyped. The SSFC balance. *Business* for any period (this month, last month, last 3 months, this / last FY, all time, custom months): freight, trips, SSFC net, profit before EMI, EMI, net after EMI, diesel, weight short; **where every ₹100 of freight goes**; month by month (chart + table); vehicles ranked; routes (avg load, ₹/T, diesel a trip, days, profit a trip). | Trip Register, On-Trip Dashboard rules |
| **Trips** | Every trip, newest first: filter by on the road / unloaded / short weight / loss before EMI / dates to check, by vehicle, month, route, or search trip no. & remarks. Tap a trip for its timeline, weights, the full bhada → SSFC net → income working, diesel issued vs allotted, its HSD fills and urea. | Trip Register, HSD Data, Urea DEF |
| **Vehicles** | A card per vehicle (status, net, freight, before EMI, diesel recon); tap for its month-by-month, EMI, km and mileage, trips. | Trip Register |
| **Vehicles → Performance** | Every trip against the trips on the **same route that started within ±10 days** (±21 when few): days to get loaded, the loaded run, idle after unloading, diesel fills. **Behind on the road now** (a vehicle past the route's recent best, or others that started with it already further on — with the driver's name, to call him). Vehicles ranked by days a trip faster / slower than their peers, **⚠ Underperforming** (≥ 1 day a trip slower than the typical peer, or 40%+ slow trips), *Slipping* (≥ ½ day), *★ Top*; days and freight lost; stage by stage; the slowest trips with the stage that lost the time. | Trip Register, HSD Data |
| **Drivers** | Each trip: driver salary − your advances = what SSFC should pay; trips SSFC paid more; **overpaid drivers** (each driver's spell on a vehicle, from the "New Driver" / "Driver Changed" remarks, with Driver Debit as money owed back); each vehicle's driver now. | Trip Register + Setup → Routes |
| **Tyre & Fastag** | SSFC's monthly charges per vehicle: fleet total per month, a vehicle × month grid, and every month **out of the usual trend** (well above / below the fleet that month *and* the vehicle's own last six months, or booked twice). Tyre is compared month to month, fastag per trip — both per km once distances are set. Each vehicle's first two months aren't judged. Vehicles can be switched out of either analysis in Setup (tyre is off for 4010, 7010, 9010 to start with). | Trip Register |
| **SSFC** | What SSFC owes (with and without GST), how much should come in the SSL account vs be settled in cash, every invoice cleared oldest first with its age, earned vs received by month, payments received, the Bridgestone notes. | Ledger sheet |
| **Diesel** | Litres and ₹ by pump (SSFC / Vriddhi Fuels / SSL Own Filling / Extra / Other), per month and per place; the diesel recon per vehicle and trip by trip; urea by vendor. | HSD Data, Diesel Recon / Recon Engine, Rates, Urea DEF |
| **Setup** | **Upload** the workbook (preview with checks → Save). **Routes**: for every loading port × destination, the distance (km), the driver salary per trip and the diesel allotted — with an optional *From month* for a change, and *Paste from Excel*. **Vehicles in the analysis** (tyre / fastag switches). **Driver pay** options (is Extra Own Driver Pay an advance; does Driver Debit count). **Diesel recon**: the workbook's Recon Engine (default) or the diesel set here for every trip. | the database |

Our **bulkers are drawn** as in the walk-around video — white Tata Signa
tractor, mustard V-belly pneumatic tank with the twin navy stripes, top
handrail, tri-axle — in Shree Shyam Logistics' livery (logo, name and the
tagline *Driving Your Progress*). The tank is see-through: the alumina (white
powder) is drawn up to the trip's load, the **RTO passing weight (56 T gross)**
is a dashed red line with any weight over it hatched amber, *62 T rated* is
marked, and the top of the tank is the highest gross in the register. They're
on every vehicle tile on Home, the vehicle cards, each vehicle (now carrying /
last load, poured in) and each trip. A trip's page also lays it **side by side
with the others that started with it** — start, every diesel fill, loading,
unloading — the quickest highlighted.

Everywhere: the **Shree Shyam Logistics logo** (a glowing animation on Home and
while loading, the header, sign-in, the app icon), and **light and dark** —
the button in the header goes *Auto* (follows the phone / computer) → *Light*
→ *Dark*, remembered on that device.

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
- **Distance** of a trip = empty from where the vehicle unloaded last to this
  trip's port + loaded from the port to the destination (a route's distance
  counts both ways). Mileage = that km ÷ the trip's diesel.
- **Driver pay** (Setup → Routes sets the salary; until then the Rates sheet's
  *Driver Payment* is used where it has one): SSFC should pay salary − Trip
  Driver Payment − Extra Own Driver Pay (when that's an advance). A driver is
  *overpaid* when, over his spell on the vehicle, SSFC + your advances + Driver
  Debit is more than the salaries earned (₹500 slack); differences up to ₹100 a
  trip are ignored (both in Setup).
- **Tyre / fastag trend**: a month is flagged when its charge is over 1.3× the
  fleet's rate that month *and* over 1.3× the vehicle's own trend (its last six
  judged months), by at least ₹5,000 (tyre) / ₹2,500 (fastag); or under 0.6×
  both (not for the latest month — it may not be booked yet); or booked twice.
  With no history of its own yet, only a 1.6× gap from the fleet counts.
- On upload the app checks itself against the workbook: the SSFC total against
  the Ledger sheet's *TOTAL* and the recon against the *Diesel Recon* total
  (✓ when they match). It also lists trips whose dates can't be right (unloaded
  after today, before loading, or more than 60 days on the road — usually a
  day and month typed the wrong way round).

## Where the data lives

In the **ledger's Supabase project** (same URL and key as `ledger/config.js`),
in its own `fleet_uploads` table (the uploads) and `fleet_settings` (Setup). Only logins on the ledger's member list can
read or write it; the public key gets nothing. You sign in with your ledger
login (if you're signed in to the ledger in the same browser, you're already
signed in here). The newest 10 uploads are kept.

No trip data is ever written to this repository: the workbook is read in the
browser and only the figures the app needs are saved to the database.

## One-time setup

1. In the ledger's Supabase project: **SQL Editor** → paste all of
   [`supabase/fleet-schema.sql`](../supabase/fleet-schema.sql) → **Run**.
   (Safe to run again — run it again after updates.)
2. Open **`/fleet/`**, sign in with your ledger login, **Setup** → upload the
   Trip Register and **Save**.
3. **Setup → Routes**: enter each route's distance, driver salary and diesel
   (or paste them from Excel) → **Save setup**.

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
| `js/perf.js` | Who's slow: trip stages, the same-route-same-time groups, vehicle scores, behind on the road |
| `js/bulker.js` | The bulker drawing and the side-by-side trip lanes |
| `js/rules.js` | Setup's rules: route values, km per trip, driver pay check, tyre / fastag trend |
| `assets/` | The logo: the mark, and the wordmark for dark (light letters) and light (navy) |
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
