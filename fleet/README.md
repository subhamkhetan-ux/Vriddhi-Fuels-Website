# Shree Shyam Fleet — the Trip Register in the cloud (`/fleet/`)

A web app, in the ledger app's look, for the 10 bulkers that run on contract
with **SS Freight Carrier (SSFC)**. You keep the **Trip Register** workbook in
Excel as before; upload it here (from any phone or computer) and the app shows:

| Tab | What it shows | From the workbook |
|---|---|---|
| **Home** | *Trips*, under the top card: for the period picked (This month … This FY, All time or Custom months — remembered on this device) trips loaded and unloaded, tonnes, freight and how many are on the road, then a tile per vehicle — its trip count (amber when well under the fleet's average), a bar, a dot per trip coloured by its load (full / near full / under / well under), tonnes, freight and driver; tap one for the vehicle. *On the road now*: a card for **every vehicle on a trip** — the full number plate, **loading port → destination** in large type, the bulker with its load, the **stage it's in** (departed → diesel at Muniguda → loaded at the port → refill → unloaded, each with its date, or the best date for the steps still to come), its **pace** (on the best pace / behind the best / late against the usual — and against its own best) with the expected unloading date, and the trip's **projected income**. **Tap a road card** (or an idle truck) for its sheet: the trip's diesel against the allotment and **every fill tagged to the trip** (date, pump and bill, place, litres, ₹/L, amount; incentive fills shown apart and not counted), the trips before it with their diesel balance, the advances on this trip, and buttons to the trip, vehicle, diesel recon and driver. *Needs a look*: vehicles behind on the road, underperformers, trips loaded > 7 days, short weight, diesel over allowance, SSFC invoices > 90 days, mistyped dates. The SSFC balance. *Business* for any period. | Trip Register, HSD Data, On-Trip Dashboard rules |
| **Day book** | **Today's brief** on top: the **owner's insight** — yesterday's and today's work, trucks late / behind / due / idle, this month's loads and the freight left behind by under-loading, freight against last month, SSFC dues, diesel recon, dates to check (share it as a picture). Under it, **Each vehicle**: a card per truck for its trip on the road (else its last one) — the plate, driver, trip and route; the **loading** (date and port, net and gross weight, rate, freight); and a table of every **diesel slip** tagged to the trip (date, pump and slip no., place and ₹/L, litres, amount; incentive slips greyed and not counted) with the total — shared as A4 pages, a truck never split across two — and the **drivers' instructions in Hindi**, a picture for the drivers' WhatsApp group: two standing rules (overload is paid for — load full; reach each stop by its date), yesterday in a line, a ★ for the best, and for every truck where it is now, its **next stop and the date to reach it by** (the best pace on the route, else the usual), its pace and its load (or the load to aim for). Then everything in the workbook with a date, **day by day**, newest first: trips started, **loadings** (tonnes, freight), **unloadings** (delivered, short), **diesel fills** (pump, place, litres, ₹), **urea**, **driver advances** and **SSFC payments** received — each linked to its trip, vehicle or account. Dates: Today, Yesterday, This week, Last 7 days, This month, Last month, Last 30 days, This FY or Custom, with ‹ Earlier / Later › to step; filter by type and vehicle; totals for the range and each day, and **by vehicle** (started, loaded, freight, unloaded, diesel, urea, advances — tap a row to see only that vehicle's entries); the range is remembered on this device; share it as a picture. A trip's undated costs (fastag, tyre, maintenance …) stay on the trip. | Trip Register, HSD Data, Urea DEF, Driver Payment, Ledger |
| **Home → Rates, costs & income** | For every route (or all): **when the rate changed** — ₹ old → new a ton, and the last 40 trips at the old rate against the first 40 at the new one: load, freight, diesel (litres and ₹ a litre), driver, fastag, tyre & maintenance, RTO & documents, other, what's kept — in one sentence and a table. **Where the bhada goes**: the % of freight to each cost and what's kept — overall, by route, by rate period and by month. **Month by month**: rate a ton, pump price, diesel ₹ and litres a trip, driver a trip, kept a trip and as % of freight, load — small charts and a table. | Trip Register, HSD Data |
| **Trips** | Every trip, newest first: filter by on the road / unloaded / short weight / loss before EMI / dates to check, by vehicle, month, route, or search trip no. & remarks. Tap a trip for its timeline, weights, the full bhada → SSFC net → income working, diesel issued vs allotted, its HSD fills and urea. | Trip Register, HSD Data, Urea DEF |
| **Vehicles** | A card per vehicle (status, net, freight, before EMI, diesel recon); tap for its month-by-month, EMI, km and mileage, trips. | Trip Register |
| **Vehicles → Performance** | Every trip against the trips on the **same route that started within ±10 days** (±21 when few): days to get loaded, the loaded run, idle after unloading, diesel fills. **Behind on the road now** (a vehicle past the route's recent best, or others that started with it already further on — with the driver's name, to call him). Vehicles ranked by days a trip faster / slower than their peers, **⚠ Underperforming** (≥ 1 day a trip slower than the typical peer, or 40%+ slow trips), *Slipping* (≥ ½ day), *★ Top*; days and freight lost; stage by stage; **by driver** — the trips each driver drove, on whichever truck, ranked the same way; the slowest trips with the stage that lost the time and who drove. | Trip Register, HSD Data, Driver Payment |
| **Drivers** | Each trip: driver salary − your advances = what SSFC should pay; trips SSFC paid more; **overpaid drivers** (each driver's spell on a vehicle, with Driver Debit as money owed back); **each vehicle's driver now** (the drivers list); **driver changes** — who took over which truck on which trip; **advances paid by driver** with the notes typed beside them. A vehicle's drivers page lists every spell with its trips and advances; a trip shows its driver and the advances paid during it. | Trip Register, Driver Payment + Setup → Routes |
| **Tyre & Fastag** | SSFC's monthly charges per vehicle: fleet total per month, a vehicle × month grid, and every month **out of the usual trend** (well above / below the fleet that month *and* the vehicle's own last six months, or booked twice). Tyre is compared month to month, fastag per trip — both per km once distances are set. Each vehicle's first two months aren't judged. Vehicles can be switched out of either analysis in Setup (tyre is off for 4010, 7010, 9010 to start with). | Trip Register |
| **SSFC** | What SSFC owes (with and without GST), how much should come in the SSL account vs be settled in cash, every invoice cleared oldest first with its age, earned vs received by month, payments received, the Bridgestone notes. | Ledger sheet |
| **Diesel** | Litres and ₹ by pump (SSFC / Vriddhi Fuels / SSL Own Filling / Extra / Other), per month and per place; the diesel recon per vehicle and trip by trip; urea by vendor. | HSD Data, Diesel Recon / Recon Engine, Rates, Urea DEF |
| **Share** (⇪ on each screen) | Data-rich pictures in the app's look, like the Ledger app's — **Share** (WhatsApp …), **Download**, or one **PDF** of the pages. **SSFC account**: what SSFC owes (with / without GST), every pending invoice with its age, month by month, every payment. **Vehicle statement** for the period chosen: every trip by month with freight, SSFC cut, own costs and net, where the freight went, the diesel recon; or the **diesel recon** trip by trip. **Trip**: the bulker drawing, dates, weights, the money line by line, each diesel fill, the driver's advances. **Driver**: his spell on the truck — trips checked against salary, every advance with its note, trips driven (to send to the driver). **Fleet report** for the period: by vehicle, route and month, SSFC today. **On the road now**: every bulker with its route, stage and pace. | everything above |
| **Diesel per trip** | Every trip against its allotment (route diesel + overload − underload; the route's diesel until it's loaded): **allotted, taken** (the fills tagged to it: SSFC's diesel + our own bought for the trip when SSFC can't supply — *OWN DIESEL for Trip*, shown apart with its cost; *Own Diesel Extra* is the drivers' incentive diesel, settled, and isn't counted), **to take, extra** over the allotment, what it **carries in** from earlier trips (extra taken before is owed and comes off the next trips), what it **may still take**, and the **balance** it leaves — on the trip page (with a bar), each road card on Home, the vehicle's diesel page, and **Diesel on the road now** at the top of the Diesel tab (extra owed in litres and ₹, trucks over their allotment now, still to fill). **Fills that may be missing**: a trip with far less diesel tagged than allotted (under 75% of it and 100 L+ under the route's usual) — or a truck on the road past its usual refill day with none entered — is flagged on the trip, in the trips list (*Diesel fill missing?* filter), Home's road cards and a list on the Diesel tab (by month, for the monthly reconciliation); normal savings (to ~20% under) aren't. The owner's insight has a Diesel section and every truck in the drivers' Hindi instructions gets its diesel line (“अब X लीटर और ले सकते हैं” / “ज़्यादा लिया डीज़ल अगली ट्रिप में कटेगा”). | Trip Register, HSD Data, Recon Engine |
| **Loads** (everywhere) | The RTO overload fee is paid, so **fuller is better**: each load is graded against the best load on the same route around the same time (±15 days) — *full* (green, ≤ 0.5 T below), *near full*, *under* (amber, ≤ 3 T), *well under* (red) — with the freight it left behind (gap × rate). Gross over the RTO 56 T shows green (“overload · RTO paid ✓”), under it red; the bulker hatches overload green. Trips list colours and an *Under-loaded* filter, the vehicle's “load vs the best”, the day book and the share pictures use the same. | Trip Register |
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
  driver's salary (Setup, else the Rates sheet's *Driver Payment*, else what
  the route usually costs) − urea (as logged, or the average) − own misc
  logged on the trip. It is the **trip's own** income: SSFC's fastag, tyre,
  maintenance and RTO come once a month after a number of trips, and the EMI
  is monthly, so neither is charged to a single trip — they're shown apart
  (the vehicle's usual a month). A yearly cost booked on the trip (road tax,
  insurance, permit, fitness … in the remarks) is left out too.
