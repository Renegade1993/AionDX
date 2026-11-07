<#
  install.ps1 - puts AionDX and everything exported with it onto this PC, for the Windows account that runs it. Run it through install.bat.

    install.bat               do everything, asking before anything is replaced or closed
    install.bat -DryRun       show what would happen, change nothing
    install.bat -Yes          no questions (closes AionDX, its backend and Claude Code if they are running)
    install.bat -SkipRedist   leave Visual C++, Git, Node and Python alone
    install.bat -SkipApp      do not run the AionDX installer
    install.bat -SkipData     do not restore the data
    install.bat -TestRoot D   restore into folder D as if D\home were the user folder (for testing): no redist, no app, no PATH or variables

  The account does not have to have the same name as the one the export was made on: every stored path that pointed into the old user
  folder is rewritten to this account's (tools\rehome.js), in settings files, the AionDX database and Claude Code's folders.
  Nothing is deleted. A folder that is replaced is renamed to "<name>.pre-restore-<time>" beside the new one; Claude Code transcripts
  that were only in the old folder are moved into the new one, so no history is lost in either direction.
  The full log is logs\install-<time>.log in this folder.
#>
param(
  [switch]$DryRun, [switch]$Yes, [switch]$SkipRedist, [switch]$SkipApp, [switch]$SkipData,
  [string]$TestRoot = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pkg = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force (Join-Path $pkg 'logs') | Out-Null
$logFile = Join-Path $pkg ('logs\install-' + $stamp + $(if ($DryRun) { '-dry' }) + '.log')
try { Start-Transcript -LiteralPath $logFile -Force | Out-Null } catch { }
$problems = New-Object System.Collections.ArrayList
function Say($m, $c) { $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m; if ($c) { Write-Host $line -ForegroundColor $c } else { Write-Host $line } }
function Warn($m) { Say $m 'Yellow'; [void]$problems.Add($m) }
function Ask($q) { if ($Yes -or $DryRun) { return $true }; $a = Read-Host "$q [y/N]"; return ($a -match '^(y|yes)$') }
function Stop-Here($m) { Say $m 'Red'; try { Stop-Transcript | Out-Null } catch { }; exit 1 }

try {
if ($TestRoot) {
  $TestRoot = [IO.Path]::GetFullPath($TestRoot)
  $HOMEDIR = Join-Path $TestRoot 'home'; $APPDATA_ = Join-Path $HOMEDIR 'AppData\Roaming'; $LOCAL_ = Join-Path $HOMEDIR 'AppData\Local'
  New-Item -ItemType Directory -Force $HOMEDIR, $APPDATA_, $LOCAL_ | Out-Null
  $SkipRedist = $true; $SkipApp = $true
} else { $HOMEDIR = $env:USERPROFILE; $APPDATA_ = $env:APPDATA; $LOCAL_ = $env:LOCALAPPDATA }
function Expand-Token($p) { return ([string]$p).Replace('{APPDATA}', $APPDATA_).Replace('{LOCALAPPDATA}', $LOCAL_).Replace('{HOME}', $HOMEDIR) }

Say ('AionDX install from ' + $pkg + $(if ($DryRun) { '  (DRY RUN: nothing will change)' }) + $(if ($TestRoot) { "  (TEST ROOT $TestRoot)" })) 'Cyan'
Say ("This account: {0}, user folder {1}" -f $env:USERNAME, $HOMEDIR)
if (Test-Path (Join-Path $pkg 'data\EXPORT-IN-PROGRESS')) { Stop-Here 'The data in this package is from an export that did not finish. Run export.bat again on the PC it came from.' }
$manifestFile = Join-Path $pkg 'MANIFEST.json'
if (-not (Test-Path $manifestFile)) { Stop-Here 'MANIFEST.json is missing: this folder is not a finished export.' }
$m = Get-Content $manifestFile -Raw | ConvertFrom-Json
Say ("Export made {0} on {1}, from the user folder {2}." -f $m.createdAt, $m.computer, $m.home)
$rehome = ($m.home -and ($m.home.ToLower() -ne $HOMEDIR.ToLower()))
if ($rehome) { Say ("Paths that pointed into {0} will be rewritten to {1}." -f $m.home, $HOMEDIR) 'Cyan' }

# ---------------------------------------------------------------- checks
if (-not [Environment]::Is64BitOperatingSystem) { Stop-Here 'AionDX needs 64-bit Windows.' }
$need = ($m.components | Measure-Object bytes -Sum).Sum
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($HOMEDIR).Substring(0, 1))
Say ("Data to restore: {0:N1} GB; free on {1}: {2:N1} GB." -f ($need / 1GB), $drive.Name, ($drive.Free / 1GB))
if ($drive.Free -lt ($need + 4GB)) { Stop-Here 'Not enough free disk space (the data plus 4 GB).' }

function Busy() {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and (
      $_.Name -in @('AionDX.exe', 'AionUi.exe', 'aioncore.exe', 'aiondx-loop.exe') -or
      ($_.Name -in @('claude.exe', 'node.exe') -and [string]$_.CommandLine -match '(?i)\\\.claude|claude-code|claude-agent-acp|AionUi|aiondx'))
  }
}
if (-not $TestRoot) {
  $run = @(Busy)
  if ($run.Count) {
    Say ('Running now and using these folders: ' + (($run | Select-Object -ExpandProperty Name -Unique) -join ', ')) 'Yellow'
    if (-not (Ask 'Close AionDX, its backend and Claude Code?')) { Stop-Here 'Close AionDX and Claude Code first, then run this again.' }
    if (-not $DryRun) { $run | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }; Start-Sleep -Seconds 3 }
  }
}

