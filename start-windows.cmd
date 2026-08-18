@echo off
setlocal
chcp 65001 >nul
title SuperSpalt Trajectory
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js 20.19 or newer is required.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)
node scripts\start-local.mjs %*
if errorlevel 1 (
    echo.
    echo SuperSpalt failed to start. Review the error above.
    pause
    exit /b 1
)
