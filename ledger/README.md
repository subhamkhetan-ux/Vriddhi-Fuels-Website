# Vriddhi Ledger — the Master Ledger in the cloud (`/ledger/`)

A web app that does the Master Ledger's daily jobs without Excel or the Mac
being on. **Phase 1** (this folder) covers:

| Master Ledger | In the app |
|---|---|
| **Import Sales** button (Module10 `ImportDayBook`) | **Import** → choose the Tally DayBook. HSD / MS / XG credit vouchers are added, and **Tally is the source of truth**: a bill already in the app takes the DayBook's date, customer, vehicle, litres, rate and amount, so importing a corrected DayBook again corrects the app (see below). |
| PO numbers typed into the `*_Bulk` sheets' PO TRACKER | The PO lists **follow the Master Ledger upload** (it is their source of truth: POs, litres, order). **POs** → add a PO and its allotted litres, to use until the next upload. Each diesel bill gets a PO by the same rule as its sheet's `PO No.` formula, read from the upload: with the current formula, the one PO with enough litres left for the whole bill, or — when several have — **pick a PO** (Excel's *Select PO ▼*; one tap on the bill), and with the earlier formula the first PO in the list with enough litres. Bills that had no PO pick one up as soon as you add it. Unit-wise lists (SMC) and typed-in POs work as in Excel. |
| **Yesterday New Ledger / Bulk Add / Bulk Delete Ledger** (Module3) | **Customers** → new names from a DayBook are listed for a short ledger name (or "No ledger needed"); **Archive** hides a customer without deleting any sales or payments. |
| — | **Sales** → the bills of any day. |
| — | **Upload Master Ledger** → copies sales, payments, customers, opening balances, the Bulk sheets' PO lists and the Unit / PO / TDS / Shortage / Remarks typed against each bulk bill. |

**Re-importing a corrected DayBook.** The preview shows how many bills are
new, how many will be **corrected** (each with what changes, e.g. *Litres
2,800 → 2,810*) and how many already match. What you typed against a bill in
the app — Unit, PO, TDS, shortage, remarks — is kept. Bills that are in the
app for the DayBook's dates but no longer in it (deleted or renumbered in
Tally) are listed with a tick box, **Also remove …**, off by default; ticking
it removes them on import (DayBooks of up to 400 days). Importing the same
DayBook again changes nothing. A later Master Ledger upload still copies
Excel's figures, so import the corrected DayBook into Excel too. Needs
[`supabase/ledger-schema.sql`](../supabase/ledger-schema.sql) run again once —
the app says so until then.

**Phase 2** (the **Bills** tab):

| Master Ledger | In the app |
|---|---|
| **Daily Tanker Bill** (Module8 `ExportHSDBills`) | Pick the dates (and optionally part of a customer name). One bill per HSD sale to a **Tanker Master** customer — letterhead, address, payment lines, **P.O. No. from the PO lists**, Density / Seal lines over 3,000 L — bundled like the macro: one PDF per day for ESM (Lakhanpur group), SMC Unit 1 / 2, OMPL and SMEL, one per customer per day for everyone else, with the same file names. **Download all (.zip)**, one PDF, or print. |
| **Print Bills** (Module7 `ExportBillsPerCustomer`) | Every HSD, MS and XG bill in the range as an A5 credit memo, one PDF per customer named `<Customer> Slips <date>`, zipped in a `Fuel Bills <from> to <to>` folder. The heading is read from the HSD Bill sheet. |

The Tanker Master and the slip heading come in with **Upload Master Ledger**
(re-upload after changing them in Excel).

**Company name on the slips.** The slip heading starts with the Tally
company name, financial year and all (`VRIDDHI FUELS (2026-27)`). Under
*Print Bills* you can change it in the app: type the name and tick **Add the
bill's financial year**, and every slip prints its own bill's year —
`(2026-27)` up to 31 March, `(2027-28)` from 1 April — with no new upload
for a new year. Untick it to print the name exactly as typed. The name is
kept across Master Ledger uploads; **Use the Master Ledger's heading** goes
back to the sheet's line. (Needs [`supabase/ledger-schema.sql`](../supabase/ledger-schema.sql)
run again once; the app says so until then.) Customers not in the Tanker Master
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

**Quotes** — quotations and proforma invoices made from the **Tanker Billing**
workbook itself. The app doesn't copy the workbook's arithmetic into its
code: it **reads the workbook and works out its own formulas**, so what you
change in Excel — a new row on the quotation, new wording, a new helper cell,
a new price tier or table, a changed formula — just needs an import.

