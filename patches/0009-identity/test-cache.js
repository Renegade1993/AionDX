#!/usr/bin/env node
/**
 * test-cache.js - aiondx-cache.js against a throwaway home folder: what it finds, what an age keeps, what a clear removes, and above all what
 * it must never touch (credentials, settings, memory, databases, anything behind a link, files in use).
 *   node patches\0009-identity\test-cache.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-cache-test-'));
const HOME = path.join(root, 'home');
const APPDATA = path.join(root, 'appdata');
const LOCAL = path.join(root, 'local');
process.env.AIONDX_CACHE_HOME = HOME;
process.env.AIONDX_CACHE_APPDATA = APPDATA;
process.env.AIONDX_CACHE_LOCAL = LOCAL;
process.env.AIONDX_CACHE_BUSY_MS = '60000';
const cache = require('./aiondx-cache.js');

const DAY = 86400000;
const UUID = '0f8fad5b-d9cb-469f-a165-8a9d1c4c1c11';
function put(rel, ageDays, size) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(size || 100, 1));
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(f, t, t);
  return f;
}
const has = (rel) => fs.existsSync(path.join(root, rel));

// A Claude Code profile (main), a second one reached by two paths (a folder and a home folder holding a link to it), Devin, AionUi.
put('home/.claude/.credentials.json', 400); put('home/.claude/.claude.json', 400); put('home/.claude/settings.json', 400); put('home/.claude/CLAUDE.md', 400);
put('home/.claude/projects/proj1/old-session.jsonl', 40); put('home/.claude/projects/proj1/mid-session.jsonl', 10); put('home/.claude/projects/proj1/new-session.jsonl', 0);
put('home/.claude/projects/proj1/' + UUID + '/subagents/agent-x.jsonl', 40);
put('home/.claude/projects/proj1/memory/MEMORY.md', 400); put('home/.claude/projects/proj1/notes.txt', 400);
put('home/.claude/file-history/s1/v1', 40); put('home/.claude/todos/t.json', 40);
put('home/.claude/cache/old.bin', 40, 1000); put('home/.claude/cache/new.bin', 0, 1000); put('home/.claude/shell-snapshots/snap.sh', 3, 500);
put('home/.claude/skills/keep/SKILL.md', 400); put('home/.claude/agents/keep.md', 400); put('home/.claude/plugins/cache/p.js', 400);
put('home/.claude-second/projects/projB/s.jsonl', 40); put('home/.claude-second/.credentials.json', 400); put('home/.claude-second/cache/c.bin', 40);
fs.mkdirSync(path.join(HOME, '.claude-second-home'), { recursive: true });
fs.symlinkSync(path.join(HOME, '.claude-second'), path.join(HOME, '.claude-second-home', '.claude'), 'junction');
// A link inside a cache folder pointing outside it: never followed, never removed.
put('outside/precious.txt', 400);
fs.symlinkSync(path.join(root, 'outside'), path.join(HOME, '.claude', 'cache', 'linked'), 'junction');
put('appdata/Devin/Cache/blob', 40, 2000); put('appdata/Devin/CachedData/x', 40); put('appdata/Devin/Crashpad/reports/r.dmp', 40, 3000); put('appdata/Devin/Crashpad/settings.dat', 40);
put('appdata/Devin/logs/old.log', 40); put('appdata/Devin/logs/new.log', 0); put('appdata/Devin/cli/logs/c.log', 40); put('appdata/Devin/cli/sessions.db', 400, 5000);
put('appdata/Devin/cli/summaries/s.md', 400); put('appdata/Devin/User/History/h/entry', 40); put('appdata/Devin/User/settings.json', 400); put('appdata/Devin/cli/bin/devin.exe', 400);
put('appdata/AionUi/Cache/a', 40); put('appdata/AionUi/logs/2026-01-01.log', 40); put('appdata/AionUi/aionui.db', 400); put('local/AionDX/logs/old.log', 40); put('local/AionDX/bin/aiondx.exe', 400);

// ---- discovery
const ps = cache.profiles();
const ids = ps.map((p) => p.id);
check('finds the Claude Code profiles, Devin and AionDX', ids.includes('claude:main') && ids.includes('claude:second') && ids.includes('devin') && ids.includes('aiondx'), JSON.stringify(ids));
check('a profile reached by two paths (a link) is listed once', ids.filter((i) => i.startsWith('claude:')).length === 2, JSON.stringify(ids));
check('a profile shows its folder with the home folder shortened', ps.find((p) => p.id === 'claude:main').label === 'Claude Code (main)');

// ---- scan: nothing is deleted
const s7 = cache.scan('claude:main', 7);
check('scan: history older than a week is the old session, its sub-session, file history and to-dos', s7.groups.history.count === 5 && s7.groups.history.targets.length >= 3, JSON.stringify(s7.groups.history));
check('scan: cache older than a week is the one old file (the link and the new file are not counted)', s7.groups.cache.count === 1 && s7.groups.cache.bytes === 1000, JSON.stringify(s7.groups.cache));
check('scan: history with no age is refused', !!cache.scan('claude:main', 0).groups.history.error);
check('scan changed nothing', has('home/.claude/projects/proj1/old-session.jsonl') && has('home/.claude/cache/old.bin'));
const s30 = cache.scan('claude:main', 30);
check('a longer age keeps the middle-aged session', s30.groups.history.count === 4 && !!s7.groups.history.count, JSON.stringify([s7.groups.history.count, s30.groups.history.count]));

// ---- clear history by age
let r = cache.clear('claude:main', 'history', 30);
check('clearing history older than 30 days removes the old transcript, its sub-session folder, file history and to-dos', r.ok && r.deleted === 4 &&
  !has('home/.claude/projects/proj1/old-session.jsonl') && !has('home/.claude/projects/proj1/' + UUID) && !has('home/.claude/file-history/s1') && !has('home/.claude/todos/t.json'), JSON.stringify(r));
check('and keeps the 10-day-old and brand-new transcripts', has('home/.claude/projects/proj1/mid-session.jsonl') && has('home/.claude/projects/proj1/new-session.jsonl'));
check('and never memory, other files in a project, or the project folder', has('home/.claude/projects/proj1/memory/MEMORY.md') && has('home/.claude/projects/proj1/notes.txt'));
check('and never credentials, settings, CLAUDE.md, skills, agents or plugins', ['.credentials.json', '.claude.json', 'settings.json', 'CLAUDE.md', 'skills/keep/SKILL.md', 'agents/keep.md', 'plugins/cache/p.js'].every((n) => has('home/.claude/' + n)));
check('the group folders themselves stay', has('home/.claude/projects') && has('home/.claude/todos'));
r = cache.clear('claude:main', 'history', 0);
check('clearing history with no age is refused and removes nothing', !r.ok && /1 day/.test(r.error) && has('home/.claude/projects/proj1/mid-session.jsonl'));

// ---- clear cache
r = cache.clear('claude:main', 'cache', 7);
check('clearing caches older than a week removes the old cache file and the 3-day snapshot stays', r.ok && !has('home/.claude/cache/old.bin') && has('home/.claude/shell-snapshots/snap.sh'), JSON.stringify(r));
check('and keeps the new cache file', has('home/.claude/cache/new.bin'));
check('and never follows a link out of the cache folder (the file behind it survives)', has('outside/precious.txt'));
r = cache.clear('claude:main', 'cache', 0);
check('clearing all of the cache leaves a file in use (touched in the last minute)', has('home/.claude/cache/new.bin') && !has('home/.claude/shell-snapshots/snap.sh') && r.ok, JSON.stringify(r));
check('and still never the link or what is behind it', has('outside/precious.txt') && fs.existsSync(path.join(HOME, '.claude', 'cache', 'linked')));

// ---- the second Claude account, reached through the home-folder link: one profile, one set of files
r = cache.clear('claude:second', 'history', 7);
check('the second account clears through its one profile', r.ok && r.deleted === 1 && !has('home/.claude-second/projects/projB/s.jsonl') && has('home/.claude-second/.credentials.json'), JSON.stringify(r));

// ---- Devin
const d = cache.scan('devin', 7);
check('Devin: caches are the browser caches and crash reports; history is logs and local edit history', d.groups.cache.count === 3 && d.groups.history.count === 3, JSON.stringify(d.groups));
cache.clear('devin', 'cache', 0); cache.clear('devin', 'history', 7);
check('Devin: caches, crash reports, old logs and edit history go', !has('appdata/Devin/Cache/blob') && !has('appdata/Devin/CachedData/x') && !has('appdata/Devin/Crashpad/reports/r.dmp') && !has('appdata/Devin/logs/old.log') && !has('appdata/Devin/cli/logs/c.log') && !has('appdata/Devin/User/History/h/entry'));
check('Devin: new logs, the session database, summaries, settings, crash settings and the program stay', has('appdata/Devin/logs/new.log') && has('appdata/Devin/cli/sessions.db') && has('appdata/Devin/cli/summaries/s.md') && has('appdata/Devin/User/settings.json') && has('appdata/Devin/Crashpad/settings.dat') && has('appdata/Devin/cli/bin/devin.exe'));

// ---- AionDX and AionUi
cache.clear('aiondx', 'cache', 0); cache.clear('aiondx', 'history', 7);
check('AionDX and AionUi: caches and old logs go; the database and programs stay', !has('appdata/AionUi/Cache/a') && !has('appdata/AionUi/logs/2026-01-01.log') && !has('local/AionDX/logs/old.log') && has('appdata/AionUi/aionui.db') && has('local/AionDX/bin/aiondx.exe'));

// ---- the command line: a dry run deletes nothing; --yes does; a log line without names
put('home/.claude/cache/cli.bin', 40, 700);
const run = (...a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'aiondx-cache.js'), ...a], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 60000 }));
let o = run('clear', 'claude:main', '--group', 'cache', '--days', '7');
check('command line: clear without --yes is a dry run', o.dryRun === true && o.scan.count === 1 && has('home/.claude/cache/cli.bin'), JSON.stringify(o));
o = run('clear', 'claude:main', '--group', 'cache', '--days', '7', '--yes');
check('command line: with --yes it removes the file', o.ok && o.deleted === 1 && !has('home/.claude/cache/cli.bin'), JSON.stringify(o));
const log = fs.readFileSync(path.join(LOCAL, 'AionDX', 'logs', 'cache-clear.log'), 'utf8');
check('every clear is logged with counts and no file names', /profile=claude:main group=cache days=7 deleted=1/.test(log) && !/cli\.bin|session|credentials/.test(log), log.slice(-200));
let bad = null;
try { execFileSync(process.execPath, [path.join(__dirname, 'aiondx-cache.js'), 'scan', 'nope'], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch (e) { bad = e; }
check('an unknown profile is an error, not a guess', bad && /no such profile/.test(String(bad.stdout)), bad && String(bad.stdout));

fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
