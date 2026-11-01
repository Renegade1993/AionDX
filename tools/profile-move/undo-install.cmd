@echo off
rem Undo an AionDX package install: puts the folders install.bat set aside (.pre-restore-<time>) back in place.
rem   undo-install.cmd            show the plan, ask, then swap
rem   undo-install.cmd -DryRun    show the plan only
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0undo-install.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo Done.) else (echo Stopped with code %RC%. Nothing is left half done.)
pause
exit /b %RC%
