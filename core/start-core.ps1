<#
.SYNOPSIS
    Launch core\bootstrap.ps1 fully detached from the caller.

.DESCRIPTION
    WinRM runs commands inside a session whose stdout pipe stays open as long as
    any child inherits it, so `start /b` from Invoke-Command hangs the caller.
    Win32_Process.Create hands the process to WMI, which owns no pipe from the
    calling session: the call returns immediately and the installer keeps running.
#>
[CmdletBinding()]
param([string]$CoreDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'

$bootstrap = Join-Path $CoreDir 'bootstrap.ps1'
$log = Join-Path $CoreDir 'bootstrap.log'
$status = Join-Path $CoreDir 'bootstrap-status.json'

if (-not (Test-Path -LiteralPath $bootstrap)) { throw "bootstrap.ps1 not found in $CoreDir" }
if (Test-Path -LiteralPath $status) { Remove-Item -LiteralPath $status -Force }

$commandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $bootstrap + '" >> "' + $log + '" 2>&1'
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($result.ReturnValue)" }

Write-Output ('[start] pid=' + $result.ProcessId)
Write-Output ('[start] log=' + $log)
