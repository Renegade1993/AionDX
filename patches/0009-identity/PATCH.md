# 0009-identity: AionDX's own look

**Target:** the asar (icons), AionUi's settings store (two themes), shortcuts, and the Loop script's
accent row (patch 0001 build `2026-09-25.2`). **Status:** themes installed and AionDX Dark made
active 2026-09-25 07:24 (shows at AionUi's next start); shortcut icons set; vendor build 5C6DD96E
carries the icons and the accent row, waiting for AionDX Apply Update.

a request of September 25th.

## The mark

`icon\aiondx.svg`: a teal loop with an arrowhead around a bright core on a blue-black tile; the
loop is the Loop, AionDX's own feature. `render-icons.js` draws it with headless Edge into
`icon\png\aiondx-<size>.png` (16 to 1024) and `icon\aiondx.ico` (16 to 256, PNG entries).

Where AionUi showed its mark, and what shows now (`apply.js`, run by `tools\do_patch.ps1`):

| place | AionUi | AionDX |
|---|---|---|
| in-app logo | `out/renderer/assets/app-*.png` | the same file, replaced with the 1024 px mark |
| window and taskbar button | nothing set in production, so Windows used `AionUi.exe`'s icon | `createWindow` loads `out/aiondx/app.png` (256 px) |
| tray | `resources\app.png` | `out/aiondx/app.png`, the tray code's own resize to 32 px |
| notifications | `resources\app.png` by path | the mark copied once to `userData\aiondx-app.png` |
| WebUI favicon and install icons | `pwa/icon-{180,192,512}.png` | replaced, both copies |
| taskbar pins, updater shortcut | `AionUi.exe,0` | `%LOCALAPPDATA%\AionDX\icons\aiondx.ico` (`install.js`) |

The main-process edits are anchored and counted like 0003 and 0006, with a marked helper block
(`AIONDX-0009 BEGIN/END`); a second run finds each done. The helper reads the mark from the asar
into a buffer and falls back to AionUi's icon on any error. Still AionUi's: `AionUi.exe`'s own
icon (Explorer, a new pin before `install.js` runs again) and the machine-wide Start menu entry
(needs admin).

## The themes

`themes.js`: AionDX Dark and AionDX Light in AionUi's own theme format, installed into
`theme.userThemes` in the settings store by `install.js`, so they show in Settings > Appearance
beside Light and Dark, and AionUi's theme editor can change them. Darker than AionUi's defaults
(dark `#0e0e0e / #1a1a1a / #262626` became `#07090d / #0c1017 / #121823`, blue-black; light
`#ffffff / #f9fafb / #f2f3f5` became `#eef1f5 / #e6eaf0 / #dde2ea`). Every accent colour reads one
variable, `--aiondx-accent` (default teal `#2dd4bf`): AionUi's `--primary` and `--brand`, Arco's
`--primary-5..7` (RGB triplets, from `--aiondx-accent-rgb`), and the dividers, which mix the accent
into the surface (`--aiondx-divider`, `--aiondx-divider-soft`) for `--border-base`, `--border-light`,
`--bg-3` and Arco's `--color-border-*`. The light theme uses a 70% accent for text and fills.
No `cover`: AionUi turns a user theme's cover into the app's background image.

## The accent row

In Settings > Appearance, under the theme gallery (found by `data-testid="theme-card-<id>"`), the
Loop script adds "AionDX accent": seven swatches, a custom colour, and "Accent dividing lines". The
choice goes to `aiondx.theme` in the settings store and to localStorage (applied at startup before
the store answers); it overrides the theme's variables with `html:root` rules, which outrank the
theme's `:root` whatever order AionUi appends its styles in. Dividers off points them at a neutral
grey. 6 checks in `tools\dx-harness\click-test.js` (`accent`).

## Files

| file | what |
|---|---|
| `icon\aiondx.svg`, `icon\png\`, `icon\aiondx.ico` | the mark and its renders |
| `render-icons.js` | SVG to PNGs and ICO, headless Edge |
| `apply.js` | the build step (icons into the asar, main-process edits) |
| `themes.js` | the two themes |
| `install.js` | themes into the store (`--activate` makes AionDX Dark active), icons onto shortcuts; `--check`, `--remove` |
| `preview-theme.js` | screenshots of both themes on the harness page (`icon\preview-*.png`) |

Undo: `node patches\0009-identity\install.js --remove` (themes out, active theme back to system,
shortcuts back to AionUi's icon), and the updater's "revert to stock" or a build without 0009.

## The sidebar's top-left logo and name, and a grey mark (2026-09-25)

a request. AionUi draws that logo inline (Layout.tsx: a
black 32 px tile and a white SVG) with the word "AionUi" beside it, so replacing `app-*.png` never
reached it. `apply.js` now edits the renderer bundle that holds it: the SVG becomes
`<img src="./aiondx-mark.svg">` (the mark, copied to `out/renderer/`), the tile loses `bg-black`, and
both "AionUi" labels there read "AionDX". Each anchor must match once, or nothing is written.

The mark's tile is neutral grey (#1b1b1b to #070707), matching AionDX Dark, whose navy K read as
purple ("is this a purple hew? can we make it grey, just about this dark"). `render-icons.js` redrew
the PNGs and the .ico; `install.js` put the .ico on the shortcuts and the grey themes in the store.

## September 26th, 2026

- `index.html`: an inline script marks AionUi's Opening guide seen (`onboarding.openingGuideSeen_v1`)
  before the app reads it; the Welcome to AionDX screen is the first screen.
- The main process, at start: `%LOCALAPPDATA%\AionDX\bin` first in its own PATH (so AionCore and every
  agent it starts find AionDX's programs first), and, when `C:\ProgramData\AionDX\manifest.json` names
  an activator, `aiondx activate --quiet --from aionui-start`, killed after 90 s.
- `aiondx-themes.js` for the renderer's first-run setup.

Later the same day, for the standalone app (a request; the friend has no AionUi):

- The start hook recognises a standalone install by `resources\aiondx\release.json` beside the app. The
  `C:\ProgramData\AionDX\manifest.json` test is gone, since any account can create that folder. On a
  standalone install it sets `AIONUI_DISABLE_AUTO_UPDATE=1`, so AionUi's updater never replaces AionDX
  with stock AionUi, and runs the bundled `aiondx.exe activate --quiet --from aionui-start`, killed
  after 90 s. It skips that when this process has no single-instance lock (a second click during start,
  or a test run) or with `AIONDX_NO_ACTIVATE=1`.
- The Windows app id is `com.aiondx.app` on a standalone install, so AionDX and a stock AionUi on the
  same PC keep separate taskbar pins, jump lists and notifications.
- Right-click: Cut, Copy, Paste and Select all in a text box, and Copy on selected text (a request). Electron raises this only when
  the page did not handle the right-click itself, so AionUi's own menus are unchanged.

## September 26th, 2026 (evening): the one-click setup's main-process half, and Node.js for a PC without it

- `ipcMain.handle("aiondx:setup")` in the helper block: `scan` runs the setup skill's `survey.js`, `apply` runs
  `apply.js` against the survey this process made last, each as a child of the main process on Electron itself
  (`fork`, `ELECTRON_RUN_AS_NODE`; the RunAsNode fuse is at its default, on), hidden, killed at 150 s. The scripts
  come from the app's payload (`resources\aiondx\skills\aiondx-setup`) or AionUi's skill folder.
  `AIONDX_SETUP_TEST_HOME` points both at a made-up home (the smoke test).
- `out/preload/index.js`: `window.aiondxSetup = { scan, apply }`, one edit before `get-backend-port`.
- The start hook puts the Node.js that AionUi itself ships
  (`resources\bundled-aioncore\win32-x64\managed-resources\node\node-v*-win-x64`, AionCore's managed runtime, which
  AionUi never puts on PATH) at the end of PATH when no `node.exe` is on it, so npx-based MCP servers (AionUi's own
  browser tool runs `cmd /c npx chrome-devtools-mcp`) and the Claude launcher work on a PC without Node.
  `build-release.ps1` unpacks nodejs.org's official zip over that folder, checked against the published SHA-256.

## September 26th, 2026 (night): Claude Code plugins for the page

A tester, through a request, then *"it seems we should definitely implement
/plugins"*. AionUi's Claude chats offer `/reload-plugins` but not Claude Code's `/plugin` browser.
`ipcMain.handle("aiondx:plugins")` in the helper block runs `claude plugin ...` for the page's /plugin panel (patch
0001): the `claude` found on PATH (AionDX's bin first), hidden, killed at 180 s. Only `list`, `install`, `uninstall`,
`enable`, `disable`, `update`, `details` and `marketplace add|list|remove|update`, with the options `--json`,
`--available`, `--scope`, `--config`, `--accept-command`, `--keep-data`, `--all`; no quotes or control characters,
at most 12 arguments. `-y` is refused: a marketplace's own install command runs only with `--accept-command` and the
hash the user was shown. A `claude.cmd` goes through `cmd.exe` and refuses `& | < > ^ % ! ( )`. The preload exposes
`window.aiondxPlugins.run(args)`. `test-plugins.js` 10/10 (the refusals, and a real `claude plugin list --json`).

Measured while building it: `claude plugin` ignores `CLAUDE_CONFIG_DIR` when started through K's launcher, so a test
install went into K's own `~/.claude` (removed again the same minute: plugin uninstalled, `enabledPlugins` taken back
out of settings.json, the cache folders deleted). Test plugin changes only through the harness stub.
