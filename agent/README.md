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

### 1. Gmail OAuth (one-time, per account) — spec §7

The runner authenticates each mailbox with a **refresh token** (not a password —
Google blocks datacenter password logins; a refresh token is revocable and
scoped to read-only Gmail).

1. In Google Cloud Console create a project, enable the Gmail API, and create an
   OAuth client of type **Desktop app**. Download `credentials.json`. Add each
   Gmail address as a **Test user** on the OAuth consent screen.
2. On the Mac, mint a refresh token **once per account** with the bundled helper
   (signs you in via the browser, read-only scope):

   ```bash
   pip install -r requirements.txt
   python3 mint_token.py --credentials credentials.json --out token_bank1.json  # sign in as account 1
   python3 mint_token.py --credentials credentials.json --out token_bank2.json  # sign in as account 2
   ```

3. Paste each printed JSON blob into a GitHub repo secret:
   `GMAIL_TOKEN_BANK1` (HDFC), `GMAIL_TOKEN_BANK2` (ICICI). The `token_*.json`
   files are git-ignored — delete them after copying.

### 2. Other secrets

- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT` — reuse the IOCL monitor's bot for
  failure alerts.
- **Keep the repo private.** Anyone with repo admin could add a workflow that
  prints secrets — no untrusted collaborators (same warning as IOCL).

### 3. Customer list

```bash
python3 export_customers.py     # reads Master Ledger.xlsm, writes state/customers.json
git add state/customers.json && git commit -m "refresh customers" && git push
```

Re-run whenever you add customers. (Open the workbook in Excel and save once
first, so column F's spill-formula values are cached for `data_only` reads.)

### 4. Tune the bank profiles

The two parser profiles in `agent/config.py` are a tolerant **starting point**.
Verify each against two or three real alert emails and adjust the one relevant
regex line if the wording differs. A parse miss never drops an alert — it queues
a `review` row carrying the raw text (also in the run-log artifact), so tuning is
low-risk and iterative.

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
