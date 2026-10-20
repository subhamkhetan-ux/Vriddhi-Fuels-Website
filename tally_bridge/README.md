# Vriddhi Fuels — Tally Prime bridge

The bridge connects **one Vriddhi Fuels company** on a Windows PC to the existing [Tally web app](https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/tally/). It uses the app's dedicated Supabase project, `qlloauxmfenrrqvfqibp`, and Tally's local XML interface. There is no inbound Internet connection to the PC and no Supabase service-role key in the installer.

## Install and activate

1. **Database, once:** open the **Tally project's** Supabase SQL editor. Existing installations already have `supabase/tally-schema.sql`; run [supabase/tally-bridge.sql](../supabase/tally-bridge.sql). For a new installation run `tally-schema.sql` first, then `tally-bridge.sql`. Both can be rerun. Do not run these in the Payments, Ledger or Fleet project's database. This repository does not contain a database administrator credential, so publishing the website does **not** apply this migration automatically.
2. **Tally Prime:** back up the company, open it on the Windows PC, and enable its HTTP/XML server on port **9000** (or another local port). In Tally Prime's advanced connectivity settings, enable the server/HTTP interface; the exact menu label varies by Prime release. The XML interface, not merely an ODBC client connection, must respond. Keep port 9000 private; do not port-forward it or open it to the Internet. The bridge connects to `127.0.0.1` only.
3. In the web app's **Settings**, confirm the exact company name shown in Tally. The current default is `VRIDDHI FUELS (2026-27)`. If automatic financial-year naming is enabled, pairing resolves the current Indian financial year. Each queued voucher also records its date's company name; a voucher for another year cannot post into the currently paired company. The installer verifies the name and Tally's company GUID. A different financial-year company is intentionally rejected after pairing.
4. Download `VriddhiTallyBridge.exe` and `SHA256SUMS.txt` from the [Windows release](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/releases/tag/tally-bridge-v1.0.1). Python is bundled; no Python installation or administrator account is needed. The executable is not code-signed. Check the published SHA-256 if Windows displays an unknown-publisher prompt:

   ```powershell
   Get-FileHash .\VriddhiTallyBridge.exe -Algorithm SHA256
   ```

5. Open the installer. Click **Test Tally** and verify that your company appears. In the web app, open **Tally connection & reports → Connect PC → Create pairing package**. Paste the package into the installer and choose **Install & pair**. The package expires after ten minutes and can be used once. Pairing a replacement PC revokes the old PC's credential.
6. Wait for **Connected to Tally Prime** in the web app. The initial company read must finish before automatic posting starts. New vouchers and supported edits now queue automatically. Existing unlinked invoices remain untouched until you select **Queue for Tally** in Sync activity.
7. Verify the first test sales invoice and a day-book report against Tally Prime on this PC. Check voucher type/number, date, party, quantity, rate, round-off, GST classification, vehicle UDF and totals. This is the necessary live acceptance check: automated tests use synthetic Tally responses, not your licensed Tally installation.

The installer starts the bridge after this Windows user signs in. Keep Tally Prime open and the user signed in. Locking the screen is fine; shutdown, sleep, sign-out or closing Tally pauses live sync. No Windows service runs before sign-in. Use Windows' own power settings if this PC should remain awake during office hours.

## What syncs

| Direction | Coverage |
|---|---|
| Web → Tally | The web app's HSD CREDIT, MS CREDIT and XG CREDIT sales vouchers; new invoices and supported edits; existing vehicle UDF, party GST classification and round-off are retained. |
| Tally → web data explorer | All voucher types; ledgers, groups, stock items/groups, units, godowns, voucher types, cost centres and currencies. The full exported XML is retained privately in Supabase. |
| Tally → web fuel editor | Fuel sales that the editor can represent: one inventory line, expected sales ledger, main godown/batch, party ledger and optional round-off. Complex bills, bank/cost-centre allocations, multiple items or extra tax ledgers stay in Tally data/reports and are not flattened into editable fuel invoices. |
| Reports | Native Tally day book, ledger statement, trial balance, balance sheet, profit & loss, receivables, payables, stock summary and cash/bank summary. Report availability/names depend on the Tally release and company features. Unsupported reports show an error and retain any previous saved result. |

