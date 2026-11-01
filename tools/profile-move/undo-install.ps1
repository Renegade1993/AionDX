<#
  undo-install.ps1 - puts a PC back as it was before install.bat restored a profile package onto it. Run it through undo-install.cmd.

    undo-install.cmd              show the plan, ask, close AionDX and Claude Code, swap the folders back
    undo-install.cmd -DryRun      show the plan only; nothing is closed or moved
    undo-install.cmd -Yes         no question
    undo-install.cmd -Stamp 20261031-171443    the install to undo (default: the newest)

  install.bat never deletes: every folder it replaced was renamed "<name>.pre-restore-<stamp>" beside the new one (and the two files
  .claude.json and .gitconfig the same way). This swaps them back:
      <name>                      ->  <name>.imported-<stamp>     (what the install put there; kept, nothing is deleted)
      <name>.pre-restore-<stamp>  ->  <name>                      (what was there before)
  If any step fails, the steps already done are reversed, so the PC is never left half swapped. The chats, teams, agents, Claude Code
  history and sign-ins of the earlier state come back together because they are in those folders. Work done after the install (chats
  started, messages sent) stays in the ".imported-<stamp>" folders and can be copied back in afterwards.

  Not undone, because install.bat keeps no copy of them: the few small files it laid over %LOCALAPPDATA%\AionDX and over
  .claude-work-home, and the Windows user variables it set (they are the same values the earlier state had, unless changed on the
  other PC). The log is Downloads\AionDX-undo-install-<time>.log.
#>
param([switch]$DryRun, [switch]$Yes, [string]$Stamp = '', [string]$TestRoot = '')
$ErrorActionPreference = 'Stop'
$now = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($TestRoot) {
  $TestRoot = [IO.Path]::GetFullPath($TestRoot)
  $HOMEDIR = Join-Path $TestRoot 'home'; $APPDATA_ = Join-Path $HOMEDIR 'AppData\Roaming'; $LOCAL_ = Join-Path $HOMEDIR 'AppData\Local'
  $logDir = $TestRoot
} else { $HOMEDIR = [IO.Path]::GetFullPath($env:USERPROFILE); $APPDATA_ = [IO.Path]::GetFullPath($env:APPDATA); $LOCAL_ = [IO.Path]::GetFullPath($env:LOCALAPPDATA); $logDir = Join-Path $HOMEDIR 'Downloads' }
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir ('AionDX-undo-install-' + $now + $(if ($DryRun) { '-dry' }) + '.log')
try { Start-Transcript -LiteralPath $logFile -Force | Out-Null } catch { }
function Say($m, $c) { $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m; if ($c) { Write-Host $line -ForegroundColor $c } else { Write-Host $line } }
function Finish($code) { try { Stop-Transcript | Out-Null } catch { }; exit $code }

