@echo off
setlocal
rem Entry point for the "DSH-MultiTool Sticker" scheduled task (starts at boot).
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\sticker.log" 2>&1
