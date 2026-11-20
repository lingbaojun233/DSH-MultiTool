@echo off
setlocal
rem Entry point for the "DSH-MultiTool Memory" scheduled task (starts at boot).
rem Logs live OUTSIDE the module folder so push can replace memory\ safely.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\memory.log" 2>&1
