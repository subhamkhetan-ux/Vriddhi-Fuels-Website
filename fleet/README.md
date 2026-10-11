# Shree Shyam Fleet — the Trip Register in the cloud (`/fleet/`)

A web app, in the ledger app's look, for the 10 bulkers that run on contract
with **SS Freight Carrier (SSFC)**. You keep the **Trip Register** workbook in
Excel as before; upload it here (from any phone or computer) and the app shows:

| Tab | What it shows | From the workbook |
|---|---|---|
| **Home** | *On the road now*: a card for **every vehicle on a trip** — the full number plate, **loading port → destination** in large type, the bulker with its load, the **stage it's in** (departed → diesel at Muniguda → loaded at the port → refill → unloaded, each with its date, or the best date for the steps still to come), its **pace** (on the best pace / behind the best / late against the usual — and against its own best) with the expected unloading date, and the trip's **projected income** (before and after the EMI share). *Needs a look*: vehicles behind on the road, underperformers, trips loaded > 7 days, short weight, diesel over allowance, SSFC invoices > 90 days, mistyped dates. The SSFC balance. *Business* for any period. | Trip Register, HSD Data, On-Trip Dashboard rules |
| **Home → Rates, costs & income** | For every route (or all): **when the rate changed** — ₹ old → new a ton, and the last 40 trips at the old rate against the first 40 at the new one: load, freight, diesel (litres and ₹ a litre), driver, fastag, tyre & maintenance, RTO & documents, other, what's kept — in one sentence and a table. **Where the bhada goes**: the % of freight to each cost and what's kept — overall, by route, by rate period and by month. **Month by month**: rate a ton, pump price, diesel ₹ and litres a trip, driver a trip, kept a trip and as % of freight, load — small charts and a table. | Trip Register, HSD Data |
| **Trips** | Every trip, newest first: filter by on the road / unloaded / short weight / loss before EMI / dates to check, by vehicle, month, route, or search trip no. & remarks. Tap a trip for its timeline, weights, the full bhada → SSFC net → income working, diesel issued vs allotted, its HSD fills and urea. | Trip Register, HSD Data, Urea DEF |
| **Vehicles** | A card per vehicle (status, net, freight, before EMI, diesel recon); tap for its month-by-month, EMI, km and mileage, trips. | Trip Register |
| **Vehicles → Performance** | Every trip against the trips on the **same route that started within ±10 days** (±21 when few): days to get loaded, the loaded run, idle after unloading, diesel fills. **Behind on the road now** (a vehicle past the route's recent best, or others that started with it already further on — with the driver's name, to call him). Vehicles ranked by days a trip faster / slower than their peers, **⚠ Underperforming** (≥ 1 day a trip slower than the typical peer, or 40%+ slow trips), *Slipping* (≥ ½ day), *★ Top*; days and freight lost; stage by stage; the slowest trips with the stage that lost the time. | Trip Register, HSD Data |
| **Drivers** | Each trip: driver salary − your advances = what SSFC should pay; trips SSFC paid more; **overpaid drivers** (each driver's spell on a vehicle, from the "New Driver" / "Driver Changed" remarks, with Driver Debit as money owed back); each vehicle's driver now. | Trip Register + Setup → Routes |
| **Tyre & Fastag** | SSFC's monthly charges per vehicle: fleet total per month, a vehicle × month grid, and every month **out of the usual trend** (well above / below the fleet that month *and* the vehicle's own last six months, or booked twice). Tyre is compared month to month, fastag per trip — both per km once distances are set. Each vehicle's first two months aren't judged. Vehicles can be switched out of either analysis in Setup (tyre is off for 4010, 7010, 9010 to start with). | Trip Register |
| **SSFC** | What SSFC owes (with and without GST), how much should come in the SSL account vs be settled in cash, every invoice cleared oldest first with its age, earned vs received by month, payments received, the Bridgestone notes. | Ledger sheet |
| **Diesel** | Litres and ₹ by pump (SSFC / Vriddhi Fuels / SSL Own Filling / Extra / Other), per month and per place; the diesel recon per vehicle and trip by trip; urea by vendor. | HSD Data, Diesel Recon / Recon Engine, Rates, Urea DEF |
| **Setup** | **Upload** the workbook (preview with checks → Save). **Routes**: for every loading port × destination, the distance (km), the driver salary per trip and the diesel allotted — with an optional *From month* for a change, and *Paste from Excel*. **Vehicles in the analysis** (tyre / fastag switches). **Driver pay** options (Extra Own Driver Pay settled by default; does Driver Debit count). **Diesel recon**: the workbook's Recon Engine (default) or the diesel set here for every trip. | the database |

