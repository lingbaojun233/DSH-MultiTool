@echo off
setlocal
rem Entry point for the "DSH-MultiTool Separator" scheduled task (starts at boot).
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\separator.log" 2>&1
