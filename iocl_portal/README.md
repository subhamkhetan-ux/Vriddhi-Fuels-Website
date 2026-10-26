# IOCL e-Mitra PAD balance → Payments

This browser worker opens e-Mitra, signs in, follows **Account Information →
PAD Statement**, and requests **yesterday → today in Asia/Kolkata** on every
run. Requesting today alone can produce a blank statement when no transactions
have posted. An empty report stops the run; it never becomes a zero balance.

The source is the **Balance (Rs.) cell on `CL.BAL.in Comp Code`**, immediately
above **Open Delivery value**. Open deliveries are excluded. The final
**Closing balance** footer is never used. A negative company balance becomes
an absolute amount with `CR`; a positive balance becomes `DR`.

## When it runs and what it saves

| Trigger | Result |
| --- | --- |
| Usable IndianOil invoice mail detected by the existing payment agent | Check PAD after ingest, including when another ingest task fails. |
| Every 3 hours (`7 */3 * * *`, UTC) | Check PAD as a fallback, including changes from payments and other transactions; fill in today's opening if it is missing. |
| Daily, four tries from **00:33 IST** (`3 19`, `23 19`, `43 19`, `8 20` UTC) | Save the new local day's opening in **Payments → Credit**, and save a changed current balance if needed. A try that finds the opening already saved stops before logging in. |

The existing Gmail agent checks mail every 20 minutes. The invoice trigger runs
after that detection, not at the instant an email arrives. Multiple invoices
in one ingest batch produce one PAD check.

Ordinary checks compare the amount **and DR/CR sign** with the latest balance
displayed by Credit (a snapshot or a newer daily opening). An unchanged value
creates no balance record and does not advance its timestamp. Changed values
are written to `pay_credit_balances`, then read back and verified. The first
valid observation is saved when there is no prior balance.

The opening is written to `pay_credit_opening` under its **IST calendar date**,
even when unchanged from yesterday. Its `updated_at` records the actual report
time. Existing openings, including manual corrections, survive reruns.

**Where the opening comes from.** The statement runs from yesterday to today,
so it carries today's opening itself: the running balance after **yesterday's
last entry**. If yesterday had no entry, it is yesterday's OP.BAL. With no
entry today yet, it is the CL.BAL.in Comp Code figure (open deliveries
excluded). The agent uses it whenever it reads the report, at any hour. The
nightly tries and **every** ordinary check (3-hourly, invoice-triggered) fill
in today's opening if it is missing. The statement has to prove it first:
- the Date, Debit and Credit columns are found by their headings;
- every entry between OP.BAL and CL.BAL is dated yesterday or today, in that
  order;
- each Balance is the previous one plus the debit, minus the credit, ending
  exactly on CL.BAL.

If it doesn't prove it, the job log says why (no amounts). Then only a reading
taken in 00:30–02:00 IST is used as the opening, so a late intraday balance is
never mislabelled. A late opening run still saves the current balance, then
fails so the miss shows; enter that day's opening manually through the
existing Credit controls. GitHub schedules are best effort and start late when
it is busy, worst on the hour: the single `0 19` run once started at 04:39
IST. That is why there are four tries at quiet minutes.

**Other deductions.** When the statement proves itself (the checks above),
every `sync` / `opening` run also marks its non-invoice **debits** in
**Payments → Credit → Other deductions** (`pay_other_deductions`), with the
reason taken from the **Item Text** column, e.g. `LICENSE FEE (SSLF) RECOVERY
(PAD doc 7012322266)`, dated to the entry's day. The Credit tab can't find
these from balances alone: it compares the balance with invoices, and a payment
credited the same day (ECollection, fleet card) hides any smaller deduction.
- A debit is an invoice, not a deduction, when its Item Text says `PRODUCT
  SUPPLY INVOICE` or its document number is already in `pay_fuel_invoices`.
- Credits (payments, reversals) are never marked.
- Ids come from the entry, so rereads add nothing; a deduction already
  confirmed by hand for the same day and amount isn't added again. One the
  agent marked comes back if deleted while it is still on the statement.
- The job log gives only the count. A dry run reports how many it would mark.

Both tables and realtime subscriptions already exist in
[`supabase/payments-schema.sql`](../supabase/payments-schema.sql); no schema or
frontend deployment change is needed. All PAD jobs share one concurrency group.

## Live setup

The worker runs only in the cloud, on the **India self-hosted runner** (label
`india`). GitHub's own runners are in the US/EU, and e-Mitra drops their
connections, so set up the free Oracle Cloud server first:
[`infra/india-runner/README.md`](../infra/india-runner/README.md).

**Live login is not verified yet.** Browser navigation has been tested against a
synthetic fixture, not the live site. Scheduled and invoice-triggered runs stay
off until `IOCL_PAD_SYNC_ENABLED=true`; manual runs are always available.

1. In repository **Settings → Secrets and variables → Actions**, add
   `IOCL_EMITRA_USERNAME` and `IOCL_EMITRA_PASSWORD` as **secrets**. Never place
   their values in source, a workflow, a command argument, or a run artifact.
2. Reuse the existing `SUPABASE_URL` and `SUPABASE_KEY` secrets used by the payment
   agent. When both are absent, the worker uses Payments' published public
   configuration. If exactly one is present, it stops. No additional
   service-role key is needed with the existing app schema.
3. In the **Actions** tab, enable **IOCL e-Mitra PAD balance → Payments** if it
   shows as disabled. Run it manually in `network` mode: the log should show
   country `IN` and `TCP 443: open`. Then run `probe`, which only opens the login
   form, and `dry-run`, which verifies login, the menu, yesterday/today dates,
   customer identity, fresh report timestamp and the company-code balance row.
   None of these modes writes a balance.
4. Once the live dry run succeeds, test `sync`, then set repository **variable**
   `IOCL_PAD_SYNC_ENABLED` to `true` to enable invoice-triggered and scheduled
   runs. `opening` is also available manually during its capture window.

Optional repository variables:

| Name | Default / purpose |
| --- | --- |
| `IOCL_CUSTOMER_CODE` | Login username; verifies the report belongs to this account. |
| `IOCL_CAPTCHA_LENGTH` | `6`, for the displayed uppercase text challenge. |
| `IOCL_SELECTORS_JSON` | Exact CSS selectors if the live layout differs. |

Selector keys are `username`, `password`, `captcha_image`, `captcha_input`,
`login`, `account_menu`, `pad_menu`, `from_date`, `to_date`, and `view`. Only
change these after inspecting the actual live page. No session-specific URL
from a screenshot is reused.

The CAPTCHA reader uses local Tesseract, requires two OCR layouts to agree,
and submits at most one login per run. Distorted challenges may require manual
entry; unattended CAPTCHA success cannot be guaranteed. Failed login,
unrecognized controls, stale/wrong-account reports, and uncertain amounts stop
the job. No browser profile, password, statement screenshot, or trace is saved
to Actions artifacts. Failed runs appear in GitHub Actions with a short summary.

## Tests

```sh
python -m pytest tests/test_iocl_portal.py tests/test_iocl_portal_browser.py tests/test_iocl_portal_trigger.py tests/test_credit.py -q
```

Tests use synthetic accounts, statements, CAPTCHA responses, and database
transports. Browser tests use an in-memory portal with all external requests
blocked. They check menu navigation, date boundaries, blank-report failure,
single-attempt login, excluded deliveries, change-only writes, daily openings,
and invoice events. They do not claim live portal or CAPTCHA compatibility.
