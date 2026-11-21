# tts-winrt.ps1 -- speech synthesis through Windows.Media.SpeechSynthesis (OneCore voices).
#
# SAPI only lists Huihui; the OneCore set also has Yaoyao (younger female) and Kangkang (male).
# Kept deliberately minimal: no SSML, no prosody -- every extra WinRT call is another way to
# fail silently under PowerShell 5.1. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$VoiceMatch = 'Yaoyao'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
if (-not $asTaskGeneric) { Write-Output '{"ok":false,"error":"NO_AWAIT_HELPER"}'; exit 1 }

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  [void]$t.Wait(-1)
  if ($t.IsFaulted) { throw ($t.Exception.GetBaseException()) }
  return $t.Result
}

$text = [System.IO.File]::ReadAllText($InFile, [System.Text.Encoding]::UTF8).Trim()
if (-not $text) { Write-Output '{"ok":false,"error":"EMPTY_TEXT"}'; exit 1 }

$syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voiceName = ''
$wanted = $null
$zh = $null
$first = $null
foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
  if (-not $first) { $first = $v }
  if (-not $zh -and $v.Language -like 'zh*') { $zh = $v }
  if ($v.DisplayName -like "*$VoiceMatch*") { $wanted = $v }
}
$picked = $wanted
if (-not $picked) { $picked = $zh }
if (-not $picked) { $picked = $first }
if (-not $picked) { Write-Output '{"ok":false,"error":"NO_VOICE"}'; exit 1 }
$syn.Voice = $picked
$voiceName = $picked.DisplayName

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$stream = Await ($syn.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
if (-not $stream) { Write-Output '{"ok":false,"error":"NO_STREAM"}'; exit 1 }

$size = [int]$stream.Size
if ($size -le 0) { Write-Output '{"ok":false,"error":"EMPTY_STREAM"}'; exit 1 }

$reader = New-Object Windows.Storage.Streams.DataReader($stream)
[void](Await ($reader.LoadAsync([uint32]$size)) ([uint32]))
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
$reader.Dispose()
$stream.Dispose()
$sw.Stop()

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllBytes($OutFile, $bytes)

Write-Output ([ordered]@{
  ok    = $true
  voice = $voiceName
  ms    = $sw.ElapsedMilliseconds
  bytes = $bytes.Length
  chars = $text.Length
} | ConvertTo-Json -Compress)
