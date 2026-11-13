#!/usr/bin/env node
/**
 * aiondx-portable-move.js - moves AionDX's data folder to a drive while AionDX is closed, then opens AionDX again (R-102, 2026-11-12).
 *
 *   node aiondx-portable-move.js --from <data folder> --to <new folder> --app <AionDX.exe> [--wait-pid <pid>] [--engine <aiondx-data-move.js>]
 *
 * Started, hidden and detached, by AionDX's "Move my chats to a drive" (main process, aiondx:portable), which then closes AionDX: a data folder
 * cannot be moved by the program that has it open (Chromium holds files in it from the first moment). Steps: wait until AionDX (the pid) and its
 * backend are gone (2 minutes at most, else nothing is done); run aiondx-data-move.js run --from --to --portable (copy to the drive, rewrite
 * every stored path, Claude history folders renamed, verify, everything undone on a failure; the old folder is kept under a new name); write
 * the outcome to %LOCALAPPDATA%\AionDX\data-move\portable-last.json, which the page shows once; open AionDX again either way. Hard deadline
 * 2 hours.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = opt('--from'), TO = opt('--to'), APP = opt('--app'), PID = Number(opt('--wait-pid', 0));
const ENGINE = opt('--engine', path.join(__dirname, 'aiondx-data-move.js'));
const POINTER = opt('--pointer', null);   // where this PC's pointer goes (the app's own Roaming folder)
// Started through WMI by AionDX, so this process has the user's own environment, not AionDX's: what it must know comes as arguments.
const LOCAL = opt('--local', process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
const HOME_ARG = opt('--home', null), ROAMING_ARG = opt('--roaming', null);
const SKIP_CHECK = argv.includes('--skip-process-check') || process.env.AIONDX_MOVER_SKIP_PROCESS_CHECK === '1';
const NO_REOPEN = argv.includes('--no-reopen') || process.env.AIONDX_MOVER_NO_REOPEN === '1';
const OUT = path.join(LOCAL, 'AionDX', 'data-move', 'portable-last.json');
const deadline = setTimeout(() => { write({ state: 'failed', error: 'the move ran past its two-hour deadline' }); process.exit(9); }, 2 * 3600000);
deadline.unref();

function write(o) {
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(Object.assign({ v: 1, at: Date.now(), from: FROM, to: TO }, o), null, 2)); } catch (e) { /* nowhere to write */ }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function running(image) {
  if (SKIP_CHECK) return false;   // tests: the PC running the test has its own AionDX open
  try { return /\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })); } catch (e) { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reopen() {
  if (NO_REOPEN) return;   // tests start the app themselves
  if (!APP || !fs.existsSync(APP)) return;
  try { spawn(APP, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch (e) { /* the user opens it */ }
}

(async () => {
  if (!FROM || !TO) { write({ state: 'failed', error: 'no --from or --to' }); process.exit(2); }
  write({ state: 'waiting' });
  const until = Date.now() + 120000;
  while (PID && alive(PID) && Date.now() < until) await sleep(500);
  const exe = APP ? path.basename(APP) : 'AionDX.exe';
  while ((running(exe) || running('aioncore.exe')) && Date.now() < until) await sleep(1000);
  if ((PID && alive(PID)) || running(exe) || running('aioncore.exe')) {
    write({ state: 'failed', error: 'AionDX did not close within two minutes, so nothing was moved' });
    reopen();
    process.exit(5);
  }
  write({ state: 'moving' });
  const r = spawnSync(process.execPath, ['--no-warnings', ENGINE, 'run', '--from', FROM, '--to', TO, '--portable', '--local', LOCAL].concat(POINTER ? ['--pointer', POINTER] : [])
    .concat(HOME_ARG ? ['--home', HOME_ARG] : []).concat(ROAMING_ARG ? ['--roaming', ROAMING_ARG] : []), { encoding: 'utf8', windowsHide: true, timeout: 2 * 3600000 - 180000 });
  const tail = String((r.stdout || '') + (r.stderr || '')).split('\n').filter(Boolean).slice(-12);
  write({ state: r.status === 0 ? 'done' : 'failed', code: r.status, log: tail });
  reopen();
  process.exit(r.status === 0 ? 0 : (r.status || 1));
})().catch((e) => { write({ state: 'failed', error: String(e && e.message || e) }); reopen(); process.exit(1); });
