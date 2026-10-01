<#
  AionDX asar installer. Runs ELEVATED, started hidden by launch_elevated.ps1 or revert.ps1.

  WHY IT NEVER COPIES OVER app.asar
  The first version was one line, `Copy-Item app.asar.patched app.asar -Force`. That writes over the
  live archive in place, and it succeeds while AionUi is running, because the app opens its archive
  with shared write access. Electron then keeps reading through its open handle using the file table
  it parsed at startup, so any file packed after the changed one is read at the wrong offset.

  WHY THE WAIT RUNS UNDER TASK SCHEDULER
  The second version waited for AionUi to close inside this same process. On 2026-09-22 that waiter
  died silently the moment K restarted AionUi, with no swap and no log line. Cause, confirmed from
  both ends: aioncore starts every agent inside a Windows Job object with KILL_ON_JOB_CLOSE
  (upstream-aioncore\crates\aionui-process\src\capabilities.rs), and anything an agent launches,
  elevated or not, inherits that job. When AionUi exits the job closes and Windows kills everything
  in it. A task started by the Schedule service is outside that job, so the wait now lives there.

  WHAT IT DOES
    -Mode Install (default, from launch_elevated.ps1):
      1. Stage the new build as app.asar.new. Nothing has that file open.
      2. Try to swap by rename: app.asar -> app.asar.prev, app.asar.new -> app.asar. If the second
         rename fails the first is undone, so the app is never left without an app.asar.
      3. If Windows refuses because AionUi holds the file, register the one-shot SYSTEM task
         "AionDX pending asar swap", start it, and exit.
    -Mode Wait (run by that task):
      Poll every 250 ms; the moment no AionUi.exe exists, swap. Then delete the task.

  SAFETY
    - Deadline (-DeadlineMinutes, default 1440). On expiry the build stays staged, nothing else
      changes, and the task deletes itself.
    - Stop file: create C:\AI Projects\AionDX\vendor\install.stop to end the wait early.
    - Log:   C:\AI Projects\AionDX\vendor\install.log
    - State: C:\AI Projects\AionDX\vendor\install-state.txt
             SWAPPED | WAITING | STOPPED | TIMEOUT | FAILED
    - app.asar.stock is created once, from the live file, and never written again.
#>
param(
  [string]$Source = 'C:\AI Projects\AionDX\vendor\app.asar.patched',
  [ValidateSet('Install', 'Wait')][string]$Mode = 'Install',
  [int]$DeadlineMinutes = 1440,
  # Set by aiondx-apply.ps1 when the live app.asar is a stock build we have never backed up, which
  # means AionUi updated itself. The old backup is kept under its hash; the live file becomes
  # app.asar.stock, so a later revert restores the version actually installed.
  [switch]$RefreshStock,
  # AionCore (2026-09-26): an aioncore.exe to swap in beside the asar, staged as aioncore.exe.new and swapped
  # by rename the same way; the first swap keeps the stock binary as aioncore.exe.stock. -NoAsar swaps only it.
  [string]$CoreSource = '',
  [switch]$NoAsar
)

$ErrorActionPreference = 'Stop'
$res   = 'C:\Program Files\AionUi\resources'
$live  = Join-Path $res 'app.asar'
$stage = Join-Path $res 'app.asar.new'
$prev  = Join-Path $res 'app.asar.prev'
$stock = Join-Path $res 'app.asar.stock'
$vend  = 'C:\AI Projects\AionDX\vendor'
$log   = Join-Path $vend 'install.log'
$state = Join-Path $vend 'install-state.txt'
$stop  = Join-Path $vend 'install.stop'
$task  = 'AionDX pending asar swap'
$self  = $MyInvocation.MyCommand.Path
$coreDir   = Join-Path $res 'bundled-aioncore\win32-x64'
$coreLive  = Join-Path $coreDir 'aioncore.exe'
$coreStage = Join-Path $coreDir 'aioncore.exe.new'
$corePrev  = Join-Path $coreDir 'aioncore.exe.prev'
$coreStock = Join-Path $coreDir 'aioncore.exe.stock'

function Log([string]$m) { Add-Content -LiteralPath $log -Value ('{0}  [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Mode, $m) }
function Set-State([string]$s) { Set-Content -LiteralPath $state -Value $s }
function Remove-WaitTask { try { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction Stop } catch { } }

# The old .prev waits as .prev.old until the whole swap has worked, so a failed attempt keeps the rollback copy.
function Swap-File([string]$l, [string]$s, [string]$p) {
  $old = "$p.old"
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
  if (Test-Path -LiteralPath $p) { Move-Item -LiteralPath $p -Destination $old }
  try {
    Move-Item -LiteralPath $l -Destination $p   # refused while AionUi holds the live file
  } catch {
    if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination $p }
    throw
  }
  try {
    Move-Item -LiteralPath $s -Destination $l
  } catch {
    Move-Item -LiteralPath $p -Destination $l   # never leave the app without the file
    if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination $p }
    throw
  }
}
# AionCore first: Windows renames a running exe, and if the asar then cannot be swapped the core goes back to
# how it was, with the new one staged again, so the two always change together.
function Invoke-Swap {
  $coreStaged = Test-Path -LiteralPath $coreStage
  $asarStaged = Test-Path -LiteralPath $stage
  if ($coreStaged) { Swap-File $coreLive $coreStage $corePrev; Log 'aioncore.exe swapped' }
  if ($asarStaged) {
    try {
      Swap-File $live $stage $prev
    } catch {
      if ($coreStaged) {
        Move-Item -LiteralPath $coreLive -Destination $coreStage -Force
        Move-Item -LiteralPath $corePrev -Destination $coreLive
        if (Test-Path -LiteralPath "$corePrev.old") { Move-Item -LiteralPath "$corePrev.old" -Destination $corePrev }
        Log 'aioncore.exe put back, since the asar could not be swapped'
      }
      throw
    }
  }
  foreach ($o in @("$prev.old", "$corePrev.old")) { if (Test-Path -LiteralPath $o) { Remove-Item -LiteralPath $o -Force } }
}

