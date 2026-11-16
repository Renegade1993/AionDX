#!/usr/bin/env node
'use strict';
/**
 * aiondx-place-move.js - a chat, a team (or several) kept where the user chooses (R-130, November 15th, 2026; the user: "users should be
 * able to tick any active team, conversation, or group and move any of them to a different drive", "the user should also be able to
 * specify a specific location for these chats as well ... though that should be the default", "if a chat loads as missing from a drive
 * or expected location, a user should be able to designate where the chat that goes there is").
 *
 * A chat is three things: its rows in AionDX's chats database, its working folder, and its agent's history (Claude Code: a folder named
 * after the working folder's path; other agents likewise). A chat placed somewhere is a package folder there:
 *   <place>\<name> (<id8>)\aiondx-chat.json   what it is: kind, ids, names, where each working folder sits in the package, when written
 *                          \aiondx-chat.db     its rows (the chat's, or the team's and every member's), for another PC to bring in
 *                          \workspace\         the working folder (a team: workspace\ for the team, members\<n>\ for a member's own)
 * and the drive's root gets AionDX-chats.json listing the packages on it, so AionDX on another PC finds them.
 *
 * Run by AionDX's main process with its bundled Node (it has node:sqlite), hidden, while AionDX stays open; the chat's agent must not be
 * running (AionDX stops it first). Commands (args as JSON in --json-file):
 *   move   { items: [{ kind: "c"|"t", id }], to: <place folder> }      each item into its package under <to>
 *   back   { items: [...] }                                             each placed item back to where it was before it was first moved
 *   relink { item, to: <folder> }                                       the package (or working folder) is at <folder> now: use it from there
 *   export { items: [...] }                                             the rows into each package (kept current while the chat lives there)
 *   import { package: <folder> }                                        a package another PC wrote: its chat (or team) into this database
 *   tidy   { items?: [...] }                                           packages made before November 16th, 2026: their working folders
 *                                                                       get their own names back (AionUi listed "workspace" ones under Projects)
 *   undo   { journal: <file> }                                          a move undone from its journal
 *   status {}                                                           every chat and team: its working folder, whether it is there, placed
 * Common: --db <chats database> --home <user folder> --work <folder for journals and backups>. Prints one JSON line; exit 0 ok, 1 refused
 * or failed (and undone), 2 failed and not fully undone. Only counts, ids and paths are logged; no message text.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

// ---------------------------------------------------------------- paths and text
const SEPS = ['\\', '\\\\', '/'];
/** A folder's path in the three spellings rows hold it in (plain, JSON-escaped, forward slashes), each with the separator after it, and the
 *  path alone at the end of a value: only that folder and what is inside it match, never a neighbour whose name starts the same way. */
function spellings(p) { const a = [p, p.replace(/\\/g, '\\\\'), p.replace(/\\/g, '/')]; return a.map((s, i) => [s + SEPS[i], s]); }
function swapPairs(oldP, newP) { const o = spellings(oldP), n = spellings(newP); return o.map((x, i) => [x, n[i]]); }
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text with each old folder path rewritten to its new one, in every spelling and letter case; a path at the very end of a quoted value too. */
function rewrite(text, pairs) {
  let u = String(text);
  for (const [o, n] of pairs) for (const [[oSep, oBare], [nSep, nBare]] of swapPairs(o, n)) {
    u = u.replace(new RegExp(reEsc(oSep), 'gi'), () => nSep);
    u = u.replace(new RegExp(reEsc(oBare) + '(?=["\'\\s,}\\]]|$)', 'gi'), () => nBare);
  }
  return u;
}
function holds(text, pairs) { const low = String(text).toLowerCase(); return pairs.some(([o]) => spellings(o).some(([s, b]) => low.includes(s.toLowerCase()) || low.includes(b.toLowerCase()))); }
function mangle(p) { return p.replace(/[^A-Za-z0-9]/g, '-'); }   // how Claude Code names a project folder
const sameVolume = (a, b) => path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
function safeName(s) { return String(s || 'Chat').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'Chat'; }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function inside(child, parent) { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') + '-' + crypto.randomBytes(2).toString('hex'); }
/** Every file under a folder: count and bytes (to check a copy). */
function tally(dir) { let files = 0, bytes = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } }; if (exists(dir)) walk(dir); return { files, bytes }; }

