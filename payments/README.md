# Vriddhi Fuels — Payments app (`/payments/`)

The **no-terminal** front end for the Gmail → Master Paid agent. The cloud agent
reads bank credit alerts and writes them to Supabase; this app shows them, lets
you resolve any unmatched names, and exports the confirmed ones to a
Master-Paid `.xlsx` — all from your phone or desktop.

## Daily routine (that's it)

1. Open the app (add it to your home screen once — it's an installable PWA).
2. New credits show under **Ready to export**, already matched. Anything the
   agent couldn't match sits under **Needs review** — tap a suggested name (or
   type one) to resolve it. Each name you confirm is **remembered** (saved as an
   alias) so that payer auto-matches next time.
3. Tap **⤴ Log to Excel** → the entries are sent to the always-on **Mac agent**,
   which writes them straight into the **Master Paid** sheet of `Master Ledger.xlsm`
   for you. They appear under **Queued to log** (with a **cancel** until the agent
   picks them up), then drop into **Exported** marked **logged ✓**. The **Activity**
   feed at the bottom shows the agent online and every row it logs. See
   [`local_agent/README.md`](../local_agent/README.md) for the one-time Mac setup.
   *(The **.xlsx** button is still there as a fallback: download a batch and paste
   it into Master Paid by hand — Paste Special → Values, under the last row.)*
4. Logged/exported entries **drop off the list** and move to a searchable **Exported
   · last 7 days** section (then auto-clear). They can never be double-logged.

No `git`, no `python`. The cloud cron keeps the list filled every ~20 minutes.

**Off-email payments** (cash, cheque, a transfer with no alert) — tap **＋ Add**,
enter date / customer / amount / mode, and it joins **Ready to export** like any
matched credit. It exports and drops off the same way. Mode chips include Cash,
Cheque, UPI, Bank Transfer and **XtraPower** (or type your own). Got a detail
wrong? Tap **edit** on a manual entry in **Ready** to fix its date / customer /
amount / mode before it's exported.

## Consignment notes (Indian Oil invoices, own TT OD23U8210)

Every new IndianOil tax invoice for **our own tank truck** arrives in the HDFC
mailbox (`B2BPRD@indianoil.in`). The agent detects it, reads the attached PDF,
and queues a **consignment note** — you don't touch the terminal.

The app has two tabs: **Payments** and **Consignment notes**. Open the
**Consignment notes** tab (a badge shows how many are waiting). Each card shows
the auto-assigned serial (`VF/CN2627/047`, `048`, …), the invoice number/date,
and the goods, quantity and value pulled from the invoice. The **printed serial
restarts each Indian financial year** (invoice date based): `VF/CN2627/…` for
FY 2026-27, then `VF/CN2728/001, 002, …` from 1 April 2027 — so the number reads
as the trip count within that FY. A separate lifetime counter tracks **total
trips to date**, shown in the app as a summary line and an "overall trip #" on
each card (not on the printed note). Serials never change once issued.

1. Set the **Reporting date** (top of the note — the TT's next reporting date;
   defaults to the invoice date, change it to the next day if needed).
