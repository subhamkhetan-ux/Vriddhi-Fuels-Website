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
- **＋ Add** — type the TT number (one of our own TTs fills its chambers in;
  for a transport TT tap its standard layout or type the chambers), tap the
  product in each chamber.

Each chamber's product comes from **Comp No(s)** on the invoice. When an
invoice doesn't list them, **MS is taken from chamber 1 upward** (C1, C2 …
until the MS quantity) and the other products take the next chambers — you can
change any chamber on the first step.

## Our TTs and transport TTs

- **Our own TTs** — OD23U8210 to start with — have their chambers saved in
  *Settings* (add one there, or with **＋ Our new TT** when adding an indent).
  Their invoices are marked **Our TT**.
- **Every other TT is a transport TT.** Their chambers aren't remembered: a
  transport TT has one of the standard layouts of its size (*Settings →
  Transport TT layouts*), and none is smaller than 20 KL:

  | Size | Chambers from C1 (KL) |
  |---|---|
  | 20 KL | 5+5+5+5 or 4+4+4+4+4 |
  | 22 KL | 4.5+4.5+4.5+4.5+4 or 5+5+4+4+4 |
  | 23 KL | 5+5+5+4+4 |
  | 24 KL | 5+5+5+5+4 |
  | 25 KL | 5+5+5+5+5 |

  The invoice normally carries the chamber table. When it doesn't, the
  truck step offers the layouts of the truck's size that can carry the
  invoice's products in whole chambers — tap the one it is.

## How full a tank may be filled

Our 20 KL IndianOil tanks hold about 21,000 L and are filled up to
**20,500 L**. The automation's ullage is measured to 20,000 L, so the app
counts a tank's **room** as *20,500 L − stock* instead — 500 L more than the
ullage on the screen — everywhere: the tank tiles, the Plan step (which never
plans past 20,500 L), the room check on each truck and the Plan tab. Stock
readings up to that (and beyond, as read) are taken as they are. The limit is
per tank under *Settings → Tanks → Fill up to*.

## Decanting a truck

**Room check.** Each truck under *To decant* shows, for each product, whether
its tanks have room for it now — on each tank's latest stock, keeping the
150 L room margin — the Plan tab's sums for this truck alone:

- **✓ Room now** — which chambers go into which tank, and each tank's stock
  and dip after (what the Plan step will suggest), or
- **Dispense X L first** — how much to dispense from each tank so every
  chamber fits, the least in total, and which chambers then go where.

A truck with no chamber table is planned for any standard layout of its size.
A tank being decanted from another truck isn't counted until its stock after
is read. An old stock reading, and another truck waiting with the same
product, are pointed out.

Tap **Start decanting** on the truck's card:

1. **Truck** — the chambers and their products, and an optional **density
   check**: type the hydrometer reading and temperature of the truck's sample;
   the app works out the density at 15 °C (ASTM D1250 Table 53B) and compares
   it with the invoice's Density@15 (± 3 kg/m³ by default).
2. **Before** — the stock of the tanks that can take this product.
   **📷 Read a screenshot** of the automation's tank page (one screenshot can
   show all four tanks), or **✎ type** the stock in litres or as a **dip in cm**.
   Every reading shows both the litres and the dip.
3. **Plan** — for each product, type **how many KL go into each tank**; the app
   picks the chambers that make it (tap a chamber to move it or hold it back).
   It starts with a suggestion: as much as fits, the tank with the most room
   taking the first chambers, and never leaving a tank with less than 150 L of
   room unless nothing else fits. The plan **only allows the same product**,
   never more than the tank's **room** (up to 20,500 L), and shows every tank's stock and dip
   after decanting. A tank already being decanted from another truck can't be
   used. Chambers that don't fit **stay in the truck** — the invoice stays on
   the list as *Part decanted* for later.
   Then either:
   - **▶ Start decanting into all** — every tank at once, or
   - **Tank by tank** — start each tank when you're ready, e.g. Tank 2 now
     and Tank 3 later.
