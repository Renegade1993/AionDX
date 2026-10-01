<#
Tests elevated_copy.ps1's swaps without elevation or Program Files: a copy of it pointed at a temp folder.
  1. app.asar and aioncore.exe swapped together; both stock backups made once; .prev kept.
  2. -NoAsar swaps only aioncore.exe; the asar and the stock backups stay.
  3. the live app.asar held open, so its swap fails: aioncore.exe goes back as it was, the new one staged again.
Run: powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-elevated-copy.ps1   (exit 0 when all pass)
Finite; deletes its temp folder at the end.
#>
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'elevated_copy.ps1'
$t = Join-Path $env:TEMP ('aiondx-swaptest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$res = Join-Path $t 'resources'
$core = Join-Path $res 'bundled-aioncore\win32-x64'
$vend = Join-Path $t 'vendor'
New-Item -ItemType Directory -Force $core, $vend | Out-Null
$script = Join-Path $t 'elevated_copy.test.ps1'
$text = [IO.File]::ReadAllText($src)
$text = $text.Replace("'C:\Program Files\AionUi\resources'", "'$res'").Replace("'C:\AI Projects\AionDX\vendor'", "'$vend'")
[IO.File]::WriteAllText($script, $text, (New-Object Text.UTF8Encoding($false)))
function Put([string]$p, [string]$v) { [IO.File]::WriteAllText($p, $v) }
function Get([string]$p) { if (Test-Path -LiteralPath $p) { [IO.File]::ReadAllText($p) } else { '(none)' } }
$fails = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { Write-Output "PASS  $name" } else { $script:fails++; Write-Output "FAIL  $name   [$detail]" }
}
function Run([string[]]$extra) {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) + $extra
  & powershell.exe @args2 *> $null
  return (Get (Join-Path $vend 'install-state.txt')).Trim()
}

Put (Join-Path $res 'app.asar') 'A1'
Put (Join-Path $core 'aioncore.exe') 'C1'
Put (Join-Path $t 'a2') 'A2'; Put (Join-Path $t 'c2') 'C2'; Put (Join-Path $t 'c3') 'C3'; Put (Join-Path $t 'a4') 'A4'; Put (Join-Path $t 'c4') 'C4'

$st = Run @('-Source', (Join-Path $t 'a2'), '-CoreSource', (Join-Path $t 'c2'))
Check 'both swapped, state SWAPPED' ($st -eq 'SWAPPED' -and (Get "$res\app.asar") -eq 'A2' -and (Get "$core\aioncore.exe") -eq 'C2') "$st $(Get "$res\app.asar") $(Get "$core\aioncore.exe")"
Check 'stock backups made from the live files, .prev kept' ((Get "$res\app.asar.stock") -eq 'A1' -and (Get "$core\aioncore.exe.stock") -eq 'C1' -and
  (Get "$res\app.asar.prev") -eq 'A1' -and (Get "$core\aioncore.exe.prev") -eq 'C1') "$(Get "$res\app.asar.stock") $(Get "$core\aioncore.exe.stock")"

$st = Run @('-NoAsar', '-CoreSource', (Join-Path $t 'c3'))
Check '-NoAsar swaps only aioncore.exe' ($st -eq 'SWAPPED' -and (Get "$core\aioncore.exe") -eq 'C3' -and (Get "$core\aioncore.exe.prev") -eq 'C2' -and
  (Get "$res\app.asar") -eq 'A2' -and (Get "$res\app.asar.prev") -eq 'A1') "$st $(Get "$core\aioncore.exe") $(Get "$res\app.asar.prev")"
Check 'the stock backups are never rewritten' ((Get "$core\aioncore.exe.stock") -eq 'C1' -and (Get "$res\app.asar.stock") -eq 'A1') "$(Get "$core\aioncore.exe.stock")"

# The live app.asar held open without delete sharing, as a running AionUi holds it.
$lock = [IO.File]::Open("$res\app.asar", 'Open', 'Read', 'Read')
try {
  $st = Run @('-Source', (Join-Path $t 'a4'), '-CoreSource', (Join-Path $t 'c4'))
} finally { $lock.Close() }
# Without elevation the hand-off to Task Scheduler fails after the swap attempt; what matters is the state left.
Check 'a refused asar swap puts aioncore.exe back, keeps both .prev copies, and leaves the new files staged' ((Get "$core\aioncore.exe") -eq 'C3' -and
  (Get "$core\aioncore.exe.new") -eq 'C4' -and (Get "$res\app.asar") -eq 'A2' -and (Get "$res\app.asar.new") -eq 'A4' -and
  (Get "$core\aioncore.exe.prev") -eq 'C2' -and (Get "$res\app.asar.prev") -eq 'A1' -and -not (Test-Path "$core\aioncore.exe.prev.old")) `
  "$st core=$(Get "$core\aioncore.exe") new=$(Get "$core\aioncore.exe.new") prev=$(Get "$core\aioncore.exe.prev") asar=$(Get "$res\app.asar")"

Remove-Item -LiteralPath $t -Recurse -Force
Write-Output ("{0} failed" -f $fails)
exit $(if ($fails) { 1 } else { 0 })
