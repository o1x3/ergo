# ergo installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/o1x3/ergo/main/install.ps1 | iex
#
# Environment overrides:
#   $env:ERGO_VERSION      pin a version (e.g. v0.2.0); defaults to latest
#   $env:ERGO_INSTALL_DIR  install directory (default: %LOCALAPPDATA%\ergo\bin)

$ErrorActionPreference = 'Stop'
$Repo = 'o1x3/ergo'
$Bin = 'ergo.exe'

function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Die($m)  { Write-Host $m -ForegroundColor Red; exit 1 }

# ---- detect arch ----
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { Die 'ergo requires 64-bit Windows' }
$asset = "ergo-windows-$arch.exe"

# ---- resolve version ----
$version = $env:ERGO_VERSION
if (-not $version) {
  Info 'Resolving latest release...'
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $version = $rel.tag_name
}
if (-not $version) { Die 'Could not determine latest version; set $env:ERGO_VERSION' }

$url = "https://github.com/$Repo/releases/download/$version/$asset"

# ---- install dir ----
$dir = $env:ERGO_INSTALL_DIR
if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'ergo\bin' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$dest = Join-Path $dir $Bin
$tmp = Join-Path $env:TEMP $asset
Info "Downloading $asset $version..."
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

# ---- checksum (best effort) ----
try {
  $sums = Invoke-RestMethod "https://github.com/$Repo/releases/download/$version/SHA256SUMS.txt"
  $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1
  if ($line) {
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($expected -and ($actual -ne $expected.ToLower())) { Die "Checksum mismatch (expected $expected, got $actual)" }
    Info 'Checksum verified.'
  }
} catch { }

Move-Item -Force $tmp $dest
Ok "Installed ergo $version to $dest"

# ---- PATH ----
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Info "Added $dir to your PATH (restart your terminal)."
}
Ok "Run 'ergo auth login' to get started."
