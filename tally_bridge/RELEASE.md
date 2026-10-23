Version **1.5.0** brings Tally edits back reliably and updates itself:

- **Edits made in Tally show up in the app.** The bridge now reads any round-off ledger spelling (R/off, Round Off, Rounding Off…), names in any capitalisation, a blank rate, and vouchers saved in Accounting Voucher View. A voucher it still cannot hold is labelled with the reason (for example *Extra ledger in Tally: Freight*) and listed under Sync activity → **Changed in Tally**, with **Read again from Tally**. Vouchers older bridges marked *Changed in Tally* are read again.
- **No false "Needs review" after posting.** When Tally lists a just-posted invoice a moment before its Day Book returns it, the bridge checks again by itself instead of asking for review. For a posting that did end up in review, **Use Tally version** now takes the invoice Tally holds under that number.
- **Every edge between the app and Tally handled** (see README → *What happens when…*):
  - Vouchers deleted, re-dated or moved to another voucher type in Tally are caught. They used to stay in the app unchanged.
  - Alterations to fuel vouchers dated up to five weeks back arrive within half an hour.
  - A voucher posting is retried by itself in three cases:
    - Tally refuses it. The bridge first checks nothing was posted, then shows Tally's reason.
    - A ledger is missing. It posts once the ledger is created.
    - The company was closed at that moment.
  - Uncertain postings are rechecked by themselves.
  - Web edits to Tally vouchers with a bill-wise New Ref work.
  - A web voucher never posted can be deleted.
  - After *Assign next invoice number*, Tally's invoice with the old number joins the app.
  - The same number twice in Tally is reported.
  - One voucher the web app cannot apply no longer stops the rest.
- **Update button.** The app checks for a newer version each time it opens (Settings → Check for updates), and **Update now** downloads it, verifies its checksum and switches the bridge over — no ZIP, no re-pairing, Tally need not be open.
- **Re-run tally-bridge.sql** (adds the reason column and re-reads vouchers marked *Changed in Tally*). Then extract this ZIP once, open the app and choose **Update now**; later versions install from the app itself.

Version **1.4.2** brings Tally's report layout to the web app:

- **Reports keep Tally's formatting.** 1.4.1 sent reports with every alignment, bold and rule removed, so amounts sat on the left and totals looked like any other row. The bridge now keeps Tally's own alignment, bold/italic, indents, column widths and rules (also when Tally sets them through style classes); it still drops scripts, links, images, colours and anything else. The web app shows, prints and saves the reports in Tally Prime's print layout either way.
- No SQL change. Open the new app and choose **Update now**.

Version **1.4.1** fits the bridge around how the office already uses Tally:

- **Nothing changes for employees.** With **Open Tally by itself** off (now the default), the bridge never opens, hides, closes or brings Tally forward and never shows a prompt. It syncs whenever Tally is open with the company loaded, and waits quietly while Tally is closed or at Select Company: web vouchers stay queued and post when Tally is next opened.
- **The export script runs undisturbed.** While `VriddhiTally.ahk` (any AutoHotkey script with "Tally" in its name) is running, the bridge sends Tally nothing, then resumes by itself. The script needs no change.
- A posting interrupted by someone closing the company is retried later instead of being marked for review.
- For a PC where nobody opens Tally by hand, **Open Tally by itself** can keep Tally hidden in the background (Show/Hide Tally on Home; shown by itself if a prompt waits for two minutes), and bring a running Tally forward if a second copy is opened.
- **If you turned on "Open Tally by itself" earlier, untick it in Settings and choose Save settings** (with Tally open). No SQL change.

Version **1.4.0** replaces Setup with the **Vriddhi Tally Bridge** app, and makes the bridge come back after a Windows restart.

- **A proper app.** Extract the ZIP and open **Open Vriddhi Tally Bridge**. **Home** shows the bridge live (running or stopped, the Tally company, fuel vouchers watched, what happens after a restart) with Start/Stop and Open web app. **Connect** walks through three steps: Check Tally, paste the pairing code with one click, choose options. **Settings** and **Activity** (with Copy for support) hold the rest. The window never freezes while Tally is busy, and closing it does not stop the bridge.
- **Start menu and desktop shortcuts** with the Vriddhi Fuels icon replace the desktop `.cmd`; the app also appears in Installed apps with its icon. When a newer app finds an older bridge running, Home offers **Update now**.
- **Auto-revive** (on by default): the bridge starts again by itself after every restart once you sign in. Earlier versions kept a **Stop**, or an upgrade that did not finish, in force across restarts. Now a Stop lasts until the next restart while auto-revive is on; untick it to keep the bridge from starting with Windows. Turning it on also re-enables the bridge if Windows Startup apps had switched it off.
- No SQL change. Open the new app and choose **Update now**.

The ZIP still opens through a one-line launcher that starts the bundled, Python-Software-Foundation-signed runtime: an unsigned standalone `.exe` was blocked by Defender in 1.0.1, and a code-signing certificate would be needed to ship one safely.

