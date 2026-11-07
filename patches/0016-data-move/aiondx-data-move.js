#!/usr/bin/env node
/**
 * aiondx-data-move.js - moves an earlier AionUi data folder (%APPDATA%\AionUi) to AionDX's (%APPDATA%\AionDX) without breaking a chat.
 *
 *   node aiondx-data-move.js plan     [--roaming DIR] [--home DIR]      what would change; changes nothing
 *   node aiondx-data-move.js run      [--roaming DIR] [--home DIR]      move, rewrite, verify; undo everything on any failure
 *   node aiondx-data-move.js rollback [--roaming DIR] [--home DIR]      undo an interrupted or finished move from its journal
 *
 * a request of 2026-11-01. Run by the installer (installer\aiondx.iss) after the files are copied and while the apps are closed.
 *
 * Why it is not a plain rename: every conversation stores its working folder as an absolute path under the old folder, in the database
 * (conversations, teams, folders, messages, mailbox, skills, assistants) and Claude Code keeps each chat's history in a folder named after
 * that path (~\.claude\projects\C--Users-...-AionUi-aionui-conversations-...). A link at the old name would keep both working, but junctions were
 * measured not to work on this PC, so the path is rewritten everywhere it is stored instead.
 *
 * Order, each step journaled in %LOCALAPPDATA%\AionDX\data-move\<stamp>\journal.json so it can be undone in reverse:
 *   0. checks (nothing is changed unless all pass): the old folder is a real folder with a chats database; AionDX's folder has no chats; no
 *      program has the database open; enough disk space for a backup of it; the database's integrity;
 *   1. a backup copy of the database, and the numbers a move must not change: rows in every table, and for every conversation whether its
 *      working folder exists;
 *   2. the old folder is renamed to AionDX's (one atomic rename on the same volume);
 *   3. every text column in the database has the old path rewritten to the new one, in all its spellings, in one transaction;
 *   4. each Claude Code history folder named after an old path is renamed to the new path's name;
 *   5. small settings files that hold the old path are rewritten (each with a .before copy);
 *   6. verification: the database passes its integrity check, every table has the same rows, no old path is left in it, every working
 *      folder exists exactly as before, and every renamed history folder is where it should be. Any difference undoes steps 5 to 2.
 * Exit codes: 0 moved; 3 nothing to do; 5 refused by a check (nothing changed); 7 failed and undone; 8 failed and could not be fully undone.
 *
 * Only counts, folder names and paths are logged; no message text is read into the log.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'plan';
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROAMING = opt('--roaming', process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
const HOME = opt('--home', process.env.USERPROFILE || os.homedir());
const LOCAL = opt('--local', process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'));
const OLD = path.join(ROAMING, 'AionUi');    // legacy-name
const NEW = path.join(ROAMING, 'AionDX');
const INNER = 'aionui';                      // legacy-name: the folder inside the data folder, still named so
const DB_NAMES = ['aiondx-backend.db', 'aionui-backend.db']; // legacy-name
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const WORK = path.join(LOCAL, 'AionDX', 'data-move', STAMP);
const LOGFILE = path.join(WORK, 'data-move.log');

let logLines = [];
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  logLines.push(line);
  try { fs.mkdirSync(WORK, { recursive: true }); fs.appendFileSync(LOGFILE, line + '\n'); } catch (e) { /* the console has it */ }
}

class Refused extends Error {}
// a test hook: AIONDX_DATA_MOVE_FAIL_AFTER=folder|db|history|files makes the run fail right after that step, to prove it is undone
const inject = (step) => { if (process.env.AIONDX_DATA_MOVE_FAIL_AFTER === step) throw new Error('injected failure after ' + step); };

// ---------------------------------------------------------------- helpers
function realDir(p) { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch (e) { return false; } }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function dbIn(root) { for (const n of DB_NAMES) { const f = path.join(root, INNER, n); if (exists(f)) return f; } return null; }
function hasChats(root) { try { const f = dbIn(root); return !!f && fs.statSync(f).size > 0; } catch (e) { return false; } }
function mangle(p) { return p.replace(/[^A-Za-z0-9]/g, '-'); }   // how Claude Code names a project folder
// The folder's path in the three spellings the database holds it in, each followed by the separator that goes with it: only the folder and what is
// inside it is matched, never a neighbour whose name merely starts the same way (AionUi.imported-2026..., which is not being moved).
const SEPS = ['\\', '\\\\', '/'];
const SPELLINGS = (root) => [root, root.replace(/\\/g, '\\\\'), root.replace(/\\/g, '/')].map((s, i) => s + SEPS[i]);
function swapPrefixes(oldRoot, newRoot) { const o = SPELLINGS(oldRoot), n = SPELLINGS(newRoot); return o.map((x, i) => [x, n[i]]); }

