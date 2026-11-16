#!/usr/bin/env node
/**
 * test-live-places.js - "Where your chats live" (R-130, November 15th, 2026) on the built app: a throwaway AionDX (made-up APPDATA,
 * LOCALAPPDATA and home) makes a chat, puts a file in its working folder, and moves it to a folder on a drive (H: by default;
 * AIONDX_TEST_DRIVE to change) the way the Settings list does: AionCore holds the chat (core-0020's runtime/hold), the app's own
 * window.aiondxPlaces runs the mover, the chat is released. AionCore must then report the chat's new working folder, the file must be there,
 * a held chat must refuse to start, and Bring back must return it. Nothing of the installed AionDX or its data is touched; the drive folder
 * and the drive's chat list are put back afterwards.
 *   node tools\test-live-places.js [--stage DIR]
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
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 600000);

(async () => {
  if (!fs.existsSync(DRIVE)) { console.log('SKIP: ' + DRIVE + ' is not there'); process.exit(0); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-live-places-'));
  const roaming = path.join(home, 'AppData', 'Roaming'), local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(roaming, { recursive: true }); fs.mkdirSync(local, { recursive: true });
  const testDir = path.join(DRIVE, 'AionDX-placestest-' + process.pid);
  const index = path.join(DRIVE, 'AionDX-chats.json');
  const hadIndex = fs.existsSync(index) ? fs.readFileSync(index) : null;
  const env = { AIONDX_E2E_USER_DATA_DIR: '', APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: home, HOME: home };
  let app = null;
  try {
    app = await launch({ port: 9593, deadlineMs: 500000, stage: arg('--stage') || undefined, profile: path.join(home, 'unused'), noUserDataDir: true, env });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { const st = await app.js('({ port: window.__backendPort || null })'); up = !!(st && st.port); if (!up) await sleep(1000); }
    check('the built app starts in the made-up profile', up);
    console.log('build', await app.js('window.__aionDx && window.__aionDx.build'));
    await app.js(`(() => { window.__t = { base: 'http://127.0.0.1:' + window.__backendPort,
      h: () => ({ 'Content-Type': 'application/json', 'x-csrf-token': window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '' }),
      call: async (m, p, b) => { const r = await fetch(window.__t.base + p, { method: m, credentials: 'include', headers: window.__t.h(), body: b === undefined ? undefined : JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; } }; return 0; })()`);
    check('the places bridge is there', await app.js('!!(window.aiondxPlaces && window.aiondxPlaces.call)'));
    const conv = await app.js(`(async () => {
      const list = (await window.__t.call('GET', '/api/assistants')).j;
      const a = ((list && list.data) || []).find((x) => x.name === 'Claude Code') || ((list && list.data) || [])[0];
      const c = await window.__t.call('POST', '/api/conversations', { name: 'places probe', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } });
      const d = (c.j && (c.j.data || c.j)) || {};
      return { id: d.id, ws: d.extra && d.extra.workspace };
    })()`);
    check('a chat is made, with its working folder', conv && conv.id && conv.ws, JSON.stringify(conv));
    fs.mkdirSync(conv.ws, { recursive: true });
    fs.writeFileSync(path.join(conv.ws, 'notes.txt'), 'kept with the chat');
    const st0 = await app.js('window.aiondxPlaces.call("status")');
    const it0 = st0 && st0.ok && st0.items.find((i) => i.id === conv.id);
    check('the list has it, in AionDX\'s folder', it0 && !it0.placed && it0.exists && it0.ws === conv.ws, JSON.stringify(it0));
    // the hold (core-0020)
    const hold = await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/hold', { hold: true })`);
    check('AionCore holds the chat', hold && hold.status === 200 && hold.j && hold.j.data && hold.j.data.held === true, JSON.stringify(hold));
    const ensure = await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/ensure', {})`);
    check('a held chat does not start', ensure && ensure.status !== 200 && /being moved/.test(JSON.stringify(ensure.j)), JSON.stringify(ensure));
    const mv = await app.js(`window.aiondxPlaces.call('move', { items: [{ kind: 'c', id: ${JSON.stringify(conv.id)} }], to: ${JSON.stringify(testDir)} })`);
    const rel = await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/hold', { hold: false })`);
    check('moved to the drive, then released', mv && mv.ok && rel && rel.status === 200, JSON.stringify([mv, rel]));
    const pkg = mv && mv.moved && mv.moved[0] && mv.moved[0].package;
    const got = await app.js(`window.__t.call('GET', '/api/conversations/${conv.id}')`);
    const wsNow = got && got.j && (got.j.data || got.j).extra && (got.j.data || got.j).extra.workspace;
    check('AionCore reads the chat\'s new working folder on the drive', !!pkg && wsNow === path.join(pkg, 'workspace'), JSON.stringify([pkg, wsNow]));
    check('its file is there, and gone from AionDX\'s folder', fs.existsSync(path.join(pkg || '', 'workspace', 'notes.txt')) && !fs.existsSync(conv.ws));
    check('the drive lists it', (() => { try { return JSON.parse(fs.readFileSync(index, 'utf8')).packages.some((p) => p.id === conv.id); } catch (e) { return false; } })());
    const ens2 = await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/ensure', {})`);
    check('released, it is not refused for its folder (not held, not missing)', ens2 && !/being moved|WorkspacePath|workspace path/i.test(JSON.stringify(ens2.j)), JSON.stringify(ens2));
    // Bring back
    await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/hold', { hold: true, stop: true })`);
    const bk = await app.js(`window.aiondxPlaces.call('back', { items: [{ kind: 'c', id: ${JSON.stringify(conv.id)} }] })`);
    await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/runtime/hold', { hold: false })`);
    const got2 = await app.js(`window.__t.call('GET', '/api/conversations/${conv.id}')`);
    const ws2 = got2 && got2.j && (got2.j.data || got2.j).extra && (got2.j.data || got2.j).extra.workspace;
    check('Bring back: in AionDX\'s folder again, with its file', bk && bk.ok && ws2 === conv.ws && fs.existsSync(path.join(conv.ws, 'notes.txt')), JSON.stringify([bk, ws2]));
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    try { if (app) await app.close(); } catch (e) { /* closed */ }
    await sleep(1500);
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log('could not remove ' + testDir + ': ' + e.message); }
    try { if (hadIndex) fs.writeFileSync(index, hadIndex); else fs.rmSync(index, { force: true }); } catch (e) { /* best effort */ }
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { /* temp */ }
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
