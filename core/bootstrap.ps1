<#
.SYNOPSIS
    Install or repair the DSH core of DSH-MultiTool on this machine.

.DESCRIPTION
    Builds a self-contained core folder:

        core\runtime\node\   portable Node.js LTS
        core\app\            node_modules with @deepseek-ai/dsh
        core\home\           DSH_HOME: profiles, sessions, .env
        core\dsh.cmd         launcher wrapper

    Idempotent: re-run to repair, or pass -Force to reinstall.

    Mirrors matter: on a mainland-China host nodejs.org is often reset mid-
    connection, so downloads try -NodeMirrors in order and the npm install uses
    -NpmRegistry first. Every attempt is logged with the URL used.

    The DeepSeek API key is NOT handled here; put it in core\home\.env as
    DEEPSEEK_API_KEY=... (see core\README.md).

.PARAMETER DshVersion
    Exact @deepseek-ai/dsh version to install. Must match the desktop build.

.PARAMETER NodeVersion
    Exact Node.js version to download as the portable win-x64 zip.

.PARAMETER Force
    Re-download Node.js and reinstall dsh even when already present.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File core\bootstrap.ps1
#>
[CmdletBinding()]
param(
    [string]$DshVersion = '0.2.2-rc.5',
    [string]$NodeVersion = '24.22.3',
    [string[]]$NodeMirrors = @(
        'https://npmmirror.com/mirrors/node',
        'https://mirrors.huaweicloud.com/nodejs',
        'https://nodejs.org/dist'
    ),
    [string]$NpmRegistry = 'https://registry.npmmirror.com',
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# No console handle exists when this runs under WinRM; never let that kill the run.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$CoreDir    = $PSScriptRoot
$RuntimeDir = Join-Path $CoreDir 'runtime\node'
$AppDir     = Join-Path $CoreDir 'app'
$HomeDir    = Join-Path $CoreDir 'home'
$TmpDir     = Join-Path $CoreDir '.download'
$StatusFile = Join-Path $CoreDir 'bootstrap-status.json'

function Write-Step { param([string]$Text) Write-Host ('[core] ' + $Text) }
function Write-Fail { param([string]$Text) Write-Host ('[core] FAILED: ' + $Text) -ForegroundColor Red }

function Get-NodePortable {
    param([string]$Version, [string]$Dest, [string]$Tmp, [string[]]$Mirrors)

    $zipName = 'node-v' + $Version + '-win-x64.zip'
    if (-not (Test-Path -LiteralPath $Tmp)) { New-Item -ItemType Directory -Path $Tmp -Force | Out-Null }
    $zipPath = Join-Path $Tmp $zipName
    $lastError = 'no mirror attempted'

    foreach ($mirror in $Mirrors) {
        $url = $mirror.TrimEnd('/') + '/v' + $Version + '/' + $zipName
        Write-Step "downloading $url"
        try {
            if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 900
            if ((Get-Item -LiteralPath $zipPath).Length -lt 10MB) { throw 'downloaded file is too small to be a node archive' }
            $lastError = $null
            break
        } catch {
            $lastError = $_.Exception.Message
            Write-Step ('  mirror failed: ' + $lastError)
        }
    }

    if ($lastError) { throw "could not download node v$Version from any mirror: $lastError" }

    Write-Step 'extracting ...'
    $inner = Join-Path $Tmp ('node-v' + $Version + '-win-x64')
    Expand-Archive -LiteralPath $zipPath -DestinationPath $Tmp -Force
    Copy-Item -Path (Join-Path $inner '*') -Destination $Dest -Recurse -Force
    Remove-Item -LiteralPath $inner -Recurse -Force
    Remove-Item -LiteralPath $zipPath -Force
}

function Install-DshPackage {
    param([string]$Version, [string]$AppDir, [string]$NpmCmd, [string]$Registry)

    $appPkg = Join-Path $AppDir 'package.json'
    '{ "name": "dsh-core-app", "private": true, "version": "0.0.0" }' | Set-Content -LiteralPath $appPkg -Encoding ASCII

    $spec = "@deepseek-ai/dsh@$Version"
    Write-Step "npm install $spec via $Registry ..."
    & $NpmCmd --prefix $AppDir install $spec --registry $Registry --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -eq 0) { return }

    Write-Step '  mirror registry failed, retrying against the default registry ...'
    & $NpmCmd --prefix $AppDir install $spec --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
}

