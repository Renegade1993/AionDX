# Merging the mobile bridge, its desktop UI and voice into one release branch (plan only)

Written 2026-11-08 by the Bridge/API Engineer. Nothing here has been done; it lists the steps and what will conflict.

## The branches (all local, none pushed)

| Branch | Base | What it adds |
|---|---|---|
| `mobile-bridge-impl` | `origin/main` 54212e6 | `patches/core-0014-auth-channel`, `patches/core-0015-mobile-bridge`; `patches/core-0010-hard-stop/0002-pause-test.patch` (test only); `tools/build-aioncore.ps1` (`-TargetDir`, `--no-self-update`); `docs/mobile-bridge/*` |
| `mobile-desktop-ui` | `mobile-bridge-impl` | `patches/0018-mobile-settings/*`; `tools/build-release.ps1` (0018 wiring, patch list, privacy-check files) |
| `voice-core-elevenlabs` | `origin/main` 54212e6 (26 commits) | `patches/0011-voice/*` (the voice work); `tools/brand-names.js` (new keep rules); `tools/build-release.ps1` (`$root` from the script path, plus the `check-core-contract.js` step); `tools/check-core-contract.js`, `tools/test-core-contract.js`, `tools/test-live-session.js`; `tools/live-app.js` |

`remotes/voiceui/voice-ui-composer` is older (patches up to 0011 and core-0005) and is not part of this.

## Numbering

- **App patches:** voice adds no new number (it changes 0011). The desktop UI is **0018**. There's no clash. The next
  free app number after the merge is 0019.
- **Core patches:** core-0001..0013 are byte-identical on the voice and bridge branches (checked with `git diff`).
  Voice adds no core patch. core-0014 / core-0015 exist only on the bridge line. core-0010 gains a second file,
  `0002-pause-test.patch` (test only); `build-aioncore.ps1` applies `*.patch` in name order inside each folder, so it
  goes after 0001.

## Textual conflicts to expect

- `tools/build-release.ps1`: the only file all three lines touch.
  - Voice changes the `$root` line and adds the `check-core-contract.js` run after the AionCore step.
  - The desktop UI adds the 0018 block, `'0018-mobile-settings'` in the patch list, and two files in the privacy check.
  - The hunks are in different places, so git will probably merge them on its own. Read the result anyway: the 0018
    block must run before the privacy check, and `check-core-contract` must run on the staged AionCore that
    `-AionDxCore` copied in.
- Everything else is touched by one line only: `brand-names.js`, `live-app.js` and the voice `tools/test-*` (voice);
  `build-aioncore.ps1` (bridge); `patches/0018-*` (desktop UI); `docs/mobile-bridge/*` (bridge).

## The semantic conflict: brand-name keep rules

- **Today**, on main and the bridge line, `brand-names.js` core mode renames AionCore's cookie names and the folder
  variables: `aionui-session` → `aiondx-session`, `AIONUI_*_DIR` → `AIONDX_*_DIR`. So an `-AionDxCore` build from the
  bridge branch only works with a main-lineage app ("fix d", noted by QA).
- **Voice** keeps them, in both modes:
  - `aionui-session` / `aionui-csrf-token`;
  - `AIONUI_CACHE_DIR` / `AIONUI_WORK_DIR` / `AIONUI_LOG_DIR`;
  - the five `AIONUI_*` error codes and their `Aionui*` enum variants;
  - an exact `aionui` object key.
  It also adds `check-core-contract.js` so a mismatch stops the build.
- **After the merge:** voice's rules apply to the core build as well. So:
  1. Rebuild the core after the merge (`tools\build-aioncore.ps1 -Patched`). A core built before the merge has the
     renamed cookie, and `check-core-contract` will (correctly) refuse it.
  2. The bridge's own names are unaffected:
     - `AIONDX_MOBILE_BIND` is already AionDX-spelled;
     - `aiondx-bridge.db` and `aiondx-mobile\host.key` are AionDX-spelled;
     - the crate becomes `aiondx-mobile` either way.
  3. core-0014 has one test that writes the cookie literally (`aionui-session={token}` in its lifecycle-guard tests).
     brand-names rewrites that literal exactly as it rewrites the constant (renamed on main, kept with voice's rules),
     so the test matches in both. Using the `aionui_common::constants::COOKIE_NAME` constant there would be cleaner; that's optional.

## Steps (when the lead says go)

1. Create `release/<version>` from `origin/main`.
2. Merge `voice-core-elevenlabs`, then `mobile-desktop-ui`, which brings `mobile-bridge-impl` with it. Resolve
   `tools/build-release.ps1` if git doesn't.
3. Run `node tools/brand-names.js <fresh core checkout> --mode core --report …` (or just step 4) and read the report:
   the cookie names, the folder variables and the error codes must be listed as kept.
4. Run `tools\build-aioncore.ps1 -Patched`. All 16 core patch files apply in order (0001..0013, 0010/0002, 0014, 0015).
   Check that `vendor\aioncore\aioncore.json` lists core-0001..core-0015.
5. Run the core tests on the dev tree. Expect aionui-mobile 157 / team MCP 51 green, with the known upstream-only
   failures:
   - terminal default cwd;
   - 3 team temp/auto-workspace tests;
   - session_context auto-workspace;
   - the conversation trailing-whitespace workspace test;
   - 2 skill tests.
   The pause test is now fixed by core-0010/0002.
6. Run `tools\build-release.ps1 -AionDxCore …`. `check-core-contract` must pass (the cookie, the env variables, the
   error codes), and the privacy check covers the 0018 files.
7. Live checks, only with `tools\live-app.js`, a throwaway profile and a made-up APPDATA:
   - QA's full bridge pass: `QA_PAIR=1 QA_P3=1 QA_P4=1 node run-k1.js` plus the LAN checklist;
   - the 0018 desktop tests (`patches/0018-mobile-settings/test-live-mobile.js`);
   - voice's live tests (`tools/test-live-session.js`, `patches/0011-voice/test-*.js`);
   - one session-cookie smoke test: open the staged app and make a write (a new chat). This is the failure
     `check-core-contract` guards against.
8. Only then cut the installer.

## Not covered

- What the voice branch did after b376b96.
- Any change to `origin/main` after 54212e6.
- Re-run `git merge-base` and this note's file lists before merging.
