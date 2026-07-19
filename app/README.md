# Vriddhi Fuels — Indent Management PWA

A mobile-first, installable Progressive Web App for placing and managing fuel
indents (Petrol / Diesel / XtraGreen), with a strong **non-repudiation / proof**
audit trail. Built as a static single-page app talking directly to
[Supabase](https://supabase.com) (Postgres + Auth + Row-Level Security +
realtime). No build step, runs on free tiers.

> This is a **separate app** from the existing Master Ledger at the repo root
> (`/index.html`). The ledger is untouched. This app lives entirely under
> `/app/` and is served at `/app/`.

## What's here

```
app/
  index.html            The whole PWA (login + customer + employee + admin)
  config.js             Paste your Supabase URL + anon key here
  manifest.webmanifest  PWA manifest (installable)
  sw.js                 Service worker (app-shell cache, offline history)
  icon.png              App icon
supabase/
  schema.sql            Tables, enums, sequential IND-#### ids, append-only
                        audit log, RLS policies, and all mutation RPCs
  functions/admin-create-user/index.ts   Edge function to create username+password users
```

## Roles

| Role | Can do |
|---|---|
| **Customer** | Place indents (3-step wizard, vehicle optional), repeat last order, approve/reject staff-logged indents, modify/cancel own open indents, view history + invoices + monthly statements, acknowledge/dispute statements. |
| **Employee** | Live realtime board (today's totals + filters), mark delivered (full or partial), modify open indents. **Cannot create or cancel indents.** |
| **Admin** | Everything employees do, **plus** create/cancel indents (log on behalf), user management (create / reset password / activate / deactivate), block/unblock customers, set daily prices, monthly statement sender, CSV export, one-tap **proof pack** (indent + full audit trail, print to PDF). |

**Delivery (full / partial):** when marking an indent delivered, staff choose
**Fully delivered** or **Partial**. Partial asks for the litres/₹ actually
delivered, and the **invoice bills the delivered amount** (not the ordered
amount). The board and detail view show "Partial: X delivered".

## Setup (one time)

### 1. Create a Supabase project
Free tier is enough. From the dashboard note **Project URL** and the **anon key**
(Project Settings → API).

### 2. Run the database schema
Open **SQL Editor** in Supabase, paste the contents of
[`supabase/schema.sql`](../supabase/schema.sql), and run it. This creates all
tables, the append-only audit log, RLS policies, and the mutation RPCs.

### 3. Configure the client
Edit [`app/config.js`](./config.js) and paste your values:

```js
window.VRIDDHI_CONFIG = {
  SUPABASE_URL: "https://YOURPROJECT.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...your anon key...",
};
```

### 4. Password length
Supabase Auth requires passwords of **at least 6 characters**, so give every
account a password of 6+ characters. (To allow shorter, lower **Authentication →
Providers → Email → Minimum password length** in the dashboard.)

> **How login works:** users log in with a **username + password**. Internally
> the app maps the username to a hidden email `<username>@vriddhi.local` — you
> never see or manage that email; you only deal with the username. Usernames are
> lowercased and limited to letters, numbers, dot, dash and underscore
> (e.g. `rajfleet01`). Email confirmations are bypassed.

### 5. Bootstrap the first admin
The app has no public sign-up (closed user base). Create the first admin by hand:

1. **Authentication → Users → Add user**
   - Email: `owner@vriddhi.local` (your chosen username + `@vriddhi.local`)
   - Password: a password of 6+ characters
   - Tick "Auto Confirm User" if asked, then copy the new user's **UUID**.
2. In **SQL Editor**, run (substitute the UUID and the same username):
   ```sql
   insert into public.app_users (id, username, name, role)
   values ('PASTE-UUID-HERE', 'owner', 'Owner', 'admin');
   ```

Now log into the app with that username + password. From **Users** you can create
every other account (customers, employees, admins) — each with a username and
password you hand to them — no more manual steps.

### 6. Deploy the admin-create-user edge function
This lets the admin create username+password accounts from inside the app.

```bash
# https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref YOURPROJECT
supabase functions deploy admin-create-user
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically for deployed functions — no secrets to set.

### 7. Serve the app
It's static — host `/app/` anywhere (GitHub Pages, Netlify, Vercel static, or
alongside the existing site). On a phone, open it in Chrome and **Add to Home
screen** to install the PWA.

## Proof / non-repudiation (how it's enforced)

- **Server timestamps only** — every row uses `now()`; the client clock is never
  trusted.
- **Append-only audit log** — `audit_log` has no UPDATE/DELETE policy *and* a
  trigger that hard-blocks updates/deletes for everyone. The only writer is the
  internal `_audit()` function, which is *revoked from clients*.
- **All mutations go through `SECURITY DEFINER` RPCs** (`place_indent`,
  `approve_indent`, `deliver_indent`, …) so permission checks and the audit write
  happen atomically. Clients get **SELECT-only** table access; RLS ensures a
  customer sees only their own indents.
- **Informed-consent confirm screen** shows full details before the placing tap.
- **"Delivered without customer approval"** is recorded as a distinct, weaker-proof
  audit note (shown in red on the proof pack).
- **Monthly statement** acknowledge / dispute is stored as an audit event.
- **Proof pack** — open any indent → *Proof pack (PDF)* → the browser's print
  dialog produces a PDF of the indent details + chronological audit trail.

## Daily prices & invoices

- **Admin → Reports → Today's fuel prices:** set each product's ₹/L rate (tax-inclusive).
  Prices are an append-only history. **Skipping a day is fine** — the most recent
  rate automatically carries forward until you enter a new one. The screen shows
  whether each price was "set today" or "carried from" an earlier date.
- **Customers** see a "Today's rates" banner on their home screen.
- **Invoices** are created automatically when an indent is marked **Delivered**,
  using that shift-day's rate. Numbered sequentially `INV-0001`. Tax-inclusive
  (no GST breakup). For ₹-amount orders, litres are computed as ₹ ÷ rate.
  Open a delivered indent → **🧾 Invoice** to view and **Print / Save as PDF**.
  Staff can **Regenerate** an invoice (e.g. after entering a price that was
  missing at delivery time). Customers can view/print their own invoices.
- **Invoice header** (business name + year, multi-line address, GSTIN, state
  name/code, mobile, e-mail) is edited in **Admin → Reports → Business details**.
- **Invoice layout** replicates the Vriddhi "CREDIT MEMO": black tag + mobile,
  centered letterhead with logo, No./Date/M-s/Vehicle rows, a bordered
  Particulars/Quantity/Rate/Amount table, a "Thank You / Total" row, and
  Customer's / Salesman signature lines. Product names print formally
  (Diesel → "High Speed Diesel", Petrol → "Motor Spirit", XtraGreen → "XtraGreen").
  The invoice **No.** shows the plain running number (strip of `INV-`); to
  continue an existing series, restart the sequence, e.g.
  `alter sequence public.invoice_code_seq restart with 1619;`.

> After pulling these changes, **re-run `supabase/schema.sql`** once in the SQL
> Editor — it adds the `product_prices` and `invoices` tables and the pricing
> functions. It's written to be safe to re-run.

## Business day (shift)

The business day is a **6am-to-6am IST shift**: an indent is attributed to the
date the shift *started*. So the shift for 18/07 covers 18/07 06:00 → 19/07 06:00,
and an indent placed at 3am on the 19th still counts under the 18th. This applies
to the employee board's "today" totals, the admin daily summary, and the month a
monthly statement groups by. IST is a fixed UTC+5:30 (no DST), so the boundary is
exact.

## Not yet wired (next steps)

These are scaffolded/documented but need extra setup to go live:

- **Web Push notifications** (approval requests, delivery, statements). Needs FCM
  keys + a push subscription table + a sender. The event points already exist in
  the RPCs.
- **Automated 9 PM IST daily summary** push. The summary is available on demand in
  **Admin → Reports**; automating the push needs a scheduled edge function
  (`pg_cron` / Supabase scheduled functions).
- **IP capture** in the audit log (`ip` column exists; the browser can't read its
  own IP, so populate it from an edge function if needed).
- Hindi toggle, credit ledger, delivery photo/signature — see requirements §10.
