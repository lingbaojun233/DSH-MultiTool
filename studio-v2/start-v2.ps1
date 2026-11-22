# studio-v2 launcher: create a detached process through WMI so it survives the SSH session.
# ASCII only. No scheduled task is created.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = 'C:\Apps\DSH-MultiTool\data-v2'
if (-not (Test-Path $data)) { New-Item -ItemType Directory -Path $data | Out-Null }
$node = 'C:\Apps\DSH-MultiTool\core\runtime\node\node.exe'
$server = Join-Path $root 'server.js'
$cmd = '"' + $node + '" "' + $server + '"'
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $cmd
  CurrentDirectory = $root
}
$pidValue = [int]$res.ProcessId
$pidValue | Set-Content -Path (Join-Path $data 'v2.pid') -Encoding ascii
Write-Output ('started pid=' + $pidValue + ' rc=' + $res.ReturnValue)
