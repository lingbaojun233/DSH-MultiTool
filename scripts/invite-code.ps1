# Resolve the separator invite code without keeping it in the repo.
#
# Reads ..\secrets\invite-code.txt (relative to the repo root). When the file
# is missing or empty, adopts the legacy ..\secrets\register-code.txt if that
# exists; otherwise generates a random 10-char lowercase code. The resolved
# code is always written back to invite-code.txt, and only that code goes to
# stdout so a caller such as separator\start-server.cmd can capture it with
# for /f.
$ErrorActionPreference = 'Stop'

function Read-Trimmed([string]$Path) {
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  if ($null -eq $raw) { return '' }
  return ([string]$raw).Trim()
}

$root = Split-Path -Parent $PSScriptRoot
$secretsDir = Join-Path $root 'secrets'
$codeFile = Join-Path $secretsDir 'invite-code.txt'
$legacyFile = Join-Path $secretsDir 'register-code.txt'

$code = ''
if (Test-Path -LiteralPath $codeFile) { $code = Read-Trimmed $codeFile }

# Installs made by older versions kept the code in register-code.txt.
if ([string]::IsNullOrEmpty($code) -and (Test-Path -LiteralPath $legacyFile)) {
  $code = Read-Trimmed $legacyFile
}

$needsWrite = $false
if ([string]::IsNullOrEmpty($code)) {
  $alphabet = 'abcdefghijklmnopqrstuvwxyz'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = New-Object byte[] 10
    $rng.GetBytes($bytes)
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($alphabet[$b % 26]) }
    $code = $sb.ToString()
  } finally {
    $rng.Dispose()
  }
  $needsWrite = $true
} elseif (-not (Test-Path -LiteralPath $codeFile)) {
  $needsWrite = $true
}

if ($needsWrite) {
  if (-not (Test-Path -LiteralPath $secretsDir)) {
    New-Item -ItemType Directory -Path $secretsDir -Force | Out-Null
  }
  Set-Content -LiteralPath $codeFile -Value $code -NoNewline -Encoding ASCII
}

[Console]::Out.WriteLine($code)
