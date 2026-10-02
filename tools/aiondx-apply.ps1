<#
  AionDX: install, roll back or revert AionUi's app.asar, from OUTSIDE AionUi.

  WHY THIS EXISTS
  aioncore runs every agent inside a Windows Job object (KILL_ON_JOB_CLOSE, breakaway disabled), so
  anything an agent starts, elevated or not, dies when AionUi closes. Installing a new app.asar needs
  AionUi closed, so nothing launched from inside AionUi can finish an install. a request of 2026-09-22.
  And, 2026-09-24: "I need a revert mechanism if AionDX fails to startup as well." When AionUi will
  not start, no agent can help, so the way back has to live here, on the desktop.

  This runs from the desktop shortcut "AionDX Apply Update". If it finds itself inside AionUi anyway
  (an agent ran it), it hands itself to Task Scheduler instead of closing the app out from under
  itself.

  WHAT IT DOES
    Opens a small menu:
      Install the new AionDX build     rebuilds first if a patch source or the app is newer
      Roll back to the previous build  app.asar.prev: whatever was live before the last swap
      Revert to stock AionUi           app.asar.stock: AionUi exactly as installed, no AionDX
    Then, for any choice:
      1. Stops an install waiter still pending from an earlier attempt, so two swaps cannot race.
      2. Closes AionUi (window close, force after 15 s) and waits for aioncore to exit, so the
         database is flushed before anything is swapped.
      3. One UAC prompt: elevated_copy.ps1 stages the chosen archive and swaps it in by rename. The
         archive that was live becomes app.asar.prev, so every swap can itself be undone.
      4. Checks the installed file against the chosen one by SHA-256 and records the swap in
         vendor\install-history.json.
      5. Reopens AionUi through explorer.exe (as the owner, not elevated, in no job) and checks it started:
         a window within 75 s that is still up 20 s later. For a build carrying patch 0003, also
         the local-account and Core-session lines in the main log.
      6. If AionUi did not start, offers a roll back or a revert on the spot, once.
    On any failure after AionUi was closed, it still reopens AionUi.

  USAGE
    Desktop shortcut "AionDX Apply Update"                     the menu
    powershell -File tools\aiondx-apply.ps1 -DryRun            state and every plan; changes nothing
    powershell -File tools\aiondx-apply.ps1 -Yes               install, no menu (agents, old callers)
    powershell -File tools\aiondx-apply.ps1 -Action Rollback   roll back, no menu
    powershell -File tools\aiondx-apply.ps1 -Action Stock      revert to stock, no menu
    powershell -File tools\aiondx-apply.ps1 -DryRun -MenuPreview x.png   draw the menu to a PNG
#>
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Detached,
  [ValidateSet('Menu', 'Install', 'Rollback', 'Stock')][string]$Action = 'Menu',
  [string]$MenuPreview = ''
)

$ErrorActionPreference = 'Stop'
$root     = 'C:\AI Projects\AionDX'
$tools    = Join-Path $root 'tools'
$vend     = Join-Path $root 'vendor'
$patched  = Join-Path $vend 'app.asar.patched'
$patchJs  = Join-Path $root 'patches\0001-renderer-dx\aionui-dx.js'
# Every patch source the build reads. A change to any of them means a rebuild.
$patchSources = @($patchJs, (Join-Path $root 'patches\0003-local-account\apply.js'), (Join-Path $root 'patches\0006-butler-to-antigravity\apply.js'), (Join-Path $root 'patches\0009-identity\apply.js'), (Join-Path $root 'patches\0009-identity\icon\png\aiondx-1024.png'), (Join-Path $tools 'do_patch.ps1'))
$res      = 'C:\Program Files\AionUi\resources'
$live     = Join-Path $res 'app.asar'
$stock    = Join-Path $res 'app.asar.stock'
$prevF    = Join-Path $res 'app.asar.prev'
$coreDir    = Join-Path $res 'bundled-aioncore\win32-x64'
$coreLive   = Join-Path $coreDir 'aioncore.exe'
$coreStockF = Join-Path $coreDir 'aioncore.exe.stock'
$corePrevF  = Join-Path $coreDir 'aioncore.exe.prev'
$coreBuilt  = Join-Path $vend 'aioncore\aioncore.exe'
$coreRecF   = Join-Path $vend 'aioncore\aioncore.json'
$appExe   = 'C:\Program Files\AionUi\AionUi.exe'
$logFile  = Join-Path $vend 'apply.log'
$histF    = Join-Path $vend 'install-history.json'
$stateF   = Join-Path $vend 'install-state.txt'
$stopF    = Join-Path $vend 'install.stop'
$asarCmd  = Join-Path $vend 'node_modules\.bin\asar.cmd'
$selfTask = 'AionDX apply update'
if ($Yes -and $Action -eq 'Menu') { $Action = 'Install' }