function openDb(file, readOnly) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: !!readOnly, timeout: 60000 });
}
function userTables(db) {
  const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
  const virtual = all.filter((t) => /CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql || '')).map((t) => t.name);
  return all.filter((t) => !/^sqlite_|^_sqlx/.test(t.name) && !virtual.includes(t.name) && !virtual.some((v) => t.name.startsWith(v + '_'))).map((t) => t.name);
}
function textColumns(db, table) {
  return db.prepare('PRAGMA table_info("' + table + '")').all().filter((c) => /CHAR|TEXT|CLOB|JSON|^$/i.test(c.type || '')).map((c) => c.name);
}
function rowCounts(db) {
  const out = {};
  for (const t of userTables(db)) out[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM "' + t + '"').get().n);
  return out;
}
function pathsOfConversations(db, root) {
  // For every conversation: the working folder it names under the root, and whether that folder exists. Counts the mapping, not text.
  const rows = db.prepare('SELECT id, extra FROM conversations').all();
  const out = {};
  for (const r of rows) {
    let ws = null;
    try { const j = JSON.parse(r.extra || '{}'); ws = j.workspace || (j.extra && j.extra.workspace) || null; } catch (e) { ws = null; }
    if (typeof ws === 'string' && ws.toLowerCase().startsWith(root.toLowerCase() + '\\')) out[r.id] = ws;
  }
  return out;
}
function countLeftover(db, oldRoot) {
  // Rows (per table.column) that still hold the old path in any spelling, compared without regard to case.
  const needles = SPELLINGS(oldRoot).map((s) => s.toLowerCase());
  const left = {};
  for (const t of userTables(db)) for (const c of textColumns(db, t)) {
    let n = 0;
    for (const s of needles) n += Number(db.prepare('SELECT COUNT(*) AS n FROM "' + t + '" WHERE instr(lower("' + c + '"), ?) > 0').get(s).n);
    if (n) left[t + '.' + c] = n;
  }
  return left;
}
function claudeConfigDirs(db) {
  const dirs = new Set();
  try {
    for (const n of fs.readdirSync(HOME)) {
      if (/^\.claude(-[A-Za-z0-9_]+)?$/.test(n) && !/imported|backup|\.bak/i.test(n) && realDir(path.join(HOME, n))) dirs.add(path.join(HOME, n));
    }
  } catch (e) { /* no home listing */ }
  try {
    for (const r of db.prepare("SELECT env FROM agent_metadata WHERE env IS NOT NULL AND env LIKE '%CLAUDE_CONFIG_DIR%'").all()) {
      try { const e = JSON.parse(r.env); if (e && e.CLAUDE_CONFIG_DIR && realDir(e.CLAUDE_CONFIG_DIR)) dirs.add(path.resolve(e.CLAUDE_CONFIG_DIR)); } catch (x) { /* not JSON */ }
    }
  } catch (e) { /* no table */ }
  return [...dirs];
}
function historyFolders(dirs, oldRoot) {
  const prefix = mangle(oldRoot);
  const found = [];
  for (const d of dirs) {
    const pj = path.join(d, 'projects');
    let names = [];
    try { names = fs.readdirSync(pj); } catch (e) { continue; }
    // the folder's own history folders only: <prefix>-aionui-... (the data folder's inner folder follows); not <prefix>-imported-... of a neighbour
    for (const n of names) if (n === prefix + '-aionui' || n.startsWith(prefix + '-aionui-')) found.push({ dir: pj, name: n }); // legacy-name
  }
  return found;
}
function freeBytes(p) { try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch (e) { return Infinity; } }

// ---------------------------------------------------------------- the journal (what was done, so it can be undone)
class Journal {
  constructor(file) { this.file = file; this.steps = []; this.state = 'started'; }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ roaming: ROAMING, home: HOME, old: OLD, new: NEW, state: this.state, steps: this.steps }, null, 2)); }
  add(step) { this.steps.push(step); this.save(); }
}
function undo(journal) {
  let clean = true;
  for (const s of journal.steps.slice().reverse()) {
    try {
      if (s.kind === 'file-rewrite') { if (exists(s.backup)) { fs.copyFileSync(s.backup, s.file); } }
      else if (s.kind === 'agent-file') { if (exists(s.backup)) { fs.copyFileSync(s.backup, s.file); try { fs.utimesSync(s.file, new Date(), new Date(s.mtime)); } catch (e) { /* nicety */ } } }
      else if (s.kind === 'agent-dir') { if (exists(s.to) && !exists(s.from)) fs.renameSync(s.to, s.from); }
      else if (s.kind === 'agent-db') { if (exists(s.backup) && exists(s.db)) { for (const x of ['', '-wal', '-shm']) { try { fs.rmSync(s.db + x, { force: true }); } catch (e) { /* none */ } } fs.copyFileSync(s.backup, s.db); } }
      else if (s.kind === 'history-rename') { if (exists(s.to) && !exists(s.from)) fs.renameSync(s.to, s.from); }
      else if (s.kind === 'db-rewrite') {
        // the rewrite is one transaction; if it committed, the backup copy is the way back
        if (s.backup && exists(s.backup) && exists(s.db)) {
          for (const x of ['', '-wal', '-shm']) { try { fs.rmSync(s.db + x, { force: true }); } catch (e) { /* none */ } }
          fs.copyFileSync(s.backup, s.db);
        }
      } else if (s.kind === 'folder-rename') { if (exists(s.to) && !exists(s.from)) fs.renameSync(s.to, s.from); }
      else if (s.kind === 'stub-removed') { /* the empty start-up folder is not worth restoring */ }
      log('undone: ' + s.kind + ' ' + (s.from || s.file || s.db || ''));
    } catch (e) { clean = false; log('COULD NOT UNDO ' + s.kind + ': ' + e.message); }
  }
  return clean;
}

