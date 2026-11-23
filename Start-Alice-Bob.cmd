@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0toy-harness\start-pair.ps1"
if errorlevel 1 pause
