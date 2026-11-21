<#
.SYNOPSIS
    DSH-MultiTool one-shot installer for Windows.

.DESCRIPTION
    Turns a freshly extracted release folder into a running DSH-MultiTool host:
    a self-contained DSH core, six DSH plugins, nine always-on services registered
    as scheduled tasks, and a web panel you can open in a browser.

    Everything is idempotent: re-run it to repair an install. Existing secrets and
    hand-tuned service config are never overwritten.

    What it does, in order:
      1. preflight (elevation, target folder)
      2. copy the service folders + core scaffolding to -Root
      3. build the DSH core (portable Node + @deepseek-ai/dsh + headless profile)
      4. install the six plugins from GitHub tarballs, then enable them in the profile
      5. write the secrets templates (internal token, BreezeBlue key, Qwen key)
      6. apply ports and paths to every service
      7. register 9 service tasks + 1 nightly maintenance task
      8. start the tasks and wait for the panel to answer HTTP 200

    ASCII only on purpose: Windows PowerShell 5.1 decodes a BOM-less .ps1 as the
    ANSI code page, so non-ASCII text in this file would mojibake on a Chinese
    Windows install.

.PARAMETER Root
    Install folder. Default C:\Apps\DSH-MultiTool.

.PARAMETER PortBase
    First port of a contiguous block of nine. io=base, panel=+1, memory=+2,
    separator=+3, video=+4, speak=+5, listen=+6, studio=+7, sticker=+8.
    Default 8765. Pass a different base to run a second instance side by side.

.PARAMETER SkipDsh
    Do not build the DSH core. Use when core\runtime and core\app are already in
    place (or supplied with -CoreFrom).

.PARAMETER CoreFrom
    Reuse the core of an existing install instead of downloading Node and dsh.
    runtime\ and app\ are linked (junctions, no copy); profile\package.json and
    home\.env are copied. Useful for offline installs and for testing.

.PARAMETER DshVersion
    Exact @deepseek-ai/dsh version. Default 0.2.2-rc.5 (matches core\bootstrap.ps1).

.PARAMETER NodeVersion
    Exact portable Node.js version. Default 24.22.3.

.PARAMETER NoTasks
    Skip scheduled-task registration; just lay down files and core.

.PARAMETER NoStart
    Register the tasks but do not start them, and skip the health wait.

.PARAMETER Force
    Re-copy files that would otherwise be preserved (service config.json,
    secrets templates). Does not delete data.

.PARAMETER TaskPrefix
    Prefix for the scheduled-task names. Default DSH-MultiTool, giving tasks named
    "DSH-MultiTool IO" etc. Change it to run a second, independent install on the
    same machine without colliding with the first one's tasks.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    .\install.ps1 -Root C:\Apps\DSH-MultiTool-test -PortBase 19000

.EXAMPLE
    .\install.ps1 -CoreFrom C:\Apps\DSH-MultiTool -SkipDsh
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\Apps\DSH-MultiTool',
    [int]$PortBase = 8765,
    [switch]$SkipDsh,
    [string]$CoreFrom,
    [string]$DshVersion = '0.2.2-rc.5',
    [string]$NodeVersion = '24.22.3',
    [switch]$NoTasks,
    [switch]$NoStart,
    [switch]$Force,
    [string]$TaskPrefix = 'DSH-MultiTool'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

$script:Failures = @()

function Write-Head([string]$t) {
    Write-Host ''
    Write-Host ('== ' + $t) -ForegroundColor Cyan
}
function Write-Step([string]$t) { Write-Host ('   ' + $t) }
function Write-Ok([string]$t)   { Write-Host ('   OK  ' + $t) -ForegroundColor Green }
function Write-Warn2([string]$t) { Write-Host ('   !!  ' + $t) -ForegroundColor Yellow; $script:Failures += $t }
function Write-Bad([string]$t)  { Write-Host ('   XX  ' + $t) -ForegroundColor Red;  $script:Failures += $t }

function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Invoke-Native([string]$Exe, [string[]]$ArgList) {
    # Run an external program and stream its output without letting stderr abort us.
    # With $ErrorActionPreference='Stop', a native command writing to stderr becomes
    # a terminating error, and npm writes ordinary warnings to stderr - that alone
    # used to kill an install mid-way.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @ArgList 2>&1
        $code = $LASTEXITCODE
        $out | ForEach-Object { Write-Host ('      ' + $_) }
        return $code
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Stop-OrphanNodeForPorts([int[]]$PortList, [string]$RootPath) {
    # A service is launched as cmd.exe -> node.exe. Stopping or re-registering the
    # task can kill the cmd.exe while node.exe keeps running, still holding the port
    # and its SQLite files. Such a leftover then blocks a re-install (the new process
    # cannot bind) and blocks uninstall (memory.db stays locked).
    #
    # This only ever touches a node.exe that (a) is listening on one of THIS install's
    # ports and (b) has the install folder in its command line. It never enumerates or
    # kills unrelated node processes.
    $stopped = @()
    foreach ($p in $PortList) {
        $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if (-not $conns) { continue }
        foreach ($c in $conns) {
            $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess) -ErrorAction SilentlyContinue
            if (-not $proc) { continue }
            if ($proc.Name -ne 'node.exe') {
                Write-Warn2 ('port ' + $p + ' is held by ' + $proc.Name + ' (pid ' + $proc.ProcessId + '), not this install; leaving it alone')
                continue
            }
            if ($proc.CommandLine -notlike ('*' + $RootPath + '*')) {
                Write-Warn2 ('port ' + $p + ' is held by a node.exe outside ' + $RootPath + '; leaving it alone')
                continue
            }
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-Step ('stopped leftover node pid ' + $proc.ProcessId + ' on port ' + $p)
                $stopped += $proc.ProcessId
            } catch {
                Write-Warn2 ('could not stop pid ' + $proc.ProcessId + ': ' + $_.Exception.Message)
            }
        }
    }
    if ($stopped.Count -gt 0) { Start-Sleep -Seconds 2 }
    return $stopped
}

