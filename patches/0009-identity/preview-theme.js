#!/usr/bin/env node
/**
 * preview-theme.js - screenshots of the AionDX themes on the harness page (tools\dx-harness), with the
 * theme applied the way AionUi's applyTheme does it: tokens as :root[data-theme=...] custom
 * properties, the theme css with !important on every declaration.
 *
 *   node patches\0009-identity\preview-theme.js     writes icon\preview-dark.png and icon\preview-light.png
 *
 * Hard 60 s deadline; Edge is killed on every exit path.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { THEMES } = require('./themes');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9345;
const BASE = 'file:///C:/AI%20Projects/AionDX/tools/dx-harness/harness.html';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-preview-edge-'));
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1280,720', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
function finish(code, msg) {
  if (msg) console.log(msg);
  try { edge.kill(); } catch { /* gone */ }
  setTimeout(() => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* locked */ } process.exit(code); }, 300);
}
setTimeout(() => finish(2, 'DEADLINE: 60 s'), 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function themeCss(t) {
  const layers = t.tokens.dark ? { dark: t.tokens.dark } : { light: t.tokens.light };
  const blocks = Object.entries(layers).map(([k, map]) =>
    `:root[data-theme='${k}'] {\n` + Object.entries(map).map(([n, v]) => `  ${n}: ${v};`).join('\n') + '\n}');
  const css = t.css.replace(/;\s*$/gm, ' !important;').replace(/(:[^;{}]+);/g, (m) => (m.includes('!important') ? m : m));
  return blocks.join('\n') + '\n' + css;
}

(async () => {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  if (!target) return finish(1, 'Edge did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  for (const t of THEMES) {
    const mode = t.appearance;
    await send('Page.navigate', { url: `${BASE}?team=1&theme=${mode}` });
    await sleep(1800);
    const css = themeCss(t);
    await send('Runtime.evaluate', { expression: `(() => { const s = document.createElement('style'); s.id = 'theme-decoration';
      s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); document.documentElement.setAttribute('data-theme', '${mode}');
      document.body.setAttribute('arco-theme', '${mode}'); return 0; })()` });
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'icon', `preview-${mode}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  finish(0, 'wrote icon\\preview-dark.png and icon\\preview-light.png');
})().catch((e) => finish(1, 'ERROR: ' + (e && e.stack || e)));