$startedAt = Get-Date
try {
    foreach ($dir in @($CoreDir, $RuntimeDir, $AppDir, $HomeDir)) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }

    # ---- 1. portable Node.js -------------------------------------------------
    $nodeExe = Join-Path $RuntimeDir 'node.exe'
    if ($Force -or -not (Test-Path -LiteralPath $nodeExe)) {
        Get-NodePortable -Version $NodeVersion -Dest $RuntimeDir -Tmp $TmpDir -Mirrors $NodeMirrors
        Write-Step ('node v' + $NodeVersion + ' installed')
    } else {
        Write-Step 'portable node already present'
    }

    # ---- 2. @deepseek-ai/dsh -------------------------------------------------
    $dshBin = Join-Path $AppDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    $dshManifest = Join-Path $AppDir 'node_modules\@deepseek-ai\dsh\package.json'
    $installed = $null
    if (Test-Path -LiteralPath $dshManifest) {
        $installed = (Get-Content -LiteralPath $dshManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
    }

    if ($Force -or $installed -ne $DshVersion) {
        Write-Step "installing @deepseek-ai/dsh@$DshVersion (this takes a few minutes) ..."
        Install-DshPackage -Version $DshVersion -AppDir $AppDir -NpmCmd (Join-Path $RuntimeDir 'npm.cmd') -Registry $NpmRegistry
    } else {
        Write-Step "dsh $installed already installed"
    }

    # ---- 3. headless profile -------------------------------------------------
    $profileSrc = Join-Path $CoreDir 'profile\headless'
    $profileDst = Join-Path $HomeDir 'profiles\headless'
    if (Test-Path -LiteralPath $profileSrc) {
        if (-not (Test-Path -LiteralPath $profileDst)) { New-Item -ItemType Directory -Path $profileDst -Force | Out-Null }
        Get-ChildItem -LiteralPath $profileSrc -Force -File | ForEach-Object {
            $target = Join-Path $profileDst $_.Name
            if ($Force -or -not (Test-Path -LiteralPath $target)) {
                Copy-Item -LiteralPath $_.FullName -Destination $target -Force
            }
        }
        Write-Step ('profile ready: ' + $profileDst)
    }

    # ---- 4. launcher wrapper -------------------------------------------------
    # Build each line inside parentheses and join with explicit CRLF: a bare
    # `@('a' + $x + 'b')` array can be flattened into one line per token, which
    # produces a cmd file whose quoted values are split across lines.
    $launcherLines = @(
        '@echo off',
        'setlocal',
        ('set "DSH_HOME=' + $HomeDir + '"'),
        ('set "PATH=' + $RuntimeDir + ';%PATH%"'),
        ('"' + $nodeExe + '" "' + $dshBin + '" %*')
    )
    $launcherText = $launcherLines -join "`r`n"
    Set-Content -LiteralPath (Join-Path $CoreDir 'dsh.cmd') -Value $launcherText -Encoding ASCII
    Write-Step ('launcher written: ' + (Join-Path $CoreDir 'dsh.cmd'))

    # ---- 5. verify -----------------------------------------------------------
    Write-Step 'verifying ...'
    $nodeVersion = (& $nodeExe --version 2>&1 | Out-String).Trim()
    $env:DSH_HOME = $HomeDir
    $dshVersion = (& $nodeExe $dshBin --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "dsh --version failed: $dshVersion" }

    $status = [pscustomobject]@{
        ok         = $true
        coreDir    = $CoreDir
        dshHome    = $HomeDir
        node       = $nodeVersion
        dsh        = $dshVersion
        startedAt  = $startedAt.ToString('s')
        finishedAt = (Get-Date).ToString('s')
    }
    $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatusFile -Encoding UTF8

    Write-Step ('OK  node=' + $nodeVersion + '  dsh=' + $dshVersion)
    exit 0
}
catch {
    $message = $_.Exception.Message
    Write-Fail $message
    [pscustomobject]@{
        ok         = $false
        coreDir    = $CoreDir
        error      = $message
        finishedAt = (Get-Date).ToString('s')
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatusFile -Encoding UTF8
    exit 1
}