function Log([string]$m) { Add-Content -LiteralPath $logFile -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
function Say([string]$m) { Log $m; Write-Output $m }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Box([string]$text, [string]$buttons = 'OK', [string]$icon = 'Information') {
  if ($DryRun) { return 'OK' }
  return [string][System.Windows.Forms.MessageBox]::Show($text, 'AionDX', $buttons, $icon)
}
function Get-Hash([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
function Short([string]$h) { if ($h) { $h.Substring(0, 8) } else { '' } }

function Test-InsideAionUi {
  $id = $PID
  for ($i = 0; $i -lt 12 -and $id; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if (-not $p) { break }
    if ($p.Name -in @('aioncore.exe', 'AionUi.exe')) { return $true }
    $id = $p.ParentProcessId
  }
  return $false
}

# Which AionDX patches the installed archive carries, read from its index.html.
function Get-LiveMarkers {
  $tmp = Join-Path $env:TEMP ('aiondx-live-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Push-Location $tmp
    try { & $asarCmd extract-file $live 'out\renderer\index.html' 2>$null | Out-Null } finally { Pop-Location }
    $idx = Join-Path $tmp 'index.html'
    $html = if (Test-Path -LiteralPath $idx) { Get-Content -LiteralPath $idx -Raw } else { '' }
    return @{ Loop = ($html -match 'aionui-dx\.js'); NoSignIn = ($html -match 'id="aiondx-0003"') }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-Backend { Get-Process -Name 'aioncore' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\Program Files\AionUi\*' } }

function Open-AionUi {
  if (Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue) { return }
  # explorer.exe launches it as the signed-in user, not elevated, parented to the shell.
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $appExe)
  Say 'AionUi reopened'
}

function Close-AionUi {
  $procs = @(Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return $false }
  # AionUi counts a GPU process that dies while its main process lives as a GPU crash
  # (child-process-gone), and after three it switches hardware acceleration off for a day
  # (%APPDATA%\AionUi\gpu.config.json). Until 2026-09-25 this killed every AionUi process at once,
  # and three installs on the 24th left AionUi running without hardware acceleration. Now the main
  # process goes first, so its children exit on their own, and a crash recorded during this close
  # is ours and is put back.
  $gpuFile = Join-Path $env:APPDATA 'AionUi\gpu.config.json'
  $gpuBefore = if (Test-Path -LiteralPath $gpuFile) { [IO.File]::ReadAllText($gpuFile) } else { $null }
  foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }
  $t0 = Get-Date
  while ((Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue) -and ((Get-Date) - $t0).TotalSeconds -lt 15) { Start-Sleep -Milliseconds 500 }
  $left = @(Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)
  if ($left.Count) {
    # AionUi hides to the tray on close, so it is usually still here. The browser process first:
    # it is the AionUi.exe without a --type= switch.
    $main = @(Get-CimInstance Win32_Process -Filter "Name='AionUi.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -notmatch '--type=' })
    foreach ($m in $main) { Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue }
    $t0 = Get-Date
    while ((Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue) -and ((Get-Date) - $t0).TotalSeconds -lt 8) { Start-Sleep -Milliseconds 250 }
    $rest = @(Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)
    if ($rest.Count) { $rest | Stop-Process -Force }
    Say "closed AionUi (main process ended first; $($rest.Count) helper process(es) still had to be forced; it hides to the tray on close)"
  }
  else { Say 'AionUi closed' }
  $gpuAfter = if (Test-Path -LiteralPath $gpuFile) { [IO.File]::ReadAllText($gpuFile) } else { $null }
  if ($gpuAfter -ne $gpuBefore) {
    if ($null -eq $gpuBefore) { Remove-Item -LiteralPath $gpuFile -Force -ErrorAction SilentlyContinue }
    else { [IO.File]::WriteAllText($gpuFile, $gpuBefore) }
    Say 'GPU crash record written during the close was put back (the close caused it)'
  }
  $t0 = Get-Date
  while ((Get-Backend) -and ((Get-Date) - $t0).TotalSeconds -lt 30) { Start-Sleep -Milliseconds 500 }
  $core = @(Get-Backend)
  if ($core.Count) { $core | Stop-Process -Force; Say 'aioncore had not exited after 30 s; forced it' }
  return $true
}

# Did AionUi come up? A window within 75 s that is still there 20 s after it first appeared.
function Test-Started {
  $t0 = Get-Date
  $firstWin = $null
  while (((Get-Date) - $t0).TotalSeconds -lt 75) {
    $procs = @(Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)
    $win = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($win) {
      if (-not $firstWin) { $firstWin = Get-Date }
      elseif (((Get-Date) - $firstWin).TotalSeconds -ge 20) { return $true }
    } elseif ($firstWin -and -not $procs.Count) {
      Say 'AionUi opened a window and then exited'
      return $false
    }
    Start-Sleep -Seconds 2
  }
  $ok = [bool]$firstWin -and [bool](Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)
  if (-not $ok) { Say 'AionUi showed no window within 75 s' }
  return $ok
}

# Patch 0003 check: after a reopen, the main-process log should show the local account and a
# Core session for it, with no sign-in. Returns a line for the final message.
function Test-LocalAccount([datetime]$since) {
  $day = Get-Date
  $log = Join-Path $env:APPDATA ('AionUi\logs\{0:yyyy}\{0:MM}\{0:dd}\{0:yyyy-MM-dd}.log' -f $day)
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt 90) {
    if (Test-Path -LiteralPath $log) {
      $recent = @(Get-Content -LiteralPath $log -Tail 400 | Where-Object {
        $_ -match '^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)' -and [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null) -ge $since.AddSeconds(-2) })
      $acct  = $recent | Where-Object { $_ -match '\[AionDX 0003\] local account' } | Select-Object -Last 1
      $ready = $recent | Where-Object { $_ -match '\[CoreUserBridge\] Core session ready' } | Select-Object -Last 1
      $bad   = $recent | Where-Object { $_ -match '\[CoreUserBridge\] (provision/exchange failed|refusing)' } | Select-Object -Last 1
      if ($acct -and $ready) { Say "0003 check: $acct / $ready"; return @{ Ok = $true; Text = 'No sign-in needed: the local account is in and its data loaded.' } }
      if ($bad -and ((Get-Date) - $t0).TotalSeconds -gt 45) { Say "0003 check FAILED: $bad"; return @{ Ok = $false; Text = "The no-sign-in check failed. From the log: $bad" } }
    }
    Start-Sleep -Seconds 3
  }
  Say '0003 check: no local-account or Core session line within 90 s'
  return @{ Ok = $false; Text = "Could not confirm the no-sign-in change within 90 s. Log: $log" }
}

function Add-History([hashtable]$entry) {
  $list = @()
  if (Test-Path -LiteralPath $histF) { try { $list = @(Get-Content -LiteralPath $histF -Raw | ConvertFrom-Json) } catch { $list = @() } }
  $list = @($list) + @([pscustomobject]$entry)
  if ($list.Count -gt 50) { $list = $list[($list.Count - 50)..($list.Count - 1)] }
  ConvertTo-Json -InputObject $list -Depth 4 | Set-Content -LiteralPath $histF -Encoding utf8
}

# A name for an archive: stock AionUi, or an AionDX build by hash, with when it was built.
function Describe([string]$path, [string]$hash) {
  if (-not $hash) { return $null }
  if ($hash -eq $script:stockHash) { return "stock AionUi $script:appVersion" }
  $when = (Get-Item -LiteralPath $path).LastWriteTime.ToString('MMM d, HH:mm')
  return "AionDX build $(Short $hash) (built $when)"
}

# The menu. Returns the chosen action, or 'Cancel'. With -MenuPreview it draws the form to a PNG
# without showing it on screen, for checking the layout.
function Show-Menu([string]$title, [string]$status, [object[]]$buttons) {
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $f = New-Object System.Windows.Forms.Form
  $f.Text = $title
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $f.Padding = New-Object System.Windows.Forms.Padding(16)
  $f.Tag = 'Cancel'
  $panel = New-Object System.Windows.Forms.FlowLayoutPanel
  $panel.FlowDirection = 'TopDown'; $panel.WrapContents = $false
  $panel.AutoSize = $true; $panel.AutoSizeMode = 'GrowAndShrink'
  $panel.Location = New-Object System.Drawing.Point(16, 14)
  $f.Controls.Add($panel)
  $label = New-Object System.Windows.Forms.Label
  $label.AutoSize = $true
  $label.MaximumSize = New-Object System.Drawing.Size(480, 0)
  $label.Text = $status
  $label.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 12)
  $panel.Controls.Add($label)
  foreach ($b in $buttons) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $b.Text
    $btn.Enabled = [bool]$b.Enabled
    $btn.Tag = $b.Action
    $btn.Size = New-Object System.Drawing.Size(480, 36)
    $btn.TextAlign = 'MiddleLeft'
    $btn.Padding = New-Object System.Windows.Forms.Padding(8, 0, 0, 0)
    $btn.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 6)
    $btn.Add_Click({ param($sender, $e) $form = $sender.FindForm(); $form.Tag = $sender.Tag; $form.Close() })
    $panel.Controls.Add($btn)
    if ($b.Action -eq 'Cancel' -or $b.Action -eq 'Leave') { $f.CancelButton = $btn }
  }
  if ($MenuPreview) {
    $f.ShowInTaskbar = $false; $f.Opacity = 0
    $f.Show(); [System.Windows.Forms.Application]::DoEvents()
    $bmp = New-Object System.Drawing.Bitmap($f.Width, $f.Height)
    $f.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $f.Width, $f.Height)))
    $bmp.Save($MenuPreview, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $f.Close()
    return 'Cancel'
  }
  [void]$f.ShowDialog()
  return [string]$f.Tag
}

