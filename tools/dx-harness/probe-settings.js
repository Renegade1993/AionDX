#!/usr/bin/env node
/**
 * probe-settings.js - screenshots of pages the harness cannot draw, from the staged app (vendor\release\stage\AionDX) in a throwaway
 * profile, through its debugging port: Settings > Agents (#/settings/agent) and the new-chat page (#/guid), plus each page's structure
 * (headings, rows, buttons) as text. Run it on the hidden desktop so no window shows:
 *   tools\hidden-run.exe node "C:\AI Projects\AionDX\tools\dx-harness\probe-settings.js" [hash ...]
 * Default hashes: #/settings/agent #/guid. Screenshots: %TEMP%\aiondx-probe-<name>.png; text: %TEMP%\aiondx-probe-settings.txt.
 * 180 s deadline; the app's process tree is killed on every exit; the aionui:// protocol key is put back as it was.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STAGE = path.join(__dirname, '..', '..', 'vendor', 'release', 'stage', 'AionDX');
const EXE = path.join(STAGE, 'AionDX.exe');
const PROFILE = path.join(os.tmpdir(), 'aiondx-probe-settings-profile');
const PORT = 9557;
const OUT = path.join(os.tmpdir(), 'aiondx-probe-settings.txt');
const REG_BACKUP = path.join(os.tmpdir(), 'aiondx-probe-settings-protocol.reg');
const hashes = process.argv.slice(2).length ? process.argv.slice(2) : ['#/settings/agent', '#/guid'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const say = (s) => { lines.push(s); try { fs.writeFileSync(OUT, lines.join('\n')); } catch { /* temp */ } };
let app = null, hadProtocolKey = false;
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
function done(code, msg) {
  if (msg) say(msg);
  if (app && app.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
  try { if (hadProtocolKey && fs.existsSync(REG_BACKUP)) reg(['import', REG_BACKUP]); else if (!hadProtocolKey) reg(['delete', 'HKCU\\Software\\Classes\\aionui', '/f']); } catch { /* best effort */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* busy files go with the next run */ }
  process.exit(code);
}
setTimeout(() => done(2, 'DEADLINE: 180 s'), 180000).unref();

(async () => {
  hadProtocolKey = reg(['query', 'HKCU\\Software\\Classes\\aionui']).status === 0;
  if (hadProtocolKey) reg(['export', 'HKCU\\Software\\Classes\\aionui', REG_BACKUP, '/y']);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  app = spawn(EXE, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, AIONDX_NO_ACTIVATE: '1', AIONUI_E2E_TEST: '1', AIONUI_E2E_USER_DATA_DIR: PROFILE }, stdio: 'ignore', windowsHide: true });
  app.on('error', (e) => done(2, 'could not start the app: ' + e.message));
  let t = null;
  for (let i = 0; i < 200 && !t; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch { /* not up */ }
    if (!t) await sleep(500);
  }
  if (!t) done(2, 'no page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(os.tmpdir(), `aiondx-probe-${name}.png`), Buffer.from(s.result.data, 'base64')); };
  try { const w = await send('Browser.getWindowForTarget', { targetId: t.id }); if (w.result) await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'normal', width: 1400, height: 900 } }); } catch { /* as it is */ }
  await send('Page.enable');
  for (let i = 0; i < 90; i++) { if (await js('!!(window.__aionDx && window.__backendPort)')) break; await sleep(1000); }
  say('build ' + (await js('window.__aionDx && window.__aionDx.build')));
  await sleep(3000);
  await js(`(() => { const b = document.querySelector('.aiondx-w-later'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  for (const h of hashes) {
    await js(`location.hash = ${JSON.stringify(h)}; 0`);
    await sleep(4000);
    const name = h.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page';
    await shot(name);
    // the page's structure as text: headings, labelled controls and rows of the main column, with their box (x, y, w, h)
    const struct = await js(`(() => { const main = document.querySelector('.arco-layout-content, main') || document.body;
      const out = [];
      main.querySelectorAll('h1,h2,h3,h4,[class*="title"],button,[role="button"],[role="switch"],.arco-card,.arco-list-item,[class*="item"]').forEach((e) => {
        const r = e.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return;
        const t = (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 90); if (!t) return;
        out.push(Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' <' + e.tagName.toLowerCase() + (e.getAttribute('data-testid') ? ' ' + e.getAttribute('data-testid') : '') + '> ' + t);
      });
      return [...new Set(out)].slice(0, 160); })()`);
    say('\n== ' + h + ' (screenshot aiondx-probe-' + name + '.png)');
    for (const l of struct || []) say(l);
  }
  done(0, '\ndone');
})().catch((e) => done(2, 'probe failed: ' + e.message));
