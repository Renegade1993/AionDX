#!/usr/bin/env node
'use strict';
/**
 * test-places-main.js - aiondx-places-main.js (R-130) with a stand-in for Electron, running the real mover (patches/0016-data-move) on
 * made-up folders: two "PCs" (two databases and user folders) and a folder standing in for a drive's root. Nothing of this PC's chats.
 *   node patches\0009-identity\test-places-main.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-places-main-'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000);
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ } });

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, type TEXT, extra TEXT, created_at INTEGER, updated_at INTEGER, project_id TEXT, folder_id TEXT, archived_at INTEGER);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, created_at INTEGER);
CREATE TABLE acp_session (conversation_id TEXT PRIMARY KEY, session_config TEXT);
CREATE TABLE teams (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, workspace TEXT, agents TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
CREATE TABLE mailbox (id TEXT PRIMARY KEY, team_id TEXT, content TEXT, files TEXT, created_at INTEGER);
CREATE TABLE team_tasks (id TEXT PRIMARY KEY, team_id TEXT, description TEXT, created_at INTEGER);`;

function makePc(name, user, chats) {
  const userData = path.join(BASE, name, 'AionDX');
  const home = path.join(BASE, name, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const dbFile = path.join(userData, 'aionui', 'aiondx-backend.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO users VALUES (?,?)').run(user, 'someone');
  for (const c of chats) {
    const ws = path.join(userData, 'aionui', 'conversations', c.id);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'file of ' + c.id);
    db.prepare('INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(c.id, user, c.name, 'acp', JSON.stringify({ workspace: ws }), 1, 100);
    db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(c.id + '-m1', c.id, 'see ' + ws + '\\a.txt', 10);
  }
  db.close();
  return { userData, home, dbFile, work: path.join(BASE, name, 'work') };
}
/** aiondx-places-main.js installed for one "PC": its handler and its before-quit. */
function install(pc, picks) {
  const handlers = {}, quit = [];
  const electron = {
    app: { getPath: () => pc.userData, on: (ev, fn) => { if (ev === 'before-quit') quit.push(fn); } },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    dialog: { showOpenDialog: async () => { const p = picks.shift(); return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] }; } },
    BrowserWindow: { getFocusedWindow: () => null },
  };
  const key = require.resolve('./aiondx-places-main.js');
  delete require.cache[key];
  require('./aiondx-places-main.js').install(electron);
  const env = { AIONDX_PLACES_DB: pc.dbFile, AIONDX_PLACES_HOME: pc.home, AIONDX_PLACES_WORK: pc.work };
  const withEnv = async (fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; } try { return await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
  return { call: (op, args) => withEnv(() => handlers['aiondx:places'](null, Object.assign({}, args, { op }))), quit: () => withEnv(async () => quit.forEach((f) => f())) };
}

process.env.AIONDX_PLACE_MOVER = path.join(__dirname, '..', '0016-data-move', 'aiondx-place-move.js');
process.env.AIONDX_PORTABLE_NODE = process.execPath;
const ROOT = path.join(BASE, 'drive') + path.sep;   // stands in for a drive's root
fs.mkdirSync(ROOT, { recursive: true });
process.env.AIONDX_PORTABLE_ROOTS = ROOT;

