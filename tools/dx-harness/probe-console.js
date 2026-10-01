#!/usr/bin/env node
/**
 * probe-console.js - load the harness headless and print every console message and uncaught
 * exception, then click the Loop button and its first menu item. For finding a script error that
 * the click suite only sees as "nothing happened".
 *
 *   node tools\dx-harness\probe-console.js [query]      e.g. "team=1"
 *
 * Hard 60 s deadline; Edge is killed on every exit path.
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const BASE = 'file:///C:/AI%20Projects/AionDX/tools/dx-harness/harness.html';
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-edge-profile-probe');
const query = process.argv[2] || 'theme=light';

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1100,640', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
function finish(code) { try { edge.kill(); } catch { /* gone */ } process.exit(code); }
setTimeout(() => { console.log('DEADLINE'); finish(2); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('EXCEPTION', d.text, d.exception && d.exception.description, 'line', d.lineNumber, 'col', d.columnNumber, d.url || '');
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      console.log('CONSOLE.' + m.params.type, m.params.args.map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) console.log('EVAL EXCEPTION', r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}?${query}` });
  await sleep(1800);
  console.log('build', await js('window.__aionDx && window.__aionDx.build'));
  const p = await js(`(() => { const e = document.querySelector('.aiondx-loop button'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  console.log('button at', JSON.stringify(p));
  if (p) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(100);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(400);
    console.log('menu open:', await js('!!document.querySelector(".aiondx-menu")'));
    const q = await js(`(() => { const e = document.querySelector('.aiondx-menu .arco-dropdown-menu-item'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (q) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 });
      await sleep(100);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 });
      await sleep(400);
    }
    console.log('pressed:', await js(`(document.querySelector('.aiondx-loop button') || {}).getAttribute && document.querySelector('.aiondx-loop button').getAttribute('aria-pressed')`));
    console.log('state:', await js('JSON.stringify(window.__aionDx.status())'));
    await js('window.__aionDx.tickNow()');
    await sleep(300);
    console.log('after tick:', await js('JSON.stringify(window.__aionDx.status())'));
  }
  finish(0);
})().catch((e) => { console.log('ERROR', e.message); finish(1); });
