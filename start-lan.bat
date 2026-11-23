@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title XiaoyiWork Canary Gateway LAN
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)
node src\cli.mjs --lan --open %*
pause
