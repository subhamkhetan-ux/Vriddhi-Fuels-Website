# Vriddhi Fuels — Tally Prime bridge

The bridge connects **one Vriddhi Fuels company** on a Windows PC to the existing [Tally web app](https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/tally/). It uses the app's dedicated Supabase project, `qlloauxmfenrrqvfqibp`, and Tally's local XML interface. There is no inbound Internet connection to the PC and no Supabase service-role key in the installer.

## Install and activate

1. **Database, once:** open the **Tally project's** Supabase SQL editor. Existing installations already have `supabase/tally-schema.sql`; run [supabase/tally-bridge.sql](../supabase/tally-bridge.sql). For a new installation run `tally-schema.sql` first, then `tally-bridge.sql`. Both can be rerun. Do not run these in the Payments, Ledger or Fleet project's database. This repository does not contain a database administrator credential, so publishing the website does **not** apply this migration automatically.
2. **Tally Prime:** back up the company, open it on the Windows PC, and enable its HTTP/XML server on port **9000** (or another local port). In Tally Prime's advanced connectivity settings, enable the server/HTTP interface; the exact menu label varies by Prime release. The XML interface, not merely an ODBC client connection, must respond. Keep port 9000 private; do not port-forward it or open it to the Internet. The bridge connects to `127.0.0.1` only.
3. In the web app's **Settings**, confirm the exact company name shown in Tally. The current default is `VRIDDHI FUELS (2026-27)`. If automatic financial-year naming is enabled, pairing resolves the current Indian financial year. Each queued voucher also records its date's company name; a voucher for another year cannot post into the currently paired company. The installer verifies the name and Tally's company GUID. A different financial-year company is intentionally rejected after pairing.
4. Download `VriddhiTallyBridge-Windows.zip`, `SHA256SUMS.txt` and `SECURITY.json` from the [Windows release](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/releases/tag/tally-bridge-v1.3.0). Use **Extract all** first, then open **Setup.cmd** in the extracted folder. The package contains readable bridge source and an unmodified CPython runtime; no separate Python install or administrator account is needed. CI verifies the Python Software Foundation's Authenticode signatures on the core runtime binaries. The bridge scripts/ZIP are not Authenticode signed. Verify the ZIP with:

   ```powershell
   Get-FileHash .\VriddhiTallyBridge-Windows.zip -Algorithm SHA256
   ```

5. Click **Test Tally**. Enable **Start Tally minimized and reopen it if employees close it**, confirm the installed `Tally.exe` path and the numeric **company folder number** (for example `10000`). Test tries to discover both; when the number is unavailable, copy it once from Tally's company-selection/data-folder listing. It is not the company name or GUID. The bridge uses Tally's documented `/NOINILOAD /LOAD:<number>` startup arguments, without editing `Tally.ini`. In the web app open **Tally connection & reports → Connect PC → Create pairing package**, paste the package in Setup, then choose **Install & pair**. Packages expire after ten minutes and can be used once. A replacement PC revokes the previous PC's credential. If this same Windows account already paired 1.0.1, use **Upgrade / save settings** instead; it retains the credential and recovery journal.

6. Wait for **Connected to Tally Prime** in the web app. The first read records every fuel voucher's identity in one request and links the app's existing vouchers by type and number; details of the rest are then read in the background, newest week first (Status shows the progress). New vouchers and supported edits post to Tally automatically once the first read finishes.
7. Verify the first test sales invoice and a day-book report against Tally Prime on this PC. Check voucher type/number, date, party, quantity, rate, round-off, GST classification, vehicle UDF and totals. This is the necessary live acceptance check: automated tests use synthetic Tally responses, not your licensed Tally installation.

The bridge runs in the background after this Windows user signs in. Closing Setup does not stop it. The screen can lock. A scheduled task runs with this user's interactive token, least privilege, no network requirement and no execution-time limit; it restarts a failed supervisor and checks for a stopped supervisor every five minutes. Sign-in registry startup provides a fallback if Windows policy prevents task registration; Setup explicitly reports that fallback. The supervisor restarts an unexpectedly exited worker. **Stop** is persistent until **Start** is selected, including across sign-in/task retries.