function New-RandomToken([int]$len) {
    # Cryptographically random alnum, so the internal token and invite code cannot
    # be guessed from one another or from a timestamp.
    $alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] $len
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($alphabet[$b % $alphabet.Length]) }
    return $sb.ToString()
}

function Copy-Tree([string]$From, [string]$To, [string[]]$Preserve) {
    # Copy a folder recursively. Files whose name matches -Preserve are only
    # written when missing, so an upgrade never eats a user's ports or keys.
    if (-not (Test-Path -LiteralPath $From)) { return 0 }
    if (-not (Test-Path -LiteralPath $To)) { New-Item -ItemType Directory -Path $To -Force | Out-Null }
    $n = 0
    Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
        $dst = Join-Path $To $_.Name
        if ($_.PSIsContainer) {
            $n += Copy-Tree -From $_.FullName -To $dst -Preserve $Preserve
        } else {
            $keep = $Preserve -and ($Preserve -contains $_.Name)
            if ($keep -and (Test-Path -LiteralPath $dst) -and -not $Force) { return }
            Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
            $n++
        }
    }
    return $n
}

# ---------------------------------------------------------------------------
# service table: name, folder, port offset, how the port is configured
# ---------------------------------------------------------------------------
$Ports = @{
    io        = $PortBase + 0
    panel     = $PortBase + 1
    memory    = $PortBase + 2
    separator = $PortBase + 3
    video     = $PortBase + 4
    speak     = $PortBase + 5
    listen    = $PortBase + 6
    studio    = $PortBase + 7
    sticker   = $PortBase + 8
}

$Services = @(
    @{ Task = 'IO';        Dir = 'io';        Port = $Ports.io;        PortVia = 'env' }
    @{ Task = 'Panel';     Dir = 'panel';     Port = $Ports.panel;     PortVia = 'env' }
    @{ Task = 'Memory';    Dir = 'memory';    Port = $Ports.memory;    PortVia = 'env' }
    @{ Task = 'Separator'; Dir = 'separator'; Port = $Ports.separator; PortVia = 'env' }
    @{ Task = 'Video';     Dir = 'video';     Port = $Ports.video;     PortVia = 'config' }
    @{ Task = 'Speak';     Dir = 'speak';     Port = $Ports.speak;     PortVia = 'config' }
    @{ Task = 'Listen';    Dir = 'listen';    Port = $Ports.listen;    PortVia = 'config' }
    @{ Task = 'Studio';    Dir = 'studio';    Port = $Ports.studio;    PortVia = 'config' }
    @{ Task = 'Sticker';   Dir = 'sticker';   Port = $Ports.sticker;   PortVia = 'config' }
)

$SentinelStart = 'rem >>> DSH-INSTALLER MANAGED BLOCK - edits below are overwritten >>>'
$SentinelEnd   = 'rem <<< DSH-INSTALLER MANAGED BLOCK <<<'

# ---------------------------------------------------------------------------
# 0. preflight
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'DSH-MultiTool installer' -ForegroundColor White
Write-Host ('   root      : ' + $Root)
Write-Host ('   ports     : ' + $PortBase + '..' + ($PortBase + 8))
Write-Host ('   source    : ' + $PSScriptRoot)

$isAdmin = Test-Admin
Write-Host ('   elevated  : ' + $isAdmin)
if (-not $isAdmin -and -not $NoTasks) {
    Write-Host ''
    Write-Host 'This installer registers services that run as SYSTEM, which needs an elevated shell.' -ForegroundColor Red
    Write-Host 'Right-click PowerShell -> Run as administrator, then run this file again.' -ForegroundColor Red
    Write-Host 'To only lay down files without services, re-run with -NoTasks.' -ForegroundColor Red
    exit 2
}