Our **bulkers are drawn** the way the Loading and Decanting apps draw our
diesel tankers: a navy livery band on top (the logo, SHREE SHYAM LOGISTICS and
*Driving Your Progress*), then one big **sight glass** over most of the mustard
V-belly tank, filled from the bottom with the alumina (white powder, heaped
under the three hatches) up to the trip's weight, with the tonnes written on
it; the twin navy stripes run along the belly, with a white Tata Signa tractor
and a tri-axle under-frame. The glass reads gross weight like a gauge — 40 T at
the bottom (every load is well over that), the register's highest gross at the
top — with the **RTO passing weight (56 T)** as a dashed red line, any weight
over it hatched amber, and *62 T rated* marked. They're on every vehicle tile
on Home, the vehicle cards, each vehicle (now carrying / last load, poured in)
and each trip. A trip's page also lays it **side by side with the others that
started with it** — start, every diesel fill, loading, unloading — the
quickest highlighted.

Everywhere: the **Shree Shyam Logistics logo** (a glowing animation on Home and
while loading, the header, sign-in, the app icon), and **light and dark** —
the button in the header goes *Auto* (follows the phone / computer) → *Light*
→ *Dark*, remembered on that device.

## Rates, costs & income over time

The Trip Register is the truth for every past trip: its own rate per ton,
diesel and driver pay as recorded (rates, diesel prices and salaries changed
over time). For comparisons each trip's freight is split into diesel, driver,
fastag, tyre & maintenance, RTO & documents, other (urea, misc, shortage),
**yearly** (insurance, permit, road tax, Fleet Edge — an own misc / document
entry whose remarks say so) and what's **kept**. SSFC books fastag, tyre,
maintenance and RTO entry once a month per vehicle on whichever trip was
running, so each vehicle's month of those is spread evenly over its trips that
month (totals unchanged). Own misc entries go by their remarks: a tyre buy to
tyre & maintenance, a repair to maintenance. *Kept before yearly costs & EMI* is
the like-for-like figure. The running month is left out of the charts until
it's complete.

## A vehicle on the road

- **Stages** come from the diesel fills logged in HSD Data. Every route runs
  the same way — departure (often a small top-up), the outbound fill (Muniguda
  on our routes), loading at the port, the return refill, unloading — so for
  each route the app learns from the last 150 days where the outbound and
  return fills happen and on which day of the trip each step comes: the
  **best** (the quickest tenth of trips), the **usual** (the median) and each
  vehicle's **own best**. A fill of under 100 L is a top-up, not the outbound
  fill; a vehicle past the usual loading day without a loading date is
  *waiting to load*.
- **Pace**: the steps done so far, and the next one if it's overdue, against
  those days — *on the best pace*, *N d behind the best* (amber), or *late* —
  a day or more behind the usual (red).
- **Projected income** of the trip: freight (loaded × rate, or before loading
  the vehicle's usual load × the route's rate) − diesel (every fill logged for
  the trip + what the route usually still needs, at the last price) − the
  driver's salary (Setup, else the Rates sheet, else what the route usually
  costs) − SSFC's other deductions (fastag, tyre, maintenance, RTO … — the
  vehicle's average a trip over the last 90 days) − urea and own misc (as
  logged, or the average); then the EMI's share a trip (the monthly EMI ÷ its
  trips a month).

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
  Driver Payment (your advance). *Extra Own Driver Pay* is the extra promised
  for those trips — on top of the salary and settled — so it's left out of the
  check (Setup can count it as an advance instead); it still counts as a cost
  in a trip's projected income. Only trips from the month set in Setup
  (*Check driver pay from*, this month by default) are checked: older ones are
  as the Trip Register has them, settled. A trip with no driver payment logged
  yet waits until there is one. A driver is
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

