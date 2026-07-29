# Vriddhi Fuels — Tanker Loading Log

A dead-simple, installable, **fully offline** PWA for an employee to record how
much diesel is loaded into each tanker chamber. Built for a low-literacy user:
big buttons, big numbers, colour-coded tankers, English + Hindi labels, and a
number-pad keyboard for every quantity.

> This is a **fourth, separate app** in this repo — independent of the Master
> Ledger at `/index.html`, the Indent PWA at `/app/`, and the Tally app at
> `/tally/`. It lives entirely under `/loading/`, is 100% static, needs **no
> server, no login, and no setup**, and stores its records in the phone's own
> storage (`localStorage`).

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

## Records & backup

- Every loading is stored on the phone with the **date, time, vehicle,
  per-chamber litres, and total**. Records survive closing the app and going
  offline.
- **History** (“View all”) groups loadings by day with per-day and grand totals,
  and lets you delete a wrong entry (with a confirm).
- **Export to Excel / CSV** downloads all records as a spreadsheet
  (`Tanker_Loading_YYYY-MM-DD.csv`, opens in Excel / Google Sheets) with columns
  *Date · Time · Vehicle · C1 · C2 · C3 · C4 · Total*. Ask the employee to
  export now and then so the owner keeps a backup off the phone.

> Because records live in the phone's storage, they are tied to that phone +
> browser. Clearing the browser's site data, or uninstalling, erases them —
> so the periodic CSV export is the backup. (If you later want all employees'
> loadings synced live to one shared cloud list — like the `/app/` and `/tally/`
> apps do with Supabase — that can be added; this version is intentionally
> zero-setup.)

## Install on the phone

It's static — host the `/loading/` folder anywhere (it deploys with the rest of
this repo on GitHub Pages, at `/loading/`). On the phone, open it in
Chrome/Safari and **Add to Home Screen**. After that it opens full-screen like a
normal app and works with no internet.

## Notes

- Times are the **phone's local time** (no server involved).
- Quantities accept whole litres only; typing more than a chamber's capacity
  shows a gentle “⚠ More than full” warning but still lets you save (in case of
  genuine top-ups).