// ---------------------------------------------------------------- the database
function openDb(file, readOnly) { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file, { readOnly: !!readOnly, timeout: 60000 }); }
function tableCols(db, t) { try { return db.prepare('PRAGMA table_info("' + t + '")').all(); } catch { return []; } }
function hasTable(db, t) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
/** The rows of a chat or a team: { table: [rows] } by the tables AionCore keeps them in. */
const CONV_TABLES = [['conversations', 'id'], ['messages', 'conversation_id'], ['acp_session', 'conversation_id'], ['conversation_assistant_snapshots', 'conversation_id'], ['conversation_artifacts', 'conversation_id']];
const TEAM_TABLES = [['teams', 'id'], ['mailbox', 'team_id'], ['team_tasks', 'team_id']];
function itemInfo(db, item) {
  if (item.kind === 't') {
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(item.id);
    if (!t) throw new Error('No team ' + item.id + '.');
    let agents = [];
    try { agents = JSON.parse(t.agents || '[]'); } catch { agents = []; }
    const convIds = agents.map((a) => a && a.conversation_id).filter(Boolean);
    return { kind: 't', id: t.id, name: t.name || 'Team', team: t, convIds, agents };
  }
  const c = db.prepare('SELECT id, name FROM conversations WHERE id = ?').get(item.id);
  if (!c) throw new Error('No chat ' + item.id + '.');
  return { kind: 'c', id: c.id, name: c.name || 'Chat', convIds: [c.id] };
}
function workspaceOf(db, convId) {
  const r = db.prepare('SELECT extra FROM conversations WHERE id = ?').get(convId);
  try { const e = JSON.parse((r && r.extra) || '{}'); return typeof e.workspace === 'string' && e.workspace ? e.workspace : null; } catch { return null; }
}
/** The item's rows in every table it has, for the package and for a backup. */
function itemRows(db, info) {
  const out = {};
  const ids = info.convIds;
  for (const [t, col] of CONV_TABLES) {
    if (!hasTable(db, t) || !ids.length) continue;
    out[t] = db.prepare('SELECT * FROM "' + t + '" WHERE "' + col + '" IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
  }
  if (info.kind === 't') for (const [t, col] of TEAM_TABLES) if (hasTable(db, t)) out[t] = db.prepare('SELECT * FROM "' + t + '" WHERE "' + col + '" = ?').all(info.id);
  return out;
}
/** The item's rows with every old folder path rewritten to its new one (text columns only); returns how many values changed. */
function rewriteRows(db, info, pairs, journal) {
  let changed = 0;
  const tables = CONV_TABLES.concat(info.kind === 't' ? TEAM_TABLES : []);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [t, col] of tables) {
      if (!hasTable(db, t)) continue;
      const cols = tableCols(db, t);
      const pk = (cols.find((c) => c.pk) || {}).name || 'rowid';
      const text = cols.filter((c) => /CHAR|TEXT|CLOB|JSON|^$/i.test(c.type || '')).map((c) => c.name);
      const keyVals = t === 'teams' || col === 'team_id' ? [info.id] : info.convIds;
      if (!keyVals.length) continue;
      const rows = db.prepare('SELECT "' + pk + '" AS __pk, ' + text.map((c) => '"' + c + '"').join(',') + ' FROM "' + t + '" WHERE "' + col + '" IN (' + keyVals.map(() => '?').join(',') + ')').all(...keyVals);
      for (const r of rows) for (const c of text) {
        const v = r[c];
        if (typeof v !== 'string' || !holds(v, pairs)) continue;
        const u = rewrite(v, pairs);
        if (u === v) continue;
        db.prepare('UPDATE "' + t + '" SET "' + c + '" = ? WHERE "' + pk + '" = ?').run(u, r.__pk);
        if (journal) journal.rows.push({ t, pk, id: r.__pk, c, v });
        changed++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; }
  return changed;
}

// ---------------------------------------------------------------- agents' history (Claude Code's folders, and other agents' files)
function claudeDirs(home, db) {
  const dirs = new Set();
  try { for (const n of fs.readdirSync(home)) if (/^\.claude(-[A-Za-z0-9_]+)?$/.test(n) && !/imported|backup|\.bak/i.test(n)) dirs.add(path.join(home, n)); } catch { /* no listing */ }
  try { for (const r of db.prepare("SELECT env FROM agent_metadata WHERE env LIKE '%CLAUDE_CONFIG_DIR%'").all()) { try { const e = JSON.parse(r.env); if (e && e.CLAUDE_CONFIG_DIR) dirs.add(path.resolve(e.CLAUDE_CONFIG_DIR)); } catch { /* not JSON */ } } } catch { /* no table */ }
  return [...dirs].filter((d) => exists(path.join(d, 'projects')) || exists(d));
}
/** Claude Code's history folders of a working folder: renamed to the new folder's name in every Claude config folder. */
function moveClaudeHistory(dirs, oldWs, newWs, journal) {
  let n = 0;
  for (const d of dirs) {
    const from = path.join(d, 'projects', mangle(oldWs)), to = path.join(d, 'projects', mangle(newWs));
    if (from === to || !exists(from)) continue;
    if (exists(to)) { journal.notes.push('history folder already at the new name: ' + to); continue; }
    fs.renameSync(from, to);
    journal.steps.push({ kind: 'rename', from, to });
    n++;
  }
  return n;
}
const AGENT_FILE = /\.(json|jsonl|md|txt|toml|ya?ml|ini|cfg|conf)$/i;
const AGENT_SKIP = /^(node_modules|cache|caches|Cache|logs?|tmp-.*|extensions|\.git|bin|backups?|imported.*)$/i;
/** Other agents (Codex, Gemini CLI and the rest) that name a working folder in their files or folder names: rewritten or renamed. Bounded. */
function moveOtherHistory(home, pairs, journal, budgetMs) {
  const t0 = Date.now();
  let files = 0, dirs = 0;
  const backupDir = path.join(journal.dir, 'agents');
  const names = new Map();
  const hash = (alg, s) => crypto.createHash(alg).update(s).digest('hex');
  for (const [o, n] of pairs) for (const f of [mangle, (s) => mangle(s).toLowerCase(), (s) => hash('sha256', s), (s) => hash('sha256', s.toLowerCase()), (s) => hash('sha256', s.replace(/\\/g, '/')), (s) => hash('md5', s), (s) => hash('sha1', s)]) { const a = f(o), b = f(n); if (a !== b) names.set(a, b); }
  const roots = [];
  try { for (const e of fs.readdirSync(home, { withFileTypes: true })) if (e.isDirectory() && /^\.(codex|gemini|qwen|opencode|cursor|devin|goose|kiro|amp|continue|crush|iflow|auggie|droid|qoder|kimi)/i.test(e.name)) roots.push(path.join(home, e.name)); } catch { /* none */ }
  for (const f of ['.claude.json']) if (exists(path.join(home, f))) roots.push(path.join(home, f));
  for (const d of fs.readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\.claude(-[A-Za-z0-9_]+)?$/.test(e.name))) roots.push(path.join(home, d.name));
  const doFile = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.size > 50 * 1048576) return;
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
    if (!holds(text, pairs)) return;
    const u = rewrite(text, pairs);
    if (u === text) return;
    if (/\.json$/i.test(p)) { try { JSON.parse(text); try { JSON.parse(u); } catch { journal.notes.push('would no longer parse: ' + p); return; } } catch { /* was not JSON */ } }
    fs.mkdirSync(backupDir, { recursive: true });
    const bk = path.join(backupDir, files + '-' + path.basename(p) + '.before');
    fs.writeFileSync(bk, text);
    fs.writeFileSync(p + '.aiondx-tmp', u);
    fs.renameSync(p + '.aiondx-tmp', p);
    try { fs.utimesSync(p, st.atime, st.mtime); } catch { /* a nicety */ }
    journal.steps.push({ kind: 'file', file: p, backup: bk });
    files++;
  };
  const walk = (dir, depth, isClaude) => {
    if (Date.now() - t0 > budgetMs || depth > 6) return;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (AGENT_SKIP.test(e.name) || (isClaude && depth === 0 && e.name === 'projects')) continue;
        let q = p;
        if (!isClaude && names.has(e.name) && !exists(path.join(dir, names.get(e.name)))) { const to = path.join(dir, names.get(e.name)); fs.renameSync(p, to); journal.steps.push({ kind: 'rename', from: p, to }); dirs++; q = to; }
        walk(q, depth + 1, isClaude);
      } else if (AGENT_FILE.test(e.name)) doFile(p);
    }
  };
  for (const r of roots) {
    let st; try { st = fs.statSync(r); } catch { continue; }
    if (st.isFile()) doFile(r); else walk(r, 0, /\.claude/i.test(path.basename(r)));
  }
  return { files, dirs };
}