function Verify-Signed($file, $pattern) {
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch $pattern) { Stop-Here ("{0} does not carry a valid signature from {1} (status {2})." -f (Split-Path $file -Leaf), $pattern, $sig.Status) }
}

# ---------------------------------------------------------------- redistributables
if (-not $SkipRedist) {
  Say '--- Visual C++, Git, Node.js, Python' 'Cyan'
  $redist = Join-Path $pkg 'redist'
  $jobs = @()
  $vc = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
  if ($vc -and $vc.Installed -eq 1 -and $vc.Minor -ge 40) { Say ("Visual C++ runtime {0}.{1} is installed." -f $vc.Major, $vc.Minor) } else { $jobs += @{ name = 'Visual C++ runtime'; file = 'VC_redist.x64.exe'; args = '/install /quiet /norestart'; pattern = 'Microsoft'; ok = @(0, 1638, 1641, 3010) } }
  if ((Test-Path "$env:ProgramFiles\Git\cmd\git.exe") -or (Get-Command git -ErrorAction SilentlyContinue)) { Say 'Git is installed.' } else { $jobs += @{ name = 'Git for Windows'; file = 'Git-2.56.0.3-64-bit.exe'; args = '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES'; pattern = 'Schindelin'; ok = @(0) } }
  if ((Test-Path "$env:ProgramFiles\nodejs\node.exe") -or (Get-Command node -ErrorAction SilentlyContinue)) { Say 'Node.js is installed.' } else { $jobs += @{ name = 'Node.js'; file = 'node-v24.16.0-x64.msi'; args = '/qn /norestart'; msi = $true; pattern = 'OpenJS'; ok = @(0, 3010) } }
  if ((Get-Command py -ErrorAction SilentlyContinue) -or (Test-Path "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")) { Say 'Python is installed.' } else { $jobs += @{ name = 'Python 3.12'; file = 'python-3.12.7-amd64.exe'; args = '/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1'; pattern = 'Python Software Foundation'; ok = @(0, 3010) } }
  foreach ($j in $jobs) { $j.path = Join-Path $redist $j.file; if (-not (Test-Path $j.path)) { Stop-Here ("{0} is missing from the redist folder." -f $j.file) }; Verify-Signed $j.path $j.pattern; Say ("Will install {0} ({1}, signature checked)." -f $j.name, $j.file) }
  if ($jobs.Count -and -not $DryRun) {
    $resultFile = Join-Path $env:TEMP ('aiondx-redist-' + $stamp + '.txt')
    $lines = @('$ErrorActionPreference = "Continue"')
    foreach ($j in $jobs) {
      if ($j.msi) { $lines += ('$p = Start-Process msiexec.exe -ArgumentList ''/i "{0}" {1}'' -Wait -PassThru' -f $j.path, $j.args) }
      else { $lines += ('$p = Start-Process -FilePath "{0}" -ArgumentList ''{1}'' -Wait -PassThru' -f $j.path, $j.args) }
      $lines += ('Add-Content "{0}" ("{1}=" + $p.ExitCode)' -f $resultFile, $j.name)
    }
    $elev = Join-Path $env:TEMP ('aiondx-redist-' + $stamp + '.ps1')
    Set-Content -LiteralPath $elev -Value $lines -Encoding UTF8
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $elev } else { Say 'Windows will ask for permission once, to install these.'; Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $elev + '"')) }
    $res = if (Test-Path $resultFile) { Get-Content $resultFile } else { @() }
    foreach ($j in $jobs) {
      $line = $res | Where-Object { $_ -like ($j.name + '=*') } | Select-Object -First 1
      $code = if ($line) { [int]($line -replace '^.*=', '') } else { -1 }
      if ($j.ok -contains $code) { Say ("{0}: done (code {1})." -f $j.name, $code) 'Green' } else { Warn ("{0} did not finish (code {1}). Install it by hand from the redist folder." -f $j.name, $code) }
    }
    Remove-Item -LiteralPath $elev, $resultFile -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- AionDX
