# Vriddhi Fuels — Tanker Loading Log

A dead-simple, installable PWA for employees to fill diesel tankers in many small
loadings and keep a running account of each tanker's fill level. Built for a
low-literacy user: big buttons, big numbers, live progress bars, and a number-pad
keyboard for every quantity. English only.

> This is a **fourth, separate app** in this repo — independent of the Master
> Ledger at `/index.html`, the Indent PWA at `/app/`, and the Tally app at
> `/tally/`. It lives entirely under `/loading/` and is 100% static.

## Two modes

The app auto-detects its mode from [`config.js`](./config.js):

- **Cloud mode (recommended for multiple employees)** — fill in your Supabase
  URL + anon key and every employee signs in with a username + password. All
  phones share **one live set of tankers**: a save on one phone updates every
  other phone **instantly** (Supabase realtime), so everyone sees the same fill
  levels. History is **kept for the last 7 days only**. Each record stores **who
  did it**, and records use the **server's clock**, not the phone's.
- **Single-device mode (zero setup)** — leave `config.js` as its placeholders
  and the app runs with **no server and no login**, storing records in that one
  phone's browser storage (kept until you clear it). Fine for one shared phone.

## How it works (the fill model)

A tanker is filled in **many small loadings**, and each tanker keeps a **running
fill level that accumulates** across those loadings. It does **not** reset when a
chamber becomes full. When the whole tanker is full it is **sent for sale**; that
empties the tanker's gauge, and when it comes back it starts filling from empty
again.

1. **Home shows a card per tanker** with a big fill bar, the current litres
   (e.g. `5,485 / 11,955 L`), how much is **left to fill**, and how many chambers
   are full. A full tanker shows a green **FULL ✓** badge.
2. **Tap a tanker → Add diesel.** Each chamber shows what is **already in it**
   (`1,500 / 3,985 L`) with a two-tone bar — the darker part is what's already
   there, the brighter part is what you're **adding now**. The **Add litres** box
   is always blank; type the litres you're loading and **Left to fill** for that
   chamber updates live. A sticky summary shows the tanker total after this save
   and the litres left to fill. The home card also lists **left to fill per
   chamber** and for the **whole tanker**, so it's clear at a glance.
3. **Save** → a check-and-confirm screen → the tanker's fill goes up by that
   amount. Do this as many times as you like; it keeps adding.
4. **When the tanker is full, tap “🚚 Sent for sale”** (a bold green button on a
   full tanker; a quiet link on a partly-filled one). A box asks **whom it was
   sold to / remarks** (optional); confirm, and the tanker empties back to `0` —
   ready for the next round. The sold-to note is saved on the record and shown
   in History and the Excel report.

Every loading (`+ litres`) and every dispatch (`🚚 Sent for sale`) is kept in
**History** and the export, so the full account of what went into each tanker and
when it was sent out is preserved.

## Vehicles & chambers (fixed in the app)

| Vehicle | Chambers | Capacity each |
|---|---|---|
| **OD23A3710** | C1, C2, C3 | 3,985 L |
| **OR15R1110** | C1, C2, C3 | 3,985 L |
| **OR15R5510** | C1, C2, C3 | 3,985 L |
| **OR15R9360** | C1, C2, C3, C4 | 4,485 L |

These are just the **seed defaults**. Tankers are now managed in-app (see below),
so you add or remove vehicles without touching any code. In cloud mode the tanker
list is shared across all employees.

## Manage tankers & data (⚙)

The **⚙ Manage tankers & data** link at the bottom of the home screen opens a
small admin screen:

- **Tankers** — lists every tanker with its chambers and full capacity, each with
  a 🗑 to remove it (with a confirm; past records stay in History).
