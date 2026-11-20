@echo off
setlocal
rem Entry point for the "DSH-MultiTool IO" scheduled task (starts at boot).
rem Logs live OUTSIDE the module folder: push replaces io\ wholesale, and an open
rem log file inside it would make the directory undeletable.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\io.log" 2>&1
