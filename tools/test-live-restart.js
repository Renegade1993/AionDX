#!/usr/bin/env node
/**
 * test-live-restart.js - closing AionDX and opening it again at once, in the real staged app and a throwaway profile (a request of 2026-10-13:
 * "if you close it, and try to open it again, it pops up for half a second, and then dies"). Nothing of the installed AionDX is touched.
 *
 *   1. A starts. It is closed the way the window's X closes it (a close request, not a kill), and B is started on the same profile a moment
 *      later, while A is still stopping its backend. B must open a window and keep it.
 *   2. A marker names a process that is still alive (a stand-in for a closing AionDX). The app started on it must wait for that process to
 *      go before it opens, and must say so in its log.
 *
 * The app's single-instance lock is on here (the live launcher normally switches it off for tests), because the lock is the point.
 *   node tools\test-live-restart.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };

const profile = path.join(os.tmpdir(), 'aiondx-restart-profile');
const marker = path.join(os.tmpdir(), 'aiondx-restart-marker.json');
const env = { AIONUI_E2E_TEST: '', AIONDX_QUIT_MARKER: marker, AIONDX_NO_ACTIVATE: '1' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
const grepLogs = (re) => {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (/\.log$/i.test(e.name) && fs.statSync(f).size < 40 * 1024 * 1024) { try { for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) if (re.test(l)) hits.push(l); } catch (x) { /* unreadable */ } }
    }
  };
  walk(profile, 0);
  return hits;
};

(async () => {
  const apps = [];
  const kill = async () => { for (const a of apps) { try { await a.close(); } catch (e) { /* gone */ } } };
  const hard = setTimeout(() => { console.log('DEADLINE'); kill().then(() => process.exit(2)); }, 420000);
  try {
    try { fs.unlinkSync(marker); } catch (e) { /* none */ }

    // ---- 1. Closed, then opened again at once.
    let t = Date.now();
    const A = await launch({ port: 9571, profile, deadlineMs: 400000, env });
    apps.push(A);
    const baseMs = Date.now() - t;
    check('A starts and opens a window (this is how long a start takes here: ' + Math.round(baseMs / 100) / 10 + ' s)', (await A.js('document.readyState')) !== undefined);
    await sleep(4000);
    // The window is closed from inside, which is what the X does (taskkill cannot send a close to a window on a hidden desktop).
    await A.send('Runtime.evaluate', { expression: 'setTimeout(function () { window.close(); }, 50)' });
    await sleep(450);
    const quitting = alive(A.pid);
    const markerNow = (() => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { return null; } })();
    check('closing A starts its quit and leaves a marker (a process id and the time; A was still there 450 ms later)', quitting && markerNow && markerNow.pid > 0 && Math.abs(markerNow.at - Date.now()) < 15000, JSON.stringify([quitting, markerNow]));
    if (!quitting) console.log('note: A had already gone; the race this test is about did not happen this time');
    t = Date.now();
    const B = await launch({ port: 9572, profile, keepProfile: true, deadlineMs: 400000, env });
    apps.push(B);
    const bMs = Date.now() - t;
    check('B, started while A was still closing, opens a window', !!B.page, bMs);
    check('and A is gone by then', !alive(A.pid));
    await sleep(10000);
    const still = await B.js('document.readyState');
    check('and the window is still there ten seconds later (it does not pop up and die)', alive(B.pid) && still === 'complete', JSON.stringify([alive(B.pid), still]));
    const mk2 = (() => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { return null; } })();
    check('B dealt with A\'s marker', !mk2 || !markerNow || mk2.pid !== markerNow.pid, JSON.stringify(mk2));
    await B.close();
    await sleep(1500);

    // ---- 2. A marker whose process is still alive: the start waits for it.
    const prev = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 14000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(marker, JSON.stringify({ pid: prev.pid, at: Date.now() }));
    t = Date.now();
    const C = await launch({ port: 9573, profile, keepProfile: true, deadlineMs: 400000, env });
    apps.push(C);
    const cMs = Date.now() - t;
    // (Not alive(prev.pid): Windows hands a dead process's id to a new one within seconds, so a pid can look alive long after.)
    check('an app started while the process in the marker is alive does not open until that process is gone', prev.exitCode !== null && cMs >= 12000, JSON.stringify([cMs, prev.exitCode]));
    check('and it opens once the process is gone, about when that happened (not a minute late)', cMs < 14000 + baseMs + 15000, cMs);
    await sleep(2500);
    const said = grepLogs(/\[AionDX\] waited \d+(\.\d)? s for the previous AionDX to finish closing/);
    check('and its log says it waited', said.length >= 1, 'no such line in ' + profile);
    try { prev.kill(); } catch (e) { /* done */ }
    await C.close();
  } catch (e) {
    check('the test ran', false, e && e.message);
    // What the app said: its own lines about waiting and locks, and when the first one quit.
    const lines = grepLogs(/AionDX\]|Another instance|before-quit|will-quit|Cleanup timed out|second-instance|Backend|backend.*(stop|exit)/i);
    console.log('--- log lines (' + lines.length + '), last 25:');
    for (const l of lines.slice(-25)) console.log('  ' + l.slice(0, 220));
    console.log('--- marker now: ' + (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 'none'));
    console.log('--- processes left with this profile: ' + spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'aiondx-restart-profile' }).Count"], { encoding: 'utf8', windowsHide: true }).stdout.trim());
  } finally {
    clearTimeout(hard);
    await kill();
    try { fs.unlinkSync(marker); } catch (e) { /* none */ }
    await sleep(2500);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }); } catch (e) { /* a process is still letting go; the next run clears it */ }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
