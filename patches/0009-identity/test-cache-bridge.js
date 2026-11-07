#!/usr/bin/env node
/**
 * test-cache-bridge.js - the main process's aiondx:cache (patches/0009-identity), run on its own: the block is taken out of apply.js's helper,
 * given a stand-in electron, and pointed at aiondx-cache.js with a throwaway home folder.
 *   node patches\0009-identity\test-cache-bridge.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 120000);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-cache-bridge-'));
const put = (rel, ageDays, size) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(size || 100, 1));
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(f, t, t);
};
put('home/.claude/.credentials.json', 400);
put('home/.claude/cache/old.bin', 40, 1000);
put('home/.claude/projects/p/old.jsonl', 40);
put('home/.claude/projects/p/new.jsonl', 0);
process.env.AIONDX_CACHE_HOME = path.join(root, 'home');
process.env.AIONDX_CACHE_APPDATA = path.join(root, 'appdata');
process.env.AIONDX_CACHE_LOCAL = path.join(root, 'local');
process.env.AIONDX_CACHE_BUSY_MS = '60000';
process.env.AIONDX_CACHE_SCRIPT = path.join(__dirname, 'aiondx-cache.js');

// The block, out of the template it lives in.
const src = fs.readFileSync(path.join(__dirname, 'apply.js'), 'utf8');
const m = /const HELPER = `([\s\S]*?)\n`;/.exec(src);
const HELPER_BEGIN = '/* B', HELPER_END = '/* E */';
const body = eval('`' + m[1] + '`');
const k = body.indexOf('(function __aiondxCache');
if (k < 0) { console.log('FAIL  the helper has no __aiondxCache block'); process.exit(1); }
const block = body.slice(k, body.indexOf(HELPER_END, k));
const handlers = {};
const electron = { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, app: { getPath: () => path.join(root, 'userData') } };
new Function('path__namespace', 'fs__namespace', 'require$$0$2', 'require', '__dirname', block)(path, fs, electron, require, path.join(root, 'out', 'main'));
const call = (req) => handlers['aiondx:cache'](null, req);

(async () => {
  try {
    check('the block registers aiondx:cache', typeof handlers['aiondx:cache'] === 'function');
    let r = await call({ op: 'profiles' });
    check('profiles: lists what is on the PC', r.ok && r.profiles.some((p) => p.id === 'claude:main'), JSON.stringify(r));
    r = await call({ op: 'scan', profile: 'claude:main', days: 7 });
    check('scan: counts, deletes nothing', r.ok && r.groups.cache.count === 1 && r.groups.history.count === 1 && fs.existsSync(path.join(root, 'home/.claude/cache/old.bin')), JSON.stringify(r));
    r = await call({ op: 'scan', profile: 'claude:main', days: 0 });
    check('scan with no age: the cache counts everything, history says to choose an age', r.ok && r.groups.cache.count === 1 && !!r.groups.history.error, JSON.stringify(r));
    r = await call({ op: 'clear', profile: 'claude:main', group: 'history', days: 0 });
    check('clear history with no age is refused', r.ok === false && /1 day/.test(r.error || ''), JSON.stringify(r));
    // Two at once: the second is told to wait.
    const a = call({ op: 'scan', profile: 'claude:main', days: 7 });
    const b = await call({ op: 'scan', profile: 'claude:main', days: 7 });
    await a;
    check('a second request while one runs is told so', b.ok === false && /still running/.test(b.error || ''), JSON.stringify(b));
    r = await call({ op: 'clear', profile: 'claude:main', group: 'history', days: 7 });
    check('clear history: the old transcript goes, the new one and the credentials stay', r.ok && r.deleted === 1 && !fs.existsSync(path.join(root, 'home/.claude/projects/p/old.jsonl')) &&
      fs.existsSync(path.join(root, 'home/.claude/projects/p/new.jsonl')) && fs.existsSync(path.join(root, 'home/.claude/.credentials.json')), JSON.stringify(r));
    r = await call({ op: 'clear', profile: 'claude:main', group: 'cache', days: 7 });
    check('clear cache: the old cache file goes', r.ok && r.deleted === 1 && !fs.existsSync(path.join(root, 'home/.claude/cache/old.bin')), JSON.stringify(r));
    // What the page may not ask for.
    for (const [what, req] of [['a profile that is a path', { op: 'scan', profile: '..\\..\\x', days: 1 }], ['a negative age', { op: 'scan', profile: 'devin', days: -1 }],
      ['a fractional age', { op: 'scan', profile: 'devin', days: 1.5 }], ['an absurd age', { op: 'scan', profile: 'devin', days: 99999 }],
      ['a group it does not have', { op: 'clear', profile: 'devin', group: 'everything', days: 7 }], ['an unknown request', { op: 'format' }], ['no request', null]]) {
      const x = await call(req);
      check('refused: ' + what, x.ok === false, JSON.stringify(x));
    }
    r = await call({ op: 'scan', profile: 'nope', days: 1 });
    check('an unknown profile is an error', r.ok === false || (r.ok && r.error), JSON.stringify(r));
  } catch (e) { check('the test ran', false, e && e.stack); }
  clearTimeout(deadline);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
