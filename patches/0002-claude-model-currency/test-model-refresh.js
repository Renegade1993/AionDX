'use strict';
// test-model-refresh.js - aiondx-model-refresh.js against a temporary AionUi database and a stand-in for Claude Code. Nothing real is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-refresh-test-'));
const dbFile = path.join(root, 'aionui-backend.db');
const fake = path.join(root, 'fake-claude.js');
// The stand-in answers initialize with FAKE_MODELS, and records the config folder and token it was given.
fs.writeFileSync(fake, `
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cfg: process.env.CLAUDE_CONFIG_DIR, tok: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, aionui: process.env.AIONUI_CONVERSATION_ID || null }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => { buf += d; if (buf.indexOf('\\n') < 0) return; const req = JSON.parse(buf.split('\\n')[0]);
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { claude_code_version: '9.9.9', models: JSON.parse(process.env.FAKE_MODELS) } } }) + '\\n'); });
`);
const X = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: X },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5', supportedEffortLevels: X },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5', supportedEffortLevels: X },
  { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
];
// A database with AionCore's agent table (the columns the refresh reads) and three Claude agents, one disabled, one on a model without efforts.
const acctA = path.join(root, 'acctA'), acctB = path.join(root, 'acctB');
fs.mkdirSync(acctA); fs.mkdirSync(acctB);
fs.writeFileSync(path.join(root, 'token-b.txt'), 'tok-B');
const db = new DatabaseSync(dbFile);
db.exec('CREATE TABLE agent_metadata (id TEXT PRIMARY KEY, agent_id TEXT, name TEXT, backend TEXT, enabled INTEGER, env TEXT, env_override TEXT, available_models TEXT, config_options TEXT, updated_at INTEGER)');
const oldAm = JSON.stringify({ available_models: [{ id: 'default', label: 'Default' }, { id: 'haiku', label: 'Haiku' }], current_model_id: 'haiku' });
const oldCo = JSON.stringify([{ id: 'mode', category: 'mode', type: 'select', currentValue: 'bypassPermissions', options: [{ value: 'default', name: 'Default' }] },
  { id: 'model', category: 'model', type: 'select', currentValue: 'haiku', options: [{ value: 'default', name: 'Default' }, { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5' }] }]);
const envA = JSON.stringify([{ name: 'CLAUDE_CONFIG_DIR', value: acctA }]);
db.prepare('INSERT INTO agent_metadata VALUES (?,?,?,?,?,?,?,?,?,?)').run('r1', 'agentA', 'Claude A', 'claude', 1, envA, null, oldAm, oldCo, 1);
db.prepare('INSERT INTO agent_metadata VALUES (?,?,?,?,?,?,?,?,?,?)').run('r2', 'agentB', 'Claude B', 'claude', 1, '[]', null, oldAm, oldCo, 1);
db.prepare('INSERT INTO agent_metadata VALUES (?,?,?,?,?,?,?,?,?,?)').run('r3', 'agentOld', 'Claude disabled', 'claude', 0, envA, null, oldAm, oldCo, 1);
db.prepare('INSERT INTO agent_metadata VALUES (?,?,?,?,?,?,?,?,?,?)').run('r4', 'gem', 'Gemini', 'gemini', 1, '[]', null, '{"x":1}', '[]', 1);
db.prepare('INSERT INTO agent_metadata VALUES (?,?,?,?,?,?,?,?,?,?)').run('r5', 'agentC', 'Claude odd', 'claude', 1, envA, null, '"not an object"', '[]', 1);
db.close();
// The router config maps agentB to its own account folder and token.
const cfgFile = path.join(root, 'router.json');
fs.writeFileSync(cfgFile, JSON.stringify({ accounts: { agentB: { label: 'B', configDir: acctB, tokenFile: path.join(root, 'token-b.txt') } } }));
const LOG = path.join(root, 'starts.log');
const script = path.join(__dirname, 'aiondx-model-refresh.js');
// The refresh runs as a program, with a launcher that turns the exe argument into "node fake-claude.js".
const shim = path.join(root, 'run.js');
fs.writeFileSync(shim, `process.removeAllListeners('warning'); const m = require(${JSON.stringify(script)}); m.main({ exe: process.execPath, exeArgs: [${JSON.stringify(fake)}], noUpdate: true }).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });`);
const run = (extraArgs, extraEnv) => spawnSync(process.execPath, [shim, '--db', dbFile, '--config', cfgFile].concat(extraArgs || []),
  { encoding: 'utf8', windowsHide: true, timeout: 120000, env: Object.assign({}, process.env, { AIONDX_REFRESH_LOG_DIR: path.join(root, 'logs'), FAKE_LOG: LOG, FAKE_MODELS: JSON.stringify(MODELS), AIONUI_CONVERSATION_ID: 'leaked', ANTHROPIC_AUTH_TOKEN: 'leaked' }, extraEnv || {}) });
const rows = () => { const d = new DatabaseSync(dbFile, { readOnly: true }); try { return Object.fromEntries(d.prepare('SELECT * FROM agent_metadata').all().map((r) => [r.id, r])); } finally { d.close(); } };

try {
  let r = run(['--dry-run']);
  check('a dry run writes nothing', rows().r1.available_models === oldAm && /would rewrite Claude A/.test(fs.readFileSync(path.join(root, 'logs', 'model-refresh.log'), 'utf8')), r.stdout + r.stderr);
  fs.writeFileSync(LOG, '');
  r = run([]);
  const R = rows();
  const am = JSON.parse(R.r1.available_models), co = JSON.parse(R.r1.config_options);
  check('the list is the one Claude Code gives, in AionCore\'s shape', am.available_models.map((m) => m.id).join() === MODELS.map((m) => m.value).join() && am.available_models[1].label === 'Opus', R.r1.available_models);
  check('ultracode is added to a model with xhigh, and only there (as AionCore does)', am.available_models[1].reasoning_efforts.join() === 'low,medium,high,xhigh,max,ultracode' && am.available_models[3].reasoning_efforts.join() === 'low,medium,high,max' && am.available_models[4].reasoning_efforts === undefined, JSON.stringify(am.available_models));
  check('the remembered model stays when it still exists', am.current_model_id === 'haiku' && co.find((o) => o.id === 'model').currentValue === 'haiku');
  check('the model select gets every model with its name and description', co.find((o) => o.id === 'model').options.length === 5 && co.find((o) => o.id === 'model').options[2].description === 'Haiku 5.5' && !('description' in co.find((o) => o.id === 'model').options[3]), JSON.stringify(co.find((o) => o.id === 'model').options));
  const eff = co.find((o) => o.id === 'reasoning_effort');
  check('the effort select is built from every model with efforts (AionCore had dropped it)', eff && eff.options.map((o) => o.value).join() === 'low,medium,high,xhigh,max,ultracode' && eff.currentValue === null, JSON.stringify(eff));
  check('other selects (the mode) are left as they were', JSON.stringify(co.find((o) => o.id === 'mode')) === JSON.stringify(JSON.parse(oldCo)[0]));
  check('a disabled agent is refreshed too', JSON.parse(R.r3.available_models).available_models.length === 5);
  check('another backend is not touched', R.r4.available_models === '{"x":1}' && R.r4.updated_at === 1);
  check('a row whose stored picker is not the expected shape is left alone', R.r5.available_models === '"not an object"' && R.r5.updated_at === 1);
  const starts = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check("agent B is asked with its own account's folder and token (from the router's mapping)", starts.some((s) => s.cfg && s.cfg.indexOf('acctB') >= 0 && s.tok === 'tok-B') || starts.some((s) => s.tok === 'tok-B'), JSON.stringify(starts));
  check('no AionUi variables or inherited tokens reach Claude Code', starts.every((s) => s.aionui === null), JSON.stringify(starts));
  check("agent B's catalog went to its own folder", fs.existsSync(path.join(acctB, 'aiondx-models.json')) && fs.existsSync(path.join(acctA, 'aiondx-models.json')));
  const t1 = rows().r1.updated_at;
  r = run([]);
  check('a second run with nothing new writes nothing', rows().r1.updated_at === t1 && /every picker is current/.test(fs.readFileSync(path.join(root, 'logs', 'model-refresh.log'), 'utf8')), r.stdout);
  // a model the remembered one no longer exists
  const d2 = new DatabaseSync(dbFile);
  d2.prepare('UPDATE agent_metadata SET available_models = ? WHERE id = ?').run(JSON.stringify({ available_models: [{ id: 'gone' }], current_model_id: 'gone' }), 'r2');
  d2.close();
  r = run([]);
  check('a remembered model that no longer exists falls back to default', JSON.parse(rows().r2.available_models).current_model_id === 'default', rows().r2.available_models);
  // the lock
  fs.writeFileSync(path.join(root, 'logs', 'model-refresh.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  r = run([]);
  check('a second run while one holds the lock does nothing', /another refresh is running/.test(fs.readFileSync(path.join(root, 'logs', 'model-refresh.log'), 'utf8')));
  fs.unlinkSync(path.join(root, 'logs', 'model-refresh.lock'));
  // no database
  r = spawnSync(process.execPath, [shim, '--db', path.join(root, 'none.db')], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: Object.assign({}, process.env, { AIONDX_REFRESH_LOG_DIR: path.join(root, 'logs') }) });
  check('with no database it ends quietly', r.status === 0, r.stderr);
  // a table from a different AionCore
  const odd = path.join(root, 'odd.db');
  const d3 = new DatabaseSync(odd); d3.exec('CREATE TABLE agent_metadata (id TEXT, agent_id TEXT, backend TEXT)'); d3.close();
  r = spawnSync(process.execPath, [shim, '--db', odd], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: Object.assign({}, process.env, { AIONDX_REFRESH_LOG_DIR: path.join(root, 'logs') }) });
  check('a table without the expected columns is not written', r.status === 0 && /does not have/.test(fs.readFileSync(path.join(root, 'logs', 'model-refresh.log'), 'utf8')));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* in use */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
