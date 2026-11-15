# IOCL Challan — invoice PDFs saved to Google Drive (Google Apps Script)

[`iocl_challan.gs`](./iocl_challan.gs) saves every IndianOil **fuel invoice** PDF
from Gmail into Google Drive, named by its invoice number and filed by its
**invoice date**, the same way as the challans already there:

```
My Drive / Vriddhi Fuels / OLD Data / IOCL Challan / 2026 / November 2026 / 7013019147.pdf
```

It's a **Google Apps Script**: it lives in your Google account and Google runs it
every 30 minutes on its own servers.

- **Nothing to expire.** There's no token and no app password; it runs as you.
- **Nothing to keep on.** No Mac or computer needs to be running.

What it does:
- **All trucks**: our TT and transport TTs alike.
- **Year and month folders** (`2027`, `January 2027`) are made inside
  "IOCL Challan" as needed. **"IOCL Challan" itself is never created.** It's
  found by its id, so moving or renaming it is fine. If it's deleted or
  un-shared, the run stops and Google emails you.
- **Never twice.** An invoice already anywhere inside "IOCL Challan" is skipped.
  That includes a late challan you downloaded and put in yourself, named by its
  invoice number (`7013019147.pdf`, or `7013019147 (1).pdf`), in any month
  folder or at the top.
- **Only fuel tax invoices.** A PDF is saved only if the payment agent read it
  as a tax invoice with a truck (T.T.No.) and products with quantities. Those
  are the ones on the decant app's invoice list, with their invoice date.
  - **Other IOCL PDFs are left out.** These come from the same sender but are
    never on that list: credit notes for dealer margin, statements and so on.
  - **A mail the agent hasn't reached yet waits** for a later run. If it's still
    not on the list after 24 hours, it's taken as not a fuel invoice.
  - **If the list can't be reached, the mail just waits.** It's never left out
    for that.
- **Each checked mail gets a Gmail label** and isn't looked at again:
  - **IOCL Challan saved**: its fuel invoice is in Drive (saved by the script,
    or already there).
  - **IOCL Challan skipped**: it has no fuel invoice, e.g. a payment
    acknowledgement ("PDF ATTCHMNT.PDF"), a credit note or a statement.

  Remove the label from a mail to have it checked again. Mails an earlier
  version labelled "saved" without an invoice in Drive can be moved to
  "skipped" by running **`fixOldLabels`** once (pick it in the toolbar, then
  Run).
- **If a run fails**, Google emails you about it.

## Setup (once, ~5 minutes, on any computer)

The IOCL invoice mails come to **sunilkhetan1976@gmail.com**, so the script runs
there. The "IOCL Challan" folder is in **subhamkhetan@gmail.com**'s Drive and is
shared with sunilkhetan1976@gmail.com as **Editor**. The script finds it by its id,
which is already filled in (`FOLDER_ID`).

1. Signed in as **sunilkhetan1976@gmail.com**, go to **script.google.com →
   New project**. Name it *IOCL Challan*.
2. Delete what's in the editor, paste the whole of
   [`iocl_challan.gs`](./iocl_challan.gs), and save (⌘S).
3. In the toolbar's function list pick **`install`** and press **Run**.
   Google asks for permission (Gmail, Drive, and connecting to the invoice
   list).
   - It warns *"Google hasn't verified this app"*. That's your own script, so
     click **Advanced → Go to IOCL Challan (unsafe) → Allow**.
   - This makes the every-30-minutes trigger and runs it once. The log at the
     bottom says how many it saved, how many were already there, and how many
     are waiting.

That's all. To stop it: the clock icon (**Triggers**) on the left → delete the
trigger.

The PDFs the script adds are owned by sunilkhetan1976@gmail.com (they use a
little of its Drive space, ~100 KB each). They sit in subhamkhetan@gmail.com's
folder like any other file. If the folder is ever un-shared, the run fails and
Google emails sunilkhetan1976@gmail.com.

## Settings (top of the script)

| Setting | Default | What |
|---|---|---|
| `FOLDER_ID` | `1wcWIymyJ11TkA3Hl6Cegn-ktKmNPQKZs` | the "IOCL Challan" folder (subhamkhetan@gmail.com's, shared to the mail account) |
| `FOLDER_PATH` | `Vriddhi Fuels/OLD Data/IOCL Challan` | used instead when `FOLDER_ID` is empty: the path from the top of the script account's My Drive |
| `START` | `2026/11/01` | the oldest mails looked at. The folder already has everything before this; set it earlier to back-fill (50 mails a run) |
| `WAIT_HOURS` | `24` | how long a PDF waits to appear on the invoice list before it's taken as not a fuel invoice |

Tests: [`tests/apps_script/`](../tests/apps_script/) runs the script in Node
against stand-ins for Gmail and Drive (`python3 -m pytest tests/test_apps_script.py`).

---

# Purchase Orders — customers' POs saved to Google Drive

[`purchase_orders.gs`](./purchase_orders.gs) saves the purchase orders customers
send to **subhamkhetan@gmail.com** into Google Drive, by customer and by the
**year of the mail**:

```
My Drive / PO / Shyam Metalics / 2026 / PO_4500123456.pdf
```

What counts and where it goes:
- **A PO mail:** it comes from a customer in the script's `CUSTOMERS` list, and
  has **PO**, **P.O.** or **Purchase Order** in its subject or an attachment's
  name ("POWER" or "PORT" don't count). Its PDFs are saved; set `TYPES` to also
  take Excel or images.
- **Folders:** "PO" is made at the top of My Drive if it isn't there, and so
  are the customer and year folders.
- **Never twice.** A file with the same name and size already in that folder is
  skipped. A *different* file with the same name is kept as
  `<name> (dd-mm-yyyy).pdf`.
- **Each checked mail gets a label** and isn't looked at again: **PO saved**,
  or **PO skipped** when it had nothing to save.
- **It runs every hour.** If a run fails, Google emails you.

## Setup (once)

1. Signed in as **subhamkhetan@gmail.com**, go to **script.google.com → New
   project** and name it *Purchase Orders*. Paste the whole of
   [`purchase_orders.gs`](./purchase_orders.gs) and save.
2. **Find the senders:** pick **`findPoSenders`** in the toolbar dropdown and
   **Run**, allowing access the first time ("Google hasn't verified this app" →
   Advanced → Go to … → Allow). The log lists everyone who sent PO-looking mail
   in the last 2 years, with counts, as ready-to-paste lines:

       'Rakesh': ['shyammetalics.com'],   // 14 mail(s), e.g. "Purchase Order for HSD"

3. **Make the customer list:** copy the lines that are real customers into
   `CUSTOMERS` near the top. Rename each to the customer's name, which becomes
   its folder name, and save.
   - A domain (`shyammetalics.com`) covers everyone at that company.
   - An address (`ankitaair@gmail.com`) covers only that sender. That's the
     form used for gmail and other public mailboxes.
4. **Start it:** pick **`installPurchaseOrders`** and **Run**. This makes the
   hourly trigger and saves the POs found so far: all past mail, 50 mails a
   run, oldest last. Set `START` (e.g. `2025/04/01`) to go back less far.

To add a customer later, add a line to `CUSTOMERS` and save; the next run picks
up their POs. Tests:
[`tests/apps_script/purchase_orders.test.mjs`](../tests/apps_script/purchase_orders.test.mjs).