if ($Mode -eq 'Install') {
  try {
    if (-not $NoAsar) {
      if (-not (Test-Path -LiteralPath $Source)) { throw "source missing: $Source" }
      if (-not (Test-Path -LiteralPath $stock)) { Copy-Item -LiteralPath $live -Destination $stock; Log 'stock backup created' }
      elseif ($RefreshStock) {
        $old = (Get-FileHash -LiteralPath $stock -Algorithm SHA256).Hash.Substring(0, 8)
        $new = (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash.Substring(0, 8)
        if ($old -ne $new) {
          $keep = "$stock.$old"
          if (-not (Test-Path -LiteralPath $keep)) { Copy-Item -LiteralPath $stock -Destination $keep }
          Copy-Item -LiteralPath $live -Destination $stock -Force
          Log "AionUi updated itself: previous stock kept as app.asar.stock.$old, live build $new is now app.asar.stock"
        }
      }
      Copy-Item -LiteralPath $Source -Destination $stage -Force
      Log "staged $Source"
    }
    if ($CoreSource) {
      if (-not (Test-Path -LiteralPath $CoreSource)) { throw "aioncore source missing: $CoreSource" }
      if (-not (Test-Path -LiteralPath $coreStock)) { Copy-Item -LiteralPath $coreLive -Destination $coreStock; Log 'aioncore.exe stock backup created' }
      Copy-Item -LiteralPath $CoreSource -Destination $coreStage -Force
      Log "staged aioncore.exe from $CoreSource"
    }
    if ($NoAsar -and -not $CoreSource) { throw 'nothing to install: -NoAsar without -CoreSource' }

    try {
      Invoke-Swap
      Log 'swapped immediately; restart AionUi to load it'
      Set-State 'SWAPPED'
      exit 0
    } catch {
      Log "live swap refused, AionUi holds the file: $($_.Exception.Message)"
    }

    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode Wait -DeadlineMinutes {1}' -f $self, $DeadlineMinutes
    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                   -ExecutionTimeLimit (New-TimeSpan -Minutes ($DeadlineMinutes + 10))
    Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force `
      -Description 'AionDX: one-shot. Swaps the staged app.asar.new in when AionUi closes, then deletes itself. Stop: create C:\AI Projects\AionDX\vendor\install.stop' | Out-Null
    Start-ScheduledTask -TaskName $task
    Log "handed the wait to Task Scheduler task '$task' (SYSTEM, outside AionUi's job object)"
    Set-State 'WAITING'
    exit 0
  } catch {
    Log "FAILED: $($_.Exception.Message)"
    Set-State 'FAILED'
    exit 1
  }
}

# -Mode Wait, run by Task Scheduler
try {
  if (-not (Test-Path -LiteralPath $stage) -and -not (Test-Path -LiteralPath $coreStage)) { Log 'nothing staged at app.asar.new or aioncore.exe.new'; Set-State 'FAILED'; Remove-WaitTask; exit 1 }
  Log "waiting for AionUi to close (pid $PID, deadline $DeadlineMinutes min, stop file $stop)"
  $until = (Get-Date).AddMinutes($DeadlineMinutes)
  $lastErr = ''
  while ((Get-Date) -lt $until) {
    # Another install (aiondx-apply.ps1) may have consumed the staged file. Retrying a swap with
    # nothing staged would rename app.asar back and forth for hours, so stand down instead.
    if (-not (Test-Path -LiteralPath $stage) -and -not (Test-Path -LiteralPath $coreStage)) {
      Log 'staged build is gone, another install consumed it; standing down'
      Remove-WaitTask
      exit 0
    }
    if (Test-Path -LiteralPath $stop) {
      Remove-Item -LiteralPath $stop -Force
      Log 'stop file seen; build left staged at app.asar.new'
      Set-State 'STOPPED'
      Remove-WaitTask
      exit 0
    }
    if (-not (Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)) {
      try {
        Invoke-Swap
        Log 'swapped after AionUi closed; the next launch loads the new build'
        Set-State 'SWAPPED'
        Remove-WaitTask
        exit 0
      } catch {
        $m = $_.Exception.Message
        if ($m -ne $lastErr) { Log "swap failed with AionUi closed, retrying: $m"; $lastErr = $m }
        Start-Sleep -Seconds 1
      }
    }
    Start-Sleep -Milliseconds 250
  }
  Log 'deadline reached; build left staged at app.asar.new'
  Set-State 'TIMEOUT'
  Remove-WaitTask
} catch {
  Log "FAILED: $($_.Exception.Message)"
  Set-State 'FAILED'
  Remove-WaitTask
  exit 1
}
