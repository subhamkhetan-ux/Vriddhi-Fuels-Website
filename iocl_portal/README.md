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
| Every 3 hours (`7 */3 * * *`, UTC) | Check PAD as a fallback, including changes from payments and other transactions. |
| Daily at **00:30 IST** (`0 19 * * *`, UTC) | Save the new local day's opening in **Payments → Credit**, and save a changed current balance if needed. |

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
time. Existing openings, including manual corrections, survive reruns. To avoid
mislabeling a late intraday observation, opening mode stops outside
00:30–02:00 IST. Enter a missed opening manually through the existing Credit
controls. GitHub schedules are best effort: 00:30 is the requested start time,
not an exact capture-time guarantee.

Both tables and realtime subscriptions already exist in
[`supabase/payments-schema.sql`](../supabase/payments-schema.sql); no schema or
frontend deployment change is needed. All PAD jobs share one concurrency group.

## Live setup

**Live login is not verified yet.** The development cloud proxy currently blocks
the IndianOil host. Browser navigation has been tested against a synthetic
fixture, not the live site. The Actions workflow remains inactive automatically
until `IOCL_PAD_SYNC_ENABLED=true`; manual probe/dry-run is available after the
workflow reaches the default branch.

1. In repository **Settings → Secrets and variables → Actions**, add
   `IOCL_EMITRA_USERNAME` and `IOCL_EMITRA_PASSWORD` as **secrets**. Never place
   their values in source, a workflow, a command argument, or a run artifact.
2. Reuse the existing `SUPABASE_URL` and `SUPABASE_KEY` secrets used by the payment
   agent. When both are absent, the worker uses Payments' published public
   configuration. If exactly one is present, it stops. No additional
   service-role key is needed with the existing app schema.
3. Run **IOCL e-Mitra PAD balance → Payments** manually in `probe` mode. This
   only opens the login form. Then use `dry-run` to verify login, the menu,
   yesterday/today dates, customer identity, fresh report timestamp, and the
   company-code balance row. Neither mode writes a balance.
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

Cloud development permissions and GitHub Actions secrets are separate. To test
from the managed cloud, apply the saved environment network draft for
`utkarsh.indianoil.co.in`, the Payments Supabase host, and `api.github.com`, and
provide the two IOCL credential environment bindings securely. Saving a draft
does not apply its network policy to an already-running environment.

## Local use and tests

Install Python 3.12+, dependencies from `iocl_portal/requirements.txt`, Playwright
Chromium (`python -m playwright install chromium`), and Tesseract (for example
`brew install tesseract` on macOS). Supply credentials through the environment
or a secret manager. `IOCL_CHROMIUM_EXECUTABLE` can select an installed Chromium.
TLS verification remains enabled, and configured HTTPS proxies are respected.

```sh
python -m iocl_portal.run --probe
python -m iocl_portal.run --dry-run
python -m iocl_portal.run --sync
```

On a desktop, `--manual-login --dry-run` opens a visible browser and gives you
three minutes to complete login yourself. Set `IOCL_CUSTOMER_CODE` for report
verification; that mode does not need the username/password environment values.

```sh
python -m pytest tests/test_iocl_portal.py tests/test_iocl_portal_browser.py tests/test_iocl_portal_trigger.py tests/test_credit.py -q
```

Tests use synthetic accounts, statements, CAPTCHA responses, and database
transports. Browser tests use an in-memory portal with all external requests
blocked. They check menu navigation, date boundaries, blank-report failure,
single-attempt login, excluded deliveries, change-only writes, daily openings,
and invoice events. They do not claim live portal or CAPTCHA compatibility.
