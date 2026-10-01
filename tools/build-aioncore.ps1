<#
AionDX: build AionCore from its source, on the development PC only. Users never need Rust: the installer and
AionDX Apply Update ship the aioncore.exe this produces.

K, 2026-09-26: MCP per chat "needs to be a permanent one-time fix for me and other users", and on installing Rust:
"if it's for the dev environment that's fine. just don't users to have to install other software".

  - Rust: rustup, per user (%USERPROFILE%\.cargo, %USERPROFILE%\.rustup), with PATH left alone; this script calls
    cargo by its full path. The toolchain is the one AionCore pins in rust-toolchain.toml.
  - Source: a git worktree of upstream-aioncore at -Tag, on branch aiondx/<tag>, in vendor\aioncore-src. The
    reference clone's own files are never touched (the tree rule: never edit upstream-aioncore).
  - -Patched applies every patches\core-*\*.patch in name order with `git apply` onto a clean checkout of the tag.
  - The build is AionCore's own release build (.github\workflows\release.yml):
      cargo build --release --target x86_64-pc-windows-msvc -p aionui-app   RUSTFLAGS=-C target-feature=+crt-static
    It needs the Visual Studio C++ build tools, which this PC has (2019 and 2022 Build Tools).

Bounded: -DeadlineMinutes (default 120) and the stop file %TEMP%\aiondx-aioncore-build.STOP end it, killing the
tree it started. Windowless when started hidden. Log: %TEMP%\aiondx-aioncore-build.log; the last line is
"DONE <exit code>". Result: vendor\aioncore-src\target\x86_64-pc-windows-msvc\release\aioncore.exe.
#>
param(
  [string]$Tag = 'v0.2.2',
  [switch]$Patched,
  [int]$DeadlineMinutes = 120
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ref = Join-Path $root 'upstream-aioncore'
$wt = Join-Path $root 'vendor\aioncore-src'
$log = Join-Path $env:TEMP 'aiondx-aioncore-build.log'
$stop = Join-Path $env:TEMP 'aiondx-aioncore-build.STOP'
$deadline = (Get-Date).AddMinutes($DeadlineMinutes)
$cargoHome = Join-Path $env:USERPROFILE '.cargo'
$rustup = Join-Path $cargoHome 'bin\rustup.exe'
$cargo = Join-Path $cargoHome 'bin\cargo.exe'
$target = 'x86_64-pc-windows-msvc'

Set-Content -LiteralPath $log -Value ('{0}  AionCore build: tag {1}, patched {2}, deadline {3:HH:mm}' -f (Get-Date -Format 'HH:mm:ss'), $Tag, [bool]$Patched, $deadline) -Encoding utf8
if (Test-Path $stop) { Remove-Item -LiteralPath $stop -Force }
function Say([string]$m) { Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }

# Runs a program hidden, its output appended to the log, until it exits, the deadline passes or the stop file appears.
function Run([string]$exe, [string[]]$argList, [string]$cwd, [hashtable]$envVars) {
  $out = Join-Path $env:TEMP ('aiondx-aioncore-step-{0}.out' -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
  $err = "$out.err"
  $saved = @{}
  if ($envVars) { foreach ($k in $envVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envVars[$k]) } }
  try {
    $p = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $cwd -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle   # without this, ExitCode can read as null once the process has ended
  } finally {
    if ($envVars) { foreach ($k in $envVars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
  }
  $lastLen = 0
  while (-not $p.HasExited) {
    if ((Get-Date) -gt $deadline -or (Test-Path $stop)) {
      & taskkill.exe /PID $p.Id /T /F | Out-Null
      Say ('stopped: ' + $(if (Test-Path $stop) { 'stop file' } else { 'deadline' }))
      throw 'stopped'
    }
    Start-Sleep -Seconds 5
    # Progress into the log (cargo writes it to stderr), a little at a time.
    if (Test-Path $err) {
      $len = (Get-Item $err).Length
      if ($len -gt $lastLen) {
        $fs = [IO.File]::Open($err, 'Open', 'Read', 'ReadWrite')
        try { $fs.Seek($lastLen, 'Begin') | Out-Null; $buf = New-Object byte[] ($len - $lastLen); [void]$fs.Read($buf, 0, $buf.Length) } finally { $fs.Close() }
        $lastLen = $len
        ([Text.Encoding]::UTF8.GetString($buf) -split "`r?`n") | Where-Object { $_ -match '\S' } | Select-Object -Last 3 | ForEach-Object { Say ('  ' + $_.Trim()) }
      }
    }
  }
  $p.WaitForExit()
  foreach ($f in @($out, $err)) { if (Test-Path $f) { Get-Content -LiteralPath $f -Tail 25 | Where-Object { $_ -match '\S' } | ForEach-Object { Say ('  | ' + $_) }; Remove-Item -LiteralPath $f -Force } }
  return $p.ExitCode
}

$code = 1
try {
  # 1. Rust, per user, PATH untouched.
  if (-not (Test-Path $rustup)) {
    # rustup-init reads its own file name to decide what to be, so it must keep that name.
    $dir = Join-Path $env:TEMP 'aiondx-rust'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $init = Join-Path $dir 'rustup-init.exe'
    $url = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
    Say 'downloading rustup-init from static.rust-lang.org'
    Invoke-WebRequest -Uri $url -OutFile $init -UseBasicParsing -TimeoutSec 300
    # It carries no Authenticode signature; rust-lang.org publishes its SHA-256 beside it.
    # Served as application/octet-stream, so it is read from a file as text, not from the response object (bytes).
    Invoke-WebRequest -Uri "$url.sha256" -OutFile "$init.sha256" -UseBasicParsing -TimeoutSec 60
    $want = ((Get-Content -LiteralPath "$init.sha256" -Raw) -split '\s+')[0].Trim().ToLowerInvariant()
    $got = (Get-FileHash -LiteralPath $init -Algorithm SHA256).Hash.ToLowerInvariant()
    Say "rustup-init sha256 $got, published $want"
    if (-not $want -or $got -ne $want) { throw 'rustup-init does not match its published SHA-256' }
    $c = Run $init @('-y', '--no-modify-path', '--default-toolchain', 'none', '--profile', 'minimal') $env:TEMP $null
    if ($c -ne 0) { throw "rustup-init exit $c" }
  }
  Say ('rustup: ' + ((& $rustup --version 2>&1 | Select-Object -First 1) -join ''))

  # 2. The source, in its own worktree.
  if (-not (Test-Path (Join-Path $wt '.git'))) {
    Say "creating the worktree $wt at $Tag"
    $c = Run 'git' @('-C', "`"$ref`"", 'worktree', 'add', '--force', '-B', "aiondx/$Tag", "`"$wt`"", $Tag) $root $null
    if ($c -ne 0) { throw "git worktree add exit $c" }
  } else {
    $c = Run 'git' @('-C', "`"$wt`"", 'checkout', '--force', '-B', "aiondx/$Tag", $Tag) $root $null
    if ($c -ne 0) { throw "git checkout exit $c" }
    $c = Run 'git' @('-C', "`"$wt`"", 'clean', '-fdq', '-e', 'target') $root $null
  }

  # 3. The toolchain AionCore pins (rust-toolchain.toml), with its components.
  $pin = Get-Content -LiteralPath (Join-Path $wt 'rust-toolchain.toml') -Raw
  $channel = [regex]::Match($pin, 'channel\s*=\s*"([^"]+)"').Groups[1].Value
  $comps = [regex]::Matches([regex]::Match($pin, 'components\s*=\s*\[([^\]]*)\]').Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
  Say "toolchain $channel, components $($comps -join ', ')"
  $args3 = @('toolchain', 'install', $channel, '--profile', 'minimal', '--target', $target)
  foreach ($cp in $comps) { $args3 += @('--component', $cp) }
  $c = Run $rustup $args3 $wt $null
  if ($c -ne 0) { throw "rustup toolchain install exit $c" }

  # 4. AionDX's AionCore patches.
  if ($Patched) {
    $list = Get-ChildItem -Path (Join-Path $root 'patches') -Directory -Filter 'core-*' | Sort-Object Name | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.patch' | Sort-Object Name }
    foreach ($pf in $list) {
      Say "applying $($pf.Name)"
      $c = Run 'git' @('-C', "`"$wt`"", 'apply', '--whitespace=nowarn', "`"$($pf.FullName)`"") $root $null
      if ($c -ne 0) { throw "git apply $($pf.Name) exit $c" }
    }
    if (-not $list) { Say 'no core patches found' }
  }

  # 5. The release build, the way AionCore's own release does it.
  Say "cargo build --release --target $target -p aionui-app (RUSTFLAGS=-C target-feature=+crt-static)"
  $c = Run $cargo @('build', '--release', '--target', $target, '-p', 'aionui-app') $wt @{ RUSTFLAGS = '-C target-feature=+crt-static'; CARGO_TERM_COLOR = 'never' }
  if ($c -ne 0) { throw "cargo build exit $c" }
  $exe = Join-Path $wt "target\$target\release\aioncore.exe"
  $h = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  Say ('built {0}, {1} bytes, sha256 {2}' -f $exe, (Get-Item $exe).Length, $h)
  $ver = ((& $exe --version 2>&1 | Select-Object -First 1) -join '').Trim()
  Say ('version: ' + $ver)
  # A patched build goes where the installer build and AionDX Apply Update look for it, with a record of what
  # it is: the tag, the patches, and the hash of the stock binary it replaces (AionUi's own, pinned below).
  if ($Patched) {
    $out = Join-Path $root 'vendor\aioncore'
    New-Item -ItemType Directory -Force $out | Out-Null
    Copy-Item -LiteralPath $exe -Destination (Join-Path $out 'aioncore.exe') -Force
    $rec = [ordered]@{
      schema = 'aiondx.aioncore/1'; tag = $Tag; version = $ver; sha256 = $h; bytes = (Get-Item $exe).Length
      stockSha256 = $(if ($Tag -eq 'v0.2.2') { '67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892' } else { '' })
      patches = @($list | ForEach-Object { $_.Directory.Name } | Select-Object -Unique); builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
      toolchain = $channel
    }
    [IO.File]::WriteAllText((Join-Path $out 'aioncore.json'), ($rec | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Say "copied to $out with aioncore.json"
  }
  $code = 0
} catch {
  Say ('FAILED: ' + $_.Exception.Message)
} finally {
  Say "DONE $code"
}
exit $code
