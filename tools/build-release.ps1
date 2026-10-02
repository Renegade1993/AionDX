# build-release.ps1 - builds the all-in-one AionDX installer: the whole app, for a PC with no AionUi.
#
#   powershell -ExecutionPolicy Bypass -File "C:\AI Projects\AionDX\tools\build-release.ps1" -Version 0.1.0
#
# a request of September 26th, 2026.
#
# The app is AionUi 2.2.2's own release files (vendor\aionui-base, unpacked from AionUi's installer by
# tools\fetch-aionui-base.js; or an installed AionUi, if the PC has one) (Electron, locales,
# the bundled AionCore v0.2.2, the unpacked native modules), with:
#   resources\app.asar      built from the STOCK asar (checked by SHA-256): patches 0001, 0003, 0006, 0009 and
#                           0010 applied, packed with the stock header's unpack rules (tools\pack-asar.js)
#   resources\aiondx\       the per-user payload: bin (Loop tool, Antigravity sign-in wrapper, Claude
#                           launcher, all built from source here), skills, icons, release.json
#   AionDX.exe              AionUi.exe renamed, with the AionDX icon and version strings (brand-exe.mjs)
#   LICENSE.AionUi.txt, LICENSE.AionCore.txt, NOTICE.AionDX.txt   Apache-2.0: the licences, and what changed
# AionUi's updater file (resources\app-update.yml) and uninstaller are left out: AionDX is not updated by
# AionUi's feed (the app also sets AionUi's own AIONUI_DISABLE_AUTO_UPDATE, patch 0009).
#
# Output, in dist\<version>\: AionDX-<version>-setup.exe (installer\aiondx.iss, Inno Setup 6, per-user),
# SHA256SUMS.txt, README.txt, release.json, build.log. The staged app stays in vendor\release\stage\AionDX
# until the next build, for tools\smoke-standalone.js. Research: ! LLM Files\Research\
# 2026-09-26_installer-and-breadcrumbs.md.
param(
  [string]$Version = '0.1.0',
  [string]$AionUiDir = 'C:\Program Files\AionUi',
  # Ship AionDX's own AionCore build (vendor\aioncore) in place of the stock binary. Off unless given: a patched
  # AionCore goes to another PC only after it has passed its tests here (September 26th).
  [switch]$AionDxCore,
  # Stop after the staged app and its privacy checks, before the installer is compiled (for tests on the staged app).
  [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+(\.\d+){1,3}(-[0-9A-Za-z.]+)?$') { throw "-Version must look like 0.1.0 (got '$Version')" }
$root = 'C:\AI Projects\AionDX'
# The base: an installed AionUi, else the copy unpacked from its official installer (tools\fetch-aionui-base.js).
if (-not (Test-Path (Join-Path $AionUiDir 'AionUi.exe'))) { $AionUiDir = Join-Path $root 'vendor\aionui-base' }
$STOCK_SHA = '95b6352bca6400e2990781398a0644f185e5b1b9f42706125ddeee21e72c7d73'   # AionUi 2.2.2's app.asar
$EXE_SHA = '16360a60802c14b1842289362704b4c4731fe4db57fda3aad4346945c1dec6dc'     # AionUi 2.2.2's AionUi.exe, x64
$AIONUI_VER = '2.2.2'
$CORE_SHA = '67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892'   # its bundled aioncore.exe v0.2.2
$ISCC = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$Stock = Join-Path $AionUiDir 'resources\app.asar.stock'
if (-not (Test-Path $Stock)) { $Stock = Join-Path $AionUiDir 'resources\app.asar' }   # a fresh unpack has only the stock one
$Unpacked = Join-Path $AionUiDir 'resources\app.asar.unpacked'

$dist = Join-Path $root "dist\$Version"
$work = Join-Path $root 'vendor\release'
$stage = Join-Path $work 'stage\AionDX'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist | Out-Null
$logFile = Join-Path $dist 'build.log'
function Say([string]$m) {
  $line = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' ' + $m
  Add-Content -Path $logFile -Value $line -Encoding utf8
  Write-Host $m
}
function Sha([string]$f) { (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() }
# Windows PowerShell 5.1 turns a native program's stderr lines into errors, which 'Stop' would end the
# script on (node's warnings, say); the exit code decides instead.
function Run([string]$exe, [string[]]$argv, [string]$what) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $exe @argv 2>&1 | ForEach-Object { Say "  $_" } } finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}
$utf8 = New-Object Text.UTF8Encoding $false

$built = (Get-Date).ToUniversalTime()
$rendererBuild = ([regex]::Match((Get-Content "$root\patches\0001-renderer-dx\aionui-dx.js" -Raw), "var BUILD = '([^']+)'")).Groups[1].Value
$buildId = $built.ToString('yyyyMMdd.HHmm') + '-r' + $rendererBuild
$coreManifest = Get-Content (Join-Path $AionUiDir 'resources\bundled-aioncore\win32-x64\manifest.json') -Raw | ConvertFrom-Json
$aioncoreVer = [string]$coreManifest.version
if (-not $aioncoreVer) { $aioncoreVer = 'unknown' }
Say "AionDX $Version (standalone), build $buildId, renderer $rendererBuild, on AionUi $AIONUI_VER and AionCore $aioncoreVer"
Say "machine $env:COMPUTERNAME, user $env:USERNAME, node $(& $node --version), Inno $ISCC"

# 1. The base: AionUi 2.2.2's files as its installer put them here, checked where a hash is known.
if ((Sha (Join-Path $AionUiDir 'AionUi.exe')) -ne $EXE_SHA) { throw "$AionUiDir\AionUi.exe is not AionUi $AIONUI_VER's (sha256 mismatch)" }
if ((Sha $Stock) -ne $STOCK_SHA) { throw "$Stock is not AionUi $AIONUI_VER's stock app.asar (sha256 mismatch)" }
# Once AionDX Apply Update has put AionDX's own AionCore build on this PC, the stock binary is its .stock backup.
$coreLive = Join-Path $AionUiDir 'resources\bundled-aioncore\win32-x64\aioncore.exe'
$coreStockFile = if ((Sha $coreLive) -eq $CORE_SHA) { $coreLive } elseif ((Test-Path "$coreLive.stock") -and ((Sha "$coreLive.stock") -eq $CORE_SHA)) { "$coreLive.stock" } else { $null }
if (-not $coreStockFile) { throw "neither the bundled aioncore.exe nor its .stock backup is AionUi $AIONUI_VER's (sha256 mismatch)" }
Say "base ok: AionUi.exe $EXE_SHA, stock app.asar $STOCK_SHA, aioncore.exe $CORE_SHA"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force "$work\stock", "$work\packed", $stage | Out-Null
Copy-Item $Stock "$work\stock\app.asar"
Copy-Item $Unpacked "$work\stock\app.asar.unpacked" -Recurse

# 2. The app.asar: extract the stock one, patch it as tools\do_patch.ps1 does, pack with stock's unpack rules.
$ext = "$work\extracted"
Run "$root\vendor\node_modules\.bin\asar.cmd" @('extract', "$work\stock\app.asar", $ext) 'asar extract'
$idx = Get-Content "$ext\out\renderer\index.html" -Raw
if ($idx -notmatch 'aionui-dx\.js') {
  $idx = $idx -replace '(<script type="module" crossorigin src="\./assets/index-[^"]+\.js"></script>)', "`$1`r`n    <script src=`"./aionui-dx.js`" defer></script>"
  Set-Content "$ext\out\renderer\index.html" $idx -NoNewline -Encoding utf8
}
Copy-Item "$root\patches\0001-renderer-dx\aionui-dx.js" "$ext\out\renderer\aionui-dx.js" -Force
Say "patch 0001: aionui-dx.js ($rendererBuild) and its script tag"
foreach ($p in @('0003-local-account', '0006-butler-to-antigravity', '0009-identity')) {
  Run $node @("$root\patches\$p\apply.js", $ext) "patch $p"
  Say "patch $p applied"
}
Run $node @("$root\patches\0010-official-identity\apply.js", $ext, $Version, '--report', "$work\0010-report.txt") 'patch 0010'
Say "patch 0010 applied (report: $work\0010-report.txt)"
Run $node @("$root\tools\pack-asar.js", $ext, "$work\stock\app.asar", "$work\packed\app.asar") 'pack'

# 3. Stage the app. Everything AionUi's installer put here, except its uninstaller, its updater feed file
#    and the asar copies (stock, previous, patched), which AionDX's own asar replaces.
Get-ChildItem -LiteralPath $AionUiDir -File | Where-Object { $_.Name -ne 'Uninstall AionUi.exe' } | ForEach-Object { Copy-Item $_.FullName $stage }
Copy-Item (Join-Path $AionUiDir 'locales') (Join-Path $stage 'locales') -Recurse
New-Item -ItemType Directory -Force "$stage\resources" | Out-Null
foreach ($d in @('app.asar.unpacked', 'bundled-aioncore', 'hub', 'pet-states', 'pwa')) {
  $src = Join-Path $AionUiDir "resources\$d"
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage "resources\$d") -Recurse }
}
foreach ($f in @('app.png', 'elevate.exe', 'manifest.webmanifest', 'sw.js')) {
  $src = Join-Path $AionUiDir "resources\$f"
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage "resources\$f") }
}
# AionCore: the stock binary, or with -AionDxCore AionDX's own build of that same version, made by
# tools\build-aioncore.ps1 -Patched (vendor\aioncore, with aioncore.json naming the stock binary it replaces).
# Apply Update's backups (.stock, .prev, .new) stay out.
$stageCoreDir = Join-Path $stage 'resources\bundled-aioncore\win32-x64'
Get-ChildItem -LiteralPath $stageCoreDir -Filter 'aioncore.exe.*' | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
Copy-Item -LiteralPath $coreStockFile -Destination (Join-Path $stageCoreDir 'aioncore.exe') -Force
$coreRec = $null
$coreRecFile = Join-Path $root 'vendor\aioncore\aioncore.json'
if ($AionDxCore) {
  if (-not (Test-Path $coreRecFile)) { throw '-AionDxCore: there is no AionDX AionCore build (vendor\aioncore\aioncore.json); run tools\build-aioncore.ps1 -Patched' }
  $coreRec = Get-Content $coreRecFile -Raw | ConvertFrom-Json
  $coreBuilt = Join-Path $root 'vendor\aioncore\aioncore.exe'
  if (-not ($coreRec.stockSha256 -eq $CORE_SHA -and (Test-Path $coreBuilt) -and ((Sha $coreBuilt) -eq $coreRec.sha256))) {
    throw '-AionDxCore: the recorded AionDX build is for another AionCore, or its file changed since it was built'
  }
  Copy-Item -LiteralPath $coreBuilt -Destination (Join-Path $stageCoreDir 'aioncore.exe') -Force
  Say "AionCore: AionDX's build of $($coreRec.tag) with $((@($coreRec.patches)) -join ', '), sha256 $($coreRec.sha256)"
} elseif (Test-Path $coreRecFile) {
  Say 'AionCore: an AionDX build is in vendor\aioncore, left out (pass -AionDxCore to ship it)'
}
if (-not $coreRec) { Say 'AionCore: the stock binary' }
# Node.js for a PC without it (2026-09-26, the friend's install: AionUi's browser tool runs npx by name, and his PC had
# no Node on PATH). AionUi 2.2.2's own installer already puts Node's Windows build where AionCore's managed runtime
# takes it (managed-resources\node\<dir>, MANAGED_NODE_VERSION in aionui-runtime managed.rs), but not on PATH. Here the
# official zip, checked against nodejs.org's published SHA-256, is unpacked over that folder so the files shipped are
# known, and the start hook (patch 0009) puts the folder on PATH when the PC has no Node of its own. The zip is
# downloaded once into vendor\node.
$NODE_VER = '24.11.0'
$nodeDirName = "node-v$NODE_VER-win-x64"
$nodeCache = Join-Path $root 'vendor\node'
$nodeZip = Join-Path $nodeCache "$nodeDirName.zip"
$nodeSums = Join-Path $nodeCache "SHASUMS256-v$NODE_VER.txt"
New-Item -ItemType Directory -Force $nodeCache | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
if (-not (Test-Path $nodeSums)) { Invoke-WebRequest "https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt" -OutFile "$nodeSums.part" -UseBasicParsing; Move-Item "$nodeSums.part" $nodeSums -Force }
if (-not (Test-Path $nodeZip)) { Invoke-WebRequest "https://nodejs.org/dist/v$NODE_VER/$nodeDirName.zip" -OutFile "$nodeZip.part" -UseBasicParsing; Move-Item "$nodeZip.part" $nodeZip -Force }
$wantNode = ((Get-Content $nodeSums) | Where-Object { $_ -match "\s$([regex]::Escape($nodeDirName)).zip$" } | Select-Object -First 1) -replace '\s.*$', ''
if (-not $wantNode -or (Sha $nodeZip) -ne $wantNode.ToLowerInvariant()) { Remove-Item $nodeZip -Force; throw "$nodeDirName.zip does not match nodejs.org's SHA-256; deleted, run again to fetch it anew" }
$nodeHome = Join-Path $stageCoreDir 'managed-resources\node'
New-Item -ItemType Directory -Force $nodeHome | Out-Null
Run "$env:WINDIR\System32\tar.exe" @('-xf', $nodeZip, '-C', $nodeHome) 'unpack Node.js'
if (-not (Test-Path (Join-Path $nodeHome "$nodeDirName\node.exe"))) { throw "Node.js did not unpack to $nodeHome\$nodeDirName" }
Say "Node.js $NODE_VER bundled (sha256 $wantNode) in resources\bundled-aioncore\win32-x64\managed-resources\node\$nodeDirName"
Copy-Item "$work\packed\app.asar" "$stage\resources\app.asar"
# AionUi's logo files beside the app (its own tray fallback, the WebUI's web-app icons and manifest) become AionDX's.
Copy-Item "$root\patches\0009-identity\icon\png\aiondx-256.png" "$stage\resources\app.png" -Force
foreach ($i in @('icon-180.png', 'icon-192.png', 'icon-512.png')) { if (Test-Path "$stage\resources\pwa\$i") { Copy-Item "$ext\out\renderer\pwa\$i" "$stage\resources\pwa\$i" -Force } }
if (Test-Path "$stage\resources\manifest.webmanifest") { Copy-Item "$ext\out\renderer\manifest.webmanifest" "$stage\resources\manifest.webmanifest" -Force }
Rename-Item (Join-Path $stage 'AionUi.exe') 'AionDX.exe'
Run $node @("$root\tools\brand-exe.mjs", (Join-Path $stage 'AionDX.exe'), "$root\patches\0009-identity\icon\aiondx.ico", $Version) 'brand AionDX.exe'
Say "staged the app in $stage"

# 4. The per-user payload, built fresh from source, inside the app.
$payload = Join-Path $stage 'resources\aiondx'
$bin = Join-Path $payload 'bin'
New-Item -ItemType Directory -Force $bin, "$payload\skills", "$payload\icons" | Out-Null
Run $csc @('/nologo', '/optimize+', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', "/out:$bin\aiondx.exe", "$root\patches\0007-loop-tool\aiondx-loop.cs") 'build aiondx.exe'
Run $csc @('/nologo', '/optimize+', '/target:winexe', '/platform:x64', '/r:System.Web.Extensions.dll', "/out:$bin\aiondx-loop.exe", "$root\patches\0007-loop-tool\aiondx-loop.cs") 'build aiondx-loop.exe'
Run $csc @('/nologo', '/optimize+', '/target:exe', '/platform:x64', "/out:$bin\agy.exe", "$root\patches\0008-agy-signin\agy-shim.cs") 'build agy.exe'
Run $csc @('/nologo', '/optimize+', '/target:exe', '/platform:x64', "/out:$bin\claude.exe", "$root\patches\0005-claude-exe-shim\claude-shim.cs") 'build claude.exe'
Copy-Item "$root\patches\0002-claude-model-currency\claude-account-router.js" $bin
Copy-Item "$root\patches\0002-claude-model-currency\claude-stream-proxy.js" $bin
Copy-Item "$root\patches\0009-identity\icon\aiondx.ico" "$payload\icons\aiondx.ico"
Copy-Item "$root\patches\0007-loop-tool\skill\aiondx-loop" "$payload\skills\aiondx-loop" -Recurse
Copy-Item "$root\patches\0004-setup-butler\skill\aiondx-setup" "$payload\skills\aiondx-setup" -Recurse
Say "payload: $((Get-ChildItem $bin | ForEach-Object Name) -join ', '); skills aiondx-loop, aiondx-setup"

# 5. Licences and the notice of changes (Apache-2.0, section 4).
Copy-Item "$root\upstream\LICENSE" "$stage\LICENSE.AionUi.txt"
if (Test-Path "$root\upstream-aioncore\LICENSE") { Copy-Item "$root\upstream-aioncore\LICENSE" "$stage\LICENSE.AionCore.txt" }
$notice = @"
AionDX $Version (build $buildId)

AionDX is AionUi $AIONUI_VER (https://github.com/iOfficeAI/AionUi, Apache-2.0, by iOfficeAI) with AionCore
$aioncoreVer, changed by AionDX. The licences are in LICENSE.AionUi.txt and LICENSE.AionCore.txt.

Files AionDX changed or added:
- AionDX.exe: AionUi.exe, renamed, with the AionDX icon and version strings. Program code unchanged.
- resources\app.asar: AionUi's app with these changes:
  0001 the Loop, Respond now, drafts, background colours, the agent control, Welcome to AionDX, the /plugin panel
       (out/renderer/aionui-dx.js and one script tag in out/renderer/index.html)
  0003 no aionui.com sign-in: a local account (out/main/index.js)
  0006 Antigravity in place of the Butler (renderer chunks)
  0009 the AionDX mark, name and themes; at start, AionDX's programs first on PATH, Node.js on PATH when the PC has
       none, and AionUi's updater off; the one-click setup's and /plugin's main-process halves and their preload bridge
       (out/main/index.js, out/preload/index.js, out/renderer/index.html, icons, out/renderer/aiondx-*.js)
  0010 AionDX as its own product: every display string that said AionUi says AionDX; the About page, the update check
       and self-update read AionDX's own GitHub releases; no crash reports or usage analytics are sent to AionUi's
       services; feedback opens AionDX's GitHub issues; pictures attached to a message box are kept across a restart
       (out/main/index.js, out/preload/index.js, out/renderer/assets/*.js, the web-app manifests, static/images)
- resources\aiondx\: AionDX's own programs, skills and icon.
- resources\bundled-aioncore\win32-x64\managed-resources\node\node-v$NODE_VER-win-x64\: Node.js $NODE_VER from
  nodejs.org, unchanged (MIT; its LICENSE is in that folder), for a PC without Node.
- resources\app-update.yml and AionUi's uninstaller are not included.
- resources\app.png, resources\pwa and resources\manifest.webmanifest: AionUi's logo files replaced by AionDX's.
- resources\bundled-aioncore\win32-x64\aioncore.exe (with -AionDxCore): AionCore built from source with AionDX's patches
  (the built-in assistants say AionDX where they said AionUi; the message queue and per-chat MCP changes).
"@
[IO.File]::WriteAllText("$stage\NOTICE.AionDX.txt", $notice.Replace("`n", "`r`n"), $utf8)

# 6. release.json, in the payload (the per-user setup reads it) and beside the installer.
$exeSha = Sha (Join-Path $stage 'AionDX.exe')
$asarSha = Sha (Join-Path $stage 'resources\app.asar')
$coreSha = Sha (Join-Path $stage 'resources\bundled-aioncore\win32-x64\aioncore.exe')
$userFiles = Get-ChildItem $payload -Recurse -File | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($payload.Length + 1).Replace('\', '/'); sha256 = (Sha $_.FullName); size = $_.Length }
}
$stageBytes = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
$release = [ordered]@{
  schema = 'aiondx.release/2'; name = 'AionDX'; kind = 'standalone'; version = $Version; build = $buildId; rendererBuild = $rendererBuild
  builtAtUtc = $built.ToString('yyyy-MM-ddTHH:mm:ssZ')
  aionui = $AIONUI_VER; aioncore = $aioncoreVer; baseExeSha256 = $EXE_SHA; stockAsarSha256 = $STOCK_SHA; stockAioncoreSha256 = $CORE_SHA
  aioncoreBuild = $(if ($coreRec) { [ordered]@{ by = 'AionDX'; tag = $coreRec.tag; patches = @($coreRec.patches); toolchain = $coreRec.toolchain; builtAt = $coreRec.builtAt } } else { 'stock' })
  files = [ordered]@{ 'AionDX.exe' = $exeSha; 'resources/app.asar' = $asarSha; 'resources/bundled-aioncore/win32-x64/aioncore.exe' = $coreSha }
  appBytes = $stageBytes
  patches = @('0001-renderer-dx', '0002-claude-model-currency', '0003-local-account', '0004-setup-butler', '0005-claude-exe-shim',
    '0006-butler-to-antigravity', '0007-loop-tool', '0008-agy-signin', '0009-identity', '0010-official-identity') + @($(if ($coreRec) { @($coreRec.patches) } else { @() }))
  userFiles = @($userFiles)
}
[IO.File]::WriteAllText("$payload\release.json", ($release | ConvertTo-Json -Depth 6), $utf8)
Copy-Item "$payload\release.json" "$dist\release.json"
Say "app: $([math]::Round($stageBytes / 1MB)) MB; AionDX.exe $exeSha; app.asar $asarSha; aioncore.exe $coreSha"

# 7. The README for the person installing it.
$readme = @"
AionDX $Version
Build $buildId

AionDX is one app for Claude Code, Codex, Gemini, Antigravity and every other agent AionUi supports,
with the Loop, Respond now, drafts that survive a restart, and a first screen that brings your settings
over from the other AI apps you use. It is AionUi $AIONUI_VER with AionDX's changes; nothing else is needed.

INSTALL
1. Run AionDX-$Version-setup.exe.
2. Windows may say "Windows protected your PC". Click "More info", then "Run anyway". The installer is
   not signed with a paid certificate, so Windows does not know it yet.
   If Windows says Smart App Control blocked it, there is no "Run anyway": with Smart App Control on,
   Windows runs only signed programs, and AionDX is not signed. It can run only with Smart App Control
   off (Windows Security > App & browser control > Smart App Control settings).
3. It installs for you only, in %LOCALAPPDATA%\Programs\AionDX, with no administrator prompt.
   If AionUi is on the PC, Setup first asks whether to move to AionDX (the default) or keep both:
   - Move: your chats and settings stay where they are (AionDX uses the same folder, %APPDATA%\AionUi).
     Setup copies the chats database, settings and custom assistants to %LOCALAPPDATA%\AionDX\migration
     (a box you can untick), removes AionUi with its own uninstaller (Windows asks for permission once if
     AionUi was installed for all users), and checks the chats database is exactly as it was.
   - Keep both: AionDX installs next to AionUi. They share one set of chats and settings, so use one at a time.
   An AionUi newer than the one AionDX is built on may have a chats database AionDX cannot open: Setup warns
   and defaults to keeping both. For an unattended install, /MIGRATE=yes moves (/AIONUIBACKUP=no skips the copy).
   The same step runs from a shell: "%LOCALAPPDATA%\AionDX\bin\aiondx.exe" migrate detect | run.
4. Updates: AionDX looks for a newer release on GitHub (github.com/Renegade1993/AionDX/releases) about half a minute after it
   starts and every six hours. When there is one, a card says so; "Download" and then "Install now" check the installer
   against the release's published SHA-256, install it quietly, and AionDX comes back. About > Check for updates does the same on
   request. AionDX itself sends no crash reports or usage figures.
5. Start AionDX. It opens on "Welcome to AionDX": sign in to Antigravity (free, with a Google account)
   and it sets up your agents, or pick "Use another agent instead".

CHECK THE DOWNLOAD
SHA256SUMS.txt, sent with the installer, has its SHA-256. In PowerShell:
  Get-FileHash .\AionDX-$Version-setup.exe

UNINSTALL
Settings > Apps > Installed apps > AionDX > Uninstall. Your chats and settings stay in %APPDATA%\AionUi.

WHERE THINGS ARE
  %LOCALAPPDATA%\Programs\AionDX           the app
  %LOCALAPPDATA%\AionDX                    AionDX's programs (bin), logs, install.json, manifest.user.json
  %APPDATA%\AionUi                         your chats, settings and agents
  HKCU\Software\AionDX\AionDX              version, build and paths
If something goes wrong, send the newest files from %LOCALAPPDATA%\AionDX\logs.
"@
[IO.File]::WriteAllText("$dist\README.txt", $readme.Replace("`n", "`r`n"), $utf8)
Copy-Item "$dist\README.txt" "$stage\README.txt"

# 7b. Nothing about this PC, its user, their accounts, people or other projects ships (K, 2026-09-27, after team
# names, a tester's name and this PC's name were found in the shipped comments and release.json). Every file AionDX
# adds to the app: its renderer scripts, its block of the main process, the payload, the README. Any hit stops the build.
Run $node @("$root\tools\privacy-check.js", '--files', "$ext\out\renderer\aionui-dx.js", "$ext\out\renderer\aiondx-themes.js", "$stage\README.txt") 'privacy check: renderer and README'
Run $node @("$root\tools\privacy-check.js", '--block', "$ext\out\main\index.js") 'privacy check: main process block'
Run $node @("$root\tools\privacy-check.js", '--dir', $payload) 'privacy check: payload'

if ($StageOnly) { Say "stage only: the staged app is in $stage; no installer compiled"; exit 0 }

# 8. The installer.
$numeric = ($Version -replace '[^0-9.]', '')
while (($numeric.Split('.')).Count -lt 4) { $numeric += '.0' }
$gen = @"
; Written by tools\build-release.ps1 on $($built.ToString('yyyy-MM-ddTHH:mm:ssZ')). Do not edit.
#define AppVer "$Version"
#define AppVerNumeric "$numeric"
#define BuildId "$buildId"
#define RendererBuild "$rendererBuild"
#define AionUiVer "$AIONUI_VER"
#define AionCoreVer "$aioncoreVer"
#define StockSha "$STOCK_SHA"
#define BaseExeSha "$EXE_SHA"
#define ExeSha "$exeSha"
#define AsarSha "$asarSha"
#define CoreSha "$coreSha"
#define StageDir "$stage"
#define OutputDir "$dist"
#define IconFile "$root\patches\0009-identity\icon\aiondx.ico"
"@
[IO.File]::WriteAllText("$root\installer\generated.iss", $gen, $utf8)
Say "compiling the installer (lzma2/ultra64; several minutes for an app this size)"
Run $ISCC @('/Q', "$root\installer\aiondx.iss") 'ISCC'
$setup = Get-Item "$dist\AionDX-$Version-setup.exe"
$setupSha = Sha $setup.FullName
[IO.File]::WriteAllText("$dist\SHA256SUMS.txt", "$setupSha  $($setup.Name)`r`n", $utf8)
Say "installer: $($setup.FullName) ($([math]::Round($setup.Length / 1MB, 1)) MB), sha256 $setupSha"
# The working copies go (stock asar, its extraction, the packed asar); the staged app stays for the smoke test.
foreach ($d in @("$work\stock", "$work\extracted", "$work\packed")) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
Say "done; staged app kept in $stage"
