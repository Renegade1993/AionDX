'use strict';
// aiondx-docs.js (patches/0009-identity): Claude Docs inside AionDX's own window (R-110).
//
// A Claude Doc link (claude.ai, an /artifact/ address) opens in a pane docked beside the chat, as the Claude app shows one, and never
// in the system browser. The pane is a WebContentsView in the main window with its own remembered sign-in (the session partition
// persist:aiondx-claude): the first doc shows claude.ai's own sign-in once, in the pane, and every doc after that opens signed in.
// claude.ai's sign-in pop-ups (Google, Apple) open as small windows on the same partition; any other address goes to the system browser.
//
// The renderer (aiondx-ui.js) owns the pane's frame: it draws the header (title, Open in browser, Close), reserves the space beside the
// chat and sends the rectangle the view fills (op "bounds") whenever the layout changes. The main process only places the view there.
//
// Requests (ipc "aiondx:docs"): open {url, bounds} | bounds {bounds} | close | external | state. Events to the page ("aiondx:docs-event"):
// {kind: "state", open, url, title, loading, signIn}.

const PARTITION = 'persist:aiondx-claude';

/** The addresses the pane shows: claude.ai and its sign-in pages. */
function isClaudeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'claude.ai' || x.hostname.endsWith('.claude.ai'));
  } catch { return false; }
}
/** A Claude Doc's address: claude.ai with an /artifact/ path segment, or /docs/. */
function isDocUrl(u) {
  if (!isClaudeUrl(u)) return false;
  try { return /\/(artifact|artifacts|docs)\//.test(new URL(u).pathname); } catch { return false; }
}
/** Sign-in pages claude.ai sends people to (and their pop-ups): kept inside the pane's own session. */
function isSignInUrl(u) {
  try {
    const h = new URL(u).hostname;
    return isClaudeUrl(u) || h === 'accounts.google.com' || h.endsWith('.google.com') || h === 'appleid.apple.com' || h.endsWith('.anthropic.com');
  } catch { return false; }
}
/** claude.ai treats an embedded browser that names itself Electron as unsupported for Google sign-in; the pane reads as the Chrome it is. */
function chromeUserAgent(ua) {
  return String(ua || '').replace(/\s(AionDX|AionUi|aionui|Electron)\/[^\s]+/gi, '');
}
function cleanBounds(b) {
  if (!b) return null;
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const r = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) };
  return r.width >= 40 && r.height >= 40 ? r : null;
}

function install(electron) {
  const { ipcMain, WebContentsView, BrowserWindow, shell, session } = electron;
  let view = null, host = null, sender = null, lastUrl = '';

  const send = () => {
    if (!sender || sender.isDestroyed()) return;
    const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
    const url = wc ? wc.getURL() : lastUrl;
    sender.send('aiondx:docs-event', {
      kind: 'state', open: !!(view && host), url, title: wc ? wc.getTitle() : '', loading: wc ? wc.isLoading() : false,
      signIn: !!url && /\/(login|signin|sign-in|oauth|magic-link)/i.test(url),
    });
  };

  const make = () => {
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));
    const v = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    const wc = v.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (isSignInUrl(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } } };
      }
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('will-navigate', (ev, url) => {
      if (isSignInUrl(url)) return;
      ev.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    });
    for (const e of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(e, send);
    wc.on('render-process-gone', () => { try { detach(); } catch {} view = null; send(); });
    return v;
  };

  const detach = () => {
    if (view && host && !host.isDestroyed()) { try { host.contentView.removeChildView(view); } catch {} }
    host = null;
  };

  ipcMain.handle('aiondx:docs', async (event, req) => {
    try {
      const op = req && req.op;
      sender = event.sender;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (op === 'open') {
        const url = String(req.url || '');
        if (!isClaudeUrl(url)) return { ok: false, error: 'Only claude.ai addresses open in the Docs pane.' };
        const bounds = cleanBounds(req.bounds);
        if (!win || !bounds) return { ok: false, error: 'No room for the pane.' };
        if (!view || view.webContents.isDestroyed()) view = make();
        if (host !== win) { detach(); win.contentView.addChildView(view); host = win; }
        view.setBounds(bounds);
        if (view.webContents.getURL() !== url) { lastUrl = url; await view.webContents.loadURL(url).catch(() => {}); }
        send();
        return { ok: true };
      }
      if (op === 'bounds') {
        const bounds = cleanBounds(req.bounds);
        if (view && host && bounds) view.setBounds(bounds);
        return { ok: true };
      }
      if (op === 'close') { if (view) lastUrl = view.webContents.getURL(); detach(); send(); return { ok: true }; }
      if (op === 'external') {
        const url = view && !view.webContents.isDestroyed() ? view.webContents.getURL() : lastUrl;
        if (isClaudeUrl(url)) await shell.openExternal(url);
        return { ok: true };
      }
      if (op === 'reload') { if (view && !view.webContents.isDestroyed()) view.webContents.reload(); return { ok: true }; }
      if (op === 'state') { send(); return { ok: true, open: !!(view && host) }; }
      return { ok: false, error: 'unknown request' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
}

module.exports = { install, isClaudeUrl, isDocUrl, isSignInUrl, chromeUserAgent, cleanBounds, PARTITION };