4. **Decant** — at the top, the truck and the tanks as they are: our TT
   (its number and capacity on the tank), a sight glass per chamber, the
   bottom-loading valves, and a hose from each chamber to its tank's fill
   point — flowing in the product's colour while that tank decants, the
   planned level shimmering in the tank; *next* tanks show a dashed hose,
   *settling* ones sit at their new level, *done* ones show a ✓. The same
   picture runs on the Home screen's *In progress* card, and a tank tile
   being filled shows where it will reach. (Motion stops if the phone is set
   to reduce motion.) Then one card per tank, each going *not started →
   decanting → settling → stock after read*:
   - **▶ Start Tank N**. A tank sells until its decanting starts, so its
     stock before must be from just before it starts: a reading from before
     the first tank started (or over 30 minutes old) is questioned — take a
     new screenshot or type it. The room is checked again with that reading.
   - **✓ Tank N done** — untick any chamber that wasn't emptied (it stays in
     the truck).
   - After the level settles (the app counts down 10 minutes per tank), read
     its **stock after** — **📷 Screenshot** reads each tank's stock before or
     after, whichever it needs, from one picture.
   - **Not now — keep in the truck** leaves a tank not started out; its
     chambers stay in the truck for later.
   The IndianOil automation blocks sales from a tank while it is decanted, so
   nothing is sold in between: each tank is measured on its own window.
5. **Result** — per tank, with its own times:

   ```
   variation = (stock after − stock before) − chambers' litres
   ```

   negative = the tank got **less** than the chambers held (short). It is **OK**
   within ±0.25 % of the load or ±25 L (whichever is more), **Watch** up to
   twice that, and **High** beyond. Positive (**excess** — the tank got more)
   is good for us and shows in **green** everywhere, still marked by its size
   (▲ *Excess*, ▲ *High excess*). The value at the invoice price is shown too.
   **📤 Share as picture** makes a PNG of the result (the truck, each tank's
   before / after / gain / chambers / variation, and the ₹ value) to send on
   WhatsApp or save.

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
litres in the second) for every phone; **📏 Dip → Convert litres ↔ dip**
converts without saving anything.

## Stock by dip

When no automation screenshot can be taken, dip the tanks by hand: **📏 Dip**
on the Decant tab lists every tank — type each one's dip in cm and its litres
(and the room left) fill in from the dip chart as you type. **Save** stores
the tanks typed as readings taken now, for every phone; a tank left empty
keeps its stock, and a dip outside the chart is refused. For one tank, tap its
tile and type its dip there.

## Internal audit: what's behind each stock

Every stock reading keeps where it came from, and the app remarks on it:

- **Proof** — read from an **automation screenshot**, or from a **physical dip**
  (the dip is kept; the litres come from the dip chart). A screenshot figure
  corrected by hand still counts — the automation has its data errors — and
  the screen's own figure is kept with it (*"corrected by hand (the screen
  said 12,519.45 L)"*).
- **No solid proof** — the litres were typed in by hand.

