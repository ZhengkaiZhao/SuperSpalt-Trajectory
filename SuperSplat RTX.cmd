@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-rtx.ps1"
if errorlevel 1 (
    echo.
    echo SuperSpalt RTX failed to start. Review the error above.
    pause
)
