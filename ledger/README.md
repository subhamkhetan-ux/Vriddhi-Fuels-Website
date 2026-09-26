# Vriddhi Ledger — the Master Ledger in the cloud (`/ledger/`)

A web app that does the Master Ledger's daily jobs without Excel or the Mac
being on. **Phase 1** (this folder) covers:

| Master Ledger | In the app |
|---|---|
| **Import Sales** button (Module10 `ImportDayBook`) | **Import** → choose the Tally DayBook. HSD / MS / XG credit vouchers are added; bills already in the app are skipped. |
| PO numbers typed into the `*_Bulk` sheets' PO TRACKER | **POs** → add a PO and its allotted litres. Each diesel bill gets the first PO in the list with enough litres left — the same rule as the sheets' `PO No.` formula — so bills that had no PO pick one up as soon as you add it. Unit-wise lists (SMC) and typed-in POs work as in Excel. |
| **Yesterday New Ledger / Bulk Add / Bulk Delete Ledger** (Module3) | **Customers** → new names from a DayBook are listed for a short ledger name (or "No ledger needed"); **Archive** hides a customer without deleting any sales or payments. |
| — | **Sales** → the bills of any day. |
| — | **Upload Master Ledger** → copies sales, payments, customers, opening balances, the Bulk sheets' PO lists and the Unit / PO / TDS / Shortage / Remarks typed against each bulk bill. |

**Phase 2** (the **Bills** tab):

| Master Ledger | In the app |
|---|---|
| **Daily Tanker Bill** (Module8 `ExportHSDBills`) | Pick the dates (and optionally part of a customer name). One bill per HSD sale to a **Tanker Master** customer — letterhead, address, payment lines, **P.O. No. from the PO lists**, Density / Seal lines over 3,000 L — bundled like the macro: one PDF per day for ESM (Lakhanpur group), SMC Unit 1 / 2, OMPL and SMEL, one per customer per day for everyone else, with the same file names. **Download all (.zip)**, one PDF, or print. |
| **Print Bills** (Module7 `ExportBillsPerCustomer`) | Every HSD, MS and XG bill in the range as an A5 credit memo, one PDF per customer named `<Customer> Slips <date>`, zipped in a `Fuel Bills <from> to <to>` folder. The heading is read from the HSD Bill sheet. |

The Tanker Master and the slip heading come in with **Upload Master Ledger**
(re-upload after changing them in Excel). Customers not in the Tanker Master
are listed as skipped, like the macro.

Coming next: **Phase 3** Daily / Monthly / Custom statements (with the
month-end Outstanding update).

This app is separate from every other app in this repo; it only adds files
(`ledger/`, `supabase/ledger-schema.sql`, `tests/ledger_web/`,
`tests/test_ledger_*.py`) and changes nothing else.

## Where the data lives

In **its own Supabase project** — not the project `/payments`, `/app`,
`/loading` or `/tally` use — so nothing about those apps changes.

- Nothing is readable without signing in, and a login must also be on the
  `ledger_members` list, which only the Supabase SQL Editor can change.
- The page's code is public (like the other apps here); the data is not. No
  ledger data is ever written to this repository.
- The Master Ledger and DayBook files are read **in the browser**; only the
  rows the app needs are sent to the database.

## One-time setup

1. **Create a Supabase project** (supabase.com → New project), e.g.
   `vriddhi-ledger`.
2. **Create the tables:** in that project, SQL Editor → paste all of
   [`supabase/ledger-schema.sql`](../supabase/ledger-schema.sql) → Run.
   (Safe to run again; later phases update this file.)
3. **Turn off public sign-ups:** Authentication → Sign In / Providers →
   switch off **Allow new users to sign up**. (The member list already keeps
   strangers out; this keeps the user list clean too.)
4. **Add your login:** Authentication → Users → **Add user** (email +
   password, tick *Auto Confirm User*). Then in the SQL Editor run:

   ```sql
   select ledger_add_member('you@example.com');
   ```

   Repeat for anyone else who should use the ledger. `ledger_remove_member`
   takes a login away.
5. **Connect the page:** copy the project's **URL** and its **publishable**
   (anon) key — the project's **Connect** button shows both, or Project
   Settings → API Keys — into [`config.js`](./config.js), or send them to
   Claude to do it. Both are meant to be public. **Never** use the
   `service_role` / secret key.
6. Open **`/ledger/`**, sign in, and **Upload Master Ledger** once. The
   preview shows what will be copied and checks that the app's PO rule gives
   the same POs Excel shows on your Bulk sheets before anything is saved.

Until step 5 the page shows these steps and a **Try the demo** button
(`/ledger/?demo`): made-up data, kept only in that browser tab.

## Day to day

- **Sales:** upload the Tally DayBook under **Import** (from any device). If
  you still use Excel for SCPL, the Sales Dashboard or the Own Tanker Report,
  keep importing the DayBook there too — the app never writes back to Excel.
- **New PO:** **POs** → the customer → **Add a PO**. Order matters (bills use
  the first PO with room), so use ↑ / ↓ to change which PO is used first.
- **Unit (SMC):** new SMC bills need a unit before they can get a PO; pick it
  in the bill list.
- **Re-uploading the Master Ledger** brings the app in line with Excel for
  sales, payments, opening balances and TDS / shortage / remarks. Ledger
  names, PO lists and a bill's Unit / PO belong to the app after the first
  upload — later uploads only fill in blanks and add POs the app doesn't
  have. Payments copied from Master Paid are replaced by the workbook's list.

## Files

| File | What |
|---|---|
| `index.html` | The page (styles + start-up) |
| `config.js` | Supabase URL + publishable key of the ledger project |
| `js/app.js` | The screens |
| `js/daybook.js` | Reads a Tally DayBook like `ImportDayBook` |
| `js/master.js` | Reads the Master Ledger (sale sheets, Master Paid, Outstanding, Customer GST, every `*_Bulk` sheet) |
| `js/po.js` | The PO rule of the Bulk sheets |
| `js/store.js` | Talks to the database (`ledger_*` functions); also the in-memory demo store |
| `js/bills.js` | Which bills go in which PDF (Module8 / Module7 rules) |
| `js/render.js` | Draws the tanker bill (A4) and fuel slip (A5); makes PDFs and zips |
| `assets/` | Letterhead and stamp for the tanker bill (copies of `/tanker/assets`) |
| `js/demo.js` | Made-up demo data |
| `js/util.js` | Dates, numbers, names |
| `../supabase/ledger-schema.sql` | Tables, row-level security and the `ledger_*` functions |

Libraries load from CDNs when needed: `@supabase/supabase-js` (esm.sh, same as
the other apps), SheetJS (cdn.sheetjs.com, same as `/loading/`), and jsPDF +
JSZip (cdnjs) for the bill PDFs.

## Tests

```bash
node --test 'tests/ledger_web/*.test.mjs'   # DayBook, PO rule, Master Ledger reader, demo store
python -m pytest tests/test_ledger_web.py tests/test_ledger_schema.py -q
```

`test_ledger_schema.py` runs the SQL on a throwaway local Postgres with
Supabase's auth stubbed, and checks that the public key and non-member logins
get nothing. It is skipped when Postgres isn't installed. Set `LEDGER_XLSX` to
SheetJS's `xlsx.mjs` to also run the real-`.xlsx` round-trip tests. All test
data is made up.