if (-not $SkipApp) {
  Say '--- AionDX' 'Cyan'
  $setup = Get-ChildItem (Join-Path $pkg 'installers') -Filter 'AionDX-*-setup.exe' | Sort-Object Name | Select-Object -Last 1
  if (-not $setup) { Stop-Here 'No AionDX-*-setup.exe in the installers folder.' }
  $pkgVer = [version](($setup.Name -replace '^AionDX-', '') -replace '-setup\.exe$', '')
  $installed = $null
  try { $installed = [version]((Get-Content (Join-Path $LOCAL_ 'AionDX\install.json') -Raw | ConvertFrom-Json).product.version) } catch { }
  if ($installed -and $installed -ge $pkgVer -and (Test-Path (Join-Path $LOCAL_ 'Programs\AionDX\AionDX.exe'))) { Say ("AionDX {0} is installed, the package has {1}: left as it is." -f $installed, $pkgVer) }
  else {
    $sums = Join-Path $pkg 'installers\SHA256SUMS.txt'
    if (Test-Path $sums) {
      $want = (Get-Content $sums | Where-Object { $_ -match [regex]::Escape($setup.Name) } | Select-Object -First 1) -replace '\s.*$', ''
      $got = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLower()
      if ($want -and $want.ToLower() -ne $got) { Stop-Here ("{0} does not match SHA256SUMS.txt." -f $setup.Name) }
      Say ("{0} matches SHA256SUMS.txt." -f $setup.Name)
    }
    Say ("Installing {0} for this user (no administrator rights needed)." -f $setup.Name)
    if (-not $DryRun) {
      $p = Start-Process -FilePath $setup.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $pkg ('logs\aiondx-setup-' + $stamp + '.log')) + '"') -Wait -PassThru
      if ($p.ExitCode -ne 0 -or -not (Test-Path (Join-Path $LOCAL_ 'Programs\AionDX\AionDX.exe'))) { Stop-Here ("The AionDX installer ended with code {0} (its log is in logs\)." -f $p.ExitCode) }
      Say 'AionDX is installed.' 'Green'
      Start-Sleep -Seconds 2
      @(Busy) | Where-Object { $_.Name -in @('AionDX.exe', 'aioncore.exe') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
    }
  }
}

