#!/usr/bin/env node
/**
 * test-live-datafolder.js - patch 0015 in the real built app, on a made-up APPDATA (nothing of this PC's data is touched):
 *   1. a PC whose chats are only in an earlier AionUi folder (the installer's move has not happened): the app uses that folder where it is,
 *      moves nothing, keeps what was in it, and AionCore renames the database file to its current name;
 *   2. a PC with no earlier folder: the app makes AionDX and no AionUi folder at all;
 *   3. the choice is logged in AionDX-data-move.log. (The installer's own move is checked by tools\\test-installer-datafolder.js.)
 *
 *   node tools/test-live-datafolder.js [--stage DIR]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const base = path.join(os.tmpdir(), 'aiondx-datafolder-test');
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* best effort */ } };

async function run(label, port, withOld) {
  const home = path.join(base, label);
  rm(home);
  const roaming = path.join(home, 'AppData', 'Roaming');
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  if (withOld) {
    fs.mkdirSync(path.join(roaming, 'AionUi', 'aionui', 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(roaming, 'AionUi', 'aionui', 'conversations', 'sentinel.txt'), 'kept');
    fs.writeFileSync(path.join(roaming, 'AionUi', 'aionui', 'aionui-backend.db'), '');   // the file an earlier version wrote: the marker of chats
  }
  const app = await launch({ port, deadlineMs: 150000, stage: arg('--stage') || undefined, profile: path.join(home, 'unused'), noUserDataDir: true,
    env: { AIONDX_E2E_USER_DATA_DIR: '', APPDATA: roaming, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), USERPROFILE: home, HOME: home } });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) break; await sleep(1000); }
  } finally { await app.close(); }
  await sleep(1500);
  return { roaming, home };
}

(async () => {
  const a = await run('with-old', 9581, true);
  const dx = path.join(a.roaming, 'AionDX');
  const old = path.join(a.roaming, 'AionUi');
  check('an earlier AionUi folder with chats is used where it is: what was in it is still there', fs.existsSync(path.join(old, 'aionui', 'conversations', 'sentinel.txt')) && fs.readFileSync(path.join(old, 'aionui', 'conversations', 'sentinel.txt'), 'utf8') === 'kept');
  check('nothing is moved by the app: AionUi is still a plain folder', fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink());
  check('and the app wrote its own files there', fs.readdirSync(old).length > 3, fs.readdirSync(old).join(','));
  check('AionCore renamed the database file to its current name', fs.existsSync(path.join(old, 'aionui', 'aiondx-backend.db')) && !fs.existsSync(path.join(old, 'aionui', 'aionui-backend.db')), fs.readdirSync(path.join(old, 'aionui')).join(','));
  const log = fs.existsSync(path.join(a.roaming, 'AionDX-data-move.log')) ? fs.readFileSync(path.join(a.roaming, 'AionDX-data-move.log'), 'utf8') : '';
  check('the choice is logged', /using .*AionUi in place/.test(log), log);
  check('AionDX holds no chats of its own yet', !fs.existsSync(path.join(dx, 'aionui')), fs.existsSync(dx) ? fs.readdirSync(dx).join(',') : '(none)');

  const b = await run('fresh', 9582, false);
  check('a PC with no earlier folder gets AionDX', fs.existsSync(path.join(b.roaming, 'AionDX')) && fs.readdirSync(path.join(b.roaming, 'AionDX')).length > 3);
  check('and no AionUi folder at all', !fs.existsSync(path.join(b.roaming, 'AionUi')), fs.readdirSync(b.roaming).join(','));
  const names = fs.readdirSync(b.roaming);
  check('nothing in Roaming is named AionUi', !names.some((n) => /aionui/i.test(n)), names.join(','));

  rm(base);
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); rm(base); process.exit(2); });