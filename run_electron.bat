@echo off
cd /d "%~dp0"

echo Launching ComfyUI Listener Electron app...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_electron.ps1"

if %errorlevel% neq 0 (
    echo [ERROR] Electron app exited with error code %errorlevel%.
    pause
    exit /b %errorlevel%
)
