#!/usr/bin/env node
/**
 * upstream-sync.js: what changed upstream since the installed AionUi, checked against the harvest
 * matrix (tools/upstream-matrix.json, explained in UPSTREAM-MATRIX.md).
 *
 *   node tools\upstream-sync.js           fetch both clones, print the report
 *   node tools\upstream-sync.js --quiet   same, print only when something needs a look
 *   node tools\upstream-sync.js --no-fetch  use the refs already fetched
 *
 * It fetches into `upstream\` and `upstream-aioncore\` (refs only) and never checks out, merges or
 * pulls: both clones stay at the installed tags, because the patches are written against the
 * installed build. It compares the installed tag with origin's branch and with the newest release,
 * lists the matrix rows whose watched paths or content changed, and writes the result to
 * vendor\upstream-sync.json (latest) and vendor\upstream-sync.log (history).
 *
 * Exit codes: 0 nothing new, 3 something needs a look (a newer release or tag, or a watched row
 * touched), 1 error. Hard deadline 180 s. Runs daily from the "AionDX Claude toolchain update"
 * task, through tools\run-toolchain-update-hidden.vbs, with --quiet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'upstream-matrix.json'), 'utf8'));
const RES = 'C:\\Program Files\\AionUi\\resources';
const OUT_JSON = path.join(ROOT, 'vendor', 'upstream-sync.json');
const OUT_LOG = path.join(ROOT, 'vendor', 'upstream-sync.log');
const args = new Set(process.argv.slice(2));
const QUIET = args.has('--quiet');

setTimeout(() => { console.error('upstream-sync: deadline of 180 s passed, exiting'); process.exit(1); }, 180000).unref();

function git(repoDir, argv, timeout = 30000) {
  return execFileSync('git', argv, { cwd: repoDir, encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(repoDir, argv, timeout) { try { return git(repoDir, argv, timeout); } catch { return null; } }
const lines = (s) => (s ? s.split(/\r?\n/).filter(Boolean) : []);

function installedVersions() {
  let app = null;
  const pkg = path.join(ROOT, 'vendor', 'extracted', 'package.json');
  try { app = 'v' + JSON.parse(fs.readFileSync(pkg, 'utf8')).version; } catch { app = null; }
  let core = null;
  try { core = JSON.parse(fs.readFileSync(path.join(RES, 'bundled-aioncore', 'win32-x64', 'manifest.json'), 'utf8')).version; } catch { core = null; }
  return { frontend: app, backend: core };
}

function latestRelease(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AionDX-upstream-sync', Accept: 'application/vnd.github+json' }, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 ? { tag: j.tag_name, published: j.published_at, prerelease: !!j.prerelease } : { error: 'HTTP ' + res.statusCode });
        } catch (e) { resolve({ error: 'unreadable reply' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timed out' }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

function vparts(tag) { return String(tag || '').replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x)); }
function newer(a, b) {
  const x = vparts(a), y = vparts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return false;
    if (y[i] === undefined) return true;
    if (typeof x[i] === typeof y[i]) return x[i] > y[i];
    return typeof x[i] === 'number';
  }
  return false;
}

async function checkRepo(key, spec, installedTag) {
  const dir = path.join(ROOT, spec.dir);
  const r = { repo: key, dir: spec.dir, installed: installedTag, notes: [] };
  if (!args.has('--no-fetch')) {
    try { git(dir, ['fetch', '--tags', '--prune', '--quiet', 'origin'], 90000); r.fetched = true; }
    catch (e) { r.fetched = false; r.notes.push('fetch failed: ' + String(e.message).split('\n')[0]); }
  }
  r.checkout = tryGit(dir, ['describe', '--tags', '--exact-match', 'HEAD']) || '(not on a tag)';
  const tags = lines(tryGit(dir, ['tag', '--list', 'v*', '--sort=-v:refname']));
  r.newestTag = tags[0] || null;
  r.newerTags = installedTag ? tags.filter((t) => newer(t, installedTag)) : [];
  const branch = 'origin/' + spec.branch;
  const base = installedTag && tryGit(dir, ['rev-parse', '--verify', '--quiet', installedTag + '^{commit}']) ? installedTag : null;
  if (!base) { r.notes.push('installed tag ' + installedTag + ' not found in the clone'); r.ahead = null; r.changed = []; }
  else {
    r.ahead = Number(tryGit(dir, ['rev-list', '--count', base + '..' + branch]) || 0);
    r.changed = lines(tryGit(dir, ['diff', '--name-only', base, branch]));
    r.log = lines(tryGit(dir, ['log', '--format=%h %ad %s', '--date=short', '-n', '25', base + '..' + branch]));
  }
  if (r.checkout !== installedTag && installedTag) r.notes.push('clone is checked out at ' + r.checkout + ', not the installed ' + installedTag);
  r.release = await latestRelease(spec.releasesApi);
  if (r.release.tag && installedTag && newer(r.release.tag, installedTag)) r.newerRelease = r.release.tag;
  // Matrix rows touched between the installed tag and origin's branch.
  r.touched = [];
  if (base) {
    for (const row of MATRIX.rows.filter((x) => x.repo === key && x.watch)) {
      const hits = new Set();
      for (const p of row.watch.paths || []) for (const f of r.changed) if (f === p || f.startsWith(p)) hits.add(f);
      for (const rx of row.watch.content || []) for (const f of lines(tryGit(dir, ['diff', '--name-only', '-G', rx, base, branch]))) hits.add(f);
      if (hits.size) r.touched.push({ id: row.id, area: row.area, decision: row.decision, patches: row.patches, files: [...hits].slice(0, 12) });
    }
  }
  return r;
}

(async () => {
  const installed = installedVersions();
  const results = [];
  for (const [key, spec] of Object.entries(MATRIX.repos)) results.push(await checkRepo(key, spec, installed[key]));
  const attention = results.some((r) => r.newerTags.length || r.newerRelease || r.touched.length);
  const at = new Date().toISOString();
  const out = [];
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const local = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  out.push('upstream-sync ' + local + (attention ? '  NEEDS A LOOK' : '  nothing new'));
  for (const r of results) {
    out.push('');
    out.push(r.repo + ' (' + r.dir + '): installed ' + r.installed + ', clone at ' + r.checkout + ', newest tag ' + r.newestTag +
      ', latest release ' + (r.release.tag || 'unknown: ' + r.release.error) + (r.release.published ? ' (' + r.release.published.slice(0, 10) + ')' : ''));
    out.push('  ' + (r.ahead === null ? 'commits ahead: unknown' : r.ahead + ' commit(s) on origin since ' + r.installed) +
      (r.newerTags.length ? '; newer tags: ' + r.newerTags.join(', ') : '') + (r.newerRelease ? '; NEWER RELEASE ' + r.newerRelease : ''));
    for (const n of r.notes) out.push('  note: ' + n);
    for (const t of r.touched) out.push('  matrix ' + t.id + ' [' + t.decision + (t.patches.length ? ', patch ' + t.patches.join('+') : '') + '] ' + t.area + ': ' + t.files.join(', '));
    for (const l of (r.log || []).slice(0, 8)) out.push('    ' + l);
  }
  const text = out.join('\n');
  try {
    fs.writeFileSync(OUT_JSON, JSON.stringify({ at, attention, installed, results }, null, 1));
    fs.appendFileSync(OUT_LOG, text + '\n\n');
  } catch (e) { console.error('upstream-sync: could not write the report: ' + e.message); }
  if (!QUIET || attention) console.log(text);
  process.exit(attention ? 3 : 0);
})().catch((e) => { console.error('upstream-sync: ' + (e && e.stack || e)); process.exit(1); });
