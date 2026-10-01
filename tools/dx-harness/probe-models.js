#!/usr/bin/env node
/**
 * probe-models.js - one-off: in the staged standalone app (throwaway profile, minimized), how the page loads the agents'
 * catalog (fetch or XMLHttpRequest, from the browser's own resource timings), whether the Claude agent's catalog has
 * model options with descriptions, and whether the Loop script learns versions from it. 150 s deadline; the app's
 * process tree is killed on every exit. Sends no prompt.
 *
 *   node tools\dx-harness\probe-models.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = path.join(__dirname, '..', '..', 'vendor', 'release', 'stage', 'AionDX', 'AionDX.exe');
const PROFILE = path.join(os.tmpdir(), 'aiondx-probe-profile2');
const PORT = 9557;
const REG_BACKUP = path.join(os.tmpdir(), 'aiondx-probe2-aionui-protocol.reg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
let app = null, hadKey = false;
function done(code, msg) {
  if (msg) console.log(msg);
  if (app && app.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
  try { if (hadKey && fs.existsSync(REG_BACKUP)) reg(['import', REG_BACKUP]); else if (!hadKey) reg(['delete', 'HKCU\\Software\\Classes\\aionui', '/f']); } catch { /* best effort */ }
  process.exit(code);
}
setTimeout(() => done(2, 'DEADLINE: 150 s'), 150000).unref();

(async () => {
  hadKey = reg(['query', 'HKCU\\Software\\Classes\\aionui']).status === 0;
  if (hadKey) reg(['export', 'HKCU\\Software\\Classes\\aionui', REG_BACKUP, '/y']);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  app = spawn(EXE, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, AIONDX_NO_ACTIVATE: '1', AIONUI_E2E_TEST: '1', AIONUI_E2E_USER_DATA_DIR: PROFILE }, stdio: 'ignore', windowsHide: true });
  let t = null;
  for (let i = 0; i < 240 && !t; i++) {
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
  try { const w = await send('Browser.getWindowForTarget', { targetId: t.id }); if (w.result) await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'minimized' } }); } catch { /* as it is */ }
  for (let i = 0; i < 90; i++) { if (await js('!!(window.__aionDx && window.__backendPort)')) break; await sleep(1000); }
  await sleep(5000);
  await js(`location.hash = '#/guid'; 0`);
  await sleep(4000);
  console.log('how the page loaded the agents catalog:', JSON.stringify(await js(`performance.getEntriesByType('resource').filter(e => /\\/api\\/agents/.test(e.name)).map(e => e.initiatorType + ' ' + e.name.replace(/^https?:\\/\\/[^/]+/, '')).slice(0, 8)`)));
  const cat = await js(`new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:' + window.__backendPort + '/api/agents/management'); x.withCredentials = true;
    x.onload = () => { try { const l = (JSON.parse(x.responseText).data) || []; res(l.filter(a => /claude/i.test(a.backend || a.name || '')).map(a => ({ id: a.id, name: a.name,
      models: ((a.config_options || []).find(o => o.category === 'model') || { options: [] }).options.map(o => [o.value, o.name, (o.description || '').slice(0, 40)]),
      available: (a.available_models && a.available_models.available_models || []).length }))); } catch (e) { res('parse ' + e.message); } }; x.onerror = () => res('xhr error'); x.send(); })`);
  console.log('Claude agents in the catalog:', JSON.stringify(cat));
  console.log('learned before a fetch of our own:', await js(`localStorage.getItem('aionui.dx.modelLabels')`));
  await js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/agents/management', { credentials: 'include' }).then(r => r.text()).then(() => 0)`);
  await sleep(800);
  console.log('learned after the page\'s fetch goes through the Loop script:', await js(`localStorage.getItem('aionui.dx.modelLabels')`));
  done(0);
})().catch((e) => done(1, 'PROBE ERROR ' + (e && e.stack || e)));
