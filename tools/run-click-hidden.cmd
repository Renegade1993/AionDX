@echo off
rem Runs the full click suite with nothing on the user's screen (no window, no taskbar entry). Start it as:
rem   & "C:\AI Projects\AionDX\tools\hidden-run.exe" cmd.exe /c "C:\AI Projects\AionDX\tools\run-click-hidden.cmd" | Out-Null
rem (PowerShell; the pipe makes it wait. Git Bash turns /c into a drive path.)
rem Output: C:\AI Projects\AionDX\.tmp\click-full.out. The suite has its own 600 s deadline per run.
cd /d "%~dp0dx-harness"
node click-test.js > "%~dp0..\.tmp\click-full.out" 2>&1
