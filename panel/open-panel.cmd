@echo off
setlocal
rem Local (desktop) launcher for the panel.
rem  1. ensure an SSH tunnel 127.0.0.1:8766 -> server 127.0.0.1:8766
rem  2. open the panel in the default browser
rem Nothing is exposed publicly: the tunnel is loopback on both ends.
set "PORT=8766"
set "SSHHOST=fish-server"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto open

echo [panel] creating SSH tunnel %PORT% -^> %SSHHOST%:%PORT% ...
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath 'ssh' -ArgumentList '-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-L','%PORT%:127.0.0.1:%PORT%','%SSHHOST%'"
timeout /t 2 /nobreak >nul

:open
start "" "http://127.0.0.1:%PORT%/"
