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
and the goods, quantity and value pulled from the invoice.

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

## Credit & dues (IOCL fuel account)

The **Credit** tab tracks the IOCL credit facility and when each day's invoices
must be repaid.

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
- **How much can I order**: enter the current **HSD** and **MS** ₹/KL (after VAT)
  and the app shows how many **KL** of each the **PAD available** funds can cover.
  It recomputes the moment you update the balance.

All of this is stored in Supabase (re-run `supabase/payments-schema.sql` once to
add the new tables/columns). The agent only writes the invoices; everything else
you set in the app syncs across your devices. The **Credit** tab sits right after
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
