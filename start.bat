@echo off
rem Keep this launcher ASCII-only: cmd parses .bat using the system code page.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title XiaoyiWork Canary Gateway
where node >nul 2>nul
if errorlevel 1 goto nonode
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--open"
node src\cli.mjs %ARGS%
set "CODE=%errorlevel%"
echo.
if not "%CODE%"=="0" echo   Gateway exited with code %CODE%. See the message above.
echo   Closing this window stops the gateway.
pause
exit /b %CODE%
:nonode
echo.
echo   [ERROR] Node.js 22 or newer is required: https://nodejs.org/
echo.
pause
exit /b 1
