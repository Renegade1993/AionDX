<#
  Restore the stock AionUi renderer. Uses the same stage-and-swap installer as a patch install,
  so it is safe to run while AionUi is open: the stock build goes in when AionUi next closes.
#>
$stock = 'C:\Program Files\AionUi\resources\app.asar.stock'
if (-not (Test-Path -LiteralPath $stock)) { 'ERROR: no stock backup at ' + $stock; exit 1 }
& 'C:\AI Projects\AionDX\tools\launch_elevated.ps1' -Source $stock
