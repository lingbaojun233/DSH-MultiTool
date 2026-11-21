@echo off
setlocal
rem Daily consolidation entry (scheduled task "DSH-MultiTool Memory Nightly", 03:00).
rem Log lives outside the module folder so push never breaks it.
rem Records start / exit code so "did it work" is answerable from the log alone.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\memory-nightly.log"

echo ==== %DATE% %TIME% start ====>> "%LOG%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%cli.js" nightly >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% exit=%RC% ====>> "%LOG%"
exit /b %RC%
