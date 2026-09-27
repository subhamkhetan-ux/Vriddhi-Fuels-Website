# Vriddhi Fuels — Tanker Decanting (`/decant/`)

A phone app for decanting tank trucks into the underground tanks: it knows
what each truck carries (from the IndianOil invoice), reads the tank stock
from the automation's screenshots, picks the chambers for each tank, and
records the stock before and after — so every decantation ends with the
**variation** between what the chambers held and what the tank actually
gained. The reports show per product what was decanted, bought and is still
**in transit**, and the variation by day, truck, product, tank and month; the
**Plan** tab works out the least to dispense from each tank so the loads
you've placed an indent for fit.

It is a separate app (like `/payments/`, `/ledger/`, `/tally/`), installable
as a PWA, in the same glassmorphism style as the payments app.

## One-time setup

The app has its **own Supabase project** — never the payments one, so it
can't use up the payments project's free-tier limits (database, bandwidth,
realtime).

1. **New project** — on [supabase.com](https://supabase.com) create a new
   project (the free plan is fine; it limits how many active free projects
   one account can have, so this may need another account).
2. **Schema** — in that project open *SQL Editor*, paste
   [`supabase/decant-schema.sql`](../supabase/decant-schema.sql) and **Run**
   (safe to run again).
3. **Config** — *Project Settings → API Keys*: put the **Project URL** and the
   **publishable key** in [`decant/config.js`](./config.js) (replacing the
   `PASTE_…` placeholders) and commit. Never a secret / service_role key.
4. Open **`/decant/`** (e.g. `https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/decant/`)
   and *Add to Home Screen*.

The payment agent reads `decant/config.js` too, and from its next run (every
~20 min) stores every IndianOil invoice in the new project — it doesn't use the
payments secrets for this, refuses to run if the config points at the payments
project, and runs after the payments work is done: a problem there is only
logged, never a failed payments run. Until the config is filled in, the app
works on one phone only and the agent skips it.

**Moving off the payments project** (the first version used it):

- Each phone that used the app sends its copy — decantations, invoices, tank
  stock, settings, indents — to the new project the first time it opens with
  the new config. A row goes across only if the new project doesn't have it
  yet or has an older version, so a phone that was closed for a while never
  overwrites newer work from another phone; a phone that's offline then
  keeps everything and tries again. Nothing is lost.
- To avoid any "this phone only" gap, put the new project's URL and key in
  `decant/config.js` **before** merging this change — then phones go
  straight from the old project to the new one, still in sync.
- The agent starts over in the new project, so it back-fills the recent
  invoices there too.
- Then run
  [`supabase/decant-remove-from-payments.sql`](../supabase/decant-remove-from-payments.sql)
  in the **payments** project. It drops only the `dec_*` tables, view and
  function.

On the first days the agent also brings in invoices from before the app was in
use; the app offers to **hide invoices from before today** (they were decanted
already), and older ones fold away under *Older* with a *Dismiss all*.

Hiding an invoice (its **⋯** menu) says why, which decides how the reports
count it:

- **Already decanted (outside the app)** / *hide invoices from before today* /
  *Dismiss all* — still a **purchase**, shown as *decanted outside the app*.
- **Not for our tanks** or **Delete** — not counted at all.

## Where the invoices come from

The payment agent (GitHub Actions, `agent/decant.py`) reads every IndianOil
tax invoice PDF in the HDFC mailbox — the same mails the payments app uses —
and stores in this app's own project, for each: the truck (TT) number, invoice no./date/time, each
product with its quantity, **"Comp No(s)"** (which chambers it was loaded
into), its Density@15, the seal/lock numbers, and the truck's **chamber
table** (`PL - cm · DIP - Cm · QTY - kl` at the foot of the invoice).

If a truck arrives before the agent has picked its invoice up (it runs every
~20 minutes), add it on the spot:

- **⬆ PDF** — pick the invoice PDF; the app reads it the same way.
- **＋ Add** — type the TT number (a truck seen before fills its chambers in),
  tap the product in each chamber.

Each chamber's product comes from **Comp No(s)** on the invoice. When an
invoice doesn't list them, **MS is taken from chamber 1 upward** (C1, C2 …
until the MS quantity) and the other products take the next chambers — you can
change any chamber on the first step.

