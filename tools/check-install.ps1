$dst     = 'C:\Program Files\AionUi\resources\app.asar'
$stock   = "$dst.stock"
$patched = 'C:\AI Projects\AionDX\vendor\app.asar.patched'

$paths = @{ live = $dst; stock = $stock; patched = $patched }
$h = @{}
foreach ($k in 'live','stock','patched') {
  $p = $paths[$k]
  if (Test-Path $p) { $h[$k] = (Get-FileHash $p -Algorithm SHA256).Hash.Substring(0,16) } else { $h[$k] = 'missing' }
}
Write-Host "live    = $($h.live)"
Write-Host "stock   = $($h.stock)"
Write-Host "patched = $($h.patched)"
if ($h.live -ne 'missing' -and $h.live -eq $h.patched) { Write-Host 'STATUS: patched build installed' }
elseif ($h.live -ne 'missing' -and $h.live -eq $h.stock) { Write-Host 'STATUS: stock build installed' }
else { Write-Host 'STATUS: installed asar matches NEITHER (app updated? re-run do_patch)' }