- **Distance**: a route's round trip in km comes from Setup, else the Rates
  sheet's *RTD/Trip in Km*.

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
- **Who drove which trip** (Driver Payment sheet): the Trip Register's Trip
  Driver Payment adds up the advances paid on a vehicle between a trip's start
  and the vehicle's next trip start, so the drivers paid in that window drove
  it — the last one, when there are two (a new driver takes his first advance
  on his first trip). A trip without an advance keeps the driver before it;
  trips before a vehicle's first advance get its first driver. A payment noted
  as a settlement (security, bonus, balance, voucher clear, last trip …), a
  former driver paid once more while the new one carries on, and a payment to
  someone driving another truck at the time don't change who's driving.
  Names are matched loosely (Rafiq / Rafik, Ramesh / Ramesh Kumar) and
  shown as the drivers list spells them; the drivers list is who drives each
  truck now. Only names are read from it, not licence or bank details. The
  upload preview checks the advances add up to the Trip Driver Payment
  column. A workbook without the sheet falls back to remarks saying "New
  Driver" / "Driver Changed".
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

Keep entering, editing and deleting trips, advances, HSD, urea and the SSFC
ledger in Excel. Save the workbook, then upload it here (from the phone too).

- **Each upload replaces the saved data as a whole**: the app shows exactly
  what the file has, so an edit or a deleted row in Excel is reflected as it
  is. Nothing is merged, so nothing goes stale. The newest 10 uploads are kept
  in the database.
