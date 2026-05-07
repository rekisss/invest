@echo off
setlocal

cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0run_sponsor_monitor.ps1"

endlocal
