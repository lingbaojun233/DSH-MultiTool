@echo off
setlocal
rem Entry point for the "DSH-MultiTool Panel" scheduled task (starts at boot).
rem HTTP stays on 127.0.0.1 (tunnels + localhost mic). HTTPS is the public door.
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%HERE%"

rem --- public HTTPS ---
set "DSH_PANEL_TLS_PORT=8443"
set "DSH_PANEL_TLS_HOST=0.0.0.0"
set "DSH_PANEL_PFX=C:\Apps\DSH-MultiTool\data\panel-cert.pfx"
set "DSH_PANEL_PFX_PASS=2ipyguzy9xtmu5fxmxvikyb8"

"%HERE%..\core\runtime\node\node.exe" "%HERE%server.js" >> "%LOGDIR%\panel.log" 2>&1
