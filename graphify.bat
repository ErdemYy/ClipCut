@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0graphify.ps1" %*
exit /b %errorlevel%