In **its own Supabase project** — not the ledger's or any other app's — in
`fleet_uploads` (the uploads; the newest 10 are kept) and `fleet_settings`
(Setup). Nothing is readable with the public key, and a login must also be on
the `fleet_members` list, which only the SQL Editor can change.

No trip data is ever written to this repository: the workbook is read in the
browser and only the figures the app needs are saved to the database.

## One-time setup

1. **Create a Supabase account and project** (supabase.com → *Start your
   project* → *New project*), e.g. `shree-shyam-fleet`, region **Mumbai
   (ap-south-1)**. Keep the database password somewhere safe (the app never
   needs it).
2. **Create the tables:** in that project, **SQL Editor** → *New query* →
   paste all of [`supabase/fleet-schema.sql`](../supabase/fleet-schema.sql) →
   **Run**. (Safe to run again; updates to this file are applied the same way.)
3. **Turn off public sign-ups:** Authentication → Sign In / Providers →
   switch off **Allow new users to sign up**.
4. **Add your login:** Authentication → Users → **Add user** → *Create new
   user* (email + password, tick *Auto Confirm User*). Then in the SQL Editor:

   ```sql
   select fleet_add_member('you@example.com');
   ```

   Repeat for anyone else who should use the app; `fleet_remove_member`
   takes a login away.
5. **Connect the page:** the project's **Connect** button (or Project
   Settings → API Keys) shows the **Project URL** and the **publishable**
   (anon) key — put both in [`config.js`](./config.js), or send them to Claude
   to do it. Both are meant to be public. **Never** use the `service_role` /
   secret key.
6. Open **`/fleet/`**, sign in, **Setup** → upload the Trip Register →
   **Save**; then **Setup → Routes**: each route's distance, driver salary and
   diesel → **Save setup**.

Until step 5 the page shows these steps, **Try the demo** (`/fleet/?demo`,
made-up data) and *open a Trip Register just on this device* (nothing saved).

## Day to day

Keep entering trips, HSD, urea and the SSFC ledger in Excel. Save the workbook,
then upload it here (from the phone too). The app always shows the latest
upload.

## Files

| File | What |
|---|---|
| `index.html` | The page (the ledger's styles + the fleet's) |
| `config.js` | Supabase URL + publishable key of the fleet's own project |
| `js/app.js` | The screens |
| `js/parse.js` | Reads the workbook: every sheet by its headings, every column by its name |
| `js/analyse.js` | The figures: periods, totals, costs, routes, live status, diesel recon, SSFC clearance, fuel, alerts |
| `js/live.js` | A vehicle on the road: its stage from the fills, pace against the best, projected income |
| `js/perf.js` | Who's slow: trip stages, the same-route-same-time groups, vehicle scores, behind on the road |
| `js/bulker.js` | The bulker drawing and the side-by-side trip lanes |
| `js/rules.js` | Setup's rules: route values, km per trip, driver pay check, tyre / fastag trend |
| `assets/` | The logo: the mark, and the wordmark for dark (light letters) and light (navy) |
| `js/charts.js` | SVG charts and their tooltips |
| `js/store.js` | Talks to the database (`fleet_*` functions); in-memory demo store |
| `js/demo.js` | Made-up demo data |
| `js/util.js` | Dates, numbers, names |
| `../supabase/fleet-schema.sql` | Members, the tables, row-level security and the `fleet_*` functions |

## Tests

```bash
node --test 'tests/fleet_web/*.test.mjs'
python -m pytest tests/test_fleet_schema.py -q    # needs a local Postgres; skipped otherwise
```

All test data is made up.
