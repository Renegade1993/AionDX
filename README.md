# AionDX

AionDX is a desktop app for working with AI coding agents (Claude Code, Codex, Gemini, Antigravity and the
others [AionUi](https://github.com/iOfficeAI/AionUi) supports) from one window. It is built on AionUi 2.2.2 and
AionCore 0.2.2 (both Apache-2.0, by iOfficeAI) with AionDX's own changes, and it installs as its own program.
It is not affiliated with or endorsed by AionUi or iOfficeAI.

**Status: beta.** It runs on Windows 10 (1809 or later) and Windows 11, x64. The installer is not code-signed, so
Windows SmartScreen asks you to confirm it ("More info", then "Run anyway").

## What it adds

- **The Loop.** A round button in every message box that keeps an agent working: it nudges when the chat has been
  quiet, follows the agent's prompt-cache window so it does not waste usage, reads the limits of your Claude account,
  and stops when you say stop. Agents can drive it themselves through the `aiondx` command or an MCP server.
- **Respond now.** For a team member with a queue, a message you mark goes to the front of its queue and into its
  running turn; nothing it is doing is stopped.
- **Usage meter.** Your Claude account's 5-hour and weekly usage beside the agent control, read from Claude's own
  traffic, and passed to the agents so they can plan their work.
- **Drafts that survive a restart.** What you typed, and the pictures and files you attached, are kept per chat.
- **Schedule send, Stop that really stops, YOLO mode that does not ask about every Bash command, undo and redo in the
  message box,** and more.
- **A first screen that brings your setup over** from the other AI apps on the PC.
- **Its own look,** its own name everywhere, and no sign-in with anyone.
- **No telemetry.** The crash reports and usage analytics that AionUi sends to its own services are switched off. AionDX itself
  contacts GitHub, to look for its own updates; the agents you run talk to their own providers.

## Install

1. Download `AionDX-<version>-setup.exe` from the [releases](../../releases) page and check it against the
   `SHA256SUMS.txt` beside it (`Get-FileHash .\AionDX-<version>-setup.exe` in PowerShell).
2. Run it. It installs for you only, in `%LOCALAPPDATA%\Programs\AionDX`, with no administrator prompt.
3. If AionUi is on the PC, Setup asks whether to move to AionDX (your chats and settings stay where they are, in
   `%APPDATA%\AionUi`, and AionUi is removed with its own uninstaller after a backup) or to keep both.

AionDX looks for a newer release about half a minute after it starts and every six hours. A card says when there is
one; "Download" and "Install now" check the installer against the release's published SHA-256, install it quietly, and
AionDX comes back. About > Check for updates does the same on request.

Uninstall from Settings > Apps. Your chats and settings stay in `%APPDATA%\AionUi`.

## Build it

The build needs a Windows PC with Node.js, the .NET Framework compiler that Windows ships, and Inno Setup 6. The
installer, patches and tools:

```text
patches\NNNN-<name>\   one folder per patch, each with a PATCH.md that says what it changes and why
patches\core-NNNN-*\   patches to AionCore (Rust), applied by tools\build-aioncore.ps1
installer\aiondx.iss   the Inno Setup installer
tools\                 the build, the tests, the privacy check, the audits
vendor\ upstream\ ...  reference and build material, not committed
```

```powershell
node tools\fetch-aionui-base.js                                  # AionUi 2.2.2's original files, checked against their hashes
powershell -ExecutionPolicy Bypass -File tools\build-aioncore.ps1 -Patched      # optional: AionCore with AionDX's patches
powershell -ExecutionPolicy Bypass -File tools\build-release.ps1 -Version 0.25.0 -AionDxCore
```

`build-release.ps1` unpacks AionUi's stock `app.asar`, applies patches 0001, 0003, 0006, 0009 and 0010 in order
(each anchor must match exactly or nothing is written), packs it, brands the executable, builds AionDX's own programs,
runs the privacy checks, and compiles the installer. `-StageOnly` stops before the installer so the staged app can be
tested.

Tests:

```powershell
node tools\dx-harness\click-test.js                 # the renderer script against a stand-in page (about 470 checks)
node patches\0007-loop-tool\test-loop-tool.js        # the Loop tool
node patches\0007-loop-tool\test-mcp-bridge.js
node patches\0007-loop-tool\test-migrate.js          # moving from AionUi
node tools\test-installer-migrate.js                 # the installer, in a sandbox
node tools\smoke-standalone.js                       # the staged app, first run, in a throwaway profile
node tools\test-live-undo.js                         # message-box undo, in the real app
```

## Licence and credits

AionUi and AionCore are Apache-2.0 software by iOfficeAI; AionDX is a modified redistribution of them. The licences
and the list of what changed ship in the installer (`LICENSE.AionUi.txt`, `LICENSE.AionCore.txt`,
`NOTICE.AionDX.txt`). AionDX's own files in this repository are also released under the Apache License 2.0
(see `LICENSE`).
