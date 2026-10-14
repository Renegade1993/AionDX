#!/usr/bin/env node
/**
 * aiondx-cache.js - clear an agent profile's caches, and its old history by age (a request of 2026-10-13).
 *
 *   node aiondx-cache.js profiles                         the profiles found on this PC (Claude Code accounts, Devin, AionDX itself)
 *   node aiondx-cache.js scan  PROFILE [--days N]         what would go, in files and bytes; deletes nothing
 *   node aiondx-cache.js clear PROFILE --group cache|history [--days N] --yes
 *
 * Two groups per profile:
 *   cache    things that rebuild themselves (browser caches, shell snapshots, debug output, crash reports). --days 0 means all of it.
 *   history  things that were made by use: Claude Code's session transcripts, its file history and to-dos, Devin's logs and local
 *            edit history, AionUi's logs. Only files older than --days (at least 1) go. A Claude Code session whose transcript
 *            is deleted can no longer be resumed.
 *
 * Safety: only a fixed list of folders per profile is ever looked at (never credentials, settings, CLAUDE.md, memory, skills, agents,
 * plugins, installs or databases); a link is never followed or removed; a file touched in the last ten minutes is left alone (an agent
 * is using it); the work stops after two minutes. Every clear writes one line (counts, no names) to
 * %LOCALAPPDATA%\AionDX\logs\cache-clear.log. Output is JSON for the app and plain text for a person with --text.
 * Test overrides: AIONDX_CACHE_HOME, AIONDX_CACHE_APPDATA, AIONDX_CACHE_LOCAL, AIONDX_CACHE_BUSY_MS.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 86400000;
const DEADLINE_MS = 120000;
const home = () => process.env.AIONDX_CACHE_HOME || os.homedir();
const appdata = () => process.env.AIONDX_CACHE_APPDATA || process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
const localdata = () => process.env.AIONDX_CACHE_LOCAL || process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
const busyMs = () => (process.env.AIONDX_CACHE_BUSY_MS !== undefined ? Number(process.env.AIONDX_CACHE_BUSY_MS) : 10 * 60 * 1000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDir(p) { try { return fs.lstatSync(p).isDirectory(); } catch (e) { return false; } }
function isDirFollow(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function exists(p) { try { fs.lstatSync(p); return true; } catch (e) { return false; } }
function real(p) { try { return fs.realpathSync(p).toLowerCase(); } catch (e) { return p.toLowerCase(); } }
function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; } }

/** The profiles on this PC. Each: { id, kind, label, dir, groups: { cache: [target], history: [target] } }. A target is { label, root, type }. */
function profiles() {
  const out = [];
  const seen = new Set();
  const h = home();
  const candidates = [];
  for (const e of entries(h)) {
    if (!/^\.claude(-|$)/i.test(e.name) || !(e.isDirectory() || e.isSymbolicLink())) continue;
    // A folder that is a whole home for one account (.claude-x-home\.claude) is that account's config folder inside it, not the home itself.
    if (isDirFollow(path.join(h, e.name, '.claude'))) candidates.push({ dir: path.join(h, e.name, '.claude'), name: e.name });
    else candidates.push({ dir: path.join(h, e.name), name: e.name });
  }
  for (const c of candidates) {
    if (!isDirFollow(c.dir)) continue;
    const looksLikeConfig = ['projects', '.claude.json', '.credentials.json', 'settings.json'].some((n) => exists(path.join(c.dir, n)));
    if (!looksLikeConfig) continue;
    const key = real(c.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    const suffix = c.name.replace(/^\.claude-?/i, '').replace(/-home$/i, '');
    const prof = claudeProfile(c.dir, suffix, 0);
    for (let n = 2; out.some((p) => p.id === prof.id); n++) prof.id = prof.id.replace(/-\d+$/, '') + '-' + n;   // two folders can share a name
    out.push(prof);
  }
  const devin = path.join(appdata(), 'Devin');
  if (isDir(devin)) out.push(devinProfile(devin));
  const ui = path.join(appdata(), 'AionUi');
  if (isDir(ui) || isDir(path.join(localdata(), 'AionDX'))) out.push(aiondxProfile(ui));
  return out;
}

function claudeProfile(dir, suffix, index) {
  const t = (rel, type, label) => ({ label: label || rel, root: path.join(dir, rel), type: type || 'tree' });
  return {
    id: 'claude:' + (suffix || 'main').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    kind: 'claude',
    label: 'Claude Code' + (suffix ? ' (' + suffix + ')' : ' (main)'),
    dir,
    groups: {
      cache: ['cache', 'shell-snapshots', 'debug', 'downloads', 'paste-cache', 'image-cache', 'statsig', 'telemetry'].map((n) => t(n)),
      history: [t('projects', 'projects', 'session transcripts'), t('file-history', 'tree', 'file history'), t('todos', 'tree', 'to-do lists'), t('session-env', 'tree', 'session environments')]
    }
  };
}
function devinProfile(dir) {
  const t = (rel, label) => ({ label: label || rel, root: path.join(dir, rel), type: 'tree' });
  return {
    id: 'devin', kind: 'devin', label: 'Devin', dir,
    groups: {
      cache: ['Cache', 'Code Cache', 'CachedData', 'CachedConfigurations', 'CachedExtensionVSIXs', 'CachedProfilesData', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
        path.join('Service Worker', 'CacheStorage'), path.join('Service Worker', 'ScriptCache'), 'Shared Dictionary', path.join('Crashpad', 'reports'), path.join('Crashpad', 'completed')].map((n) => t(n)),
      history: [t('logs', 'logs'), t(path.join('cli', 'logs'), 'CLI logs'), t(path.join('User', 'History'), 'local edit history')]
    }
  };
}
function aiondxProfile(uiDir) {
  const t = (root, label) => ({ label, root, type: 'tree' });
  return {
    id: 'aiondx', kind: 'aiondx', label: 'AionDX and AionUi', dir: uiDir,
    groups: {
      cache: ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', path.join('Service Worker', 'CacheStorage')].map((n) => t(path.join(uiDir, n), n)),
      history: [t(path.join(uiDir, 'logs'), 'AionUi logs'), t(path.join(localdata(), 'AionDX', 'logs'), 'AionDX logs')]
    }
  };
}

/** Every file a target covers: [{ p, size, mtime, root }]. Never follows or lists a link. */
function* filesOf(target, deadline) {
  const root = target.root;
  if (!isDir(root)) return;
  if (target.type === 'projects') {
    for (const p of entries(root)) {
      if (Date.now() > deadline) return;
      if (!p.isDirectory()) continue;
      const pdir = path.join(root, p.name);
      for (const e of entries(pdir)) {
        const f = path.join(pdir, e.name);
        if (e.isFile() && /\.jsonl$/i.test(e.name)) { const st = stat(f); if (st) yield { p: f, size: st.size, mtime: st.mtimeMs, root }; }
        else if (e.isDirectory() && UUID.test(e.name)) yield* walk(f, root, deadline);   // never "memory" or anything else
      }
    }
    return;
  }
  yield* walk(root, root, deadline);
}
function stat(f) { try { const s = fs.lstatSync(f); return s.isFile() ? s : null; } catch (e) { return null; } }
function* walk(dir, root, deadline) {
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return;
    const d = stack.pop();
    for (const e of entries(d)) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) { const st = stat(f); if (st) yield { p: f, size: st.size, mtime: st.mtimeMs, root }; }
    }
  }
}

