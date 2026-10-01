#!/usr/bin/env node
/**
 * probe-app.js - one-off: the staged standalone app (vendor\release\stage\AionDX) in a throwaway profile, driven
 * through its debugging port, to see two things the harness cannot:
 *   1. "/plugin" typed in a real chat's message box with real key presses: does the Plugins panel open, and does
 *      anything reach the agent? (K, 2026-09-26: "/plugin does not, only reload plugins")
 *   2. The model names a Claude chat shows, on the new-chat page and in a chat, before and after its agent starts.
 *      (K: "just says 'Fable' 'Opus' etc.")
 * It creates one Claude chat and starts its runtime (runtime/ensure), and sends no prompt. The app is minimized;
 * 240 s deadline; the app's process tree is killed on every exit. Screenshots to %TEMP%\aiondx-probe-*.png.
 *
 *   node tools\dx-harness\probe-app.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STAGE = path.join(__dirname, '..', '..', 'vendor', 'release', 'stage', 'AionDX');
const EXE = path.join(STAGE, 'AionDX.exe');
const PROFILE = path.join(os.tmpdir(), 'aiondx-probe-profile');
const PORT = 9556;
const REG_BACKUP = path.join(os.tmpdir(), 'aiondx-probe-aionui-protocol.reg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;
let hadProtocolKey = false;
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
function done(code, msg) {
  if (msg) console.log(msg);
  if (app && app.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
  try { if (hadProtocolKey && fs.existsSync(REG_BACKUP)) reg(['import', REG_BACKUP]); else if (!hadProtocolKey) reg(['delete', 'HKCU\\Software\\Classes\\aionui', '/f']); } catch { /* best effort */ }
  process.exit(code);
}
setTimeout(() => done(2, 'DEADLINE: 240 s'), 240000).unref();

