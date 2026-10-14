#!/usr/bin/env node
/**
 * test-restart-block.js - the main process's __aiondxRestart (patches/0009-identity), taken out of apply.js's helper and run with a
 * stand-in electron, against the real aiondx-restart.js copied where the app keeps it (out/aiondx next to out/main).
 *   node patches\0009-identity\test-restart-block.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-restart-block-'));
fs.mkdirSync(path.join(root, 'out', 'main'), { recursive: true });
fs.mkdirSync(path.join(root, 'out', 'aiondx'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'aiondx-restart.js'), path.join(root, 'out', 'aiondx', 'aiondx-restart.js'));
const marker = path.join(root, 'quitting.json');
process.env.AIONDX_QUIT_MARKER = marker;
for (const k of ['AIONDX_NO_RESTART_WAIT', 'AIONUI_MULTI_INSTANCE', 'AIONUI_E2E_TEST']) delete process.env[k];

const src = fs.readFileSync(path.join(__dirname, 'apply.js'), 'utf8');
const m = /const HELPER = `([\s\S]*?)\n`;/.exec(src);
const HELPER_BEGIN = '/* B', HELPER_END = '/* E */';
const body = eval('`' + m[1] + '`');
const k = body.indexOf('function __aiondxRestartStart');
if (k < 0) { console.log('FAIL  the helper has no __aiondxRestart block'); process.exit(1); }
const block = body.slice(k, body.indexOf(HELPER_END, k));

let lockAsks = 0;
function run() {
  const handlers = {};
  lockAsks = 0;
  // A lock that fails twice, as one does right after the previous process: the block must keep asking.
  const electron = { app: { on: (ev, fn) => { handlers[ev] = fn; }, requestSingleInstanceLock: () => { lockAsks++; return lockAsks >= 3; } } };
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const t = Date.now();
  try { new Function('path__namespace', 'fs__namespace', 'require$$0$2', 'require', '__dirname', block + '\n__aiondxRestartStart();')(path, fs, electron, require, path.join(root, 'out', 'main')); }
  finally { console.log = realLog; }
  return { handlers, logs, ms: Date.now() - t };
}

// Nothing marked: no wait, and the quit hook is registered.
let r = run();
check('with no marker the start does not wait, and the quit marks itself', r.ms < 400 && typeof r.handlers['before-quit'] === 'function' && r.logs.length === 0, JSON.stringify([r.ms, r.logs]));
r.handlers['before-quit']();
const mk = JSON.parse(fs.readFileSync(marker, 'utf8'));
check('before-quit writes this process\'s marker', mk.pid === process.pid && Math.abs(mk.at - Date.now()) < 5000, JSON.stringify(mk));
fs.unlinkSync(marker);

// A previous AionDX still closing: the block holds the start until it is gone, and says so.
const prev = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 2200)'], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(marker, JSON.stringify({ pid: prev.pid, at: Date.now() }));
r = run();
check('a previous AionDX still closing holds the start until it exits', r.ms >= 1500 && r.ms < 9000 && prev.exitCode !== undefined, r.ms);
check('and the log says how long it waited', r.logs.some((l) => /^\[AionDX\] waited \d+(\.\d)? s for the previous AionDX to finish closing$/.test(l)), JSON.stringify(r.logs));
check('and the finished start leaves no marker behind', !fs.existsSync(marker));
check('and it takes the single-instance lock itself, asking again while Windows lets go of it', lockAsks === 3 && r.logs.some((l) => /single-instance lock taken/.test(l)), JSON.stringify([lockAsks, r.logs]));

// The switches.
for (const [name, env] of [['AIONDX_NO_RESTART_WAIT=1', 'AIONDX_NO_RESTART_WAIT'], ['multi-instance mode', 'AIONUI_MULTI_INSTANCE'], ['the test mode', 'AIONUI_E2E_TEST']]) {
  const p = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(marker, JSON.stringify({ pid: p.pid, at: Date.now() }));
  process.env[env] = '1';
  r = run();
  delete process.env[env];
  check(name + ' skips it', r.ms < 400 && Object.keys(r.handlers).length === 0, r.ms);
  p.kill();
}

clearTimeout(deadline);
fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