function cutoffFor(group, days) {
  const d = Number(days);
  if (group === 'history') {
    if (!(d >= 1)) return { error: 'History is cleared by age: choose 1 day or more.' };
  } else if (!(d >= 0)) return { error: 'Choose an age (0 means everything).' };
  return { cutoff: d > 0 ? Date.now() - d * DAY : Infinity };
}

/** What a group holds, split by target; only files older than the cutoff and not busy. */
function plan(profile, group, days) {
  const c = cutoffFor(group, days);
  if (c.error) return { error: c.error };
  const deadline = Date.now() + DEADLINE_MS;
  const busyAfter = Date.now() - busyMs();
  const targets = [];
  const files = [];
  let partial = false;
  for (const target of profile.groups[group] || []) {
    let n = 0, bytes = 0;
    for (const f of filesOf(target, deadline)) {
      if (f.mtime >= c.cutoff || f.mtime >= busyAfter) continue;
      files.push(f); n++; bytes += f.size;
    }
    if (Date.now() > deadline) partial = true;
    if (n) targets.push({ label: target.label, files: n, bytes });
  }
  return { files, targets, count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), partial };
}

function find(id) {
  const p = profiles().find((x) => x.id === id);
  if (!p) throw new Error('no such profile: ' + id);
  return p;
}
function view(p) { return { id: p.id, kind: p.kind, label: p.label, dir: p.dir.replace(home(), '~') }; }

