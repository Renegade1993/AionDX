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
  fs.writeFileSync(fake, "process.stdout.write(JSON.stringify({ guard: process.env.AIONDX_GUARDED || null, mode: process.argv[process.argv.indexOf('--permission-mode') + 1] || null }));");
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
