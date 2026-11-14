@echo off
rem Runs some click-suite sections with nothing on the user's screen. From the PowerShell tool:
rem   & "C:\AI Projects\AionDX\tools\hidden-run.exe" cmd.exe /c "C:\AI Projects\AionDX\tools\run-sections-hidden.cmd" dxdocs tips | Out-Null
rem Output: C:\AI Projects\AionDX\.tmp\sections.out
cd /d "%~dp0dx-harness"
node run-sections.js %* > "%~dp0..\.tmp\sections.out" 2>&1
