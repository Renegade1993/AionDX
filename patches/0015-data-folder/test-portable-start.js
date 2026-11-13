'use strict';
// test-portable-start.js - patch 0015's start-up check for an AionDX drive (R-102, 2026-11-12), run on its own: the injected block is taken out
// of apply.js and run with a stand-in Electron app against made-up folders. At start only this PC's pointer is read; no drive is searched
// (that runs later, in the background: test-portable.js in patches\0009-identity). Nothing real is read or written.
//   node patches\0015-data-folder\test-portable-start.js
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-portable-start-'));
const src = fs.readFileSync(path.join(__dirname, 'apply.js'), 'utf8');
const body = eval('`' + /const BLOCK = MARK \+ `([\s\S]*?)`;/.exec(src)[1] + '`');
const portable = body.slice(body.indexOf('(function aiondxPortableDrive'), body.indexOf('(function aiondxDataFolder'));

function scene(name) {
  const root = path.join(base, name);
  const appData = path.join(root, 'Roaming');
  fs.mkdirSync(appData, { recursive: true });
  return { root, appData };
}
function makeData(dir, id) {
  fs.mkdirSync(path.join(dir, 'aionui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'aionui', 'aiondx-backend.db'), 'db');
  fs.writeFileSync(path.join(dir, 'aiondx-portable.json'), JSON.stringify({ v: 1, id, path: dir }));
  return dir;
}
const pointer = (sc, dir, id) => fs.writeFileSync(path.join(sc.appData, 'AionDX-location.json'), JSON.stringify({ v: 1, id, path: dir }));
function start(sc) {
  const set = [];
  const app = { getPath: (k) => (k === 'appData' ? sc.appData : path.join(sc.appData, 'AionDX')), setPath: (k, v) => set.push([k, v]) };
  delete global.__aiondxPortable;
  const t = Date.now();
  new Function('require', portable)((m) => (m === 'electron' ? { app } : require(m)));
  return { set, st: global.__aiondxPortable, ms: Date.now() - t };
}
try {
  let sc = scene('none');
  let r = start(sc);
  check('no pointer: nothing changes and no drive is searched at start', r.st.state === 'none' && r.set.length === 0, JSON.stringify(r));

  sc = scene('using');
  const dir = makeData(path.join(sc.root, 'drive', 'AionDX-Data'), 'id1');
  pointer(sc, dir, 'id1');
  r = start(sc);
  check("the pointer's folder is there: AionDX opens it", r.st.state === 'using' && r.st.path === dir && JSON.stringify(r.set) === JSON.stringify([['userData', dir]]), JSON.stringify(r));

  fs.renameSync(path.join(sc.root, 'drive'), path.join(sc.root, 'unplugged'));
  r = start(sc);
  check("the drive unplugged: this PC's own chats open, and the page is told it is missing", r.st.state === 'missing' && r.st.path === dir && r.set.length === 0, JSON.stringify(r));

  sc = scene('otherid');
  const dir2 = makeData(path.join(sc.root, 'drive', 'AionDX-Data'), 'someone-else');
  pointer(sc, dir2, 'id2');
  r = start(sc);
  check('a folder at the pointer with another id (another AionDX drive) is not opened', r.st.state === 'missing' && r.set.length === 0, JSON.stringify(r));

  sc = scene('nodb');
  const dir3 = makeData(path.join(sc.root, 'drive', 'AionDX-Data'), 'id3');
  fs.rmSync(path.join(dir3, 'aionui'), { recursive: true, force: true });
  pointer(sc, dir3, 'id3');
  r = start(sc);
  check('a marked folder with no chats database is not opened', r.st.state === 'missing' && r.set.length === 0, JSON.stringify(r));

  sc = scene('badpointer');
  fs.writeFileSync(path.join(sc.appData, 'AionDX-location.json'), '{ not json');
  r = start(sc);
  check('a pointer that is not readable changes nothing', r.st.state === 'none' && r.set.length === 0, JSON.stringify(r));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
