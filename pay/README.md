# Vriddhi Fuels — Payment Entry PWA

A mobile-first, installable app for entering fuel-payment receipts quickly,
resolving partial customer names to their exact canonical spelling, and
exporting a clean **`.xlsx` ready to append to the “Master Paid” sheet** of
`Master Ledger.xlsm`.

Built to the [Payment Entry App spec](../). It is a **standalone app** — its own
folder at `/pay/`, served at `/pay/`, exactly like the other apps (`/app`,
`/loading`, `/tally`). It does **not** modify or depend on any of them. Static,
no build step, works offline once the customer list is loaded.

> **Why `.xlsx` export (Option A)?** The spec offers two paths for getting
> entries into Master Ledger. This app takes **Option A** — generate a
> well-formed `.xlsx` the user (or an existing macro) imports into Master Paid.
> It keeps the app off the Excel/AppleScript automation path entirely, so
> there are no locale bugs and nothing to install on the Mac. It runs in any
> browser (phone or desktop).

## Customer list — from Tally `Master.xml`

The customer list comes from a **Tally Masters (Ledgers) XML** you upload in the
app — the **same source the Tally app uses**. The app reads every ledger under
the **Sundry Debtors** group (including subgroups, e.g. RCP COMPANIES) as your
customer list.

- Tap **⬆ Upload Tally Master.xml**, pick the Masters XML you export from Tally.
- The list is stored **on the device** and used to resolve every payment, so
  matching works fully offline.
- **Re-upload anytime to add new customers** — a fresh Master export replaces the
  stored list.
- **🗑 Clear ledgers** deletes the whole customer list and its cached data — on
  all your devices when cloud sync is on — after a confirm. It does **not** touch
  the exported-entries history; upload a Master.xml again to reload customers.

The uploaded list is **authoritative**. An optional ledger feed (`DATA_URL` in
[`config.js`](./config.js)) is used only as a convenience: it supplies each
customer's past payment amounts for the “unusual amount” check, and can act as a
fallback name source before any `Master.xml` has been uploaded. It's never
required.

## What it does

1. **Input** — a simple **form**: date picker, customer (with autocomplete),
   amount, and payment mode. Add as many payments as you like; the date is kept
   between entries so a run of same-day payments is quick. The customer can be a
   partial (e.g. `akv`) — it resolves to the full name in the review below.

2. **Resolve** — each partial name is matched against the uploaded customer list.
   Matching **ignores case and punctuation**, so `akv` → “A.K.V. Logistics”,
   `smc` → “M/s Smc Power Generation Ltd.”. Dates become Excel serials; amounts
   are normalised to plain numbers.

3. **Review** — every entry lands in an editable table with a status:
   - **ready** — resolved cleanly, will be exported.
   - **pick one** — the partial matched several customers; choose the right one
     (a wrong customer is never auto-picked).
   - **no match** — closest names are offered; pick one or search the full list.
   - **bad date / bad amount** — fix inline.
   - **🔒 already entered / 🔒 duplicate** — blocked, see below.

   Date, amount and mode are editable in place, and any row can be removed.

4. **Analysis** — a batch summary (total, count, customers, date range),
   a **by-payment-mode** breakdown (UPI / Bank / Cash / Cheque / …), a
   **running total per customer**, and a flag for amounts that look off vs a
   customer's history.

5. **Export** — one tap writes `vriddhi-payments-<timestamp>.xlsx` with columns
   **Date · Customer · Amount Paid · Payment Mode** on a sheet named
   **“Master Paid”**. A **CSV** export is also available. Only *ready* rows are
   exported; flagged/blocked rows are left behind.

## Old entries — and why duplicates are impossible

When you export, those entries **move into a persistent “Old entries” list**
(and out of the pending batch). A payment is identified by
**date + customer + amount**.

- Any new row that matches an entry already in **Old entries** is **hard-blocked**
  — marked **🔒 already entered** and excluded from export. It is *not just a
  warning*: the same payment can never be exported twice.
- Two identical rows in the *same* batch: only the first is exportable; the
  second is **🔒 duplicate**.

The **Old entries** section is searchable and shows what was exported and when.
If a payment was recorded by mistake, you can remove that single entry (which
unblocks it), or use **🗑 Clear entries** to clear the history — **all of it by
default, or a date range** (by payment date) via the From/To fields. Every clear
asks for confirmation, and when cloud sync is on it clears on all your devices.

**Auto-clear after 7 days.** The Old-entries history keeps entries for **7 days**
and then clears them automatically (pruned on the device, filtered on read, and
purged server-side when cloud sync is on). So the no-duplicate guard covers the
last week; older payments drop off on their own.

## Cloud sync across devices (optional)

Set **`SUPABASE_URL` + `SUPABASE_ANON_KEY`** in [`config.js`](./config.js) and run
[`supabase/pay-schema.sql`](../supabase/pay-schema.sql) once (see
[SETUP.md](./SETUP.md)) to keep **the exported-entries history and the customer
list consistent across every device, in real time**:

- Export on one phone and it appears in **Old entries** on your other devices
  within a moment — and **the same payment is blocked on every device**, so two
  people entering in parallel can't double-export.
- Upload a Tally Master.xml on one device and the customer list updates everywhere.
- The header shows **☁ synced / connecting… / offline**. If the cloud is
  unreachable the app keeps working on-device and reconciles when it reconnects.

Leave the `PASTE_…` placeholders and the app runs **purely on-device**
(localStorage) exactly as before — cloud sync is entirely optional.

## How the `.xlsx` matches Master Paid (spec constraints kept)

- **Column A is a date serial**, not text. The stored value is the plain Excel
  serial (days since 1899-12-30); a `dd/mm/yyyy` cell format makes Excel show it
  as a date. A 2-digit year `< 100` is read as `2000 + y`.
- **Amounts are plain numbers** — no thousands separators in the value; grouping
  is a display format only.
- **Never writes the customer master** — the Master.xml / column-F list is
  read-only; this app only ever reads it.
- The exported file is written by a **small, dependency-free XLSX writer** built
  into the page (no external library, no CDN), so it works fully offline.

## Install / serve

It's static — host `/pay/` anywhere (GitHub Pages, Netlify, Vercel static, or
alongside the existing site). On a phone, open it in the browser and **Add to
Home screen** to install the PWA.

## Files

```
pay/
  index.html            The whole app — Master.xml parser, form entry, name
                        matcher, review UI, old-entries/dedupe, cloud sync,
                        analysis, and the built-in .xlsx writer.
  config.js             Optional SUPABASE_URL + SUPABASE_ANON_KEY (cross-device
                        sync) and DATA_URL (ledger feed for history + fallback).
  manifest.webmanifest  PWA manifest (installable).
  sw.js                 Service worker (app-shell cache; never caches the feed).
  icon.png              App icon.
  SETUP.md              One-time Supabase setup for cloud sync.
supabase/
  pay-schema.sql        Tables + RLS + realtime + 7-day purge for cloud sync.
```
