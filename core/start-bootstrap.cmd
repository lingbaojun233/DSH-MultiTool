@echo off
setlocal
rem Launch core\bootstrap.ps1 detached (WMI owns the process, so no pipe keeps
rem the WinRM call alive). See start-core.ps1 for why.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-core.ps1"
exit /b %errorlevel%
