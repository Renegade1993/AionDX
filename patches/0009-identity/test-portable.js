'use strict';
// test-portable.js - the main process's aiondx:portable (R-102, 2026-11-12), run on its own: the block is taken out of apply.js's helper and given a
// stand-in electron (app, dialog) and a stand-in mover that only records how it was started. Nothing is moved and no drive letter changes.
//   node patches\0009-identity\test-portable.js
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-portable-test-'));
const userData = path.join(root, 'Roaming', 'AionDX');
fs.mkdirSync(userData, { recursive: true });
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const started = path.join(root, 'mover-args.json');
fs.writeFileSync(path.join(bin, 'aiondx-portable-move.js'), `require('fs').writeFileSync(${JSON.stringify(started)}, JSON.stringify(process.argv.slice(2)));`);
fs.writeFileSync(path.join(bin, 'aiondx-data-move.js'), '// stand-in');
const local = path.join(root, 'Local');
fs.mkdirSync(path.join(local, 'AionDX', 'data-move'), { recursive: true });
process.env.LOCALAPPDATA = local;
process.env.AIONDX_PORTABLE_BIN = bin;
process.env.AIONDX_PORTABLE_NODE = process.execPath;

const src = fs.readFileSync(path.join(__dirname, 'apply.js'), 'utf8');
const m = /const HELPER = `([\s\S]*?)\n`;/.exec(src);
const HELPER_BEGIN = '/* B', HELPER_END = '/* E */';
const body = eval('`' + m[1] + '`');
const k = body.indexOf('(function __aiondxPortable');
const block = body.slice(k, body.indexOf('/** Clearing', k));
const handlers = {};
let quit = 0, nextPick = null;
const electron = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  app: { getPath: () => userData, quit: () => { quit++; }, relaunch: () => {}, exit: () => {} },
  dialog: { showOpenDialog: async () => nextPick },
};
new Function('path__namespace', 'fs__namespace', 'require$$0$2', 'require', block)(path, fs, electron, require);
const call = (req) => handlers['aiondx:portable'](null, req);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  try {
    check('the handler is registered', typeof handlers['aiondx:portable'] === 'function');
    global.__aiondxPortable = { state: 'missing', path: 'H:\\AionDX-Data' };
    fs.writeFileSync(path.join(local, 'AionDX', 'data-move', 'portable-last.json'), JSON.stringify({ state: 'done', to: 'H:\\AionDX-Data' }));
    let r = await call({ op: 'status' });
    check('status: the data folder, what the start found, the last move', r.ok && r.userData === userData && r.portable === false && r.start.state === 'missing' && r.last.state === 'done', JSON.stringify(r));
    fs.writeFileSync(path.join(userData, 'aiondx-portable.json'), '{}');
    r = await call({ op: 'status' });
    check('status: a marked data folder is portable', r.portable === true, JSON.stringify(r));
    nextPick = { canceled: true, filePaths: [] };
    r = await call({ op: 'choose' });
    check('choose: cancelling the picker changes nothing', r.ok === false && r.canceled === true, JSON.stringify(r));
    const pick = path.join(root, 'drive');
    fs.mkdirSync(pick);
    nextPick = { canceled: false, filePaths: [pick] };
    r = await call({ op: 'choose' });
    check('choose: the chats go into a new AionDX-Data folder inside the chosen one', r.ok && r.to === path.join(pick, 'AionDX-Data'), JSON.stringify(r));
    fs.mkdirSync(path.join(pick, 'AionDX-Data')); fs.writeFileSync(path.join(pick, 'AionDX-Data', 'x.txt'), 'x');
    r = await call({ op: 'choose' });
    check('choose: a folder that already holds an AionDX-Data with files is refused', r.ok === false && /already holds files/.test(r.error), JSON.stringify(r));
    nextPick = { canceled: false, filePaths: [path.dirname(userData)] };
    fs.mkdirSync(path.join(userData, 'sub'), { recursive: true });
    nextPick = { canceled: false, filePaths: [path.join(userData, 'sub')] };
    r = await call({ op: 'choose' });
    check("choose: a folder inside AionDX's own data folder is refused", r.ok === false && /inside AionDX/.test(r.error), JSON.stringify(r));
    r = await call({ op: 'move', to: 'relative\\path' });
    check('move: a path that is not absolute is refused', r.ok === false, JSON.stringify(r));
    const to = path.join(pick, 'Fresh', 'AionDX-Data');
    r = await call({ op: 'move', to });
    for (let i = 0; i < 40 && !fs.existsSync(started); i++) await sleep(100);
    const args = fs.existsSync(started) ? JSON.parse(fs.readFileSync(started, 'utf8')) : null;
    await sleep(1000);
    check('move: the mover starts (through WMI, outside the app process tree) with this data folder, the new folder, this program and pid, and AionDX closes',
      r.ok && r.via === 'wmi' && args && args[args.indexOf('--from') + 1] === userData && args[args.indexOf('--to') + 1] === to && args[args.indexOf('--wait-pid') + 1] === String(process.pid) && quit === 1, JSON.stringify([r, args, quit]));
    // scan (background, after the start): made-up drive roots; each root is given 1.5 s, so a slow one cannot hold the answer
    const rootA = path.join(root, 'driveA') + path.sep, rootB = path.join(root, 'driveB') + path.sep;
    const mkDrive = (r0, id, letter) => {
      const dir = path.join(r0, 'AionDX-Data');
      fs.mkdirSync(path.join(dir, 'aionui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'aiondx-portable.json'), JSON.stringify({ v: 1, id, path: dir }));
      fs.writeFileSync(path.join(r0, 'AionDX-drive.json'), JSON.stringify({ v: 1, id, dataPath: 'AionDX-Data', letter }));
      return dir;
    };
    fs.mkdirSync(rootA, { recursive: true });
    const dirB = mkDrive(rootB, 'idB', rootB.slice(0, 1).toUpperCase());
    process.env.AIONDX_PORTABLE_ROOTS = [rootA, rootB].join(';');
    electron.app.getPath = (k) => (k === 'appData' ? path.join(root, 'Roaming') : userData);
    r = await call({ op: 'scan' });
    check('scan: finds an AionDX drive (its folder, its id, its letter now and the one it was made with)', r.ok && r.found.length === 1 && r.found[0].dir === dirB &&
      r.found[0].id === 'idB' && r.found[0].have === r.found[0].want && r.pointer === null, JSON.stringify(r));
    fs.writeFileSync(path.join(rootB, 'AionDX-drive.json'), JSON.stringify({ v: 1, id: 'idB', dataPath: 'AionDX-Data', letter: 'Q' }));
    r = await call({ op: 'scan' });
    check('scan: a drive made under another letter says both letters', r.found.length === 1 && r.found[0].want === 'Q' && r.found[0].have !== 'Q', JSON.stringify(r));
    r = await call({ op: 'adopt', dir: dirB, id: 'wrong' });
    check('adopt: a folder whose id does not match is refused', r.ok === false, JSON.stringify(r));
    r = await call({ op: 'adopt', dir: dirB, id: 'idB' });
    const ptr = JSON.parse(fs.readFileSync(path.join(root, 'Roaming', 'AionDX-location.json'), 'utf8'));
    check('adopt: writes this PC\'s pointer to the drive (AionDX then restarts into it)', r.ok && ptr.path === dirB && ptr.id === 'idB', JSON.stringify([r, ptr]));
    mkDrive(rootA, 'someone-else', rootA.slice(0, 1).toUpperCase());
    r = await call({ op: 'scan' });
    check('scan: with a pointer, another AionDX drive is not offered', r.found.length === 1 && r.found[0].id === 'idB', JSON.stringify(r));
    delete process.env.AIONDX_PORTABLE_ROOTS;
    r = await call({ op: 'letter', have: 'E', want: 'E' });
    check('letter: the same letter, or not a letter, is refused', r.ok === false, JSON.stringify(r));
    r = await call({ op: 'letter', have: 'Q', want: 'C' });
    check('letter: C: is never a target', r.ok === false, JSON.stringify(r));
    const inUse = ['D', 'E', 'F', 'G', 'H'].find((l) => fs.existsSync(l + ':\\'));
    if (inUse) {
      r = await call({ op: 'letter', have: 'Z', want: inUse });
      check('letter: a letter already in use on this PC is refused with what to do (no prompt)', r.ok === false && /already in use/.test(r.error), JSON.stringify(r));
    }
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    clearTimeout(deadline);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
