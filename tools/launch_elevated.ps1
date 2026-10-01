<#
  Install an asar build through elevated_copy.ps1 (stage, then swap by rename).
  Shows one UAC prompt. The elevated worker runs hidden.

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch_elevated.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch_elevated.ps1 -Source <path>

  Returns once the worker reports its first state:
    SWAPPED  installed; restart AionUi to load it
    WAITING  AionUi holds the file; the build installs the moment AionUi closes
  The argument string is passed as ONE string on purpose. Windows PowerShell 5.1's
  Start-Process joins an -ArgumentList array with spaces and does not quote elements, so the
  space in "C:\AI Projects" would split the path.
#>
param([string]$Source = 'C:\AI Projects\AionDX\vendor\app.asar.patched')

$worker = 'C:\AI Projects\AionDX\tools\elevated_copy.ps1'
$state  = 'C:\AI Projects\AionDX\vendor\install-state.txt'
if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Force }

$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Source "{1}"' -f $worker, $Source
Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $argLine

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $state)) { Start-Sleep -Milliseconds 500 }
if (Test-Path -LiteralPath $state) {
  $s = (Get-Content -LiteralPath $state -Raw).Trim()
  "install state: $s"
  switch ($s) {
    'SWAPPED' { 'Installed. Restart AionUi to load it.' }
    'WAITING' { 'Staged. Task Scheduler task "AionDX pending asar swap" installs it the moment AionUi fully closes; reopen AionUi after that.' }
    default   { 'See C:\AI Projects\AionDX\vendor\install.log' }
  }
} else {
  'No state reported within 120 s. Was the UAC prompt approved? See vendor\install.log.'
}
