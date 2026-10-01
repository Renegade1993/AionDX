$ErrorActionPreference = 'Stop'
$root = 'C:\AI Projects\AionDX'
$work = "$root\vendor"
$src  = 'C:\Program Files\AionUi\resources\app.asar'
$ext  = "$work\extracted"
$patchJs = "$root\patches\0001-renderer-dx\aionui-dx.js"

if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
Write-Host "extracting..."
& "$work\node_modules\.bin\asar.cmd" extract $src $ext
if (-not (Test-Path "$ext\out\renderer\index.html")) { throw 'extract failed: index.html missing' }
Write-Host "extracted OK"

$idx = Get-Content "$ext\out\renderer\index.html" -Raw
if ($idx -match 'aionui-dx\.js') { Write-Host 'index.html already patched' }
else {
  $idx = $idx -replace '(<script type="module" crossorigin src="\./assets/index-[^"]+\.js"></script>)', "`$1`r`n    <script src=`"./aionui-dx.js`" defer></script>"
  Set-Content "$ext\out\renderer\index.html" $idx -NoNewline -Encoding utf8
  Write-Host 'index.html patched'
}
Copy-Item $patchJs "$ext\out\renderer\aionui-dx.js" -Force
Write-Host 'aionui-dx.js copied'

# Patch 0003-local-account: no aionui.com sign-in. apply.js checks every anchor and writes nothing
# unless all of them match, so a changed AionUi build stops the rebuild here instead of shipping.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
& $node "$root\patches\0003-local-account\apply.js" $ext
if ($LASTEXITCODE -ne 0) { throw 'patch 0003-local-account did not apply; see its message above' }

# Patch 0006-butler-to-antigravity: "via chat" buttons open Antigravity, English labels say so.
# Same rule as 0003: every anchor must match its expected count or nothing is written.
& $node "$root\patches\0006-butler-to-antigravity\apply.js" $ext
if ($LASTEXITCODE -ne 0) { throw 'patch 0006-butler-to-antigravity did not apply; see its message above' }

# Patch 0009-identity: the AionDX mark in place of AionUi's (in-app logo, window, tray, notifications,
# WebUI icons). Same rule: every anchor must match or nothing is written.
& $node "$root\patches\0009-identity\apply.js" $ext
if ($LASTEXITCODE -ne 0) { throw 'patch 0009-identity did not apply; see its message above' }

Write-Host "repacking..."
& "$work\node_modules\.bin\asar.cmd" pack $ext "$work\app.asar.patched"
Write-Host "done -> $work\app.asar.patched"
Get-Item "$work\app.asar.patched" | Select-Object Length
