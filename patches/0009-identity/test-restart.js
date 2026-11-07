#!/usr/bin/env node
/**
 * test-restart.js - aiondx-restart.js with real processes: a start that finds the previous AionDX still closing waits for it, and only
 * for as long as it is really there.
 *   node patches\0009-identity\test-restart.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 90000);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-restart-test-'));
const marker = path.join(dir, 'quitting.json');
process.env.AIONDX_QUIT_MARKER = marker;
delete process.env.AIONDX_NO_RESTART_WAIT;
const r = require('./aiondx-restart.js');

const children = [];
function sleeper(ms) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, ' + ms + ')'], { stdio: 'ignore', windowsHide: true });
  children.push(c);
  return c;
}
const write = (pid, at) => fs.writeFileSync(marker, JSON.stringify({ pid, at }));
const gone = () => { try { fs.unlinkSync(marker); } catch (e) { /* none */ } };
const t0 = () => Date.now();

// No marker.
gone();
let t = t0();
check('no marker: nothing to wait for, and the step says nothing', r.atStart({}) === '' && t0() - t < 300);
// Our own marker (this process began a quit and is starting again?): not waited for.
write(process.pid, Date.now());
t = t0();
check('a marker with this process\'s own id is ignored', r.waitForPreviousExit({}).waited === 0 && t0() - t < 300);

// A closing process that is still alive: the start waits until it is gone, then goes on.
const a = sleeper(2500);
write(a.pid, Date.now());
t = t0();
let w = r.waitForPreviousExit({ timeoutMs: 20000 });
check('a marker whose process is alive: the start waits until it exits', w.gone === true && w.recent === true && w.waited >= 1800 && w.waited < 8000 && !r.alive(a.pid), JSON.stringify(w));

// One that never goes: the wait has a limit.
const b = sleeper(15000);
write(b.pid, Date.now());
t = t0();
w = r.waitForPreviousExit({ timeoutMs: 700 });
check('a process that does not go is waited for only up to the limit', w.gone === false && w.waited >= 650 && w.waited < 3000 && r.alive(b.pid), JSON.stringify(w));
const line = r.atStart({ timeoutMs: 600 });
b.kill();
check('and the step reports the wait and that it had not finished', /^waited 0\.[6-9] s for the previous AionDX to finish closing \(it had not by then\)$/.test(line), line);

// A stale marker (older than two and a half minutes) is a leftover: its live process is not waited for.
const c = sleeper(5000);
write(c.pid, Date.now() - 200000);
t = t0();
w = r.waitForPreviousExit({ timeoutMs: 20000 });
check('a marker older than 2.5 minutes is not waited for, even when a process has that id', w.stale === true && w.waited === 0 && t0() - t < 500, JSON.stringify(w));
c.kill();

// A dead process: no wait, but a quit just happened, so a leftover AionCore is worth looking for.
write(99999999, Date.now() - 5000);
w = r.waitForPreviousExit({});
check('a marker whose process is already gone: no wait, and it counts as a recent quit', w.waited === 0 && w.gone === true && w.recent === true, JSON.stringify(w));
write(99999999, Date.now() - 3600000);
w = r.waitForPreviousExit({});
check('an hour-old marker is not a recent quit', w.waited === 0 && w.recent === false, JSON.stringify(w));

// The step cleans up a marker whose process is dead, and leaves one whose process is still there.
write(99999999, Date.now() - 5000);
r.atStart({});
check('after a start has dealt with it, a dead process\'s marker is removed', !fs.existsSync(marker));
const d = sleeper(6000);
write(d.pid, Date.now());
const said = r.atStart({ timeoutMs: 400 });
check('a marker whose process is still there is kept', fs.existsSync(marker) && r.alive(d.pid), said);
d.kill();

// Marking and clearing: only this process's own marker.
gone();
r.markQuitting();
let m = r.readMarker();
check('markQuitting writes this process\'s id and the time', m && m.pid === process.pid && Math.abs(m.at - Date.now()) < 5000, JSON.stringify(m));
r.clearMarker();
check('clearMarker removes its own marker', !fs.existsSync(marker));
write(12345, Date.now());
r.clearMarker();
check('and never another process\'s', fs.existsSync(marker));

// Leftover AionCore handling, with injected lists.
let calls = 0;
const killed = [];
let ended = r.reapOrphans({ list: () => (++calls <= 2 ? [{ pid: 4242, parent: 1 }] : []), kill: (p) => killed.push(p), graceMs: 5000 });
check('an AionCore that finishes within the grace time is left alone', ended.length === 0 && killed.length === 0, JSON.stringify([ended, killed, calls]));
ended = r.reapOrphans({ list: () => [{ pid: 4343, parent: 1 }, { pid: 4444, parent: 1 }], kill: (p) => killed.push(p), graceMs: 700 });
check('one that does not is ended after the grace time', JSON.stringify(ended) === JSON.stringify([4343, 4444]) && JSON.stringify(killed) === JSON.stringify([4343, 4444]), JSON.stringify([ended, killed]));
check('with none left behind, nothing is ended', r.reapOrphans({ list: () => [], kill: (p) => killed.push(p), graceMs: 200 }).length === 0);
// The real lookup, against a folder nothing runs from: finds nothing, ends nothing, does not throw.
t = t0();
const real = r.listOrphans(path.join(dir, 'no-such-install'));
check('the real process lookup finds nothing for an install that is not running', Array.isArray(real) && real.length === 0, JSON.stringify(real) + ' ' + (t0() - t) + ' ms');

// Taking the lock again after the previous process is gone (its exit code is set a moment before the lock file is let go).
let asks = 0;
t = t0();
check('takeLock asks again until the lock is free', r.takeLock({ requestSingleInstanceLock: () => ++asks >= 3 }, 5000) === true && asks === 3 && t0() - t >= 400 && t0() - t < 3000, JSON.stringify([asks, t0() - t]));
asks = 0;
t = t0();
check('and gives up at its limit', r.takeLock({ requestSingleInstanceLock: () => { asks++; return false; } }, 700) === false && asks >= 2 && t0() - t < 3000, JSON.stringify([asks, t0() - t]));
check('a lock call that throws is not retried', r.takeLock({ requestSingleInstanceLock: () => { throw new Error('no'); } }, 2000) === false);
write(99999999, Date.now() - 5000);
r.atStart({});
check('atStart records what it found, for the lock step', r.lastStart() && r.lastStart().recent === true && r.lastStart().gone === true, JSON.stringify(r.lastStart()));

// The switch.
write(99999999, Date.now() - 1000);
process.env.AIONDX_NO_RESTART_WAIT = '1';
const e = sleeper(4000);
write(e.pid, Date.now());
t = t0();
check('AIONDX_NO_RESTART_WAIT=1 switches the step off', r.atStart({}) === '' && t0() - t < 300);
e.kill();

for (const c of children) { try { c.kill(); } catch (x) { /* gone */ } }
clearTimeout(deadline);
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
