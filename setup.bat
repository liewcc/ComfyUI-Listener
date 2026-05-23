@echo off
:: Set current directory to the script's directory
cd /d "%~dp0"

echo ====================================================
echo   Starting ComfyUI Listener Full Environment Setup
echo ====================================================
echo.

echo Launching PowerShell setup script for Python and Git...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"

if %errorlevel% neq 0 (
    echo [ERROR] Python/Git Setup script exited with error code %errorlevel%.
    pause
    exit /b %errorlevel%
)

echo.
echo Launching PowerShell setup script for Node.js and Electron...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_node.ps1"

if %errorlevel% neq 0 (
    echo [ERROR] Node.js/Electron Setup script exited with error code %errorlevel%.
    pause
    exit /b %errorlevel%
)

echo.
echo ====================================================
echo   All setups completed successfully!
echo   You can run the app using: run_electron.bat
echo ====================================================
echo.
pause

