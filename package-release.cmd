@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-node-windows.ps1" "scripts\package-source.mjs"
set "status=%errorlevel%"
pause
exit /b %status%