# ---------------------------------------------------------------- a Node.js that has node:sqlite (AionDX's own first)
function Find-Node {
  $c = @()
  $c += Get-ChildItem (Join-Path $LOCAL_ 'Programs\AionDX\resources\bundled-aioncore\win32-x64\managed-resources\node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  $c += Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs\AionDX\resources\bundled-aioncore\win32-x64\managed-resources\node') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  $c += "$env:ProgramFiles\nodejs\node.exe"
  $g = Get-Command node -ErrorAction SilentlyContinue; if ($g) { $c += $g.Source }
  foreach ($n in $c) { if ($n -and (Test-Path $n)) { & cmd.exe /d /c ('"' + $n + '" -e "require(''node:sqlite'')" >nul 2>nul'); if ($LASTEXITCODE -eq 0) { return $n } } }
  return $null
}
# Windows PowerShell turns a native program's stderr into errors, which $ErrorActionPreference = 'Stop' makes fatal: run Node through cmd.
function Run-Node($node, [string[]]$nargs) {
  $q = ($nargs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $errFile = Join-Path $env:TEMP ('aiondx-node-' + [guid]::NewGuid().ToString('n') + '.err')
  $out = & cmd.exe /d /c ('"' + $node + '" ' + $q + ' 2>"' + $errFile + '"')
  $err = if (Test-Path $errFile) { Get-Content $errFile -Raw; Remove-Item $errFile -ErrorAction SilentlyContinue } else { '' }
  $code = $LASTEXITCODE
  if ($null -eq $err) { $err = '' }
  return @{ out = @($out); err = [string]$err; code = $code }
}

# ---------------------------------------------------------------- data
$restored = @()
if (-not $SkipData) {
  Say '--- your data' 'Cyan'
  $newerIds = @('local-AionDX')                              # the installer just wrote the current program files here: only newer files are copied
  $tops = @($m.components | Where-Object { $_.id -notmatch '/' -and -not $_.database })
  foreach ($c in $tops) {
    $src = Join-Path $pkg ('data\' + $c.id)
    if (-not (Test-Path $src)) { Say ("skip {0}: nothing exported" -f $c.id); continue }
    $dest = Expand-Token $c.restoreTo
    # an account home (claude-<name>-home) is a folder of links: its files are laid over and nothing is renamed
    $mode = if ($c.restoreTo -eq '{HOME}') { 'files' } elseif ($c.id -match '-home$') { 'overlay' } elseif ($newerIds -contains $c.id) { 'newer' } else { 'replace' }
    Say ("{0,-18} {1,8:N0} files {2,8:N0} MB  ->  {3}  [{4}]" -f $c.id, $c.files, ($c.bytes / 1MB), $dest, $mode)
    if ($DryRun) { continue }
    $old = $null
    if ($mode -eq 'replace' -and (Test-Path -LiteralPath $dest)) {
      $old = $dest + '.pre-restore-' + $stamp
      try { Rename-Item -LiteralPath $dest -NewName (Split-Path $old -Leaf) -ErrorAction Stop; Say ("    the folder that was there is kept as {0}" -f (Split-Path $old -Leaf)) }
      catch { Warn ("    {0} is in use and could not be set aside; the package is laid over it instead ({1})" -f $dest, $_.Exception.Message); $old = $null; $mode = 'overlay' }
    }
    New-Item -ItemType Directory -Force $dest | Out-Null
    if ($mode -eq 'files') {
      foreach ($f in Get-ChildItem -LiteralPath $src -File -Force) {
        $t = Join-Path $dest $f.Name
        if (Test-Path -LiteralPath $t) { Copy-Item -LiteralPath $t -Destination ($t + '.pre-restore-' + $stamp) -Force }
        Copy-Item -LiteralPath $f.FullName -Destination $t -Force
      }
    } else {
      $flags = @('/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XJ', '/MT:16')
      if ($mode -eq 'newer') { $flags += '/XO' }
      & robocopy.exe $src $dest @flags | Out-Null
      if ($LASTEXITCODE -ge 8) { Warn ("    robocopy reported problems (code {0}) for {1}" -f $LASTEXITCODE, $c.id) }
    }
    $restored += [pscustomobject]@{ id = $c.id; dest = $dest; old = $old; mode = $mode }
  }
  $dbc = $m.components | Where-Object { $_.database } | Select-Object -First 1
  $dbDest = if ($dbc) { Expand-Token $dbc.restoreTo } else { $null }
  if ($dbc -and -not $DryRun) {
    $dbSrc = Join-Path $pkg 'data\roaming-AionUi\aionui\aionui-backend.db'
    Copy-Item -LiteralPath $dbSrc -Destination $dbDest -Force
    foreach ($x in '-wal', '-shm') { Remove-Item -LiteralPath ($dbDest + $x) -ErrorAction SilentlyContinue }
  }

  # paths into the old user folder -> this account's
  if ($rehome) {
    Say '--- pointing stored paths at this account' 'Cyan'
    $node = Find-Node
    if (-not $node) { Warn 'No Node.js with node:sqlite was found, so paths were not rewritten. Run tools\rehome.js later (see AGENT-GUIDE.md).' }
    else {
      Say ("Node.js for this step: {0}" -f $node)
      $rargs = @((Join-Path $pkg 'tools\rehome.js'), '--from', $m.home, '--to', $HOMEDIR)
      foreach ($r in $restored) { if ($r.mode -ne 'files') { $rargs += @('--root', $r.dest) } }
      foreach ($f in @('.claude.json', '.gitconfig')) { if (Test-Path (Join-Path $HOMEDIR $f)) { $rargs += @('--root-file', (Join-Path $HOMEDIR $f)) } }
      if ($dbDest) { $rargs += @('--db', $dbDest) }
      if ($DryRun) { $rargs += '--dry' }
      $rn = Run-Node $node $rargs
      $out = $rn.out
      $nodeSaid = (([string]$rn.err) -replace 'ExperimentalWarning: SQLite is an experimental feature and might change at any time', '' -replace '\(Use `node --trace-warnings[^)]*\)', '' -replace '\(node:\d+\)', '' -replace '\s+', ' ').Trim()
      if ($nodeSaid) { Say ('    (Node said: ' + $nodeSaid.Substring(0, [Math]::Min(300, $nodeSaid.Length)) + ')') }
      $sum = $null; try { $sum = ($out | Select-Object -Last 1) | ConvertFrom-Json } catch { }
      if ($sum) {
        Say ("Rewrote {0} files ({1} large ones line by line) and {2} database values; renamed {3} Claude Code folders; {4} s." -f $sum.filesChanged, $sum.bigFilesChanged, $sum.dbValuesChanged, $sum.foldersRenamed, $sum.seconds) 'Green'
        foreach ($e in @($sum.errors)) { if ($e) { Warn ("    rehome: {0}" -f $e) } }
      } else { Warn ('rehome.js did not report: ' + (($out | Select-Object -Last 5) -join ' | ')) }
    }
  }

  # transcripts that only the replaced folder had: moved into the new one
  foreach ($r in $restored) {
    if (-not $r.old -or $r.id -notmatch '^claude') { continue }
    $op = Join-Path $r.old 'projects'; $np = Join-Path $r.dest 'projects'
    if (-not (Test-Path $op)) { continue }
    & robocopy.exe $op $np /E /MOV /XC /XN /XO /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XJ | Out-Null
    Say ("    {0}: transcripts that only the earlier folder had were moved into the restored one" -f $r.id)
  }

  Say '--- links between profile folders' 'Cyan'
  foreach ($j in $m.junctions) {
    $link = Expand-Token $j.link; $target = Expand-Token $j.target
    if ($link -match '\\session-skills\\') { continue }
    if (Test-Path -LiteralPath $link) { Say ("link exists: {0}" -f $link); continue }
    if (-not (Test-Path -LiteralPath $target)) { Say ("link skipped, its target is not on this PC: {0} -> {1}" -f $link, $target); continue }
    Say ("link {0} -> {1}" -f $link, $target)
    if (-not $DryRun) { New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null; & cmd.exe /c mklink /J "$link" "$target" | Out-Null }
  }

  # Windows user variables (Claude Code's long-lived sign-in among them) and PATH entries inside the user folder
  if ($m.userEnv) {
    Say '--- Windows user variables and PATH' 'Cyan'
    foreach ($p in $m.userEnv.vars.PSObject.Properties) {
      $v = Expand-Token $p.Value
      $now = [Environment]::GetEnvironmentVariable($p.Name, 'User')
      if ($now -eq $v) { Say ("{0} is already set" -f $p.Name); continue }
      Say ("set {0}{1}" -f $p.Name, $(if ($TestRoot) { ' (not in a test)' }))
      if (-not $DryRun -and -not $TestRoot) { [Environment]::SetEnvironmentVariable($p.Name, $v, 'User') }
    }
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    $have = @($userPath.Split(';') | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\').ToLower() })
    $add = @()
    foreach ($e in @($m.userEnv.path)) { $x = Expand-Token $e; if ((Test-Path -LiteralPath $x) -and ($have -notcontains $x.TrimEnd('\').ToLower())) { $add += $x } }
    foreach ($x in @((Join-Path $LOCAL_ 'AionDX\bin'), (Join-Path $APPDATA_ 'npm'), (Join-Path $HOMEDIR '.local\bin'))) { if ((Test-Path $x) -and ($have -notcontains $x.ToLower()) -and ($add -notcontains $x)) { $add += $x } }
    foreach ($x in $add) { Say ("PATH + {0}{1}" -f $x, $(if ($TestRoot) { ' (not in a test)' })) }
    if ($add.Count -and -not $DryRun -and -not $TestRoot) { [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';'), ($add -join ';')) -join ';').TrimStart(';'), 'User') }
  }
}

# ---------------------------------------------------------------- the two Claude Code accounts (offline check: no sign-in is used or refreshed)
# AionDX's account router gives each agent its account: a config folder and a long-lived sign-in token (a token file). Those, not
# .credentials.json (empty on the PC this was made on), are what signs Claude Code in. Checked offline: nothing is sent or renewed.
Say '--- Claude Code accounts' 'Cyan'
$routerFile = Join-Path $APPDATA_ 'npm\claude-account-router.config.json'
$seen = @{}
if (Test-Path $routerFile) {
  try {
    $router = Get-Content $routerFile -Raw | ConvertFrom-Json
    foreach ($a in $router.accounts.PSObject.Properties) {
      $v = $a.Value; $key = ([string]$v.configDir).ToLower() + '|' + ([string]$v.tokenFile).ToLower()
      if ($seen[$key]) { continue }; $seen[$key] = $true
      $label = if ($v.label) { $v.label } else { $a.Name }
      $dirOk = $v.configDir -and (Test-Path -LiteralPath $v.configDir)
      $tok = if ($v.tokenFile -and (Test-Path -LiteralPath $v.tokenFile)) { (Get-Content -LiteralPath $v.tokenFile -Raw).Trim() } else { '' }
      $inside = ([string]$v.configDir).ToLower().StartsWith($HOMEDIR.ToLower())
      if ($dirOk -and $tok.Length -ge 40 -and $inside) { Say ("{0}: ready (config folder {1}, sign-in token present)" -f $label, $v.configDir) 'Green' }
      else { Warn ("{0}: config folder {1} {2}, token file {3} {4}{5}" -f $label, $v.configDir, $(if ($dirOk) { 'found' } else { 'MISSING' }), $v.tokenFile, $(if ($tok.Length -ge 40) { 'found' } else { 'MISSING or empty' }), $(if (-not $inside) { '; it does not point into this user folder' })) }
    }
    if (-not $router.defaultAccount) { Warn 'the account router names no default account' }
  } catch { Warn ('the account router could not be read: ' + $_.Exception.Message) }
} else { Warn ('no account router at ' + $routerFile + ': Claude Code runs with whatever account each config folder is signed in to') }
if ($m.userEnv -and $m.userEnv.vars.CLAUDE_CODE_OAUTH_TOKEN) { Say 'CLAUDE_CODE_OAUTH_TOKEN (the long-lived sign-in for Claude Code outside AionDX) is carried over as a Windows user variable.' 'Green' }

Say ('Finished' + $(if ($problems.Count) { (' with {0} thing(s) to look at:' -f $problems.Count) } else { '.' })) $(if ($problems.Count) { 'Yellow' } else { 'Green' })
foreach ($p in $problems) { Say ('  - ' + $p) 'Yellow' }
Say ('The full log: ' + $logFile)
if (-not $DryRun -and -not $TestRoot -and -not $SkipApp) {
  $exe = Join-Path $LOCAL_ 'Programs\AionDX\AionDX.exe'
  if ((Test-Path $exe) -and (Ask 'Start AionDX now?')) { Start-Process $exe }
}
} catch {
  Say ('STOPPED: ' + $_.Exception.Message) 'Red'
  Say ($_.ScriptStackTrace) 'Red'
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
try { Stop-Transcript | Out-Null } catch { }
exit 0
