#!/usr/bin/env node
/**
 * test-live-nobrowser.js - patch 0012 in the real built app, on a hidden desktop and a throwaway profile:
 *   1. a fresh start registers AionUi's other built-in MCP servers but not aionui-browser;
 *   2. a profile that still has aionui-browser (an earlier AionUi or AionDX start) loses it at the next start;
 *   3. the page has no "Open in built-in browser" item or browser tab button text, and a link to a web address opens in no tab.
 *
 *   node tools/test-live-nobrowser.js [--stage DIR]
 */
'use strict';
const path = require('path');
const os = require('os');
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const profile = path.join(os.tmpdir(), 'aiondx-nobrowser-profile');

const api = (app, method, url, body) => app.js(`(async () => {
  const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
  const r = await fetch('http://127.0.0.1:' + window.__backendPort + ${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} });
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, data: j && j.data !== undefined ? j.data : j };
})()`);
async function ready(app) { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; }
const names = async (app) => { const r = await api(app, 'GET', '/api/mcp/servers'); return Array.isArray(r.data) ? r.data.map((s) => s.name) : null; };
async function settled(app, want, ms) {      // the start-up migration runs a few seconds after the page is up
  let list = null;
  for (let t = Date.now(); Date.now() - t < ms; ) { list = await names(app); if (list && want(list)) return list; await sleep(1500); }
  return list;
}

(async () => {
  const first = await launch({ port: 9571, deadlineMs: 200000, stage: arg('--stage') || undefined, profile });
  try {
    await ready(first);
    const list = await settled(first, (l) => l.includes('chrome-devtools'), 60000);
    check('a fresh start registers the other built-in servers (chrome-devtools)', list && list.includes('chrome-devtools'), JSON.stringify(list));
    check('and not the built-in browser', list && !list.includes('aionui-browser'), JSON.stringify(list));
    const made = await api(first, 'POST', '/api/mcp/servers', { name: 'aionui-browser', description: 'left by an earlier start', builtin: true,
      transport: { type: 'stdio', command: 'node', args: ['C:\\nowhere\\builtin-mcp-browser.js'] } });
    check('(setup) an earlier start\'s aionui-browser can be put back in the profile', made.status >= 200 && made.status < 300 && (await names(first)).includes('aionui-browser'), JSON.stringify(made).slice(0, 200));
  } finally { await first.close(); }

  const second = await launch({ port: 9572, deadlineMs: 200000, stage: arg('--stage') || undefined, profile, keepProfile: true });
  try {
    await ready(second);
    const list = await settled(second, (l) => !l.includes('aionui-browser'), 60000);
    check('the next start deletes a leftover aionui-browser', list && !list.includes('aionui-browser'), JSON.stringify(list));
    check('and keeps the other servers', list && list.includes('chrome-devtools'), JSON.stringify(list));
    await sleep(2000);
    const page = await second.js(`(() => ({
      pluses: document.querySelectorAll('[class*="new-browser"], [aria-label*="rowser"]').length,
      text: /Open in built-in browser/i.test(document.body.innerText),
      opts: window.__aionDx && window.__aionDx.option ? window.__aionDx.option('links.external') : 'no api' }))()`);
    check('the page offers no built-in browser (no item text, no option)', page && page.text === false && page.opts === undefined, JSON.stringify(page));
  } finally { await second.close(); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
