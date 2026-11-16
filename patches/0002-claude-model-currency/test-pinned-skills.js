'use strict';
// test-pinned-skills.js - pinned skills (R-128) reach the agent at its start: the launcher adds each pinned SKILL.md to the system prompt
// argument AionCore passes, from the nearest layer (the bound project's over the shared and the user's own), for a chat's own pins and its
// team's. A made-up data folder and a stand-in Claude (a copy of Node named claude.exe that prints its arguments). Nothing real is touched.
//   node patches\0002-claude-model-currency\test-pinned-skills.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-pins-'));
try {
  const cat = path.join(root, 'router');
  fs.mkdirSync(cat);
  for (const f of ['claude-account-router.js', 'claude-stream-proxy.js']) fs.copyFileSync(path.join(__dirname, f), path.join(cat, f));
  fs.copyFileSync(path.join(__dirname, '..', '0009-identity', 'aiondx-plan-hooks.js'), path.join(cat, 'aiondx-plan-hooks.js'));
  const claudeExe = path.join(root, 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(claudeExe));
  fs.copyFileSync(process.execPath, claudeExe);
  const data = path.join(root, 'AionDX');
  fs.mkdirSync(path.join(data, 'aionui'), { recursive: true });
  const dbFile = path.join(data, 'aionui', 'aiondx-backend.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT, user_id TEXT); CREATE TABLE agent_metadata (agent_id TEXT, env TEXT, user_id TEXT, backend TEXT); CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?,?)').run('m1', JSON.stringify({ backend: 'claude', teamId: 'team1', agent_id: 'ag1' }), 'u1');
  db.prepare('INSERT INTO teams VALUES (?,?)').run('team1', 'Atlas Team');
  db.close();
  const profile = path.join(root, 'profile');
  const skill = (dir, name, body) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: x\n---\n' + body); };
  const proj = path.join(root, 'Atlas');
  const shared = path.join(root, 'Shared');
  skill(path.join(profile, '.claude', 'skills'), 'notes', 'PERSONAL NOTES BODY');
  skill(path.join(profile, '.claude', 'skills'), 'build', 'PERSONAL BUILD BODY');
  skill(path.join(proj, '.claude', 'skills'), 'build', 'PROJECT BUILD BODY');
  skill(path.join(shared, '.claude', 'skills'), 'review', 'SHARED REVIEW BODY');
  fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [shared], projects: { atlas: { root: proj, domain: 'personal' } }, bindings: { 'team:team1': 'atlas' }, accountDocs: { personal: 'off' } }));
  const fake = path.join(cat, 'fake-claude.js');
  fs.writeFileSync(fake, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  fs.writeFileSync(path.join(cat, 'claude-account-router.config.json'), JSON.stringify({ claudeExe, streamProxy: false, modelCatalog: false,
    database: dbFile, usageMeter: false, defaultAccount: 'ag1', accounts: { ag1: { label: 'personal', configDir: path.join(profile, '.claude') } } }));
  const run = (extra) => {
    const r = spawnSync(process.execPath, [path.join(cat, 'claude-account-router.js'), fake, '--input-format', 'stream-json', '--output-format', 'stream-json'].concat(extra || []),
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, input: '',
        env: Object.assign({}, process.env, { AIONDX_CONVERSATION_ID: 'm1', CLAUDE_CODE_OAUTH_TOKEN: '', USERPROFILE: profile, HOME: profile, CLAUDE_CONFIG_DIR: path.join(profile, '.claude') }) });
    try { return JSON.parse(r.stdout); } catch (e) { return { err: r.stdout + r.stderr }; }
  };
  const sp = (a) => Array.isArray(a) && a.indexOf('--append-system-prompt') >= 0 ? a[a.indexOf('--append-system-prompt') + 1] : null;
  let a = run(['--append-system-prompt', 'AIONCORE TEXT']);
  check('no pins: AionCore\'s system prompt text is untouched', sp(a) === 'AIONCORE TEXT', JSON.stringify(a));
  fs.writeFileSync(path.join(data, 'aiondx-skill-pins.json'), JSON.stringify({ 'c:m1': ['notes', 'build'], 't:team1': ['review'], 'c:other': ['nope'] }));
  a = run(['--append-system-prompt', 'AIONCORE TEXT']);
  const t = sp(a) || '';
  check('the chat\'s and its team\'s pins are added after AionCore\'s text, one argument', t.startsWith('AIONCORE TEXT\n\nPinned skills:') && a.filter((x) => x === '--append-system-prompt').length === 1, t.slice(0, 200));
  check('each pinned skill in full', /PERSONAL NOTES BODY/.test(t) && /SHARED REVIEW BODY/.test(t) && /<pinned-skill name="review"/.test(t), t);
  check('the bound project\'s skill wins over the user\'s own of the same name', /PROJECT BUILD BODY/.test(t) && !/PERSONAL BUILD BODY/.test(t), t);
  check('another chat\'s pins are not given', !/nope/.test(t));
  // R-127: the planning hooks, passed with --settings (a file holding only hooks)
  const st = a[a.indexOf('--settings') + 1];
  let hk = null; try { hk = JSON.parse(fs.readFileSync(st, 'utf8')); } catch (e) {}
  check('the planning hooks go in with --settings: a file of hooks only, prompt, stop and edits', st === path.join(data, 'aiondx-claude-hooks.json') && hk && JSON.stringify(Object.keys(hk)) === '["hooks"]' &&
    /aiondx-plan-hooks.js" prompt$/.test(hk.hooks.UserPromptSubmit[0].hooks[0].command) && /" stop$/.test(hk.hooks.Stop[0].hooks[0].command) && hk.hooks.PreToolUse[0].matcher === 'Edit|Write|MultiEdit|NotebookEdit', JSON.stringify(hk));
  a = run([]);
  check('no system prompt argument from AionCore: one is added', /^Pinned skills:/.test(sp(a) || ''), JSON.stringify(a).slice(0, 300));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
