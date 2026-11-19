#!/usr/bin/env node
/**
 * test-live-second-pc.js - a chat on a drive brought in by a fresh AionDX on "another PC" (R-132, November 17th, 2026: on the laptop every
 * chat came in owned by AionCore's built-in user and answered 404 to the person who owns it). Two throwaway AionDX profiles of the built
 * app, one after the other: A makes a chat and moves it to a folder on a drive (H: by default; AIONDX_TEST_DRIVE to change); B is a fresh
 * install that looks at that drive, and its own sync brings the chat in. B's signed-in user must then open it (200), see it in its list, and
 * B's log must have the import's line. Nothing of the installed AionDX or its data is touched; the drive folder and the drive's chat list are
 * put back afterwards.
 *   node tools\test-live-second-pc.js [--stage DIR]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./live-app');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const DRIVE = process.env.AIONDX_TEST_DRIVE || 'H:\\';
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 900000);

const T = `(window.__t || (window.__t = { base: 'http://127.0.0.1:' + window.__backendPort,
  h: () => ({ 'Content-Type': 'application/json', 'x-csrf-token': window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '' }),
  call: (m, p, b) => new Promise((res) => { const x = new XMLHttpRequest(); x.open(m, window.__t.base + p); x.withCredentials = true; const hd = window.__t.h(); Object.keys(hd).forEach((k) => x.setRequestHeader(k, hd[k])); x.timeout = 30000;
    x.onload = () => { let j = null; try { j = JSON.parse(x.responseText); } catch (e) {} res({ status: x.status, j }); }; x.onerror = x.ontimeout = () => res({ status: 0, j: null }); x.send(b === undefined ? null : JSON.stringify(b)); }) }), 0) || `;

function profile(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-live-2ndpc-' + tag + '-'));
  const roaming = path.join(home, 'AppData', 'Roaming'), local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(roaming, { recursive: true }); fs.mkdirSync(local, { recursive: true });
  return { home, roaming, env: { AIONDX_E2E_USER_DATA_DIR: '', APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: home, HOME: home } };
}
async function start(p, port, roots) {
  const env = Object.assign({}, p.env, roots ? { AIONDX_PORTABLE_ROOTS: roots } : {});
  const app = await launch({ port, deadlineMs: 420000, stage: arg('--stage') || undefined, profile: path.join(p.home, 'unused'), noUserDataDir: true, env });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { const st = await app.js('({ port: window.__backendPort || null })'); up = !!(st && st.port); if (!up) await sleep(1000); }
  let steady = 0;
  for (let i = 0; i < 90 && steady < 4; i++) { const b = await app.js('window.__aionDx && window.__aionDx.build'); steady = b ? steady + 1 : 0; await sleep(1000); }
  const origJs = app.js.bind(app);
  app.js = (expr) => origJs(/window\.__t\b/.test(expr) ? '(' + T + expr + ')' : expr);
  return { app, up };
}

(async () => {
  if (!fs.existsSync(DRIVE)) { console.log('SKIP: ' + DRIVE + ' is not there'); process.exit(0); }
  const testDir = path.join(DRIVE, 'AionDX-2ndpc-' + process.pid);
  const index = path.join(DRIVE, 'AionDX-chats.json');
  const hadIndex = fs.existsSync(index) ? fs.readFileSync(index) : null;
  const A = profile('a'), B = profile('b');
  let a = null, b = null, convId = null;
  try {
    // ---- PC A: a chat, moved to the drive
    a = await start(A, 9595);
    check('PC A starts', a.up);
    const conv = await a.app.js(`(async () => {
      const list = (await window.__t.call('GET', '/api/assistants')).j;
      const as = ((list && list.data) || []).find((x) => x.name === 'Claude Code') || ((list && list.data) || [])[0];
      const c = await window.__t.call('POST', '/api/conversations', { name: 'Second PC probe', assistant: { id: as.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } });
      const d = (c.j && (c.j.data || c.j)) || {};
      return { id: d.id, ws: d.extra && d.extra.workspace };
    })()`);
    check('PC A makes a chat', conv && conv.id && conv.ws, JSON.stringify(conv));
    convId = conv.id;
    fs.mkdirSync(conv.ws, { recursive: true });
    fs.writeFileSync(path.join(conv.ws, 'notes.txt'), 'kept with the chat');
    await a.app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/hold', { hold: true })`);
    const mv = await a.app.js(`window.aiondxPlaces.call('move', { items: [{ kind: 'c', id: ${JSON.stringify(conv.id)} }], to: ${JSON.stringify(testDir)} })`);
    await a.app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/hold', { hold: false })`);
    check('PC A moves it to the drive', mv && mv.ok && mv.moved && mv.moved[0] && fs.existsSync(path.join(mv.moved[0].package, 'aiondx-chat.json')), JSON.stringify(mv));
    await a.app.close(); a = null;

    // ---- PC B: a fresh install that sees the drive
    b = await start(B, 9596, DRIVE);
    check('PC B (a fresh install) starts', b.up);
    const me = await b.app.js(`(async () => { const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/auth/user', { credentials: 'include' }); const j = await r.json().catch(() => null); return j && j.user && j.user.id; })()`);
    check('PC B has its signed-in user', !!me && me !== 'system_default_user', String(me));
    let seen = null;
    for (let i = 0; i < 8 && !(seen && seen.status === 200); i++) {
      await b.app.js('window.__aionDx.placesSyncNow()');
      await sleep(2500);
      seen = await b.app.js(`window.__t.call('GET', '/api/conversations/${convId}')`);
    }
    check('PC B brought it in, and its signed-in user can open it (the laptop got 404)', seen && seen.status === 200, JSON.stringify(seen).slice(0, 300));
    const listed = await b.app.js(`(async () => { const r = await window.__t.call('GET', '/api/conversations?limit=200'); const d = r.j && (r.j.data || r.j); const l = (d && (d.items || d)) || []; return Array.isArray(l) && l.some((x) => x && x.id === ${JSON.stringify(convId)}); })()`);
    check('and it is in PC B\'s list', listed === true, String(listed));
    const ws = seen && seen.j && (seen.j.data || seen.j).extra && (seen.j.data || seen.j).extra.workspace;
    check('its working folder is on the drive, with its file', !!ws && ws.toLowerCase().startsWith(testDir.toLowerCase()) && fs.existsSync(path.join(ws, 'notes.txt')), String(ws));
    const logDir = path.join(B.roaming, 'AionDX', 'logs');
    let logText = '';
    const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.log$/.test(e.name)) logText += fs.readFileSync(p, 'utf8'); } } catch (e) { /* none */ } };
    // the page logs its check a moment after the import (it opens each chat first): wait for it
    for (let i = 0; i < 15; i++) { logText = ''; walk(logDir); if (new RegExp('import c:' + convId + '.*seen').test(logText)) break; await sleep(1000); }
    check('PC B\'s log has the import: the chat, its owner, and that it was seen', new RegExp('aiondx:places import .*"id":"' + convId).test(logText) && new RegExp('import c:' + convId + '.*owner ' + me + '.*seen').test(logText),
      (logText.match(/\[AionDX places\][^\n]*/g) || []).slice(-6).join('\n'));
  } catch (e) {
    check('no exception', false, e && e.stack);
  } finally {
    try { if (a) await a.app.close(); } catch (e) { /* closed */ }
    try { if (b) await b.app.close(); } catch (e) { /* closed */ }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    try { if (hadIndex) fs.writeFileSync(index, hadIndex); else fs.rmSync(index, { force: true }); } catch (e) { /* best effort */ }
    for (const p of [A, B]) { try { fs.rmSync(p.home, { recursive: true, force: true }); } catch (e) { /* the app may hold a file a moment */ } }
    clearTimeout(deadline);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
