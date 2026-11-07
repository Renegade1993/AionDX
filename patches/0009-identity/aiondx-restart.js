/**
 * aiondx-restart.js - opening AionDX again while the one just closed is still finishing (a request of 2026-10-13).
 *
 * The fault, which AionUi has too: closing does not quit at once. The main process stops the backend (AionCore) first, up to ten seconds, and
 * holds the single-instance lock all that time. Opening AionDX in that window started a process that lost the lock, told the closing one to
 * show its window, and quit; the closing one showed a window for half a second, finished quitting, and took the window with it. Nothing
 * was open, and a leftover AionCore could still hold the database when the next try came.
 *
 * What this does, run by the main process before it asks for the lock (patch 0009 helper, __aiondxRestart):
 *   - a closing AionDX leaves a small marker file (its process id and the time) as soon as the quit begins; it stays until the next start
 *     has dealt with it;
 *   - a starting AionDX that finds a marker whose process is still alive waits for that process to go (at most a minute, so a stuck one
 *     cannot block it for good) and then starts normally, as the first instance, instead of poking the closing one;
 *   - right after a quit, an AionCore left behind by the dead process (its parent gone, started from this install) gets a few seconds to
 *     finish and is then ended, so it cannot hold the database against the new one.
 * No marker, a stale one (older than 2.5 minutes), or one with no live process means nothing is waited for. Test overrides:
 * AIONDX_QUIT_MARKER (the file). AIONDX_NO_RESTART_WAIT=1 switches it off.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const MAX_AGE_MS = 150000;      // a marker older than this is a leftover from a crash
const WAIT_MS = 60000;          // the longest a start waits for the closing one
const RECENT_MS = 10 * 60000;   // an AionCore is only called a leftover this soon after a quit

const markerFile = () => process.env.AIONDX_QUIT_MARKER || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AionDX', 'quitting.json');

function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readMarker() {
  try {
    const m = JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
    return m && Number(m.pid) > 0 && Number(m.at) > 0 ? { pid: Number(m.pid), at: Number(m.at) } : null;
  } catch (e) { return null; }
}

/** The quit has begun: say so. */
function markQuitting() {
  try {
    fs.mkdirSync(path.dirname(markerFile()), { recursive: true });
    fs.writeFileSync(markerFile(), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch (e) { /* the quit goes on */ }
}
/** Take this process's own marker away (never another process's): a quit that did not go through. */
function clearMarker() {
  try { const m = readMarker(); if (m && m.pid === process.pid) fs.unlinkSync(markerFile()); } catch (e) { /* nothing to do */ }
}

/**
 * At start. Waits while the process that left the marker is alive. Returns { waited, recent, gone }:
 * recent says a quit happened within ten minutes (so a leftover AionCore is worth looking for).
 */
function waitForPreviousExit(opts) {
  const o = opts || {};
  const m = readMarker();
  if (!m || m.pid === process.pid) return { waited: 0, recent: false, gone: true };
  const age = Date.now() - m.at;
  if (age > MAX_AGE_MS) return { waited: 0, recent: age < RECENT_MS, gone: true, stale: true };
  const start = Date.now();
  const limit = o.timeoutMs !== undefined ? o.timeoutMs : WAIT_MS;
  while (alive(m.pid) && Date.now() - start < limit) sleep(150);
  const gone = !alive(m.pid);
  return { waited: Date.now() - start, recent: true, gone };
}

/** AionCore processes of this install whose parent is gone: [{ pid, parent }]. Windows only. */
function listOrphans(resourcesDir) {
  if (process.platform !== 'win32') return [];
  try {
    const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='aioncore.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)\" }"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const mine = path.resolve(resourcesDir || '').toLowerCase() + path.sep;
    return String(out).split(/\r?\n/).map((l) => l.split('|')).filter((p) => p.length >= 3 && p[2] && path.resolve(p[2]).toLowerCase().startsWith(mine))
      .map((p) => ({ pid: Number(p[0]), parent: Number(p[1]) })).filter((p) => p.pid > 0 && !alive(p.parent));
  } catch (e) { return []; }
}

/**
 * Give leftover AionCores a few seconds to finish by themselves, then end what remains. Injected list and kill functions are for tests.
 * Returns the process ids it had to end.
 */
function reapOrphans(opts) {
  const o = opts || {};
  const list = o.list || (() => listOrphans(o.resourcesDir));
  const kill = o.kill || ((pid) => { try { process.kill(pid); } catch (e) { /* gone already */ } });
  const graceMs = o.graceMs !== undefined ? o.graceMs : 15000;
  const start = Date.now();
  let left = list();
  while (left.length && Date.now() - start < graceMs) { sleep(500); left = list(); }
  const ended = [];
  for (const p of left) { kill(p.pid); ended.push(p.pid); }
  return ended;
}

/**
 * Take the single-instance lock now, trying again for a few seconds. Needed right after the previous AionDX is gone: its process counts as
 * gone as soon as its exit code is set, which is a moment before Windows has let go of the lock file, so the first request can fail ("Another
 * instance is already running", a window that never opens) even though nothing is running. A request that succeeds keeps the lock for this
 * process, and AionUi's own request later returns true. Returns whether the lock is held.
 */
function takeLock(app, timeoutMs) {
  const limit = timeoutMs !== undefined ? timeoutMs : 8000;
  const start = Date.now();
  for (;;) {
    let got = false;
    try { got = !!app.requestSingleInstanceLock(); } catch (e) { return false; }
    if (got) return true;
    if (Date.now() - start >= limit) return false;
    sleep(250);
  }
}

let lastWait = null;
/** What the last atStart found: { waited, recent, gone }, or null when it did not run. */
function lastStart() { return lastWait; }

/** The whole start-up step, as the main process runs it. Returns a line for the log, or '' when there was nothing to do. */
function atStart(opts) {
  const o = opts || {};
  lastWait = null;
  if (process.env.AIONDX_NO_RESTART_WAIT === '1') return '';
  const w = waitForPreviousExit(o);
  lastWait = w;
  const parts = [];
  if (w.waited > 500) parts.push('waited ' + Math.round(w.waited / 100) / 10 + ' s for the previous AionDX to finish closing' + (w.gone ? '' : ' (it had not by then)'));
  if (w.recent && w.gone && o.resourcesDir) {
    const ended = reapOrphans({ resourcesDir: o.resourcesDir, graceMs: o.graceMs });
    if (ended.length) parts.push('ended ' + ended.length + ' AionCore left behind by it');
  }
  // The marker has done its work once its process is gone: the next start has nothing to check.
  try { const m = readMarker(); if (m && m.pid !== process.pid && !alive(m.pid)) fs.unlinkSync(markerFile()); } catch (e) { /* left for the next start */ }
  return parts.join('; ');
}

module.exports = { markQuitting, clearMarker, waitForPreviousExit, reapOrphans, listOrphans, atStart, takeLock, lastStart, alive, readMarker, markerFile };
