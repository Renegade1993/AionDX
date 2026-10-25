'use strict';
/* export.js - copies this PC's AionDX setup into the package folder's data\ (the folder above tools\). Read-only on the sources.
 *   node export.js [--dry] [--include-active]
 *     --dry              measure and decide, copy nothing
 *     --include-active   also copy the very large sessions that are still being written to (still inside the 5 GB, newest first)
 *
 * Incremental: a file already in data\ with the same size and time is not copied again, and a file in data\ that is no longer part of the
 * export is removed, so the second run copies only what changed. While it runs, data\EXPORT-IN-PROGRESS exists and install.ps1 refuses
 * the package; the marker goes only when the export finished and MANIFEST.json was written.
 * The database is copied with SQLite's VACUUM INTO (one consistent snapshot while AionDX keeps writing), through node:sqlite.
 * Bounded: stops itself after 3 hours, or when a file named STOP appears in the package folder. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY = process.argv.includes('--dry');
const INCLUDE_ACTIVE = process.argv.includes('--include-active');
const HOME = os.homedir();
const APPDATA = process.env.APPDATA;
const LOCAL = process.env.LOCALAPPDATA;
const OUT = process.env.AIONDX_PACKAGE_DIR ? path.resolve(process.env.AIONDX_PACKAGE_DIR) : path.resolve(__dirname, '..');
const DATA = path.join(OUT, 'data');
const MARK = path.join(DATA, 'EXPORT-IN-PROGRESS');
const BUDGET = 5 * 1024 * 1024 * 1024;              // the conversation cache that goes in: the 5 GB most recent
const DEADLINE = Date.now() + 3 * 3600 * 1000;
const STOP = path.join(OUT, 'STOP');
// Run by refresh-package.ps1 (AIONDX_PACKAGE_DIR set), its transcript is the log; run alone, it writes logs\export-data-<time>.log.
const LOG = process.env.AIONDX_PACKAGE_DIR ? null : path.join(OUT, 'logs', 'export-data-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + (DRY ? '-dry' : '') + '.log');
fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });
const log = (s) => { const line = new Date().toISOString().slice(11, 19) + '  ' + s; console.log(line); if (LOG) { try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* none */ } } };
const check = () => { if (Date.now() > DEADLINE || fs.existsSync(STOP)) { log('stopped: deadline or STOP file (data\\ is marked unfinished; run again)'); process.exit(4); } };
const lower = (s) => String(s).toLowerCase();
const isLink = (st) => st.isSymbolicLink();

const manifest = { schema: 'aiondx.export/2', createdAt: new Date().toISOString(), user: os.userInfo().username, home: HOME, appdata: APPDATA, localappdata: LOCAL,
  computer: os.hostname(), components: [], junctions: [], skipped: [], failures: [], conversationCache: {}, copied: { files: 0, bytes: 0 }, unchanged: { files: 0, bytes: 0 }, removed: 0 };
const keepSet = new Set();      // every file in data\ that belongs to this export (lower case)
const keepPath = (p) => keepSet.add(lower(p));
const keepDirs = new Set();     // every folder, empty ones included: a chat's working folder is often empty and must still exist
function keepDir(d) { keepDirs.add(lower(d)); if (!DRY) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* reported by the copy */ } } }

function junctionTarget(p) { try { return fs.readlinkSync(p).replace(/^\\\\\?\\/, ''); } catch (e) { return ''; } }
function tokenize(p) {
  const t = [[APPDATA, '{APPDATA}'], [LOCAL, '{LOCALAPPDATA}'], [HOME, '{HOME}']];
  for (const [base, tok] of t) if (lower(p).startsWith(lower(base) + '\\') || lower(p) === lower(base)) return tok + p.slice(base.length);
  return p;
}

/** One file into data\, unless the copy there already has its size and time. */
function syncFile(s, d, st, stats) {
  keepPath(d);
  stats.files++; stats.bytes += st.size;
  if (DRY) return;
  try {
    const x = fs.statSync(d);
    if (x.size === st.size && Math.abs(x.mtimeMs - st.mtimeMs) < 2) { manifest.unchanged.files++; manifest.unchanged.bytes += st.size; return; }
  } catch (e) { /* not there yet */ }
  try {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    fs.utimesSync(d, st.atime, st.mtime);
    manifest.copied.files++; manifest.copied.bytes += st.size;
  } catch (e) { stats.files--; stats.bytes -= st.size; manifest.failures.push(s + ' (' + e.code + ')'); }
}

