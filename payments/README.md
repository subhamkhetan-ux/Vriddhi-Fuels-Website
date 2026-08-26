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
3. Tap **Download .xlsx** → open it and paste the rows into the **Master Paid**
   sheet of `Master Ledger.xlsm` (Paste Special → Values, under the last row).
4. Exported entries **drop off the list** and move to a searchable **Exported ·
   last 7 days** section (then auto-clear). They can never be double-exported.

No `git`, no `python`. The cloud cron keeps the list filled every ~20 minutes.

**Off-email payments** (cash, cheque, a transfer with no alert) — tap **＋ Add**,
enter date / customer / amount / mode, and it joins **Ready to export** like any
matched credit. It exports and drops off the same way.

## How it connects

```
Gmail → agent (GitHub Actions) → Supabase (pay_credit_queue) → this app → .xlsx → Master Paid
                                   ↑ pay_credit_aliases ←──────────┘ (names you confirm)
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
   (safe to re-run). It creates the two tables, RLS, realtime, and the 7-day
   purge. Same project as your `/pay` app is fine.
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
