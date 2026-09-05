# Tanker Billing — data sync

The tanker-bill web app never opens the master **`Tanker Billing.xlsm`**. Instead
a scheduled job reads the workbook, extracts the tables that drive a bill, and
commits them as **`state/tanker_billing.json`**. The app reads that JSON. This is
how the app stays current with new customers, changed PO numbers, and price
changes — all of which you keep editing in the workbook exactly as you do today.

```
Tanker Billing.xlsm  (iCloud master; you edit it in Excel)
        │  your existing daily sync
        ▼
Google Drive copy  ──[service account, read-only]──►  GitHub Action (daily)
                                                              │ parse Customers /
                                                              │ RateCard / ProductRates
                                                              ▼
                                                 state/tanker_billing.json  (committed)
                                                              │
                                                              ▼
                                                     tanker-bill web app
```

Why Drive and not iCloud: iCloud Drive has no service API a server can log into,
so the app relies on the Google Drive copy you already sync to daily.

> **One requirement on the workbook:** the parser reads *cached* formula values
> (`data_only`), so the Drive copy must have been **saved by Excel at least once
> after any change**. Your normal "edit in Excel, let it sync" workflow already
> does this — just don't hand-edit the raw file outside Excel.

## What gets materialized

`state/tanker_billing.json`:

| Key | From the workbook | Used for |
|---|---|---|
| `customers[]` | `Customers` table (A1:M32) | name, address lines, GSTIN, payment block, PO label + PO no., price tier, resolved HSD rate |
| `rate_card` | `RateCard` table (O1:P9) | tier → ₹/Ltr (e.g. `HSD RSP` 100.74, `DBL Price` = RSP−0.75) |
| `product_rates` | `ProductRates` table (R1:S3) | non-HSD products (Motor Spirit, XtraGreen Diesel) |
| `fuel_types` | `FuelTypes` table (U1:U4) | the product dropdown (default **High Speed Diesel**) |

A bill's price = customer's `hsd_rate` when product is High Speed Diesel,
otherwise `product_rates[product]`; amount = `TRUNC(quantity × price)`.

## One-time setup

Two ways to authorize. **Method A (service account) is recommended** — it needs
**no OAuth consent screen / "Branding" page** and its key **does not expire**,
which are exactly the two problems with the OAuth flow (Method B): its refresh
token expires after ~7 days unless you publish the app "In production" (the
Branding/verification flow). A service account sidesteps all of that and still
keeps the file private (you share it with one machine account, nothing is made
public).

### Method A — service account (recommended: no Branding, never expires)

1. **Create the service account** — <https://console.cloud.google.com/> → pick
   or create a project → **IAM & Admin → Service Accounts → Create service
   account**. Give it a name (e.g. `tanker-sync`), **no roles needed**, Done.
   *(This screen has no consent/Branding step.)*
2. **Make a key** — open the new service account → **Keys → Add key → Create new
   key → JSON**. A `.json` file downloads. Note the account **email**
   (`…@…iam.gserviceaccount.com`).
3. **Enable the Drive API** — **APIs & Services → Library** → search **Google
   Drive API** → **Enable**. *(Enabling an API is separate from the consent
   screen — no Branding needed.)*
4. **Share the workbook with it** — in Google Drive, right-click
   **`Tanker Billing.xlsm`** (or its folder) → **Share** → paste the service
   account **email** → **Viewer** → Send.
5. **Add the GitHub secret/variable** — repo → **Settings → Secrets and
   variables → Actions**:
   - **Secrets → New:** `GDRIVE_SA_JSON` = the entire contents of the JSON key.
   - **Variables → New:** `TANKER_DRIVE_FILE_ID` = the file id from its Drive URL
     (`.../file/d/<FILE_ID>/view`). *(Optional — the job can also find it by
     name; override with `TANKER_FILE_NAME`.)*

> If your Google Workspace admin blocks service-account **key creation**, use
> Method B instead, or ask me to wire the "shared-link" fallback (download a
> link-shared file with no credentials — simplest, but the link must be treated
> as a secret since anyone with it can view the file).

### Method B — OAuth refresh token (reuses the Gmail agent's mechanism)

> A Gmail **App Password** (16-char) cannot be used here — App Passwords only
> work for IMAP/SMTP, not the Drive API. This mints an OAuth refresh token, the
> same kind `mint_token.py` uses. **Caveat:** to stop the token expiring after
> ~7 days you must set the OAuth app to "In production" (the Branding flow).

1. **Enable the Drive API** (as above), same project as the Gmail agent is fine.
2. **Mint the token** on your Mac, signing in as the account whose Drive holds
   the workbook (reuse the Gmail agent's `credentials.json`):
   ```bash
   python3 tanker/mint_drive_token.py --credentials credentials.json --out gdrive_token.json
   ```
3. **Add** secret `GDRIVE_TOKEN` = the printed blob, and variable
   `TANKER_DRIVE_FILE_ID` as above.

That's it. The **Sync tanker billing data** workflow
(`.github/workflows/tanker-sync.yml`) then runs **hourly** and on demand
(**Actions → Sync tanker billing data → Run workflow**), refreshing the JSON
whenever the workbook changed (it only commits on an actual change). Adjust the
`cron` in that file to change the cadence.

## Running it by hand

Against a local copy of the workbook (no Drive needed) — handy for testing:

```bash
python3 tanker/sync_tanker_billing.py --xlsm "Tanker Billing.xlsm"
```

Against Google Drive (what the Action runs):

```bash
export GDRIVE_TOKEN=/path/to/gdrive_token.json   # OAuth blob (path or inline)
# or, for method B:  export GDRIVE_SA_JSON=/path/to/service-account.json
export DRIVE_FILE_ID=<file id>                    # or rely on name search
python3 tanker/sync_tanker_billing.py --from-drive
```

Dependencies: `openpyxl`, `google-api-python-client`, `google-auth`
(all already in the repo's `requirements.txt`). Minting a token additionally
uses `google-auth-oauthlib`, also already listed.
