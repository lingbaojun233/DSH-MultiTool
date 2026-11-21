# enable-plugins.ps1 -- add installed DSH plugin packages to the profile's bundle list.
#
# Why this is a separate step: `npm install` puts the package in node_modules, but DSH
# only loads a plugin if its package name is listed in package.json -> dsh.profile.bundles.
# Nothing in npm does that for us, so we patch the JSON here (idempotent).
#
# ASCII only: PS 5.1 reads a BOM-less UTF-8 .ps1 as ANSI and mojibakes non-ASCII text.
param(
  [string]$ProfileDir = 'C:\Apps\DSH-MultiTool\core\home\profiles\headless',
  [string[]]$Plugins = @('dsh-memory', 'dsh-speak', 'dsh-listen', 'dsh-watch', 'dsh-studio', 'dsh-sticker'),
  [switch]$Disable
)

$ErrorActionPreference = 'Stop'
$pkgPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $pkgPath)) { Write-Output "FATAL: $pkgPath not found"; exit 1 }

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

$bundles = New-Object System.Collections.ArrayList
foreach ($b in @($pkg.dsh.profile.bundles)) { [void]$bundles.Add([string]$b) }

$changed = @()
foreach ($p in $Plugins) {
  $installed = Test-Path (Join-Path $ProfileDir "node_modules\$p\package.json")
  if ($Disable) {
    if ($bundles.Contains($p)) { $bundles.Remove($p); $changed += "-$p" }
    continue
  }
  if (-not $installed) { Write-Output "skip $p : not installed under node_modules"; continue }
  if (-not $bundles.Contains($p)) { [void]$bundles.Add($p); $changed += "+$p" }
}

if (-not $changed.Count) {
  Write-Output 'no changes (bundles already up to date)'
} else {
  $pkg.dsh.profile.bundles = @($bundles)
  $json = $pkg | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('bundles updated: ' + ($changed -join ' '))
}
Write-Output '--- current bundles ---'
foreach ($b in @($pkg.dsh.profile.bundles)) { Write-Output "  $b" }
