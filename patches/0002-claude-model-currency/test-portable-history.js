'use strict';
// test-portable-history.js - the Claude launcher keeps each chat's Claude history on an AionDX drive (R-102, 2026-11-12). A made-up data folder
// marked portable, a made-up chats database, and a stand-in Claude (a Node script) that writes a session file where Claude Code would. Nothing of
// this PC's own data is read or written.
//   node patches\0002-claude-model-currency\test-portable-history.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-portable-history-'));
try {
  const cat = path.join(root, 'router');
  fs.mkdirSync(cat);
  for (const f of ['claude-account-router.js', 'claude-stream-proxy.js']) fs.copyFileSync(path.join(__dirname, f), path.join(cat, f));
  const data = path.join(root, 'drive', 'AionDX-Data');
  fs.mkdirSync(path.join(data, 'aionui'), { recursive: true });
  const dbFile = path.join(data, 'aionui', 'aiondx-backend.db');
  const ws = path.join(data, 'aionui', 'conversations', 'chat1');
  fs.mkdirSync(ws, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT, user_id TEXT); CREATE TABLE agent_metadata (agent_id TEXT, env TEXT, user_id TEXT, backend TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?,?)').run('chat1', JSON.stringify({ backend: 'claude', workspace: ws, agent_id: 'ag1' }), 'u1');
  db.close();
  const claudeA = path.join(root, 'pcA', '.claude'), claudeB = path.join(root, 'pcB', '.claude');
  // the stand-in Claude: writes a session file under <config>\projects\<working folder> and appends to it on --resume
  const fake = path.join(cat, 'fake-claude.js');
  fs.writeFileSync(fake, `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const i = a.indexOf('--resume');
const id = i >= 0 ? a[i + 1] : '11111111-2222-3333-4444-555555555555';
const f = path.join(dir, id + '.jsonl');
const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
fs.writeFileSync(f, had + JSON.stringify({ turn: had.split('\\n').filter(Boolean).length + 1, pc: process.env.CLAUDE_CONFIG_DIR }) + '\\n');
process.stdout.write(JSON.stringify({ had: had.split('\\n').filter(Boolean).length }) + '\\n');
`);
  const cfg = (claudeDir) => fs.writeFileSync(path.join(cat, 'claude-account-router.config.json'), JSON.stringify({ claudeExe: process.execPath, streamProxy: false, modelCatalog: false, database: dbFile, usageMeter: false,
    defaultAccount: 'ag1', accounts: { ag1: { label: 'a', configDir: claudeDir } } }));
  const run = (args) => spawnSync(process.execPath, [path.join(cat, 'claude-account-router.js'), fake].concat(args), { cwd: ws, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: Object.assign({}, process.env, { AIONDX_CONVERSATION_ID: 'chat1', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', USERPROFILE: path.join(root, 'profile'), HOME: path.join(root, 'profile'), CLAUDE_CONFIG_DIR: path.join(root, 'profile', '.claude') }) });
  const slug = ws.replace(/[^a-zA-Z0-9]/g, '-');
  const mirror = path.join(data, 'claude-history', 'projects', slug, '11111111-2222-3333-4444-555555555555.jsonl');

  // not portable: nothing is copied to the data folder
  cfg(claudeA);
  let r = run(['-p', 'hi']);
  check('a data folder that is not portable gets no copy of the history', r.status === 0 && !fs.existsSync(path.join(data, 'claude-history')), r.stdout + r.stderr);

  fs.writeFileSync(path.join(data, 'aiondx-portable.json'), JSON.stringify({ v: 1, id: 'x', path: data }));
  r = run(['-p', 'hi']);
  check("on a portable data folder, the session's history is copied to the drive when the chat's process ends", r.status === 0 && fs.existsSync(mirror) &&
    fs.readFileSync(mirror, 'utf8').trim().split('\n').length === 2, r.stdout + r.stderr + (fs.existsSync(mirror) ? fs.readFileSync(mirror, 'utf8') : 'no copy'));

  // the other PC: its own Claude folder has nothing; the resume brings the drive's copy in first, and the new turn goes back to the drive
  cfg(claudeB);
  r = run(['--resume', '11111111-2222-3333-4444-555555555555', '-p', 'again']);
  const seen = (() => { try { return JSON.parse(r.stdout.trim().split('\n').pop()).had; } catch (e) { return -1; } })();
  check('on another PC the chat resumes with its history from the drive (the stand-in saw both earlier turns)', r.status === 0 && seen === 2, r.stdout + r.stderr);
  const lines = fs.readFileSync(mirror, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check("and the other PC's new turn is on the drive afterwards", lines.length === 3 && lines[2].pc === claudeB, JSON.stringify(lines));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
