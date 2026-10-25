<#
  make-package.ps1 - builds an AionDX profile package: a folder that carries this PC's whole AionDX setup (AionDX, its teams and
  chats, the Claude Code accounts, settings, tools) to another PC, and back again.

    powershell -ExecutionPolicy Bypass -File tools\profile-move\make-package.ps1 -Out D:\AionDX-package [-Installer path\AionDX-x.y.z-setup.exe]

  It copies the scripts from this folder into -Out, downloads the redistributables from their publishers (Visual C++ from Microsoft,
  Git for Windows, Node.js, Python; each signature is checked, nothing unsigned is kept), puts in the newest AionDX installer from
  dist\ (or -Installer), and runs the first export. Later updates: export.bat in the package (only what changed is copied).
  On the other PC: install.bat. Both write logs into the package's logs folder.
#>
param([Parameter(Mandatory = $true)][string]$Out, [string]$Installer = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$Out = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force $Out, "$Out\tools", "$Out\redist", "$Out\installers", "$Out\logs" | Out-Null

# the scripts
foreach ($f in 'install.bat', 'install.ps1', 'export.bat', 'README.txt', 'AGENT-GUIDE.md') { Copy-Item (Join-Path $here $f) (Join-Path $Out $f) -Force }
foreach ($f in 'export.js', 'rehome.js', 'refresh-package.ps1') { Copy-Item (Join-Path $here "tools\$f") (Join-Path $Out "tools\$f") -Force }
Write-Host "scripts copied into $Out"

# the redistributables: [url, file, signer pattern, sha256 or $null]
$redist = @(
  @('https://aka.ms/vs/17/release/vc_redist.x64.exe', 'VC_redist.x64.exe', 'Microsoft', $null),
  @('https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.3/Git-2.56.0.3-64-bit.exe', 'Git-2.56.0.3-64-bit.exe', 'Schindelin', $null),
  @('https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi', 'node-v24.16.0-x64.msi', 'OpenJS', '43749d78a28ff11a36cb279407bc13e79bcfb8670e7926e469018d31c2ec6453'),
  @('https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe', 'python-3.12.7-amd64.exe', 'Python Software Foundation', $null)
)
foreach ($r in $redist) {
  $dest = Join-Path "$Out\redist" $r[1]
  if (-not (Test-Path $dest)) { Invoke-WebRequest $r[0] -OutFile "$dest.part" -UseBasicParsing -TimeoutSec 900; Move-Item "$dest.part" $dest -Force }
  $sig = Get-AuthenticodeSignature $dest
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  $ok = $sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match $r[2] -and (-not $r[3] -or $hash -eq $r[3])
  if (-not $ok) { Remove-Item $dest -Force; throw ("{0} did not verify (signature {1}); deleted" -f $r[1], $sig.Status) }
  Write-Host ("redist {0}: signed by {1}, sha256 {2}" -f $r[1], ($sig.SignerCertificate.Subject -replace ',.*', ''), $hash)
}

# the AionDX installer
if (-not $Installer) {
  $d = Get-ChildItem (Join-Path $root 'dist') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if ($d) { $Installer = Join-Path $d.FullName ('AionDX-' + $d.Name + '-setup.exe') }
}
if (-not $Installer -or -not (Test-Path $Installer)) { throw 'No AionDX installer: build one (tools\build-release.ps1) or pass -Installer.' }
Copy-Item $Installer "$Out\installers" -Force
$sums = Join-Path (Split-Path $Installer) 'SHA256SUMS.txt'
if (Test-Path $sums) { Copy-Item $sums "$Out\installers" -Force }
Write-Host ('installer: ' + (Split-Path $Installer -Leaf))

# the first export (later ones: export.bat in the package)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Out\tools\refresh-package.ps1" -DistDir (Join-Path $root 'dist')
exit $LASTEXITCODE
