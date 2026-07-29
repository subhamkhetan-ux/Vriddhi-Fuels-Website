# Vriddhi Fuels — Tanker Loading Log

A dead-simple, installable PWA for employees to record how much diesel is loaded
into each tanker chamber. Built for a low-literacy user: big buttons, big
numbers, colour-coded tankers, English + Hindi labels, and a number-pad keyboard
for every quantity.

> This is a **fourth, separate app** in this repo — independent of the Master
> Ledger at `/index.html`, the Indent PWA at `/app/`, and the Tally app at
> `/tally/`. It lives entirely under `/loading/` and is 100% static.

## Two modes

The app auto-detects its mode from [`config.js`](./config.js):

- **Cloud mode (recommended for multiple employees)** — fill in your Supabase
  URL + anon key and every employee signs in with a username + password. All
  phones share **one live list**: a save on one phone appears on every other
  phone **instantly** (Supabase realtime). Data is **kept for the last 7 days
  only** — older loadings drop off automatically. Each record also stores **who
  loaded it**. Records use the **server's clock**, not the phone's.
- **Single-device mode (zero setup)** — leave `config.js` as its placeholders
  and the app runs with **no server and no login**, storing records in that one
  phone's browser storage (kept until you clear it). Fine for one shared phone.

## How the employee uses it

1. **Tap “⛽ New Loading”.**
2. **Pick the tanker** — four big colour cards, one per vehicle number.
3. **Type how many litres went into each chamber.** Each chamber has a big
   number box, a **Full** button (fills that chamber's capacity in one tap) and
   a **Clear** button. Multiple chambers can be filled in the same loading.
   Leave a chamber blank/0 if it wasn't filled. A running **TOTAL** shows at the
   bottom, and a chamber turns green once it has a quantity.
4. **Tap “✓ Save”** → a plain check-and-save summary → **“Confirm & Save”.**

The home screen then shows **today's total litres**, today's loading count, the
all-time totals, and the most recent loadings.

## Vehicles & chambers (fixed in the app)

| Vehicle | Chambers | Capacity each |
|---|---|---|
| **OD23A3710** | C1, C2, C3 | 3,985 L |
| **OR15R1110** | C1, C2, C3 | 3,985 L |
| **OR15R5510** | C1, C2, C3 | 3,985 L |
| **OR15R9360** | C1, C2, C3, C4 | 4,485 L |

To add/change a vehicle or capacity, edit the `VEHICLES` array near the top of
the `<script>` in [`index.html`](./index.html) — nothing else needs changing.

## Cloud setup (one time)

1. Create a **new** Supabase project (free tier) — do **not** reuse the indent
   or tally project.
2. In its **SQL Editor**, run [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql)
   (safe to re-run). It creates the `loading_events` table, the read policy that
   only exposes the last 7 days, the write functions, realtime, and — if
   `pg_cron` is available — an hourly purge.
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

## Records & backup

- Every loading stores the **date, time, vehicle, per-chamber litres, total**,
  and (cloud mode) **who loaded it**.
- **History** (“View all”) groups loadings by day with per-day and grand totals,
  and lets you delete a wrong entry (with a confirm). In cloud mode this shows
  the last 7 days shared across all employees.
- **Export to Excel / CSV** downloads the records as a spreadsheet
  (`Tanker_Loading_YYYY-MM-DD.csv`, opens in Excel / Google Sheets) with columns
  *Date · Time · Vehicle · C1 · C2 · C3 · C4 · Total* (plus *By* in cloud mode).
  Since cloud data only spans 7 days, export weekly to keep a longer archive.

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
- Quantities accept whole litres only; typing more than a chamber's capacity
  shows a gentle “⚠ More than full” warning but still lets you save (in case of
  genuine top-ups).