// ---------------------------------------------------------------- folders
/** A folder moved: renamed on the same drive; copied, checked and the old one kept until commit, on another. */
function moveFolder(from, to, journal) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (exists(to)) throw new Error('Something is already at ' + to + '.');
  if (!exists(from)) { fs.mkdirSync(to, { recursive: true }); journal.steps.push({ kind: 'mkdir', dir: to }); return 'made'; }
  if (sameVolume(from, to)) { fs.renameSync(from, to); journal.steps.push({ kind: 'rename', from, to }); return 'renamed'; }
  const before = tally(from);
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  journal.steps.push({ kind: 'copy', from, to });
  const after = tally(to);
  if (after.files !== before.files || after.bytes !== before.bytes) throw new Error('The copy of ' + from + ' does not match it (' + after.files + ' of ' + before.files + ' files).');
  journal.removeAfter.push(from);   // the old one goes once everything else has worked
  return 'copied';
}

// ---------------------------------------------------------------- the journal (undo)
function newJournal(work, cmd) {
  const dir = path.join(work, 'place-move', stamp());
  fs.mkdirSync(dir, { recursive: true });
  return { dir, file: path.join(dir, 'journal.json'), cmd, steps: [], rows: [], notes: [], removeAfter: [], state: 'started', save() { fs.writeFileSync(this.file, JSON.stringify({ cmd: this.cmd, state: this.state, steps: this.steps, rows: this.rows, notes: this.notes, removeAfter: this.removeAfter }, null, 1)); } };
}
/** Undo the steps of a journal, newest first; the rows' old values back. */
function undoJournal(j, db) {
  const left = [];
  if (j.rows && j.rows.length && db) {
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const r of j.rows.slice().reverse()) db.prepare('UPDATE "' + r.t + '" SET "' + r.c + '" = ? WHERE "' + r.pk + '" = ?').run(r.v, r.id);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } left.push('rows: ' + e.message); }
  }
  for (const s of (j.steps || []).slice().reverse()) {
    try {
      if (s.kind === 'rename') fs.renameSync(s.to, s.from);
      else if (s.kind === 'copy') { if (!exists(s.from)) fs.cpSync(s.to, s.from, { recursive: true, preserveTimestamps: true }); fs.rmSync(s.to, { recursive: true, force: true }); }   // the original was removed once the move was done: copied back first
      else if (s.kind === 'saved') fs.cpSync(s.saved, s.file, { recursive: true, preserveTimestamps: true });
      else if (s.kind === 'rmdir') fs.mkdirSync(s.dir, { recursive: true });
      else if (s.kind === 'index') indexOnDrive(s.pkg, { id: s.id, kind: s.ikind, name: s.name }, !s.remove);
      else if (s.kind === 'mkdir') fs.rmSync(s.dir, { recursive: true, force: true });
      else if (s.kind === 'file') fs.copyFileSync(s.backup, s.file);
      else if (s.kind === 'write') { if (s.backup && exists(s.backup)) fs.copyFileSync(s.backup, s.file); else fs.rmSync(s.file, { force: true }); }
    } catch (e) { left.push(s.kind + ' ' + (s.from || s.file || s.dir || s.to) + ': ' + e.message); }
  }
  return left;
}

// ---------------------------------------------------------------- packages
const MANIFEST = 'aiondx-chat.json', ROWS = 'aiondx-chat.db', DRIVE_INDEX = 'AionDX-chats.json';
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
/** Where each working folder of an item goes in its package: the first (a chat's, or a team's) is workspace\, others members\<n>\. */
function packageLayout(db, info, pkg, homeMap) {
  const map = [];   // [{ convId, old, rel }]
  const seen = new Map();
  const teamWs = info.kind === 't' && info.team.workspace ? info.team.workspace : null;
  const teamRel = ownName((homeMap && homeMap._team) || teamWs);
  if (teamWs) seen.set(teamWs.toLowerCase(), teamRel);
  let k = 0;
  for (const id of info.convIds) {
    const ws = workspaceOf(db, id);
    if (!ws) continue;
    let rel = seen.get(ws.toLowerCase());
    if (!rel) {
      rel = !teamWs && !seen.size ? ownName((homeMap && homeMap[id]) || ws) : path.join('members', String(++k) + ' ' + safeName((info.agents || []).find((a) => a.conversation_id === id) ? (info.agents.find((a) => a.conversation_id === id).name) : id.slice(0, 8)));
      seen.set(ws.toLowerCase(), rel);
    }
    map.push({ convId: id, old: ws, rel });
  }
  if (teamWs) map.push({ convId: null, old: teamWs, rel: teamRel });
  void pkg;
  return map;
}
/** The rows of an item into its package's database (a fresh file swapped in), and its manifest. */
function exportRows(db, info, pkg, layout, homeOf, userHome) {
  if (userHome) exportHistory(db, userHome, pkg, layout);
  const rows = itemRows(db, info);
  // a chat's assistant snapshot points at an assistant record this PC made (November 16th, 2026: another PC has none, so every chat
  // was refused there with "FOREIGN KEY constraint failed"): those records go with it, for the other PC to add when it lacks them
  const defIds = [...new Set((rows.conversation_assistant_snapshots || []).map((r) => r.assistant_definition_id).filter(Boolean))];
  if (defIds.length && hasTable(db, 'assistant_definitions')) rows.assistant_definitions = defIds.map((id) => db.prepare('SELECT * FROM assistant_definitions WHERE id = ?').get(id)).filter(Boolean);
  const tmp = path.join(pkg, ROWS + '.tmp');
  fs.rmSync(tmp, { force: true });
  const out = openDb(tmp, false);
  try {
    // the tables come over with their foreign keys (conversations to users, and so on), but not the tables those point at: the package
    // holds this item's rows only, so its keys are not enforced (the 0.28.0 live test: "no such table: main.users")
    out.exec('PRAGMA foreign_keys = OFF');
    out.exec('BEGIN');
    for (const [t, list] of Object.entries(rows)) {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!sql || !sql.sql) continue;
      out.exec(sql.sql.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS '));
      if (!list.length) continue;
      const cols = Object.keys(list[0]);
      const ins = out.prepare('INSERT INTO "' + t + '" (' + cols.map((c) => '"' + c + '"').join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')');
      for (const r of list) ins.run(...cols.map((c) => r[c]));
    }
    out.exec('COMMIT');
  } finally { out.close(); }
  fs.renameSync(tmp, path.join(pkg, ROWS));
  const version = localVersion(db, info);
  const manifest = { format: 1, kind: info.kind, id: info.id, name: info.name, convIds: info.convIds,
    workspaces: layout.map((l) => ({ convId: l.convId, rel: l.rel, path: path.join(pkg, l.rel) })),
    home: homeOf || (readJson(path.join(pkg, MANIFEST)) || {}).home || {},
    version, exportedAt: Date.now(), exportedBy: os.hostname() };
  fs.writeFileSync(path.join(pkg, MANIFEST), JSON.stringify(manifest, null, 1));
  return manifest;
}
/** A stamp of an item's rows that changes when they do: its chats' last change and message counts. */
function localVersion(db, info) {
  const ids = info.convIds;
  if (!ids.length) return '0';
  const q = (sql) => { try { return db.prepare(sql.replace('@ids', ids.map(() => '?').join(','))).get(...ids); } catch { return {}; } };
  const a = q('SELECT MAX(updated_at) AS u, COUNT(*) AS n FROM conversations WHERE id IN (@ids)');
  const b = q('SELECT MAX(created_at) AS m, COUNT(*) AS n FROM messages WHERE conversation_id IN (@ids)');
  return [a.u || 0, a.n || 0, b.m || 0, b.n || 0].join('.');
}
/** The drive's root lists the packages on it (another PC reads this to find them). */
function indexOnDrive(pkg, info, remove) {
  const root = path.parse(path.resolve(pkg)).root;
  if (root.toLowerCase() === path.parse(os.homedir()).root.toLowerCase()) return;   // the PC's own drive: nothing to find it by elsewhere
  const f = path.join(root, DRIVE_INDEX);
  const idx = readJson(f) || { format: 1, packages: [] };
  const rel = path.relative(root, pkg);
  idx.packages = (idx.packages || []).filter((p) => p.id !== info.id);
  if (!remove) idx.packages.push({ id: info.id, kind: info.kind, name: info.name, path: rel, at: Date.now() });
  try { fs.writeFileSync(f, JSON.stringify(idx, null, 1)); } catch { /* a read-only root: the package is still found by Find it */ }
}

