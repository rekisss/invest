@echo off
setlocal

cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0run_hybrid_monitor.ps1"

endlocal
