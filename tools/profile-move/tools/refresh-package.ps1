<#
  refresh-package.ps1 - brings this package up to date with the PC it runs on. Run it through export.bat.

    export.bat                    newest AionDX installer (when this PC builds AionDX) + everything changed since the last export
    export.bat -LeaveOutActive    leave out the very large sessions still being written to
    export.bat -VerifyRestore     afterwards restore the package into a scratch folder under another user name, to prove it (minutes)

  What it does, in order:
    1. On the development PC only (C:\AI Projects\AionDX\dist exists): the newest AionDX-<version>-setup.exe there, checked against its
       SHA256SUMS.txt, goes into installers\ and the older ones come out. Elsewhere the installer already in the package is kept.
    2. tools\export.js: data\ is brought up to date. Only files that changed are copied and files that are gone are removed, so a second
       run takes a few minutes. The AionDX database is copied as one consistent snapshot, so AionDX may stay open.
    3. Checks: the copied database opens (teams, conversations, messages), and install.ps1 -DryRun reads the new manifest.
  Nothing outside this folder is changed. The log is logs\export-<time>.log.
#>
param([switch]$LeaveOutActive, [switch]$VerifyRestore, [string]$DistDir = 'C:\AI Projects\AionDX\dist')
$ErrorActionPreference = 'Stop'
$pkg = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force (Join-Path $pkg 'logs') | Out-Null
$logFile = Join-Path $pkg ('logs\export-' + $stamp + '.log')
try { Start-Transcript -LiteralPath $logFile -Force | Out-Null } catch { }
function Say($m, $c) { if ($c) { Write-Host ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) -ForegroundColor $c } else { Write-Host ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) } }
function Find-Node {
  $c = @()
  $c += Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs\AionDX\resources\bundled-aioncore\win32-x64\managed-resources\node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  $c += "$env:ProgramFiles\nodejs\node.exe"
  $g = Get-Command node -ErrorAction SilentlyContinue; if ($g) { $c += $g.Source }
  foreach ($n in $c) { if ($n -and (Test-Path $n)) { & cmd.exe /d /c ('"' + $n + '" -e "require(''node:sqlite'')" >nul 2>nul'); if ($LASTEXITCODE -eq 0) { return $n } } }
  return $null
}
$t0 = Get-Date
try {
  Say ("Export of {0} ({1}) into {2}" -f $env:USERNAME, $env:USERPROFILE, $pkg) 'Cyan'
  $node = Find-Node
  if (-not $node) { throw 'No Node.js 22.13 or newer was found (AionDX brings one; install AionDX or Node.js first).' }
  Say ("Node.js: {0}" -f $node)

  # 1. the newest installer, on the development PC
  if (Test-Path -LiteralPath $DistDir) {
    $cands = Get-ChildItem -LiteralPath $DistDir -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending
    $src = $null
    foreach ($d in $cands) { $f = Join-Path $d.FullName ('AionDX-' + $d.Name + '-setup.exe'); if (Test-Path $f) { $src = Get-Item $f; break } }
    if ($src) {
      $sums = Join-Path $src.DirectoryName 'SHA256SUMS.txt'
      $want = (Get-Content $sums | Where-Object { $_ -match [regex]::Escape($src.Name) } | Select-Object -First 1) -replace '\s.*$', ''
      $inst = Join-Path $pkg 'installers'
      New-Item -ItemType Directory -Force $inst | Out-Null
      $have = Join-Path $inst $src.Name
      if ((Test-Path $have) -and ((Get-FileHash -LiteralPath $have -Algorithm SHA256).Hash.ToLower() -eq $want.ToLower())) { Say ("Installer: {0} is already in the package." -f $src.Name) }
      else {
        $got = (Get-FileHash -LiteralPath $src.FullName -Algorithm SHA256).Hash.ToLower()
        if (-not $want -or $want.ToLower() -ne $got) { throw ("{0} does not match {1}" -f $src.Name, $sums) }
        Get-ChildItem -LiteralPath $inst -Filter 'AionDX-*-setup.exe' | Where-Object { $_.Name -ne $src.Name } | Remove-Item -Force
        Copy-Item -LiteralPath $src.FullName -Destination $inst -Force
        Copy-Item -LiteralPath $sums -Destination $inst -Force
        Say ("Installer: {0} ({1:N0} MB), sha256 {2}, checked." -f $src.Name, ($src.Length / 1MB), $got) 'Green'
      }
    }
  } else { Say ('Installer: kept (' + ((Get-ChildItem (Join-Path $pkg 'installers') -Filter 'AionDX-*-setup.exe' | Select-Object -ExpandProperty Name) -join ', ') + ').') }

  # 2. the data
  $eargs = @((Join-Path $pkg 'tools\export.js'))
  if (-not $LeaveOutActive) { $eargs += '--include-active' }
  Say 'Exporting the data (only what changed is copied).'
  $env:AIONDX_PACKAGE_DIR = $pkg
  & cmd.exe /d /c ('"' + $node + '" "' + ($eargs -join '" "') + '" 2>&1')
  if ($LASTEXITCODE -ne 0) { throw "export.js ended with code $LASTEXITCODE; see export.log" }

  # 3. checks
  $m = Get-Content (Join-Path $pkg 'MANIFEST.json') -Raw | ConvertFrom-Json
  Say ("Export made {0}; {1} folders; failures: {2}; Claude Code transcripts kept {3:N0} MB, older ones left out {4:N0} MB." -f $m.createdAt, @($m.components | Where-Object { $_.id -notmatch '/' -and -not $_.database }).Count, @($m.failures).Count, ($m.conversationCache.claudeKeptBytes / 1MB), ($m.conversationCache.claudeDroppedBytes / 1MB))
  foreach ($f in @($m.failures)) { Say ("   could not copy: {0}" -f $f) 'Yellow' }
  $db = Join-Path $pkg 'data\roaming-AionUi\aionui\aionui-backend.db'
  $q = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const n=(t)=>d.prepare('select count(*) n from '+t).get().n;console.log('database ok: '+Object.values(d.prepare('pragma quick_check').get())[0]+' | teams '+n('teams')+' | conversations '+n('conversations')+' | messages '+n('messages'))"
  & cmd.exe /d /c ('"' + $node + '" -e "' + $q.Replace('"', '\"') + '" "' + $db + '" 2>nul')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkg 'install.ps1') -DryRun -SkipRedist -SkipApp -Yes | Select-String -Pattern 'Export made|Paths that|Finished|thing' | ForEach-Object { Say ('   dry run: ' + $_.Line.Substring(10)) }
  if ($VerifyRestore) {
    $t = 'C:\aiondx-restore-test\Other User'
    # links first, so nothing they point at is touched; then the folder
    function Clear-Rehearsal { if (Test-Path 'C:\aiondx-restore-test') { Get-ChildItem 'C:\aiondx-restore-test' -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { [IO.Directory]::Delete($_.FullName) }; Remove-Item 'C:\aiondx-restore-test' -Recurse -Force -ErrorAction SilentlyContinue } }
    Clear-Rehearsal
    Say ("Restoring into {0} as if it were another account's user folder..." -f $t)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkg 'install.ps1') -TestRoot $t -Yes | Select-String -Pattern 'Rewrote|Finished|STOPPED|  - |signed in|credentials' | ForEach-Object { Say ('   ' + $_.Line.Substring(10)) }
    Clear-Rehearsal
    Get-ChildItem (Join-Path $pkg 'logs') -Filter 'install-*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $t0 } | Remove-Item -ErrorAction SilentlyContinue
    Say ('Scratch restore done and removed' + $(if (Test-Path 'C:\aiondx-restore-test') { ' (some files were in use; C:\aiondx-restore-test is still there)' } else { '' }) + '.') 'Green'
  }
  Say ("The package is up to date ({0:N0} s). Copy this whole folder to the other PC and run install.bat there." -f ((Get-Date) - $t0).TotalSeconds) 'Green'
} catch {
  Say ('STOPPED: ' + $_.Exception.Message) 'Red'
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
try { Stop-Transcript | Out-Null } catch { }
exit 0