// ---------------------------------------------------------------- agents' history in a package (for another PC)
/** Claude Code's history of each working folder, copied into the package as agents\<config folder>\<working folder in the package>; only
 *  files that are new or changed since the last copy are written. */
function exportHistory(db, userHome, pkg, layout) {
  let n = 0;
  const seen = new Set();
  for (const l of layout) {
    const ws = path.join(pkg, l.rel);
    if (seen.has(ws.toLowerCase())) continue;
    seen.add(ws.toLowerCase());
    for (const d of claudeDirs(userHome, db)) {
      const from = path.join(d, 'projects', mangle(ws));
      if (!exists(from)) continue;
      n += syncTree(from, path.join(pkg, 'agents', path.basename(d), mangle(l.rel)));
    }
  }
  return n;
}
/** A package's agents' history to where this PC's agents look for it (the working folder's path here), its paths rewritten. */
function importHistory(userHome, pkg, m, pairs) {
  let n = 0;
  const root = path.join(pkg, 'agents');
  if (!exists(root)) return 0;
  for (const cfg of fs.readdirSync(root)) {
    const cfgHere = exists(path.join(userHome, cfg)) ? path.join(userHome, cfg) : path.join(userHome, '.claude');
    const seen = new Set();
    for (const w of m.workspaces) {
      if (seen.has(w.rel)) continue;
      seen.add(w.rel);
      const from = path.join(root, cfg, mangle(w.rel));
      if (!exists(from)) continue;
      n += syncTree(from, path.join(cfgHere, 'projects', mangle(path.join(pkg, w.rel))), pairs);
    }
  }
  return n;
}
/** Files under one folder copied to another when missing there or newer (paths in text files rewritten when pairs are given). */
function syncTree(from, to, pairs) {
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) { n += syncTree(a, b, pairs); continue; }
    const sa = fs.statSync(a);
    let sb = null; try { sb = fs.statSync(b); } catch { /* not there */ }
    if (sb && sb.mtimeMs >= sa.mtimeMs - 1000 && sb.size === sa.size) continue;
    fs.mkdirSync(to, { recursive: true });
    if (pairs && pairs.length && /\.(jsonl?|md|txt)$/i.test(e.name) && sa.size < 50 * 1048576) fs.writeFileSync(b + '.aiondx-tmp', rewrite(fs.readFileSync(a, 'utf8'), pairs));
    else fs.copyFileSync(a, b + '.aiondx-tmp');
    fs.renameSync(b + '.aiondx-tmp', b);
    try { fs.utimesSync(b, sa.atime, sa.mtime); } catch { /* a nicety */ }
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- commands
function cmdMove(db, a, ctx) {
  const to = path.resolve(String(a.to || ''));
  if (!a.to || !path.isAbsolute(to)) throw new Error('Choose a folder to keep them in.');
  if (inside(to, ctx.dataDir) || path.resolve(to).toLowerCase() === path.resolve(ctx.dataDir).toLowerCase()) throw new Error('That folder is inside AionDX\'s own data folder, where they already are.');
  fs.mkdirSync(to, { recursive: true });
  const done = [];
  for (const item of a.items || []) {
    const info = itemInfo(db, item);
    const pkg = path.join(to, safeName(info.name) + ' (' + info.id.slice(0, 8) + ')');
    if (exists(pkg)) throw new Error('Something is already at ' + pkg + '.');
    const journal = newJournal(ctx.work, 'move ' + info.kind + ':' + info.id);
    // moved again from a place it already has (November 16th, 2026: the first package's own files were left behind): that package
    const prev = packageOf(db, info);
    try {
      fs.mkdirSync(pkg, { recursive: true });
      journal.steps.push({ kind: 'mkdir', dir: pkg });
      const layout = packageLayout(db, info, pkg, prev && prev.m.home);
      const home = {};
      const pairs = [];
      const moved = new Set();
      for (const l of layout) {
        const key = l.old.toLowerCase();
        home[l.convId || '_team'] = l.old;
        if (moved.has(key)) continue;
        moved.add(key);
        const dest = path.join(pkg, l.rel);
        if (inside(dest, l.old)) throw new Error('The new place is inside the chat\'s own folder.');
        moveFolder(l.old, dest, journal);
        pairs.push([l.old, dest]);
      }
      if (prev && prev.m.home) Object.assign(home, prev.m.home);
      journal.save();
      const cdirs = claudeDirs(ctx.home, db);
      for (const [o, n] of pairs) moveClaudeHistory(cdirs, o, n, journal);
      journal.save();
      const changed = rewriteRows(db, info, pairs, journal);
      journal.save();
      const agents = moveOtherHistory(ctx.home, pairs, journal, 30000);
      if (process.env.AIONDX_PLACE_FAIL_AFTER === 'rows') throw new Error('injected failure after rows');
      exportRows(db, info, pkg, layout.map((l) => Object.assign({}, l)), home, ctx.home);
      journal.steps.push({ kind: 'write', file: path.join(pkg, MANIFEST) }, { kind: 'write', file: path.join(pkg, ROWS) });
      indexOnDrive(pkg, info, false);
      journal.steps.push({ kind: 'index', pkg, id: info.id, ikind: info.kind, name: info.name, remove: false });
      for (const old of journal.removeAfter) { try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { journal.notes.push('the old folder could not be removed: ' + old); } }
      if (prev && path.resolve(prev.dir).toLowerCase() !== path.resolve(pkg).toLowerCase()) dropPackageFiles(prev.dir, journal);
      journal.state = 'done'; journal.save();
      done.push({ kind: info.kind, id: info.id, name: info.name, package: pkg, folders: pairs.length, rows: changed, agentFiles: agents.files, journal: journal.file });
    } catch (e) {
      journal.state = 'failed'; journal.save();
      const left = undoJournal(journal, db);
      const err = new Error('"' + info.name + '" was not moved: ' + e.message + (left.length ? ' (not everything could be put back: ' + left.join('; ') + ')' : ' Nothing was changed.'));
      err.partial = done; err.code = left.length ? 2 : 1;
      throw err;
    }
  }
  return { moved: done };
}
/** Back to where it was before it was first moved (the package's manifest remembers), or into AionDX's own folder when that is taken. */
function cmdBack(db, a, ctx) {
  const done = [];
  for (const item of a.items || []) {
    const info = itemInfo(db, item);
    const at = packageOf(db, info);
    const pkg = at ? at.dir : null, m = at ? at.m : null;
    if (!m) throw new Error('"' + info.name + '" is not in a place of its own (it is in AionDX\'s folder already).');
    const journal = newJournal(ctx.work, 'back ' + info.kind + ':' + info.id);
    try {
      const pairs = [];
      const seen = new Set();
      for (const w of m.workspaces) {
        const cur = path.join(pkg, w.rel);
        if (seen.has(cur.toLowerCase())) continue;
        seen.add(cur.toLowerCase());
        let dest = m.home && m.home[w.convId || '_team'];
        if (!dest || exists(dest)) dest = path.join(ctx.dataDir, 'aionui', 'conversations', 'placed-back', safeName(info.name) + ' (' + info.id.slice(0, 8) + ')', w.rel);
        moveFolder(cur, dest, journal);
        pairs.push([cur, dest]);
      }
      journal.save();
      for (const [o, n] of pairs) moveClaudeHistory(claudeDirs(ctx.home, db), o, n, journal);
      rewriteRows(db, info, pairs, journal);
      moveOtherHistory(ctx.home, pairs, journal, 30000);
      indexOnDrive(pkg, info, true);
      journal.steps.push({ kind: 'index', pkg, id: info.id, ikind: info.kind, name: info.name, remove: true });
      for (const old of journal.removeAfter) { try { fs.rmSync(old, { recursive: true, force: true }); } catch { journal.notes.push('could not remove ' + old); } }
      dropPackageFiles(pkg, journal);
      journal.state = 'done'; journal.save();
      done.push({ kind: info.kind, id: info.id, name: info.name, to: pairs.map((p) => p[1]), journal: journal.file });
    } catch (e) {
      journal.state = 'failed'; journal.save();
      const left = undoJournal(journal, db);
      const err = new Error('"' + info.name + '" was not moved back: ' + e.message + (left.length ? ' (not everything could be put back: ' + left.join('; ') + ')' : ''));
      err.code = left.length ? 2 : 1;
      throw err;
    }
  }
  return { back: done };
}
/** The package an item is in now: the folder holding its working folder (workspace\ or members\<n>\) whose manifest is this item's. */
function packageOf(db, info) {
  const firstWs = workspaceOf(db, info.convIds[0]) || (info.team && info.team.workspace);
  return firstWs ? pkgDirOf(firstWs, info.id) : null;
}
/** The package holding a working folder: its parent (workspace\ or the folder's own name), or two up (members\<n>\). */
function pkgDirOf(ws, id) {
  const cands = [path.dirname(ws.replace(/[\\/]members[\\/][^\\/]+$/i, '').replace(/[\\/]workspace$/i, '') + path.sep + 'x'), path.dirname(ws), path.dirname(path.dirname(ws))];
  for (const d of cands) { const m = readJson(path.join(d, MANIFEST)); if (m && (!id || m.id === id)) return { dir: d, m }; }
  return null;
}
/** A working folder that was in a package (now missing or not): its folder is named for the package's shape, or its parent is
 *  "<name> (<id8>)". */
