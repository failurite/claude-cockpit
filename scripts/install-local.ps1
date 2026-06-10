# Local update (Windows): rebuild Claude Cockpit and swap the installed app in
# place, then relaunch it. No GitHub, no signing — a locally-built app runs freely
# (SmartScreen only warns on downloaded, unsigned binaries, not locally-built ones).
#
# Run it from the repo (e.g. the "Cockpit Dev" session inside Cockpit):
#   npm run update-app
#
# Install location defaults to the Desktop; override with COCKPIT_APP_PATH.
$ErrorActionPreference = 'Stop'

# Repo root (this script lives in scripts/).
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

$Dest = if ($env:COCKPIT_APP_PATH) { $env:COCKPIT_APP_PATH } else { Join-Path $env:USERPROFILE 'Desktop\Claude Cockpit' }
# electron-builder's `--win dir` target unpacks here (single arch, x64).
$Built = Join-Path $Repo 'dist\win-unpacked'
$Exe   = 'Claude Cockpit.exe'

Write-Host '> Building bundle...'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

Write-Host '> Packaging app (win dir)...'
# Local build: just the unpacked app dir (no NSIS installer, no signing).
& npx --no-install electron-builder --win dir
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

if (-not (Test-Path $Built)) { throw "Expected build output not found: $Built" }

# The running app's exe is locked, so the swap must happen AFTER it exits. A
# detached, hidden watcher waits for the old process to quit, replaces the install,
# and relaunches — surviving this script's pty being torn down when the app quits.
Write-Host '> Scheduling relaunch...'
$watcher = @"
while (Get-Process -Name 'Claude Cockpit' -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 1
if (Test-Path '$Dest') { Remove-Item -Recurse -Force '$Dest' -ErrorAction SilentlyContinue }
Copy-Item -Recurse -Force '$Built' '$Dest'
Start-Process (Join-Path '$Dest' '$Exe')
"@
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $watcher) | Out-Null

Write-Host '> Update staged. Relaunching Cockpit...'
# Ask the running app to close gracefully (WM_CLOSE -> before-quit persists
# sessions) so the watcher takes over. If this runs inside Cockpit it also ends
# this script — fine, the detached watcher already owns the relaunch.
& taskkill /IM $Exe 2>$null | Out-Null