// ---------------------------------------------------------------- the checks and the plan
function checks() {
  if (!realDir(OLD)) throw Object.assign(new Refused('there is no earlier AionUi folder to move'), { code: 3 });
  const oldDb = dbIn(OLD);
  if (!oldDb || fs.statSync(oldDb).size === 0) throw Object.assign(new Refused('the earlier folder holds no chats database'), { code: 3 });
  if (hasChats(NEW)) throw Object.assign(new Refused('AionDX already has chats of its own in ' + NEW + '; nothing is moved'), { code: 3 });
  return { oldDb };
}

function planAndBaseline(oldDb) {
  const db = openDb(oldDb, true);
  try {
    const ic = db.prepare('PRAGMA quick_check').get();
    const ok = ic && Object.values(ic)[0] === 'ok';
    if (!ok) throw new Refused('the chats database does not pass its own check, so it is left alone (' + JSON.stringify(ic) + ')');
    const counts = rowCounts(db);
    const convs = pathsOfConversations(db, OLD);
    const exist = {};
    for (const [id, ws] of Object.entries(convs)) exist[id] = exists(ws);
    const dirs = claudeConfigDirs(db);
    const hist = historyFolders(dirs, OLD);
    const left = countLeftover(db, OLD);
    return { counts, convs, exist, dirs, hist, left };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- the move
function rewriteDatabase(dbFile) {
  const db = openDb(dbFile, false);
  const pairs = swapPrefixes(OLD, NEW);
  const changed = {};
  try {
    db.exec('PRAGMA busy_timeout = 60000');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of userTables(db)) for (const c of textColumns(db, t)) {
        const cond = pairs.map(() => 'instr("' + c + '", ?) > 0').join(' OR ');
        let expr = '"' + c + '"';
        const args = [];
        for (const [o, n] of pairs) { expr = 'replace(' + expr + ', ?, ?)'; args.push(o, n); }
        const st = db.prepare('UPDATE "' + t + '" SET "' + c + '" = ' + expr + ' WHERE ' + cond);
        const r = st.run(...args, ...pairs.map(([o]) => o));
        if (Number(r.changes)) changed[t + '.' + c] = Number(r.changes);
      }
      // anything left in another spelling of the case (Windows paths are not case-sensitive): rewritten row by row
      const left = countLeftover(db, OLD);
      for (const key of Object.keys(left)) {
        const [t, c] = key.split('.');
        const rows = db.prepare('SELECT rowid AS rid, "' + c + '" AS v FROM "' + t + '" WHERE instr(lower("' + c + '"), ?) > 0 OR instr(lower("' + c + '"), ?) > 0 OR instr(lower("' + c + '"), ?) > 0').all(...SPELLINGS(OLD).map((s) => s.toLowerCase()));
        const upd = db.prepare('UPDATE "' + t + '" SET "' + c + '" = ? WHERE rowid = ?');
        for (const row of rows) {
          let v = String(row.v);
          for (const [o, n] of pairs) v = v.replace(new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), () => n);
          upd.run(v, row.rid);
        }
        changed[key + ' (case)'] = rows.length;
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* already ended */ } throw e; }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  return changed;
}

