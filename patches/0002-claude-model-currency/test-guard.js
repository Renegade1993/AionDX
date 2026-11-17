'use strict';
// test-guard.js - the launcher starts a chat in a mode that asks before acting through aiondx-guard.exe (Windows' RedirectionGuard on), and
// a yolo chat (bypassPermissions, or --dangerously-skip-permissions) without it (November 16th, 2026). A stand-in Claude (a hard link to
// node named claude.exe) reports whether the guard started it (AIONDX_GUARDED=1). The helper is compiled from aiondx-guard.cs.
//   node patches\0002-claude-model-currency\test-guard.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-guard-test-'));
try {
  const cat = path.join(root, 'router');
  fs.mkdirSync(cat);
  for (const f of ['claude-account-router.js', 'claude-stream-proxy.js']) fs.copyFileSync(path.join(__dirname, f), path.join(cat, f));
  const claude = path.join(cat, 'claude.exe');
  try { fs.linkSync(process.execPath, claude); } catch (e) { fs.copyFileSync(process.execPath, claude); }
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const c = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + path.join(cat, 'aiondx-guard.exe'), path.join(__dirname, 'aiondx-guard.cs')], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  check('the helper compiles', c.status === 0, c.stdout);
  const data = path.join(root, 'AionDX');
  fs.mkdirSync(path.join(data, 'aionui'), { recursive: true });
  const dbFile = path.join(data, 'aionui', 'aiondx-backend.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT, user_id TEXT); CREATE TABLE agent_metadata (agent_id TEXT, env TEXT, user_id TEXT, backend TEXT); CREATE TABLE teams (id TEXT PRIMARY KEY, agents TEXT)');
  db.prepare('INSERT INTO conversations VALUES (?,?,?)').run('solo1', JSON.stringify({ backend: 'claude', agent_id: 'ag1' }), 'u1');
  db.close();
  fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [], projects: {}, bindings: {}, accountDocs: { personal: 'off' } }));
  const fake = path.join(cat, 'fake-claude.js');
  // the stand-in reports whether it was guarded, its mode, and each skill it can read in the folders Claude would (every --add-dir's
  // .claude\skills): name -> the first line of its SKILL.md, or ERR
  fs.writeFileSync(fake, [
    "const fs = require('fs'), path = require('path'); const a = process.argv; const skills = {}; const dirs = [];",
    "for (let i = 0; i < a.length - 1; i++) if (a[i] === '--add-dir') dirs.push(a[i + 1]);",
    "for (const d of dirs) { const s = path.join(d, '.claude', 'skills'); let n = []; try { n = fs.readdirSync(s); } catch (e) { continue; }",
    "  for (const k of n) { let v; try { v = fs.readFileSync(path.join(s, k, 'SKILL.md'), 'utf8').split('\\n')[0]; } catch (e) { v = 'ERR'; } if (!skills[k] || skills[k] === 'ERR') skills[k] = v; } }",
    "process.stdout.write(JSON.stringify({ guard: process.env.AIONDX_GUARDED || null, mode: a[a.indexOf('--permission-mode') + 1] || null, dirs, skills }));",
  ].join('\n'));
  const profile = path.join(root, 'profile');
  const cfgDir = path.join(profile, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cat, 'claude-account-router.config.json'), JSON.stringify({ claudeExe: claude, streamProxy: false, modelCatalog: false,
    database: dbFile, usageMeter: false, defaultAccount: 'ag1', accounts: { ag1: { label: 'personal', configDir: cfgDir } } }));
  const run = (extra, env) => {
    const r = spawnSync(process.execPath, [path.join(cat, 'claude-account-router.js'), fake, '--input-format', 'stream-json', '--output-format', 'stream-json', '-p'].concat(extra),
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
        env: Object.assign({}, process.env, { AIONDX_CONVERSATION_ID: 'solo1', AIONDX_DATA_DIR: data, CLAUDE_CODE_OAUTH_TOKEN: '', USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: cfgDir, AIONDX_GUARD: '' }, env || {}) });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (e) { return { raw: (r.stdout || '') + (r.stderr || '') }; }
  };
  let o = run(['--permission-mode', 'default']);
  check('a chat that asks before acting (default) starts through the guard', o.guard === '1' && o.mode === 'default', JSON.stringify(o));
  o = run(['--permission-mode', 'acceptEdits']);
  check('acceptEdits (asks before commands): the guard too', o.guard === '1', JSON.stringify(o));
  o = run(['--permission-mode', 'bypassPermissions']);
  check('a yolo chat (bypassPermissions) starts without it', o.guard === null && o.mode === 'bypassPermissions', JSON.stringify(o));
  o = run(['--permission-mode', 'default', '--dangerously-skip-permissions']);
  check('--dangerously-skip-permissions: without it', o.guard === null, JSON.stringify(o));
  o = run(['--permission-mode', 'default'], { AIONDX_GUARD: 'off' });
  check('AIONDX_GUARD=off: without it', o.guard === null, JSON.stringify(o));
  {
    // what a guarded agent can read of a chat's skill view (core-0022): a junction to a skill is refused, the same skill as real files
    // (hard links, as the view now holds them) is read. A test run itself under the guard sees the junction refused too.
    const src = path.join(root, 'skills-src', 'cron'), view = path.join(root, 'view');
    fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(path.join(view, 'files', 'cron'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), 'SKILLTOKEN');
    fs.symlinkSync(src, path.join(view, 'junction'), 'junction');
    fs.linkSync(path.join(src, 'SKILL.md'), path.join(view, 'files', 'cron', 'SKILL.md'));
    const read = (p) => spawnSync(path.join(cat, 'aiondx-guard.exe'), [process.execPath, '-e', 'try{process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))}catch(e){process.stdout.write("ERR "+e.code)}', p], { windowsHide: true, encoding: 'utf8', timeout: 30000 }).stdout;
    const viaJunction = read(path.join(view, 'junction', 'SKILL.md'));
    check('under the guard, a skill reached through a junction cannot be read', viaJunction !== 'SKILLTOKEN', viaJunction);
    const viaFiles = read(path.join(view, 'files', 'cron', 'SKILL.md'));
    check('under the guard, the same skill as files in the view is read', viaFiles === 'SKILLTOKEN', viaFiles);
  }
  {
    // a skill linked into a shared skill root by a junction (DX Skills' link, the library updater): a guarded chat gets it as files
    const lib = path.join(root, 'library', 'pdf'), shared = path.join(root, 'Shared'), sk = path.join(shared, '.claude', 'skills');
    fs.mkdirSync(lib, { recursive: true }); fs.mkdirSync(path.join(sk, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'SKILL.md'), 'LIBTOKEN\nbody');
    fs.writeFileSync(path.join(sk, 'plain', 'SKILL.md'), 'PLAINTOKEN');
    fs.symlinkSync(lib, path.join(sk, 'pdf'), 'junction');
    fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [shared], projects: {}, bindings: {}, accountDocs: { personal: 'off' } }));
    o = run(['--permission-mode', 'default']);
    const mirror = path.join(data, 'guard-skills', 'solo1');
    check('a guarded chat reads a skill linked by a junction, given to it as files', o.guard === '1' && o.skills && o.skills.pdf === 'LIBTOKEN' && o.skills.plain === 'PLAINTOKEN' && o.dirs.indexOf(mirror) >= 0, JSON.stringify(o));
    check('the given copy is not a link, and the library\'s own file is the same file (a hard link)', !fs.lstatSync(path.join(mirror, '.claude', 'skills', 'pdf')).isSymbolicLink() &&
      fs.statSync(path.join(mirror, '.claude', 'skills', 'pdf', 'SKILL.md')).ino === fs.statSync(path.join(lib, 'SKILL.md')).ino, '');
    check('a skill that is not a link is not copied', !fs.existsSync(path.join(mirror, '.claude', 'skills', 'plain')));
    o = run(['--permission-mode', 'bypassPermissions']);
    check('a yolo chat gets no extra folder (it reads the link itself)', o.guard === null && o.dirs.indexOf(mirror) < 0, JSON.stringify(o));
    fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [], projects: {}, bindings: {}, accountDocs: { personal: 'off' } }));
  }
  fs.rmSync(path.join(cat, 'aiondx-guard.exe'));
  o = run(['--permission-mode', 'default']);
  check('no helper beside the launcher: the chat starts as before', o.guard === null && o.mode === 'default', JSON.stringify(o));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* in use */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
