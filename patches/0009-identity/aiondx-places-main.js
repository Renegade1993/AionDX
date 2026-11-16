'use strict';
/**
 * aiondx-places-main.js - chats, teams and groups kept where the user chooses (R-130, November 15th, 2026). Main process side of
 * Settings > Where your chats live, the sidebar's missing marks and Find it, and the drive sync. The work is aiondx-place-move.js
 * (patches/0016-data-move), run by AionDX's bundled Node (it has node:sqlite), hidden, one at a time. The page holds each chat's agent
 * stopped (AionCore's POST /api/conversations/{id}/runtime/hold, core-0020) around every command that changes a chat, and releases it after.
 *
 * IPC aiondx:places, ops:
 *   status                  every chat and team: where its folder is, placed, missing; the places used before; group places
 *   choose {title}          a folder box; { to }
 *   move {items, to}        into packages under <to>; recorded, and <to> remembered
 *   back {items}            back to AionDX's folder
 *   relink {item, to?}      Find it: the folder it is in now (asked for when not given)
 *   undo                    the last move, back or Find it
 *   sync                    drives scanned for packages; placed ones written back when changed here; what came in or changed elsewhere listed
 *   import {package}        a package's chat or team into this AionDX (as another PC's), its sync state kept
 *   groupPlace {group, to}  a group's place (null: none)
 * The record: <userData>\aiondx-places.json = { placed: { id: { kind, package, at } }, places: [recent], groups: { id: place },
 * sync: { id: { version, exportedAt } }, last: { op, items, journals } }.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

function install(electron, opts) {
  const o = opts || {};
  const app = electron.app;
  const userData = () => app.getPath('userData');
  const dbFile = () => process.env.AIONDX_PLACES_DB || path.join(userData(), 'aionui', 'aiondx-backend.db');
  const recFile = () => path.join(userData(), 'aiondx-places.json');
  const local = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const workDir = () => process.env.AIONDX_PLACES_WORK || path.join(local(), 'AionDX');
  const homeDir = () => process.env.AIONDX_PLACES_HOME || os.homedir();   // tests: a made-up user folder
  const binDir = () => process.env.AIONDX_PORTABLE_BIN || path.join(process.resourcesPath || '', 'aiondx', 'bin');
  const mover = () => process.env.AIONDX_PLACE_MOVER || path.join(binDir(), 'aiondx-place-move.js');
  const nodeExe = () => {
    if (process.env.AIONDX_PORTABLE_NODE) return process.env.AIONDX_PORTABLE_NODE;
    const base = path.join(process.resourcesPath || '', 'bundled-aioncore', 'win32-x64', 'managed-resources', 'node');
    try { const d = fs.readdirSync(base).filter((x) => /^node-v/.test(x)).sort().pop(); if (d && fs.existsSync(path.join(base, d, 'node.exe'))) return path.join(base, d, 'node.exe'); } catch { /* none */ }
    return null;
  };
  const roots = () => process.env.AIONDX_PORTABLE_ROOTS ? process.env.AIONDX_PORTABLE_ROOTS.split(';').filter(Boolean)
    : 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':' + path.sep);

  function readRec() {
    let r = null;
    try { r = JSON.parse(fs.readFileSync(recFile(), 'utf8')); } catch { /* none yet */ }
    r = r && typeof r === 'object' ? r : {};
    for (const k of ['placed', 'groups', 'sync']) if (!r[k] || typeof r[k] !== 'object') r[k] = {};
    if (!Array.isArray(r.places)) r.places = [];
    return r;
  }
  function writeRec(r) {
    const f = recFile();
    fs.writeFileSync(f + '.tmp', JSON.stringify(r, null, 1));
    fs.renameSync(f + '.tmp', f);
  }
  const registryFile = () => path.join(userData(), 'aiondx-projects.json');
  function readRegistry() { try { const r = JSON.parse(fs.readFileSync(registryFile(), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; } }
  function remember(r, place) {
    if (!place) return;
    r.places = [place].concat(r.places.filter((p) => p.toLowerCase() !== place.toLowerCase())).slice(0, 8);
  }

  const childEnv = () => { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return e; };
  let busy = null;   // one command at a time (a move and a sync must not meet)
  /** The mover, hidden; resolves with its one JSON line. */
  function run(cmd, args, timeoutMs) {
    const node = nodeExe();
    if (!node || !fs.existsSync(mover())) return Promise.resolve({ ok: false, error: 'This AionDX is missing its mover (' + (node ? 'aiondx-place-move.js' : 'Node.js') + ').' });
    const jf = path.join(os.tmpdir(), 'aiondx-place-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(jf, JSON.stringify(args || {}));
    const go = () => new Promise((resolve) => {
      cp.execFile(node, ['--no-warnings', mover(), cmd, '--db', dbFile(), '--home', homeDir(), '--work', workDir(), '--json-file', jf],
        { windowsHide: true, timeout: timeoutMs || 600000, maxBuffer: 16 * 1024 * 1024, env: childEnv() },
        (err, stdout) => {
          try { fs.rmSync(jf, { force: true }); } catch { /* best effort */ }
          let j = null;
          try { j = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* not JSON */ }
          resolve(j && typeof j === 'object' ? j : { ok: false, error: String((err && err.message) || 'No answer from the mover.').slice(0, 400) });
        });
    });
    const p = (busy || Promise.resolve()).then(go, go);
    busy = p.then(() => null, () => null);
    return p;
  }

  /** Every item with its place, missing ones marked. */
  async function status() {
    const r = await run('status', {}, 60000);
    if (!r.ok) return r;
    const rec = readRec();
    const items = r.items.map((it) => {
      const known = rec.placed[it.id];
      const placed = it.placed || !!known;
      const pkg = it.package || (known && known.package) || null;
      return Object.assign({}, it, { placed, package: pkg, place: pkg ? path.dirname(pkg) : null,
        missing: !it.exists && !!it.ws && (placed || it.custom || it.packaged) });
    });
    // what the record says is placed but the mover found placed and the record did not know (another PC wrote it, a relink): recorded now
    let changed = false;
    for (const it of items) if (it.placed && it.package && (!rec.placed[it.id] || rec.placed[it.id].package !== it.package) && it.exists) { rec.placed[it.id] = { kind: it.kind, package: it.package, at: Date.now() }; changed = true; }
    for (const id of Object.keys(rec.placed)) if (!items.some((it) => it.id === id)) { delete rec.placed[id]; changed = true; }
    if (changed) writeRec(rec);
    return { ok: true, items, places: rec.places, groups: rec.groups, home: userData(), last: rec.last ? { op: rec.last.op, names: rec.last.names || [], at: rec.last.at } : null };
  }

  async function choose(title, start) {
    const w = electron.BrowserWindow.getFocusedWindow() || undefined;
    const d = await electron.dialog.showOpenDialog(w, { title: title || 'Choose a folder for them', defaultPath: start || undefined, properties: ['openDirectory', 'createDirectory'] });
    if (!d || d.canceled || !d.filePaths || !d.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, to: d.filePaths[0] };
  }

  /** The drives' lists of packages (each drive given a second and a half). */
  async function scanDrives() {
    const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
    const look = async (root) => {
      try {
        const idx = JSON.parse(await fs.promises.readFile(path.join(root, 'AionDX-chats.json'), 'utf8'));
        const out = [];
        for (const p of (idx && idx.packages) || []) {
          const dir = path.join(root, p.path || '');
          try { const m = JSON.parse(await fs.promises.readFile(path.join(dir, 'aiondx-chat.json'), 'utf8')); if (m && m.id) out.push({ dir, m }); } catch { /* gone */ }
        }
        return out;
      } catch { return null; }
    };
    const found = await Promise.all(roots().map((r) => within(look(r), 1500)));
    return found.filter(Boolean).flat();
  }

  /** The minute's work: placed items written back (unless someone else wrote their package since), and what the drives hold. */
  let tidied = false;
  /** groupOf: { item id: its sidebar group's name } from the page, written into each package so another PC files it the same way. */
  let lastGroupOf;   // the page's groups at its last sync, for the export as AionDX quits
  async function sync(groupOf) {
    if (groupOf) lastGroupOf = groupOf;
    // once per start: packages made before November 16th, 2026 get their working folders' own names back (AionUi listed them under
    // Projects); a chat whose agent holds its folder is skipped and tried again at the next start
    if (!tidied) { tidied = true; try { await run('tidy', {}, 300000); } catch { /* next start */ } }
    const st = await status();
    if (!st.ok) return st;
    const rec = readRec();
    const byId = new Map(st.items.map((it) => [it.id, it]));
    const toExport = [], changed = [], relink = [], incoming = [];
    for (const it of st.items) {
      if (!it.placed || !it.package || it.missing) continue;
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(it.package, 'aiondx-chat.json'), 'utf8')); } catch { continue; }
      const s = rec.sync[it.id];
      if (s && m.exportedAt && s.exportedAt && m.exportedAt !== s.exportedAt) changed.push({ kind: it.kind, id: it.id, name: it.name, package: it.package });
      else toExport.push({ kind: it.kind, id: it.id });
    }
    let exported = [];
    if (toExport.length) {
      const r = await run('export', { items: toExport, groupOf }, 300000);
      if (r.ok) {
        exported = r.exported.filter((e) => e.exported);
        for (const e of exported) rec.sync[e.id] = { version: e.exported, exportedAt: e.exportedAt };
        // first sight of a package this PC did not write (a fresh record): what it holds is the starting point
        for (const e of r.exported) if (e.skipped === 'unchanged' && !rec.sync[e.id]) { const it = byId.get(e.id); try { const m = JSON.parse(fs.readFileSync(path.join(it.package, 'aiondx-chat.json'), 'utf8')); rec.sync[e.id] = { version: m.version, exportedAt: m.exportedAt }; } catch { /* next time */ } }
      }
    }
    for (const { dir, m } of await scanDrives()) {
      const it = byId.get(m.id);
      if (!it) { if (!rec.declined || !rec.declined[m.id]) incoming.push({ kind: m.kind, id: m.id, name: m.name, package: dir }); continue; }
      if (it.missing && it.package && it.package.toLowerCase() !== dir.toLowerCase()) relink.push({ kind: it.kind, id: it.id, name: it.name, to: dir });
    }
    writeRec(rec);
    return { ok: true, exported: exported.length, changed, relink, incoming };
  }

  async function handle(req) {
    const op = req && req.op;
    if (op === 'status') return status();
    if (op === 'choose') return choose(req.title, req.start);
    if (op === 'move') {
      const to = String(req.to || '');
      if (!path.isAbsolute(to)) return { ok: false, error: 'Choose a folder first.' };
      const r = await run('move', { items: req.items || [], to, groupOf: req.groupOf || undefined });
      const rec = readRec();
      const done = (r.moved || (r.partial || [])).filter(Boolean);
      for (const d of done) { rec.placed[d.id] = { kind: d.kind, package: d.package, at: Date.now() }; delete rec.sync[d.id]; }
      if (done.length) { remember(rec, to); rec.last = { op: 'move', at: Date.now(), names: done.map((d) => d.name), items: done.map((d) => ({ kind: d.kind, id: d.id })), journals: done.map((d) => d.journal) }; }
      writeRec(rec);
      return r;
    }
    if (op === 'back') {
      const r = await run('back', { items: req.items || [] });
      const rec = readRec();
      for (const d of r.back || []) { delete rec.placed[d.id]; delete rec.sync[d.id]; }
      if (r.back && r.back.length) rec.last = { op: 'back', at: Date.now(), names: r.back.map((d) => d.name), items: r.back.map((d) => ({ kind: d.kind, id: d.id })), journals: r.back.map((d) => d.journal) };
      writeRec(rec);
      return r;
    }
    if (op === 'relink') {
      let to = req.to;
      if (!to) { const c = await choose('Where is "' + String(req.name || 'it') + '" now? Choose its folder, or the folder it is in'); if (!c.ok) return c; to = c.to; }
      const r = await run('relink', { item: req.item, to });
      if (r.ok && r.relinked) {
        const rec = readRec();
        const pkg = r.relinked.at;
        let isPkg = false; try { isPkg = fs.existsSync(path.join(pkg, 'aiondx-chat.json')); } catch { /* no */ }
        if (isPkg) rec.placed[r.relinked.id] = { kind: r.relinked.kind, package: pkg, at: Date.now() };
        rec.last = { op: 'relink', at: Date.now(), names: [r.relinked.name], items: [{ kind: r.relinked.kind, id: r.relinked.id }], journals: [r.relinked.journal] };
        writeRec(rec);
      }
      return r;
    }
    if (op === 'undo') {
      const rec = readRec();
      const last = rec.last;
      if (!last || !last.journals || !last.journals.length) return { ok: false, error: 'There is nothing to undo.' };
      const left = [];
      for (const j of last.journals.slice().reverse()) { const r = await run('undo', { journal: j }); if (!r.ok || !r.undone) left.push((r.left || [r.error]).join('; ')); }
      const rec2 = readRec();
      if (last.op === 'move') for (const it of last.items) { delete rec2.placed[it.id]; delete rec2.sync[it.id]; }
      rec2.last = null;
      writeRec(rec2);
      return left.length ? { ok: false, error: 'Not everything could be undone: ' + left.join(' | ') } : { ok: true, undone: last.op, names: last.names };
    }
    if (op === 'sync') return sync(req.groupOf || undefined);
    if (op === 'import') {
      const pkg = String(req.package || '');
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(pkg, 'aiondx-chat.json'), 'utf8')); } catch { return { ok: false, error: 'No AionDX chat in ' + pkg + '.' }; }
      const rec = readRec();
      const r = await run('import', { package: pkg, lastSync: rec.sync[m.id] || null });
      if (r.ok && r.imported && !r.imported.skipped) {
        const rec2 = readRec();
        const id = r.imported.id;
        rec2.placed[id] = { kind: m.kind, package: pkg, at: Date.now() };
        rec2.sync[m.id] = { version: r.imported.version, exportedAt: m.exportedAt };
        if (id !== m.id) rec2.sync[id] = { version: r.imported.version, exportedAt: m.exportedAt };
        writeRec(rec2);
      }
      return r;
    }
    if (op === 'decline') {   // "not on this PC": a package the user does not want brought in is not offered again
      const rec = readRec();
      rec.declined = Object.assign({}, rec.declined || {}, { [String(req.id || '')]: Date.now() });
      writeRec(rec);
      return { ok: true };
    }
    // R-128: a chat's project (its project's skills load into it). The registry, <userData>\aiondx-projects.json, is the one AionDX's
    // Claude launcher and AionCore's skill mirror read. A binding "" means "no project, and do not ask".
    if (op === 'projects') {
      const reg = readRegistry();
      if (!reg) return { ok: true, projects: [], bindings: {} };
      const projects = Object.keys(reg.projects || {}).map((k) => { const p = reg.projects[k] || {}; return { key: k, name: p.root ? path.basename(String(p.root)) : k, root: p.root || '', planGate: p.planGate === 'on' }; })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, projects, bindings: reg.bindings || {} };
    }
    if (op === 'bind') {
      const m = /^([ct]):([A-Za-z0-9_-]{1,80})$/.exec(String(req.key || ''));
      if (!m) return { ok: false, error: 'Which chat?' };
      const reg = readRegistry();
      if (!reg) return { ok: false, error: 'AionDX has no projects list on this PC yet.' };
      const project = req.project === null || req.project === undefined ? null : String(req.project);
      if (project && !(reg.projects || {})[project]) return { ok: false, error: 'There is no project called ' + project + '.' };
      reg.bindings = reg.bindings && typeof reg.bindings === 'object' ? reg.bindings : {};
      const bkey = (m[1] === 'c' ? 'conv:' : 'team:') + m[2];
      if (project === null) delete reg.bindings[bkey]; else reg.bindings[bkey] = project;
      reg.updatedAt = new Date().toISOString();
      const f = registryFile();
      fs.writeFileSync(f + '.tmp', JSON.stringify(reg, null, 2));
      fs.renameSync(f + '.tmp', f);
      return { ok: true, bindings: reg.bindings };
    }
    // R-127: a plan the user approved in a DX Doc (the edit gate of a project that asks for one), and that gate per project
    if (op === 'approvePlan') {
      const f = path.join(userData(), 'aiondx-plans.json');
      let p = {}; try { p = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { /* none yet */ }
      const rec = { doc: String(req.doc || ''), at: Date.now() };
      if (req.conv && /^[A-Za-z0-9_-]{1,80}$/.test(String(req.conv))) p['c:' + req.conv] = rec;
      if (req.team && /^[A-Za-z0-9_-]{1,80}$/.test(String(req.team))) p['t:' + req.team] = rec;
      fs.writeFileSync(f + '.tmp', JSON.stringify(p, null, 1)); fs.renameSync(f + '.tmp', f);
      return { ok: true };
    }
    if (op === 'planGate') {
      const reg = readRegistry();
      if (!reg || !reg.projects || !reg.projects[req.project]) return { ok: false, error: 'There is no project called ' + req.project + '.' };
      if (req.on) reg.projects[req.project].planGate = 'on'; else delete reg.projects[req.project].planGate;
      reg.updatedAt = new Date().toISOString();
      const f = registryFile();
      fs.writeFileSync(f + '.tmp', JSON.stringify(reg, null, 2)); fs.renameSync(f + '.tmp', f);
      return { ok: true, on: !!req.on };
    }
    if (op === 'groupPlace') {
      const rec = readRec();
      const g = String(req.group || '');
      if (!g) return { ok: false, error: 'Which group?' };
      if (req.to) { rec.groups[g] = String(req.to); remember(rec, String(req.to)); } else delete rec.groups[g];
      writeRec(rec);
      return { ok: true, groups: rec.groups };
    }
    return { ok: false, error: 'unknown request' };
  }

  electron.ipcMain.handle('aiondx:places', async (_event, req) => {
    try { return await handle(req); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Written back when AionDX closes: placed items whose package nobody else wrote since, bounded to half a minute.
  app.on('before-quit', () => {
    try {
      const rec = readRec();
      const items = Object.keys(rec.placed).map((id) => ({ kind: rec.placed[id].kind, id }));
      if (!items.length) return;
      const safe = items.filter((it) => {
        const p = rec.placed[it.id].package;
        try { const m = JSON.parse(fs.readFileSync(path.join(p, 'aiondx-chat.json'), 'utf8')); const s = rec.sync[it.id]; return !(s && s.exportedAt && m.exportedAt !== s.exportedAt); } catch { return false; }
      });
      const node = nodeExe();
      if (!safe.length || !node || !fs.existsSync(mover())) return;
      const jf = path.join(os.tmpdir(), 'aiondx-place-quit-' + process.pid + '.json');
      fs.writeFileSync(jf, JSON.stringify({ items: safe, groupOf: lastGroupOf }));
      const r = cp.spawnSync(node, ['--no-warnings', mover(), 'export', '--db', dbFile(), '--home', homeDir(), '--work', workDir(), '--json-file', jf], { windowsHide: true, timeout: 30000, encoding: 'utf8', env: childEnv() });
      try { fs.rmSync(jf, { force: true }); } catch { /* best effort */ }
      try {
        const j = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
        if (j && j.ok) { for (const e of j.exported) if (e.exported) rec.sync[e.id] = { version: e.exported, exportedAt: e.exportedAt }; writeRec(rec); }
      } catch { /* the next start's sync writes it */ }
    } catch { /* never hold the quit */ }
  });
  if (o.log) o.log('aiondx:places ready');
  return { handle, status, sync };
}

module.exports = { install };
