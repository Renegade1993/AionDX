'use strict';
// test-launch-record.js - the launcher writes <data folder>\aiondx-launches\<conversation id>.json at each agent launch (R-112, the chat's
// notification bell): when it started, its own pid (it lives as long as the agent), the project and account, whether Docs was on, and
// whether the sign-in was full. A made-up data folder and a stand-in Claude named claude.exe (a hard link to node) so the launcher treats
// it as Claude Code; nothing real is read or written.
//   node patches\0002-claude-model-currency\test-launch-record.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-launch-record-'));
try {
  const cat = path.join(root, 'router');
  fs.mkdirSync(cat);
  for (const f of ['claude-account-router.js', 'claude-stream-proxy.js']) fs.copyFileSync(path.join(__dirname, f), path.join(cat, f));
  const claude = path.join(cat, 'claude.exe');
  try { fs.linkSync(process.execPath, claude); } catch (e) { fs.copyFileSync(process.execPath, claude); }
  const data = path.join(root, 'AionDX');
  fs.mkdirSync(path.join(data, 'aionui'), { recursive: true });
  const dbFile = path.join(data, 'aionui', 'aiondx-backend.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT, user_id TEXT); CREATE TABLE agent_metadata (agent_id TEXT, env TEXT, user_id TEXT, backend TEXT); CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?,?)').run('solo1', JSON.stringify({ backend: 'claude', agent_id: 'ag1' }), 'u1');
  db.close();
  const writeReg = (docs) => fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [], projects: {}, bindings: {}, accountDocs: { personal: docs } }));
  const fake = path.join(cat, 'fake-claude.js');
  fs.writeFileSync(fake, "process.stdout.write(JSON.stringify({ pid: process.ppid }));");
  const profile = path.join(root, 'profile');
  const cfgDir = path.join(profile, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cat, 'claude-account-router.config.json'), JSON.stringify({ claudeExe: claude, streamProxy: false, modelCatalog: false,
    database: dbFile, usageMeter: false, defaultAccount: 'ag1', accounts: { ag1: { label: 'personal', configDir: cfgDir } } }));
  const run = () => spawnSync(process.execPath, [path.join(cat, 'claude-account-router.js'), fake, '--input-format', 'stream-json', '--output-format', 'stream-json', '-p'],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: Object.assign({}, process.env, { AIONDX_CONVERSATION_ID: 'solo1', CLAUDE_CODE_OAUTH_TOKEN: '', USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: cfgDir }) });
  const recFile = path.join(data, 'aiondx-launches', 'solo1.json');
  writeReg('off');
  let r = run();
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch (e) { /* none */ }
  check('a Claude agent launch writes its record', !!rec && rec.v === 1 && Math.abs(Date.now() - rec.at) < 60000, (r.stdout || '') + (r.stderr || '') + fs.readFileSync(path.join(cat, 'claude-account-router.log'), 'utf8').slice(-400));
  let child = null;
  try { child = JSON.parse(r.stdout); } catch (e) { /* none */ }
  check('the record names the launcher process, the parent of the agent (alive as long as it is)', rec && child && rec.pid === child.pid, JSON.stringify([rec, child]));
  check('and what the launch got: account personal, Docs off, no full sign-in, the sign-in folder', rec && rec.acct === 'personal' && rec.docs === false && rec.fullSignIn === false &&
    path.resolve(rec.signInDir) === path.resolve(cfgDir) && rec.project === null, JSON.stringify(rec));
  fs.writeFileSync(path.join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: Date.now() + 86400000 } }));
  writeReg('on');
  run();
  rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  check('the next launch rewrites it: Docs on, full sign-in', rec.docs === true && rec.fullSignIn === true, JSON.stringify(rec));
  check('no temporary file is left behind', !fs.existsSync(recFile + '.tmp'));
  // a launch that is not an agent session (a subcommand such as `claude plugin list`) writes nothing
  fs.unlinkSync(recFile);
  spawnSync(process.execPath, [path.join(cat, 'claude-account-router.js'), fake, 'plugin', 'list'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: Object.assign({}, process.env, { AIONDX_CONVERSATION_ID: 'solo1', CLAUDE_CODE_OAUTH_TOKEN: '', USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: cfgDir }) });
  check('a subcommand that is not an agent session writes no record', !fs.existsSync(recFile));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
