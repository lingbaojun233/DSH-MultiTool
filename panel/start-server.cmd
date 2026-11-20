@echo off
setlocal
rem Entry point for the "DSH-MultiTool Panel" scheduled task (starts at boot).
set "HERE=%~dp0"
cd /d "%HERE%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%HERE%service.log" 2>&1
