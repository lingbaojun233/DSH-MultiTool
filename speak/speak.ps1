# speak.ps1 -- text to speech via Windows SAPI (offline).
#
# The text arrives through a UTF-8 file, never through the command line: Chinese plus
# quotes on argv gets mangled between shells. ASCII only -- PS 5.1 reads BOM-less
# .ps1 files as ANSI, so non-ASCII here would break.
param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Voice = '',
  [int]$Rate = -1
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($InFile, [System.Text.Encoding]::UTF8).Trim()
if (-not $text) { Write-Output '{"ok":false,"error":"EMPTY_TEXT"}'; exit 1 }

$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($syn.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo })
  $picked = $null
  if ($Voice) {
    foreach ($v in $voices) {
      if ($v.Name -eq $Voice) { $picked = $v; break }
    }
  }
  if (-not $picked) {
    # Prefer a Chinese voice, otherwise take the first installed one.
    foreach ($v in $voices) { if ($v.Culture.Name -like 'zh*') { $picked = $v; break } }
  }
  if (-not $picked -and $voices.Count -gt 0) { $picked = $voices[0] }
  if (-not $picked) { Write-Output '{"ok":false,"error":"NO_VOICE"}'; exit 1 }

  $syn.SelectVoice($picked.Name)
  $syn.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))

  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $syn.SetOutputToWaveFile($OutFile)
  $syn.Speak($text)
  $syn.SetOutputToNull()
  $sw.Stop()

  $size = (Get-Item $OutFile).Length
  $payload = [ordered]@{
    ok     = $true
    voice  = $picked.Name
    culture = $picked.Culture.Name
    ms     = $sw.ElapsedMilliseconds
    bytes  = $size
    chars  = $text.Length
  }
  Write-Output ($payload | ConvertTo-Json -Compress)
} finally {
  $syn.Dispose()
}
