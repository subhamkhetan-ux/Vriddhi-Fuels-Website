# Vriddhi Fuels — Payment Entry PWA

A mobile-first, installable app for entering fuel-payment receipts quickly,
resolving partial customer names to their exact canonical spelling, and
exporting a clean **`.xlsx` ready to append to the “Master Paid” sheet** of
`Master Ledger.xlsm`.

Built to the [Payment Entry App spec](../). It is a **separate app** from the
Master Ledger dashboard at the repo root (`/index.html`) and the other apps
under `/app`, `/loading`, `/tally`. It lives entirely under `/pay/` and is
served at `/pay/`. Static, no build step, works offline once loaded.

> **Why `.xlsx` export (Option A)?** The spec offers two paths for getting
> entries into Master Ledger. This app takes **Option A** — generate a
> well-formed `.xlsx` the user (or an existing macro) imports into Master Paid.
> It keeps the app off the Excel/AppleScript automation path entirely, so
> there are no locale bugs and nothing to install on the Mac. The app runs in
> any browser (phone or desktop).

## What it does

1. **Input** — paste `pay …` lines (the format you already use) **or** use the
   form (date picker, customer autocomplete, amount, mode). Both are supported.
   ```
   pay 28/07/26 akv 60000 30000 UPI + 30000 HDFC
   pay 28/07/26 sudarshan 50000 HDFC 1010
   ```
   Grammar: `pay · DATE(dd/mm/yy) · NAME… · AMOUNT · MODE…` — amount may have
   commas (`1,25,000`); mode may be empty.

2. **Resolve** — each partial name is matched against the live customer list
   (see below). Matching **ignores case and punctuation**, so `akv` →
   “A.K.V. Logistics”, `smc` → “M/s Smc Power Generation Ltd.”. Dates become
   Excel serials; amounts are normalised to plain numbers.

3. **Review** — every entry lands in an editable table with a status:
   - **ready** — resolved cleanly, will be exported.
   - **pick one** — the partial matched several customers; choose the right one
     (a wrong customer is never auto-picked).
   - **no match** — closest names are offered; pick one or search the full list.
   - **bad date / bad amount** — fix inline.

   Date, amount and mode are editable in place, and any row can be removed.

4. **Analysis** — a batch summary (total, count, customers, date range),
   a **by-payment-mode** breakdown (UPI / Bank / Cash / Cheque / …), and a
   **running total per customer**. Rows are flagged when they look risky:
   - **duplicate within the batch** (same customer + amount + date),
   - **already exported earlier** (see idempotency below),
   - **unusual amount** vs that customer's historical payments (possible
     extra/missing zero).

5. **Export** — one tap writes `vriddhi-payments-<timestamp>.xlsx` with columns
   **Date · Customer · Amount Paid · Payment Mode** on a sheet named
   **“Master Paid”**. A **CSV** export is also available. Only *ready* rows are
   exported; flagged rows are left for you to fix.

6. **Idempotency** — every exported entry's key (date + customer + amount) is
   remembered in the browser. Re-exporting the same payment flags it as
   *already exported* so a re-run can't silently duplicate a payment.

## Where the customer list comes from

The canonical customer names are pulled from the **same Google Apps Script feed
that powers the Master Ledger dashboard** (repo root `/index.html`). The app
reads the “Master Paid” sheet's customer master list (column F), the historical
payees (column B), and every customer ledger (the Outstanding sheet), and takes
their union — deduped and sorted. That list is the source of truth for valid
names; nothing here writes back to it.

- The list is **cached in the browser** after the first online load, so name
  matching keeps working offline. Tap **↻ Names** in the header to refresh.
- The feed URL lives in [`config.js`](./config.js) (`DATA_URL`). It's the same
  `/exec` URL as the dashboard — change it there if it ever moves.

## How the `.xlsx` matches Master Paid (spec constraints kept)

- **Column A is a date serial**, not text. The stored value is the plain Excel
  serial (days since 1899-12-30); a `dd/mm/yyyy` cell format makes Excel show it
  as a date. A 2-digit year `< 100` is read as `2000 + y`.
- **Amounts are plain numbers** — no thousands separators in the value; grouping
  is a display format only.
- **Never writes column F** — the customer master list is read-only; this app
  only ever reads it.
- The exported file is written by a **small, dependency-free XLSX writer** built
  into the page (no external library, no CDN), so it works fully offline.

## Install / serve

It's static — host `/pay/` anywhere (GitHub Pages, Netlify, Vercel static, or
alongside the existing site). On a phone, open it in the browser and **Add to
Home screen** to install the PWA.

## Files

```
pay/
  index.html            The whole app — parser, name matcher, review UI,
                        analysis, and the built-in .xlsx writer.
  config.js             DATA_URL for the customer-name feed (same Apps Script).
  manifest.webmanifest  PWA manifest (installable).
  sw.js                 Service worker (app-shell cache; never caches the feed).
  icon.png              App icon.
```
