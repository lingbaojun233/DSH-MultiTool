# DSH-MultiTool :: listen :: asr.ps1
#
# Windows SAPI (System.Speech) speech-to-text.
#
# ASCII ONLY, on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
# so any non-ASCII byte in here would come out as mojibake. Keep comments English.
#
# Usage:
#   asr.ps1 -List                                    -> recognizers as JSON on stdout
#   asr.ps1 -In in.wav -Out out.txt [-Recognizer id]  -> text as UTF-8 (no BOM) file
#
# Exit codes: 0 ok, 2 bad input, 3 no recognizer, 4 recognition error, 5 write error.
#
# Notes:
#   * SetInputToWaveFile only decodes WAV; the caller converts webm/ogg/mp4 first.
#   * Recognize() returns $null at end of stream, so we loop until $null.
#   * Dictation is free-form, no grammar to build; accuracy is what it is.
#   * Under the SYSTEM account CurrentUICulture may be en-US, so the engine is
#     constructed from an explicit RecognizerInfo instead of the default one.

[CmdletBinding()]
param(
    [string]$In = '',
    [string]$Out = '',
    [string]$Recognizer = '',
    [switch]$List
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Speech
} catch {
    [Console]::Error.WriteLine('ASSEMBLY_LOAD_FAILED: ' + $_.Exception.Message)
    exit 3
}

function Get-RecognizerList {
    $items = New-Object System.Collections.ArrayList
    foreach ($ri in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
        $entry = [pscustomobject]@{
            id      = [string]$ri.Id
            culture = [string]$ri.Culture.Name
            name    = [string]$ri.Name
        }
        [void]$items.Add($entry)
    }
    return $items
}

if ($List) {
    $items = Get-RecognizerList
    $json = ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
    [Console]::Out.WriteLine($json)
    exit 0
}

if (-not $In) {
    [Console]::Error.WriteLine('NO_INPUT')
    exit 2
}
if (-not (Test-Path -LiteralPath $In -PathType Leaf)) {
    [Console]::Error.WriteLine('INPUT_NOT_FOUND: ' + $In)
    exit 2
}
$inFile = (Resolve-Path -LiteralPath $In).ProviderPath
$info = Get-Item -LiteralPath $inFile
if ($info.Length -lt 44) {
    [Console]::Error.WriteLine('INPUT_TOO_SMALL: ' + $info.Length + ' bytes')
    exit 2
}

$available = Get-RecognizerList
if ($available.Count -eq 0) {
    [Console]::Error.WriteLine('NO_RECOGNIZER_INSTALLED')
    exit 3
}

# Pick: explicit -Recognizer id > zh-CN > first installed.
$picked = $null
if ($Recognizer) {
    foreach ($candidate in $available) {
        if ($candidate.id -eq $Recognizer) { $picked = $candidate; break }
    }
}
if (-not $picked) {
    foreach ($candidate in $available) {
        if ($candidate.culture -eq 'zh-CN') { $picked = $candidate; break }
    }
}
if (-not $picked) { $picked = $available[0] }

$target = $null
foreach ($ri in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
    if ([string]$ri.Id -eq $picked.id) { $target = $ri; break }
}
if (-not $target) {
    [Console]::Error.WriteLine('RECOGNIZER_LOOKUP_FAILED: ' + $picked.id)
    exit 3
}

$engine = $null
try {
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($target)
    $engine.SetInputToWaveFile($inFile)
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    [void]$engine.LoadGrammar($grammar)

    $parts = New-Object System.Collections.Generic.List[string]
    $confidences = New-Object System.Collections.Generic.List[double]
    $loopError = $null
    while ($true) {
        $result = $null
        try {
            $result = $engine.Recognize()
        } catch {
            # SAPI is documented to return $null at end of stream, but in practice
            # it often throws "No audio input is supplied" once the wave file is
            # exhausted (it detaches the input, the next call sees none).
            # Treat that as end-of-audio and keep what we already recognised.
            $loopError = $_.Exception.Message
            break
        }
        if ($null -eq $result) { break }
        $chunk = [string]$result.Text
        if ($chunk -and $chunk.Trim().Length -gt 0) {
            $parts.Add($chunk.Trim())
            $confidences.Add([double]$result.Confidence)
        }
        if ($parts.Count -ge 500) { break }
    }
    if ($parts.Count -eq 0 -and $loopError) {
        [Console]::Error.WriteLine('RECOGNIZE_FAILED: ' + $loopError)
        try { $engine.Dispose() } catch { }
        exit 4
    }
} catch {
    [Console]::Error.WriteLine('RECOGNIZE_FAILED: ' + $_.Exception.Message)
    if ($engine) { try { $engine.Dispose() } catch { } }
    exit 4
}

try { $engine.Dispose() } catch { }

# Join without a separator: Chinese dictation comes back as phrase chunks and
# inserting spaces would look wrong. Callers that need segments get the count.
$text = ($parts -join '').Trim()
$avg = 0
if ($confidences.Count -gt 0) {
    $sum = 0.0
    foreach ($c in $confidences) { $sum += $c }
    $avg = [math]::Round($sum / $confidences.Count, 3)
}

if ($Out) {
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Out, $text, $utf8)
    } catch {
        [Console]::Error.WriteLine('WRITE_FAILED: ' + $_.Exception.Message)
        exit 5
    }
}

$meta = [pscustomobject]@{
    ok         = $true
    segments   = $parts.Count
    chars      = $text.Length
    confidence = $avg
    recognizer = $picked.id
    culture    = $picked.culture
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $meta -Depth 3 -Compress))
exit 0