// ---------------------------------------------------------------- other agents' history (step 4b)
// Agents keep their chat history their own way, and no list of forty-odd agents stays true. What they have in common is that the history holds
// the working folder of the chat: in a file (JSON, JSONL, TOML, YAML, Markdown), in a SQLite database, or in the name of a folder (the path
// with its punctuation turned into dashes, or a hash of it). So the agents' own data folders (the registry's agents by name, and the dot-folders of
// the home folder) are searched for exactly that, and what is found is rewritten or renamed: with a backup of every file first, the file's
// modification time kept (agents sort sessions by it), the result re-read and checked (JSON still parses, no old path left), and the step
// undone as a whole if anything fails. It never fails the move itself: the chats are safe without it, and `agents` repeats just this step.
const AGENT_SKIP_DIR = /^(node_modules|\.git|Cache|Code Cache|GPUCache|Crashpad|extensions|logs|log|Service Worker|CacheStorage|blob_storage|IndexedDB|Local Storage|Session Storage|Dictionaries|DawnGraphiteCache|DawnWebGPUCache|ShaderCache|GrShaderCache|\.cache|cache|npm-cache|_npx|WebStorage|Partitions|Shared Dictionary|sentry)$/i; // (Gemini keeps its per-folder history in tmp, so tmp is searched)
const HOME_SKIP = /^\.(claude.*|git|ssh|gnupg|cache|npm|nvm|cargo|rustup|docker|vscode.*|kube|aws|azure|gradle|m2|nuget|dotnet|aiondx|aionui|config|local|bash.*|python.*|conda|ipython|matplotlib|android|node.*|yarn|pnpm|bun|lesshst|viminfo|gitconfig|npmrc|wslconfig)$/i; // legacy-name
const TEXT_EXT = /\.(json|jsonl|toml|ya?ml|md|txt|ini|cfg|conf)$/i;
const DB_EXT = /\.(db|sqlite|sqlite3)$/i;
const GENERIC_TOKENS = new Set(['aion', 'cli', 'code', 'agent', 'acp', 'node', 'npx', 'bun', 'python', 'uv', 'sh', 'cmd', 'exe', 'the', 'ai', 'claude']);
const AGENT_PER_ROOT_MS = Number(process.env.AIONDX_DATA_MOVE_ROOT_MS) || 60000;
const AGENT_TOTAL_MS = Number(process.env.AIONDX_DATA_MOVE_AGENTS_MS) || 240000;
const AGENT_MAX_FILE = 100 * 1048576;

function sha(alg, s) { return require('crypto').createHash(alg).update(s).digest('hex'); }
function swapPath(w) { return w.toLowerCase().startsWith(OLD.toLowerCase() + '\\') ? NEW + w.slice(OLD.length) : w; }
function agentTokens(db) {
  const out = new Set();
  const add = (s) => {
    s = String(s || '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    for (const part of [s, s.replace(/(-acp|-cli|-code|-agent|-gateway)+$/, ''), ...s.split(/[^a-z0-9]+/)]) {
      const t = part.replace(/[^a-z0-9]/g, '');
      if (t.length >= 3 && !GENERIC_TOKENS.has(t)) out.add(t);
    }
  };
  try { for (const r of db.prepare('SELECT backend, name, command FROM agent_metadata').all()) { add(r.backend); add(r.name); add(String(r.command || '').split(/[\\/]/).pop()); } } catch (e) { /* no table */ }
  return out;
}
function agentRoots(tokens, claudeDirs) {
  const roots = new Map();   // path -> { claude: bool }
  const norm = (n) => n.toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
  const matches = (n) => { const x = norm(n); return [...tokens].some((t) => x === t || x.startsWith(t) || t.startsWith(x) && x.length >= 4); };
  const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { return []; } };
  for (const e of listDir(HOME)) if (e.name.startsWith('.') && !HOME_SKIP.test(e.name)) roots.set(path.join(HOME, e.name), {});
  for (const base of [path.join(HOME, '.config'), path.join(HOME, '.local', 'share'), ROAMING, LOCAL]) {
    for (const e of listDir(base)) if (!/^(AionUi|AionDX|Temp|Packages|Microsoft|npm|Programs)/i.test(e.name) && matches(e.name)) roots.set(path.join(base, e.name), {}); // legacy-name
  }
  for (const d of claudeDirs) roots.set(d, { claude: true });
  return roots;
}
function nameMap(workspacesOld) {
  const m = new Map();
  const variants = [(s) => s.replace(/[^A-Za-z0-9]/g, '-'), (s) => s.replace(/[^A-Za-z0-9]/g, '-').toLowerCase(), (s) => sha('sha256', s), (s) => sha('sha256', s.toLowerCase()),
    (s) => sha('sha256', s.replace(/\\/g, '/')), (s) => sha('md5', s), (s) => sha('sha1', s)];
  for (const w of workspacesOld) { const w2 = swapPath(w); for (const f of variants) { const a = f(w), b = f(w2); if (a !== b && !m.has(a)) m.set(a, b); } }
  return m;
}
function rewriteText(text) {
  const pairs = swapPrefixes(OLD, NEW);
  let u = text;
  for (const [o, n] of pairs) u = u.split(o).join(n);
  for (const [o, n] of pairs) u = u.replace(new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), () => n);   // another letter case
  return u;
}
function holdsOld(buf) {
  const lower = buf.toString('latin1').toLowerCase();
  return SPELLINGS(OLD).some((s) => lower.includes(s.toLowerCase()));
}
function validJson(ext, text) {
  try {
    if (/\.jsonl$/i.test(ext)) { for (const line of text.split(/\r?\n/)) if (line.trim()) JSON.parse(line); return true; }
    JSON.parse(text); return true;
  } catch (e) { return false; }
}

