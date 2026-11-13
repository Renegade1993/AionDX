# Publishing an AionDX release

Any collaborator with push access can publish a release from their own PC, signed in to GitHub as themselves. Collaborators on this
repository can push, merge pull requests, and create and edit releases. Nothing in the release tools is tied to one account: they use
the GitHub sign-in that git already has on the PC (Git Credential Manager), and no token is typed or stored.

## What the PC needs

- Windows 10 or 11, PowerShell 5.1, the .NET Framework C# compiler (`csc.exe`, part of Windows), Node.js 24, git.
- AionUi installed, and `vendor\app.asar.stock` (the unpatched app the build starts from; `tools\do_patch.ps1` explains where it comes from).
- For a release that carries AionDX's own AionCore: the Rust toolchain that `tools\build-aioncore.ps1` installs on first use.
- Inno Setup 6 for the installer.

## Steps

1. Start from an up-to-date `main` with everything merged that goes into the release. Pick the version (`X.Y.Z`) and put it in the release
   notes file you will publish (`dist\X.Y.Z\RELEASE-NOTES.md`; it is not committed).
2. If any `patches\core-*` folder changed since the last release: `powershell -File tools\build-aioncore.ps1 -Patched` (about 10 to 30 minutes).
   The release build in step 4 runs `tools\check-core-contract.js` on it and stops if the app and AionCore disagree on a name.
3. The tests. Each must pass in full; a failing test is never loosened to pass.
   - `node tools\dx-harness\click-test.js` (the renderer, with real mouse input).
   - The launcher: `node patches\0002-claude-model-currency\test-stream-proxy.js`, `test-account-switch.js`, `test-model-refresh.js`,
     `test-portable-history.js` in the same folder.
   - The data folder: `node patches\0015-data-folder\test-portable-start.js`, `node patches\0016-data-move\test-data-move.js`,
     `node patches\0016-data-move\test-portable-move.js` (the last two use a second drive when one is there; `AIONDX_TEST_DRIVE` picks it).
   - The main process: `node patches\0009-identity\test-signin.js`, `test-portable.js`, `test-cache-bridge.js`.
   - Voice and mobile: `node patches\0011-voice\test-voice.js` (and its other `test-*.js`), `node patches\0020-mobile-settings\test-firewall.js`,
     `node tools\test-core-contract.js`.
4. Build: `powershell -File tools\build-release.ps1 -Version X.Y.Z -AionDxCore`. It writes `dist\X.Y.Z\` (the installer `AionDX-X.Y.Z-setup.exe`,
   `SHA256SUMS.txt`, `release.json`). Then the live suites against the staged app: `tools\run-release-tests.cmd` (it includes
   `tools\test-live-drive.js`, which moves a throwaway AionDX to a second drive when the PC has one).
5. Before anything leaves the PC:
   - `node tools\privacy-check.js` (refuses names, user folders, e-mail addresses and keys in tracked files).
   - `node tools\security-sweep.js --github --allow <each collaborator's login>` (no keys anywhere, and nobody unexpected with access).
   - `node tools\scan-binary.js dist\X.Y.Z\AionDX-X.Y.Z-setup.exe`.
6. Commit, then `git push origin main`. Never force-push; never push a tag by hand.
7. Publish: `node tools\github-release.js --tag vX.Y.Z-beta --title "AionDX X.Y.Z" --notes dist\X.Y.Z\RELEASE-NOTES.md --asset dist\X.Y.Z\AionDX-X.Y.Z-setup.exe
   --asset dist\X.Y.Z\SHA256SUMS.txt --prerelease --publish`. It makes a draft, uploads both files, reads each back and compares its SHA-256,
   then publishes. AionDX's update check reads the asset named `AionDX-<version>-setup.exe` and the release's `SHA256SUMS.txt`, so both
   must be there.
8. Check with `node tools\github-api.js repo` that the release is listed and not a draft.

## Notes

- Keep build output, installers and anything under `vendor\` out of commits (`.gitignore` has them).
- A release note says what changed for the user, in plain words, and what was not tested.