## Bridge on or off

The bridge is optional. **Tally connection & reports → Sync vouchers with Tally** switches it, and the choice is shared by everyone using the app.

- **Off:** the app works exactly as before the bridge: the day's **Download XML**, **Move day**, **Import from Tally** (which then updates every voucher, linked ones too), free edits and deletes. The Windows PC does not read or start Tally; it only answers report requests. Vouchers that were still waiting to post go back into the day's XML. Nothing already in Tally changes.
- **On:** new and edited vouchers post to Tally by themselves, and vouchers made or changed in Tally appear in the app. Vouchers saved while it was off are not posted again: the bridge links the ones it finds in Tally by type and number. Import the XML of any not yet in Tally first, or queue them from Sync activity.
- **Disconnect PC** also switches the bridge off. Switching on needs a paired PC.

## Automatic Tally recovery

- **Employees close Tally:** with automatic recovery enabled, the bridge reopens the selected installation minimized with the configured company number. Normal online polling targets five seconds; Tally's loading time, connection timeouts and backoff add delay. Repeated failed starts are throttled from 30 seconds up to 15 minutes, persisted across bridge restarts.
- **Tally is already running:** it is left alone. A busy/unresponsive XML server, another Tally installation, a company-selection prompt, a password/licence prompt or a repair dialog does not authorize killing it or opening competing instances. Setup/connection status explains the wait. This can still require attention; no automatic click-through, password storage or licence bypass is included.
- **Company check:** the same exact name and paired company GUID are verified before work. A wrong startup number cannot post into another company's books. After an automatic restart, complete identity reconciliation runs before any cloud job is claimed; existing restore/conflict/write-recovery guards remain in force.
- **Keep awake:** the optional Setup checkbox makes a Windows system-awake request only while the worker runs. The display may turn off and lock; global Windows power settings are not rewritten. Manual sleep, shutdown and Windows sign-out still pause sync. This is an interactive-user installation, not a service running before Windows sign-in.
- **Intentional maintenance:** choose **Stop** in Setup before closing Tally for backup/repair or intentionally keeping it closed. Stop never force-terminates Tally. Choose **Start** when ready. An uncertain posting is reconciled rather than blindly retried after a restart.

## Windows Security / Defender

A Defender block was reported against the old 1.0.1 self-extracting executable. The downloaded release file matched GitHub's published asset digest, which establishes artifact identity, not malware clearance. Version 1.0.2 replaces that packaging with a readable ZIP, per-file integrity manifest and unmodified signed CPython core binaries. There is no self-extracting application executable, encoded PowerShell cleanup script, Defender exclusion or change to antivirus settings.

`SECURITY.json` records the core runtime publisher signatures and the CI Defender scan result. `clean` means that runner's custom scan completed successfully with the recorded definitions; `unavailable` means no Defender clearance was obtained there. Neither result guarantees that every endpoint policy or future signature accepts the package. If Defender flags any file, **keep it quarantined**, record the exact threat name/path and submit the public package to [Microsoft's file-submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) for review. Do not disable Defender or add an exclusion to force installation. SmartScreen's unknown-publisher notice is different from a malware detection.

## What syncs

