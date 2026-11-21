@echo off
setlocal
rem Entry point for the "DSH-MultiTool Separator" scheduled task (starts at boot).
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"

rem Public panel = anyone on the internet can reach the register form.
rem invite: needs the code; closed: admin only. Change to "open" only on a LAN.
set "DSH_REGISTER_MODE=invite"
set "DSH_REGISTER_CODE=8uhptkku"

"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\separator.log" 2>&1