Version **1.3.0** makes the bridge optional and much lighter on Tally:

- **Switch the bridge on or off** in the web app (Tally connection & reports → Sync vouchers with Tally). Off, the app works exactly as before the bridge (day's XML, Import from Tally, free edits) and the PC leaves Tally alone.
- **Tally stays responsive.** 1.2.0 scanned the whole voucher list every 5 seconds and read a week of Day Book at a time to catch up on older vouchers. Now the bridge watches only vouchers dated **today and yesterday**: an idle check is one small question every 10 seconds (the voucher alteration counter), and those two days are listed only when something changed. There is no deletion scan and no catch-up of older vouchers (use Import from Tally). Posting looks up an invoice from its own date. Masters and GST details are cached.
- **Import from Tally no longer times out.** Linking imported vouchers to the bridge's copies used an unindexed search through every stored Tally voucher; it is now indexed and limited to the file being imported, in chunks of 250.
- Re-run tally-bridge.sql, then **Upgrade / save settings** in the new Setup.

Version **1.2.0** brings every fuel voucher in Tally into the app:

- **Vouchers made in Tally Prime appear in the app** (history, tanker bills, fuel slips, the customer's last price). 1.1.x read voucher details with a collection export that leaves out Tally's ledger and inventory lines, so a voucher made in Tally could not be shown, and a posted voucher's read-back looked different and was marked *Needs review*. Details now come from Tally's Day Book export, the same format as a Day Book XML file.
- **Existing vouchers are read in the background, newest week first**, after the one-request first sync. Status shows the progress.
- **Needs review clears itself** when Tally's copy matches the app's voucher (party compared the way Tally does, ignoring capitals).
- Stored Tally XML drops the hundreds of empty fields Tally exports.
- Re-run tally-bridge.sql, then **Upgrade / save settings** in the new Setup.

Version **1.1.1** finishes the 1.1 sync fix:

- **Setup tells you when the old worker is still running.** Opening a new Setup never replaced the background worker; until **Upgrade / save settings** is clicked, Windows keeps starting the old one. Setup now shows the installed worker version, marks status lines written by an older bridge as out of date, and says when background sync is not running.
- **First sync is one Tally request.** Vouchers seen for the first time are recorded from their identifiers (4,982 vouchers no longer means ~170 full-detail reads before any status appears). Details are read only for vouchers later altered in Tally. Progress is written to Status while reading and uploading.
- Re-run tally-bridge.sql for this version too.

Version **1.1.0** makes the bridge a fuel-voucher sync and fixes the first sync that stopped with *"Tally did not supply GUID, MasterID and AlterID; sync is paused"*.

**Before upgrading, re-run [tally-bridge.sql](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/supabase/tally-bridge.sql)** in the dedicated **Tally** Supabase project `qlloauxmfenrrqvfqibp`. Publishing the website does not apply SQL.

- **What syncs now:** the app's HSD CREDIT, MS CREDIT and XG CREDIT vouchers post to Tally, and alterations, cancellations and deletions of those vouchers in Tally come back to the app. Masters and other voucher types are no longer mirrored; 1.0.x read them all and paused at the first record without Tally identifiers, before reaching any fuel voucher.
- **Import from Tally works again while paired.** DayBook and Master files import as before. Vouchers the bridge already tracks are kept as they are; nothing imported is posted back to Tally.
- **Real Tally exports are understood.** Tally's empty placeholder lists (`<BILLALLOCATIONS.LIST>  </BILLALLOCATIONS.LIST>`), bill-wise references and amount-mode quantities no longer make every voucher look unsupported, which previously turned every posting into a read-back conflict.
- **Clearer problems:** a missing party/ledger/stock item is named before posting; Tally's own rejection text and the cloud database's message are shown in Setup → Status and in the web app. Test Tally now reports how many fuel vouchers it can read.
- **Upgrade:** extract the ZIP, open `Setup.cmd` on the same Windows account, click **Test Tally**, then **Upgrade / save settings**. No re-pairing. The worker re-reads the fuel vouchers once; in-flight posting records are kept.

Download `VriddhiTallyBridge-Windows.zip`, Extract all, then open **Open Vriddhi Tally Bridge**. Python is bundled; its unmodified core runtime binaries are verified as signed by the Python Software Foundation in CI. The bridge source/scripts and ZIP are not Authenticode signed. `SECURITY.json` records signature and Defender scan results. Keep Windows Security enabled.

This is a **Windows preview**. Automated tests use synthetic Tally responses; verify the first posted invoice and a day-book report against your licensed Tally Prime, as described in the [setup guide](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/tally_bridge/README.md).

`SHA256SUMS.txt` checks the ZIP, and `BUILD.txt` identifies the source commit:

```powershell
Get-FileHash .\VriddhiTallyBridge-Windows.zip -Algorithm SHA256
```