function Remove-SelfTask {
  if ($Detached) { try { Unregister-ScheduledTask -TaskName $selfTask -Confirm:$false -ErrorAction Stop } catch { } }
}

# Stops a waiter left by an earlier install, so it cannot swap its staged build in later.
function Stop-Waiter {
  if (-not ((Test-Path -LiteralPath $stateF) -and ((Get-Content -LiteralPath $stateF -Raw).Trim() -eq 'WAITING'))) { return }
  Set-Content -LiteralPath $stopF -Value 'stop'
  $t0 = Get-Date
  while ((Test-Path -LiteralPath $stopF) -and ((Get-Date) - $t0).TotalSeconds -lt 6) { Start-Sleep -Milliseconds 200 }
  if (Test-Path -LiteralPath $stopF) { Remove-Item -LiteralPath $stopF -Force; Say 'no waiter answered the stop file; none was running' }
  else { Say 'stopped the earlier install waiter' }
}

# AionCore (2026-09-26): AionDX's own build of the installed AionCore (tools\build-aioncore.ps1 -Patched, with
# vendor\aioncore\aioncore.json naming the stock binary it replaces). It goes in only over that stock binary or
# over an earlier AionDX build of it (the stock one then sits in aioncore.exe.stock), never over another
# AionCore: after AionUi updates itself, the build has to be made again for the new version.
function Get-CoreSource([string]$what) {
  if (-not (Test-Path -LiteralPath $coreLive)) { return $null }
  $liveCore = Get-Hash $coreLive
  if ($what -eq 'Install') {
    if (-not (Test-Path -LiteralPath $coreBuilt) -or -not (Test-Path -LiteralPath $coreRecF)) { return $null }
    $rec = Get-Content -LiteralPath $coreRecF -Raw | ConvertFrom-Json
    $builtHash = Get-Hash $coreBuilt
    if ($builtHash -ne ([string]$rec.sha256).ToUpperInvariant()) { Say 'AionCore: vendor\aioncore\aioncore.exe does not match its record; left as it is'; return $null }
    if ($liveCore -eq $builtHash) { return $null }
    $stockOk = ([string]$rec.stockSha256).ToUpperInvariant()
    $backup = if (Test-Path -LiteralPath $coreStockF) { Get-Hash $coreStockF } else { '' }
    if ($stockOk -and ($liveCore -eq $stockOk -or $backup -eq $stockOk)) { return $coreBuilt }
    Say "AionCore: the installed aioncore.exe is neither the stock $($rec.tag) binary nor an AionDX build of it (AionUi updated?); AionDX's build stays out until it is made for this version"
    return $null
  }
  if ($what -eq 'Rollback' -and (Test-Path -LiteralPath $corePrevF) -and (Get-Hash $corePrevF) -ne $liveCore) { return $corePrevF }
  if ($what -eq 'Stock' -and (Test-Path -LiteralPath $coreStockF) -and (Get-Hash $coreStockF) -ne $liveCore) { return $coreStockF }
  return $null
}

