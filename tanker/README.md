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

Two ways to authorize. **Method A (OAuth token) is recommended** — it reuses the
exact mechanism the Gmail agent already uses (`mint_token.py` → a refresh token
in a GitHub secret), and because the token is *your own Google account* — the
one whose Drive holds the file — there is **no service account and no
file-sharing** to set up.

### Method A — OAuth refresh token (recommended)

> Note: a Gmail **App Password** (the 16-character kind) cannot be used here —
> App Passwords only work for IMAP/SMTP, not the Drive API. What the Gmail agent
> actually uses is an OAuth refresh token, and that is what we mint below.

1. **Enable the Drive API** — <https://console.cloud.google.com/> → your project
   (the same one as the Gmail agent is fine) → **APIs & Services → Library** →
   enable **Google Drive API**.
2. **Mint the token** on your Mac, signing in as the account whose Drive holds
   the workbook. Reuse the Gmail agent's `credentials.json` (Desktop-app OAuth
   client), or create one:
   ```bash
   python3 tanker/mint_drive_token.py --credentials credentials.json --out gdrive_token.json
   ```
   It opens a browser for consent and prints an authorized-user JSON blob.
3. **Add the GitHub secret/variable** — repo → **Settings → Secrets and
   variables → Actions**:
   - **Secrets → New:** `GDRIVE_TOKEN` = the entire blob it printed.
   - **Variables → New:** `TANKER_DRIVE_FILE_ID` = the file id from its Drive URL
     (`.../file/d/<FILE_ID>/view`). *(Optional — the job can also find it by
     name; override the name with `TANKER_FILE_NAME`.)*

### Method B — service account (alternative)

1. **APIs & Services → Credentials → Create credentials → Service account**
   (no roles) → open it → **Keys → Add key → JSON**. Note its email.
2. **Share** `Tanker Billing.xlsm` (or its folder) with that email as **Viewer**.
3. Add secret `GDRIVE_SA_JSON` = the key file contents, and variable
   `TANKER_DRIVE_FILE_ID` as above.

That's it. The **Sync tanker billing data** workflow
(`.github/workflows/tanker-sync.yml`) then runs **daily** and on demand
(**Actions → Sync tanker billing data → Run workflow**), refreshing the JSON
whenever the workbook changed. Change the `cron` in that file to run a little
after your own daily Drive sync finishes.

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
