# Tally Voucher App — Step-by-Step Setup Guide

Follow the parts in order. Part A–C are one-time setup (about 20 minutes);
Part D is what employees do daily. Nothing here needs a developer.

---

## Part A — Put the app live

1. **Merge the pull request** into `main` on GitHub.
2. The site deploys automatically via GitHub Pages. The app's address is:

   ```
   https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/tally/
   ```

3. Open it once in a browser to confirm it loads. At this point it runs in
   **single-device mode** (no login) — that changes after Part B.

## Part B — Create the shared backend (Supabase, one time)

This gives all employees one live shared dataset with instant sync.

1. Go to **[supabase.com](https://supabase.com)** and sign in (create a free
   account if needed — the free tier is enough for this app).
2. Click **New project**:
   - **Do NOT reuse the indent app's project — create a separate one.**
   - Name: e.g. `vriddhi-tally`
   - Database password: choose a strong one and store it safely (it is not
     needed for daily use)
   - Region: **Mumbai (ap-south-1)** (closest to Jharsuguda)
3. Wait ~2 minutes for the project to be created.
4. Open **SQL Editor** (left sidebar) → **New query** → copy the ENTIRE
   contents of [`supabase/tally-schema.sql`](../supabase/tally-schema.sql)
   from this repo, paste it in, and press **Run**.
   - You should see *"Success. No rows returned"*.
   - The script is safe to run again later (e.g. after app updates).
5. Create one login per employee: **Authentication → Users → Add user →
   Create new user**:
   - Email: `<username>@vriddhi.local` — e.g. `ramesh@vriddhi.local`.
     The employee will sign in with just `ramesh`.
   - Password: at least 6 characters (you hand this to the employee).
   - Tick **Auto Confirm User**.
   - Repeat for each employee (and one for yourself, e.g. `owner`).
6. Get the two keys: **Project Settings → API**:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon / publishable key** — a long string starting `eyJ…` or
     `sb_publishable_…`. (Never use the `service_role` / `sb_secret_` key.)

## Part C — Connect the app to the backend

1. In GitHub, open the file **`tally/config.js`** and click the ✏️ edit
   button. Replace the two placeholder values:

   ```js
   window.VRIDDHI_TALLY_CONFIG = {
     SUPABASE_URL: "https://abcdefgh.supabase.co",       // your Project URL
     SUPABASE_ANON_KEY: "sb_publishable_xxxxxxxxxxxx",   // your anon key
   };
   ```

2. **Commit changes** (to `main`). Wait 1–2 minutes for the site to redeploy.
3. Open the app again — it now shows a **Sign in** screen. Sign in with a
   username + password from Part B step 5.

### Load your Tally data (one time, from any ONE device)

4. On the home screen tap **"⬆ Import Tally XML (DayBook / Master)"** and
   pick your **Master.xml** (ledgers export). Expected result:
   *"Customer list set to Sundry Debtors: 119 customers"*.
   - To export it from Tally Prime: **Gateway of Tally → press Alt+E
     (Export) → Masters** → type of masters: **All Masters**, format
     **XML** → export.
5. Tap the same button again and pick your **DayBook.xml**. Expected:
   *"Vouchers added: 1964 (1639 HSD, 319 MS, 6 XG)"* plus the next invoice
   numbers (1640 / MS320 / XG7) and today's prices.
   - To export it from Tally Prime: **Gateway of Tally → Day Book →
     press F2** to set the period (01-Apr-2026 to today) → **Alt+E
     (Export)** → format **XML** → export. A ~100 MB file is fine — the
     app reads it in about a second.
6. That's it — the data is **shared**. Every other phone only needs to
   sign in; customers, old vouchers, counters and prices are already there.

### Install on each phone

7. Open the app URL in Chrome (Android) or Safari (iPhone), sign in, then
   use **Add to Home Screen** so it opens like a normal app.

## Part D — Daily use (employees)

1. Tap the **Diesel**, **Petrol** or **XtraGreen** card.
2. **Search and select the customer** (type a few letters).
3. Enter the **vehicle number** (optional).
4. Enter **quantity in litres** — the amount fills in automatically — OR
   type the **amount in ₹** (e.g. "₹20,000 ka diesel") and the litres are
   calculated. The price is preset to today's price; both stay editable.
5. **Round off** only if needed: type the value yourself (e.g. `0.22` or
   `-0.11`). Nothing is rounded automatically.

> **Prices.** The price prefilled here is today's price for that product,
> set in **Settings** (see below). It is editable on the voucher for a
> one-off rate, and changing it here **never changes that day's price** for
> other vouchers.
6. **Save.** The invoice number is automatic — every employee's phone shows
   the voucher instantly, and two employees can never get the same number.
7. Mistake? Tap the voucher in the day list to **edit** it (it keeps its
   number), or ✕ to delete it.
8. **End of day → "⬇ Download XML — <date>"**. The file always contains
   the WHOLE day and can be downloaded again any number of times (after a
   late correction, just download again). Import it in **Tally Prime:
   Gateway of Tally → Import Data → Vouchers**, into company
   **VRIDDHI FUELS (2026-27)**.
9. After confirming the import in Tally, optionally tap
   **"✓ Day imported in Tally — move to old vouchers"** to tidy the list.
   The day can still be re-exported later if the file is ever lost.

## Part E — VERIFY BEFORE GO-LIVE (do this once, it matters)

1. Create **one** small test voucher in the app and download the XML.
2. Import it into a **BACKUP copy** of your Tally company (not the live one).
3. Open the imported voucher in Tally and compare with a hand-entered one:
   party, quantity, rate, amount, R/off, voucher type, invoice number.
4. Only after they match, start daily use on the live company.

## Troubleshooting & tips

| Problem | Fix |
|---|---|
| "Wrong username or password" | Check the username (no `@vriddhi.local` needed) and password; reset it in Supabase → Authentication → Users if forgotten. |
| App loads without a login screen | `tally/config.js` still has placeholders, or the redeploy hasn't finished — hard-refresh after 2 minutes. |
| Voucher import into Tally rejects/skips rows | Party/ledger name doesn't exist in Tally masters. Names must match EXACTLY (case, spacing, `&`). Create the ledger in Tally first. |
| New customer walks in | Best: create the ledger in Tally first, then re-import Master.xml (or add the party in the app with the exact same spelling). |
| Vouchers were entered directly in Tally | Export a fresh DayBook and import it in the app (duplicates are skipped automatically), or correct "Last invoice number" in Settings. |
| Change today's price | **Settings → the product's "Today's price"** → Save. It stays that price on the following days too, until you change it again. Saving vouchers never changes it, even if a voucher's own rate is edited. |
| One-off different rate for a voucher | Just edit the Price field on that voucher. It affects only that voucher — the day's price stays as set in Settings. |
| Employee left the company | Supabase → Authentication → Users → delete or ban the user. |
| Imported the same day's XML into Tally twice | Duplicate vouchers in Tally — delete one set in Tally (Day Book → select voucher → Alt+D). The app deliberately allows repeated exports; managing repeats in Tally is the operator's job. |