## Decanting a truck

Tap **Start decanting** on the truck's card:

1. **Truck** — the chambers and their products, the **seals** to check, and an
   optional **density check**: type the hydrometer reading and temperature of
   the truck's sample; the app works out the density at 15 °C (ASTM D1250
   Table 53B) and compares it with the invoice's Density@15 (± 3 kg/m³ by
   default).
2. **Before** — the stock of the tanks that can take this product.
   **📷 Read a screenshot** of the automation's tank page (one screenshot can
   show all four tanks), or **✎ type** the stock in litres or as a **dip in cm**.
   Every reading shows both the litres and the dip.
3. **Plan** — for each product, type **how many KL go into each tank**; the app
   picks the chambers that make it (tap a chamber to move it or hold it back).
   It starts with a suggestion: as much as fits, the tank with the most room
   taking the first chambers, and never leaving a tank with less than 150 L of
   room unless nothing else fits. The plan **only allows the same product**,
   never more than the tank's **ullage**, and shows every tank's stock and dip
   after decanting. A tank already being decanted from another truck can't be
   used. Chambers that don't fit **stay in the truck** — the invoice stays on
   the list as *Part decanted* for later.
4. **Decant** — **▶ Start decanting**, then **✓ Decanting done**. Untick any
   chamber that wasn't emptied.
5. **After** — after the level settles (the app counts down 10 minutes), read
   the **after screenshot** or type the stock. If sales ran from the tank
   while decanting, type the **litres sold**.
6. **Result** — per tank:

   ```
   variation = (stock after − stock before) − (chambers' litres − litres sold)
   ```

   negative = the tank got **less** than the chambers held (short). It is **OK**
   within ±0.25 % of the load or ±25 L (whichever is more), **Watch** up to
   twice that, and **High** beyond. The value at the invoice price is shown too.

**Chambers in the wrong tank?** If one tank came out well over and another
of the same product well under, the app works out which chambers most
likely went where from the stock and offers to fix it in one tap (or set it
yourself: *Which chamber went where?*).

## Reading the automation screenshots

The screenshot is read on the phone (Tesseract.js — nothing is uploaded) twice,
cleaned up two ways, and each tank card's figures are checked:

- **volume + ullage = capacity** (20,000 L), and
- **the dip chart** at the card's *Product Height* agrees with its volume.

Two readings that agree fix a misread digit on their own (the badge says
*Fixed & checked*); if nothing agrees you're asked to check the figure, which
is always editable. The card's **Last Updated** time is read too: the app warns
when a before-reading is more than 30 minutes old, and when an "after"
screenshot was taken before decanting finished. Any tank on the screenshot also
updates the **Tank stock** tiles on the home screen (📷 Stock does just that).
Tested on the four sample screenshots, their WhatsApp-compressed and shrunken
copies and a blurred, tilted "photo of the screen": every volume was read
correctly.

## Dip chart

The app carries the 20 KL tanks' dip chart (`DIP_Chart.xlsm`, 1.0–209.0 cm
every 0.1 cm), which matches the automation's own volumes to within a litre.
One fix was made: the sheet's rows 143.2–143.9 cm all read 15,687.45 L (143.0
cm's value copied down); they're put back on the line from 143.1 to 144.0 cm
(e.g. 143.5 cm = 15,748.49 L). Correct the Excel sheet too. **Settings →
Upload a chart** takes a new chart (.xlsx/.xlsm/.csv, dip in the first column,
litres in the second) for every phone; **📏** converts dip ↔ litres.

## Plan: what to dispense before the indented loads

The **Plan** tab answers one question: *how little do I have to dispense from
each tank so the loads I've placed an indent for fit?*

1. **Stock now** — each tank's latest reading: the stock after the last
   decanting, or the last screenshot. **✎ Type** a new figure (litres or a dip)
   or **📷 Screenshot** to update it.
2. **Indents placed** — **＋ Add an indent** for each load: the tanker (its
   chambers fill in for a truck seen before, or type them) and the **KL of each
   product** (MS goes from chamber 1 up, then HSD, then XtraGreen; tap a chamber
   to change it). **Clear all** once they've been decanted.