2. Tap **Print / Save as PDF** — the app fills your fixed letterhead and opens
   the print dialog; pick your printer or **Save as PDF**. (**.docx** is there
   too if you'd rather open it in Word.) Everything else on the note stays as-is.

Numbering starts at **047 = invoice 7010221545** and counts up from there; any
IOC invoice older than that is ignored (already covered by the manual notes up
to 046). The app keeps **only the latest 5 notes** — older ones drop off
automatically (serials never repeat). Only invoices for **OD23U8210** produce a
note. The letterhead lives in
[`payments/consignment_template.docx`](./consignment_template.docx) with the
fill-in fields as `{{TOKENS}}`; the app never alters anything else.

### Invoice mail didn't come? Upload the PDF

If an IndianOil invoice mail never reaches the HDFC mailbox, add it by hand:
tap **⬆ Upload invoice PDF** on the **Consignment notes** tab (or **⬆ Invoice
PDF** on the Credit tab's day-wise ledger) and pick the invoice PDF. The app
reads it in the browser — the same reader as the `/decant/` app — and shows what
it will do before you tap **Save**:

- **Credit** — the invoice total is added to that day's invoices (any truck), and
  the per-KL price is updated if this is the newest invoice.
- **Consignment note** — created with the next serial when it's eligible, the same
  rules as the mail: TT **OD23U8210** only, invoice **7010221545** (047) onward.
  Another TT or an older invoice gets no note.
- **Decant app** — the invoice is put in the decant app's own project too (any
  truck, with its chambers), so the tanker shows under **To decant** there, ready
  for *Start decanting*, on every phone. If that truck was already **typed in** on
  the decant app for the same day, it isn't added again (the preview says so;
  tick *It's a different load* if it really is another trip). An invoice more
  than a few days old sits under *Older, not decanted in the app* there, as the
  decant app does with its own uploads.

Nothing is ever added twice. The upload is stored under the same keys the agent
uses (the invoice number for Credit; the note id derived from it), so when the
mail **does** arrive later the agent finds it already there and skips it — no
second total, no second note, no serial spent, and no second truck in the decant
app (whatever you've done to it there — chambers, a decantation — stays). Uploading the same PDF again just
says it's already recorded.

**One consignment note per invoice number — never a second.** Supabase keeps a
permanent record of every invoice that has been issued a note
(`pay_consignment_issued`, never purged), and the claim function checks it
whichever way the invoice comes in: the mail, an IOCL resend, a PDF uploaded
here, even after the note has dropped off the 5-note list. An invoice that
already has a note only shows that note's serial; it is never issued again and a
dismissed note is never put back on the list. (Printing a note that's on the
list again — same serial — is still fine.) Notes issued before this record
existed and since purged can't be looked up, so an invoice older than every
note on record gets no note automatically. **Re-run
`supabase/payments-schema.sql` once** for this; until then the app makes no notes
from a PDF.

## Credit & dues (IOCL fuel account)

The **Credit** tab tracks the IOCL credit facility and when each day's invoices
must be repaid.

The optional [e-Mitra PAD worker](../iocl_portal/README.md), once configured and
enabled, checks after invoice detection and every three hours. It saves changed
balances excluding open deliveries and captures each day's opening at 00:30 IST.
It always requests yesterday through today to avoid empty same-day statements.

- **Limit + repayment window** at the top are editable (default **₹85,00,000**
  and **T+2 working days**). Change them any time. **0 working days** means each
  day's invoices must be cleared the **same day, before midnight**.
- **Opening balance (per day)** — paste the start-of-day figure and tap **Save as
  opening for…** (or tap a day's *Opening* cell in the table). This re-anchors the
  dues math to a known figure each morning, so tracking stays precise without
  needing the entire invoice history; days before the latest opening collapse
  into it and show as **carried forward**.
- **Invoices** are pulled from mail automatically — **all** IndianOil invoices
  (every truck, not just OD23U8210), summed per day. If a mail was missed or
  misread, tap a day's **₹ amount** to correct that day's total by hand.
- **Balance**: paste the IndianOil balance message (e.g. *"…Provisional A/c
  Balance for MS-HSD is Rs. 6836847.03 Cr"*) and tap **Save balance**. The app
  reads just the **amount** and **DR/CR** (DR = you owe, CR = in credit), so it
  survives wording changes. Paste a fresh one whenever it updates through the day.
- **Dues schedule**: each day's invoices get a due date = invoice date + the
  repayment window, rolled to the next **working day** (Sundays and 2nd/4th
  Saturdays are automatic). Your latest balance is applied **oldest-invoices-
  first**, so the table shows exactly what's still owed and by when (overdue is
  flagged, and the tab shows a badge when something is due/overdue).
- **Other bank holidays**: when a payment is due on a date that isn't an
  automatic holiday, the app asks *"is the bank open on <date>?"*. Tap **Open** to
  confirm, or **Closed** and give the date the bank **reopens** — it marks every
  day in between as closed (so a multi-day festival is one action) and moves the
  due date to the reopen day. It only asks when money is actually due; otherwise
  it assumes the bank is open.

- **Funds needed by date**: right under the limit/cycle, a compact table groups
  the unpaid dues by **due date** (₹ to arrange on each day, plus a total) so you
  can plan cash date-wise.
- **How much can I order**: shows how many **KL** of **HSD** / **MS** the **PAD
  available** funds can cover. The per-KL price (after VAT) is read
  **automatically** from each invoice's per-product *"Total for material" ÷ KL*,
  and updates whenever IOCL revises it; type a price only to override. Recomputes
  the moment you update the balance.

All of this is stored in Supabase (re-run `supabase/payments-schema.sql` once to
add the new tables/columns). The mail agent writes invoices; the optional PAD
worker writes balances and daily openings. App edits sync across your devices.
The **Credit** tab sits right after
**Payments**.

## How it connects

```
Gmail → agent (GitHub Actions) → Supabase (pay_credit_queue) → this app → .xlsx → Master Paid
                                   ↑ pay_credit_aliases ←──────────┘ (names you confirm)
IOC invoice PDF ─┘             → Supabase (pay_consignment_notes) → this app → printable PDF / .docx
```

- **Queue** lives in `pay_credit_queue`; the app reads pending + last-7-day
  exported rows in real time.
- **Aliases** you confirm are written to `pay_credit_aliases`; the agent reads
  them back so matching keeps improving on its own.
- The repo's `state/*.json` remains the agent's source of truth and idempotency
  guard — Supabase is a live mirror, not a replacement. If Supabase is down, the
  agent still ingests; the app just shows an **offline** pill.

## One-time setup

1. **Schema** — in Supabase → SQL Editor, run
   [`supabase/payments-schema.sql`](../supabase/payments-schema.sql) once
   (safe to re-run). It creates the payment + alias tables, the consignment-note
   table with its serial counter (seeded at **047**), RLS, realtime, the 7-day
   payment purge and the keep-latest-5 note cap. **Re-run it after this update.**
   Same project as your `/pay` app is fine. (One-time only: if the agent already
   auto-created a batch of notes, run
   [`supabase/reset_consignment.sql`](../supabase/reset_consignment.sql) once to
   restart numbering at 047 — see that file's header.)
2. **App keys** — [`payments/config.js`](./config.js) already points at your
   Supabase project (`SUPABASE_URL` + anon key). `CUSTOMERS_URL` defaults to the
   committed `state/customers.json` for the review autocomplete.
3. **Agent secrets** — add repo secrets `SUPABASE_URL` and `SUPABASE_KEY` so the
   Actions runner can write the queue and read aliases. Use the **service_role**
   key (kept secret in Actions) or the anon key — both work with the schema's
   RLS. The workflow already passes them through.

## Notes

- **Possible duplicates** (same date + customer + amount) are flagged in the
  Ready list — verify before exporting; nothing is auto-dropped.
- **Skip** leaves a review row for later; **drop** removes an alert entirely.
- **Undo** on an exported row brings it back to Ready (within the 7-day window).
- The anon key is safe in the client; access is limited to the two payment
  tables by RLS. Never put a `service_role` / `sb_secret_` key in `config.js`.
- `.xlsx` cell types (date serials, plain amounts, sheet "Master Paid") match
  the agent's `materialize.py` and the `/pay` app exactly, so imports drop in.
