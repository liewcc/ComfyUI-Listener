@echo off
:: Set current directory to the script's directory
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Run script exited with error code %errorlevel%.
    pause
    exit /b %errorlevel%
)
