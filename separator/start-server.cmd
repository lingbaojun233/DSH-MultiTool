@echo off
setlocal
rem Entry point for the "DSH-MultiTool Separator" scheduled task (starts at boot).
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"

rem Public panel = anyone on the internet can reach the register form.
rem invite: needs the code; closed: admin only. Change to "open" only on a LAN.
rem The invite code is NOT stored in this file. It lives outside the repo in
rem ..\secrets\invite-code.txt (on first use a random one is generated there).
set "DSH_REGISTER_MODE=invite"
set "DSH_REGISTER_CODE="

for /f "usebackq delims=" %%i in (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%..\scripts\invite-code.ps1"`) do set "DSH_REGISTER_CODE=%%i"
if not defined DSH_REGISTER_CODE (
  echo [separator] FATAL: cannot resolve invite code from ..\secrets\invite-code.txt 1>&2
  exit /b 1
)

"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\separator.log" 2>&1