function looksPackaged(ws, id) {
  return /[\\/](workspace|members[\\/][^\\/]+)$/i.test(ws) || (!!id && path.basename(path.dirname(ws)).endsWith('(' + String(id).slice(0, 8) + ')'));
}
/** The name a working folder keeps in its package: its own when AionUi counts it as a chat's own folder (a "-temp-" name; any other
 *  name made AionUi list the chat under Projects, November 16th, 2026), else "workspace". */
function ownName(ws) {
  const leaf = ws ? path.basename(ws) : '';
  return /-temp-/.test(leaf) ? leaf : 'workspace';
}
/** A package's own files go once its working folders have moved out (a copy kept with the journal, for undo), then an empty members\
 *  folder, then the package's folder once nothing else is in it. Anything the user put there is left. */
function dropPackageFiles(pkg, journal) {
  try {
    for (const f of [MANIFEST, ROWS, 'agents']) {
      const p = path.join(pkg, f);
      if (!exists(p)) continue;
      const saved = path.join(journal.dir, 'package', f);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.cpSync(p, saved, { recursive: true, preserveTimestamps: true });
      journal.steps.push({ kind: 'saved', file: p, saved });
      fs.rmSync(p, { recursive: true, force: true });
    }
    const mem = path.join(pkg, 'members');
    if (exists(mem) && !fs.readdirSync(mem).length) { fs.rmdirSync(mem); journal.steps.push({ kind: 'rmdir', dir: mem }); }
    if (!fs.readdirSync(pkg).length) { fs.rmdirSync(pkg); journal.steps.push({ kind: 'rmdir', dir: pkg }); }
  } catch { /* left for the user */ }
}
/** Tidy: a package made before November 16th, 2026 named its working folder "workspace", so AionUi listed the chat under Projects.
 *  Each such folder gets its own name back (from the manifest's record of where it lived), with the rows, the agents' history and the
 *  manifest following. One journal per item; a failure puts that item back. Items with nothing to do are skipped. */
