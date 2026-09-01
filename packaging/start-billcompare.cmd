@echo off
setlocal
cd /d "%~dp0app"
set "PATH=%~dp0runtime\node;%PATH%"
set "BILLCOMPARE_BUNDLED=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\start-billcompare.ps1"
endlocal
