@echo off
REM UTF-8 console so the dragon banner renders correctly.
chcp 65001 > nul

powershell -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Setup encountered an error. Please screenshot this window and send it to the vault owner.
    pause
)
