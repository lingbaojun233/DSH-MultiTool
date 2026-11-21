@echo off
setlocal
rem Entry point for the "DSH-MultiTool IO" scheduled task (starts at boot).
rem Logs live OUTSIDE the module folder: push replaces io\ wholesale, and an open
rem log file inside it would make the directory undeletable.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"
rem Internal service token: lets plugins (which have no user token) ask io to plan.
rem Kept OUT of the repo - the file lives in ..\secrets on the server.
if exist "%HERE%..\secrets\internal-token.txt" set /p DSH_INTERNAL_TOKEN=<"%HERE%..\secrets\internal-token.txt"

"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\io.log" 2>&1