# One UAC prompt; elevated_copy.ps1 stages $source (and an aioncore.exe) and swaps them in. The live files become .prev.
function Invoke-ElevatedSwap([string]$source, [bool]$refreshStock, [string]$coreSource = '', [bool]$noAsar = $false) {
  if (Test-Path -LiteralPath $stateF) { Remove-Item -LiteralPath $stateF -Force }
  $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Source "{1}"{2}{3}{4}' -f `
    (Join-Path $tools 'elevated_copy.ps1'), $source, $(if ($refreshStock) { ' -RefreshStock' } else { '' }),
    $(if ($coreSource) { ' -CoreSource "' + $coreSource + '"' } else { '' }), $(if ($noAsar) { ' -NoAsar' } else { '' })
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $argLine -Wait
  } catch {
    throw "the Windows permission prompt was declined or failed ($($_.Exception.Message)); nothing was changed"
  }
  $st = if (Test-Path -LiteralPath $stateF) { (Get-Content -LiteralPath $stateF -Raw).Trim() } else { 'no state reported' }
  if ($st -ne 'SWAPPED') { throw "the installer reported '$st'; see vendor\install.log" }
}

# Carries out one action end to end, AionUi closed by the caller. Returns a result line.
function Invoke-Action([string]$what) {
  $refresh = $false
  switch ($what) {
    'Install'  { $source = $patched; $refresh = $script:appUpdated }
    'Rollback' { $source = $prevF }
    'Stock'    { $source = $stock }
  }
  if (-not (Test-Path -LiteralPath $source)) { throw "nothing to $($what.ToLower()) from: $source is missing" }
  $sourceHash = Get-Hash $source
  $before = Get-Hash $live
  $label = Describe $source $sourceHash
  $coreSource = Get-CoreSource $what
  $coreExpect = if ($coreSource) { Get-Hash $coreSource } else { '' }
  $coreBefore = if (Test-Path -LiteralPath $coreLive) { Get-Hash $coreLive } else { '' }
  if ($before -eq $sourceHash -and -not $coreSource) {
    Say "$what`: $label is already installed; no swap needed"
  } else {
    $asarToo = $before -ne $sourceHash
    Say ("$what`: swapping in " + $(if ($asarToo) { $label } else { 'no new app.asar' }) + $(if ($coreSource) { " and aioncore.exe $(Short $coreExpect) from $(Split-Path $coreSource -Leaf)" } else { '' }))
    Invoke-ElevatedSwap $source $refresh $coreSource (-not $asarToo)
    if ($asarToo) {
      $after = Get-Hash $live
      Say ('installed file matches {0}: {1}' -f $label, ($after -eq $sourceHash))
      if ($after -ne $sourceHash) { throw "the installed app.asar does not match $label; see vendor\install.log" }
    }
    if ($coreSource) {
      $coreAfter = Get-Hash $coreLive
      Say ('installed aioncore.exe matches {0}: {1}' -f (Short $coreExpect), ($coreAfter -eq $coreExpect))
      if ($coreAfter -ne $coreExpect) { throw "the installed aioncore.exe does not match $(Short $coreExpect); see vendor\install.log" }
    }
    Add-History @{ at = (Get-Date).ToString('s'); action = $what; installed = (Short $sourceHash); label = $label; replaced = (Short $before);
      core = (Short $(if ($coreSource) { $coreExpect } else { $coreBefore })); coreReplaced = (Short $coreBefore) }
  }
  Install-SetupSkill $what
  return $label
}

