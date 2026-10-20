Version **1.0.2** adds background Tally recovery and replaces the old self-extracting installer with a readable Windows ZIP.

- **Download `VriddhiTallyBridge-Windows.zip`, Extract all, then open `Setup.cmd`.** Python is bundled; its unmodified core runtime binaries are verified as signed by the Python Software Foundation in CI. The bridge source/scripts and ZIP are not Authenticode signed. `SECURITY.json` records signature and Defender scan results; a scan marked `unavailable` is not malware clearance. Keep Windows Security enabled. If a file is flagged, keep it quarantined and report the exact threat; do not add an exclusion or restore the old executable.
- **Background operation:** starts after Windows sign-in; closing Setup is fine. A per-user scheduled task and worker supervisor provide restart recovery. Windows can remain locked; sign-out, manual sleep and shutdown pause sync. No Windows password or Tally login password is stored.
- **Automatic Tally recovery:** in Setup enable **Start Tally minimized and reopen it if employees close it**, then confirm the installed executable and numeric company folder number. Test Tally tries to discover them; copy the number once from Tally's company-selection/data-folder listing if needed. The bridge uses documented `/NOINILOAD /LOAD:<number>` arguments. It never kills a running Tally process or opens a competing instance. A licence/login/repair prompt may still need attention.
- **Upgrade an existing 1.0.1 pairing:** use **Upgrade / save settings** on the same Windows account. The previous worker is stopped gracefully; the encrypted device credential and recovery journal are retained. No new SQL migration is needed for an already working 1.0.1 bridge.
- **Fresh setup:** enable Tally's local XML server, apply [tally-bridge.sql](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/supabase/tally-bridge.sql) in the dedicated **Tally** Supabase project `qlloauxmfenrrqvfqibp`, then create a pairing package from **Tally connection & reports → Connect PC**. Publishing the website does not apply SQL.
- **Data safety:** restart throttling persists locally; the exact company GUID is verified; full identity reconciliation precedes work after automatic Tally recovery. The existing durable journal, read-back confirmation, uncertain-write recovery and conflict/restore guards remain in force. Stop in Setup pauses both sync and automatic Tally launches until Start.

This is a **Windows preview**. Automated recovery/database/browser/native Windows checks do not replace acceptance against your licensed Tally Prime installation. Follow the [setup and first-invoice verification guide](https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/tally_bridge/README.md), including comparing a test invoice and day-book report.

`SHA256SUMS.txt` checks the ZIP, and `BUILD.txt` identifies the source commit:

```powershell
Get-FileHash .\VriddhiTallyBridge-Windows.zip -Algorithm SHA256
```

A checksum establishes that the download matches the published artifact; it is not an antivirus verdict. The 1.0.1 executable's reported Defender block has not been attributed to a particular detection without the exact threat details. This release does not disable, reconfigure or bypass Defender.
