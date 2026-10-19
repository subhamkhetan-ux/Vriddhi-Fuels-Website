Connect one Vriddhi Fuels Tally Prime company to the web app, with a durable sync queue, offline recovery, native reports and searchable Tally records.

Version **1.0.1** adds direct ledger PDF/Excel downloads, searchable ledger selection, source timestamps in exports and safeguards against exporting the wrong selection or downloading after sign-out. It also checks restored/inconsistent Tally snapshots on restart and before posting, and blocks web edits while a Tally version is still being fetched.

**Upgrade:** re-run `supabase/tally-bridge.sql` in the Tally project, then install and pair this version using the same Windows account. Preserve the existing recovery journal. The installer stops the previous worker before pairing.

- **Windows 10/11, 64 bit.** Download `VriddhiTallyBridge.exe`; Python is bundled. It installs for the signed-in Windows user and starts after sign-in.
- **One-time database setup:** apply [tally-bridge.sql](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/supabase/tally-bridge.sql) in the dedicated **Tally** Supabase project, `qlloauxmfenrrqvfqibp`. Publishing the website does not apply this migration.
- **Pair the PC:** enable Tally Prime's local XML server, then open **Tally connection & reports → Connect PC** in the web app and paste its pairing package into the installer.
- **Coverage:** HSD/MS/XG credit vouchers and supported edits from the web app; all voucher types and ten accounting-master/transaction collections from Tally; nine native report selections. Complex vouchers remain read-only in the web app.
- **Recovery:** cloud queue plus a local SQLite journal, read-back before confirming a write, conflict review, and no blind retry of an uncertain posting. Normal voucher polling targets five seconds while Tally and the PC are online.

This preview passes automated recovery, database-permission, browser and Windows package/DPAPI/installation checks. **It has not been tested against your licensed Tally Prime installation.** Follow the [setup and first-invoice verification guide](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/tally_bridge/README.md) before relying on live sync.

The executable is not code-signed. `SHA256SUMS.txt` contains its checksum and `BUILD.txt` identifies the source commit. Check the download in PowerShell with:

```powershell
Get-FileHash .\VriddhiTallyBridge.exe -Algorithm SHA256
```

Keep Tally open and the Windows user signed in. If the PC is offline, queued vouchers remain saved and previously fetched reports display their last refresh time. The bridge cannot make a powered-off PC available.