function cmdTidy(db, a, ctx) {
  const out = [];
  let items = a.items;
  if (!items) {   // every chat and team
    items = db.prepare('SELECT id FROM conversations').all().map((r) => ({ kind: 'c', id: r.id }));
    if (hasTable(db, 'teams')) items = items.concat(db.prepare('SELECT id FROM teams').all().map((r) => ({ kind: 't', id: r.id })));
  }
  for (const item of items) {
    let info; try { info = itemInfo(db, item); } catch (e) { continue; }
    if (item.kind === 'c' && info.team) continue;   // a member: its team is tidied
    const at = packageOf(db, info);
    if (!at || !Array.isArray(at.m.workspaces)) continue;
    const ren = [];
    for (const w of at.m.workspaces) {
      if (w.rel !== 'workspace') continue;
      const want = ownName(at.m.home && at.m.home[w.convId || '_team']);
      if (want === 'workspace' || ren.some((r) => r.to === want)) continue;
      ren.push({ from: path.join(at.dir, 'workspace'), to: want });
    }
    if (!ren.length) continue;
    const journal = newJournal(ctx.work, 'tidy ' + info.kind + ':' + info.id);
    try {
      const pairs = [];
      for (const r of ren) {
        const dest = path.join(at.dir, r.to);
        if (exists(dest)) throw new Error('Something is already at ' + dest + '.');
        moveFolder(r.from, dest, journal);
        pairs.push([r.from, dest]);
      }
      journal.save();
      const cdirs = claudeDirs(ctx.home, db);
      for (const [o, n] of pairs) moveClaudeHistory(cdirs, o, n, journal);
      const rows = rewriteRows(db, info, pairs, journal);
      journal.save();
      moveOtherHistory(ctx.home, pairs, journal, 30000);
      for (const f of [MANIFEST, ROWS]) { const pth = path.join(at.dir, f); if (exists(pth)) { const saved = path.join(journal.dir, 'package', f); fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.copyFileSync(pth, saved); journal.steps.push({ kind: 'saved', file: pth, saved }); } }
      const layout = at.m.workspaces.map((w) => ({ convId: w.convId, old: path.join(at.dir, w.rel === 'workspace' ? (ren[0] ? ren[0].to : w.rel) : w.rel), rel: w.rel === 'workspace' ? (ren[0] ? ren[0].to : w.rel) : w.rel }));
      exportRows(db, info, at.dir, layout, at.m.home, ctx.home);
      for (const old of journal.removeAfter) { try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* left */ } }
      journal.state = 'done'; journal.save();
      out.push({ kind: info.kind, id: info.id, name: info.name, renamed: ren.map((r) => r.to), rows, journal: journal.file });
    } catch (e) {
      journal.state = 'failed'; journal.save();
      const left = undoJournal(journal, db);
      out.push({ kind: info.kind, id: info.id, name: info.name, error: e.message + (left.length ? ' (not everything could be put back: ' + left.join('; ') + ')' : '') });
    }
  }
  return { tidied: out };
}
/** Find it: the folder the user points at is the package (or the bare working folder) now; the rows and history follow it there. */
function cmdRelink(db, a, ctx) {
  const info = itemInfo(db, a.item || {});
  let to = path.resolve(String(a.to || ''));
  if (!exists(to)) throw new Error('There is no folder at ' + to + '.');
  let m = readJson(path.join(to, MANIFEST));
  if (!m) {   // the folder the package is in: the package itself, found among what is in it
    try { for (const e of fs.readdirSync(to, { withFileTypes: true })) { if (!e.isDirectory()) continue; const mm = readJson(path.join(to, e.name, MANIFEST)); if (mm && mm.id === info.id) { to = path.join(to, e.name); m = mm; break; } } } catch { /* unreadable */ }
  }
  const was = workspaceOf(db, info.convIds[0]) || (info.team && info.team.workspace) || '';
  if (!m && looksPackaged(was, info.id) && !pkgDirOf(was, info.id))
    throw new Error('"' + info.name + '" is not in that folder. Pick the folder named "' + safeName(info.name) + ' (' + info.id.slice(0, 8) + ')", or the one it is in.');
  const journal = newJournal(ctx.work, 'relink ' + info.kind + ':' + info.id);
  const pairs = [];
  if (m) {
    if (m.id !== info.id) throw new Error('That folder holds "' + m.name + '", not "' + info.name + '".');
    for (const w of m.workspaces) {
      const now = path.join(to, w.rel);
      const before = w.convId ? workspaceOf(db, w.convId) : info.team && info.team.workspace;
      if (before && before.toLowerCase() !== now.toLowerCase() && !pairs.some((p) => p[0].toLowerCase() === before.toLowerCase())) pairs.push([before, now]);
    }
  } else {
    if (info.convIds.length !== 1) throw new Error('For a team, point at its package folder (the one holding ' + MANIFEST + ').');
    const before = workspaceOf(db, info.convIds[0]);
    if (before && before.toLowerCase() !== to.toLowerCase()) pairs.push([before, to]);
  }
  try {
    for (const [o, n] of pairs) moveClaudeHistory(claudeDirs(ctx.home, db), o, n, journal);
    const changed = pairs.length ? rewriteRows(db, info, pairs, journal) : 0;
    if (m) { const layout = m.workspaces.map((w) => ({ convId: w.convId, old: path.join(to, w.rel), rel: w.rel })); exportRows(db, info, to, layout, m.home, ctx.home); indexOnDrive(to, info, false); }
    journal.state = 'done'; journal.save();
    return { relinked: { kind: info.kind, id: info.id, name: info.name, at: to, rows: changed, journal: journal.file } };
  } catch (e) {
    journal.state = 'failed'; journal.save();
    const left = undoJournal(journal, db);
    const err = new Error('"' + info.name + '" was not found there: ' + e.message);
    err.code = left.length ? 2 : 1;
    throw err;
  }
}
/** The rows of placed items into their packages, when they changed since the last time (a chat on a drive kept current). */
function cmdExport(db, a, ctx) {
  const out = [];
  for (const item of a.items || []) {
    let info; try { info = itemInfo(db, item); } catch (e) { out.push({ id: item.id, error: e.message }); continue; }
    const at = packageOf(db, info);
    const pkg = at ? at.dir : null, m = at ? at.m : null;
    if (!m) { out.push({ id: info.id, skipped: 'not placed' }); continue; }
    if (!a.force && m.version === localVersion(db, info)) { out.push({ id: info.id, skipped: 'unchanged' }); continue; }
    const layout = m.workspaces.map((w) => ({ convId: w.convId, old: path.join(pkg, w.rel), rel: w.rel }));
    const nm = exportRows(db, info, pkg, layout, m.home, ctx && ctx.home);
    out.push({ id: info.id, exported: nm.version, exportedAt: nm.exportedAt });
  }
  return { exported: out };
}
/** Another PC's package into this database: its rows (this PC's user; its paths where the package is now). Same ids already here: the
 *  newer one wins when only one side changed since they last met; both changed, the package's comes in as a copy beside it. */
