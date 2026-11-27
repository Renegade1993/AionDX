@echo off
rem run-release-tests.cmd - the test set run before a release, against the staged app. Meant to be started on a hidden desktop:
rem   tools\hidden-run.exe cmd.exe /c "C:\AI Projects\AionDX\tools\run-release-tests.cmd"
rem Writes %TEMP%\dx-release-tests.out and cleans up what the tests leave in %TEMP% at the end (tools\clean-test-leftovers.ps1).
cd /d "%~dp0.."
rem The test apps scan every drive for chats kept on one (D: to Z:) and would take in, and write back to, the user's real
rem packages (November 16th, 2026). They look only in this empty folder; a test that needs a drive sets its own.
if not exist "%TEMP%\dx-test-roots" mkdir "%TEMP%\dx-test-roots"
set AIONDX_PORTABLE_ROOTS=%TEMP%\dx-test-roots\
set OUT=%TEMP%\dx-release-tests.out
echo ==== renderer-names > "%OUT%"
node tools\check-renderer-names.js >> "%OUT%" 2>&1
echo ==== anchors >> "%OUT%"
node tools\test-live-anchors.js >> "%OUT%" 2>&1
echo ==== nobrowser >> "%OUT%"
node tools\test-live-nobrowser.js >> "%OUT%" 2>&1
echo ==== menu >> "%OUT%"
node tools\test-live-menu.js >> "%OUT%" 2>&1
echo ==== smoke >> "%OUT%"
node tools\smoke-standalone.js >> "%OUT%" 2>&1
echo ==== oct9 >> "%OUT%"
node tools\test-live-oct9.js >> "%OUT%" 2>&1
echo ==== drive >> "%OUT%"
node tools\test-live-drive.js >> "%OUT%" 2>&1
echo ==== places >> "%OUT%"
node tools\test-live-places.js >> "%OUT%" 2>&1
echo ==== second pc >> "%OUT%"
node tools\test-live-second-pc.js >> "%OUT%" 2>&1
echo ==== big files and folders >> "%OUT%"
node tools\test-live-biglinks.js >> "%OUT%" 2>&1
echo ==== chat to team and back >> "%OUT%"
node tools\test-live-chatteam.js >> "%OUT%" 2>&1
echo ==== swap a member >> "%OUT%"
node tools\test-live-swap.js >> "%OUT%" 2>&1
echo ==== look >> "%OUT%"
node tools\test-live-look.js >> "%OUT%" 2>&1
echo ==== theme and accent >> "%OUT%"
node tools\test-live-theme.js >> "%OUT%" 2>&1
echo ==== undo >> "%OUT%"
node tools\test-live-undo.js >> "%OUT%" 2>&1
echo ==== click >> "%OUT%"
node tools\dx-harness\click-test.js >> "%OUT%" 2>&1
echo ==== cleanup >> "%OUT%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\clean-test-leftovers.ps1 -OlderThanMinutes 0 >> "%OUT%" 2>&1
echo ==== DONE >> "%OUT%"
