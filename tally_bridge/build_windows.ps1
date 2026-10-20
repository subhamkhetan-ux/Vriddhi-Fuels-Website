# Transparent distribution: unmodified Python binaries + readable bridge source.
$ErrorActionPreference = 'Stop'
$bundle = Join-Path $PWD 'bridge-package/VriddhiTallyBridge'
New-Item -ItemType Directory -Force bridge-dist | Out-Null
python -m tally_bridge.packaging $bundle
if ($LASTEXITCODE -ne 0) { throw 'Package assembly failed' }

$signatures = @()
$core = @('python.exe', 'pythonw.exe', 'python3.dll')
$core += (Get-ChildItem "$bundle/runtime/python3[0-9]*.dll" | Select-Object -ExpandProperty Name)
foreach ($name in ($core | Select-Object -Unique)) {
    $signature = Get-AuthenticodeSignature (Join-Path "$bundle/runtime" $name)
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
        throw "CPython publisher signature was not valid for $name"
    }
    $signatures += @{file=$name; status='Valid'; publisher=$signature.SignerCertificate.Subject; thumbprint=$signature.SignerCertificate.Thumbprint}
}

# Real installed-runtime test, including Tk, DPAPI, native process discovery and scheduled task registration.
& "$bundle/runtime/python.exe" -I -B "$bundle/bridge.pyw" --self-test --install-smoke-test *> bridge-self-test.log
if ($LASTEXITCODE -ne 0) {
    $detail = (Get-Content bridge-self-test.log -Tail 35) -join "`n"
    $detail = $detail.Replace('%','%25').Replace("`r",'%0D').Replace("`n",'%0A')
    Write-Host "::error::$detail"
    throw 'Installed package smoke test failed'
}

$defender = @{status='unavailable'; detail='Defender scan engine was unavailable on this CI runner.'}
try {
    $status = Get-MpComputerStatus -ErrorAction Stop
    if ($status.AMServiceEnabled -and $status.AntivirusEnabled) {
        # Updating definitions does not alter security settings. Do not add exclusions or disable monitoring.
        try { Update-MpSignature -ErrorAction Stop } catch { Write-Host 'Signature update unavailable; checking current definitions.' }
        $status = Get-MpComputerStatus
        if ($status.AntivirusSignatureAge -gt 7) { throw 'Defender definitions are older than seven days' }
        $scanner = Get-ChildItem "$env:ProgramData/Microsoft/Windows Defender/Platform/*/MpCmdRun.exe" | Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $scanner) { $scanner = Get-Item "$env:ProgramFiles/Windows Defender/MpCmdRun.exe" }
        $scan = Start-Process -FilePath $scanner.FullName -ArgumentList @('-Scan','-ScanType','3','-File',('"' + $bundle + '"'),'-DisableRemediation','-ReturnHR') -Wait -PassThru -NoNewWindow
        if ($scan.ExitCode -ne 0) { throw "Defender custom scan did not pass, exit $($scan.ExitCode)" }
        $defender = @{status='clean'; engine=$status.AMEngineVersion; signatures=$status.AntivirusSignatureVersion; scannedUtc=[DateTime]::UtcNow.ToString('o'); detail='Windows Defender custom scan completed with exit code zero.'}
    }
} catch {
    # An available engine reporting a scan failure is a release blocker, never a clean result.
    if ($status -and $status.AMServiceEnabled -and $status.AntivirusEnabled) { throw }
    Write-Host 'Defender is unavailable on this runner; no malware-clearance claim will be made.'
}
$security = @{sourceCommit=$env:GITHUB_SHA; runtimeAuthenticode=$signatures; defender=$defender; note='CPython publisher signatures cover its core runtime binaries. Bridge source and launch scripts are not Authenticode signed. Keep Windows Security enabled.'}
$security | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 bridge-dist/SECURITY.json

Compress-Archive -Path $bundle -DestinationPath bridge-dist/VriddhiTallyBridge-Windows.zip -CompressionLevel Optimal
$hash = (Get-FileHash bridge-dist/VriddhiTallyBridge-Windows.zip -Algorithm SHA256).Hash.ToLower()
"$hash  VriddhiTallyBridge-Windows.zip" | Out-File -Encoding ascii bridge-dist/SHA256SUMS.txt
Copy-Item tally_bridge/README.md bridge-dist/SETUP.md
"Built from $env:GITHUB_SHA" | Out-File -Encoding ascii bridge-dist/BUILD.txt
