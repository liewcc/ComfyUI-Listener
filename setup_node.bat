@echo off
:: Set current directory to the script's directory
cd /d "%~dp0"

echo Launching PowerShell setup script for Node.js...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_node.ps1"

if %errorlevel% neq 0 (
    echo [ERROR] Setup script exited with error code %errorlevel%.
    pause
    exit /b %errorlevel%
)