- **Before saving, the preview checks the file:**
  - Excel error values (#N/A, #VALUE! …) in a column the app reads;
  - half-filled rows: a trip without a vehicle, or an advance without a date
    or vehicle;
  - the same trip twice;
  - a trip without a start date;
  - Gross Weight, Excess/Short, Trip Bhada, SSFC Net Amount, Income/Trip and
    Trip Driver Payment that don't match their formulas (Excel not
    recalculated, or a formula typed over);
  - advances on a vehicle with no trips, dated before its first trip or after
    today;
  - recent one-off driver names (a possible misspelling);
  - the drivers list naming two drivers for one truck.
- **It also shows what the file changes against what's saved right now**
  (fetched at that moment, so another device's upload counts):
  - trips added, edited (field by field, old → new) and deleted; trips are
    matched by vehicle and trip number, so inserting or deleting rows doesn't
    confuse it;
  - advances, HSD fills, urea, Ledger and drivers-list entries added and
    removed.
- **Saving is stopped until you tick "save anyway"** when the file looks like
  an old copy or is missing data:
  - a sheet that's saved now is empty;
  - its newest trip is older than the saved one;
  - 3+ saved trips are missing;
  - 3+ trips lost a loading / unloading date or weight;
  - 5+ fills, urea entries or advances are gone.
- **Two people saving at once:** if someone saved while you were looking at
  the preview, your save is stopped and the file is compared again with what
  they saved.
- **Another device uploads:** a tab left open loads the newer data when it
  comes back into view (or shows a notice with *Load it* while an upload or
  Setup is open). It checks every 5 minutes while open.
- **Setup changed on another device** since this page loaded it: you're asked
  before your save replaces it.

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
| `js/daybook.js` | The day book: every dated entry, the date ranges |
| `js/tripdiesel.js` | Each trip's diesel: allotted, taken, to take, extra, carried in, may still take |
| `js/load.js` | Each load against the best on its route then; targets |
| `js/brief.js` | Today's brief: owner's insight, drivers' instructions (Hindi) |
| `js/share-svg.js` | The share pictures (pages and cards) |
| `js/render.js` | Pictures → JPEG / PDF / zip, the font and the bulker's look for them |
| `js/checks.js` | Checks on a freshly read workbook (formulas, duplicates, advances, names) |
| `js/changes.js` | What an upload changes against the saved one; when to stop and ask |
| `js/drivers.js` | Who drove which trip (Driver Payment sheet), names matched loosely, the driver now |
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
