@echo off
REM Double-click this to install (or update) Bot Crossing on this PC.
REM It sets up Node, builds the app, and makes it open when you log in.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-bot-crossing.ps1" %*
echo.
pause
