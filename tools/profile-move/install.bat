@echo off
rem AionDX install: Visual C++, Git, Node, Python, then AionDX, then everything exported with it, for the account running this.
rem   install.bat            do everything
rem   install.bat -DryRun    show the plan, change nothing
rem The full log goes to the logs folder beside this file.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo Done. The log is in the logs folder.) else (echo Stopped with code %RC%. The log is in the logs folder.)
pause
exit /b %RC%
