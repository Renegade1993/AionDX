# ---------------------------------------------------------------------------
#  AionUi account router shim, PowerShell form.
#  Rebuilt by AionDX patch 0002 on 2026-09-22, alongside claude.cmd.
#
#  Same contract as claude.cmd: route through claude-account-router.js when it and
#  node are both present, otherwise launch the native build unmodified.
#
#  To revert:  Remove-Item "$PSScriptRoot\claude.ps1"
# ---------------------------------------------------------------------------
$router = Join-Path $PSScriptRoot 'claude-account-router.js'
$native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$npmExe = Join-Path $PSScriptRoot 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'

if ((Test-Path $router) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  & node $router @args
  exit $LASTEXITCODE
}

if (Test-Path $native) {
  & $native @args
  exit $LASTEXITCODE
}

if (Test-Path $npmExe) {
  & $npmExe @args
  exit $LASTEXITCODE
}

Write-Error 'claude.ps1: no Claude Code binary found. Run: claude install latest'
exit 1