function relocateAgents(journal, ctx) {
  const t0 = Date.now();
  const stats = { roots: {}, files: 0, dbs: 0, dirs: 0, skipped: [] };
  const map = nameMap(ctx.workspaces);
  const agentDir = path.join(WORK, 'agents');
  if (!ctx.dry) fs.mkdirSync(agentDir, { recursive: true });
  let n = 0;
  const uid = () => (n++) + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);   // a name no earlier run used
  const bump = (root, what) => { const r = path.relative(HOME, root) || root; stats.roots[r] = stats.roots[r] || {}; stats.roots[r][what] = (stats.roots[r][what] || 0) + 1; };

  function doFile(p, root, ext) {
    let st; try { st = fs.statSync(p); } catch (e) { return; }
    if (st.size > AGENT_MAX_FILE) { if (/\.json/i.test(ext)) stats.skipped.push(p + ' (over 100 MB)'); return; }
    let buf; try { buf = fs.readFileSync(p); } catch (e) { stats.skipped.push(p + ' (' + e.code + ')'); return; }
    if (!holdsOld(buf)) return;
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) { stats.skipped.push(p + ' (UTF-16)'); return; }
    const text = buf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buf)) { stats.skipped.push(p + ' (not UTF-8)'); return; }
    const u = rewriteText(text);
    if (u === text) return;
    if (ctx.dry) { stats.files++; bump(root, 'files'); return; }
    const wasJson = /\.jsonl?$/i.test(ext) && validJson(ext, text);
    if (wasJson && !validJson(ext, u)) { stats.skipped.push(p + ' (would no longer parse)'); return; }
    const bk = path.join(agentDir, uid() + '-' + path.basename(p) + '.before');
    fs.writeFileSync(bk, buf);
    const tmp = p + '.aiondx-tmp';
    try {
      fs.writeFileSync(tmp, u);
      fs.renameSync(tmp, p);
      try { fs.utimesSync(p, st.atime, st.mtime); } catch (e) { /* the time is a nicety */ }
    } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (x) { /* none */ } stats.skipped.push(p + ' (' + e.code + ')'); return; }
    journal.add({ kind: 'agent-file', file: p, backup: bk, mtime: st.mtimeMs });
    // checked from the disk, not from memory
    const again = fs.readFileSync(p);
    if (holdsOld(again) || (wasJson && !validJson(ext, again.toString('utf8')))) throw new Error('an agent file did not come out right: ' + p);
    stats.files++; bump(root, 'files');
  }
  function doDb(p, root) {
    let st; try { st = fs.statSync(p); } catch (e) { return; }
    if (st.size > 512 * 1048576 || st.size < 1024) return;
    let head = Buffer.alloc(16); try { const fd = fs.openSync(p, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); } catch (e) { return; }
    if (head.toString('latin1') !== 'SQLite format 3\0') return;
    let buf; try { buf = fs.readFileSync(p); } catch (e) { stats.skipped.push(p + ' (' + e.code + ')'); return; }
    if (!holdsOld(buf)) { return; }
    if (ctx.dry) { stats.dbs++; bump(root, 'databases'); return; }
    let db;
    try { db = openDb(p, true); const qc = db.prepare('PRAGMA quick_check').get(); if (Object.values(qc)[0] !== 'ok') throw new Error('integrity'); }
    catch (e) { stats.skipped.push(p + ' (database: ' + e.message + ')'); try { db && db.close(); } catch (x) { /* closed */ } return; }
    const counts = rowCounts(db);
    const bk = path.join(agentDir, uid() + '-' + path.basename(p) + '.before');
    try { db.exec("VACUUM INTO '" + bk.replace(/'/g, "''") + "'"); } catch (e) { db.close(); stats.skipped.push(p + ' (backup: ' + e.message + ')'); return; }
    db.close();
    try { rewriteDatabase(p); } catch (e) { stats.skipped.push(p + ' (rewrite: ' + e.message + ')'); return; }
    journal.add({ kind: 'agent-db', db: p, backup: bk });
    const v = openDb(p, true);
    try {
      if (Object.values(v.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new Error('an agent database fails its integrity check after the rewrite: ' + p);
      if (JSON.stringify(rowCounts(v)) !== JSON.stringify(counts)) throw new Error('an agent database changed its row counts: ' + p);
      if (Object.keys(countLeftover(v, OLD)).length) throw new Error('an agent database still holds the old path: ' + p);
    } finally { v.close(); }
    stats.dbs++; bump(root, 'databases');
  }
  function walk(dir, root, isClaude, depth, deadline) {
    if (Date.now() > deadline || Date.now() - t0 > AGENT_TOTAL_MS) { stats.skipped.push(dir + ' (time budget)'); return; }
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (AGENT_SKIP_DIR.test(e.name) || depth > 6) continue;
        if (isClaude && depth === 0 && e.name === 'projects') continue;   // Claude's history folders have their own step
        let target = p;
        if (!isClaude && depth <= 5 && map.has(e.name)) {
          const to = path.join(dir, map.get(e.name));
          if (ctx.dry) { stats.dirs++; bump(root, 'folders renamed'); }
          else if (!exists(to)) {
            try { fs.renameSync(p, to); journal.add({ kind: 'agent-dir', from: p, to }); stats.dirs++; bump(root, 'folders renamed'); target = to; }
            catch (x) { stats.skipped.push(p + ' (' + x.code + ')'); }
          } else stats.skipped.push(p + ' (the new name already exists)');
        }
        walk(target, root, isClaude, depth + 1, deadline);
      } else if (TEXT_EXT.test(e.name) && !/\.before$/.test(e.name)) doFile(p, root, path.extname(e.name));
      else if (DB_EXT.test(e.name)) doDb(p, root);
    }
  }
  const roots = agentRoots(ctx.tokens, ctx.claudeDirs);
  for (const [root, info] of roots) {
    if (Date.now() - t0 > AGENT_TOTAL_MS) { stats.skipped.push(root + ' (time budget)'); continue; }
    walk(root, root, !!info.claude, 0, Date.now() + AGENT_PER_ROOT_MS);
  }
  log((ctx.dry ? 'plan, other agents: ' : 'other agents: ') + roots.size + ' data folders searched in ' + Math.round((Date.now() - t0) / 1000) + ' s; ' + stats.files + ' files, ' + stats.dbs + ' databases and ' + stats.dirs + ' folders rewritten or renamed' + (stats.skipped.length ? '; ' + stats.skipped.length + ' skipped' : ''));
  for (const [r, s] of Object.entries(stats.roots)) log('   ' + r + ': ' + JSON.stringify(s));
  for (const s of stats.skipped.slice(0, 12)) log('   skipped ' + s);
  return stats;
}

function agentContext(dbFile, fromRoot) {
  const db = openDb(dbFile, true);
  try {
    const ws = Object.values(pathsOfConversations(db, fromRoot)).map((w) => OLD + w.slice(fromRoot.length));   // the old names of the working folders
    return { tokens: agentTokens(db), claudeDirs: claudeConfigDirs(db), workspaces: ws };
  } finally { db.close(); }
}

function run(dry) {
  const { oldDb } = checks();
  log('earlier folder: ' + OLD + '; database ' + path.basename(oldDb) + ' (' + Math.round(fs.statSync(oldDb).size / 1048576) + ' MB)');
  const base = planAndBaseline(oldDb);
  const totalRows = Object.values(base.counts).reduce((a, b) => a + b, 0);
  log('rows: ' + totalRows + ' in ' + Object.keys(base.counts).length + ' tables; ' + Object.keys(base.convs).length + ' conversations with a working folder under the earlier folder (' + Object.values(base.exist).filter(Boolean).length + ' of them exist)');
  log('Claude history folders to rename: ' + base.hist.length + ' in ' + base.dirs.length + ' Claude folder(s)');
  log('rows holding the old path now: ' + JSON.stringify(base.left));
  if (dry) {
    try { const actx = agentContext(oldDb, OLD); actx.dry = true; relocateAgents({ add() {} }, actx); } catch (e) { log('plan, other agents: could not be searched (' + e.message + ')'); }
    log('plan only: nothing was changed');
    return 0;
  }

  const need = fs.statSync(oldDb).size * 1.2;
  if (freeBytes(LOCAL) < need) throw Object.assign(new Refused('not enough free disk space for a backup of the chats database (' + Math.round(need / 1048576) + ' MB needed)'), { code: 5 });
  // no program has the database open: the folder rename would fail on an open file, and a rewrite needs the file to itself
  try { const fd = fs.openSync(oldDb, 'r+'); fs.closeSync(fd); } catch (e) { throw Object.assign(new Refused('the chats database is in use (' + e.code + '); close AionUi, AionDX and their agents'), { code: 5 }); }

  fs.mkdirSync(WORK, { recursive: true });
  const journal = new Journal(path.join(WORK, 'journal.json'));
  journal.save();
  let committed = false;
  try {
    // 1. backup
    const backup = path.join(WORK, 'backup-' + path.basename(oldDb));
    const src = openDb(oldDb, true);
    try { src.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'"); } finally { src.close(); }
    const b = openDb(backup, true);
    const bc = rowCounts(b); b.close();
    if (JSON.stringify(bc) !== JSON.stringify(base.counts)) throw new Error('the backup copy does not hold the same rows');
    log('backup of the database written to ' + backup);

    // 2. the folder
    if (realDir(NEW)) {
      // only what Chromium makes at a start with no data; the check above found no chats in it
      fs.rmSync(NEW, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      journal.add({ kind: 'stub-removed', path: NEW });
      log('removed the empty start-up folder ' + NEW);
    }
    fs.renameSync(OLD, NEW);
    journal.add({ kind: 'folder-rename', from: OLD, to: NEW });
    log('renamed ' + OLD + ' to ' + NEW);
    inject('folder');

    // 3. the database
    const newDb = dbIn(NEW);
    const changed = rewriteDatabase(newDb);   // one transaction: a failure inside it leaves the file as it was
    journal.add({ kind: 'db-rewrite', db: newDb, backup });   // from here on, the backup copy is the way back
    log('rewrote the old path in ' + Object.keys(changed).length + ' columns: ' + JSON.stringify(changed));
    inject('db');

    // 4. Claude Code history folders
    const renamed = [];
    for (const h of base.hist) {
      const to = mangle(NEW) + h.name.slice(mangle(OLD).length);
      const from = path.join(h.dir, h.name), dest = path.join(h.dir, to);
      if (exists(dest)) throw new Error('a history folder already exists at ' + dest);
      fs.renameSync(from, dest);
      journal.add({ kind: 'history-rename', from, to: dest });
      renamed.push([from, dest]);
    }
    log('renamed ' + renamed.length + ' Claude history folder(s)');
    inject('history');

    // 4b. other agents' history (never fails the move: this step alone is undone if it goes wrong)
    const agentStart = journal.steps.length;
    try { relocateAgents(journal, agentContext(newDb, NEW)); inject('agents'); }
    catch (e) {
      log('other agents: NOT updated (' + e.message + '); that step is undone, the move stands. aiondx-data-move.cmd agents repeats it.');
      const part = journal.steps.splice(agentStart); journal.save(); undo({ steps: part });
    }

    // 5. small settings files in the moved folder that hold the path
    let rewrittenFiles = 0;
    const walk = (d, depth) => {
      if (depth > 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!/^(Cache|Code Cache|GPUCache|Local Storage|IndexedDB|Session Storage|blob_storage|Network|conversations|builtin-skills|runtime|logs|Crashpad|DawnGraphiteCache|DawnWebGPUCache|sentry|Partitions|Shared Dictionary|Dictionaries)$/i.test(e.name)) walk(p, depth + 1); continue; }
        if (!/\.json$/i.test(e.name) || e.name.endsWith('.before')) continue;
        let st; try { st = fs.statSync(p); } catch (x) { continue; }
        if (st.size > 2 * 1048576) continue;
        const s = fs.readFileSync(p, 'utf8');
        let u = s;
        for (const [o, n] of swapPrefixes(OLD, NEW)) u = u.split(o).join(n);
        if (u !== s) {
          const bk = path.join(WORK, 'files', String(rewrittenFiles++) + '-' + e.name + '.before');
          fs.mkdirSync(path.dirname(bk), { recursive: true });
          fs.writeFileSync(bk, s);
          fs.writeFileSync(p, u);
          journal.add({ kind: 'file-rewrite', file: p, backup: bk });
        }
      }
    };
    walk(NEW, 0);
    log('rewrote the path in ' + rewrittenFiles + ' settings file(s)');
    inject('files');

    // 6. verification
    const v = openDb(newDb, true);
    try {
      const ic = v.prepare('PRAGMA quick_check').get();
      if (Object.values(ic)[0] !== 'ok') throw new Error('the database fails its integrity check after the rewrite: ' + JSON.stringify(ic));
      const after = rowCounts(v);
      if (JSON.stringify(after) !== JSON.stringify(base.counts)) throw new Error('row counts changed: ' + JSON.stringify({ before: base.counts, after }));
      const left = countLeftover(v, OLD);
      if (Object.keys(left).length) throw new Error('the old path is still stored in ' + JSON.stringify(left));
      const convs = pathsOfConversations(v, NEW);
      if (Object.keys(convs).length !== Object.keys(base.convs).length) throw new Error('the number of conversations with a working folder changed');
      let mismatch = 0;
      for (const id of Object.keys(base.convs)) if (exists(convs[id]) !== base.exist[id]) mismatch++;
      if (mismatch) throw new Error(mismatch + ' conversations have a working folder that existed before and does not now (or the reverse)');
    } finally { v.close(); }
    for (const [from, to] of renamed) if (!exists(to) || exists(from)) throw new Error('a history folder is not where it should be: ' + to);
    log('verified: integrity ok, ' + totalRows + ' rows in the same tables, no old path left, every working folder as before, history folders in place');
    journal.state = 'done'; journal.save();
    committed = true;
    return 0;
  } catch (e) {
    if (committed) throw e;
    log('FAILED: ' + e.message);
    journal.state = 'failed'; journal.save();
    const clean = undo(journal);
    journal.state = clean ? 'undone' : 'undo-failed'; journal.save();
    if (e instanceof Refused) throw e;
    throw Object.assign(new Error(e.message), { code: clean ? 7 : 8 });
  }
}

function agentsOnly() {
  if (!realDir(NEW) || !hasChats(NEW)) throw Object.assign(new Refused('there is no moved AionDX data folder with chats'), { code: 3 });
  const db = dbIn(NEW);
  fs.mkdirSync(WORK, { recursive: true });
  const journal = new Journal(path.join(WORK, 'journal.json'));
  journal.save();
  try { relocateAgents(journal, agentContext(db, NEW)); journal.state = 'done'; journal.save(); return 0; }
  catch (e) { log('FAILED: ' + e.message); undo(journal); journal.state = 'undone'; journal.save(); return 7; }
}

function rollbackLatest() {
  const root = path.join(LOCAL, 'AionDX', 'data-move');
  let stamps = []; try { stamps = fs.readdirSync(root).sort(); } catch (e) { /* none */ }
  const last = stamps.reverse().find((s) => exists(path.join(root, s, 'journal.json')));
  if (!last) throw Object.assign(new Refused('no move to undo'), { code: 3 });
  const j = JSON.parse(fs.readFileSync(path.join(root, last, 'journal.json'), 'utf8'));
  log('undoing the move recorded in ' + last + ' (state ' + j.state + ')');
  const clean = undo({ steps: j.steps });
  return clean ? 0 : 8;
}

try {
  let code;
  if (cmd === 'plan') code = run(true);
  else if (cmd === 'run') code = run(false);
  else if (cmd === 'rollback') code = rollbackLatest();
  else if (cmd === 'agents') code = agentsOnly();
  else { console.error('usage: aiondx-data-move.js plan|run|agents|rollback [--roaming DIR] [--home DIR] [--local DIR]'); code = 2; }
  process.exit(code);
} catch (e) {
  log((e instanceof Refused ? 'not moved: ' : 'ERROR: ') + e.message);
  process.exit(e.code || 5);
}
