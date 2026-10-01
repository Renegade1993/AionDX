#!/usr/bin/env node
/**
 * Tests for patch 0003-local-account. Run before every build that includes it:
 *
 *   node patches\0003-local-account\test.js
 *
 * The stock main bundle comes from app.asar.stock, so this keeps working after a build has put
 * the patched bundle into vendor\extracted. The patched AuthManager runs in a VM sandbox with a
 * fake electron `app` and a network stub that fails the test if anything reaches aionui.com.
 *
 * Failure modes it guards:
 *   DATA LOSS       a new account id would show K an empty app (174 conversations belong to his
 *                   existing id), so the auth.enc id must win and must persist
 *   SIGN-IN AGAIN   anything that turns the snapshot back to "unauthenticated" sends the app to
 *                   the aionui.com sign-in page
 *   NETWORK         bootstrap, login, logout or a user-info refresh reaching aionui.com
 *   BAD BUILD       a patch that half-applies, applies twice, or breaks the bundle's syntax
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const patch = require('./apply.js');
const ROOT = path.resolve(__dirname, '..', '..');
const STOCK_ASAR = 'C:\\Program Files\\AionUi\\resources\\app.asar.stock';
const ASAR_CLI = path.join(ROOT, 'vendor', 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '   ' + String(detail).slice(0, 300) : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-0003-'));
const deadline = setTimeout(() => { console.log('DEADLINE: 0003 tests did not finish in 120 s'); process.exit(2); }, 120000);

function stockFile(inner) {
  const dir = fs.mkdtempSync(path.join(tmp, 'stock-'));
  execFileSync(process.execPath, [ASAR_CLI, 'extract-file', STOCK_ASAR, inner], { cwd: dir, windowsHide: true, stdio: 'ignore' });
  return fs.readFileSync(path.join(dir, path.basename(inner)), 'utf8');
}

function sandbox(src, opts) {
  const userData = opts.userData;
  const net = [], cleared = [], logs = [];
  const helperStart = src.indexOf(patch.MARK_BEGIN);
  const classEnd = src.indexOf('const authManager = new AuthManager();');
  const prelude = [
    'const FALLBACK_USER_ID_PREFIX = "desktop-user-";',
    'const readPersistedMeta = () => __meta();',
    'const createAionuiClient = () => ({ request: async (p) => { __net.push(p); throw new Error("network used: " + p); } });',
    'const getCommonParams = () => ({});',
    'const loadPersistedSession = async () => { __net.push("loadPersistedSession"); return null; };',
    'const savePersistedSession = async () => true;',
    'const clearPersistedSession = async () => { __cleared.push(1); };',
    'const ACCESS_TOKEN_EARLY_REFRESH_MS = 60000;',
  ].join('\n');
  const fakeRequire = (name) => name === 'electron'
    ? { app: { getPath: () => { if (opts.noUserData) throw new Error('no userData'); return userData; } } }
    : require(name);
  const quiet = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), log: () => {}, error: (...a) => logs.push(a.join(' ')) };
  const ctx = { require: fakeRequire, console: quiet, __meta: () => opts.meta, __net: net, __cleared: cleared };
  const api = vm.runInNewContext(prelude + '\n' + src.slice(helperStart, classEnd) + '\n;({ AuthManager, __aiondx })', ctx);
  return { AuthManager: api.AuthManager, net, cleared, logs };
}

(async () => {
  let stockMain, html;
  try {
    stockMain = stockFile('out\\main\\index.js');
    html = stockFile('out\\renderer\\index.html');
  } catch (e) {
    console.log('FAIL  could not read the stock asar: ' + e.message);
    process.exit(1);
  }
  check('stock bundle is unpatched', !stockMain.includes(patch.MARK_BEGIN));

  // ------------------------------------------------------------ BAD BUILD
  const once = patch.patchMain(stockMain).src;
  const twice = patch.patchMain(once).src;
  check('applies to the stock bundle', once.includes(patch.MARK_BEGIN) && once.length > stockMain.length);
  check('applying twice changes nothing', twice === once);
  const older = once.replace('const TAG = "[AionDX 0003]";', 'const TAG = "[old build]";');
  check('an older helper block is replaced by this version', patch.patchMain(older).src === once);
  for (const m of patch.METHODS) check('rewrote ' + m.head.trim(), once.split(m.call).length === 2);
  check('stock method bodies stay, renamed', patch.METHODS.every((m) => once.includes(m.stock)));
  let threw = null;
  try { patch.patchMain(stockMain.replace('class AuthManager {', 'class AuthManagerX {')); } catch (e) { threw = e.message; }
  check('a missing anchor refuses to patch', threw && /AuthManager/.test(threw), threw);
  threw = null;
  try { patch.patchMain(stockMain.replace('  async logout() {\n', '  async logout() {\n  }\n  async logout() {\n')); } catch (e) { threw = e.message; }
  check('a duplicated method refuses to patch', threw && /logout/.test(threw), threw);
  const syntaxFile = path.join(tmp, 'patched-main.js');
  fs.writeFileSync(syntaxFile, once);
  const syn = spawnSync(process.execPath, ['--check', syntaxFile], { windowsHide: true, encoding: 'utf8' });
  check('patched bundle passes node --check', syn.status === 0, syn.stderr);

  const h1 = patch.patchHtml(html).html;
  check('Account entry hidden by one style tag', h1.split('id="' + patch.STYLE_ID + '"').length === 2 && h1.includes('[data-settings-id="account"]'));
  check('style tag applied twice changes nothing', patch.patchHtml(h1).html === h1);

  // apply.js end to end on a throwaway tree
  const tree = path.join(tmp, 'tree');
  fs.mkdirSync(path.join(tree, 'out', 'main'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'out', 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'out', 'main', 'index.js'), stockMain);
  fs.writeFileSync(path.join(tree, 'out', 'renderer', 'index.html'), html);
  const run = () => spawnSync(process.execPath, [path.join(__dirname, 'apply.js'), tree], { windowsHide: true, encoding: 'utf8' });
  const r1 = run();
  const after1 = fs.readFileSync(path.join(tree, 'out', 'main', 'index.js'), 'utf8');
  const r2 = run();
  const after2 = fs.readFileSync(path.join(tree, 'out', 'main', 'index.js'), 'utf8');
  check('apply.js exits 0 and reports', r1.status === 0 && /0003:/.test(r1.stdout), r1.stderr);
  check('apply.js re-run exits 0 with identical output', r2.status === 0 && after2 === after1, r2.stderr);
  fs.writeFileSync(path.join(tree, 'out', 'main', 'index.js'), stockMain.replace('class AuthManager {', 'class Nope {'));
  fs.writeFileSync(path.join(tree, 'out', 'renderer', 'index.html'), html);
  const r3 = run();
  check('apply.js on a broken bundle exits 1 and writes nothing',
    r3.status === 1 && fs.readFileSync(path.join(tree, 'out', 'renderer', 'index.html'), 'utf8') === html, r3.stdout + r3.stderr);

  // ------------------------------------------------------------ DATA LOSS
  const KID = 'c18c50aa-0000-4000-8000-000000000001';
  const meta = { user: { id: KID, name: 'K', username: 'k', email: 'k@example.invalid', avatarUrl: null, extras: {} } };
  let ud = fs.mkdtempSync(path.join(tmp, 'ud-'));
  let s = sandbox(once, { userData: ud, meta });
  let am = new s.AuthManager();
  let snap = am.getSnapshot();
  check('first run keeps the auth.enc account id', snap.status === 'authenticated' && snap.user.id === KID, JSON.stringify(snap));
  const saved = JSON.parse(fs.readFileSync(path.join(ud, 'aiondx-account.json'), 'utf8'));
  check('and saves it to aiondx-account.json', saved.user.id === KID && saved.source === 'auth.enc');
  s = sandbox(once, { userData: ud, meta: null });
  check('later runs keep it even with auth.enc gone', new s.AuthManager().getSnapshot().user.id === KID);
  s = sandbox(once, { userData: ud, meta: { user: { id: 'someone-else' } } });
  check('the saved account wins over a different auth.enc', new s.AuthManager().getSnapshot().user.id === KID);

  ud = fs.mkdtempSync(path.join(tmp, 'ud-'));
  s = sandbox(once, { userData: ud, meta: null });
  const fresh = new s.AuthManager().getSnapshot().user.id;
  check('a machine that never signed in gets an aiondx- id', /^aiondx-[0-9a-f-]{36}$/.test(fresh), fresh);
  s = sandbox(once, { userData: ud, meta: null });
  check('and keeps it on the next launch', new s.AuthManager().getSnapshot().user.id === fresh);
  ud = fs.mkdtempSync(path.join(tmp, 'ud-'));
  s = sandbox(once, { userData: ud, meta: { user: { id: 'desktop-user-abc123abc123' } } });
  const fb = new s.AuthManager().getSnapshot().user.id;
  check('a desktop-user- fallback id is never used (CoreUserBridge refuses it)', fb.startsWith('aiondx-'), fb);
  s = sandbox(once, { userData: ud, meta: null, noUserData: true });
  check('no userData path still opens, with an in-memory account', new s.AuthManager().getSnapshot().status === 'authenticated');

  // ------------------------------------------------------------ SIGN-IN AGAIN and NETWORK
  ud = fs.mkdtempSync(path.join(tmp, 'ud-'));
  s = sandbox(once, { userData: ud, meta });
  am = new s.AuthManager();
  const events = [];
  am.onChange((snapshot, reason) => events.push(reason + ':' + snapshot.status));
  await am.bootstrap();
  check('bootstrap announces an authenticated account', events.join() === 'bootstrap:authenticated', events.join());
  await am.waitForBootstrap();
  const lr = await am.login({ lang: 'en', provider: 'aionui' });
  check('login succeeds without a browser', lr && lr.ok === true && am.getSnapshot().status === 'authenticated');
  await am.logout();
  check('logout keeps the account', am.getSnapshot().status === 'authenticated' && am.getSnapshot().user.id === KID);
  await am.clearSession('refresh_failed');
  check('clearSession keeps the account', am.getSnapshot().status === 'authenticated');
  check('auth.enc is never cleared', s.cleared.length === 0);
  check('getAccessToken has no token and makes no call', (await am.getAccessToken({ forceRefresh: true })) === null);
  await am.fetchUserInfo();
  check('nothing reached aionui.com', s.net.length === 0, s.net.join());
  check('the log names the account source', s.logs.some((l) => /\[AionDX 0003\] local account from auth\.enc/.test(l)), s.logs.join(' | '));

  clearTimeout(deadline);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); process.exit(1); });
