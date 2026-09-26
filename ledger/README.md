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

**Phase 3** (the **Statements** tab):

| Master Ledger | In the app |
|---|---|
| **Daily Screenshots** (Module1) | Always for **yesterday**, like the macro. Every ledger customer who bought anything that day gets a picture of their ledger (month so far) and of that day's bills, plus the **HSD / MS Daily** summaries — JPEGs the size of the Excel export, named like the macro (`Keshav Ledger 25-09-2026.jpeg`, `HSD Daily 25-09-2026.jpeg`). **Share all on WhatsApp** sends them in one go through the phone's share sheet; **Share** on a customer sends just their two. Browsers that can't share files download a zip instead. |
| **Monthly Export** (Module2) | Pick the month (last month on the 1st, otherwise this month). A ledger PDF with a TOTAL row and a bill-statement PDF (header repeated on each page, TOTAL at the end) for every ledger customer with diesel, petrol or XtraGreen sales. |
| **Update Monthly Outstanding** (Module5) | After a monthly run: **Save closing balances as (next month) opening**. Optional — balances already carry forward. |
| **Custom Date Report** (Module6) | Any From..To range, optionally part of a customer name. Unlike Excel, the ledger opens with the customer's real balance on the From date, not only on the 1st of a month. |

A ledger's title (sheet A1), the bill-statement address (Q10) and the
sheet's column widths / row heights come with **Upload Master Ledger**; the
GSTIN comes from Customer GST. The pictures are drawn the way Excel prints
them — Times New Roman at the sheet's own widths, whole-number "fit to page"
zoom, the same margins, borders and stamp position — so they match the
workbook's exports. Phones without Times New Roman (Android) get Tinos, a
free font with the same letter widths, from Google Fonts. The Statements tab
says when a customer's address or sheet widths are missing (re-upload the
Master Ledger). Upload the
stamp once on the Statements tab — it is kept in the database, not on the
website.

**Home dashboard** (the workbook's Sales Analysis — Module14 — and the
Outstanding sheet, live): pick *This month / Last month / Last 30 days / This
FY* and see earnings, sales, collections and today's outstanding; each
product's litres, sales and earnings; litres and earnings per day (per month
for long periods); the best customers (sort by litres, sales or earnings;
retail / bulk; tap one for the product split, payments and outstanding);
everyone's outstanding, largest first (ledger customers as on their sheet,
bulk groups as on their *_Bulk sheet: opening + sales − paid − TDS −
shortage); bulk vs retail; the FY month by month (sales vs collections); and
the day's RSP per product. Tap or hover any chart for its numbers.

**Customer ledgers**: tap anyone under *Outstanding today* (or *Open ledger*
on a best customer) to see their ledger laid out like their sheet in the
Master Ledger, with the sheet's column letters, row numbers and column widths:
- **Bulk** — the *_Bulk sheet: title, Customer / Group, Opening Balance and
  Period From, then every member's bill (diesel, petrol, XtraGreen, then
  payments, then Other Sale, by date) with Unit, PO No., TDS, Shortage and
  Remarks, and the running Balance (opening + amount − paid − TDS −
  shortage), in the sheet's number formats (negatives in red). Group sheets
  show the Billing Name; SMC-style sheets the Unit.
- **Retail** — the ledger sheet (A:G) for a month, with ‹ › to move between
  months, and *Share as picture* / *PDF* of the same page.
**Fit / − / + / 100%** zoom the sheet (on a phone it scrolls sideways like
Excel). The widths come with the Master Ledger upload.

Earnings follow Module14: a bill earns *amount − litres × (day's RSP −
margin)*, margin ₹2.58/L diesel and XtraGreen, ₹4/L petrol, the day's RSP
being the highest price billed that day — so retail earns the full margin and
a discounted bulk bill earns the margin less its discount. A day without its
own RSP (no bills, or only discounted bills under an unchanged price) takes
the price of the days before and after when those two are the same.

**Payments tab**: the [payments app](../payments/)'s matched entries, read
straight from its database with the same public key it uses
(`payments/config.js`) — read-only, so the payments app carries on exactly as
before (keep logging to Excel from it). Each entry shows where it is in the
payments app (Ready / Queued for Excel / In Excel) and in the ledger (Not in
ledger / In ledger ✓ / In Excel copy ✓). Tick the ones you want and tap
**Log payments**: they count in balances and statements straight away and
their status turns to *In ledger ✓*. **Discard** keeps an entry (say a test
payment) out of the ledger for good — taking it back out if it was logged —
and **Restore** under *Discarded* undoes that; the payments app isn't touched. They stay listed under *Logged here, not
in your Excel copy yet* until a Master Ledger upload shows them in Master
Paid — then the ledger's copy is dropped (one for one), so the Mac's Excel
file stays the source of truth and nothing counts twice. **Remove** takes one
out of the ledger only.

This app is separate from every other app in this repo (it only reads the
payments app's list); it only adds files
(`ledger/`, `supabase/ledger-schema.sql`, `tests/ledger_web/`,
`tests/test_ledger_*.py`).

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
| `js/render.js` | Draws the tanker bill (A4) and fuel slip (A5); makes PDFs, JPEGs and zips |
| `js/statements.js` | Statement rules: ledger rows, bill statement, daily summaries, who gets what (Module1 / 2 / 6) |
| `js/statement-svg.js` | Draws the ledger, bill statement and daily summary pages |
| `assets/` | Letterhead and stamp for the tanker bill (copies of `/tanker/assets`), logo for the ledger |
| `js/payin.js` | Reads the payments app's list for the Payments tab |
| `js/dash.js` | Home dashboard figures (earnings, customers, outstanding, months) |
| `js/charts.js` | The dashboard's SVG charts and their tooltips |
| `js/account.js` | A customer's ledger as on their sheet (bulk layouts, formats) |
| `js/demo.js` | Made-up demo data |
| `js/util.js` | Dates, numbers, names |
| `../supabase/ledger-schema.sql` | Tables, row-level security and the `ledger_*` functions |

Libraries load from CDNs when needed: `@supabase/supabase-js` (esm.sh, same as
the other apps), SheetJS (cdn.sheetjs.com, same as `/loading/`), and jsPDF +
JSZip (cdnjs) for the bill and statement PDFs.

## Tests

```bash
node --test 'tests/ledger_web/*.test.mjs'   # DayBook, PO rule, Master Ledger reader, bills, statements, demo store
python -m pytest tests/test_ledger_web.py tests/test_ledger_schema.py -q
```

`test_ledger_schema.py` runs the SQL on a throwaway local Postgres with
Supabase's auth stubbed, and checks that the public key and non-member logins
get nothing. It is skipped when Postgres isn't installed. Set `LEDGER_XLSX` to
SheetJS's `xlsx.mjs` to also run the real-`.xlsx` round-trip tests. All test
data is made up.
