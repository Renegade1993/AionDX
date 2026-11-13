'use strict';
// test-docs-strict.js - with Claude Docs on for a chat, the launcher drops AionCore's --strict-mcp-config, which hides claude.ai's connectors
// (Claude Docs among them) from every team chat; with Docs off it stays. A made-up data folder (registry, chats database with a team chat)
// and a stand-in Claude that prints its arguments. Nothing real is read or written.
//   node patches\0002-claude-model-currency\test-docs-strict.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-docs-strict-'));
try {
  const cat = path.join(root, 'router');
  fs.mkdirSync(cat);
  for (const f of ['claude-account-router.js', 'claude-stream-proxy.js']) fs.copyFileSync(path.join(__dirname, f), path.join(cat, f));
  const data = path.join(root, 'AionDX');
  fs.mkdirSync(path.join(data, 'aionui'), { recursive: true });
  const dbFile = path.join(data, 'aionui', 'aiondx-backend.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT, user_id TEXT); CREATE TABLE agent_metadata (agent_id TEXT, env TEXT, user_id TEXT, backend TEXT); CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?,?)').run('lead1', JSON.stringify({ backend: 'claude', teamId: 'team1', role: 'lead', agent_id: 'ag1' }), 'u1');
  db.prepare('INSERT INTO teams VALUES (?,?)').run('team1', 'Landfall Team');
  db.close();
  const proj = path.join(root, 'Landfall');
  fs.mkdirSync(proj);
  const writeReg = (docs) => fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [],
    projects: { landfall: { root: proj, domain: 'personal', accounts: ['personal'], docs } }, bindings: { 'team:team1': 'landfall' }, accountDocs: { personal: docs } }));
  const fake = path.join(cat, 'fake-claude.js');
  fs.writeFileSync(fake, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const profile = path.join(root, 'profile');
  fs.mkdirSync(path.join(profile, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cat, 'claude-account-router.config.json'), JSON.stringify({ claudeExe: process.execPath, streamProxy: false, modelCatalog: false,
    database: dbFile, usageMeter: false, defaultAccount: 'ag1', accounts: { ag1: { label: 'personal', configDir: path.join(profile, '.claude') } } }));
  const run = () => {
    const r = spawnSync(process.execPath, [path.join(cat, 'claude-account-router.js'), fake, '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '-p', 'x'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
        env: Object.assign({}, process.env, { AIONDX_CONVERSATION_ID: 'lead1', CLAUDE_CODE_OAUTH_TOKEN: '', USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: path.join(profile, '.claude') }) });
    try { return JSON.parse(r.stdout); } catch (e) { return { err: r.stdout + r.stderr }; }
  };
  writeReg('on');
  let a = run();
  check('Docs on for the team\'s project: --strict-mcp-config is dropped, --mcp-config and its value stay', Array.isArray(a) && a.indexOf('--strict-mcp-config') < 0 && a[a.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}', JSON.stringify(a));
  const log = fs.readFileSync(path.join(cat, 'claude-account-router.log'), 'utf8');
  check('the launch line says so', /docs=on .*strict-mcp dropped/.test(log), log.slice(-300));
  writeReg('off');
  a = run();
  check('Docs off: --strict-mcp-config stays', Array.isArray(a) && a.indexOf('--strict-mcp-config') >= 0, JSON.stringify(a));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