function cmdImport(db, a, ctx) {
  const pkg = path.resolve(String(a.package || ''));
  const m = readJson(path.join(pkg, MANIFEST));
  if (!m || !m.id) throw new Error('No AionDX chat in ' + pkg + '.');
  const src = openDb(path.join(pkg, ROWS), true);
  const rows = {};
  try { for (const t of CONV_TABLES.concat(TEAM_TABLES).map((x) => x[0]).concat(['assistant_definitions'])) if (hasTable(src, t)) rows[t] = src.prepare('SELECT * FROM "' + t + '"').all(); } finally { src.close(); }
  const defs = rows.assistant_definitions || [];
  delete rows.assistant_definitions;
  const user = db.prepare('SELECT user_id AS u, COUNT(*) AS n FROM conversations GROUP BY user_id ORDER BY n DESC LIMIT 1').get() || db.prepare('SELECT id AS u FROM users LIMIT 1').get();
  if (!user || !user.u) throw new Error('This AionDX has no user to give the chat to yet; open it once first.');
  // the paths the package's rows were written with, and where its folders are on this PC now
  const pairs = m.workspaces.map((w) => [w.path, path.join(pkg, w.rel)]).filter(([o, n]) => o && o.toLowerCase() !== n.toLowerCase());
  const here = m.convIds.filter((id) => db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id));
  const last = (a.lastSync || {});   // { version: local version when they last met, exportedAt: the package's then }
  let mode = 'new';
  if (here.length) {
    const info = itemInfo(db, { kind: m.kind, id: m.id });
    const localChanged = !last.version || localVersion(db, info) !== last.version;
    const pkgChanged = !last.exportedAt || m.exportedAt !== last.exportedAt;
    if (!pkgChanged) return { imported: { id: m.id, skipped: 'this PC has it as the package has it' + (localChanged ? ' (and newer: it will be written to the package)' : '') } };
    mode = localChanged ? 'copy' : 'replace';
  }
  // a copy gets new ids everywhere (the chat, its messages, a team and its members)
  const idMap = new Map();
  if (mode === 'copy') {
    const fresh = () => crypto.randomUUID();
    for (const id of m.convIds) idMap.set(id, fresh());
    if (m.kind === 't') idMap.set(m.id, fresh());
  }
  const remap = (v) => { if (typeof v !== 'string' || !idMap.size) return v; let u = v; for (const [o, n] of idMap) u = u.split(o).join(n); return u; };
  const fixRow = (t, r) => {
    const o = Object.assign({}, r);
    for (const k of Object.keys(o)) if (typeof o[k] === 'string') { o[k] = rewrite(o[k], pairs); o[k] = remap(o[k]); }
    if ('user_id' in o) o.user_id = user.u;
    if ('project_id' in o) o.project_id = null;
    if ('folder_id' in o) o.folder_id = null;
    if (t === 'messages' && mode === 'copy') o.id = crypto.randomUUID();
    if (t === 'mailbox' && mode === 'copy' && typeof o.id === 'string') o.id = crypto.randomUUID();
    if (t === 'team_tasks' && mode === 'copy' && typeof o.id === 'string') o.id = crypto.randomUUID();
    if ((t === 'conversations' || t === 'teams') && mode === 'copy') o.name = String(o.name || m.name) + ' (from the drive, ' + new Date(m.exportedAt).toISOString().slice(0, 10) + ')';
    return o;
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (mode === 'replace') {
      // children first: with foreign keys on, a chat row cannot go before its messages, a team before its mailbox
      if (m.kind === 't') for (const [t, col] of TEAM_TABLES.slice().reverse()) if (hasTable(db, t)) db.prepare('DELETE FROM "' + t + '" WHERE "' + col + '" = ?').run(m.id);
      for (const [t, col] of CONV_TABLES.slice().reverse()) if (hasTable(db, t)) db.prepare('DELETE FROM "' + t + '" WHERE "' + col + '" IN (' + m.convIds.map(() => '?').join(',') + ')').run(...m.convIds);
    }
    let n = 0, skipped = 0;
    if (defs.length && hasTable(db, 'assistant_definitions')) {
      const have = new Set(tableCols(db, 'assistant_definitions').map((c) => c.name));
      for (const d0 of defs) {
        if (db.prepare('SELECT 1 FROM assistant_definitions WHERE id = ?').get(d0.id)) continue;
        const d = Object.assign({}, d0);
        if ('user_id' in d) d.user_id = user.u;
        const cols = Object.keys(d).filter((c) => have.has(c));
        db.prepare('INSERT OR IGNORE INTO assistant_definitions (' + cols.map((c) => '"' + c + '"').join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map((c) => d[c]));
      }
    }
    // a link to something this PC does not have (and the package did not bring): a column that may be empty is emptied, else the row
    // is left out, so one stale link never refuses a whole chat
    const fkCache = new Map();
    const linksOf = (t) => { if (!fkCache.has(t)) { let l = []; try { l = db.prepare('PRAGMA foreign_key_list("' + t + '")').all(); } catch { /* none */ } fkCache.set(t, l); } return fkCache.get(t); };
    const notNull = (t, c) => tableCols(db, t).some((x) => x.name === c && x.notnull);
    const linked = (t, r) => {
      for (const f of linksOf(t)) {
        const v = r[f.from];
        if (v === null || v === undefined) continue;
        if (!hasTable(db, f.table)) continue;
        if (db.prepare('SELECT 1 FROM "' + f.table + '" WHERE "' + (f.to || 'id') + '" = ?').get(v)) continue;
        if (notNull(t, f.from)) return false;
        r[f.from] = null;
      }
      return true;
    };
    for (const [t, list] of Object.entries(rows)) {
      if (!hasTable(db, t) || !list.length) continue;
      const have = new Set(tableCols(db, t).map((c) => c.name));
      for (const r0 of list) {
        const r = fixRow(t, r0);
        if (!linked(t, r)) { skipped++; continue; }
        const cols = Object.keys(r).filter((c) => have.has(c));
        db.prepare('INSERT INTO "' + t + '" (' + cols.map((c) => '"' + c + '"').join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map((c) => r[c]));
        n++;
      }
    }
    db.exec('COMMIT');
    const newId = mode === 'copy' ? idMap.get(m.id) || m.id : m.id;
    // history files name the folder where the chat first lived (home) as well as where the package was written
    const histPairs = pairs.concat(m.workspaces.map((w) => [m.home && m.home[w.convId || '_team'], path.join(pkg, w.rel)]).filter(([o, n]) => o && o.toLowerCase() !== n.toLowerCase()));
    const history = importHistory(ctx.home, pkg, m, histPairs);
    let version = null;
    try { version = localVersion(db, itemInfo(db, { kind: m.kind, id: newId })); } catch { /* counted next time */ }
    return { imported: { id: newId, from: m.id, kind: m.kind, name: m.name, mode, rows: n, skipped, history, version, exportedAt: m.exportedAt } };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; }
}