function scan(id, days) {
  const p = find(id);
  const out = { profile: view(p), days: Number(days) || 0, groups: {} };
  for (const g of ['cache', 'history']) {
    const r = plan(p, g, days);
    out.groups[g] = r.error ? { error: r.error } : { count: r.count, bytes: r.bytes, targets: r.targets, partial: r.partial };
  }
  return out;
}

function clear(id, group, days) {
  if (group !== 'cache' && group !== 'history') throw new Error('group must be cache or history');
  const p = find(id);
  const r = plan(p, group, days);
  if (r.error) return { ok: false, error: r.error };
  const roots = (p.groups[group] || []).map((t) => path.resolve(t.root).toLowerCase() + path.sep);
  let deleted = 0, bytes = 0, skipped = 0;
  const dirs = new Set();
  const deadline = Date.now() + DEADLINE_MS;
  for (const f of r.files) {
    if (Date.now() > deadline) { skipped += r.files.length - deleted - skipped; break; }
    const abs = path.resolve(f.p).toLowerCase();
    if (!roots.some((x) => abs.startsWith(x))) { skipped++; continue; }   // never outside the group's own folders
    try {
      if (!fs.lstatSync(f.p).isFile()) { skipped++; continue; }
      fs.unlinkSync(f.p);
      deleted++; bytes += f.size;
      dirs.add(path.dirname(f.p));
    } catch (e) { skipped++; }
  }
  // Folders the clear emptied (never a target's own folder).
  const rootSet = new Set((p.groups[group] || []).map((t) => path.resolve(t.root).toLowerCase()));
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    let cur = d;
    while (cur && !rootSet.has(path.resolve(cur).toLowerCase()) && roots.some((x) => path.resolve(cur).toLowerCase().startsWith(x))) {
      try { fs.rmdirSync(cur); } catch (e) { break; }
      cur = path.dirname(cur);
    }
  }
  try {
    const log = path.join(localdata(), 'AionDX', 'logs', 'cache-clear.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, new Date().toISOString() + ' profile=' + p.id + ' group=' + group + ' days=' + (Number(days) || 0) + ' deleted=' + deleted + ' bytes=' + bytes + ' skipped=' + skipped + '\n');
  } catch (e) { /* the clear stands */ }
  return { ok: true, deleted, bytes, skipped, partial: r.partial };
}

function mb(n) { return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB'; }
function main(argv) {
  const [cmd, id] = argv;
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const text = argv.includes('--text');
  const show = (obj, plain) => console.log(text ? plain : JSON.stringify(obj));
  if (cmd === 'profiles') { const l = profiles().map(view); return show(l, l.map((p) => p.id + '  ' + p.label + '  ' + p.dir).join('\n')); }
  if (cmd === 'scan' && id) {
    const r = scan(id, opt('--days'));
    return show(r, [r.profile.label + ' (' + r.profile.dir + ')'].concat(['cache', 'history'].map((g) => { const x = r.groups[g]; return g + ': ' + (x.error || (x.count + ' files, ' + mb(x.bytes))); })).join('\n'));
  }
  if (cmd === 'clear' && id) {
    const group = opt('--group');
    if (!argv.includes('--yes')) {
      const r = scan(id, opt('--days'));
      const x = r.groups[group] || {};
      return show({ dryRun: true, group, scan: x }, 'Would remove ' + (x.error || (x.count + ' files, ' + mb(x.bytes))) + ' from ' + r.profile.label + ' (' + group + '). Add --yes to do it.');
    }
    const r = clear(id, group, opt('--days'));
    return show(r, r.ok ? 'Removed ' + r.deleted + ' files, ' + mb(r.bytes) + (r.skipped ? ' (' + r.skipped + ' left: in use or newer)' : '') : r.error);
  }
  console.error('usage: node aiondx-cache.js profiles | scan PROFILE [--days N] | clear PROFILE --group cache|history [--days N] --yes   (--text for plain output)');
  process.exit(2);
}

module.exports = { profiles, scan, clear, plan, DAY };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); }
}