3. **Dispense first** — per product and tank: the litres to **dispense**,
   which chambers go into which tank, and the stock and dip after. All the
   chambers of a product (from every indent) are split over its tanks together,
   picking the split that needs **the least dispensing in total**, then the
   most even, keeping the 150 L room margin. Chambers go in whole, so the
   figure can be a little above "incoming − room".
4. **Our tankers** — sign in once on the phone with a **Loading app** login;
   the app reads how full each of our own tankers is (read-only, live) and
   shows the free space, leaving out **OD15AF5510** (change the list in
   *Settings*). The diesel card then says whether our tankers can take the
   diesel to be dispensed.

## Log and reports

- **Log** — every finished decantation of *today, 7 days, this month or last
  month*, one row per tank filled, with filters by truck and product, search,
  and **⬇ Excel / CSV**. Tap a row for the full result and notes.
- **Reports** — for **this month** (the default), **last month**, **this FY**
  (from 1 April), **all** (this FY and the last) or any dates, and any truck /
  product:
  - a **card per product**: KL **decanted** (by the day it went into the
    tank), net variation, and KL **purchased** (by invoice date) split into
    *decanted in the app*, *decanted outside the app* and **in transit** —
    with each truck in transit: TT no., KL, chambers left, invoice no., date
    and time, and whether it is part-decanted, being decanted now or days old
    (decanted outside the app? hide it on the Decant tab);
  - the variation: decanted KL, net variation, short / excess, how many were
    outside tolerance, the value at invoice price and the worst one; **net
    variation per day** (per month for periods over two months); **every
    decantation** on a timeline against the tolerance band; and tables **by
    truck** (tap one to see only its trips), **by product**, **by tank** and
    **by month**; **⬇ Excel** of the period.

## What is kept

- **Decantations and invoices**: this financial year and the last, in the
  cloud. The phone keeps this month and last; *This FY* / *All* reports fetch
  the older months from the cloud (compact, via `dec_history`) when opened.
- **Screenshots are never kept** — they're read on the phone and only the
  figures are saved.

## Several phones at once

Every phone opening `/decant/` uses the same project (from `decant/config.js`)
and sees the others' work live: new invoices, stock readings, indents and the
Plan's advice, a decantation in progress (its tanks show as busy, and a second
phone is offered *Continue* rather than a second start).

## Offline

Everything is saved on the phone first. With no signal the pill says
*offline · n to send*; the changes go to the cloud when the connection is
back, and other phones see them live.

## Settings (⚙)

Tank products and capacities, the variation tolerance, the room warning, when
a reading counts as old, the settling wait, the density limit, how many days
of undecanted invoices to list, our tankers to leave out on the Plan tab
(OD15AF5510 by default), the automation's date format (MM/DD/YYYY by default),
and the dip chart.

## Files

| File | What |
|---|---|
| `index.html` | The page and its styles |
| `config.js` | Supabase URL + publishable key of the app's own project |
| `js/app.js` | Home screen, stock screenshots, invoices, settings |
| `js/wizard.js` | The six decanting steps |
| `js/views.js` | Log and reports |
| `js/plan.js` | The Plan tab: stock now, indents placed, what to dispense |
| `js/tankers.js` | Our tankers' free space, read from the Loading app (sign-in) |
| `js/core.js` | The rules: dip chart, chambers, planning (decanting and dispensing), checks, variation, density |
| `js/automation.js` | Reading tank cards out of the screenshot text |
| `js/ocr.js` | The in-browser text reader (Tesseract.js) |
| `js/invoice.js` | Reading an invoice PDF in the browser (pdf.js) |
| `js/report.js` | Report maths (by day / truck / product / tank / month, purchases and in transit, periods, export) |
| `js/charts.js`, `js/xlsx.js`, `js/ui.js`, `js/store.js`, `js/dipchart.js` | Charts, Excel export, UI bits, storage + sync, the dip chart |
| `../agent/decant.py` | The agent side: invoices → `dec_invoices` |
| `../supabase/decant-schema.sql` | The tables (in the app's own project) |
| `../supabase/decant-remove-from-payments.sql` | Takes the `dec_*` tables out of the payments project, if they were ever put there |

Tests: `python -m pytest tests/test_decant.py tests/test_decant_schema.py
tests/test_decant_web.py tests/test_invoice.py` (the web ones run
`node --test tests/decant_web`).
