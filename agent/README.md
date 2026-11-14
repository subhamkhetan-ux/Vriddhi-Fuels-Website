# Gmail → Master Paid Payment Agent

Reads bank **credit-alert emails** from two Gmail accounts, extracts
`amount + date + payer`, fuzzy-matches the payer to a canonical customer, and
turns confirmed entries into an `.xlsx` you import into **Master Paid** in
`Master Ledger.xlsm`.

This is a re-target of the proven WhatsApp `vriddhi_pay.py` logic (the same
matcher / date-serial / idempotency model that lives in this repo's `pay/` PWA),
pointed at Gmail and run as a GitHub Actions cron. Built to
`gmail_payment_agent_spec.md`.

## The mental model (read this first)

The pipeline is **two halves bridged by committed state**, because a cloud runner
can't touch your Mac's iCloud Drive:

```
  Gmail  ──►  agent/run.py (cloud, cron)  ──►  state/queue.json  ──►  materialize.py (Mac)  ──►  PaymentEntries_YYYY-MM-DD.xlsx  ──►  Master Ledger.xlsm
             parse · match · queue            (committed to repo)      review · export · mark
```

The real online/offline axis is **not** "is the runner up" — it always runs with
network. It's **"queued in cloud" vs "materialized on Mac."** The queue *is* the
offline buffer: if the Mac is off for a week, alerts pile up in `queue.json` and
flush into **one** `.xlsx` on the next local run. Two idempotency guards make
that flush safe (see below), so nothing is ever entered twice.

## Layout

| Path | Half | What it is |
|---|---|---|
| `agent/run.py` | cloud | Orchestrator: read alerts → parse → match → queue. `python -m agent.run` |
| `agent/gmail_client.py` | cloud | Gmail API via OAuth refresh token (read-only scope) |
| `agent/parser.py` + `agent/config.py` | cloud | Parser engine + **the two bank profiles (edit here)** |
| `agent/matcher.py` `normalize.py` `serial.py` | both | Ported name matcher, noise-stripping, date-serial |
| `agent/telegram.py` | cloud | Failure alerts (never fail silently) |
| `agent/decant.py` | cloud | Every IOCL invoice with its chamber table → `dec_invoices` in the [`/decant/`](../decant/) app's **own** Supabase project (from `decant/config.js`, never the payments one); runs last, and its problems are only logged |
| `materialize.py` | Mac | Queue → review → `.xlsx`, marks rows materialized |
| `export_customers.py` | Mac | Export Master Paid column F → `state/customers.json` |
| `state/*.json` | bridge | `queue` · `seen` (high-water) · `aliases` · `customers` |
| `.github/workflows/payment-agent.yml` | cloud | The cron |

## Idempotency (why duplicates are impossible) — spec §6

1. **Ingest guard (cloud):** `state/seen.json` holds a per-account high-water
   mark (newest Gmail `internalDate`) plus recent message ids. The mark advances
   **only past alerts actually queued**, so a transient error resurfaces an alert
   rather than losing it. A given email is queued at most once.
2. **Materialize guard (Mac):** each queue row has a stable `entry_id` (hash of
   the Gmail message id). `materialize.py` emits only `matched` rows not yet
   `materialized`, then flips them and commits. A re-run — or the Mac being off
   for a week — can never produce a duplicate `.xlsx` entry.

## Matching & the shrinking review queue — spec §5

- The ported matcher folds case **and punctuation** (`akv` → `A.K.V. Logistics`,
  `smc` → `M/s Smc Power Generation Ltd.`). Bank noise (`M/S`, honorifics,
  trailing UTR/ref tokens) is stripped before matching.
- Tiers: exact → unique substring → ambiguous → no match. Ambiguous/unmatched
  names are **never auto-guessed** — they queue as `review`.
- **Learned aliases** (`state/aliases.json`) are checked first. The **first**
  time a remitter is confirmed on the Mac, its raw string is saved → canonical
  customer, so it auto-passes forever. That's what makes the review queue shrink
  instead of nagging every run.

## Setup

### 1. Gmail access — App Password over IMAP (one-time, per account)

The runner reads each mailbox over **IMAP with a Google App Password** (see
`agent/gmail_client.py`). App Passwords **don't expire** on a clock — no OAuth,
no Google Cloud project, no consent screen, no verification. (This replaced OAuth
refresh tokens, which Google expired every ~7 days for apps in "Testing".)

Per account (do this for both Gmail accounts):

1. Enable **2-Step Verification** on the Google account (required for App
   Passwords): Google Account → **Security → 2-Step Verification**.
2. Create an **App Password**: Google Account → **Security → App passwords** →
   name it e.g. `Vriddhi agent` → copy the 16-character password it shows.
   (IMAP is already on in Gmail by default.)
3. Put a JSON blob into the matching GitHub repo secret (mapping per
   `agent/config.py`):
   - `GMAIL_TOKEN_BANK1` = account-1 mailbox (ICICI alerts)
   - `GMAIL_TOKEN_BANK2` = account-2 mailbox (HDFC alerts + IOC invoices)

   ```json
   {"email": "you@gmail.com", "app_password": "abcd efgh ijkl mnop"}
   ```

   (Spaces in the app password are ignored. The secret names are unchanged, so
   the workflow needs no edit.) `mint_token.py` and the Google Cloud OAuth setup
   are **no longer used**.

### Troubleshooting: an account fails to authenticate

If a run logs e.g. `[bank2] FAILED: … AUTHENTICATIONFAILED` for one mailbox:

- The **App Password was revoked** or the account password changed → create a new
  App Password (step 2 above) and update that mailbox's secret with fresh JSON.
- **2-Step Verification got turned off** → App Passwords require it; re-enable it,
  then create a new App Password.
- The JSON is malformed → it must be exactly `{"email": "…", "app_password": "…"}`.

Then re-run: Actions → **Payment agent (Gmail → queue)** → **Run workflow** (or
wait for the 20-min cron). Unlike the old OAuth tokens, App Passwords don't expire
on their own, so this shouldn't recur.

### 2. Other secrets

- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT` — reuse the IOCL monitor's bot for
  failure alerts.
- **Keep the repo private.** Anyone with repo admin could add a workflow that
  prints secrets — no untrusted collaborators (same warning as IOCL).

### 3. Customer list

The canonical customer names (used to match bank credits, and for manual entry)
come from your **Tally Sundry Debtors**. The easiest way to keep them current:

- In the **[`/payments`](../payments/) app → Customers tab**, upload your Tally
  **Master.xml** (Gateway of Tally → Export → All Masters, XML). The app parses
  only the **Sundry Debtors** (including sub-groups like *RCP COMPANIES*), shows a
  diff (new / removed), and on confirm **replaces** the roster in Supabase. Both
  the app and this cloud agent read that roster (the agent unions it with the
  committed `state/customers.json` seed, so a bad upload can never shrink the
  matchable set). No `git`/deploy needed — it reaches matching on the next run.

`state/customers.json` remains a committed fallback seed. To refresh it from the
ledger instead (legacy path):

```bash
python3 export_customers.py     # reads Master Ledger.xlsm column F, writes state/customers.json
git add state/customers.json && git commit -m "refresh customers" && git push
```

(Open the workbook in Excel and save once first, so column F's spill-formula
values are cached for `data_only` reads.)

### 4. Tune the bank profiles

The two parser profiles in `agent/config.py` are a tolerant **starting point**.
Verify each against two or three real alert emails and adjust the one relevant
regex line if the wording differs. A parse miss never drops an alert — it queues
a `review` row carrying the raw text (also in the run-log artifact), so tuning is
low-risk and iterative.

## IOCL Challan — invoice PDFs in Google Drive

Every IndianOil invoice PDF (our TT and transport TTs alike) from the HDFC
mailbox is saved into the firm's existing **IOCL Challan** folder. It's named by
its invoice number and filed by its **invoice date**, the same way as the
challans already there:

```
My Drive / Vriddhi Fuels / OLD Data / IOCL Challan / 2026 / November 2026 / 7013019147.pdf
```

- **Year and month folders** (`2026`, `November 2026`) are made automatically
  inside "IOCL Challan" when a new month or year starts. The job runs with the
  payment agent, every ~20 min (`agent/drive_archive.py`).
- **"IOCL Challan" itself is never created.** It's found by its path. If it's
  renamed or moved, the job reports it (Telegram, at most once a day) and waits,
  without making a second folder. Point it at the new place with the repo
  variable `DRIVE_ARCHIVE_PATH` (path from the top of My Drive), or
  `DRIVE_ARCHIVE_FOLDER_ID` (the folder's id, the last part of its link).
- **Never twice.** An invoice already anywhere inside "IOCL Challan" is skipped.
  That covers one this job saved (a resent mail, a re-run) and a **late challan
  you downloaded and put in yourself**, named by its invoice number
  (`7013019147.pdf`, or a browser's `7013019147 (1).pdf`): in its month,
  another month, or the top. A file with that number outside "IOCL Challan"
  doesn't count.
- **Nothing lost.** A mail counts as done only once its PDFs are in Drive. While
  Drive is unreachable (or the token is expired) the job catches up later.
  Drive problems never fail the payments run.

**One-time setup** (on the Mac, ~5 min):

1. Google Cloud Console (the project your Gmail OAuth client is in) →
   **APIs & Services → Library → Google Drive API → Enable**.
2. Mint the token, signing in as the Google account whose Drive holds the
   folder (it asks for full Drive access, needed to use the existing folder
   and see the challans you put in by hand):

       python3 mint_drive_token.py --credentials credentials.json --out gdrive_upload_token.json

3. GitHub → repo **Settings → Secrets and variables → Actions → Secrets**:
   `GDRIVE_UPLOAD_TOKEN` = the printed JSON. Then delete
   `gdrive_upload_token.json`.

The challans already in the folder stay as they are. The job starts with the
last 10 days of mail and skips everything already there. (Optional variable
`DRIVE_ARCHIVE_SINCE=YYYY-MM-DD` goes further back, 60 mails per run.)

Invoices added in the payments app from a PDF or typed in (no mail) aren't
saved by this job.

## Daily use — the app (no terminal)

The easiest daily path is the **[`/payments/`](../payments/) web app** (a PWA,
like `/pay`). It reads the queue from Supabase, lets you resolve review names on
your phone (saving aliases the agent reads back), and exports the `.xlsx` — no
`git`/`python`. See [`payments/README.md`](../payments/README.md) for the one-time
Supabase setup. The terminal flow below still works as a fallback.

### Fully hands-off: the Mac logging agent

To skip even the `.xlsx` paste, run the **[`local_agent/`](../local_agent/)** daemon
on your Mac. It's always on, and when you tap **⤴ Log to Excel** in the app it writes
the approved payments straight into the **Master Paid** sheet of `Master Ledger.xlsm`
(driving the real Excel app, so macros/formulas survive) and reports every action
back to the app's **Activity** feed. It only ever writes rows you pushed, catches up
safely after being offline, and can never double-post. See
[`local_agent/README.md`](../local_agent/README.md).

## Daily use (Mac, terminal fallback)

```bash
git pull
python3 materialize.py          # resolve any review rows once; writes the .xlsx
# import PaymentEntries_YYYY-MM-DD.xlsx into Master Paid
git add state/queue.json state/aliases.json
git commit -m "materialize batch" && git push
```

`python3 materialize.py --dry-run` shows what would export without changing
anything; `--no-input` skips the review prompt (materializes only already-matched
rows).

## Cron reality — spec §8

- Schedule is every 20 min; don't go tighter (GitHub throttles). A credit alert
  queued 20 min late is fine.
- GitHub disables cron on dormant repos after 60 days; the state commits usually
  keep it alive, but watch for the reactivate banner.

## The `.xlsx` shape — spec §3

Sheet **"Master Paid"**, columns **Date · Customer · Amount Paid · Payment Mode**:
- **A** = Excel **date serial** (days since 1899-12-30), *not text*, shown
  `dd/mm/yyyy`.
- **C** = plain number, no separators in the value.
- **D** = `"<BANK> <RAIL>"`, e.g. `HDFC NEFT`, `ICICI UPI`.

Cell types match the proven `pay/` writer exactly, so the file drops in cleanly.

## Tests

```bash
pip install -r requirements.txt
python -m pytest -q
```

Covers the ported matcher (incl. `akv`, `smc`, `maa samlai`, ambiguous, no-match),
date-serial edge cases, both bank parsers, the `.xlsx` shape, ingest + both
idempotency guards, aliases, and the amount-sanity flag.

## Build order (spec §10) — where each piece lives

1. `materialize.py` against a hand-written `queue.json` — `tests/test_materialize.py`
2. Parser + matcher as pure functions with unit tests — `tests/test_matcher.py`, `test_serial.py`, `test_parser.py`
3–4. One/both Gmail accounts, alias table, review flow — `agent/gmail_client.py`, `agent/run.py`, `tests/test_run.py`
5. GitHub Actions — `.github/workflows/payment-agent.yml`
