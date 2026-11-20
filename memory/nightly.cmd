@echo off
setlocal
rem 每日巩固任务入口（计划任务 DSH-MultiTool Memory Nightly，每天 03:00）。
rem 日志在模块目录外，避免 push 时被占用。
set "HERE=%~dp0"
set "LOGDIR=%HERE%..\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
"%HERE%..\core\runtime\node\node.exe" "%HERE%cli.js" nightly >> "%LOGDIR%\memory-nightly.log" 2>&1
