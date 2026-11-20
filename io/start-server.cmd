@echo off
setlocal
rem Entry point for the "DSH-MultiTool IO" scheduled task (starts at boot).
rem Kept as a .cmd so the task action needs no shell quoting and stdout has a home.
set "IO=%~dp0"
cd /d "%IO%"
"%IO%..\core\runtime\node\node.exe" "%IO%server.js" >> "%IO%service.log" 2>&1
