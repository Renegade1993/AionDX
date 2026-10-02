# 0010-official-identity: AionDX as its own product

**Target:** the extracted `app.asar` (main process, preload, renderer chunks, web-app manifests, images), by
`apply.js`, run by `tools\build-release.ps1` after patches 0001, 0003, 0006 and 0009. **Status:** in installer 0.25.0.

Every anchor must match its expected count on an unpatched tree, or show its done-marker on a patched one;
otherwise nothing is written. `node patches\0010-official-identity\apply.js <dir> <version> --check` reports what
would change without writing.

## What it changes

### No telemetry

AionUi 2.2.2 sends three kinds of data to its own services, and none of it is AionDX's to send:

| what | where | change |
|---|---|---|
| crash reports, with a device id and the app version | Sentry project, DSN baked into `out/main/index.js` | `dsn: void 0`: Sentry starts with no destination |
| page views, message and conversation counts, a device id | Google Analytics 4, measurement id baked into the renderer's app chunk | the Firebase configuration reads as absent, and the tracking function returns at once |
| bug reports and the one-click feedback: logs, a database summary, a screenshot | Sentry (through the same project) | the opener and the submit function call `window.aiondxFeedback` (patch 0001), which opens the AionDX issues page in the browser with what was typed filled in; nothing is collected or sent |

### Updates from AionDX's own GitHub releases

- `update.check` (main process) reads `https://api.github.com/repos/Renegade1993/AionDX/releases`, takes the highest
  version among the non-draft releases that carry an asset named `AionDX-<semver>-setup.exe`, and compares it with
  the AionDX version baked in at build time (`AIONDX_VERSION`). AionUi's CDN feed (`static.aionui.com`) is no longer
  asked. `package.json`'s `version` stays AionUi's 2.2.2 on purpose: AionUi refuses to start on data stamped by a newer
  version than the running one, so the AionDX version cannot replace it.
- **Self-update.** Thirty seconds after start, and every six hours, the main process runs the same check and, when a
  newer release exists, opens the app's update card once per version (`AIONDX_NO_UPDATE_CHECK=1` turns it off; the test
  runs leave it off). The card's "Download" saves the installer in the Downloads folder (AionUi's own downloader, from
  `github.com`); "Install now" calls `window.aiondxUpdate.install(path)` (preload bridge) and the main process
  `aiondx:update-install` handler: the file must be an `AionDX-<semver>-setup.exe` directly in the Downloads folder,
  its SHA-256 must be the one the release publishes in `SHA256SUMS.txt`, then it runs the installer with
  `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /UPDATE=yes` and quits. The installer's `[Run]` entry
  `Check: IsUpdateRun` starts AionDX again.
- The About page: AionDX, its version, the repository, releases and issues; AionUi's contact and website links are
  gone.

### Names

A pass over every bundle (main, preload, renderer, all languages) with a real JavaScript parser (acorn): each string
literal that names AionUi or AionUI is rewritten to AionDX, except where it is not display text: links and e-mail
addresses, paths, folder and product keys (`aionui-session`, `AIONUI_*`), log prefixes (`[AionUi]`), the data folder
(`%APPDATA%\AionUi`, shared on purpose so chats carry over), and a short exact list of names that are keys although they read
like text (the credential store's service name, a legacy MCP server name, the markers around the user's own CSS, the
in-app browser's version string). About 2,100 strings change; about 120 are left. The scripts the app runs from
`app.asar.unpacked` (`builtin-mcp-*.js`) are not touched. The report of what changed and what was left is written to
`vendor\release\0010-report.txt` by every build.

Also: the web-app manifests, `static/images/brand/app.png`, `resources\app.png`, `resources\pwa\*` and
`resources\manifest.webmanifest` carry the AionDX mark; the executable's version resource (`tools\brand-exe.mjs`) says
AionDX and the AionDX version (file and product version) in every field Windows shows.

### Fixes that were in the product's own screens

- The confirm dialog for removing a team member was given no button text, so Arco showed its Chinese defaults. It now
  passes the translated Remove and Cancel.
- A picture or file attached to a message box (AionUi keeps these in a module-level `Map`) is kept in `localStorage`
  (`aiondx.sbdraft.v1`, 30 days) and put back after a restart. The text of the draft is kept by patch 0001. Leaving a chat no longer
  cancels an upload still in flight (AionUi's `useAbortUploadsOnConversationChange` becomes a no-op).

## Not changed, on purpose

- `package.json` `name` and `version`; the data folder name; the `aionui://` link handler. Chats, settings and agents
  stay where AionUi keeps them, so moving between the two programs loses nothing.
- Links into AionUi's own wiki (guides for ACP setup, LLM configuration and similar): they document the parts of the
  app that are AionUi's.
- The Butler assistant's rules and the other assistants' rule files are AionCore data: see `core-0003-names`.

## Files

| file | what |
|---|---|
| `apply.js` | the build step |
| `PATCH.md` | this file |
