'use strict';
// test-docs.js - the Claude Docs pane's main process (aiondx-docs.js) against a stand-in Electron: which addresses it shows, which go to
// the system browser, the sign-in pop-ups, the remembered session, and open / bounds / close / external. No window opens.
//   node patches\0009-identity\test-docs.js
const path = require('path');
const docs = require(path.join(__dirname, 'aiondx-docs.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };

check('a doc address is recognised', docs.isDocUrl('https://claude.ai/artifact/0f3a') && docs.isDocUrl('https://claude.ai/project/p1/artifact/x') && docs.isDocUrl('https://claude.ai/docs/abc'));
check('other claude.ai pages, other sites and plain http are not docs', !docs.isDocUrl('https://claude.ai/new') && !docs.isDocUrl('https://evil.example/artifact/x') &&
  !docs.isDocUrl('http://claude.ai/artifact/x') && !docs.isDocUrl('https://claude.ai.evil.example/artifact/x') && !docs.isDocUrl('not a url'));
check('sign-in pages stay in the pane; others do not', docs.isSignInUrl('https://accounts.google.com/o/oauth2') && docs.isSignInUrl('https://appleid.apple.com/auth') &&
  docs.isSignInUrl('https://claude.ai/login') && !docs.isSignInUrl('https://example.com/'));
check('the pane reads as plain Chrome (no Electron or app token)', docs.chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AionDX/0.27.1 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36') ===
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Safari/537.36');
check('bounds are whole pixels; a sliver is refused', JSON.stringify(docs.cleanBounds({ x: 10.4, y: 36.6, width: 500.2, height: 700 })) === '{"x":10,"y":37,"width":500,"height":700}' && docs.cleanBounds({ x: 0, y: 0, width: 10, height: 500 }) === null);

// ---- the stand-in Electron
const opened = [], events = [];
let handler = null, partitionUsed = null, uaSet = null;
class FakeWC {
  constructor() { this.url = ''; this.title = ''; this.handlers = {}; this.destroyed = false; this.openHandler = null; }
  on(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  emit(e, ...a) { for (const f of this.handlers[e] || []) f(...a); }
  setWindowOpenHandler(f) { this.openHandler = f; }
  loadURL(u) { this.url = u; this.title = 'Plan - Claude'; this.emit('did-navigate'); return Promise.resolve(); }
  getURL() { return this.url; } getTitle() { return this.title; } isLoading() { return false; } isDestroyed() { return this.destroyed; } reload() { this.reloaded = true; }
}
class WebContentsView {
  constructor(o) { partitionUsed = o.webPreferences.partition; this.webContents = new FakeWC(); this.bounds = null; }
  setBounds(b) { this.bounds = b; }
}
const children = [];
const win = { isDestroyed: () => false, contentView: { addChildView: (v) => children.push(v), removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); } } };
const sender = { isDestroyed: () => false, send: (ch, d) => events.push([ch, d]) };
const electron = {
  ipcMain: { handle: (ch, f) => { if (ch === 'aiondx:docs') handler = f; } },
  WebContentsView,
  BrowserWindow: { fromWebContents: () => win },
  shell: { openExternal: (u) => { opened.push(u); return Promise.resolve(); } },
  session: { fromPartition: (p) => ({ getUserAgent: () => 'Mozilla/5.0 Chrome/138 Electron/37.10.3 Safari/537.36', setUserAgent: (u) => { uaSet = u; } }) },
};
docs.install(electron);
const call = (req) => handler({ sender }, req);

(async () => {
  try {
    check('the handler is registered', typeof handler === 'function');
    let r = await call({ op: 'open', url: 'https://evil.example/artifact/1', bounds: { x: 0, y: 0, width: 400, height: 400 } });
    check('a non-claude.ai address is refused', r.ok === false && children.length === 0, JSON.stringify(r));
    r = await call({ op: 'open', url: 'https://claude.ai/artifact/abc', bounds: { x: 600, y: 36, width: 500, height: 700 } });
    const v = children[0];
    check('open docks one view in the window, on the remembered partition, at the given rectangle, with the doc loaded', r.ok && children.length === 1 && partitionUsed === 'persist:aiondx-claude' &&
      v.bounds.x === 600 && v.bounds.width === 500 && v.webContents.url === 'https://claude.ai/artifact/abc' && /Electron/.test(uaSet) === false, JSON.stringify([r, v && v.bounds, uaSet]));
    const st = events.filter((e) => e[0] === 'aiondx:docs-event').pop();
    check('the page is told the state: open, the address and the title', st && st[1].open === true && st[1].url === 'https://claude.ai/artifact/abc' && st[1].title === 'Plan - Claude', JSON.stringify(st));
    r = await call({ op: 'open', url: 'https://claude.ai/artifact/def', bounds: { x: 600, y: 36, width: 500, height: 700 } });
    check('a second doc reuses the same view', r.ok && children.length === 1 && children[0] === v && v.webContents.url === 'https://claude.ai/artifact/def');
    await call({ op: 'bounds', bounds: { x: 500, y: 36, width: 600, height: 700 } });
    check('bounds moves the view', v.bounds.x === 500 && v.bounds.width === 600);
    const popG = v.webContents.openHandler({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' });
    check('a Google sign-in pop-up opens as a small window on the same remembered session', popG.action === 'allow' && popG.overrideBrowserWindowOptions.webPreferences.partition === 'persist:aiondx-claude', JSON.stringify(popG));
    const popX = v.webContents.openHandler({ url: 'https://example.com/page' });
    check('any other pop-up goes to the system browser', popX.action === 'deny' && opened.includes('https://example.com/page'), JSON.stringify([popX, opened]));
    let prevented = false;
    v.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://example.com/elsewhere');
    check('navigating the pane away from claude.ai opens the system browser instead', prevented && opened.includes('https://example.com/elsewhere'));
    prevented = false;
    v.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://claude.ai/login');
    check('claude.ai pages (sign-in included) stay in the pane', !prevented);
    await call({ op: 'external' });
    check('Open in browser sends the doc on show to the system browser', opened.includes('https://claude.ai/artifact/def'), JSON.stringify(opened));
    await call({ op: 'reload' });
    check('Reload reloads the doc', v.webContents.reloaded === true);
    await call({ op: 'close' });
    const st2 = events.filter((e) => e[0] === 'aiondx:docs-event').pop();
    check('close takes the view out of the window and says so', children.length === 0 && st2[1].open === false, JSON.stringify(st2));
    r = await call({ op: 'open', url: 'https://claude.ai/artifact/def', bounds: { x: 600, y: 36, width: 500, height: 700 } });
    check('reopening after close puts the same view back (sign-in and page kept)', r.ok && children.length === 1 && children[0] === v);
    r = await call({ op: 'nope' });
    check('an unknown request is refused', r.ok === false);
  } catch (e) {
    check('no exception', false, e.stack);
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