/** Every chat (not in a team) and every team, with where its working folder is, whether that folder is there, and whether it is placed (a
 *  package's manifest beside it). Read only. Archived ones are left out. */
function cmdStatus(db) {
  const items = [];
  const teamOf = new Map();
  const teams = hasTable(db, 'teams') ? db.prepare('SELECT id, name, workspace, agents, updated_at' + (tableCols(db, 'teams').some((c) => c.name === 'archived_at') ? ', archived_at' : ', NULL AS archived_at') + ' FROM teams').all() : [];
  for (const t of teams) {
    let agents = []; try { agents = JSON.parse(t.agents || '[]'); } catch { /* none */ }
    for (const a of agents) if (a && a.conversation_id) teamOf.set(a.conversation_id, t.id);
  }
  const look = (ws, id) => {
    if (!ws) return { exists: false, placed: false };
    const there = exists(ws);
    const at = there ? pkgDirOf(ws, id) : null;
    return { exists: there, placed: !!at, package: at ? at.dir : null, packaged: looksPackaged(ws, id) };
  };
  const hasArch = tableCols(db, 'conversations').some((c) => c.name === 'archived_at');
  for (const c of db.prepare('SELECT id, name, extra, updated_at' + (hasArch ? ', archived_at' : ', NULL AS archived_at') + ' FROM conversations').all()) {
    if (c.archived_at) continue;
    let e = {}; try { e = JSON.parse(c.extra || '{}'); } catch { /* none */ }
    if (teamOf.has(c.id) || e.teamId) continue;
    const ws = typeof e.workspace === 'string' ? e.workspace : '';
    items.push(Object.assign({ kind: 'c', id: c.id, name: c.name || 'Chat', ws, custom: !!e.customWorkspace, updated: c.updated_at || 0, convIds: [c.id] }, look(ws, c.id)));
  }
  for (const t of teams) {
    if (t.archived_at) continue;
    let agents = []; try { agents = JSON.parse(t.agents || '[]'); } catch { /* none */ }
    items.push(Object.assign({ kind: 't', id: t.id, name: t.name || 'Team', ws: t.workspace || '', custom: true, members: agents.length, updated: t.updated_at || 0, convIds: agents.map((a) => a && a.conversation_id).filter(Boolean) }, look(t.workspace || '', t.id)));
  }
  return { items };
}

module.exports = { cmdStatus, rewrite, spellings, mangle, localVersion, packageLayout, cmdMove, cmdBack, cmdRelink, cmdExport, cmdImport, undoJournal, openDb, MANIFEST, ROWS, DRIVE_INDEX };

if (require.main === module) {
  const cmd = argv[0];
  const done = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(code || 0); };
  let db = null;
  try {
    const args = opt('--json-file') ? JSON.parse(fs.readFileSync(opt('--json-file'), 'utf8')) : opt('--json') ? JSON.parse(opt('--json')) : {};
    const dbFile = opt('--db');
    if (!dbFile || !exists(dbFile)) done({ ok: false, error: 'No chats database at ' + dbFile + '.' }, 1);
    const ctx = { home: opt('--home', os.homedir()), work: opt('--work', path.join(os.tmpdir(), 'aiondx-place')), dataDir: path.dirname(path.dirname(path.resolve(dbFile))) };
    db = openDb(dbFile, cmd === 'status');
    const r = cmd === 'move' ? cmdMove(db, args, ctx) : cmd === 'back' ? cmdBack(db, args, ctx) : cmd === 'relink' ? cmdRelink(db, args, ctx)
      : cmd === 'status' ? cmdStatus(db) : cmd === 'export' ? cmdExport(db, args, ctx) : cmd === 'import' ? cmdImport(db, args, ctx)
      : cmd === 'tidy' ? cmdTidy(db, args, ctx)
      : cmd === 'undo' ? (() => { const j = readJson(args.journal); if (!j) throw new Error('No journal at ' + args.journal + '.'); const left = undoJournal(j, db); return { undone: !left.length, left }; })()
      : null;
    if (!r) done({ ok: false, error: 'Commands: status, move, back, relink, export, import, tidy, undo.' }, 1);
    db.close(); db = null;
    done(Object.assign({ ok: true }, r));
  } catch (e) {
    try { if (db) db.close(); } catch { /* closed */ }
    done({ ok: false, error: e.message, partial: e.partial }, e.code === 2 ? 2 : 1);
  }
}
