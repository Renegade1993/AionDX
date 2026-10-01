# AionDX

An unofficial patch layer over the [AionUi](https://github.com/iOfficeAI/AionUi) desktop app
(Apache-2.0). We do not rebuild the app: we ship targeted modifications to the installed build,
and an apply/verify/revert toolchain.

## Layout

```
patches\NNNN-<name>\   one folder per patch, each with a PATCH.md
tools\                 do_patch / launch_elevated / revert / check-install, the privacy check, the test page
vendor\                asar tooling, extracted app.asar tree, packed output (not committed)
upstream\              AionUi frontend source, full clone at v2.2.2, reference only, never edited
upstream-aioncore\     AionCore backend source (Rust), full clone at v0.2.2, reference only
```

## Two kinds of patch

Most patches modify the renderer and need the asar rebuilt and reinstalled. Patch 0002 does not: it
modifies user-owned files in the Claude launch chain, so it survives an AionUi update and is applied
by copying files, not by `do_patch.ps1`.

## Apply / verify / revert

**To apply, use the desktop shortcut "AionDX Apply Update"** (`tools\aiondx-apply.ps1`). It closes
AionUi after asking, rebuilds when needed, installs with one UAC prompt, verifies, and reopens
AionUi. An install has to be driven from outside AionUi, because aioncore kills every process an
agent started when the app closes. `-DryRun` shows the plan without changing anything.

The individual steps, for when something needs doing by hand:

```powershell
# rebuild patched asar from the currently installed app.asar
powershell -NoProfile -ExecutionPolicy Bypass -File tools\do_patch.ps1

# install it (UAC prompt; Program Files)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch_elevated.ps1

# check what is actually installed
powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-install.ps1

# revert to stock
powershell -NoProfile -ExecutionPolicy Bypass -File tools\revert.ps1
```

The app must be restarted to load a new asar. `app.asar.stock` in
`C:\Program Files\AionUi\resources\` is the restore point; do not overwrite it.

**The installer never writes over a live `app.asar`.** It stages the build as `app.asar.new` and swaps
by rename. With AionUi open, Windows refuses the rename, and a one-shot SYSTEM task waits for AionUi to
close, swaps, and deletes itself. It has to be a Task Scheduler task: aioncore runs every agent in a
Job object that kills all the agent's descendants when AionUi exits, which is how the first waiter
died. `launch_elevated.ps1` prints `SWAPPED` or `WAITING`; the log is
`vendor\install.log`. An in-place copy under a running app is what the first installer did, and it
leaves Electron reading the new file through the old file table.

## Upstream source

AionUi is two repositories, and most of what this project has fought lives in the second:

| clone | repo | tag | what it holds |
|---|---|---|---|
| `upstream\` | `github.com/iOfficeAI/AionUi` | `v2.2.2` | Electron shell and React renderer: composer, pickers, menus |
| `upstream-aioncore\` | `github.com/iOfficeAI/AionCore` | `v0.2.2` | `aioncore.exe`: database, agent launch, ACP, conversations, turn recovery, teams |

The installed app reports both versions in `resources\bundled-aioncore\win32-x64\manifest.json`.
When AionUi updates, fetch both and check out the new tags before diffing patches against them.

Where the problems met so far live in the backend, as of `v0.2.2`:

| concern | file |
|---|---|
| Agent model list cached in `agent_metadata.available_models` | `crates\aionui-ai-agent\src\factory\acp.rs`, `agent_task.rs` |
| Spawning an ACP agent's CLI | `crates\aionui-ai-agent\src\capability\cli_process\spawn_sdk.rs` |
| `UserAgentDisconnected` and other agent errors | `crates\aionui-ai-agent\src\protocol\send_error.rs`, `crates\aionui-api-types\src\agent_error.rs` |
| Whether a failed turn is replayed | `crates\aionui-conversation\src\turn_recovery_policy.rs`, `turn_orchestrator.rs` |
| Conversation finished and idle status | `crates\aionui-conversation\src\runtime_completion.rs`, `service.rs` |
| Team mailbox and idle notifications | `crates\aionui-team\src\mailbox.rs`, `event_loop.rs` |

The backend carries its own `ARCHITECTURE.md`, `CLAUDE.md` and `AGENTS.md`. Read `ARCHITECTURE.md`
before changing anything there.

## Previewing a renderer change

`tools\dx-harness\harness.html` loads AionUi's shipped stylesheets and runs the real patch script
against a copy of the composer row, so a UI change can be screenshotted in light and dark before
anything is installed. Instructions in `patches\0001-renderer-dx\PATCH.md`.
