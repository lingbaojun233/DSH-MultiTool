@echo off
setlocal
rem Entry point for the "DSH-MultiTool Panel" scheduled task (starts at boot).
rem Logs live OUTSIDE the module folder: push replaces panel\ wholesale, and an
rem open log file inside it would make the directory undeletable.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\panel.log" 2>&1