# Patches 0004 and 0007: the aiondx-setup and aiondx-loop skills live in AionUi's
# builtin-skills\auto-inject, which a backend version change rewrites. Put them back after every
# swap, before AionUi reopens, so the backend's startup scan sees them. A revert to stock takes the
# skills out, so stock really is stock; 0007's programs and MCP row stay (outside the app, harmless:
# nothing runs the Loop in a stock build, and the tool says so).
function Install-SetupSkill([string]$what) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  $jobs = @(
    @{ label = 'setup skill'; js = (Join-Path $root 'patches\0004-setup-butler\install.js'); arg = $(if ($what -eq 'Stock') { '--remove' } else { '' }) },
    @{ label = 'loop tool';   js = (Join-Path $root 'patches\0007-loop-tool\install.js');    arg = $(if ($what -eq 'Stock') { '--remove-skill' } else { '--no-register' }) }
  )
  foreach ($j in $jobs) {
    if (-not (Test-Path -LiteralPath $j.js) -or -not (Test-Path -LiteralPath $node)) { Say "$($j.label): installer or node missing; skipped"; continue }
    try {
      $out = & $node $j.js $j.arg 2>&1 | Out-String
      Say ("$($j.label): " + $out.Trim())
    } catch { Say "$($j.label): failed ($($_.Exception.Message)); the rest of the update is unaffected" }
  }
}