$SrcRoot = $PSScriptRoot
# Remembered before anything is created: a brand-new install must mint its own
# invite code, while a re-run over an existing install must keep the one users
# already have.
$rootExisted = Test-Path -LiteralPath $Root
if (-not $rootExisted) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Write-Step ('created ' + $Root)
}
$Root = (Resolve-Path -LiteralPath $Root).Path
$sameFolder = ($Root.TrimEnd('\') -eq $SrcRoot.TrimEnd('\'))

# ---------------------------------------------------------------------------
# 1. copy payload
# ---------------------------------------------------------------------------
Write-Head '1/8 copy files'
if ($sameFolder) {
    Write-Step 'install folder is the release folder; nothing to copy'
} else {
    $preserve = @('config.json', 'secrets.json', 'package-lock.json')
    $total = 0
    foreach ($s in $Services) {
        $from = Join-Path $SrcRoot $s.Dir
        if (-not (Test-Path -LiteralPath $from)) { Write-Warn2 ('source missing: ' + $s.Dir); continue }
        $total += Copy-Tree -From $from -To (Join-Path $Root $s.Dir) -Preserve $preserve
    }
    # core scaffolding only: bootstrap.ps1, start-core.ps1, profile\, README.md.
    # runtime\ app\ home\ are built by bootstrap, never copied from the release.
    $coreFiles = @('bootstrap.ps1', 'start-core.ps1', 'start-bootstrap.cmd', 'README.md')
    $coreDst = Join-Path $Root 'core'
    if (-not (Test-Path -LiteralPath $coreDst)) { New-Item -ItemType Directory -Path $coreDst -Force | Out-Null }
    foreach ($f in $coreFiles) {
        $src = Join-Path $SrcRoot ('core\' + $f)
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $coreDst $f) -Force; $total++ }
    }
    $srcProfile = Join-Path $SrcRoot 'core\profile'
    if (Test-Path -LiteralPath $srcProfile) {
        $total += Copy-Tree -From $srcProfile -To (Join-Path $coreDst 'profile') -Preserve @('config.json')
    }
    $srcScripts = Join-Path $SrcRoot 'scripts'
    if (Test-Path -LiteralPath $srcScripts) {
        $total += Copy-Tree -From $srcScripts -To (Join-Path $Root 'scripts')
    }
    Write-Ok ('copied ' + $total + ' files')
}

foreach ($d in @('data', 'logs', 'secrets', 'tmp')) {
    $p = Join-Path $Root $d
    if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

# ---------------------------------------------------------------------------
# 2. DSH core
# ---------------------------------------------------------------------------
Write-Head '2/8 DSH core'
$CoreDir    = Join-Path $Root 'core'
$RuntimeRoot = Join-Path $CoreDir 'runtime'
$RuntimeDir = Join-Path $RuntimeRoot 'node'
$AppDir     = Join-Path $CoreDir 'app'
$HomeDir    = Join-Path $CoreDir 'home'
$ProfileDir = Join-Path $HomeDir 'profiles\headless'
$NodeExe    = Join-Path $RuntimeDir 'node.exe'
$DshBin     = Join-Path $AppDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$NpmCmd     = Join-Path $RuntimeDir 'npm.cmd'

# runtime\ and app\ are skipped here: when -CoreFrom is used they become junctions,
# and creating folders underneath a junction would write into the linked install.
foreach ($d in @($CoreDir, $HomeDir, $ProfileDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

function Get-DshLauncher {
    $lines = @(
        '@echo off',
        'setlocal',
        ('set "DSH_HOME=' + $HomeDir + '"'),
        ('set "PATH=' + $RuntimeDir + ';%PATH%"'),
        ('"' + $NodeExe + '" "' + $DshBin + '" %*')
    )
    Set-Content -LiteralPath (Join-Path $CoreDir 'dsh.cmd') -Value ($lines -join "`r`n") -Encoding ASCII
}

if ($SkipDsh -and -not $CoreFrom) {
    $okNode = Test-Path -LiteralPath $NodeExe
    $okDsh  = Test-Path -LiteralPath $DshBin
    if (-not ($okNode -and $okDsh)) {
        Write-Bad ('-SkipDsh was given but the core is incomplete: node=' + $okNode + ' dsh=' + $okDsh)
    } else {
        Write-Ok 'core already present (-SkipDsh)'
    }
    Get-DshLauncher
} elseif ($CoreFrom) {
    # Reuse an existing core. runtime\ and app\ are read-only for our purposes, so
    # link them instead of copying ~1.5 GB of files. The link target is the core's
    # runtime\ and app\ folder itself (never runtime\node, which would leave
    # node.exe one level too deep and every service unable to start).
    $from = (Resolve-Path -LiteralPath $CoreFrom).Path
    if (-not (Test-Path -LiteralPath (Join-Path $from 'core'))) { $from = Split-Path -Parent $from }
    foreach ($pair in @(@('runtime', $RuntimeRoot), @('app', $AppDir))) {
        $src = Join-Path $from ('core\' + $pair[0])
        if (-not (Test-Path -LiteralPath $src)) { $src = Join-Path $from $pair[0] }
        $dst = $pair[1]
        if (-not (Test-Path -LiteralPath $src)) { Write-Warn2 ('-CoreFrom missing ' + $pair[0] + ': ' + $src); continue }
        if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
        try {
            New-Item -ItemType Junction -Path $dst -Target $src -ErrorAction Stop | Out-Null
            Write-Ok ('linked core\' + $pair[0] + ' -> ' + $src)
        } catch {
            Write-Step ('junction failed for ' + $pair[0] + ', copying instead')
            Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
            Write-Ok ('copied core\' + $pair[0])
        }
    }
    if (-not (Test-Path -LiteralPath $NodeExe)) { Write-Bad ('node.exe not found after linking: ' + $NodeExe) }
    if (-not (Test-Path -LiteralPath $DshBin))  { Write-Bad ('dsh bin.js not found after linking: ' + $DshBin) }
    # profile package.json (plugin list) and the model credentials
    $srcPkg = Join-Path $from 'core\home\profiles\headless\package.json'
    if (-not (Test-Path -LiteralPath $srcPkg)) { $srcPkg = Join-Path $from 'home\profiles\headless\package.json' }
    if (Test-Path -LiteralPath $srcPkg) {
        Copy-Item -LiteralPath $srcPkg -Destination (Join-Path $ProfileDir 'package.json') -Force
        Write-Ok 'profile package.json copied'
    }
    $srcEnv = Join-Path $from 'core\home\.env'
    if (-not (Test-Path -LiteralPath $srcEnv)) { $srcEnv = Join-Path $from 'home\.env' }
    $dstEnv = Join-Path $HomeDir '.env'
    if ((Test-Path -LiteralPath $srcEnv) -and (-not (Test-Path -LiteralPath $dstEnv))) {
        Copy-Item -LiteralPath $srcEnv -Destination $dstEnv -Force
        Write-Ok 'core\home\.env copied (contains your model API key)'
    }
    Get-DshLauncher
} else {
    $bootstrap = Join-Path $CoreDir 'bootstrap.ps1'
    if (-not (Test-Path -LiteralPath $bootstrap)) {
        Write-Bad 'core\bootstrap.ps1 is missing from the release'
    } elseif ((Test-Path -LiteralPath $NodeExe) -and (Test-Path -LiteralPath $DshBin) -and -not $Force) {
        Write-Ok 'core already built (use -Force to rebuild)'
        Get-DshLauncher
    } else {
        Write-Step ('running core\bootstrap.ps1 (node ' + $NodeVersion + ', dsh ' + $DshVersion + ')')
        Write-Step 'this downloads portable Node.js and @deepseek-ai/dsh; expect several minutes'
        $log = Join-Path $CoreDir 'bootstrap.log'
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $bout = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -DshVersion $DshVersion -NodeVersion $NodeVersion 2>&1
            $bcode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevEap
        }
        $bout | ForEach-Object { Write-Host ('      ' + $_) }
        try { $bout | Out-File -FilePath $log -Encoding UTF8 } catch { }
        Write-Step ('bootstrap exit ' + $bcode)
        if (-not (Test-Path -LiteralPath $NodeExe) -or -not (Test-Path -LiteralPath $DshBin)) {
            Write-Bad ('core bootstrap failed; see ' + $log)
        } else {
            Write-Ok 'core built'
        }
        Get-DshLauncher
    }
}

# ---------------------------------------------------------------------------
# 3. plugins
# ---------------------------------------------------------------------------
Write-Head '3/8 plugins'
$PluginNames = @('dsh-memory', 'dsh-speak', 'dsh-listen', 'dsh-watch', 'dsh-studio', 'dsh-sticker')
$PluginUrls = @{
    'dsh-memory'  = 'https://github.com/lingbaojun233/dsh-memory/archive/refs/heads/main.tar.gz'
    'dsh-speak'   = 'https://github.com/lingbaojun233/dsh-speak/archive/refs/heads/main.tar.gz'
    'dsh-listen'  = 'https://github.com/lingbaojun233/dsh-listen/archive/refs/heads/main.tar.gz'
    'dsh-watch'   = 'https://github.com/lingbaojun233/dsh-watch/archive/refs/heads/main.tar.gz'
    'dsh-studio'  = 'https://github.com/lingbaojun233/dsh-studio/archive/refs/heads/main.tar.gz'
    'dsh-sticker' = 'https://github.com/lingbaojun233/dsh-sticker/archive/refs/heads/main.tar.gz'
}

# The profile's package.json is the declared dependency list; make sure it exists
# even when the core came from elsewhere.
$profilePkg = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $profilePkg)) {
    $srcProfilePkg = Join-Path $CoreDir 'profile\headless\package.json'
    if (Test-Path -LiteralPath $srcProfilePkg) {
        Copy-Item -LiteralPath $srcProfilePkg -Destination $profilePkg -Force
        Write-Step 'profile package.json seeded from core\profile'
    } else {
        Write-Bad 'profile package.json not found; cannot install plugins'
    }
}

function Get-MissingPlugins {
    $m = @()
    foreach ($p in $PluginNames) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir ('node_modules\' + $p + '\package.json')))) { $m += $p }
    }
    return $m
}

$missing = @(Get-MissingPlugins)

if ($missing.Count -eq 0 -and -not $Force) {
    Write-Ok 'all six plugins already installed'
} elseif (Test-Path -LiteralPath $NpmCmd) {
    Push-Location -LiteralPath $ProfileDir
    try {
        # Pass one: hand npm the whole set in a single command. It resolves the tree
        # once, and a plugin that fails on its own often still lands because the tree
        # install pulls it in from the declared dependencies.
        if ($missing.Count -gt 0) {
            $urls = @()
            foreach ($p in $missing) { $urls += $PluginUrls[$p] }
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                Write-Step ('npm install (' + $missing.Count + ' plugins, attempt ' + $attempt + '/3)')
                $npmArgs = @('install') + $urls + @('--no-audit', '--no-fund', '--loglevel=error')
                $code = Invoke-Native $NpmCmd $npmArgs
                $missing = @(Get-MissingPlugins)
                if ($missing.Count -eq 0) { break }
                Write-Step ('  exit ' + $code + '; still missing: ' + ($missing -join ', '))
                if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
            }
        }

        # Pass two: anything still absent gets its own command and its own retries.
        $missing = @(Get-MissingPlugins)
        foreach ($p in $missing) {
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                Write-Step ('npm install ' + $p + ' (attempt ' + $attempt + '/3)')
                $code = Invoke-Native $NpmCmd @('install', $PluginUrls[$p], '--no-audit', '--no-fund', '--loglevel=error')
                if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir ('node_modules\' + $p + '\package.json')))) {
                    Write-Step ('  attempt ' + $attempt + ' did not install it (exit ' + $code + ')')
                    if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
                } else { break }
            }
        }
    } finally {
        Pop-Location
    }

    # Trust the files on disk, not npm's exit code: a tree install can succeed for a
    # package even when its own command reported a transient network error.
    $still = @(Get-MissingPlugins)
    foreach ($p in $PluginNames) {
        if ($still -contains $p) { Write-Bad ($p + ' is missing after install (network?)') }
        else { Write-Ok ($p + ' installed') }
    }
} else {
    Write-Bad ('npm.cmd not found at ' + $NpmCmd + '; cannot install plugins')
}

# npm only puts the package on disk. DSH loads a plugin only when its name is in
# package.json -> dsh.profile.bundles, so patch that list too.
$enable = Join-Path $Root 'scripts\enable-plugins.ps1'
if (Test-Path -LiteralPath $enable) {
    Invoke-Native 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $enable, '-ProfileDir', $ProfileDir) | Out-Null
    Write-Ok 'plugin bundle list updated'
} else {
    Write-Warn2 'scripts\enable-plugins.ps1 missing; enable plugins manually'
}

# ---------------------------------------------------------------------------
# 4. secrets
# ---------------------------------------------------------------------------
Write-Head '4/8 secrets'
$SecretsDir = Join-Path $Root 'secrets'
$tokenFile  = Join-Path $SecretsDir 'internal-token.txt'
if (-not (Test-Path -LiteralPath $tokenFile) -or $Force) {
    $tok = New-RandomToken 32
    Set-Content -LiteralPath $tokenFile -Value $tok -Encoding ASCII -NoNewline
    Write-Ok ('internal-token.txt generated (32 chars)')
} else {
    Write-Ok 'internal-token.txt kept'
}

$bbFile = Join-Path $SecretsDir 'breezeblue.key'
if (-not (Test-Path -LiteralPath $bbFile)) {
    Set-Content -LiteralPath $bbFile -Value '' -Encoding ASCII -NoNewline
    Write-Step 'breezeblue.key created empty - fill it in to enable speech'
} else { Write-Ok 'breezeblue.key kept' }

$qwenFile = Join-Path $SecretsDir 'qwen.key'
if (-not (Test-Path -LiteralPath $qwenFile)) {
    Set-Content -LiteralPath $qwenFile -Value '' -Encoding ASCII -NoNewline
    Write-Step 'qwen.key created empty - needed by the video module'
} else { Write-Ok 'qwen.key kept' }

if (-not (Test-Path -LiteralPath (Join-Path $SecretsDir 'README.md'))) {
    @(
        'Secrets for DSH-MultiTool. Never commit this folder.',
        '',
        'internal-token.txt  shared secret between plugins and the io module (generated)',
        'breezeblue.key      BreezeBlue speech API key - fill in to enable text-to-speech',
        'qwen.key            Qwen API key - needed by the video module',
        'invite-code.txt     invite code for the web panel register form (generated)',
        'panel-cert.pass     PFX passphrase for data\panel-cert.pfx (only when HTTPS is on)'
    ) | Set-Content -LiteralPath (Join-Path $SecretsDir 'README.md') -Encoding ASCII
}

$codeFile = Join-Path $SecretsDir 'invite-code.txt'
if (-not (Test-Path -LiteralPath $codeFile) -or $Force) {
    # Re-installing over an existing install must not silently change the code
    # users already have: adopt the legacy register-code.txt, then any value an
    # older installer injected into separator\start-server.cmd. A brand-new
    # install gets a fresh random one. The code never goes into a repo file:
    # separator\start-server.cmd only reads it from this secrets file.
    $adopted = ''
    $legacyFile = Join-Path $SecretsDir 'register-code.txt'
    if ($rootExisted -and -not $Force -and (Test-Path -LiteralPath $legacyFile)) {
        $rawLegacy = Get-Content -LiteralPath $legacyFile -Raw
        if ($null -ne $rawLegacy) { $adopted = ([string]$rawLegacy).Trim() }
    }
    $sepCmd = Join-Path $Root 'separator\start-server.cmd'
    if (-not $adopted -and $rootExisted -and -not $Force -and (Test-Path -LiteralPath $sepCmd)) {
        $m = [regex]::Match((Get-Content -Raw -LiteralPath $sepCmd), 'DSH_REGISTER_CODE=([A-Za-z0-9]{6,})')
        if ($m.Success) { $adopted = $m.Groups[1].Value }
    }
    $code = if ($adopted) { $adopted } else { New-RandomToken 10 }
    Set-Content -LiteralPath $codeFile -Value $code -Encoding ASCII -NoNewline
    Write-Ok ('invite-code.txt ' + $(if ($adopted) { 'adopted existing: ' } else { 'generated: ' }) + $code)
}
$rawInvite = Get-Content -LiteralPath $codeFile -Raw
$InviteCode = if ($null -eq $rawInvite) { '' } else { ([string]$rawInvite).Trim() }

# Model credentials. The DSH core reads DSH_HOME\.env, so this is the one file a
# new user must edit before chatting works.
$envFile = Join-Path $HomeDir '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    @(
        '# Model credentials for the DSH core. Fill in at least DEEPSEEK_API_KEY.',
        'DEEPSEEK_API_KEY=',
        '#DEEPSEEK_BASE_URL=https://api.deepseek.com'
    ) | Set-Content -LiteralPath $envFile -Encoding ASCII
    Write-Step 'core\home\.env created - set DEEPSEEK_API_KEY before chatting'
} else { Write-Ok 'core\home\.env kept' }

