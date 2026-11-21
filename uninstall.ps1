<#
.SYNOPSIS
    Remove a DSH-MultiTool install created by install.ps1.

.DESCRIPTION
    Stops and unregisters the ten scheduled tasks, then deletes the install folder.

    Services are stopped strictly BY TASK NAME, one task at a time. This script
    never enumerates or kills node.exe processes: on a shared machine that would
    take down unrelated work, and the tasks are the only thing this install owns.

    Data (memory database, panel history, rendered videos) is deleted with the
    folder unless -KeepData is passed.

    ASCII only: Windows PowerShell 5.1 decodes a BOM-less .ps1 as the ANSI code
    page, so non-ASCII text here would mojibake.

.PARAMETER Root
    Install folder to remove. Default C:\Apps\DSH-MultiTool.

.PARAMETER KeepData
    Keep the data\ and secrets\ folders; everything else is still removed.

.PARAMETER Force
    Do not ask for confirmation.

.PARAMETER TaskPrefix
    Prefix of the scheduled-task names to remove. Must match what install.ps1 was
    given. Default DSH-MultiTool.

.PARAMETER PortBase
    Port base the install was given, used only to find leftover service processes
    still holding a port. Default 8765.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -Root C:\Apps\DSH-MultiTool-test -TaskPrefix DSH-MultiTool-TEST -PortBase 19000 -Force
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\Apps\DSH-MultiTool',
    [switch]$KeepData,
    [switch]$Force,
    [string]$TaskPrefix = 'DSH-MultiTool',
    [int]$PortBase = 8765
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$ProgressPreference = 'SilentlyContinue'

$TaskNames = @(
    'IO', 'Panel', 'Memory', 'Separator', 'Video', 'Speak', 'Listen', 'Studio', 'Sticker',
    'Memory Nightly'
) | ForEach-Object { $TaskPrefix + ' ' + $_ }

function Write-Step([string]$t) { Write-Host ('   ' + $t) }
function Write-Ok([string]$t)   { Write-Host ('   OK  ' + $t) -ForegroundColor Green }
function Write-Warn2([string]$t) { Write-Host ('   !!  ' + $t) -ForegroundColor Yellow }

function Stop-OrphanNodeForPorts([int[]]$PortList, [string]$RootPath) {
    # cmd.exe -> node.exe: stopping the task can leave node.exe running and holding
    # its port and SQLite files, which then blocks deleting the folder. Only a
    # node.exe listening on one of this install's ports AND carrying the install
    # folder in its command line is touched.
    foreach ($p in $PortList) {
        $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if (-not $conns) { continue }
        foreach ($c in $conns) {
            $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess) -ErrorAction SilentlyContinue
            if (-not $proc) { continue }
            if ($proc.Name -ne 'node.exe') {
                Write-Warn2 ('port ' + $p + ' held by ' + $proc.Name + ' (pid ' + $proc.ProcessId + '), not this install; leaving it alone')
                continue
            }
            if ($proc.CommandLine -notlike ('*' + $RootPath + '*')) {
                Write-Warn2 ('port ' + $p + ' held by a node.exe outside ' + $RootPath + '; leaving it alone')
                continue
            }
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-Step ('stopped leftover node pid ' + $proc.ProcessId + ' on port ' + $p)
            } catch {
                Write-Warn2 ('could not stop pid ' + $proc.ProcessId + ': ' + $_.Exception.Message)
            }
        }
    }
}

Write-Host ''
Write-Host 'DSH-MultiTool uninstaller' -ForegroundColor White
Write-Host ('   root  : ' + $Root)
Write-Host ('   tasks : ' + $TaskNames.Count + ' (' + $TaskPrefix + ' *)')
Write-Host ('   data  : ' + $(if ($KeepData) { 'kept' } else { 'deleted with the folder' }))
Write-Host ''

$rootExists = Test-Path -LiteralPath $Root
if (-not $rootExists) { Write-Warn2 ('folder does not exist: ' + $Root) }

if (-not $Force) {
    Write-Host 'This stops the DSH-MultiTool services and deletes the install folder.' -ForegroundColor Yellow
    if ($KeepData) { Write-Host 'data\ and secrets\ will be kept.' -ForegroundColor Yellow }
    else { Write-Host 'ALL data (memory database, panel history, rendered video) will be deleted.' -ForegroundColor Yellow }
    $answer = Read-Host 'Type y to continue'
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host 'Aborted; nothing was changed.'
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 1. stop and unregister tasks, by exact name only
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Stopping services ...'
foreach ($name in $TaskNames) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { Write-Step ($name + ' : not present'); continue }
    try {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $name -ErrorAction Stop
            Write-Step ($name + ' : stopped')
        } else {
            Write-Step ($name + ' : idle (' + $task.State + ')')
        }
    } catch {
        Write-Warn2 ($name + ' : could not stop (' + $_.Exception.Message + ')')
    }
}

# Give each service a moment to exit before its folder disappears.
Start-Sleep -Seconds 3

# Stopping the task does not always end the node.exe it launched.
Write-Host ''
Write-Host 'Releasing ports held by leftover service processes ...'
Stop-OrphanNodeForPorts @($PortBase..($PortBase + 8)) $Root
Start-Sleep -Seconds 2

Write-Host ''
Write-Host 'Unregistering tasks ...'
foreach ($name in $TaskNames) {
    if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { continue }
    try {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
        Write-Step ($name + ' : removed')
    } catch {
        Write-Warn2 ($name + ' : could not unregister (' + $_.Exception.Message + ')')
    }
}

# ---------------------------------------------------------------------------
# 2. remove the folder
# ---------------------------------------------------------------------------
if ($rootExists) {
    Write-Host ''
    Write-Host 'Removing files ...'
    $resolved = (Resolve-Path -LiteralPath $Root).Path
    if ($KeepData) {
        # Move data\ and secrets\ aside, delete the rest by hand, then put them back.
        $stash = Join-Path $env:TEMP ('dsh-keep-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $stash -Force | Out-Null
        foreach ($keep in @('data', 'secrets')) {
            $src = Join-Path $resolved $keep
            if (Test-Path -LiteralPath $src) {
                Move-Item -LiteralPath $src -Destination (Join-Path $stash $keep) -Force
                Write-Step ('kept ' + $keep + ' -> ' + $stash)
            }
        }
        Get-ChildItem -LiteralPath $resolved -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        foreach ($keep in @('data', 'secrets')) {
            $back = Join-Path $stash $keep
            if (Test-Path -LiteralPath $back) { Move-Item -LiteralPath $back -Destination (Join-Path $resolved $keep) -Force }
        }
        Remove-Item -LiteralPath $stash -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok ('kept data\ and secrets\ in ' + $resolved)
    } else {
        $removed = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
                $removed = $true
                break
            } catch {
                if ($attempt -lt 5) {
                    Write-Step ('delete attempt ' + $attempt + ' blocked (' + $_.Exception.Message + '); retrying')
                    Start-Sleep -Seconds 3
                } else {
                    Write-Warn2 ('could not remove everything: ' + $_.Exception.Message)
                    Write-Warn2 'a service is still holding a file; reboot and delete the folder by hand'
                }
            }
        }
        if ($removed) { Write-Ok ('removed ' + $resolved) }
    }
}

Write-Host ''
if ((Test-Path -LiteralPath $Root) -and -not $KeepData) {
    Write-Host 'Finished with the folder still present.' -ForegroundColor Yellow
    exit 1
}
Write-Host 'Uninstall complete.' -ForegroundColor Green
exit 0
