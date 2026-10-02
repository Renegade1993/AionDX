#!/usr/bin/env node
/**
 * live-app.js - starts a built AionDX (default: the staged one, vendor\release\stage\AionDX) the way
 * smoke-standalone.js does, in a throwaway profile on its own debugging port, and hands back a small CDP
 * driver. For tests that need the real app (React's own message box, its attachment state, the backend) and not
 * the DOM harness in tools\dx-harness. Nothing of the installed AionDX or its data is touched: its own
 * --user-data-dir, AIONUI_E2E_TEST (no single-instance lock), no per-user setup (AIONDX_NO_ACTIVATE), and the
 * aionui:// link handler key exported first and put back afterwards.
 *
 *   const { launch } = require('./live-app');
 *   const app = await launch({ port: 9557, deadlineMs: 240000 });
 *   await app.js('document.title');           // Runtime.evaluate, returns the value
 *   await app.key('z', { ctrl: true });       // a real key press through the browser's input path
 *   await app.type('hello');                  // Input.insertText
 *   await app.close();                        // kills the process tree, restores the registry key
 *
 * Every launch has a hard deadline (deadlineMs, default 300 s): the process tree is killed when it passes.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });

async function launch(opts) {
  opts = opts || {};
  const stage = opts.stage || path.join(ROOT, 'vendor', 'release', 'stage', 'AionDX');
  const exe = path.join(stage, opts.exeName || 'AionDX.exe');
  const port = opts.port || 9557;
  const profile = opts.profile || path.join(os.tmpdir(), 'aiondx-live-profile');
  const regBackup = path.join(os.tmpdir(), 'aiondx-live-aionui-protocol.reg');
  if (!fs.existsSync(exe)) throw new Error('no app at ' + exe);
  const hadKey = reg(['query', 'HKCU\\Software\\Classes\\aionui']).status === 0;
  if (hadKey) reg(['export', 'HKCU\\Software\\Classes\\aionui', regBackup, '/y']);
  if (!opts.keepProfile) fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const env = Object.assign({}, process.env, { AIONDX_NO_ACTIVATE: '1', AIONDX_NO_UPDATE_CHECK: '1', AIONUI_E2E_TEST: '1', AIONUI_E2E_USER_DATA_DIR: profile }, opts.env || {});
  // The Claude Code session this runs in must not be mistaken for the app's own: no AionUi runtime variables go in.
  Object.keys(env).forEach((k) => { if (/^AIONUI_(RUNTIME_TOKEN|BASE_URL|USER_ID|CONVERSATION_ID|CDP_)/.test(k)) delete env[k]; });
  const child = spawn(exe, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port].concat(opts.args || []), { env, stdio: 'ignore', windowsHide: true, detached: false });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }); } catch (e) { /* gone */ }
    try { if (hadKey && fs.existsSync(regBackup)) reg(['import', regBackup]); else if (!hadKey) reg(['delete', 'HKCU\\Software\\Classes\\aionui', '/f']); } catch (e) { /* best effort */ }
  };
  const deadline = setTimeout(() => { console.log('live-app: deadline passed, killing the app'); close().then(() => process.exit(3)); }, opts.deadlineMs || 300000);
  if (deadline.unref) deadline.unref();
  child.on('error', () => { closed = true; });

  let page = null;
  for (let i = 0; i < 240 && !page; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
      page = list.find((x) => x.type === 'page' && /index\.html/.test(x.url));
    } catch (e) { /* not up yet */ }
    if (!page) await sleep(500);
  }
  if (!page) { await close(); throw new Error('the app never opened a page on the debugging port'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) events.push(m);
  };
  const send = (method, params) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __error: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const KEYS = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  const key = async (k, o) => {
    o = o || {};
    const modifiers = (o.ctrl ? MODS.ctrl : 0) | (o.shift ? MODS.shift : 0) | (o.alt ? MODS.alt : 0) | (o.meta ? MODS.meta : 0);
    const code = KEYS[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    const text = !o.ctrl && !o.alt && !o.meta && k.length === 1 ? k : (k === 'Enter' ? '\r' : undefined);
    const base = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
    await send('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown' }, base, text ? { text, unmodifiedText: text } : {}));
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  };
  const type = (text) => send('Input.insertText', { text });
  // Serve a file in place of the app's own copy of a script (by the end of its URL), then reload the page: the real app, running the
  // edited aionui-dx.js without a rebuild. Other requests go on untouched.
  const overrides = [];
  const overrideScript = async (urlEnd, file) => {
    overrides.push({ urlEnd, file });
    if (overrides.length === 1) {
      ws.addEventListener('message', async (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method !== 'Fetch.requestPaused') return;
        const hit = overrides.find((o) => m.params.request.url.endsWith(o.urlEnd));
        if (hit) {
          await send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
            body: fs.readFileSync(hit.file).toString('base64') });
        } else await send('Fetch.continueRequest', { requestId: m.params.requestId });
      });
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' + urlEnd, requestStage: 'Request' }] });
    }
    await send('Page.reload', { ignoreCache: true });
  };
  return { js, send, key, type, events, close, port, profile, page, sleep, overrideScript };
}

module.exports = { launch, sleep };