$videoSecrets = Join-Path $Root 'video\secrets.json'
if (-not (Test-Path -LiteralPath $videoSecrets)) {
    '{ "apiKey": "" }' | Set-Content -LiteralPath $videoSecrets -Encoding ASCII
}

# ---------------------------------------------------------------------------
# 5. ports and paths
# ---------------------------------------------------------------------------
Write-Head '5/8 ports and paths'
$RootJson = $Root.Replace('\', '\\')     # as it appears inside JSON text
$OldRootJson = 'C:\\Apps\\DSH-MultiTool'  # every shipped config points here

function Set-JsonConfig([string]$file, [hashtable]$values) {
    if (-not (Test-Path -LiteralPath $file)) { Write-Warn2 ('config missing: ' + $file); return }
    $text = Get-Content -Raw -LiteralPath $file
    if (-not $sameFolder) { $text = $text.Replace($OldRootJson, $RootJson) }
    $obj = $text | ConvertFrom-Json
    foreach ($k in $values.Keys) {
        if ($obj.PSObject.Properties.Name -contains $k) { $obj.$k = $values[$k] }
        else { $obj | Add-Member -NotePropertyName $k -NotePropertyValue $values[$k] }
    }
    $json = $obj | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-JsonNested([string]$file, [string]$parent, [hashtable]$values) {
    if (-not (Test-Path -LiteralPath $file)) { return }
    $text = Get-Content -Raw -LiteralPath $file
    if (-not $sameFolder) { $text = $text.Replace($OldRootJson, $RootJson) }
    $obj = $text | ConvertFrom-Json
    if (-not ($obj.PSObject.Properties.Name -contains $parent)) { return }
    $child = $obj.$parent
    foreach ($k in $values.Keys) {
        if ($child.PSObject.Properties.Name -contains $k) { $child.$k = $values[$k] }
        else { $child | Add-Member -NotePropertyName $k -NotePropertyValue $values[$k] }
    }
    [System.IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
}

function Url([int]$port) { return 'http://127.0.0.1:' + $port }

# config.json driven services
Set-JsonConfig (Join-Path $Root 'studio\config.json') @{
    port       = $Ports.studio
    ioUrl      = (Url $Ports.io)
    speakUrl   = (Url $Ports.speak)
    stickerUrl = (Url $Ports.sticker)
    personaUrl = (Url $Ports.memory)
}
Set-JsonNested (Join-Path $Root 'speak\config.json') 'personaVoice' @{
    memoryUrl = (Url $Ports.memory)
    ioUrl     = (Url $Ports.io)
}
Set-JsonConfig (Join-Path $Root 'speak\config.json') @{ port = $Ports.speak }
Set-JsonConfig (Join-Path $Root 'listen\config.json') @{ port = $Ports.listen }
Set-JsonConfig (Join-Path $Root 'video\config.json') @{
    port      = $Ports.video
    listenUrl = (Url $Ports.listen)
}
Set-JsonConfig (Join-Path $Root 'sticker\config.json') @{
    port     = $Ports.sticker
    videoUrl = (Url $Ports.video)
}

# env driven services: rewrite the managed block inside start-server.cmd
function Set-ManagedEnv([string]$dir, [hashtable]$vars) {
    $cmd = Join-Path $Root (Join-Path $dir 'start-server.cmd')
    if (-not (Test-Path -LiteralPath $cmd)) { Write-Warn2 ('start-server.cmd missing: ' + $dir); return }

    $text = Get-Content -Raw -LiteralPath $cmd
    $text = $text.Replace("`r`n", "`n")

    # drop a previous managed block
    $pattern = [regex]::Escape($SentinelStart) + '.*?' + [regex]::Escape($SentinelEnd) + "\n?"
    $text = [regex]::Replace($text, $pattern, '', 'Singleline')

    if ($vars.Count -gt 0) {
        $block = @($SentinelStart)
        foreach ($k in ($vars.Keys | Sort-Object)) {
            $block += ('set "' + $k + '=' + $vars[$k] + '"')
        }
        $block += $SentinelEnd
        $blockText = ($block -join "`n") + "`n"

        # Insert immediately before the node launch line so managed values win over
        # any earlier hardcoded `set` in the same file.
        $lines = $text -split "`n"
        $idx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match 'core\\runtime\\node\\node\.exe') { $idx = $i; break }
        }
        if ($idx -ge 0) {
            $before = ($lines[0..($idx - 1)] -join "`n") + "`n"
            $after  = ($lines[$idx..($lines.Count - 1)] -join "`n")
            $text = $before + $blockText + $after
        } else {
            $text = $text + "`n" + $blockText
        }
    }

    Set-Content -LiteralPath $cmd -Value ($text.Replace("`n", "`r`n")) -Encoding ASCII -NoNewline
}

$commonUrls = @{
    DSH_IO_URL        = (Url $Ports.io)
    DSH_MEMORY_URL    = (Url $Ports.memory)
    DSH_SEPARATOR_URL = (Url $Ports.separator)
    DSH_VIDEO_URL     = (Url $Ports.video)
    DSH_SPEAK_URL     = (Url $Ports.speak)
    DSH_LISTEN_URL    = (Url $Ports.listen)
    DSH_STUDIO_URL    = (Url $Ports.studio)
    DSH_STICKER_URL   = (Url $Ports.sticker)
}

Set-ManagedEnv 'io' @{
    DSH_IO_PORT       = $Ports.io
    DSH_MEMORY_URL    = (Url $Ports.memory)
    DSH_SEPARATOR_URL = (Url $Ports.separator)
}
Set-ManagedEnv 'memory' @{ DSH_MEMORY_PORT = $Ports.memory }
Set-ManagedEnv 'separator' @{
    DSH_SEPARATOR_PORT = $Ports.separator
    DSH_MEMORY_URL     = (Url $Ports.memory)
    DSH_REGISTER_MODE  = 'invite'
}

$panelVars = @{ DSH_PANEL_PORT = $Ports.panel }
foreach ($k in $commonUrls.Keys) { $panelVars[$k] = $commonUrls[$k] }
# HTTPS stays off until the install actually owns a certificate. Without this a
# second install on the same machine would inherit the shipped 8443 and die with
# EADDRINUSE while the first install still holds it.
$panelCert = Join-Path $Root 'data\panel-cert.pfx'
$panelPassFile = Join-Path $SecretsDir 'panel-cert.pass'
if ((-not (Test-Path -LiteralPath $panelCert)) -or (-not (Test-Path -LiteralPath $panelPassFile))) { $panelVars['DSH_PANEL_TLS_PORT'] = '0' }
Set-ManagedEnv 'panel' $panelVars

$portLine = 'ports applied: io=' + $Ports.io + ' panel=' + $Ports.panel + ' memory=' + $Ports.memory + ' separator=' + $Ports.separator + ' video=' + $Ports.video + ' speak=' + $Ports.speak + ' listen=' + $Ports.listen + ' studio=' + $Ports.studio + ' sticker=' + $Ports.sticker
Write-Ok $portLine

# ---------------------------------------------------------------------------
# 6. scheduled tasks
# ---------------------------------------------------------------------------
Write-Head '6/8 scheduled tasks'
if ($NoTasks) {
    Write-Step 'skipped (-NoTasks)'
} else {
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $trigger = New-ScheduledTaskTrigger -AtStartup

    foreach ($s in $Services) {
        $taskName = $TaskPrefix + ' ' + $s.Task
        $cmd = Join-Path $Root ($s.Dir + '\start-server.cmd')
        if (-not (Test-Path -LiteralPath $cmd)) { Write-Bad ('missing ' + $cmd + '; cannot register ' + $taskName); continue }
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            # Stop before unregistering: unregistering a running task abandons its
            # process instead of ending it.
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 400
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        $action = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory (Join-Path $Root $s.Dir)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Description 'DSH-MultiTool service (installed by install.ps1)' -Force | Out-Null
        Write-Step ('registered ' + $taskName + '  port ' + $s.Port)
    }

    # nightly memory consolidation
    $nightlyCmd = Join-Path $Root 'memory\nightly.cmd'
    if (Test-Path -LiteralPath $nightlyCmd) {
        $nName = $TaskPrefix + ' Memory Nightly'
        if (Get-ScheduledTask -TaskName $nName -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $nName -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 400
            Unregister-ScheduledTask -TaskName $nName -Confirm:$false
        }
        $nSet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
            -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
        $nTrig = New-ScheduledTaskTrigger -Daily -At '03:00'
        $nAct = New-ScheduledTaskAction -Execute $nightlyCmd -WorkingDirectory (Join-Path $Root 'memory')
        Register-ScheduledTask -TaskName $nName -Action $nAct -Trigger $nTrig -Settings $nSet `
            -Principal $principal -Description 'DSH-MultiTool nightly memory consolidation' -Force | Out-Null
        Write-Step ('registered ' + $nName + '  daily 03:00')
    } else {
        Write-Warn2 'memory\nightly.cmd missing; nightly task not registered'
    }
    Write-Ok '10 tasks registered'
}

# ---------------------------------------------------------------------------
# 7. start + health
# ---------------------------------------------------------------------------
Write-Head '7/8 start services'
if ($NoTasks -or $NoStart) {
    Write-Step 'skipped'
} else {
    # Clear leftovers from a previous run first, otherwise the new process loses the
    # bind race with the old one and the task silently falls back to Ready.
    Write-Step 'checking for leftover service processes ...'
    Stop-OrphanNodeForPorts @($Ports.Values) $Root | Out-Null

    foreach ($s in $Services) {
        $taskName = $TaskPrefix + ' ' + $s.Task
        if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { continue }
        try {
            Start-ScheduledTask -TaskName $taskName
            Write-Step ('started ' + $taskName)
        } catch { Write-Bad ('could not start ' + $taskName + ': ' + $_.Exception.Message) }
    }

    Write-Step 'waiting for the panel to answer ...'
    $panelUrl = 'http://127.0.0.1:' + $Ports.panel + '/'
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try {
            $r = Invoke-WebRequest -Uri $panelUrl -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if ($ready) { Write-Ok ('panel HTTP 200 at ' + $panelUrl) }
    else { Write-Bad ('panel did not answer 200 at ' + $panelUrl + ' within 60s; see logs\panel.log') }

    Write-Step 'port check:'
    foreach ($s in $Services) {
        $hit = $false
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $iar = $c.BeginConnect('127.0.0.1', $s.Port, $null, $null)
            $hit = $iar.AsyncWaitHandle.WaitOne(1500, $false)
            if ($hit) { $c.EndConnect($iar) }
            $c.Close()
        } catch { $hit = $false }
        if ($hit) { Write-Host ('      ' + $s.Task.PadRight(10) + ' ' + $s.Port + '  listening') -ForegroundColor Green }
        else { Write-Host ('      ' + $s.Task.PadRight(10) + ' ' + $s.Port + '  NOT listening') -ForegroundColor Yellow }
    }
}

# ---------------------------------------------------------------------------
# 8. summary
# ---------------------------------------------------------------------------
Write-Head '8/8 done'
$panelPort = $Ports.panel
Write-Host ''
Write-Host 'Open the panel:' -ForegroundColor White
Write-Host ('   http://127.0.0.1:' + $panelPort + '/') -ForegroundColor Green
Write-Host ('   LAN:  http://<this-machine-ip>:' + $panelPort + '/   (HTTP is bound to 127.0.0.1 by default; use an SSH tunnel or set -PortBase plus a reverse proxy for remote access)')
Write-Host ''
Write-Host 'Invite code for the register form:' -ForegroundColor White
Write-Host ('   ' + $InviteCode + '     (also in ' + $codeFile + ')') -ForegroundColor Green
Write-Host ''
Write-Host 'Still manual, in this order:' -ForegroundColor White
Write-Host ('   1. put your model key in ' + $envFile + '  (DEEPSEEK_API_KEY=sk-...)')
Write-Host ('   2. speech (optional): put a BreezeBlue key in ' + $bbFile)
Write-Host ('   3. video (optional): put a Qwen key in ' + $qwenFile + ' or ' + (Join-Path $Root 'video\secrets.json'))
Write-Host ('   4. video rendering needs ffmpeg at ' + (Join-Path $Root 'tools\ffmpeg\bin\ffmpeg.exe'))
Write-Host ('   5. sign out and back in (or restart) for the AtStartup tasks to be visible in Task Scheduler')
Write-Host ''
Write-Host 'Management:' -ForegroundColor White
Write-Host ('   logs   : ' + (Join-Path $Root 'logs'))
Write-Host ('   restart: Get-ScheduledTask -TaskName "' + $TaskPrefix + ' *" | Start-ScheduledTask')
Write-Host ('   remove  : powershell -File .\uninstall.ps1 -Root ' + $Root)
Write-Host ''

if ($script:Failures.Count -gt 0) {
    Write-Host ('Finished with ' + $script:Failures.Count + ' warning(s):') -ForegroundColor Yellow
    $script:Failures | ForEach-Object { Write-Host ('   - ' + $_) -ForegroundColor Yellow }
    exit 1
}
Write-Host 'Install complete.' -ForegroundColor Green
exit 0
