@echo off
rem run-release-tests.cmd - the test set run before a release, against the staged app. Meant to be started on a hidden desktop:
rem   tools\hidden-run.exe cmd.exe /c "C:\AI Projects\AionDX\tools\run-release-tests.cmd"
rem Writes %TEMP%\dx-release-tests.out and cleans up what the tests leave in %TEMP% at the end (tools\clean-test-leftovers.ps1).
cd /d "%~dp0.."
set OUT=%TEMP%\dx-release-tests.out
echo ==== anchors > "%OUT%"
node tools\test-live-anchors.js >> "%OUT%" 2>&1
echo ==== nobrowser >> "%OUT%"
node tools\test-live-nobrowser.js >> "%OUT%" 2>&1
echo ==== menu >> "%OUT%"
node tools\test-live-menu.js >> "%OUT%" 2>&1
echo ==== smoke >> "%OUT%"
node tools\smoke-standalone.js >> "%OUT%" 2>&1
echo ==== oct9 >> "%OUT%"
node tools\test-live-oct9.js >> "%OUT%" 2>&1
echo ==== click >> "%OUT%"
node tools\dx-harness\click-test.js >> "%OUT%" 2>&1
echo ==== cleanup >> "%OUT%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\clean-test-leftovers.ps1 -OlderThanMinutes 0 >> "%OUT%" 2>&1
echo ==== DONE >> "%OUT%"
