# Customer bills macro (Master Ledger.xlsm)

`CustomerBills.bas` makes the same bills as the ledger app's **Statements → Customer
bills**, inside Excel: SCPL-style bills for **any customer**, one PDF with **a page per
vehicle tag** (Shivaay Logistics: JSW, 700 Acre, …), or on one page.

## Put it in the workbook (once)

1. Open **Master Ledger.xlsm** in Excel.
2. **Tools → Macro → Visual Basic Editor** (or **Option + F11**).
3. **File → Import File…** and pick `CustomerBills.bas`. A module named
   **modCustomerBills** appears under *Modules*.
4. Close the editor and save the workbook (it stays `.xlsm`).

It doesn't change any of your existing macros, and its names don't clash with them.

## Make a bill

1. **Tools → Macro → Macros…** → **CustomerBills** → **Run** (or put it on a button).
2. **Customer:** type its number from the list, or a name exactly as in the sale sheets'
   Customer column. A customer not set up yet is added with *a page per vehicle tag,
   monthly, HSD*.
3. **Period:** it offers last month (or, for a "10 days" customer, the 10 days just
   gone, as the SCPL bill does). Change the dates if you need to (dd/mm/yyyy).
4. **Vehicles with no tag:** they're added to the tag list on **Bill Setup**
   (highlighted). Choose **YES** to stop and fill them in, then run again. Choose **NO**
   to make the bill without those bills.
5. **The first time** it asks whether to save the **letterhead** and **stamp** pictures in
   the workbook. Pick them once. Without them the heading is typed text and there's no
   stamp. Run **CustomerBills_Pictures** to change them later.
6. The PDF is saved on the **Desktop**, for example `Shivaay Logistics Bill Oct 2026.pdf`.
   The bill also stays on the **Customer Bill** sheet to check or print.

## The Bill Setup sheet

Made on the first run. One row per customer:

| Column | What |
|---|---|
| A Customer | exactly as in the HSD Sale sheet's Customer column |
| B Split | `Tag` (a page per vehicle tag) or `One page` |
| C Period | `Month` or `10 days` |
| D Products | `HSD`, or e.g. `HSD, MS, XG` (a page per tag and product) |
| E / F / G | Bill To name / address / GSTIN; blank = from the customer's ledger sheet (K3, Q10, Q11) |

**Vehicle tags** (J:L): Customer | Vehicle No. | Tag. The vehicle no. can be typed any way
(`OD15AF5510`, `od 15 af-5510`). Vehicles with the same tag go on the same page. A word
typed in the sale sheet's Vehicle column instead of a vehicle no. ("JSW",
"Transporting") is its own tag without a row here.

**Payment details** (N4:N7): the four lines printed on every bill. They start as the
ICICI current account.

## Each page

The letterhead, **Bill To** (name, address, GSTIN) and **Date: from To to**, then
**Vehicles: JSW** and **Product: HSD**. Then the table: Date, Bill No, Vehicle, Quantity,
Rate/Ltr, Amount, sorted by date then bill no. A red, bold **TOTAL** follows, then the
payment details, the stamp, and *For VRIDDHI FUELS · Signature of Customer*. Each tag
starts a new A4 page, fitted to the width.

## Tested

`tests/test_customer_bills_macro.py` runs the macro for real in LibreOffice's VBA mode on
a made-up workbook. It checks:
- the split by tag, the auto tags from words, and the untagged list;
- the period, the file names, and the Indian amounts;
- each page's contents (Bill To from the ledger sheet, the table and TOTAL, the payment
  details);
- one page with HSD and MS.

The dialogs, the pictures and Excel's PDF export can't run there. The PDF is saved the
same way as the workbook's own statement macro (Module1).