The existing web app remains a fuel voucher editor. It does not become an editor for every Tally voucher/master type. Create missing parties, stock items, voucher types and allocation rules in Tally Prime first; the bridge does not invent those accounting masters. Reports are fetched from Tally's own reporting engine rather than reconstructed from incomplete totals. No automatic messaging, payment execution or GST filing is included.

## Ledger PDF and Excel downloads

In **Tally connection & reports → Reports**, select **Ledger statement**, search for a synced ledger, choose dates and select **Fetch from Tally** (or **Open saved report**). You can also open a ledger report directly from **Tally data → Ledger**.

- **Download PDF** creates a paginated file in the browser, with ledger, period, source fetch time and offline/refresh status. The rupee sign is embedded using Noto Sans. Very wide tables or names outside the font's character coverage show an actionable error; **Print / Save PDF** preserves the browser's font fallback and the native report layout.
- **Download Excel** creates a real `.xlsx` workbook: report information, the complete report, and an original-display sheet when amounts are converted. Plain numbers under explicit Debit/Credit/Amount/Balance headings become numeric cells. Dates, invoice IDs, leading zeroes and Dr/Cr-labelled balances remain text. No totals or balances are recalculated, and formula-looking text remains literal text.
- **Save HTML** and **Print / Save PDF** also include the source fetch time. A changed ledger/date selection disables exports until its report is fetched/opened. Signing out during generation prevents a subsequent download.

All conversion is local to the browser using vendored assets; no financial data is sent to a conversion service. Saved cloud reports can be exported while the office PC is offline, provided the browser has Internet access to Supabase and the public export assets. A downloaded file is a dated snapshot, never a live balance.

## Upgrading from 1.0.0

Re-run `supabase/tally-bridge.sql` in the dedicated Tally project to apply the additional server-side guards. Download the 1.0.1 installer, create a fresh pairing package, and use **Install & pair** on the same Windows account. The installer stops the old worker before pairing and preserves the recovery journal. Do not delete the journal or reset queued jobs. The previous installer does not contain the new restore checks.

Normal cadence is a five-second worker loop for cloud jobs and voucher changes, one minute for masters, and one hour for complete identity/deletion reconciliation. These are polling targets, not instantaneous delivery guarantees: large initial reads, report generation, Internet latency and Tally's response time add delay. Reports refresh on request. The web screen polls status every ten seconds while visible.

## Offline periods and recovery

- **Windows/Tally offline:** Supabase keeps the transactional voucher queue and report requests. Saved cloud reports remain readable with their fetch timestamps. Current figures are never claimed when only an older report is available.
- **Internet offline while Windows/Tally run:** SQLite stores object changes and pending uploads with WAL and full synchronous commits. Upload acknowledgement is required before deleting a local queue item. The next connection resumes that journal.
- **Browser closed:** vouchers already saved to Supabase are queued by a database trigger; the browser is not the queue runner. Unsaved form edits are not guaranteed offline. Browser sign-in and fetching cloud data still require Internet access.
- **Posting response lost:** cloud state changes to `writing` before the Tally request. A restarted/expired job only reconciles by identity and values. It cannot blindly repeat a Create or Alter. A voucher becomes confirmed only after a matching Tally read-back.
- **Conflicting edits:** a queued web edit carries the expected Tally AlterID. A newer Tally edit, duplicate number, changed GUID or unsupported allocation blocks the write. In Sync activity, use **Use Tally version** to discard the pending web edit after a fresh read. **Try sync again** is available only when no write was started. **Recheck Tally** checks an uncertain posting without writing; correct/create that invoice in Tally first if required.
- **Deleted/cancelled vouchers:** periodic complete scans mark records as deleted/cancelled. They retain their last recorded values for reference, are labelled, and cannot be billed/edited as active records. The bridge never deletes Tally records in response to web history cleanup. Auto-clear and deletion of bridge-tracked history are blocked.
- **Renumbering in Tally:** supported invoices follow Tally's new number/type. If that number already belongs to another saved web invoice, both histories are kept and the affected fuel-editor record becomes read-only. Review the current Tally version in the data explorer/reports and resolve the duplicate numbering in Tally before continuing.
- **Restore or financial-year split:** a changed company GUID or decreasing object AlterID pauses sync. Do not erase the journal to bypass this. Review the backup/restore with the accountant, preserve queued jobs, and reconcile company identity and invoice numbering before re-pairing. A restored cloud database can be bootstrapped by re-pairing the same company; unchanged local objects are republished too.
- **Restart and inconsistent reads:** every worker restart performs a complete identity reconciliation before claiming work. Outgoing voucher lookups also check the full voucher identity snapshot against the journal. Details older than the advertised metadata, reused MasterIDs or a lower/disappearing highest revision block progress. Deleting the highest-version object can also trigger this conservative stop; it needs administrator review, not an automatic checkpoint reset.
- **Manual XML:** the web app checks current bridge status before permitting manual XML export. If that check fails, export is blocked. This prevents a stale browser status from allowing manual export alongside automatic posting.

