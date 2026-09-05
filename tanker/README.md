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

## One-time setup (Google Drive service account)

You do this once. ~10 minutes.

1. **Create a service account**
   - Go to <https://console.cloud.google.com/> → create (or pick) a project.
   - **APIs & Services → Library →** enable **Google Drive API**.
   - **APIs & Services → Credentials → Create credentials → Service account.**
     Name it e.g. `tanker-sync`. No roles needed.
   - Open the new service account → **Keys → Add key → Create new key → JSON.**
     A `.json` file downloads. Note the account's **email**
     (`...@...iam.gserviceaccount.com`).

2. **Share the workbook with it (read-only)**
   - In Google Drive, right-click **`Tanker Billing.xlsm`** (or the folder it's
     in) → **Share** → paste the service account email → **Viewer** → Send.

3. **Get the file id**
   - Open the file in Drive; the URL is `.../file/d/<FILE_ID>/view`. Copy
     `<FILE_ID>`. (Optional — the job can also find it by name.)

4. **Add the GitHub secrets/variables**
   In the repo: **Settings → Secrets and variables → Actions**.
   - **Secrets → New repository secret:** `GDRIVE_SA_JSON` = the entire contents
     of the downloaded JSON key file.
   - **Variables → New repository variable:** `TANKER_DRIVE_FILE_ID` = the
     `<FILE_ID>` from step 3.
     *(Optional)* `TANKER_FILE_NAME` if you rely on name lookup instead of id
     (defaults to `Tanker Billing.xlsm`).

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
export GDRIVE_SA_JSON=/path/to/service-account.json   # file path or raw JSON
export DRIVE_FILE_ID=<file id>                          # or rely on name search
python3 tanker/sync_tanker_billing.py --from-drive
```

Dependencies: `openpyxl`, `google-api-python-client`, `google-auth`
(all already in the repo's `requirements.txt`).
