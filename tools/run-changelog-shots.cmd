@echo off
rem Makes the Changelog's pictures with nothing on the user's screen. Start it as:
rem   & "C:\AI Projects\AionDX\tools\hidden-run.exe" cmd.exe /c "C:\AI Projects\AionDX\tools\run-changelog-shots.cmd" [--sections name ...] | Out-Null
rem Output: C:\AI Projects\AionDX\.tmp\changelog-shots.result (the summary) and .tmp\changelog-shots.out (the suite's own log).
cd /d "%~dp0dx-harness"
node changelog-shots.js %* > "%~dp0..\.tmp\changelog-shots.result" 2>&1
