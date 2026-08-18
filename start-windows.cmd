@echo off
setlocal
chcp 65001 >nul
title SuperSpalt Trajectory
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-node-windows.ps1" "scripts\start-local.mjs" %*
if errorlevel 1 (
    echo.
    echo SuperSpalt failed to start. Review the error above.
    pause
    exit /b 1
)
