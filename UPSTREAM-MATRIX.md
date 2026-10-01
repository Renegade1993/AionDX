# Upstream and the harvest matrix

K, 2026-09-24: *"make sure we are syncing the latest source changes from upstream, and that we have
a set configuration matrix on what gets harvested and what does not."*

The configuration is `tools\upstream-matrix.json`. This file explains it. `tools\upstream-sync.js`
reads it, fetches both upstream clones and reports which rows an upstream change touches. Changing a
decision is K's call; record the date and his words in the row's `why`.

## What upstream is

AionUi comes from two public repositories, both cloned here at the installed tags:

| clone | repository | installed | what it is |
|---|---|---|---|
| `upstream\` | github.com/iOfficeAI/AionUi | v2.2.2 | Electron app: renderer, main process, backend launcher |
| `upstream-aioncore\` | github.com/iOfficeAI/AionCore | v0.2.2 | Rust backend `aioncore.exe`: database, agents, ACP, teams, API |

The installed app is not exactly the public frontend. It is AionUi's AionPro edition: its main
process pins `CORE_IDENTITY_MODE = "aionpro"` and carries an aionui.com sign-in (`AuthManager`,
`CoreUserBridge`, the "Sign in to AionUi" page, Settings > Account) that the public source does not
contain. The public build runs the backend in local mode with no sign-in. The public source also
carries a compile-time switch for AionUi's "final discontinued build", which shows a dialog moving
users to AionPro (`packages\desktop\src\renderer\utils\discontinuedBuild.ts`); no such build has
shipped. So for the frontend, AionDX patches what the installed app actually runs (the asar), and
the public source is the reference for how it works. The backend is public, and the app ships the
AionCore release binary unchanged.

As of September 24th, 2026: no AionUi release after 2.2.2 (September 9th) and no commits on its
public `main` since; AionCore has 16 unreleased commits on `main` (MiniMax Code added as a registry
agent, version-pin chores), none touching anything an AionDX patch depends on.

## Decisions

| decision | meaning |
|---|---|
| harvest | take upstream as it ships, no AionDX change |
| harvest+patch | take upstream; an AionDX patch rides on it, so a change here is checked before rebuilding |
| strip | remove or disable it in AionDX |
| hold | not decided; K's call |

## The matrix

| id | area | decision | patch |
|---|---|---|---|
| F1 | Multi-agent core: agent backends, conversations, teams, cron, skills, assistants, MCP settings | harvest | |
| F2 | Composer action row: send box, Draft queue, agent mode (Permission) pill | harvest+patch | 0001 |
| F3 | Team page: member columns, arrows, active-member scroll | harvest+patch | 0001 |
| F4 | AionPro account and aionui.com sign-in | strip | 0003 |
| F5 | First-run onboarding carousel | harvest, until the setup screen (P-009) replaces it | |
| F6 | Telemetry: page-view analytics, identity alias, Sentry reports | hold | |
| F7 | Auto-update from GitHub releases | hold | |
| F8 | Discontinued-build flag and the move-to-AionPro dialog | strip, if it ever ships | |
| F9 | WebUI remote access and pairing | harvest | |
| F10 | Builtin MCP servers (browser, image generation) | harvest | |
| F11 | Backend launcher: port and identity flags | harvest, watched | |
| F12 | Renderer `index.html` | harvest+patch | 0001, 0003 |
| F13 | The Butler in the interface: via-chat buttons, onboarding, English labels | strip, Antigravity in its place | 0006 |
| F14 | Team page warmup on open (`POST /api/teams/{id}/session`) | strip while the team has no session | 0001 |
| F15 | Chat and team column headers: the model picker, where the account pill sits (`acp-model-selector`, `data-role`) | harvest+patch | 0001 |
| F16 | New-chat agent list, message box and rows, Opening guide (`/api/assistants`, `sendbox-panel`, `message-text-content`, `openingGuideSeen_v1`) | harvest+patch | 0001, 0009 |
| B1 | aioncore binary, as each app release bundles it | harvest | |
| B2 | Team runtime: queue, pause and resume, run-state, delivery-failure notices | harvest, watched | |
| B3 | Conversation API and events: messages, status, `extra`, `turn.completed` | harvest, watched | |
| B4 | Identity modes, auth, CSRF, runtime-token channel | harvest, watched | |
| B5 | MCP injection into agent sessions | harvest, watched | |
| B6 | Agent error classification | harvest, watched | |
| B7 | Process Job objects | harvest, watched | |
| B8 | Registry agents (new backends) | harvest, watched | |
| B9 | WebSocket event bus | harvest, watched | |
| B10 | Claude launch: program resolution and arguments | harvest+patch | 0005 |
| B11 | Builtin skills: per-version copy, auto-inject to every conversation | harvest+patch | 0004 |
| B12 | Assistants API and the builtin Butler | harvest, watched | 0004 |
| B13 | Client preferences store, `/api/settings/client` (the Loop's shared state) | harvest, watched | 0001, 0007 |
| B14 | Agent CLI version-drift card (verified releases compiled into aioncore) | strip, built September 26th: the chat notice is hidden (Settings' advisory stays) | 0001 |
| B15 | Conversation runtime state (`is_processing`, `supports_midturn_delivery`), `runtime/restart`, `client_preferences` read by the account router | harvest+patch | 0001, 0002 |
| B16 | Stopping turns and queue order: conversation cancel, team interrupt and run cancel, the coordinator's lanes; assistants list, conversation create | harvest, watched | 0001 |

The `why` for each row, and the paths and content patterns watched for it, are in the JSON.

## Two rows wait on K

F6, telemetry. The app sends a page-view event on every screen change, an analytics identity alias
tied to the account id, and Sentry crash and installer-failure reports to AionUi's services.
Harvesting keeps upstream's crash data flowing; stripping keeps usage on the machine.

F7, auto-update. electron-updater checks for a release and AionUi offers it (autoDownload is off); K's
click downloads it and it installs when AionUi quits. That replaces
`app.asar`, so patches 0001 and 0003 drop out until "AionDX Apply Update" rebuilds them, and after
October 7th, 2026 the stock AionPro build would ask for an aionui.com sign-in in that window. The
alternative is taking updates only through AionDX Apply Update, which already detects a new stock
build and rebuilds on top of it.

The standalone app (installer 0.1.0, September 26th) runs with AionUi's own switch
`AIONUI_DISABLE_AUTO_UPDATE=1`: there an update would install stock AionUi over AionDX, and it has no
Apply Update to rebuild with. K's own machine is unchanged, and F7's decision for it is still his.

## When upstream moves

1. `node tools\upstream-sync.js` reports it. It runs daily at 09:00 with the "AionDX Claude
   toolchain update" task, and at session start and before any install by hand. Exit code 3 and
   "NEEDS A LOOK" mean a newer release or tag, or a watched row touched. The latest result is in
   `vendor\upstream-sync.json`, the history in `vendor\upstream-sync.log`.
2. For each touched row, act by its decision. harvest+patch and strip rows: read the change, rerun
   the patch's tests, and adjust the patch before the next build. harvest rows that are watched:
   check the AionDX feature that reads that code path still works.
3. A new app release reaches the machine through AionUi's own updater (F7) or a manual install.
   `tools\aiondx-apply.ps1` detects the new stock build, refreshes `app.asar.stock`, and rebuilds
   the patches on it. Patch 0003's `apply.js` refuses to write if its anchors moved, which stops
   the rebuild rather than shipping a half-patched app.
4. Look for upstream behavior that assumes an older state than AionDX runs (design directive 6:
   a verified CLI version, a sign-in, a warmup that wakes agents) and give it a `strip` row.
5. When the new release lands, check out the new tags in both clones (`git -C upstream checkout
   vX.Y.Z`), so the reference matches what is installed.
