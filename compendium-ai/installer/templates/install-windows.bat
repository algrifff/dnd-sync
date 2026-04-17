@echo off
REM UTF-8 console so the banner renders correctly.
chcp 65001 > nul

powershell -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Setup encountered an error. Screenshot this window and send it to the vault owner.
    pause
)