- **Add a new tanker** — type the vehicle number, pick the number of **chambers**
  (− / +) and the **litres per chamber**, then **Add tanker**. It appears
  immediately as a new card on the home screen (and, in cloud mode, on every
  employee's phone).
- **Danger zone → Clear all records** — deletes **all** loading & sale records
  (which also empties every tanker); the tankers themselves are kept. Requires
  typing `CLEAR` to confirm. In cloud mode this clears the shared data for
  everyone.

## Cloud setup (one time)

1. Create a **new** Supabase project (free tier) — do **not** reuse the indent
   or tally project.
2. In its **SQL Editor**, run [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql)
   (safe to re-run). It creates the `loading_events` and `loading_vehicles`
   tables (seeded with the four tankers), the read policy that only exposes the
   last 7 days of records, the write functions (add / delete / clear / add-vehicle
   / remove-vehicle), realtime, and — if `pg_cron` is available — an hourly purge.
   Re-run it after pulling updates; it is written to be safe to re-run.
3. **Authentication → Users → Add user** for each employee: email
   `<username>@vriddhi.local` (e.g. `ramesh@vriddhi.local`), a 6+ char password,
   tick *Auto Confirm User*. Employees sign in with just the username + password.
4. Paste the project's **URL** and **anon/publishable key**
   (Project Settings → API) into [`config.js`](./config.js) and deploy.
5. On each phone: open `/loading/`, sign in, Add to Home Screen.

Every signed-in employee has equal rights (add / delete / export). The anon key
alone can read or write nothing — access is gated by sign-in and Row Level
Security, and all writes go through server functions.

### How the 7-day retention is enforced

It holds three ways, so a week is the most that is ever kept:

1. The read policy only returns rows from the **last 7 days** (older rows are
   invisible even before deletion).
2. Every save also deletes rows older than 7 days, and the app calls
   `loading_purge()` on open.
3. If `pg_cron` is installed, it purges hourly on a schedule too.

> A tanker's current fill is computed from its loadings since its last
> **dispatch**, all within this 7-day window — which is fine because a fill →
> sale cycle takes far less than a week. (If a tanker were left partly filled for
> more than 7 days, the oldest loadings would age out of the window.)

## Records & backup

- Every record stores the **date, time, vehicle, type (Load / Sent for sale),
  per-chamber litres, total**, and (cloud mode) **who did it**.
- **History** (“View all”) groups records by day and shows each loading as
  `+ litres` and each dispatch as `🚚 Sent for sale`, with a per-day loaded
  total. You can delete a wrong entry (with a confirm); the tanker's fill
  recalculates automatically.

## Reports (📊) — data-rich Excel

**Reports** (button on the home screen and in History) shows headline figures
for a chosen **date range** (From/To, with **Today / 7 days / All** presets):
litres loaded, loadings, litres sold, tankers sold, and a per-tanker breakdown
with each tanker's current fill.

**View chamber log (detailed)** opens an on-screen log for the chosen range —
one row per **chamber per transaction** (chamber, vehicle, time, `+`litres loaded
or `−`litres emptied on a sale, with the sold-to name), newest first and grouped
by day. It's the same breakdown as the Excel "Chamber log" sheet, right in the app.

**Download Excel report** produces a multi-sheet `.xlsx`
(`Vriddhi_Tanker_Report_<from>_to_<to>.xlsx`) built with
[SheetJS](https://sheetjs.com) — it **falls back to a CSV** of the transactions
if the device is offline. Sheets:

| Sheet | What's in it |
|---|---|
| **Summary** | Report metadata + headline totals + current fill per tanker |
| **Transactions** | The full statement — one row per event: *Date · Time · Vehicle · Type · C1–C4 · Total · **Tanker after** (running fill) · **Remarks / Sold to** · By*, with an auto-filter |
| **Chamber log** | One row **per chamber per transaction** — *Date · Time · Vehicle · Chamber · Litres · Type · Remarks · By* — the easiest layout to reconcile chamber by chamber |
| **By tanker** | Per-vehicle: capacity, loadings, litres loaded, tankers sold, litres sold, current fill, status |
| **By day** | Per-day loadings / litres loaded / tankers sold / litres sold |

Litres columns are thousands-formatted and columns are pre-sized. Since cloud
data only spans 7 days, download a report weekly to keep a longer archive.

> In **single-device mode** the records live in that phone's browser storage;
> clearing the browser's site data or uninstalling erases them, so the periodic
> CSV export is the backup. In **cloud mode** the data lives in Supabase and is
> intentionally trimmed to the last 7 days.

## Install on the phone

It's static — host the `/loading/` folder anywhere (it deploys with the rest of
this repo on GitHub Pages, at `/loading/`). On the phone, open it in
Chrome/Safari and **Add to Home Screen**. After that it opens full-screen like a
normal app. Single-device mode works fully offline; cloud mode needs internet to
sign in and sync.

## Notes

- In cloud mode, times use the **server's clock**; in single-device mode, the
  phone's clock.
- Quantities accept whole litres only; if a chamber's already-in amount plus what
  you're adding would exceed its capacity, the bar turns red with an “⚠ Over full”
  warning, but it still lets you save (in case of a genuine top-up).
- The **🚚 Sent for sale** button appears once a tanker has any diesel in it —
  bold and green when the tanker is full, a quiet link when it's only partly
  filled. It always asks for confirmation before emptying the tanker.