| Tanker Billing workbook | In the app |
|---|---|
| — (the workbook itself) | **Import Tanker Billing.xlsm** (on Quotes, or on Import), read on this device. The app takes: every cell (value, formula, number format) of the *Quotation Maker* and *Proforma Invoice* sheets and of every sheet their formulas reach (Customers); the tables (Customers, RateCard, ProductRates, PaymentPresets, TierTerms …) and names (`HSD_RSP`, `XP_Net` …); each sheet's print area as Excel prints it (column widths, row heights, merged cells, fonts, fills, borders, alignment, conditional formats, drop-down lists, margins, where the letterhead and stamp sit); the macros' source (the PI Log is filled as Module1 says); the pictures (kept in the database, not on the website); the Customers table again as the **Tanker Master** (Daily Tanker Bills); and the **PI Log** sheet. **The self-check:** before anything is saved, the preview works out every formula with the workbook's own inputs and compares each with what Excel saved — *“✓ the app works out all 110 formulas as Excel saved them”*, or the cells that differ and any function the app doesn't know yet (also flagged on the Quotes screens until the next import). A formula linked to another workbook (`[1]Sheet!A1`) keeps what Excel saved. The preview also lists what each document will ask for, the tables read and the RSP. |
| **Quotation Maker** | **Quotes → Quotation.** The form asks for the sheet's input cells — those in **blue** (the sheet's own note: *Blue-on-yellow cells are inputs*) and the drop-downs — named as the sheet names them (the label to the left, the heading above, or the cell's own prompt): today the customer (A5), Valid Till, Quotation Date, Contact No., Email, Dispatch and Fleet Available. A blue cell that has a formula (Quotation Date `=TODAY()`) is worked out until you type over it. **IOCL RSP** changes the RateCard's HSD RSP for this document, and everything that depends on it follows as in Excel (tiers written as `=P2-0.74`, a tier on another tier like `=P4-0.74`). The **Calculated** panel is the sheet's helper block beside the page (RSP, offer price, discount, XtraPower, price tier, payment terms …), live; **✎** changes one value for this document only (e.g. other payment terms), **↺** goes back to the formula. The page is the print area, worked out: payment terms, the XtraPower remark in bold green (the conditional format), the bank block, Fleet Available — whatever the sheet has. **Download PDF**, **Share**, **Print** — `<Customer's first two words> Quotation <d mmmm yyyy>.pdf`. |
| **Proforma Invoice** + **Print & Log PI** | **Quotes → Proforma Invoice.** The form asks for the blue cells and what the macro restores on a reprint (LoadLogRowToSheet): PI No. (the next after the PI Log's highest of the financial year, editable), date (today), Buyer's P.O. No. and date, Place of Supply, Buyer, Contact Person, Description, HSN, Quantity and Rate (worked out — the customer's HSD rate — until typed over; a new customer puts it back). Everything else is the sheet's formulas: Valid Up To, amount, round-off, grand total, the RSP / benefit / XtraPower lines, amount in words. **Save PDF & log**, **Share & log**, **Print & log** do what the macro does, read from Module1: its checks (PI No., buyer, quantity), the cells it writes to each PI Log column (WriteLogRow), its file name (`<first two words> PI <d mmmm yyyy>.pdf`); a PI No. already in the log shows that entry and asks before **replacing** it under its own Log ID — *Cancel* makes and logs nothing. Each PI also keeps the customer's row and the typed-in cells, for reprints. |
| **PI Log** sheet + **Reprint PIs** | **Quotes → PI Log.** The whole log: the Excel file's **PI Log** sheet (from the import; dates typed as text — e.g. rows pasted in — are read too, and noted) and every PI made here, newest first, with the sheet's columns (Log ID, PI No., dates, customer, P.O., quantity, rate, IOCL RSP, discount = RSP − rate, totals, XtraPower points, effective rate, printed on / by, *Excel* or *app*). To reprint, narrow it down by part of the customer's name and PI dates (or **Last 30 days**, the macro's default), then **Reprint (.zip)**, **Print all**, or one PI's **PDF** / **Print**: the logged values go back on the sheet as the macro's reprint puts them (its own rate, RSP and P.O. No.; the customer's lines as printed when the app kept them) and the sheet is worked out. **Download log (Excel)** gives the sheet's columns with real Excel dates, ready to paste; ✕ removes an entry. **PI Log check:** every import compares the file's PI Log sheet with the app's — in the preview, and afterwards at the top of the PI Log until the next import: PIs with different figures (field by field, and whose were kept), PIs in the app but not in Excel's sheet (tagged *Not in Excel*, with **Download them for Excel**), PI Nos. listed twice. |
| **Bank Pay CrNote** + **Save/Print & Log** (Module3) | **Quotes → Credit Note.** The loyalty credit note on payments made to our bank account after the customer's XtraPower monthly limit (36 paise per ₹100 — the sheet's XtraPower settings). The form asks for the sheet's blue cells — customer, Credit Note No. (the next after the CN Log's highest, e.g. BNK/002; editable), date, **Payment Period** (a month), Customer PO No., Amount Paid — and *Our bank account* beside the page; the credit, the line's wording and the amount in words are the sheet's own formulas (its LAMBDA too). **Save PDF & log**, **Share & log**, **Print & log** do what PrintAndLogXPCreditNote does, read from the macro: its checks, its question, the file name (`BNK-002 - <customer>.pdf`), every column it writes to the XP Cr Note Log, then the next number and the amount cleared. A number already in the log isn't logged again (as the macro). |
| **XP Cr Note Log** + **ReprintXPCreditNote** | **Quotes → CN Log.** The workbook's XP Cr Note Log (from the import; a note made in the app keeps the app's) and every note made here, newest first: number, date, period, customer, amount paid, credit, logged by, reprints. **Duplicate** makes the note again exactly as logged, headed *CREDIT NOTE (DUPLICATE COPY)* as the Reprint macro does, and counts the reprint; **Print**; ✕ removes one. **Download log (Excel)** has the log sheet's own columns, ready to paste. Needs `supabase/ledger-schema.sql` re-run once. |
| **Price Letter** (your Word letter) | **Quotes → Price Letter.** *To whomsoever it may concern* — the RSP of HSD, MS or XtraGreen at our outlet on **one day** or over **a period** (up to a year), in the Word letter's format (`assets/price-letter.docx`: the same letterhead, wording, bold parts and signature block). The price comes from the app's **price history** — the day's RSP, the highest price billed that day, as on Home; the last days with no bill yet (today, say) carry the last known price, marked *check it*; days with none need it typed — and any price can be typed over. A period at one price says *during the period from … to … was ₹ …*; one whose price changed says *was as under:* with a table of each price and its dates. **Download Word** (the .docx, ready to edit), **PDF**, **Share**, **Print**. The stamp: one uploaded for letters, else the Proforma stamp from the workbook. |

**What still needs Claude:** a sheet renamed from *Quotation Maker* /
*Proforma Invoice*, a function the self-check says the app doesn't know, or
moving the Proforma's cells without updating the Print & Log PI macro (the
app follows the macro, as Excel does). Everything else follows the workbook.

The pages are fitted to one A4 page as Excel prints them (the Proforma at
48%). The sheets use Aptos Narrow, which phones and browsers don't have:
Roboto Condensed (Google Fonts) stands in for it, and text that still doesn't
fit its cell is made a little smaller rather than spilling over. The stamps
can also be changed on each screen (**Change stamp**). The demo
(`/ledger/?demo`) uses [`js/demo-workbook.js`](./js/demo-workbook.js): the
real sheets' design, formulas and macro with made-up customers, made by
[`tools/demo_workbook.mjs`](./tools/demo_workbook.mjs). Needs
[`supabase/ledger-schema.sql`](../supabase/ledger-schema.sql) run once (the
Quotes tab says so until then).

**Home** opens with *Jai Shree Krishna* — a morpankh flies in, writes it and
flies out (once each time the app opens; still for reduced-motion settings) —
with today's date and the date the Master File is updated until (the latest
sale in the last Master Ledger upload). *Sales in the app up to* and the bill
counts are on the **Import** tab.

**Home dashboard** (the workbook's Sales Analysis — Module14 — and the
Outstanding sheet, live): pick *This month / Last month / Last 30 days / This
FY / Custom* (any From..To, up to two years) and see today's outstanding (at the top), earnings, sales and collections; each
product's litres, sales and earnings; litres and earnings per day (per month
for long periods); the best customers (sort by litres, sales or earnings;
retail / bulk; tap one for the product split, payments and outstanding);
everyone's outstanding, largest first (right under the heading) (ledger customers as on their sheet,
bulk groups as on their *_Bulk sheet: opening + sales − paid − TDS −
shortage); bulk vs retail; the FY month by month (sales vs collections); and
the day's RSP per product. Tap or hover any chart for its numbers.

**Customer ledgers**: tap anyone under *Outstanding today* (or *Open ledger*
on a best customer) to see their ledger as a **statement**, in the app's look:
- the balance (Dr = due, Cr = advance) and the last payment — **everything
  received on the latest payment date** (several firms of a group, or several
  payments, add up; "· 3 payments" says so) — then tiles for the
  opening, billed (litres, bills), received (payments) and TDS & shortage,
  and each product's litres and amount;
- **Bulk** — the *_Bulk sheet's figures (opening + amount − paid − TDS −
  shortage, every member's diesel, petrol, XtraGreen, payments and Other
  Sale) with Unit, PO No., Billing Name, **how a payment came in** (Master
  Paid's mode: HDFC 1010, ICICI Bank Ltd, XtraPower, Cash, …) and Remarks
  under each entry (a ledger sheet's payments show their mode too). A
  **group** sheet (several billing names) also gets **Company-wise
  outstanding**: a card per company — its opening, billed, received, TDS &
  shortage, last payment and what it owes; companies at a nil balance are
  left out (on screen and in the pictures) with one line saying how many.
  **Each company's opening balance** comes from the **Customer GST** sheet:
  the column of amounts the group sheet's *Opening Balance* adds up
  (`=SUM('Customer GST'!$H$1:$H$50)` on Lakhanpur RCP, `$M$1:$M$50` on Ankita
  Air), each amount beside the company's name in the column to its left. It
  starts that company's statement and is its first pending bill. Any part of
  the sheet's opening not split that way belongs to the group as a whole, so
  that part + every company = the group's balance.
  **Statement of account per company** (as Tally's, party by party): pick a
  company under *Statement of* to see only its bills and payments from its
  opening, with its own running balance (its closing = its company-wise
  outstanding), its balance and its own pending bills. *Share ledger* then
  offers that company, the **Whole group** or **Company-wise** (one set of
  pictures + PDF per company, each with its own Share); **Company statements
  (PDFs)** downloads one PDF per company in a .zip — the whole ledger with its
  pending bills, or the month picked.
- **Retail** — the ledger sheet's rows for a month, with ‹ › to move between
  months.
- every entry by month (newest first, or oldest first), each month with its
  billed / received / closing; *All / Bills / Payments* filters. **TDS** and a
  **shortage** typed with a payment are transactions of their own on the
  payment's date (*TDS deducted*, *Shortage* — "On the payment of ₹…"), each
  with the balance after it; the payment shows only what was paid. Same in the
  ledger pictures and PDFs.
- **Pending bills** on every bulk ledger — each with its date, invoice no.,
  the bill's amount, what's still pending on it and how many days old it is
  (amber after 15 days, red after 30); an advance not yet set against a bill
  is shown below. Each payment (with its TDS and shortage) is **matched to the
  bills it adds up to**, to the rupee, because customers who lift several
  products often pay product by product:
  1. one bill of exactly that amount (the oldest such);
  2. whole runs of bills of one or two products, each product's oldest first —
     e.g. all the diesel bills up to a date, leaving the petrol bills pending;
  3. one product's oldest bills with a single bill held back.
  A remark on the payment row naming a product (MS / petrol, HSD / diesel, XG)
  tries that product first. When nothing adds up, the payment clears the
  opening balance, then the bills of the product billed most (usually diesel)
  oldest first — a petrol or lube bill only once no bill of a bigger product
  is open, since those small bills often wait.
  Finally, if a bill would be left part paid but each product's **newest
  bills add up exactly** to what's owed, those whole bills are the pending
  ones (e.g. two diesel bills + the April lube bill).
  On a **group** sheet (several billing names) each company's payment clears
  **only that company's bills** (then the group's opening) — never an older
  bill of another company — and what a company pays beyond that is its own
  advance, kept for its later bills. A payment with no billing name clears
  any company's bills. So a company that is clear has no pending bill.
- **PO-wise outstanding** for customers with PO lists: the pending bills
  grouped by PO number (unit by unit on an SMC-style sheet) — how much is
  still owed against each PO, how many bills and which dates, and how old the
  oldest one is. The opening balance and bills without a PO get rows of their
  own, by product: *Petrol*, *XtraGreen*, *Other items*, *Diesel · no PO yet*.
  The PO is the one the POs tab gives the bill.
- **Unit-wise (SMC-style sheets with a PO list per unit)**: a card per unit
  with its own outstanding and pending bills, and the statement of the whole
  account or of one unit. A payment counts for the unit typed in its **Unit**
  cell on the *_Bulk sheet's payment row and clears that unit's bills (then any
  opening the sheet doesn't split by unit); a payment with no unit clears the
  oldest bills of either unit. Each unit opens with its own opening balance
  from the sheet. Bills with no unit yet show as their own *No unit* part
  while anything there is owed, so the parts always add up to the account's
  balance. The Unit typed on a Bulk sheet's **Other Sale** rows (lubricant,
  AdBlue …) comes in too — matched to the Other Sale bill by customer, date
  and amount (and the item), as those rows usually have no bill no. — along
  with their TDS, shortage and remarks.

**Share as picture** — everything is drawn the same way for sending to a
customer (dark, orange-lit, the Vriddhi Fuels logo; Sora font):
- **Share ledger**: the statement as A4-shaped pictures (as many pages as it
  needs; on a bulk ledger pick the whole ledger or one month), or **PDF**.
- **Share outstanding**: one card with the balance as on today, the period,
  billed, received, last payment (that day's total), the **PO-wise
  outstanding** and the **pending bills** of a bulk customer — and, for a
  group, every company — then, at the bottom, **recent payments** (the last
  three payment days: each day's total and, under it, every payment — firm
  and mode). **PDF** saves the card (and the *Outstanding today* list) as a
  PDF too: one page the picture's shape at twice its sharpness, for when a
  long picture would get squeezed by the app it's sent through.
- **SMC-style sheets** share **unit-wise** by default: one set of pictures per
  unit (its ledger, or its outstanding card with its pending bills), each with
  its own **Share** button so each unit gets only its own; **Both units
  together** in the share sheet sends the whole account in one set, as before.
  Ledger pictures of the whole ledger end with the PO-wise outstanding and
  the pending bills.
- the share button on each **company card** sends that company's own card.
- on Home, the share button beside each customer under *Outstanding today*
  sends their card (unit-wise for SMC-style sheets); **Share list** sends the
  whole list (All / Retail / Bulk as chosen).
- **Paid in advance**: everyone with an advance is listed right under
  *Outstanding today* (largest first, tap to open the ledger), each with a
  share button for their balance card.
The pictures open in a preview: **Share** hands them to WhatsApp & co. through
the phone's share sheet, **Download** saves them (a zip for several).

**Excel sheet** (the chip beside *Statement*; the app remembers the choice)
still shows the ledger laid out like the sheet in the Master Ledger — column
letters, row numbers, widths, number formats, **Fit / − / + / 100%** zoom —
and, for retail, *Share as picture* / *PDF* of the Excel-style page (the same
page as the Statements tab).

**Rate chart (Excel)**: on Home, under *Day's RSP*, pick From..To (up to two
years) and **Download rate chart** — one row per day (date, weekday), each
product's rate (the day's RSP, as the dashboard uses it) and its change from
the day before, with a filter on the header row.

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

**Payments → By mode**: every payment of a period (This month, Last month,
Last 30 days, This FY or any dates) by how it came in — Master Paid's
*Payment Mode* (HDFC 1010, ICICI Bank Ltd, XtraPower, Cash, …) and the payments
logged here. Only the modes used in those dates are listed: **Cash first,
XtraPower next**, the rest by amount, payments with no mode last. Each mode
shows its total, share, payments, customers and dates; tap one for its
month-by-month chart, customers and payments. Modes are matched however
they're typed ("Xtrapower" is XtraPower), and a payment typed as two modes
("2.5 Cash + 1Lac HDFC 1010", "15000 HDFC + 35000 Cash") counts in each with
its part when the parts add up ("HDFC" counts as HDFC 1010 when that's the
only HDFC mode in the period). **Download Excel**: the summary and a sheet per
mode. (Needs `supabase/ledger-schema.sql` re-run once.)

**Register tab** (right of Home): the pump's **Daily Stock Register** — the
paper DSR book, a table per product (HSD, MS, XtraGreen) and month — and the
**Stock Register**, from the three workbooks kept on the Mac:

| Workbook | What the app takes |
|---|---|
| **E-DSR.xlsx** (Petrol / Diesel / XtraGreen) | The month (from "DIESEL MONTH OF NOVEMBER 2026"), the opening book stock, each day's receipts, each nozzle's opening meter reading (machines from the merged labels above them) and testing. Sale = the next morning's readings − this morning's − testing, cumulative sale, as its own formulas. |
| **Stock Register.xlsm** (MS / HSD / XG, Macro Log) | Each day's **Actual Tank Stock** (the next morning's dip stock), the opening shortage and HSD's testing adjustment; every morning its macro logged (**Macro Log**, "LOGGED to F…"). |
| **DIP Chart.xlsm** (Stock to Dip, Log) | The tank chart (dip in cm → litres, one chart for every tank), **this morning's stock of each tank** (HSD's two tanks), dated by its `=TODAY()`, and its **Log** sheet of mornings. |

Both are drawn as the **paper pages** they're copied into every morning —
white ruled paper, black print, entries in blue ink: the DSR page as the
printed book (उत्पाद / PRODUCT title, the month in red, TANK 1–4 with DIP and
WATER DIP, OPENING : METER READING with PUMPS 1–8 (MS: 1–6 and a REMARKS
column, XtraGreen: 1–5), TESTING, SALES, COMMUTATIVE SALES, all 31 date
lines, TOTAL and LAST YEAR SALES), figures written as by hand: whole litres
and meter readings, dips to a mm, testing as typed, sales to the paisa; ×
for no receipt; today's line highlighted. The Stock Register page is the
workbook's sheet (S.No … Variation of Shortage, G.TOTAL, and the Opening
Shortage / Todays Tank Stock / Current Shortage box). **Print** prints just
the page (A4 landscape). On a wide screen the page takes the window's width.

This morning's line is highlighted (but not its receipt and total stock —
what comes in today isn't known yet, so no × either), and on the line before
it the receipt, total stock,
testing, sale and cumulative sale those readings complete. **Edit dips**
turns the dips into boxes: a dip typed there (one misread, or HSD's per-tank
dips the DIP Chart didn't keep) is kept (`dips:YYYY-MM`) and written over
the DIP Chart's, dotted-underlined; a **!** says when typed dips don't come
to the morning's stock on the chart. Clear a box to go back.

**Testing adjustment** (Stock Register tab, under the page): the DSR's
testing is written higher than what's really tested, which keeps the book
stock — and the shortage on the books — higher. Each day the difference
(DSR testing − actual testing) is added to the testing adjustment. A day's
actual testing is typed there, else the day before's (to start: HSD 30, MS
20, XtraGreen 10 L; none on a day the DSR has 0). The month's **opening** is
typed, else **last month's closing** (so a new month's Stock Register starts
from it by itself), else the Stock Register's *Testing Adjustment* cell;
shown: opening, added this month (DSR vs actual testing totals), closing,
the shortage on the books and without the adjustment, and day by day the
adjustment and its running total. The page's box shows the opening, this
month and the closing (`adjust:YYYY-MM`).

*Daily Stock Register*: date, **dips** (each tank), **opening stock** (that
morning's dip stock), receipt, total stock, the opening **meter reading** of
every nozzle by machine, testing, **sale** and **cumulative sale**, a total
row — today's row marked. The opening stock is the DIP Chart's reading
(else its Log, else the Stock Register's Actual Tank Stock of the day
before, else its Macro Log); the dips are that stock read back on the chart
(the nearest row, as *Stock to Dip* does). Where the Stock Register's stock
differs from the DIP Chart's (a morning logged before the DIP Chart was
updated), a **!** says so. HSD's per-tank dips are known for the days the
app has the DIP Chart's reading — from the first day it's brought in (the
workbooks keep only the total for earlier days). *Stock Register*: book
stock (opening + receipts − sale), the **actual tank stock**, **shortage**
(closing book − actual) and **variation** (its change from the day before;
the first day from the opening shortage), as the workbook works them out.
*This morning*: each product's stock, dips and shortage.

The workbooks are reused month after month, so each month is **kept in the
app** once brought in (`ledger_register`: `dsr:YYYY-MM`, `stock:YYYY-MM`,
`dipchart`, and `tanklog` — every morning's stock, added to by each import,
never replaced — plus what's typed: `dips:YYYY-MM`, `adjust:YYYY-MM`); pick a month at the top of the table. The Mac's sync sends
the three workbooks (see *Day to day*), or **Import workbooks…** on the tab
(several at once; which is which is worked out from their sheets). Needs
`supabase/ledger-schema.sql` re-run once. The demo has a made-up month.

**Petrol and XtraGreen sales on Home** come from the pumps once the E-DSR
is in: the app's sales are the credit bills, but the E-DSR has every day's
sale through the pumps. For each day it has, the litres beyond that day's
credit bills count as **cash & others**, at the day's RSP (earning the full
margin) — in *By product* (credit · cash & others), the litres per day, the
months and **Bulk vs Retail vs Cash**. Collections are compared with the
credit sales. Diesel stays as billed (bulk supplies don't all go through the
pumps).

**Loans tab** (Loans & EMI, as in the [fleet app](../fleet/)): the loans on
the firm's vehicles — our own tanker trucks and cars in the firm's name — from
the banks' **repayment schedules**. **Add EMI schedules (PDF)** (several at
once): the app reads every EMI (date, EMI, principal, interest, balance), the
lender, account / agreement no., amount, rate (worked out from the schedule
when it isn't printed; HDFC's APR is kept beside it) and tenure, and fills in
the vehicle no. from the file name ("OD23U8210_Repayment_Schedule.pdf") and
whether it's a tanker (a commercial vehicle loan) or a car — check them and
save. A schedule that's a **scan or a photo** (no text, like Toyota
Financial's) is **typed in**: amount, EMI, number of EMIs, first EMI date
and the **last EMI** (that matches the bank to the rupee), and the **first
EMI's interest** when the loan was paid out mid-month; the app works out
every EMI the way the bank does. **Every EMI due till today counts as
paid**; tap one on its loan to mark it **not paid** (Home's *Needs your
attention* lists those). Shown: principal still owed, EMIs a month, interest
paid and still to pay, a ring and bar of paid / still to go, the **next EMI
of each loan** (Coming up), tankers vs cars, a card per vehicle, every EMI
month by month (principal and interest), and each loan's full schedule.
Kept in `ledger_loans` (one row per loan; needs `supabase/ledger-schema.sql`
re-run once) — not in this repository.

**Tally tab** (the Tally viewer): open your Tally data and see the
company's financials, compare every customer's balance here with Tally, and
see the lubricants bought month by month. The files are read on this device —
nothing is saved or uploaded, and the app's data is not changed.

Files (choose several together; a voucher in two files counts once; **Add a
file** adds one to those open):
- **Everything (best)** — in Tally Prime, Gateway of Tally → *Export →
  Masters* (All Masters, XML) and *Export → Transactions* (the year's Day
  Book, XML). The masters give the groups, opening balances, stock items and
  units; the transactions every voucher with its ledger lines and stock items.
- **Tally XML Day Book** alone (Display → Day Book → Export → XML): no
  groups or openings, so the financials are estimated (ledgers placed by
  their names) and the balance comparison compares only the movement in the
  file.
- **DayBook in Excel** (the file Import reads): the Insights only.

**Exporting only the new days.** The viewer saves nothing, so it knows only
the files open. There's no need to export the whole year each time: keep
the earlier exports and export just the days since (overlapping a few days
is fine), then choose them all together. Each voucher counts once — and an
XML voucher edited in Tally since the earlier export keeps only its latest
version (Tally's GUID and ALTERID). Re-export the masters only after adding
customers, ledgers or items.

What needs what: the Insights, Purchases & stock and a month's P&L need only
that month. Balances — the balance sheet, cash & bank, debtors and *Ledger vs
Tally* — need the masters and every voucher since 1 April (in any number of
files). The viewer checks: more than 7 days in a row with no voucher at all,
or a start more than 7 days after 1 April, is shown as a gap on top of every
view. Then the balance sheet and cash & bank say their balances are short,
the P&L says which days it leaves out, and *Ledger vs Tally* compares only
from where the files run unbroken (both sides starting from the app's
balance that day), so a month left out is never taken for bills missing from
Tally.

Four views (all but *Ledger vs Tally* for the whole file, a month, or any
From..To):
- **Insights** — sales, receipts, payments, estimated earnings and the
  discount under the day's RSP, each product's litres and rates, litres per
  day and weekday, customers (sort, search, their vouchers), voucher types,
  vehicles (and ones billed to several parties), rate changes, bill-number
  gaps / repeats / out-of-order bills, checks (litres × rate ≠ amount, no
  vehicle, no party …), ledger totals and every voucher (filter, Excel).
- **Financials** — profit & loss as Tally groups it (sales, purchases,
  direct / indirect expenses and income, gross and net profit, % of sales).
  The file doesn't carry the closing stock (Tally values it from the
  inventory): type it from Tally's Stock Summary for the true gross profit;
  the opening stock comes from the masters. Then month by month (sales,
  purchases, expenses, result, money in / out of cash and bank — transfers
  between them left out — and cash & bank at each month end), every expense
  ledger with its share and monthly average, income / sales / purchase
  accounts, a balance sheet as on the To date (cash, bank, receivable,
  payable, duties & taxes, loans, capital, fixed assets, working capital,
  current ratio), debtor and creditor days, collections, each cash and bank
  account (opening, in, out, closing), top debtors and creditors, and checks
  (trial balance agrees, the difference in opening balances, vouchers whose
  debits and credits differ, ledgers in no group). **Download trial
  balance** gives every ledger and the months in Excel.
- **Ledger vs Tally** — each customer's balance in this app (their ledger
  sheet; a bulk sheet's billing names together) against their ledger in
  Tally, as on any date in the file (at first the app's last sale date, so
  Tally bills from days not yet imported here don't read as missing):
  agree / differ / same balance with entries on other days / not found in
  Tally. Tap one to see where a
  difference comes from — the entries are matched:
  1. bills by bill no. (amount or date differs);
  2. a payment with its TDS and shortage against one Tally receipt of the
     three together;
  3. the rest by exact amount, the same day, then within 10 days (TDS and
     shortage within 120 days — Tally often books them later in a journal);
  4. what's left is in one side only (*Not in Tally*, *Not in the app*).

  Each finding says its date, the bill or voucher and its **effect** on the
  difference (+ = Tally higher); with the opening difference they add up to
  the difference in the balance. *Day by day* lists the days the difference
  changes, and the account says the day it first went off. A customer whose
  name differs in Tally gets suggestions (*“Sample Roadlines” may be “M/s
  Sample Roadlines Pvt Ltd”*) — tap one to compare with it (until the file is
  closed). Debtors with a balance in Tally that the app doesn't compare
  (cash customers, *No ledger needed*, new names) are listed below.
  **Download Excel** gives every finding.
- **Purchases & stock** — the lubricants and other items (or the fuel)
  bought — or sold — item by item and month by month, in litres / kg, packs
  or amount (before GST), with totals per month. The pack size is read from
  the item's name (`900ML`, `20 LTR`, `(7.5 LTR)`, `500 GM` = 0.5 kg,
  `1X12X1L` = a box of 12 × 1 L) and a compound unit in the masters (*Box of
  12 Nos*) says how many packs a box holds; viscosity grades (`15W40`) and
  `2T` / `4T` aren't taken for sizes. Items with no size in the name are
  listed and counted in packs and amount only. Purchase returns (debit
  notes) count against purchases. **Untick an item** to leave it out: it
  stays listed (dimmed, *left out*) but is out of every total, the tiles,
  the chart, the suppliers' amounts and the Excel; **Tick / Untick all**
  works on the items the search shows. The choice is remembered on that
  device (bought and sold separately). Also each item's packs, litres, ₹ a pack,
  ₹ a litre, last rate and date, and each supplier's total before and with
  GST. **Download Excel**: litres, packs and amount sheets and the suppliers.

In the demo, **Try a sample Tally file** makes a made-up export from the
demo data (masters and a year of vouchers) with a few differences planted
for *Ledger vs Tally* to find.

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

### After updating to the "Select PO" formula

Run [`supabase/ledger-schema.sql`](../supabase/ledger-schema.sql) again (it
adds each bulk ledger's PO rule and is safe to re-run), then **Upload Master
Ledger** once: the app reads which `PO No.` formula each Bulk sheet has and
follows it.

### After updating to unit-wise payments

Run [`supabase/ledger-schema.sql`](../supabase/ledger-schema.sql) again in the
SQL Editor (it adds a `unit` to payments and is safe to re-run), then **Upload
Master Ledger** once so the Unit typed on the SMC sheet's payment rows comes
in. Until then every SMC payment counts as "no unit" (oldest bill first).

## Day to day

- **From your Mac:** the Google Drive sync on the Mac (`vriddhi_gdrive.sh`,
  run by *Vriddhi 3 — Google Drive.command*) also uploads **Master
  Ledger.xlsm**, **Tanker Billing.xlsm**, **E-DSR.xlsx**, **Stock
  Register.xlsm** and **DIP Chart.xlsm** (for *Register*) to the app's private storage
  (Supabase Storage bucket `ledger-uploads`, members only) whenever they
  changed. **The app imports them by itself** as soon as it's open on any
  device (and again when it comes back into view) — no preview, no tap: a
  bar at the top says *Bringing in … from your Mac*, then what came in.
  Import → *From your Mac* lists them (*imported*, with *Import again* for
  the usual preview); if one can't be imported, Home says why and offers the
  preview. The script signs in
  as a ledger member; its password is kept in the Mac's Keychain, not in the
  script (`security add-generic-password -s vriddhi-ledger -a "<email>" -w`).
  Needs `supabase/ledger-schema.sql` re-run once (it makes the bucket).

- **Sales:** upload the Tally DayBook under **Import** (from any device). If
  you still use Excel for SCPL, the Sales Dashboard or the Own Tanker Report,
  keep importing the DayBook there too — the app never writes back to Excel.
- **New PO:** add it to the customer's *_Bulk sheet and upload the Master
  Ledger (the PO lists follow it). **POs** → the customer → **Add a PO** works
  for the time between, but the next upload replaces the list with the sheet's. The list is shown by PO
  number, Z→A, or — tap **Litres left** — most unused litres first (ties and
  used-up POs Z→A); the app remembers the choice. **#** is the list order (with the earlier formula, bills take the first PO with room),
  and ↑ / ↓ change that order (until the next upload, which takes the sheet's order).
- **Unit (SMC):** new SMC bills need a unit before they can get a PO; pick it
  in the bill list.
- **Pick a PO:** when more than one PO has enough litres left for a diesel
  bill, the bill waits for you to choose (Excel shows *Select PO ▼*): Home
  and the customer's PO page count them, and the bill shows a button per PO.
- **Re-uploading the Master Ledger** brings the app in line with Excel for
  sales, payments, opening balances, TDS / shortage / remarks and **the PO
  lists**: the Master Ledger is their source of truth, so each bulk ledger in
  the upload gets exactly its *_Bulk sheet's POs, litres and order — a PO
  added in the app but not on the sheet is removed (the preview names each
  PO added, changed or removed before anything is saved). A PO typed (or
  picked from *Select PO ▼*) on a Bulk sheet replaces the bill's PO in the
  app; a PO you picked in the app stays while the sheet's cell still has its
  formula. Ledger names and a bill's Unit belong to the app after the first
  upload — later uploads only fill in blanks. Payments copied from Master Paid are replaced by the
  workbook's list.

## Files

| File | What |
|---|---|
| `index.html` | The page (styles + start-up) |
| `config.js` | Supabase URL + publishable key of the ledger project |
| `js/app.js` | The screens |
| `js/daybook.js` | Reads a Tally DayBook like `ImportDayBook` |
| `js/master.js` | Reads the Master Ledger (sale sheets, Master Paid, Outstanding, Customer GST, every `*_Bulk` sheet) |
| `js/po.js` | The PO rule of the Bulk sheets |
| `js/register.js` | Register: reads the E-DSR, Stock Register and DIP Chart; each morning's dip stock and dips; a product's month (the DSR book and the Stock Register) |
| `js/register-view.js` | Register: the DSR book's and the Stock Register's tables, *This morning* |
| `js/register-demo.js` | Register: the demo's made-up month (tank chart, readings, receipts, dips) |
| `js/store.js` | Talks to the database (`ledger_*` functions); also the in-memory demo store |
| `js/bills.js` | Which bills go in which PDF (Module8 / Module7 rules) |
| `js/render.js` | Draws the tanker bill (A4) and fuel slip (A5); makes PDFs, JPEGs and zips |
| `js/statements.js` | Statement rules: ledger rows, bill statement, daily summaries, who gets what (Module1 / 2 / 6) |
| `js/statement-svg.js` | Draws the ledger, bill statement and daily summary pages |
| `js/xl-model.js` | Quotes: reads the Tanker Billing workbook into a model — cells, formulas, tables, names, styles, print areas, pictures |
| `js/formula.js` | Quotes: the spreadsheet engine that works out the workbook's own formulas |
| `js/vba.js` | Quotes: reads the macros' source out of the workbook (the PI Log follows Module1) |
| `js/docs.js` | Quotes: the Quotation, Proforma Invoice and Bank Pay credit note from the model — the form's cells, the Calculated panel, the page, the PI Log and CN Log rows (read from their macros), reprints, the self-check |
| `js/price-letter.js` + `assets/price-letter.docx` | The price letter: wording for a day or a period, rupees in words, the Word file (the template with the sentence and stamp put in) and the PDF page |
| `js/quote.js` | Quotes: the Customers table and PI Log sheet, the PI Log's rules (next PI No., the check against Excel's), file names |
| `js/sheet-svg.js` | Draws a sheet's print area as an A4 page, as Excel prints it |
| `js/demo-workbook.js` | The demo's Tanker Billing workbook (made-up data; made by `tools/demo_workbook.mjs`) |
| `assets/` | Letterhead and stamp for the tanker bill (copies of `/tanker/assets`), the quotation's letterhead, logo for the ledger |
| `js/payin.js` | Reads the payments app's list for the Payments tab |
| `js/modes.js` | Payments by mode: modes matched however typed, split payments, Cash / XtraPower first |
| `../fleet/js/loans.js` | Loans & EMI (shared with the fleet app): reading the banks' schedules, a loan from its terms, paid and left as of today |
| `js/dash.js` | Home dashboard figures (earnings, customers, outstanding, months) |
| `js/charts.js` | The dashboard's SVG charts and their tooltips |
| `js/account.js` | A customer's ledger as on their sheet (bulk layouts, formats) |
| `js/ledger-view.js` | The ledger as a statement (summary, months, company-wise outstanding) and the rate chart sheet |
| `js/share-svg.js` | Draws the shared pictures: ledger pages, outstanding cards, the outstanding list |
| `js/tally-file.js` | Tally viewer: reads a DayBook (Excel) or Tally XML (masters + vouchers), merges files, works out the insights |
| `js/tally-fin.js` | Tally viewer: financials (groups, P&L, balance sheet, months, ratios, trial balance) |
| `js/tally-recon.js` | Tally viewer: the app's balances against Tally's, and the entries behind each difference |
| `js/tally-stock.js` | Tally viewer: items bought / sold by month, pack sizes from item names |
| `js/tally-view.js`, `js/tally-reports.js` | Tally viewer screens |
| `js/tally-sample.js` | A made-up Tally export from the demo data (demo and tests) |
| `js/demo.js` | Made-up demo data |
| `js/util.js` | Dates, numbers, names |
| `../supabase/ledger-schema.sql` | Tables, row-level security and the `ledger_*` functions |

Libraries load from CDNs when needed: `@supabase/supabase-js` (esm.sh, same as
the other apps), SheetJS (cdn.sheetjs.com, same as `/loading/`), and jsPDF +
JSZip (cdnjs) for the bill and statement PDFs.

## Tests

```bash
node --test 'tests/ledger_web/*.test.mjs'   # DayBook, PO rule, Master Ledger reader, bills, statements, ledger view + pictures, quotes, demo store, Tally viewer
python -m pytest tests/test_ledger_web.py tests/test_ledger_schema.py -q
```

`test_ledger_schema.py` runs the SQL on a throwaway local Postgres with
Supabase's auth stubbed, and checks that the public key and non-member logins
get nothing. It is skipped when Postgres isn't installed. Set `LEDGER_XLSX` to
SheetJS's `xlsx.mjs` to also run the real-`.xlsx` round-trip tests. All test
data is made up.
