@echo off
setlocal
rem Entry point for the "DSH-MultiTool Listen" scheduled task (starts at boot).
rem Logs live OUTSIDE the module folder so push can replace listen\ safely.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\listen.log" 2>&1