/** Recursive sync. excl(relPath, isDir) true = leave out. Links are recorded, not followed. */
function copyTree(src, dst, excl, stats, rel) {
  rel = rel || '';
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { manifest.failures.push(src + ' (' + e.code + ')'); return; }
  keepDir(dst);
  for (const ent of entries) {
    check();
    const s = path.join(src, ent.name), d = path.join(dst, ent.name), r = rel ? rel + '\\' + ent.name : ent.name;
    let st; try { st = fs.lstatSync(s); } catch (e) { manifest.failures.push(s + ' (' + e.code + ')'); continue; }
    if (excl && excl(r, st.isDirectory())) { manifest.skipped.push(tokenize(s)); continue; }
    if (isLink(st)) { manifest.junctions.push({ link: tokenize(s), target: tokenize(junctionTarget(s)) }); continue; }
    if (st.isDirectory()) { copyTree(s, d, excl, stats, r); continue; }
    if (st.isFile()) syncFile(s, d, st, stats);
  }
}

function component(id, destRoot, src, excl, only) {
  if (!fs.existsSync(src)) { log('absent  ' + id + '  ' + src); return null; }
  const st = { files: 0, bytes: 0 };
  const dst = path.join(DATA, id);
  if (only) { for (const f of only) { const s = path.join(src, f); try { const x = fs.lstatSync(s); if (x.isFile()) syncFile(s, path.join(dst, f), x, st); } catch (e) { /* not there */ } } }
  else copyTree(src, dst, excl, st);
  manifest.components.push({ id, restoreTo: tokenize(destRoot), files: st.files, bytes: st.bytes });
  log((DRY ? 'would copy ' : 'synced  ') + id.padEnd(22) + String(st.files).padStart(8) + ' files ' + (st.bytes / 1048576).toFixed(0).padStart(7) + ' MB');
  return st;
}

/** A consistent copy of a live SQLite database: VACUUM INTO a temporary file beside the target, checked, then moved in. */
function backupDb(src, dstRel, id, restoreTo) {
  if (!fs.existsSync(src)) { log('absent  ' + src); return 0; }
  const dst = path.join(DATA, dstRel);
  keepPath(dst);
  if (DRY) { const sz = fs.statSync(src).size; log('would back up ' + src + ' (' + (sz / 1048576).toFixed(0) + ' MB)'); return sz; }
  const tmp = dst + '.part';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.rmSync(tmp, { force: true }); } catch (e) { /* none */ }
  const { DatabaseSync } = require('node:sqlite');
  const t0 = Date.now();
  try {
    const s = new DatabaseSync(src, { readOnly: true, timeout: 120000 });
    s.prepare('VACUUM INTO ?').run(tmp);
    s.close();
    const d = new DatabaseSync(tmp, { readOnly: true });
    const ok = d.prepare('PRAGMA quick_check').get();
    const tables = d.prepare("select count(*) n from sqlite_master where type='table'").get().n;
    d.close();
    const verdict = ok && Object.values(ok)[0];
    if (verdict !== 'ok') throw new Error('quick_check: ' + verdict);
    fs.rmSync(dst, { force: true });
    fs.renameSync(tmp, dst);
    const sz = fs.statSync(dst).size;
    log('database ' + path.basename(src) + ': snapshot ok, ' + tables + ' tables, ' + (sz / 1048576).toFixed(0) + ' MB, ' + Math.round((Date.now() - t0) / 1000) + ' s');
    manifest.components.push({ id, restoreTo: tokenize(restoreTo), files: 1, bytes: sz, database: true });
    return sz;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (x) { /* none */ }
    manifest.failures.push(src + ' (snapshot failed: ' + String(e && e.message || e).slice(0, 200) + ')');
    log('database ' + path.basename(src) + ': SNAPSHOT FAILED ' + (e && e.message || e));
    return 0;
  }
}

