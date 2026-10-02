#!/usr/bin/env node
/**
 * smoke-standalone.js - runs the staged standalone AionDX (vendor\release\stage\AionDX) the way a fresh PC
 * would, in a throwaway profile, and checks its first run. Nothing of the installed AionUi is touched.
 *
 *   node tools\smoke-standalone.js [--agy]       --agy also opens an Antigravity chat and waits for a reply
 *
 * Isolation: --user-data-dir points Electron, and through it AionCore's whole data folder
 * (<userData>\aionui: database, skills, Node runtime), at %TEMP%\aiondx-smoke-profile. AionUi links no
 * ~\.aionui folder on Windows. AIONDX_NO_ACTIVATE=1 keeps the per-user setup from running. The one
 * machine-wide thing the app changes, the aionui:// link handler (HKCU\Software\Classes\aionui), is
 * exported first and put back afterwards. The window is minimized as soon as the debugging port answers.
 *
 * Checks: the window loads AionDX's page (title, the renderer script and its build); no aionui.com
 * sign-in (no #/login); AionUi's Opening guide stays shut; the backend answers; first-run setup records
 * aiondx.provisioned; Welcome to AionDX opens; the agent list comes back; with --agy, an Antigravity
 * chat answers. Hard 300 s deadline; the app's process tree is killed on every exit path.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STAGE = path.join(__dirname, '..', 'vendor', 'release', 'stage', 'AionDX');
const EXE = path.join(STAGE, 'AionDX.exe');
const PROFILE = path.join(os.tmpdir(), 'aiondx-smoke-profile');
const PORT = 9555;
const REG_BACKUP = path.join(os.tmpdir(), 'aiondx-smoke-aionui-protocol.reg');
// The one-click setup scans and imports this made-up home folder, never the real one (AIONDX_SETUP_TEST_HOME, patch 0009).
const SETUP_HOME = path.join(os.tmpdir(), 'aiondx-smoke-home');
const NODE_EXE = path.join(STAGE, 'resources', 'bundled-aioncore', 'win32-x64', 'managed-resources', 'node', 'node-v24.11.0-win-x64', 'node.exe');
const WANT_AGY = process.argv.includes('--agy');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 300) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;
let hadProtocolKey = false;

function reg(args) { return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 }); }
function restoreProtocol() {
  if (hadProtocolKey && fs.existsSync(REG_BACKUP)) reg(['import', REG_BACKUP]);
  else if (!hadProtocolKey) reg(['delete', 'HKCU\\Software\\Classes\\aionui', '/f']);
}
function finish(code, msg) {
  if (msg) console.log(msg);
  if (app && app.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
  try { restoreProtocol(); } catch { /* best effort */ }
  try { fs.rmSync(SETUP_HOME, { recursive: true, force: true }); } catch { /* a process may still hold a file */ }
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '   [' + r.detail + ']'}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(code || (failed ? 1 : 0));
}
setTimeout(() => finish(2, 'DEADLINE: smoke test did not finish within 300 s'), 300000).unref();

async function target() {
  for (let i = 0; i < 240; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && /index\.html/.test(x.url));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('the app never opened a page on the debugging port');
}