| Direction | Coverage |
|---|---|
| Web → Tally | The web app's HSD CREDIT, MS CREDIT and XG CREDIT sales vouchers; new invoices and supported edits; existing vehicle UDF, party GST classification and round-off are retained. Before posting, the party, sales ledger, `R/off`, stock item and voucher type are checked live in Tally, and a missing one is named in Sync activity. |
| Tally → web | Every HSD/MS/XG CREDIT voucher in the paired company. One made in Tally Prime appears in the app within seconds (history, bills, fuel slips, the customer's last price); an alteration, cancellation or deletion is applied to the app's copy (Tally is the source of truth). After pairing, the voucher list is read in one request and details follow in the background from Tally's Day Book export, one week per step, newest first. A web voucher waiting to post, or flagged for review, whose Tally copy already matches is confirmed instead of posted again. |
| Import from Tally | Unchanged and available while paired: DayBook files add and refresh vouchers, Master files add customers with GST details. Vouchers the bridge already links (or is posting) are kept as the bridge has them and counted as *kept*; nothing an import brings in is posted back to Tally. An imported voucher the bridge has already seen is linked at once, with Tally's exact round-off. |
| Reports | Native Tally day book, ledger statement, trial balance, balance sheet, profit & loss, receivables, payables, stock summary and cash/bank summary. Report availability/names depend on the Tally release and company features. Unsupported reports show an error and retain any previous saved result. |

Ledgers, groups, stock items and other masters are not mirrored. A fuel voucher in Tally with extra inventory lines or tax ledgers is labelled *Changed in Tally* and kept read-only in the app; bill-wise references (New Ref) are fine to read, but such a voucher can only be altered in Tally Prime.

The existing web app remains a fuel voucher editor. It does not become an editor for every Tally voucher/master type. Create missing parties, stock items, voucher types and allocation rules in Tally Prime first; the bridge does not invent those accounting masters. Reports are fetched from Tally's own reporting engine rather than reconstructed from incomplete totals. No automatic messaging, payment execution or GST filing is included.

## Ledger PDF and Excel downloads

In **Tally connection & reports → Reports**, select **Ledger statement**, type the ledger name (customers are suggested from the app's party list), choose dates and select **Fetch from Tally** (or **Open saved report**).

- **Download PDF** creates a paginated file in the browser, with ledger, period, source fetch time and offline/refresh status. The rupee sign is embedded using Noto Sans. Very wide tables or names outside the font's character coverage show an actionable error; **Print / Save PDF** preserves the browser's font fallback and the native report layout.
- **Download Excel** creates a real `.xlsx` workbook: report information, the complete report, and an original-display sheet when amounts are converted. Plain numbers under explicit Debit/Credit/Amount/Balance headings become numeric cells. Dates, invoice IDs, leading zeroes and Dr/Cr-labelled balances remain text. No totals or balances are recalculated, and formula-looking text remains literal text.
- **Save HTML** and **Print / Save PDF** also include the source fetch time. A changed ledger/date selection disables exports until its report is fetched/opened. Signing out during generation prevents a subsequent download.

All conversion is local to the browser using vendored assets; no financial data is sent to a conversion service. Saved cloud reports can be exported while the office PC is offline, provided the browser has Internet access to Supabase and the public export assets. A downloaded file is a dated snapshot, never a live balance.

## Upgrading

**Upgrading to 1.1.x from 1.0.x:** first re-run [supabase/tally-bridge.sql](../supabase/tally-bridge.sql) in the Tally project's SQL editor (it re-enables Import from Tally and changes what the cloud keeps). Then extract the 1.1.x ZIP, open Setup.cmd on the **same Windows account**, click Test Tally (it now also reports how many fuel vouchers it can read) and choose **Upgrade / save settings**. No re-pairing is needed. The worker discards the 1.0.x snapshot cursors and re-reads the fuel voucher list once (one Tally request; details are read only for vouchers later altered); in-flight posting records are kept. The encrypted credential and journal stay in their original data directory.

Normal cadence: the cloud queue every 5 seconds; Tally every 10 seconds, with one small question (the company's voucher alteration counter, `$AltVchId`). The voucher list is read only when that counter changes, and in full every two hours to catch deletions. Vouchers the app does not have yet are read one day of Day Book per minute. Masters and GST details used for posting are cached for half an hour. These are polling targets, not instantaneous delivery guarantees. Reports refresh on request. The web screen polls status every ten seconds while it is open.

## Offline periods and recovery

- **Windows/Tally offline:** Supabase keeps the transactional voucher queue and report requests. Saved cloud reports remain readable with their fetch timestamps. Current figures are never claimed when only an older report is available.
- **Internet offline while Windows/Tally run:** SQLite stores object changes and pending uploads with WAL and full synchronous commits. Upload acknowledgement is required before deleting a local queue item. The next connection resumes that journal.
- **Browser closed:** vouchers already saved to Supabase are queued by a database trigger; the browser is not the queue runner. Unsaved form edits are not guaranteed offline. Browser sign-in and fetching cloud data still require Internet access.
- **Posting response lost:** cloud state changes to `writing` before the Tally request. A restarted/expired job only reconciles by identity and values. It cannot blindly repeat a Create or Alter. A voucher becomes confirmed only after a matching Tally read-back.
- **Conflicting edits:** a queued web edit carries the expected Tally AlterID. A newer Tally edit, duplicate number, changed GUID or unsupported allocation blocks the write. In Sync activity, use **Use Tally version** to discard the pending web edit after a fresh read. **Try sync again** is available only when no write was started. **Recheck Tally** checks an uncertain posting without writing; correct/create that invoice in Tally first if required.
- **Deleted/cancelled vouchers:** periodic complete scans mark records as deleted/cancelled. They retain their last recorded values for reference, are labelled, and cannot be billed/edited as active records. The bridge never deletes Tally records in response to web history cleanup. Auto-clear and deletion of bridge-tracked history are blocked.
- **Renumbering in Tally:** supported invoices follow Tally's new number/type. If that number already belongs to another saved web invoice, both histories are kept and the affected fuel-editor record becomes read-only. Review the current Tally version in the data explorer/reports and resolve the duplicate numbering in Tally before continuing.
- **Restore or financial-year split:** a changed company GUID or decreasing object AlterID pauses sync. Do not erase the journal to bypass this. Review the backup/restore with the accountant, preserve queued jobs, and reconcile company identity and invoice numbering before re-pairing. A restored cloud database can be bootstrapped by re-pairing the same company; unchanged local objects are republished too.
- **Restart and inconsistent reads:** every worker restart performs a complete identity reconciliation of the fuel vouchers before claiming work. Details older than the advertised metadata, reused MasterIDs or a voucher whose AlterID went backwards (a restored backup) block progress. Deleting or retyping the most recently edited voucher is ordinary work and does not pause sync. Outgoing voucher lookups read only the invoice being posted.
- **Manual XML:** the web app checks current bridge status before permitting manual XML export. If that check fails, export is blocked. This prevents a stale browser status from allowing manual export alongside automatic posting.

Tally's XML interface has no distributed transaction or documented compare-and-swap operation across Supabase and Tally. The bridge checks versions immediately before an alteration and reads the result back, but cannot lock a voucher being edited simultaneously in the Tally UI. Avoid editing the same invoice in both places at the same time. If a write outcome cannot be proven, the bridge leaves it for review instead of promising exactly-once delivery.

## Troubleshooting

- **A voucher made in Tally does not appear, or a posted one says Needs review (1.1.x):** 1.1.x read voucher details with a collection export, which leaves out Tally's ledger and inventory lines. 1.2.0 reads details from the Day Book export instead, re-reads every fuel voucher once, adds the missing ones and confirms reviewed vouchers whose Tally copy matches.
- **Setup still shows an old message after downloading a new version:** opening the new Setup does not replace the background worker Windows already starts. Click **Upgrade / save settings**. From 1.1.1, Setup says which bridge version is installed and which version wrote each status line, and whether background sync is running at all.
- **Setup's Status shows the exact problem.** It names the voucher, master or cloud message involved, and the time it was recorded. The same text appears in the web app under Tally connection.
- **"Tally did not supply GUID, MasterID and AlterID; sync is paused" (1.0.x):** 1.0.x read every master type (groups, units, godowns, currencies…) and every voucher type, and paused at the first record without these identifiers, before reaching any fuel voucher. 1.1.0 reads only HSD/MS/XG CREDIT vouchers. If 1.1.0 reports this for a specific voucher, open and save that voucher once in Tally Prime.
- **"Not posted: create … in Tally Prime first":** the named party, ledger, stock item or voucher type does not exist in the open company. Create it (names are matched without regard to capitals), then choose **Try sync again**.
- **"The web app refused the bridge: …":** the cloud database rejected the request, for example a revoked PC or an un-applied SQL update. Re-run `tally-bridge.sql` or re-pair as the message says.

## Security and operation

- Pairing codes and device credentials are stored as SHA-256 hashes in cloud tables with RLS and no direct client grants. The PC generates its credential and encrypts it with Windows DPAPI for the signed-in user. Neither pairing packages nor financial report content are stored in browser localStorage.
- The existing app's signed-in employees retain their shared access rights. Any of those employees can pair, pause or revoke the one bridge. This is **not** a new owner-only role system.
- Device RPCs expose only this company's queue, snapshots and report results; ordinary anonymous reads/writes are denied. The service-role key is never needed. All cloud traffic uses HTTPS with normal certificate validation.
- Native report HTML is allowlisted on the worker, allowlisted again in the browser and displayed in a sandboxed iframe with a restrictive CSP. Scripts, remote images, links, forms and arbitrary styles do not survive. The service worker caches only public app-shell files, never authenticated financial/API responses.
- Installation: `%LOCALAPPDATA%\Programs\VriddhiTallyBridge\1.3.0\`, with `runtime\pythonw.exe` launching the readable `bridge.pyw`. Recovery data: `%LOCALAPPDATA%\VriddhiTallyBridge\journal.sqlite3`; encrypted configuration: `credential.dat`. The journal contains business data, so protect the Windows account and disk like Tally's own data. Back up the whole journal directory, including any SQLite WAL file, while the bridge is stopped.
- Open the desktop shortcut for Status, Start and Stop. Uninstall through Windows Installed apps. Uninstall stops the bridge and removes task/registry/shortcut registration. After closing Setup you can delete its program folder; no delayed deletion script is run. The journal and encrypted credential are retained for recovery. Select **Disconnect PC** in the web app to revoke access. Do not publish or email the journal/credential.
- No app-owned subscription fee is added. Tally licensing and Supabase storage/egress limits still apply. Historical full XML and durable job records consume storage; retention/archiving should preserve accounting audit history.

## Build and verify

The `Tally bridge — tests and Windows installer` workflow runs PostgreSQL permission/outbox tests, synthetic Tally recovery tests, XML parity tests and desktop/mobile browser tests. On Windows it builds a ZIP from a supported CPython release, checks the core runtime's Python Software Foundation Authenticode signatures, and tests the actual packaged runtime, Tk, DPAPI, cross-session mutex, native process discovery, keep-awake request and installed startup task. It attempts a Defender custom scan, records its actual result in `SECURITY.json`, and uploads the ZIP, setup guide, source commit and SHA-256. No claims about your licensed Tally installation or your endpoint's Defender verdict are implied by CI.

```bash
python -m pip install -r tally_bridge/requirements.txt pytest playwright PyMuPDF==1.28.2
python -m playwright install chromium
# PostgreSQL server/client binaries and Node must also be installed.
python -m pytest tests/test_tally_bridge.py tests/test_tally_bridge_schema.py tests/test_tally_bridge_browser.py -q
python -m tally_bridge.cli --self-test
```

Build on Windows with the regular supported CPython installation (including Tcl/Tk):

```powershell
python -m pip install -r tally_bridge/requirements.txt
.\tally_bridge\build_windows.ps1
```

See [DESIGN.md](DESIGN.md) for the sync contract and [RESEARCH.md](RESEARCH.md) for BizAnalyst feature research and source limitations.