$closedApp = $false
$mutex = New-Object System.Threading.Mutex($false, 'Local\AionDXApplyUpdate')
try {
  if (-not $DryRun) {
    # A copy killed while it held the lock leaves it abandoned; the next WaitOne then throws but
    # still hands over ownership, which is exactly what should happen.
    $owned = $false
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { [void](Box 'The AionDX updater is already open.'); exit 0 }
  }
  Log ('=== apply requested: {0}{1}{2} ===' -f $Action, $(if ($DryRun) { ' (dry run)' } else { '' }), $(if ($Detached) { ' (via Task Scheduler)' } else { '' }))

  # Inside AionUi, closing the app would kill this script midway. Hand off instead.
  if (-not $DryRun -and -not $Detached -and (Test-InsideAionUi)) {
    $vbs = Join-Path $tools 'aiondx-apply.vbs'
    $argv = '"{0}" -Detached -Action {1}' -f $vbs, $Action
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $argv
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $selfTask -Action $taskAction -Settings $settings -Force `
      -Description 'AionDX: one-shot hand-off of aiondx-apply.ps1 out of AionUi''s job object. Deletes itself when done.' | Out-Null
    Start-ScheduledTask -TaskName $selfTask
    Say "Started from inside AionUi, which would kill this script when it closes the app. Handed off to Task Scheduler task '$selfTask'. Its window will appear on the desktop."
    exit 0
  }

  # 1. Where things stand.
  if (-not (Test-Path -LiteralPath $live)) { throw "no installed app.asar at $live" }
  $script:appVersion = ((Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion -split '\.')[0..2] -join '.'
  $liveHash    = Get-Hash $live
  $script:stockHash = if (Test-Path -LiteralPath $stock) { Get-Hash $stock } else { '' }
  $prevHash    = if (Test-Path -LiteralPath $prevF) { Get-Hash $prevF } else { '' }
  $markers     = Get-LiveMarkers
  $livePatched = $markers.Loop
  $script:appUpdated = (-not $livePatched) -and ($script:stockHash -ne '') -and ($liveHash -ne $script:stockHash)
  $newestSrc   = $patchSources | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTime } | Sort-Object -Descending | Select-Object -First 1
  $sourceNewer = (Test-Path -LiteralPath $patched) -and ($newestSrc -gt (Get-Item -LiteralPath $patched).LastWriteTime)
  $needBuild   = (-not (Test-Path -LiteralPath $patched)) -or $sourceNewer -or $script:appUpdated
  $patchedHash = if (Test-Path -LiteralPath $patched) { Get-Hash $patched } else { '' }
  $current     = (-not $needBuild) -and ($liveHash -eq $patchedHash)
  $running     = [bool](Get-Process -Name 'AionUi' -ErrorAction SilentlyContinue)

  $liveLabel  = if ($liveHash -eq $script:stockHash) { "stock AionUi $script:appVersion" } elseif ($livePatched) { "AionDX build $(Short $liveHash)" } else { "AionUi $script:appVersion, a new stock version" }
  $readyLabel = if ($needBuild) { 'a new AionDX build (built when you choose Install)' } else { Describe $patched $patchedHash }
  $prevLabel  = if ($prevHash) { Describe $prevF $prevHash } else { $null }
  Say ('installed: {0}; ready: {1}; previous: {2}; stock: {3}' -f $liveLabel, $readyLabel, $(if ($prevLabel) { $prevLabel } else { 'none' }), $(if ($script:stockHash) { "AionUi $script:appVersion" } else { 'none' }))
  Say ('rebuild needed: {0} (patch source newer: {1}; AionUi updated itself: {2}); AionUi running: {3}' -f $needBuild, $sourceNewer, $script:appUpdated, $running)

  $canInstall  = -not $current
  $canRollback = [bool]$prevHash -and ($prevHash -ne $liveHash)
  $canStock    = [bool]$script:stockHash -and ($script:stockHash -ne $liveHash)

  # 2. Choose.
  if ($Action -eq 'Menu' -or $MenuPreview) {
    $status = "Installed now: $liveLabel`n" +
      $(if ($canInstall) { "Ready to install: $readyLabel`n" } else { "Installed is the newest AionDX build.`n" }) +
      $(if ($prevLabel) { "Previous: $prevLabel`n" } else { '' }) +
      "`nEach choice closes AionUi, which ends every agent session, then reopens it and checks that it started."
    $buttons = @(
      @{ Text = $(if ($canInstall) { 'Install the new AionDX build' } else { 'Install the new AionDX build (already installed)' }); Enabled = $canInstall; Action = 'Install' },
      @{ Text = $(if ($prevLabel) { "Roll back to the previous build: $prevLabel" } else { 'Roll back to the previous build (none saved)' }); Enabled = $canRollback; Action = 'Rollback' },
      @{ Text = $(if ($script:stockHash) { "Revert to stock AionUi $script:appVersion, without AionDX" } else { 'Revert to stock AionUi (no stock copy saved)' }); Enabled = $canStock; Action = 'Stock' },
      @{ Text = 'Cancel'; Enabled = $true; Action = 'Cancel' }
    )
    if ($DryRun) {
      Say ('menu: install {0}, roll back {1}, revert to stock {2}' -f $(if ($canInstall) { 'enabled' } else { 'disabled' }), $(if ($canRollback) { 'enabled' } else { 'disabled' }), $(if ($canStock) { 'enabled' } else { 'disabled' }))
      if ($MenuPreview) { [void](Show-Menu 'AionDX' $status $buttons); Say "menu drawn to $MenuPreview" }
      Say ('PLAN, any choice: {0}close AionUi (ends every agent session), swap with one UAC prompt, verify, reopen, check it started.' -f $(if ($needBuild) { 'Install rebuilds first; ' } else { '' }))
      exit 0
    }
    $Action = Show-Menu 'AionDX' $status $buttons
    if ($Action -eq 'Cancel') { Say 'menu closed without a choice'; Remove-SelfTask; exit 0 }
  } elseif ($DryRun) {
    Say "PLAN: $Action. Close AionUi (ends every agent session), swap with one UAC prompt, verify, reopen, check it started."
    exit 0
  }
  if ($Action -eq 'Install' -and $current) { Say 'Nothing to install: the newest build is already live.'; [void](Box 'The installed AionUi already has the newest AionDX build.'); Remove-SelfTask; exit 0 }
  if ($Action -eq 'Rollback' -and -not $canRollback) { throw 'there is no previous build different from the installed one' }
  if ($Action -eq 'Stock' -and -not $canStock) { throw 'stock AionUi is already installed, or there is no stock copy' }

  # 3. Stop an earlier waiter so two swaps cannot race.
  Stop-Waiter

  # 4. Rebuild while AionUi is still open; it only reads the live archive.
  if ($Action -eq 'Install' -and $needBuild) {
    Say 'rebuilding vendor\app.asar.patched'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools 'do_patch.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $patched)) { throw 'rebuild failed; run tools\do_patch.ps1 by hand to see why' }
  }

  # 5. Close AionUi, swap, verify.
  $closedApp = Close-AionUi
  $label = Invoke-Action $Action

  # 6. Reopen and check it started; offer a way back once if it did not.
  $reopenedAt = Get-Date
  Open-AionUi
  $started = Test-Started
  if (-not $started) {
    $prevNow = if (Test-Path -LiteralPath $prevF) { Describe $prevF (Get-Hash $prevF) } else { $null }
    $fallback = Show-Menu 'AionDX: AionUi did not start' ("AionUi did not start after installing $label.`n`nChoose a way back. Each closes whatever is left of AionUi first.") @(
      @{ Text = $(if ($prevNow) { "Roll back to $prevNow" } else { 'Roll back (no previous build saved)' }); Enabled = [bool]$prevNow; Action = 'Rollback' },
      @{ Text = "Revert to stock AionUi $script:appVersion, without AionDX"; Enabled = [bool]$script:stockHash; Action = 'Stock' },
      @{ Text = 'Leave it as it is'; Enabled = $true; Action = 'Leave' }
    )
    if ($fallback -eq 'Leave' -or $fallback -eq 'Cancel') {
      Say 'AionUi did not start; the owner chose to leave it'
      [void](Box "AionUi did not start after installing $label.`n`nDouble-click AionDX Apply Update again to roll back or revert. Log: $logFile" 'OK' 'Warning')
      Remove-SelfTask
      exit 1
    }
    [void](Close-AionUi)
    $label2 = Invoke-Action $fallback
    Open-AionUi
    $started2 = Test-Started
    Say ('after the fallback to {0}, AionUi started: {1}' -f $label2, $started2)
    [void](Box $(if ($started2) { "AionUi did not start with $label, so it was replaced by $label2, which started.`n`nLog: $logFile" } else { "AionUi did not start with $label, nor with $label2.`n`nReinstalling AionUi from its installer restores it. Log: $logFile" }) 'OK' 'Warning')
    Remove-SelfTask
    exit $(if ($started2) { 0 } else { 1 })
  }

  $extra = ''
  $nowMarkers = Get-LiveMarkers
  if ($nowMarkers.NoSignIn) {
    $acct = Test-LocalAccount $reopenedAt
    $extra = "`n`n" + $acct.Text
    if (-not $acct.Ok) { $extra += "`nIf AionUi shows a sign-in page, double-click AionDX Apply Update and roll back." }
  }
  $done = switch ($Action) {
    'Install'  { "Installed $label and reopened AionUi." }
    'Rollback' { "Rolled back to $label and reopened AionUi." }
    'Stock'    { "Reverted to $label, without AionDX, and reopened AionUi." }
  }
  [void](Box ($done + $extra))
  Remove-SelfTask
  exit 0
} catch {
  $err = $_.Exception.Message
  Log "FAILED: $err"
  if ($closedApp) { try { Open-AionUi } catch { Log "could not reopen AionUi: $($_.Exception.Message)" } }
  [void](Box "That did not complete:`n`n$err`n`nAionUi has been reopened if it was closed. Log: $logFile" 'OK' 'Warning')
  Remove-SelfTask
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