(async () => {
  if (!fs.existsSync(EXE)) finish(2, 'no staged app at ' + EXE + ' (run tools\\build-release.ps1 first)');
  hadProtocolKey = reg(['query', 'HKCU\\Software\\Classes\\aionui']).status === 0;
  if (hadProtocolKey) reg(['export', 'HKCU\\Software\\Classes\\aionui', REG_BACKUP, '/y']);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.rmSync(SETUP_HOME, { recursive: true, force: true });
  const seed = (rel, text) => { const f = path.join(SETUP_HOME, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  seed('.claude/CLAUDE.md', '# Smoke rules\nBe brief.\n');
  seed('.claude/agents/helper.md', 'helps');
  seed('.claude.json', JSON.stringify({ mcpServers: { notes: { command: 'notes-server', env: { NOTES_KEY: 'smoke-secret' } } } }));
  // AionUi's own test mode sets the data folder explicitly (app.setPath('userData'), main process), skips the
  // single-instance lock so it runs beside the installed AionUi, and leaves the tray and updater off; the
  // first-run path under test (sign-in, setup, Welcome, agents) is the same.
  app = spawn(EXE, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, AIONDX_NO_ACTIVATE: '1', AIONDX_NO_UPDATE_CHECK: '1', AIONUI_E2E_TEST: '1', AIONUI_E2E_USER_DATA_DIR: PROFILE, AIONDX_SETUP_TEST_HOME: SETUP_HOME },
    stdio: 'ignore', windowsHide: true, detached: false });
  app.on('error', (e) => finish(2, 'could not start the app: ' + e.message));

  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  // Out of the way: minimized, if the browser domain allows it.
  try {
    const w = await send('Browser.getWindowForTarget', { targetId: t.id });
    if (w.result) await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'minimized' } });
  } catch { /* stays visible */ }

  // Let the backend come up and the renderer script run its first-run setup.
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await js(`(() => ({ title: document.title, hash: location.hash, dx: !!window.__aionDx, build: window.__aionDx && window.__aionDx.build,
      port: window.__backendPort || null, guide: !!document.querySelector('[data-testid="opening-guide"]'),
      guideSeen: localStorage.getItem('onboarding.openingGuideSeen_v1'), welcome: !!document.querySelector('.aiondx-welcome') }))()`);
    if (st && st.welcome) break;
    await sleep(1000);
  }
  check('the window shows AionDX (page title)', st && st.title === 'AionDX', st && st.title);
  check('the AionDX renderer script runs, build ' + (st && st.build), st && st.dx && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(st.build || ''), JSON.stringify(st));
  check('no aionui.com sign-in: the app did not go to #/login', st && !/login/i.test(st.hash || ''), st && st.hash);
  check("AionUi's Opening guide stays shut", st && !st.guide && st.guideSeen === 'true', JSON.stringify(st));
  check('the backend answers (the app found its port)', st && st.port, st && st.port);
  const prov = await js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client', { credentials: 'include' }).then(r => r.json()).then(j => (j.data || j)['aiondx.provisioned'] || null).catch(e => 'error ' + e.message)`);
  check('first-run setup recorded aiondx.provisioned', prov && prov.v >= 1, JSON.stringify(prov));
  check('Welcome to AionDX opens on a first run', st && st.welcome, JSON.stringify(st));
  const agents = await js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/assistants', { credentials: 'include' }).then(r => r.json())
    .then(j => (j.data || []).filter(a => a.enabled !== false).map(a => a.name + ':' + (a.agent_status || '?'))).catch(e => ['error ' + e.message])`);
  check('the new-chat agent list answers', Array.isArray(agents) && agents.length > 0, JSON.stringify(agents));
  console.log('agents: ' + JSON.stringify(agents));
  const welcomeStatus = await js(`(document.querySelector('.aiondx-welcome-status') || {}).textContent || ''`);
  console.log('welcome status: ' + welcomeStatus);

  // The one-click setup (2026-09-26): the page reaches the main process through the preload, which runs the setup
  // skill's scripts on the app's own Electron as Node; here on the made-up home folder.
  const firstButton = await js(`(document.querySelector('.aiondx-welcome-actions button') || {}).textContent || ''`);
  check('Welcome opens on the one-click setup ("Look for my setup")', firstButton === 'Look for my setup', firstButton);
  const scan = await js(`window.aiondxSetup ? window.aiondxSetup.scan().then(r => ({ ok: r.ok, error: r.error || null,
    tools: r.ok ? r.survey.tools.filter(t => t.installed).map(t => t.id) : [], home: r.ok ? r.survey.home : null })) : { ok: false, error: 'no window.aiondxSetup' }`);
  check('the page can scan through the main process, with no Node.js and no agent', scan && scan.ok && scan.tools.includes('claude-code') && scan.home === SETUP_HOME, JSON.stringify(scan));
  const plan = { prefs: 'Smoke instructions.', items: [path.join(SETUP_HOME, '.claude', 'CLAUDE.md'), path.join(SETUP_HOME, '.claude', 'agents')],
    mcp: [{ file: path.join(SETUP_HOME, '.claude.json'), name: 'notes' }], wire: ['claude-code'] };
  const imp = await js(`window.aiondxSetup.apply(${JSON.stringify(plan)}).then(r => ({ ok: r.ok, error: r.error || null, added: r.ok ? r.result.mcp.added : null, wired: r.ok ? r.result.wired.map(w => w.agent) : null }))`);
  const md = (() => { try { return fs.readFileSync(path.join(SETUP_HOME, '.aiondx', 'AIONDX.md'), 'utf8'); } catch { return ''; } })();
  const claudeMd = (() => { try { return fs.readFileSync(path.join(SETUP_HOME, '.claude', 'CLAUDE.md'), 'utf8'); } catch { return ''; } })();
  const mcpFile = (() => { try { return fs.readFileSync(path.join(SETUP_HOME, '.aiondx', 'mcp', 'servers.json'), 'utf8'); } catch { return ''; } })();
  check('and import: AIONDX.md, the block in the agent\'s file, the MCP server with a placeholder and no secret', imp && imp.ok &&
    /Smoke instructions\./.test(md) && /<!-- AionDX instructions: begin -->/.test(claudeMd) && /"NOTES_KEY": "\$\{NOTES_KEY\}"/.test(mcpFile) && !/smoke-secret/.test(mcpFile + md),
    JSON.stringify(imp) + ' md=' + md.length + ' claude=' + claudeMd.length);
  // Node.js for a PC without it: the bundled copy runs.
  const nodeV = fs.existsSync(NODE_EXE) ? spawnSync(NODE_EXE, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout.trim() : '(missing)';
  check('the bundled Node.js is there and runs', nodeV === 'v24.11.0', nodeV);
  // Claude Code's plugins through the main process (/plugin): a read-only list, when this PC has claude.
  const plug = await js(`window.aiondxPlugins ? window.aiondxPlugins.run(['list', '--json']).then(r => ({ ok: r.ok, error: r.error || null,
    json: (() => { try { return Array.isArray(JSON.parse(r.out)); } catch (e) { return false; } })(), err: String(r.err || '').slice(0, 200) })) : { ok: false, error: 'no window.aiondxPlugins' }`);
  const refused = await js(`window.aiondxPlugins ? window.aiondxPlugins.run(['eval', 'x']).then(r => r.ok === false && /not a plugin command/.test(r.error || '')) : false`);
  if (plug && /not installed, or not on PATH/.test(plug.error || '')) console.log('SKIP  claude is not on this PC: the plugin list was not made');
  else check('the page lists Claude Code plugins through the main process (claude plugin list --json)', plug && plug.ok && plug.json, JSON.stringify(plug));
  check('and anything but a plugin command is refused there', refused === true, refused);

  if (WANT_AGY) {
    // A real Antigravity turn: the chat the Welcome screen's sign-in button makes, with its first message.
    const conv = await js(`(async () => {
      const base = 'http://127.0.0.1:' + window.__backendPort;
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const h = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
      const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
      const a = list.find(x => x.agent && (x.agent.type === 'antigravity' || x.agent.acp_backend === 'antigravity'));
      if (!a) return { error: 'no Antigravity in the agent list' };
      if (a.enabled === false) await fetch(base + '/api/assistants/' + encodeURIComponent(a.id) + '/state', { method: 'PATCH', credentials: 'include', headers: h, body: JSON.stringify({ enabled: true }) });
      const r = await fetch(base + '/api/conversations', { method: 'POST', credentials: 'include', headers: h,
        body: JSON.stringify({ name: 'AionDX smoke test', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } }) });
      const c = await r.json();
      const id = (c.data || c).id;
      if (!id) return { error: 'create ' + r.status + ' ' + JSON.stringify(c).slice(0, 200) };
      const m = await fetch(base + '/api/conversations/' + id + '/messages', { method: 'POST', credentials: 'include', headers: h,
        body: JSON.stringify({ content: 'Reply with the single word READY.', files: [] }) });
      return { id, status: a.agent_status, send: m.status };
    })()`);
    check('an Antigravity chat is created and its first message accepted', conv && conv.id && conv.send >= 200 && conv.send < 300, JSON.stringify(conv));
    // Its reply, not the notices AionCore posts first (the CLI version line, say): wait for READY itself.
    let reply = null;
    for (let i = 0; conv && conv.id && i < 75 && !(reply && /READY/i.test(reply)); i++) {
      await sleep(2000);
      reply = await js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/conversations/${conv && conv.id}/messages?limit=20', { credentials: 'include' })
        .then(r => r.json()).then(j => { const d = j.data || j; const list = Array.isArray(d) ? d : (d.items || d.messages || []);
          const left = list.filter(m => m.position === 'left'); return left.length ? left.map(m => (m.type || '') + ': ' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' | ').slice(0, 900) : null; })`);
    }
    console.log('antigravity chat: ' + reply);
    check('Antigravity answers in the fresh app', reply && /READY/i.test(reply), reply);
    const signin = await js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client?keys=aiondx.agy.signin', { credentials: 'include' }).then(r => r.json()).then(j => (j.data || j)['aiondx.agy.signin'] || null)`);
    console.log('agy sign-in record: ' + JSON.stringify(signin));
  }
  ws.close();
  finish(0);
})().catch((e) => finish(2, 'ERROR: ' + (e && e.stack || e)));
