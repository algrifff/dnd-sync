@echo off
echo ===============================
echo   The Compendium - Sync Setup
echo ===============================
echo.
echo Starting setup, please wait...
echo.

powershell -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Setup encountered an error. Please screenshot this window and send it to the vault owner.
    pause
)
