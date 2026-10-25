<#
  clean-test-leftovers.ps1 - removes what AionDX's tests and builds leave in %TEMP%: throwaway app profiles, scratch folders, logs.

    powershell -ExecutionPolicy Bypass -File tools\clean-test-leftovers.ps1 [-OlderThanMinutes 30] [-DryRun]

  Only names AionDX's tools make are touched (aiondx-*, click-*.log, the restore rehearsal folder), and only when they were last
  written more than -OlderThanMinutes ago, so a test that is running keeps its files. Links inside a folder are removed as links
  first, so nothing they point at is touched. Run it at the end of a test session.
#>
param([int]$OlderThanMinutes = 30, [switch]$DryRun)
$ErrorActionPreference = 'Continue'
$cut = (Get-Date).AddMinutes(-$OlderThanMinutes)
$targets = @(Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -like 'aiondx-*' -or $_.Name -like 'click-*.log' -or $_.Name -like 'p001?' -or $_.Name -like 'core000?-*') -and $_.LastWriteTime -lt $cut })
$rehearsal = 'C:\aiondx-restore-test'
if ((Test-Path $rehearsal) -and (Get-Item $rehearsal).LastWriteTime -lt $cut) { $targets += Get-Item $rehearsal }
$freed = 0; $n = 0
foreach ($t in $targets) {
  $size = if ($t.PSIsContainer) { (Get-ChildItem $t.FullName -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } else { $t.Length }
  if ($DryRun) { "would remove {0} ({1:N1} MB)" -f $t.FullName, ($size / 1MB); continue }
  try {
    if ($t.PSIsContainer) {
      Get-ChildItem $t.FullName -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { [IO.Directory]::Delete($_.FullName) }
      Remove-Item -LiteralPath $t.FullName -Recurse -Force -ErrorAction Stop
    } else { Remove-Item -LiteralPath $t.FullName -Force -ErrorAction Stop }
    $freed += $size; $n++
  } catch { "kept {0}: {1}" -f $t.Name, $_.Exception.Message }
}
"removed {0} item(s), {1:N1} MB" -f $n, ($freed / 1MB)
