# 0012-no-builtin-browser: AionUi's built-in browser is removed

Written October 22nd, 2026, on a request to remove AionUi's built-in browser and open every web link in the system browser.

Applied by `apply.js` (run by `tools\build-release.ps1` with 0003, 0006 and 0009). Same rule as those: every edit must match its expected count on an unpatched tree, or show its marker on a patched one, or nothing is written.

## What AionUi 2.2.2 had

- A browser tab in the Preview panel (a webview), opened by a link click, by "Open in built-in browser" in the selection pop-up, by the "+" on the tab bar and by the workspace button's Browser entry.
- A CDP bridge in the main process that lets an agent drive that webview.
- An MCP server, `aionui-browser`, registered on every start and switched on in every new chat. An agent that used it loaded pages inside the app.

## What it does now

| Where | Change |
|---|---|
| `out/main/index.js` | `cdpStartupEnabled = false`: the bridge never starts, so nothing can drive a page inside the app. |
| `out/main/chunks/runBackendMigrations-*.js` | The start-up step no longer lists `aionui-browser` among the servers it registers, and deletes the one an earlier start registered (`DELETE /api/mcp/servers/{id}`). |
| `out/renderer/assets/*.js` | `openBrowserTab`, which every link, selection and button called, opens the address with `window.open`; the main window's handler sends `http` and `https` to `shell.openExternal` (the system browser). A blank tab does nothing. The two "Open in built-in browser" items, the "+" button and the workspace button's Browser entry are removed. Browser tabs saved by an earlier session are not restored. |
| `patches/0001-renderer-dx/aionui-dx.js` (build 2026-10-22.1) | The option `links.external` is gone (there is nothing to choose). A left click on a web link, with or without Alt, Ctrl or Shift, goes to the system browser. The colour menu no longer takes a right-click on a link or a picture, so Open link in browser, Copy link and Copy image show. |

`chrome-devtools` (off by default, runs its own Chrome) is not AionUi's browser and is left as it was.

## Why the right-click menu was empty

AionDX's colour menu handles a right-click anywhere in a reply and calls `preventDefault`. Electron's `context-menu` event, which builds the link menu (patch 0009, `aiondx-menu.js`), does not fire for a prevented event. A link in a reply therefore showed only the colour item. The live menu test did not catch it because it right-clicked a link outside any reply.

## Checks

- `node patches\0012-no-builtin-browser\apply.js <tree> --check` reports each edit and writes nothing.
- On a scratch copy: all nine edits match once, a second run reports each as already applied, and the four changed files still parse.
- Click suite: the link tests (plain, Alt and Ctrl click all reach `open-external`), the option list without `links.external`, and a right-click on a link in a reply (no colour menu).

## Limits

- `builtin-mcp-browser.js` stays in the unpacked app folder, unused (AionDX does not change the files AionUi unpacks).
- Settings > Tools still has AionUi's page for the CDP switch; with the bridge off it controls nothing.
- A page inside an HTML preview that opens a link uses the main window's handler, which also sends it to the system browser.
- AionCore's chat-link and tool output cards that print a URL as plain text are not links; select the text and use "Open in system browser".

## Re-applying on a new AionUi

Run `apply.js --check` first. A changed bundle shows as a count other than one; fix the regex for that edit.