/** Windows user variables the agents need on the other PC, and the PATH entries inside the user folder. */
function userEnv() {
  const { spawnSync } = require('child_process');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "$u=[Environment]::GetEnvironmentVariables('User'); $o=@{}; foreach($k in $u.Keys){ $o[$k]=[string]$u[$k] }; $o | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let all = {};
  try { all = JSON.parse(r.stdout || '{}'); } catch (e) { manifest.failures.push('user environment (' + e.message + ')'); }
  const vars = {};
  for (const [k, v] of Object.entries(all)) if (/^(CLAUDE|ANTHROPIC|AIONUI|AIONDX|OLLAMA|OPENAI|GEMINI|GOOGLE_API|ELEVENLABS)/i.test(k)) vars[k] = tokenize(v);
  const pathEntries = String(all.Path || all.PATH || '').split(';').filter(Boolean).map(tokenize).filter((p) => /^\{(HOME|APPDATA|LOCALAPPDATA)\}/.test(p));
  return { vars, path: pathEntries };
}

/** Removes files in data\ that this export did not produce (stale), and the folders left empty. */
function sweep(dir) {
  let n = 0, entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { n += sweep(p); try { if (!keepDirs.has(lower(p)) && fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch (e) { /* in use */ } }
    else if (!keepSet.has(lower(p))) { try { fs.rmSync(p, { force: true }); n++; } catch (e) { /* in use */ } }
  }
  return n;
}

(async () => {
  const t0 = Date.now();
  log((DRY ? 'DRY RUN  ' : 'EXPORT  ') + 'to ' + OUT + ' (from ' + HOME + ')');
  if (!DRY) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(MARK, new Date().toISOString()); keepPath(MARK); try { fs.rmSync(path.join(OUT, 'MANIFEST.json'), { force: true }); } catch (e) { /* none */ } }

  // ---- AionDX (AionUi's data folder: the database has the teams, conversations, agents, settings)
  const aionui = path.join(APPDATA, 'AionUi');
  backupDb(path.join(aionui, 'aionui', 'aionui-backend.db'), 'roaming-AionUi/aionui/aionui-backend.db', 'roaming-AionUi-db', path.join(aionui, 'aionui', 'aionui-backend.db'));
  const skipTop = new Set(['logs', 'cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache', 'crashpad', 'blob_storage', 'dictionaries', 'sentry', 'dips', 'dips-wal', 'sharedstorage', 'sharedstorage-wal', 'shared dictionary', 'lockfile']);
  component('roaming-AionUi', aionui, aionui, (r) => {
    const top = lower(r.split('\\')[0]);
    if (!r.includes('\\') && skipTop.has(top)) return true;
    if (lower(r) === 'network\\cookies' || lower(r) === 'network\\cookies-journal') return true;   // always locked while AionDX runs; the web UI signs in again
    if (top === 'aionui' && lower(r) === 'aionui\\session-skills') return true;      // links rebuilt for each session
    if (top === 'aionui' && r.includes('\\')) {
      const leaf = lower(r.split('\\').pop()), depth = r.split('\\').length;
      if (depth === 2 && /(\.bak|\.bak-.*|-shm|-wal|\.lock|\.pre-.*\.bak|\.env-hardwire\.bak)$/.test(leaf)) return true;
      if (depth === 2 && leaf === 'aionui-backend.db') return true;
    }
    return false;
  });
  component('local-AionDX', path.join(LOCAL, 'AionDX'), path.join(LOCAL, 'AionDX'), (r) => ['logs', 'devin-cli', 'migration'].includes(lower(r.split('\\')[0])) && !r.includes('\\'));
  component('home-aiondx', path.join(HOME, '.aiondx'), path.join(HOME, '.aiondx'));
  component('home-agents', path.join(HOME, '.agents'), path.join(HOME, '.agents'));
  component('npm-global', path.join(APPDATA, 'npm'), path.join(APPDATA, 'npm'));
  component('home-local-bin', path.join(HOME, '.local', 'bin'), path.join(HOME, '.local', 'bin'));   // Claude Code's own install (claude.exe)

  // ---- Claude Code profiles: everything but the transcripts here; the transcripts go in by recency under the budget below
  // Every Claude Code config folder in the user folder (.claude, .claude-<name>) and every folder that is a whole home for one account
  // (.claude-<name>-home: a folder of links to the others, with its own .claude.json), found by what they contain.
  const claudeSkip = new Set(['cache', 'debug', 'downloads', 'telemetry', 'shell-snapshots', 'appdata', 'projects']);
  const homeEntries = fs.readdirSync(HOME, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\.claude(-|$)/i.test(e.name));
  const looksLikeConfig = (d) => ['settings.json', '.claude.json', '.credentials.json', 'projects', 'CLAUDE.md'].some((n) => fs.existsSync(path.join(d, n)));
  const profiles = homeEntries.filter((e) => !/-home$/i.test(e.name) && looksLikeConfig(path.join(HOME, e.name))).map((e) => e.name);
  const linkHomes = homeEntries.filter((e) => /-home$/i.test(e.name)).map((e) => e.name);
  log('Claude Code config folders: ' + profiles.join(', ') + (linkHomes.length ? '; account homes: ' + linkHomes.join(', ') : ''));
  for (const n of profiles) {
    component(n.slice(1), path.join(HOME, n), path.join(HOME, n), (r) => {
      const parts = lower(r).split('\\');
      return (parts.length === 1 && claudeSkip.has(parts[0])) || /\.tmp\.\d+/.test(parts[parts.length - 1]);
    });
  }
  for (const h of linkHomes) {
    // an account home is a folder of links: its own files are copied, its links recorded (never .ssh) so the installer can make them again
    component(h.slice(1), path.join(HOME, h), path.join(HOME, h), null, ['.claude.json', '.gitconfig']);
    try {
      for (const ent of fs.readdirSync(path.join(HOME, h), { withFileTypes: true })) {
        if (!(ent.isDirectory() || ent.isSymbolicLink()) || lower(ent.name) === '.ssh') continue;
        const p = path.join(HOME, h, ent.name), t = junctionTarget(p);
        if (t) manifest.junctions.push({ link: tokenize(p), target: tokenize(t) });
      }
    } catch (e) { /* none */ }
  }
  component('home-files', HOME, HOME, null, ['.claude.json', '.gitconfig']);
  for (const n of ['.gemini', '.windsurf', '.cursor']) component('home' + n, path.join(HOME, n), path.join(HOME, n));

  // ---- the conversation cache: Claude Code's transcripts, newest first, up to the budget
  const units = [];
  const projectDirs = [];
  for (const n of profiles) {
    const pd = path.join(HOME, n, 'projects');
    let st; try { st = fs.lstatSync(pd); } catch (e) { continue; }
    if (isLink(st)) continue;
    projectDirs.push({ profile: n, dir: pd });
  }
  const measure = (p) => { let bytes = 0, mtime = 0, files = 0; (function walk(q) { let st; try { st = fs.lstatSync(q); } catch (e) { return; } if (isLink(st)) return; if (st.isDirectory()) { let es = []; try { es = fs.readdirSync(q); } catch (e) { return; } for (const e of es) walk(path.join(q, e)); } else { bytes += st.size; files++; if (st.mtimeMs > mtime) mtime = st.mtimeMs; } })(p); return { bytes, mtime, files }; };
  const memoryAlways = [];
  for (const { profile, dir } of projectDirs) {
    for (const proj of fs.readdirSync(dir, { withFileTypes: true })) {
      check();
      const pp = path.join(dir, proj.name);
      if (!proj.isDirectory()) { const m = measure(pp); units.push({ profile, rel: proj.name, src: pp, ...m }); continue; }
      for (const e of fs.readdirSync(pp, { withFileTypes: true })) {
        const ep = path.join(pp, e.name);
        if (lower(e.name) === 'memory') { memoryAlways.push({ profile, rel: path.join(proj.name, e.name), src: ep }); continue; }
        units.push({ profile, rel: path.join(proj.name, e.name), src: ep, ...measure(ep) });
      }
    }
  }
  // Left out unless --include-active: a session over 250 MB written to in the last 24 hours
  const giants = INCLUDE_ACTIVE ? [] : units.filter((u) => u.bytes > 250 * 1048576 && Date.now() - u.mtime < 24 * 3600 * 1000);
  manifest.conversationCache.leftOutActiveGiants = giants.map((u) => ({ profile: u.profile, mb: Math.round(u.bytes / 1048576), modified: new Date(u.mtime).toISOString() }));
  giants.forEach((u) => log('  left out (active, ' + Math.round(u.bytes / 1048576) + ' MB): ' + u.profile + ' ' + u.rel.slice(0, 60)));
  for (const g of giants) units.splice(units.indexOf(g), 1);
  units.sort((a, b) => b.mtime - a.mtime);
  let used = 0, kept = 0, keptBytes = 0, dropped = 0, droppedBytes = 0, cut = false, oldestKept = null, newestDropped = null;
  const keep = [];
  for (const u of units) {
    if (!cut && used + u.bytes <= BUDGET) { used += u.bytes; kept++; keptBytes += u.bytes; keep.push(u); oldestKept = u.mtime; }
    else { cut = true; dropped++; droppedBytes += u.bytes; if (!newestDropped) newestDropped = u.mtime; }
  }
  manifest.conversationCache = { ...manifest.conversationCache, budgetBytes: BUDGET, claudeKeptUnits: kept, claudeKeptBytes: keptBytes, claudeDroppedUnits: dropped, claudeDroppedBytes: droppedBytes,
    oldestKept: oldestKept ? new Date(oldestKept).toISOString() : null, newestDropped: newestDropped ? new Date(newestDropped).toISOString() : null, totalIncluded: used };
  log('conversation cache: kept ' + kept + ' transcript units (' + (keptBytes / 1048576).toFixed(0) + ' MB); dropped ' + dropped + ' older units (' + (droppedBytes / 1048576).toFixed(0) + ' MB)');
  log('  oldest kept ' + (oldestKept ? new Date(oldestKept).toISOString().slice(0, 10) : '-') + ', newest dropped ' + (newestDropped ? new Date(newestDropped).toISOString().slice(0, 10) : '-'));
  const byProfile = {};
  for (const u of keep.concat(memoryAlways)) {
    check();
    const dst = path.join(DATA, u.profile.slice(1), 'projects', u.rel);
    const st = { files: 0, bytes: 0 };
    let x; try { x = fs.lstatSync(u.src); } catch (e) { continue; }
    if (x.isDirectory()) copyTree(u.src, dst, null, st); else syncFile(u.src, dst, x, st);
    byProfile[u.profile] = byProfile[u.profile] || { files: 0, bytes: 0 };
    byProfile[u.profile].files += st.files; byProfile[u.profile].bytes += st.bytes;
  }
  for (const [p, v] of Object.entries(byProfile)) { manifest.components.push({ id: p.slice(1) + '/projects', restoreTo: tokenize(path.join(HOME, p, 'projects')), files: v.files, bytes: v.bytes }); log('synced  ' + (p + '/projects').padEnd(22) + String(v.files).padStart(8) + ' files ' + (v.bytes / 1048576).toFixed(0).padStart(7) + ' MB'); }

  // ---- the user's environment
  manifest.userEnv = userEnv();
  log('user environment: ' + Object.keys(manifest.userEnv.vars).length + ' variable(s) (' + Object.keys(manifest.userEnv.vars).join(', ') + '), ' + manifest.userEnv.path.length + ' PATH entries inside the user folder');

  // ---- finish: remove what is no longer exported, write the manifest, clear the marker
  manifest.finishedAt = new Date().toISOString();
  manifest.junctions = manifest.junctions.filter((j, i, a) => a.findIndex((k) => lower(k.link) === lower(j.link)) === i);
  if (!DRY) {
    manifest.removed = sweep(DATA);
    fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
    fs.rmSync(MARK, { force: true });
  } else log('dry run: ' + manifest.components.length + ' parts, ' + (manifest.components.reduce((a, c) => a + c.bytes, 0) / 1073741824).toFixed(1) + ' GB; nothing written');
  log('copied ' + manifest.copied.files + ' files (' + (manifest.copied.bytes / 1048576).toFixed(0) + ' MB), unchanged ' + manifest.unchanged.files + ' (' + (manifest.unchanged.bytes / 1048576).toFixed(0) + ' MB), removed ' + manifest.removed + ' stale; failures ' + manifest.failures.length + '; ' + Math.round((Date.now() - t0) / 1000) + ' s');
  log('DONE');
})().catch((e) => { log('ERROR ' + (e && e.stack || e)); process.exit(2); });
