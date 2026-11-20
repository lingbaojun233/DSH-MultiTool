@echo off
setlocal
rem Entry point for the "DSH-MultiTool Video" scheduled task (starts at boot).
rem Logs live OUTSIDE the module folder so push can replace video\ safely.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\video.log" 2>&1
