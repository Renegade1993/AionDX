# core-unit-tests.ps1 - AionCore's unit tests for the crates a core patch touches, with the release build's own flags, so the dependencies
# tools\build-aioncore.ps1 -Patched already compiled are reused (a different RUSTFLAGS would rebuild all of them, about 30 minutes).
# Run after build-aioncore.ps1 -Patched (it leaves the patched, renamed checkout in vendor\aioncore-src). Hidden; bounded by -Minutes.
#   powershell -ExecutionPolicy Bypass -File tools\core-unit-tests.ps1 -Crates aiondx-session-message,aiondx-conversation -Filter team
# Output: .tmp\core-unit-tests.log (stdout: each test and "test result:" lines) and .err (cargo's progress). Last line of the log: EXIT <code>.
param(
  [string[]]$Crates = @('aiondx-session-message', 'aiondx-conversation', 'aiondx-team'),
  [string]$Filter = '',
  [int]$Minutes = 40
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$wt = Join-Path $root 'vendor\aioncore-src'
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$cargo = Join-Path $cargoHome 'bin\cargo.exe'
$rustupHome = Join-Path $env:USERPROFILE '.rustup'
# the same flags as build-aioncore.ps1 (keep the two in step)
$flags = @('-C', 'target-feature=+crt-static',
  "--remap-path-prefix=$cargoHome=C:\cargo", "--remap-path-prefix=$rustupHome=C:\rustup", "--remap-path-prefix=$wt=C:\aioncore",
  "--remap-path-prefix=$env:USERPROFILE=C:\user", '-C', 'link-arg=/PDBALTPATH:%_PDB%')
$env:CARGO_ENCODED_RUSTFLAGS = ($flags -join [string][char]0x1f)
$env:RUSTFLAGS = $null
$env:CL = "/d1trimfile:$($env:USERPROFILE)\"
$env:CARGO_TERM_COLOR = 'never'
$env:CARGO_TARGET_DIR = Join-Path $wt 'target'
$tmp = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force $tmp | Out-Null
$log = Join-Path $tmp 'core-unit-tests.log'
$argList = @('test', '--release', '--target', 'x86_64-pc-windows-msvc')
foreach ($c in $Crates) { $argList += @('-p', $c) }
$argList += '--lib'
if ($Filter) { $argList += @('--', $Filter) }
$p = Start-Process -FilePath $cargo -ArgumentList $argList -WorkingDirectory $wt -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
if (-not $p.WaitForExit($Minutes * 60 * 1000)) { Stop-Process -Id $p.Id -Force; 'TIMEOUT' | Add-Content $log }
"EXIT $($p.ExitCode)" | Add-Content $log
Get-Content $log | Select-String -Pattern 'test result:|FAILED|panicked|EXIT|TIMEOUT'