(async () => {
  hadProtocolKey = reg(['query', 'HKCU\\Software\\Classes\\aionui']).status === 0;
  if (hadProtocolKey) reg(['export', 'HKCU\\Software\\Classes\\aionui', REG_BACKUP, '/y']);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  app = spawn(EXE, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, AIONDX_NO_ACTIVATE: '1', AIONUI_E2E_TEST: '1', AIONUI_E2E_USER_DATA_DIR: PROFILE },
    stdio: 'ignore', windowsHide: true });
  app.on('error', (e) => done(2, 'could not start the app: ' + e.message));
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
  const net = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === 'Network.responseReceived' && /\/api\/conversations\/[^/]+\/(runtime\/ensure|config-options)|\/api\/(models|agents)/.test(m.params.response.url)) net.push({ id: m.params.requestId, url: m.params.response.url });
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : (r.result && r.result.exceptionDetails ? 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300) : undefined); };
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(os.tmpdir(), `aiondx-probe-${name}.png`), Buffer.from(s.result.data, 'base64')); };
  const key = async (k, extra) => {
    const base = Object.assign({ key: k, code: k === 'Enter' ? 'Enter' : k === 'Escape' ? 'Escape' : '', windowsVirtualKeyCode: k === 'Enter' ? 13 : k === 'Escape' ? 27 : 0 }, extra || {});
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
    if (k === 'Enter') await send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r' }, base));
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  };
  const typeChars = async (text) => { for (const ch of text) { await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(40); } };
  try { const w = await send('Browser.getWindowForTarget', { targetId: t.id }); if (w.result) await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'normal', width: 1400, height: 900 } }); } catch { /* as it is */ }
  await send('Network.enable');
  await send('Page.enable');

  for (let i = 0; i < 90; i++) { if (await js('!!(window.__aionDx && window.__backendPort)')) break; await sleep(1000); }
  console.log('build', await js('window.__aionDx && window.__aionDx.build'));
  await sleep(4000);
  await js(`(() => { const b = document.querySelector('.aiondx-w-later'); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  const api = (method, url, body) => js(`(async () => { const m = document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/);
    const r = await fetch('http://127.0.0.1:' + window.__backendPort + ${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': window.__coreCsrfToken || (m ? decodeURIComponent(m[1]) : '') }${body ? ', body: ' + JSON.stringify(JSON.stringify(body)) : ''} });
    const t = await r.text(); try { const j = JSON.parse(t); return j.data !== undefined ? j.data : j; } catch (e) { return t.slice(0, 300); } })()`);
  const modelTexts = () => js(`[...document.querySelectorAll('button, [role="menuitem"], .arco-dropdown-menu-item, .arco-select-option, span, div')]
    .filter(e => e.children.length === 0 && /\\b(Opus|Sonnet|Fable|Haiku)\\b/.test(e.textContent || '') && (e.textContent || '').length < 80)
    .map(e => (e.closest('[data-testid]') ? e.closest('[data-testid]').getAttribute('data-testid') + ': ' : '') + e.textContent.trim()).slice(0, 30)`);

  // 1. The new-chat page.
  {
    await js(`location.hash = '#/guid'; 0`);
    await sleep(2500);
    console.log('learned at load (from the agents catalog):', await js(`localStorage.getItem('aionui.dx.modelLabels')`));
    console.log('new-chat picker label:', JSON.stringify(await js(`(document.querySelector('[data-testid="guid-model-selector"]') || {}).textContent || null`)));
    console.log('new-chat page model names:', JSON.stringify(await modelTexts()));
    await shot('newchat');
    // Its model picker ("Default Model"), opened.
    const mp = await js(`(() => { const b = [...document.querySelectorAll('button, [role="button"], span, div')].find(e => e.children.length <= 2 && /^Default Model$/.test((e.textContent || '').trim()));
      if (!b) return null; const r = b.getBoundingClientRect(); return { tag: b.tagName, testid: (b.closest('[data-testid]') || {}).getAttribute ? b.closest('[data-testid]').getAttribute('data-testid') : null, cls: String(b.className).slice(0, 80), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    console.log('new-chat model picker:', JSON.stringify(mp));
    if (mp) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mp.x, y: mp.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mp.x, y: mp.y, button: 'left', clickCount: 1 });
      await sleep(2500);
      console.log('new-chat model menu:', JSON.stringify(await js(`[...document.querySelectorAll('.arco-dropdown-menu-item, [role="menuitem"], [role="option"], .arco-select-option, .arco-trigger-popup li')].map(e => e.textContent.trim().slice(0, 70)).slice(0, 25)`)));
      console.log('new-chat model menu html:', await js(`(() => { const p = document.querySelector('.arco-trigger-popup, .arco-dropdown, .arco-popover-content'); return p ? p.outerHTML.slice(0, 1500) : null; })()`));
      await shot('newchat-models');
      await key('Escape');
      await sleep(400);
    }
  }
  // 2. A Claude chat, before its agent starts.
  const list = await api('GET', '/api/assistants');
  const claude = Array.isArray(list) ? list.find((a) => a.enabled && a.agent && a.agent.acp_backend === 'claude') : null;
  console.log('assistants:', Array.isArray(list) ? list.filter((a) => a.enabled).map((a) => a.id + ' ' + a.name + ' ' + JSON.stringify(a.agent)).join(' | ') : JSON.stringify(list).slice(0, 300));
  if (!claude) done(1, 'no Claude assistant here');
  const conv = await api('POST', '/api/conversations', { name: 'probe', assistant: { id: claude.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } });
  const convId = conv && (conv.id || (conv.conversation && conv.conversation.id));
  console.log('chat:', convId || JSON.stringify(conv).slice(0, 300));
  await js(`location.hash = '#/conversation/${convId}'; 0`);
  for (let i = 0; i < 30; i++) { if (await js('!!document.querySelector(\'[data-testid="sendbox-input"]\')')) break; await sleep(500); }
  await sleep(2500);
  console.log('chat before start, model names:', JSON.stringify(await modelTexts()));
  console.log('learned labels:', await js(`localStorage.getItem('aionui.dx.modelLabels')`));
  await shot('chat-before');

  // 3. "/plugin" with real key presses.
  const box = await js(`(() => { const e = document.querySelector('[data-testid="sendbox-input"]'); if (!e) return null; const t = /^(TEXTAREA|INPUT)$/.test(e.tagName) ? e : e.querySelector('textarea, input'); t.focus(); const r = t.getBoundingClientRect(); return { tag: t.tagName, testidOn: e.tagName, x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  console.log('message box:', JSON.stringify(box));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await js(`window.__probeKeys = []; document.addEventListener('keydown', e => window.__probeKeys.push([e.key, e.keyCode, e.isComposing, e.defaultPrevented, (e.target.getAttribute && e.target.getAttribute('data-testid')) || e.target.tagName]), true); 0`);
  await typeChars('/plugin');
  await sleep(600);
  console.log('before Enter: box value', JSON.stringify(await js(`document.querySelector('[data-testid="sendbox-input"]').value || (document.querySelector('[data-testid="sendbox-input"] textarea') || {}).value`)),
    'slash menu open:', await js(`!!document.querySelector('.sendbox-panel.overflow-visible')`));
  await shot('slash-menu');
  await key('Enter');
  await sleep(2500);
  console.log('keys seen:', JSON.stringify(await js('window.__probeKeys.slice(-3)')));
  console.log('after Enter: panel open', await js(`!!document.querySelector('.aiondx-plugins-backdrop') && !document.querySelector('.aiondx-plugins-backdrop').hidden`),
    'box value', JSON.stringify(await js(`document.querySelector('[data-testid="sendbox-input"]').value || (document.querySelector('[data-testid="sendbox-input"] textarea') || {}).value`)),
    'plugins state', JSON.stringify(await js(`(() => { const p = window.__aionDx.plugins(); return { installed: p.installed.length, available: p.available.length, markets: (p.markets || '').slice(0, 60) }; })()`)));
  await shot('after-plugin');
  const msgs = await api('GET', `/api/conversations/${convId}/messages?limit=10`);
  const items = Array.isArray(msgs) ? msgs : (msgs && (msgs.messages || msgs.items)) || [];
  console.log('messages in the chat:', items.length, JSON.stringify(items.map((m) => [m.position, String((m.content && (m.content.content || m.content.text)) || m.content).slice(0, 60)])));
  await key('Escape');
  await sleep(500);
  // Ctrl+Enter (AionUi's draft queue) with "/plugins".
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await typeChars('/plugins');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
  await sleep(1500);
  const msgs2 = await api('GET', `/api/conversations/${convId}/messages?limit=10`);
  const items2 = Array.isArray(msgs2) ? msgs2 : (msgs2 && (msgs2.messages || msgs2.items)) || [];
  console.log('Ctrl+Enter "/plugins": panel open', await js(`!!document.querySelector('.aiondx-plugins-backdrop') && !document.querySelector('.aiondx-plugins-backdrop').hidden`),
    'messages', items2.length, 'draft box text', JSON.stringify(await js(`(document.querySelector('[class*="draft"]') || {}).textContent || null`)));
  await key('Escape');
  await sleep(500);

  // 4. The agent started (runtime/ensure), then the model names again.
  // Through XMLHttpRequest: the page's fetch holds runtime/ensure until the first message (patch 0001, build .4).
  const ens = await js(`new Promise((res) => { const m = document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/);
    const x = new XMLHttpRequest(); x.open('POST', 'http://127.0.0.1:' + window.__backendPort + '/api/conversations/${convId}/runtime/ensure'); x.withCredentials = true;
    x.setRequestHeader('Content-Type', 'application/json'); x.setRequestHeader('x-csrf-token', window.__coreCsrfToken || (m ? decodeURIComponent(m[1]) : ''));
    x.timeout = 90000; x.onload = () => { try { const j = JSON.parse(x.responseText); res(j.data !== undefined ? j.data : j); } catch (e) { res(x.responseText.slice(0, 300)); } };
    x.onerror = () => res('xhr error'); x.ontimeout = () => res('xhr timeout'); x.send('{}'); })`);
  const opts = ens && ens.config_options ? ens.config_options : (ens && ens.runtime && ens.runtime.config_options) || null;
  console.log('ensure answered: keys', ens && typeof ens === 'object' ? Object.keys(ens).join(',') : String(ens).slice(0, 200));
  if (ens && typeof ens === 'object') {
    console.log('  config_options:', JSON.stringify((ens.config_options || []).map((o) => [o.id, o.category, o.type, (o.options || []).length, o.currentValue])));
    const walk = (o, p, out) => { if (!o || typeof o !== 'object' || out.length > 12) return out; for (const k of Object.keys(o)) { if (/model/i.test(k)) out.push(p + k + ' = ' + JSON.stringify(o[k]).slice(0, 700)); else walk(o[k], p + k + '.', out); } return out; };
    for (const line of walk(ens, '', [])) console.log('  ' + line);
  }
  if (opts) for (const o of opts) if (o.category === 'model' || o.id === 'model') console.log('model options:', JSON.stringify(o.options.map((x) => [x.value, x.name, (x.description || '').slice(0, 50)])));
  await sleep(6000);
  console.log('chat after start, model names:', JSON.stringify(await modelTexts()));
  console.log('learned labels:', await js(`localStorage.getItem('aionui.dx.modelLabels')`));
  for (const n of net.slice(-6)) {
    const b = await send('Network.getResponseBody', { requestId: n.id });
    console.log('response', n.url.replace(/^https?:\/\/[^/]+/, ''), (b.result && b.result.body || '').slice(0, 400));
  }
  await shot('chat-after');
  // The model menu, opened.
  const pill = await js(`(() => { const b = document.querySelector('[data-testid="acp-model-selector"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  console.log('model pill:', JSON.stringify(pill));
  if (pill) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pill.x, y: pill.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pill.x, y: pill.y, button: 'left', clickCount: 1 });
    await sleep(1200);
    console.log('model menu rows:', JSON.stringify(await js(`[...document.querySelectorAll('.arco-dropdown-menu-item, [role="menuitem"], [role="option"]')].map(e => e.textContent.trim().slice(0, 60)).slice(0, 20)`)));
    await shot('model-menu');
  }
  done(0);
})().catch((e) => done(1, 'PROBE ERROR ' + (e && e.stack || e)));