(async () => {
  const pc1 = makePc('pc1', 'u1', [{ id: 'c1', name: 'Plan' }, { id: 'c2', name: 'Notes' }]);
  const pc2 = makePc('pc2', 'u2', [{ id: 'x1', name: 'Trip' }]);
  const picks1 = [], picks2 = [];
  const a = install(pc1, picks1);
  let r = await a.call('status');
  check('status: both chats, in AionDX\'s folder', r.ok && r.items.length === 2 && r.items.every((i) => !i.placed && !i.missing && i.exists), JSON.stringify(r));
  const place = path.join(BASE, 'My place');
  r = await a.call('move', { items: [{ kind: 'c', id: 'c1' }], to: place });
  check('move: ok', r.ok && r.moved.length === 1, JSON.stringify(r));
  r = await a.call('status');
  const c1 = r.items.find((i) => i.id === 'c1');
  check('status after a move: placed, its place, the place remembered, the move undoable', c1.placed && c1.place === place && r.places[0] === place && r.last && r.last.op === 'move' && r.last.names[0] === 'Plan', JSON.stringify(r));
  // missing: the package taken away
  fs.renameSync(c1.package, c1.package + '-away');
  r = await a.call('status');
  check('status: a placed chat whose folder went away is missing', r.items.find((i) => i.id === 'c1').missing === true, JSON.stringify(r.items));
  picks1.push(path.join(place));   // Find it: the user points at the folder the package is in now (renamed back under it)
  fs.renameSync(c1.package + '-away', c1.package);
  r = await a.call('relink', { item: { kind: 'c', id: 'c1' }, name: 'Plan' });
  check('Find it with the folder box: ok, the same place', r.ok && r.relinked.at === c1.package, JSON.stringify(r));
  r = await a.call('undo');
  check('undo after Find it: ok', r.ok && r.undone === 'relink', JSON.stringify(r));
  r = await a.call('status');
  check('undo leaves the move in place (only Find it was undone)', r.items.find((i) => i.id === 'c1').placed === true && !r.last, JSON.stringify(r));
  r = await a.call('back', { items: [{ kind: 'c', id: 'c1' }] });
  check('back: ok', r.ok, JSON.stringify(r));
  r = await a.call('undo');
  check('undo the bring-back: ok', r.ok && r.undone === 'back', JSON.stringify(r));
  r = await a.call('status');
  check('after the undo it is placed again', r.items.find((i) => i.id === 'c1').placed === true, JSON.stringify(r.items));
  r = await a.call('groupPlace', { group: 'g1', to: place });
  check('a group\'s place kept', r.ok && r.groups.g1 === place);
  r = await a.call('groupPlace', { group: 'g1', to: null });
  check('and cleared', r.ok && !r.groups.g1);

  // the drive: PC2 moves its chat to the drive and lists it there (as indexOnDrive does on a real drive)
  const b = install(pc2, picks2);
  r = await b.call('move', { items: [{ kind: 'c', id: 'x1' }], to: path.join(ROOT, 'Chats') });
  const pkgX = r.moved && r.moved[0].package;
  check('PC2: its chat to the drive', r.ok && !!pkgX, JSON.stringify(r));
  fs.writeFileSync(path.join(ROOT, 'AionDX-chats.json'), JSON.stringify({ format: 1, packages: [{ id: 'x1', kind: 'c', name: 'Trip', path: path.relative(ROOT, pkgX) }] }));
  r = await a.call('sync');
  check('PC1 sync: the drive\'s chat is offered as coming in', r.ok && r.incoming.length === 1 && r.incoming[0].id === 'x1' && r.incoming[0].package === pkgX, JSON.stringify(r));
  r = await a.call('import', { package: pkgX });
  check('PC1 brings it in', r.ok && r.imported.mode === 'new' && r.imported.id === 'x1', JSON.stringify(r));
  r = await a.call('status');
  check('PC1 now has it, placed on the drive', r.items.some((i) => i.id === 'x1' && i.placed && i.package === pkgX), JSON.stringify(r.items));
  r = await a.call('sync');
  check('next sync: nothing coming in, nothing changed', r.ok && !r.incoming.length && !r.changed.length, JSON.stringify(r));
  // PC2 writes to it, and its sync writes the package
  { const d = new DatabaseSync(pc2.dbFile); d.prepare("INSERT INTO messages VALUES ('x1-m2','x1','more',20)").run(); d.prepare("UPDATE conversations SET updated_at = 200 WHERE id = 'x1'").run(); d.close(); }
  r = await b.call('sync');
  check('PC2 sync writes its change to the drive', r.ok && r.exported === 1, JSON.stringify(r));
  r = await a.call('sync');
  check('PC1 sync sees the drive\'s copy changed by another PC', r.ok && r.changed.length === 1 && r.changed[0].id === 'x1', JSON.stringify(r));
  r = await a.call('import', { package: pkgX });
  check('PC1 takes it (only the drive changed): replaced in place', r.ok && r.imported.mode === 'replace', JSON.stringify(r));
  { const d = new DatabaseSync(pc1.dbFile, { readOnly: true }); const n = d.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'x1'").get().n; d.close(); check('PC1 has PC2\'s new message', n === 2, n); }
  // PC1 changes it and closes: written back on the way out
  { const d = new DatabaseSync(pc1.dbFile); d.prepare("INSERT INTO messages VALUES ('x1-m3','x1','from pc1',30)").run(); d.prepare("UPDATE conversations SET updated_at = 300 WHERE id = 'x1'").run(); d.close(); }
  const before = JSON.parse(fs.readFileSync(path.join(pkgX, 'aiondx-chat.json'), 'utf8')).exportedAt;
  await a.quit();
  const after = JSON.parse(fs.readFileSync(path.join(pkgX, 'aiondx-chat.json'), 'utf8')).exportedAt;
  { const d = new DatabaseSync(path.join(pkgX, 'aiondx-chat.db'), { readOnly: true }); const n = d.prepare('SELECT COUNT(*) AS n FROM messages').get().n; d.close(); check('closing AionDX writes PC1\'s change to the drive', after > before && n === 3, [before, after, n].join(' ')); }
  // R-128: a chat's project
  r = await a.call('projects');
  check('projects: none on a PC without the registry', r.ok && r.projects.length === 0, JSON.stringify(r));
  r = await a.call('bind', { key: 'c:c2', project: 'atlas' });
  check('bind: refused with no registry', !r.ok, JSON.stringify(r));
  fs.writeFileSync(path.join(pc1.userData, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: ['C:/shared'], projects: { atlas: { root: 'C:/x/Atlas Game' }, zed: { root: 'C:/x/Beacon' } }, bindings: { 'team:t1': 'zed' }, accountDocs: { personal: 'on' } }, null, 2));
  r = await a.call('projects');
  check('projects: by folder name, sorted, with the bindings', r.ok && JSON.stringify(r.projects.map((p) => p.name)) === '["Atlas Game","Beacon"]' && r.bindings['team:t1'] === 'zed', JSON.stringify(r));
  r = await a.call('bind', { key: 'c:c2', project: 'atlas' });
  const reg1 = JSON.parse(fs.readFileSync(path.join(pc1.userData, 'aiondx-projects.json'), 'utf8'));
  check('bind: the chat bound, everything else in the registry kept', r.ok && reg1.bindings['conv:c2'] === 'atlas' && reg1.bindings['team:t1'] === 'zed' && reg1.skillRoots[0] === 'C:/shared' && reg1.accountDocs.personal === 'on', JSON.stringify(reg1));
  r = await a.call('bind', { key: 'c:c2', project: '' });
  check('bind "No project": kept as an empty binding', r.ok && r.bindings['conv:c2'] === '', JSON.stringify(r));
  r = await a.call('bind', { key: 't:t1', project: null });
  check('unbind a team', r.ok && !('team:t1' in r.bindings), JSON.stringify(r));
  r = await a.call('bind', { key: 'c:c2', project: 'nope' });
  check('bind: an unknown project is refused', !r.ok && /no project called nope/.test(r.error), JSON.stringify(r));
  // R-127: plans approved in a DX Doc, and a project's edit gate
  r = await a.call('approvePlan', { conv: 'c2', team: 't7', doc: 'plan-export' });
  const plans = JSON.parse(fs.readFileSync(path.join(pc1.userData, 'aiondx-plans.json'), 'utf8'));
  check('approvePlan records the plan for the chat and its team', r.ok && plans['c:c2'].doc === 'plan-export' && plans['t:t7'].doc === 'plan-export', JSON.stringify(plans));
  r = await a.call('planGate', { project: 'atlas', on: true });
  let reg2 = JSON.parse(fs.readFileSync(path.join(pc1.userData, 'aiondx-projects.json'), 'utf8'));
  check('planGate on: written into the project, the rest kept', r.ok && reg2.projects.atlas.planGate === 'on' && reg2.projects.zed.root === 'C:/x/Beacon', JSON.stringify(reg2));
  r = await a.call('projects');
  check('the projects list says which builds from approved plans', r.projects.find((p) => p.key === 'atlas').planGate === true && r.projects.find((p) => p.key === 'zed').planGate === false);
  r = await a.call('planGate', { project: 'atlas', on: false });
  reg2 = JSON.parse(fs.readFileSync(path.join(pc1.userData, 'aiondx-projects.json'), 'utf8'));
  check('planGate off', r.ok && !('planGate' in reg2.projects.atlas));
  r = await a.call('decline', { id: 'zz' });
  check('decline: kept', r.ok);
  clearTimeout(deadline);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(2); });
