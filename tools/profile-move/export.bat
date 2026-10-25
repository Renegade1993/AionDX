@echo off
rem AionDX export: brings this package up to date with THIS PC (AionDX, its data, both Claude Code accounts, settings).
rem Use it on the laptop at the end of the trip, then run install.bat on the main PC. See README.txt.
rem   export.bat                   everything that changed since the last export
rem   export.bat -VerifyRestore    and afterwards prove the package with a scratch restore under another user name
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\refresh-package.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo Done. The log is in the logs folder.) else (echo Stopped with code %RC%. The log is in the logs folder.)
pause
exit /b %RC%
