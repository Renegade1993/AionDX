#!/usr/bin/env node
/**
 * test-live-drive.js - "Chats on a drive" (R-102, 2026-11-12) end to end on the built app: a throwaway AionDX (made-up APPDATA, LOCALAPPDATA
 * and home) starts, saves a setting and a value in its page storage, and is moved to a folder on a drive (H: by default; AIONDX_TEST_DRIVE to
 * change) through its own window.aiondxPortable: the app closes, the mover moves the data folder, and the app is started again, which must open
 * the folder on the drive through the pointer and find both values. Nothing of the installed AionDX or its data is touched; the drive folder and
 * its marker are removed afterwards.
 *   node tools\test-live-drive.js [--stage DIR]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./live-app');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const DRIVE = process.env.AIONDX_TEST_DRIVE || 'H:\\';
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 900000);

(async () => {
  if (!fs.existsSync(DRIVE)) { console.log('SKIP: ' + DRIVE + ' is not there'); process.exit(0); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-live-drive-'));
  const roaming = path.join(home, 'AppData', 'Roaming'), local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(roaming, { recursive: true }); fs.mkdirSync(local, { recursive: true });
  const testDir = path.join(DRIVE, 'AionDX-livetest-' + process.pid);
  const target = path.join(testDir, 'AionDX-Data');
  const driveMarker = path.join(DRIVE, 'AionDX-drive.json');
  const hadMarker = fs.existsSync(driveMarker) ? fs.readFileSync(driveMarker) : null;
  const env = { AIONDX_E2E_USER_DATA_DIR: '', APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: home, HOME: home,
    AIONDX_MOVER_SKIP_PROCESS_CHECK: '1', AIONDX_MOVER_NO_REOPEN: '1' };   // this PC's own AionDX is open; the test starts the app again itself
  const ready = async (app) => { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; };
  const putSetting = (app, k, v) => app.js(`(async () => { const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client', { method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': window.__coreCsrfToken || ((document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/) || [])[1] || '') }, body: JSON.stringify({ ${JSON.stringify(k)}: ${JSON.stringify(v)} }) }); return r.status; })()`);
  const getSetting = (app, k) => app.js(`(async () => { const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client?keys=' + encodeURIComponent(${JSON.stringify(k)}), { credentials: 'include' }); const j = await r.json(); return ((j && (j.data || j)) || {})[${JSON.stringify(k)}] || null; })()`);
  try {
    // 1. a fresh AionDX in the made-up profile: its data folder is %APPDATA%\AionDX
    let app = await launch({ port: 9591, deadlineMs: 600000, stage: arg('--stage') || undefined, profile: path.join(home, 'unused'), noUserDataDir: true, env });
    let ok = await ready(app);
    check('the built app starts in the made-up profile', ok);
    const st0 = await app.js('window.aiondxPortable ? window.aiondxPortable.status() : null');
    check('the drive bridge is there and says the chats are on this PC', st0 && st0.ok && st0.portable === false && /AionDX$/.test(st0.userData) && st0.start && st0.start.state === 'none', JSON.stringify(st0));
    const put = await putSetting(app, 'aiondx.test.drive', { kept: 'yes' });
    await app.js("localStorage.setItem('aiondx.test.drive', 'page storage kept'); 0");
    check('a setting is saved in the chats database', put === 200 || put === 204, put);
    const from = st0 && st0.userData;
    // 2. the move, through the app's own bridge: it starts the mover and closes
    const mv = await app.js(`window.aiondxPortable.move(${JSON.stringify(target)})`);
    check('the move is started', mv && mv.ok === true, JSON.stringify(mv));
    const last = path.join(local, 'AionDX', 'data-move', 'portable-last.json');
    let out = null;
    for (let i = 0; i < 300; i++) { try { out = JSON.parse(fs.readFileSync(last, 'utf8')); } catch (e) { out = null; } if (out && (out.state === 'done' || out.state === 'failed')) break; await sleep(1000); }
    await app.close();
    check('the app closed and the mover moved the data folder to the drive', out && out.state === 'done' && out.to === target, JSON.stringify(out));
    const ptr = (() => { try { return JSON.parse(fs.readFileSync(path.join(roaming, 'AionDX-location.json'), 'utf8')); } catch (e) { return null; } })();
    check("this PC's pointer names the drive folder, and the old folder is kept renamed", ptr && ptr.path === target && fs.readdirSync(roaming).some((n) => /^AionDX\.moved-/.test(n)) && !fs.existsSync(from),
      JSON.stringify([ptr, fs.readdirSync(roaming)]));
    // 3. AionDX again: it must open the folder on the drive
    app = await launch({ port: 9592, deadlineMs: 600000, stage: arg('--stage') || undefined, profile: path.join(home, 'unused2'), noUserDataDir: true, keepProfile: true, env });
    ok = await ready(app);
    const st1 = ok ? await app.js('window.aiondxPortable.status()') : null;
    check('started again, it opens the chats on the drive', st1 && st1.start && st1.start.state === 'using' && st1.userData === target && st1.portable === true, JSON.stringify(st1));
    const got = ok ? await getSetting(app, 'aiondx.test.drive') : null;
    const ls = ok ? await app.js("localStorage.getItem('aiondx.test.drive')") : null;
    check('the setting saved before the move is there', got && got.kept === 'yes', JSON.stringify(got));
    check('and the page storage too', ls === 'page storage kept', ls);
    await app.close();
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    await sleep(1500);
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log('could not remove ' + testDir + ': ' + e.message); }
    try { if (hadMarker) fs.writeFileSync(driveMarker, hadMarker); else fs.rmSync(driveMarker, { force: true }); } catch (e) { /* best effort */ }
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { /* temp */ }
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