function Busy() {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and (
      $_.Name -in @('AionDX.exe', 'AionUi.exe', 'aioncore.exe', 'aiondx-loop.exe', 'claude.exe', 'agy.exe') -or
      ($_.Name -eq 'node.exe' -and [string]$_.CommandLine -match '(?i)\\\.claude|claude-code|claude-agent-acp|claude-account-router|AionUi|aiondx'))
  }
}
function Find-Node {
  $c = @()
  $c += Get-ChildItem (Join-Path $LOCAL_ 'Programs\AionDX\resources\bundled-aioncore\win32-x64\managed-resources\node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  $c += "$env:ProgramFiles\nodejs\node.exe"
  foreach ($n in $c) { if ($n -and (Test-Path $n)) { & cmd.exe /d /c ('"' + $n + '" -e "require(''node:sqlite'')" >nul 2>nul'); if ($LASTEXITCODE -eq 0) { return $n } } }
  return $null
}

try {
  Say ('Undo of an AionDX package install, for ' + $HOMEDIR + $(if ($DryRun) { '  (DRY RUN: nothing will change)' }) + $(if ($TestRoot) { '  (TEST ROOT)' })) 'Cyan'

  # what was set aside
  $found = @()
  foreach ($d in @($HOMEDIR, $APPDATA_, $LOCAL_, (Join-Path $HOMEDIR '.local'))) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($e in Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue) {
      if ($e.Name -match '^(?<n>.+)\.pre-restore-(?<s>\d{8}-\d{6})$') { $found += [pscustomobject]@{ Dir = $d; Name = $Matches['n']; Stamp = $Matches['s']; Old = $e.FullName } }
    }
  }
  if (-not $found.Count) { Say 'No ".pre-restore-" folders here: nothing to undo.' 'Yellow'; Finish 0 }
  $stamps = @($found | Select-Object -ExpandProperty Stamp -Unique | Sort-Object)
  if (-not $Stamp) { $Stamp = $stamps[-1] }
  if ($stamps.Count -gt 1) { Say ('Installs found: ' + ($stamps -join ', ') + '. Undoing ' + $Stamp + ' (use -Stamp for another).') }
  $use = @($found | Where-Object { $_.Stamp -eq $Stamp })
  if (-not $use.Count) { Say ("No set-aside folders with the stamp $Stamp.") 'Red'; Finish 1 }

  $plan = @()
  foreach ($p in $use) {
    $cur = Join-Path $p.Dir $p.Name
    $aside = Join-Path $p.Dir ($p.Name + '.imported-' + $Stamp)
    $k = 2; while (Test-Path -LiteralPath $aside) { $aside = Join-Path $p.Dir ($p.Name + '.imported-' + $Stamp + '-' + $k); $k++ }
    $plan += [pscustomobject]@{ Cur = $cur; CurExists = (Test-Path -LiteralPath $cur); Aside = $aside; Old = $p.Old }
  }
  Say ('Plan (' + $plan.Count + ' items):')
  foreach ($s in $plan) {
    $short = $s.Cur.Replace($HOMEDIR, '~')
    if ($s.CurExists) { Say ('  {0}  ->  {1}   (kept)' -f $short, (Split-Path $s.Aside -Leaf)) } else { Say ('  {0} is not there now' -f $short) }
    Say ('  {0}  ->  {1}' -f (Split-Path $s.Old -Leaf), (Split-Path $s.Cur -Leaf))
  }

  if ($DryRun) { Say 'Dry run: nothing was closed or moved.' 'Green'; Finish 0 }

  # AionDX and Claude Code hold these folders open
  if (-not $TestRoot) {
    $run = @(Busy)
    if ($run.Count) {
      Say ('Running now and holding these folders: ' + (($run | Select-Object -ExpandProperty Name -Unique) -join ', ')) 'Yellow'
      if (-not $Yes) {
        Write-Host ''
        Write-Host 'This closes AionDX and every Claude Code window (and the chat you are in now), then swaps the folders back.' -ForegroundColor Yellow
        $a = Read-Host 'Type YES to go on'
        if ($a -ne 'YES') { Say 'Stopped: nothing was changed.' 'Yellow'; Finish 1 }
      }
      $run | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
      for ($i = 0; $i -lt 20 -and @(Busy).Count; $i++) { Start-Sleep -Seconds 1 }
      $left = @(Busy)
      if ($left.Count) { Say ('Could not close: ' + (($left | Select-Object -ExpandProperty Name -Unique) -join ', ') + '. Nothing was changed.') 'Red'; Finish 1 }
      Start-Sleep -Seconds 2
    }
  } elseif (-not $Yes) { Say 'Test root: use -Yes.' 'Red'; Finish 1 }

  # the swap, all or nothing
  $done = New-Object System.Collections.ArrayList
  function Step($from, $to) {
    Rename-Item -LiteralPath $from -NewName (Split-Path $to -Leaf) -ErrorAction Stop
    [void]$done.Add(@{ from = $from; to = $to })
  }
  try {
    foreach ($s in $plan) {
      if ($s.CurExists) { Step $s.Cur $s.Aside }
      Step $s.Old $s.Cur
      Say ('swapped ' + $s.Cur.Replace($HOMEDIR, '~')) 'Green'
    }
  } catch {
    Say ('A step failed: ' + $_.Exception.Message) 'Red'
    Say 'Reversing the steps already done...' 'Yellow'
    for ($i = $done.Count - 1; $i -ge 0; $i--) {
      try { Rename-Item -LiteralPath $done[$i].to -NewName (Split-Path $done[$i].from -Leaf) -ErrorAction Stop } catch { Say ('  could not reverse ' + $done[$i].to + ': ' + $_.Exception.Message) 'Red' }
    }
    Say 'The PC is as it was before this run.' 'Yellow'
    Finish 1
  }

  # check what came back
  $node = Find-Node
  $db = Join-Path $APPDATA_ 'AionUi\aionui\aionui-backend.db'
  if ($node -and (Test-Path -LiteralPath $db)) {
    $js = Join-Path $env:TEMP ('aiondx-undo-check-' + $now + '.js')
    Set-Content -LiteralPath $js -Encoding UTF8 -Value "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const n=(t)=>d.prepare('select count(*) n from '+t).get().n;const l=d.prepare('select max(created_at) m from messages').get().m;console.log('database '+Object.values(d.prepare('pragma quick_check').get())[0]+': teams '+n('teams')+', chats '+n('conversations')+', messages '+n('messages')+', newest message '+new Date(l).toLocaleString());"
    $out = & cmd.exe /d /c ('"' + $node + '" "' + $js + '" "' + $db + '" 2>nul')
    Remove-Item -LiteralPath $js -ErrorAction SilentlyContinue
    Say ('Back: ' + ($out | Select-Object -Last 1)) 'Green'
  } else { Say 'Done. (The database could not be checked here.)' 'Green' }
  Say 'Not undone, because the install kept no copy: a few small files in AppData\Local\AionDX and in .claude-work-home, and the Windows user variables.'
  Say 'Nothing was deleted: what the install put there is in the ".imported-" folders next to the restored ones. Delete them when you no longer need them.'
  Say ('The log: ' + $logFile)
  Say 'Start AionDX now.' 'Green'
  Finish 0
} catch {
  Say ('STOPPED: ' + $_.Exception.Message) 'Red'
  Finish 1
}