Tally's XML interface has no distributed transaction or documented compare-and-swap operation across Supabase and Tally. The bridge checks versions immediately before an alteration and reads the result back, but cannot lock a voucher being edited simultaneously in the Tally UI. Avoid editing the same invoice in both places at the same time. If a write outcome cannot be proven, the bridge leaves it for review instead of promising exactly-once delivery.

## Security and operation

- Pairing codes and device credentials are stored as SHA-256 hashes in cloud tables with RLS and no direct client grants. The PC generates its credential and encrypts it with Windows DPAPI for the signed-in user. Neither pairing packages nor financial report content are stored in browser localStorage.
- The existing app's signed-in employees retain their shared access rights. Any of those employees can pair, pause or revoke the one bridge. This is **not** a new owner-only role system.
- Device RPCs expose only this company's queue, snapshots and report results; ordinary anonymous reads/writes are denied. The service-role key is never needed. All cloud traffic uses HTTPS with normal certificate validation.
- Native report HTML is allowlisted on the worker, allowlisted again in the browser and displayed in a sandboxed iframe with a restrictive CSP. Scripts, remote images, links, forms and arbitrary styles do not survive. The service worker caches only public app-shell files, never authenticated financial/API responses.
- Installation: `%LOCALAPPDATA%\Programs\VriddhiTallyBridge\1.0.1\VriddhiTallyBridge.exe`. Recovery data: `%LOCALAPPDATA%\VriddhiTallyBridge\journal.sqlite3`; encrypted configuration: `credential.dat`. The journal contains business data, so protect the Windows account and disk like Tally's own data. Back up the whole journal directory, including any SQLite WAL file, while the bridge is stopped.
- Open the desktop shortcut for Status, Start and Stop. Uninstall through Windows Installed apps. Uninstall stops startup registration and removes program files; it retains the journal and encrypted credential for recovery. Select **Disconnect PC** in the web app to revoke access. Do not publish or email the journal/credential.
- No app-owned subscription fee is added. Tally licensing and Supabase storage/egress limits still apply. Historical full XML and durable job records consume storage; retention/archiving should preserve accounting audit history.

## Build and verify

The `Tally bridge — tests and Windows installer` GitHub Actions workflow runs PostgreSQL permission/outbox tests, fake-Tally recovery tests, XML parity tests against the existing exporter, and desktop/mobile browser tests. It then builds on Windows, tests Windows DPAPI, the frozen executable, startup registration and the single-process guard, and uploads `Vriddhi-Tally-Bridge-Windows` with the executable, setup guide, commit id and SHA-256.

```bash
python -m pip install -r tally_bridge/requirements.txt pytest playwright PyMuPDF==1.28.2
python -m playwright install chromium
# PostgreSQL server/client binaries and Node must also be installed.
python -m pytest tests/test_tally_bridge.py tests/test_tally_bridge_schema.py tests/test_tally_bridge_browser.py -q
python -m tally_bridge.cli --self-test
```

Windows package command:

```powershell
python -m pip install pyinstaller==6.16.0
python -m PyInstaller --noconfirm --clean --onefile --windowed --paths . --name VriddhiTallyBridge tally_bridge/entry.py
```

See [DESIGN.md](DESIGN.md) for the sync contract and [RESEARCH.md](RESEARCH.md) for BizAnalyst feature research and source limitations.
