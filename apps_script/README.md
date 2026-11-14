# IOCL Challan — invoice PDFs saved to Google Drive (Google Apps Script)

[`iocl_challan.gs`](./iocl_challan.gs) saves every IndianOil invoice PDF from
Gmail into Google Drive, named by its invoice number and filed by its
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
  "IOCL Challan" as needed. **"IOCL Challan" itself is never created.** If it's
  moved or renamed, the run stops and Google emails you.
- **Never twice.** An invoice already anywhere inside "IOCL Challan" is skipped.
  That includes a late challan you downloaded and put in yourself, named by its
  invoice number (`7013019147.pdf`, or `7013019147 (1).pdf`), in any month
  folder or at the top.
- **The invoice date** is the one the payment agent read off the PDF, from the
  decant app's invoice list. A mail newer than the agent waits for the next
  run; after 6 hours it's filed by the mail's own date.
- **Done mails get the Gmail label "IOCL Challan saved"** and aren't looked at
  again. Remove the label from a mail to have it checked again.
- **If a run fails**, Google emails you about it.

## Setup (once, ~5 minutes, on any computer)

Do this signed in as the **Gmail account that receives the IOCL invoice mails**
(the HDFC alerts mailbox).

1. Go to **script.google.com → New project**. Name it *IOCL Challan*.
2. Delete what's in the editor, paste the whole of
   [`iocl_challan.gs`](./iocl_challan.gs), and save (⌘S).
3. **If that Gmail account is not the one whose Drive has
   "IOCL Challan"** (subhamkhetan@gmail.com):
   - In Drive, **share** the "IOCL Challan" folder with the mail account as
     **Editor**.
   - Put the folder's id in `FOLDER_ID` near the top of the script: the last
     part of the folder's link, `drive.google.com/drive/folders/<id>`.
4. In the toolbar's function list pick **`install`** and press **Run**.
   Google asks for permission (Gmail, Drive, and connecting to the invoice
   list).
   - It warns *"Google hasn't verified this app"*. That's your own script, so
     click **Advanced → Go to IOCL Challan (unsafe) → Allow**.
   - This makes the every-30-minutes trigger and runs it once. The log at the
     bottom says how many it saved, how many were already there, and how many
     are waiting.

That's all. To stop it: the clock icon (**Triggers**) on the left → delete the
trigger.

## Settings (top of the script)

| Setting | Default | What |
|---|---|---|
| `FOLDER_PATH` | `Vriddhi Fuels/OLD Data/IOCL Challan` | where the folder is, from the top of My Drive |
| `FOLDER_ID` | *(empty)* | the folder's id instead; needed when the script runs in another account |
| `START` | `2026/11/01` | the oldest mails looked at. The folder already has everything before this; set it earlier to back-fill (50 mails a run) |
| `WAIT_HOURS` | `6` | how long a mail waits for its invoice date before it's filed by the mail's date |

Tests: [`tests/apps_script/`](../tests/apps_script/) runs the script in Node
against stand-ins for Gmail and Drive (`python3 -m pytest tests/test_apps_script.py`).