It shows on the tank's sheet (tap a tile), under each reading in a
decantation, as *"✎ typed, no proof"* on a tile or a Log row, on the Result
(each stock's source, and one audit line) and on its shared picture, and in
the Excel / CSV export as three last columns: *Stock before from*, *Stock
after from* and *Stock proof* (Yes / No — typed litres). Nothing is
calculated differently; readings saved before this remark existed carry
their source already. For months older than the phone keeps, the FY export
has the sources once `supabase/decant-schema.sql` has been re-run (it's safe
to re-run).

## Plan: what to dispense before the indented loads

The **Plan** tab answers one question: *how little do I have to dispense from
each tank so the loads I've placed an indent for fit?*

1. **Stock now** — each tank's latest reading: the stock after the last
   decanting, or the last screenshot. **✎ Type** a new figure (litres or a dip)
   or **📷 Screenshot** to update it.
2. **Indents placed** — **＋ Add an indent** for each load, as many as you've
   placed:
   - **Our TT** (the default: OD23U8210, or another of ours from the list) —
     type the **KL of each product**; MS goes from chamber 1 up, then HSD, then
     XtraGreen (tap a chamber to change it). **＋ Our new TT** adds a TT of
     ours with its chambers, kept for next time.
   - **Transport TT** — type only the **KL of each product** (20 KL or more).
     Which truck comes isn't known, so the plan makes room for **every
     standard layout of its size** — 22 KL as 4.5+4.5+4.5+4.5+4 or as
     5+5+4+4+4. Each product fills the whole chambers closest to its KL, MS
     from C1: MS 5 + HSD 17 in a 4.5 KL-chamber TT is planned as MS 4.5 +
     HSD 17.5.

   **✎** changes an indent, **✕** removes it, **Clear all** removes them all.
3. **Off the plan as the invoices arrive** — an indent comes off by itself
   when its invoice comes in during the day: for our TT, that TT's next
   invoice; for a transport TT, the next invoice from a TT that isn't ours
   (the closest in KL first). Only invoices that come in after the indent was
   added count, so a TT's previous trip never clears its next indent. It shows
   under **Arrived** at the bottom of the tab — **Not this one** puts it back
   if the app picked the wrong invoice — and leaves the list a day and a half
   later. The truck's
   card on the Decant tab then shows the room to make for it.
4. **Dispense first** — per product and tank: the litres to **dispense**,
   which chambers go into which tank (for a transport TT, **each way it can
   come**), and the stock and dip after. All the chambers of a product (from
   every indent) are split over its tanks together, picking the split that
   needs **the least dispensing in total**, then the most even, keeping the
   150 L room margin — and for a transport TT, the least that works **whichever
   layout comes**. Chambers go in whole, so the figure can be a little above
   "incoming − room".
5. **Our delivery tankers** — sign in once on the phone with a **Loading app** login;
   the app reads how full each of our own tankers is (read-only, live) and
   shows the free space, leaving out **OD15AF5510** (change the list in
   *Settings*). The diesel card then says whether our delivery tankers can take
   the diesel to be dispensed.

## Log and reports

- **Log** — every finished decantation of *today, 7 days, this month or last
  month*: **one card per invoice** with a line per tank filled (and the
  invoice's total variation), with filters by truck and product, search, and
  **⬇ Excel / CSV**. Tap a card for the full result and notes; an invoice
  decanted in two goes (part now, the rest later) is still one card, each line
  opening its own go.
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
and sees the others' work live: new invoices, stock readings, indents (and
their coming off the plan) and the Plan's advice, a decantation in progress (its tanks show as busy, and a second
phone is offered *Continue* rather than a second start).

## Offline

Everything is saved on the phone first. With no signal the pill says
*offline · n to send*; the changes go to the cloud when the connection is
back, and other phones see them live.

## Settings (⚙)

Tank products, capacities and how full each may be filled (20,500 L for our
20 KL tanks), the variation tolerance, the room warning, when
a reading counts as old, the settling wait, the density limit, how many days
of undecanted invoices to list, our delivery tankers to leave out on the Plan
tab (OD15AF5510 by default), the automation's date format (MM/DD/YYYY by
default), the dip chart, and:

- **Our TTs** — one per line with its chambers from C1: `OD23U8210: 5, 5, 4, 4, 4`
- **Transport TT layouts** — one size per line, its layouts split by `|`:
  `22: 4.5+4.5+4.5+4.5+4 | 5+5+4+4+4`

## Files

| File | What |
|---|---|
| `index.html` | The page and its styles |
| `config.js` | Supabase URL + publishable key of the app's own project |
| `js/app.js` | Home screen, stock screenshots, invoices, settings |
| `js/wizard.js` | The decanting steps, tank by tank |
| `js/shareimg.js` | The result as a picture (PNG) to share |
| `js/scene.js` | The decanting picture: truck, hoses and underground tanks (animated) |
| `js/views.js` | Log and reports |
| `js/plan.js` | The Plan tab: stock now, indents placed (our TTs, transport TTs), what to dispense |
| `js/tankers.js` | Our delivery tankers' free space, read from the Loading app (sign-in) |
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
