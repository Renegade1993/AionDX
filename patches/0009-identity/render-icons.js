#!/usr/bin/env node
/**
 * render-icons.js - draws icon\aiondx.svg into the PNG sizes and the Windows .ico AionDX ships.
 *
 *   node patches\0009-identity\render-icons.js
 *
 * Renders with headless Edge (the same DevTools-protocol approach as tools\dx-harness) on a
 * transparent background, so no image library is needed. Writes icon\png\aiondx-<size>.png and
 * icon\aiondx.ico (PNG-compressed entries, which Windows Vista and later read). Hard 90 s deadline;
 * Edge is killed on every exit path.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, 'icon');
const OUT = path.join(DIR, 'png');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9344;
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 180, 192, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-icon-edge-'));

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1100,1100', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
function finish(code, msg) {
  if (msg) console.log(msg);
  try { edge.kill(); } catch { /* gone */ }
  setTimeout(() => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* locked */ } process.exit(code); }, 300);
}
setTimeout(() => finish(2, 'DEADLINE: 90 s'), 90000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const svg = fs.readFileSync(path.join(DIR, 'aiondx.svg'), 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const pngs = {};
  for (const size of SIZES) {
    const html = `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    await sleep(250);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    const buf = Buffer.from(shot.result.data, 'base64');
    pngs[size] = buf;
    fs.writeFileSync(path.join(OUT, `aiondx-${size}.png`), buf);
  }

  // .ico: header, one directory entry per size, then the PNG images.
  const count = ICO_SIZES.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  ICO_SIZES.forEach((s, i) => {
    const png = pngs[s];
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16);
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2);
    dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(png.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += png.length;
  });
  fs.writeFileSync(path.join(DIR, 'aiondx.ico'), Buffer.concat([header, dir, ...ICO_SIZES.map((s) => pngs[s])]));
  console.log(`rendered ${SIZES.length} PNG sizes and aiondx.ico (${ICO_SIZES.join(', ')})`);
  finish(0);
})().catch((e) => finish(1, 'ERROR: ' + (e && e.stack || e)));
