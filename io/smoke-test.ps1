<#
.SYNOPSIS
    Smoke-test the IO module against the local DSH core.

.DESCRIPTION
    Starts io.js with the .NET process API instead of cmd.exe: no shell quoting,
    no inherited WinRM pipe, UTF-8 in and out. Prints one compact JSON line:

        {"exitCode":0,"answer":"...","stderr":"..."}

.EXAMPLE
    powershell -NoProfile -File io\smoke-test.ps1
    powershell -NoProfile -File io\smoke-test.ps1 -TaskFile C:\Apps\DSH-MultiTool\core\task.txt
#>
[CmdletBinding()]
param(
    [string]$TaskFile,
    [string]$CoreDir
)

$ErrorActionPreference = 'Stop'

$ioDir = $PSScriptRoot
if (-not $CoreDir) { $CoreDir = Join-Path (Split-Path -Parent $ioDir) 'core' }

$node = Join-Path $CoreDir 'runtime\node\node.exe'
$ioJs = Join-Path $ioDir 'io.js'
$dshHome = Join-Path $CoreDir 'home'

if (-not $TaskFile) { $TaskFile = Join-Path $CoreDir 'task.txt' }
if (-not (Test-Path -LiteralPath $TaskFile)) {
    $TaskFile = Join-Path $env:TEMP ('dsh-task-' + [guid]::NewGuid().ToString('N') + '.txt')
    Set-Content -LiteralPath $TaskFile -Value 'Reply with exactly: OK' -Encoding UTF8
}

foreach ($required in @($node, $ioJs)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "missing: $required" }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = '"' + $ioJs + '" send --file "' + $TaskFile + '"'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$psi.EnvironmentVariables['DSH_HOME'] = $dshHome

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$process = [System.Diagnostics.Process]::Start($psi)
$stderrTask = $process.StandardError.ReadToEndAsync()
$stdoutText = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
$stderrText = $stderrTask.Result
$watch.Stop()

$result = [pscustomobject]@{
    exitCode = $process.ExitCode
    seconds  = [math]::Round($watch.Elapsed.TotalSeconds, 1)
    answer   = $stdoutText.Trim()
    stderr   = $stderrText.Trim()
}
$result | ConvertTo-Json -Compress
exit $process.ExitCode
