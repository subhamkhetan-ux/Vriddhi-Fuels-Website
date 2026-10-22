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

Download `VriddhiTallyBridge-Windows.zip`, Extract all, then open `Setup.cmd`. Python is bundled; its unmodified core runtime binaries are verified as signed by the Python Software Foundation in CI. The bridge source/scripts and ZIP are not Authenticode signed. `SECURITY.json` records signature and Defender scan results. Keep Windows Security enabled.

This is a **Windows preview**. Automated tests use synthetic Tally responses; verify the first posted invoice and a day-book report against your licensed Tally Prime, as described in the [setup guide](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/tally_bridge/README.md).

`SHA256SUMS.txt` checks the ZIP, and `BUILD.txt` identifies the source commit:

```powershell
Get-FileHash .\VriddhiTallyBridge-Windows.zip -Algorithm SHA256
```
