#!/usr/bin/env node
/**
 * test-account-switch.js - the account router's per-chat choice and transcript carry-over, run
 * from a scratch copy so the installed router is never touched.
 *
 * Copies claude-account-router.js from this folder and the live router config into a temp folder
 * and runs it with `--version` (claude prints its version and exits; no API call, no usage).
 * Uses the real AionUi database read-only, and sets and then removes settings-store keys
 * (aiondx.account.conv.<chat>, aiondx.agent.conv.<chat>) for a chat that is not a Claude chat, so no
 * real launch reads them. The generic half (2026-09-26) runs a second scratch copy whose config has no
 * accounts at all, as on a machine that is not the owner's, with "claude" pinned to node printing the
 * environment it was given.
 *
 *   node patches\0002-claude-model-currency\test-account-switch.js
 *
 * Needs AionUi running and an agent shell's AIONUI_* variables. 120 s deadline.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 120000);
const NPM = path.join(process.env.APPDATA, 'npm');
const scratch = path.join(process.env.TEMP, 'aiondx-router-test-' + Date.now().toString(36));
fs.mkdirSync(scratch, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'claude-account-router.js'), path.join(scratch, 'claude-account-router.js'));
const cfg = JSON.parse(fs.readFileSync(path.join(NPM, 'claude-account-router.config.json'), 'utf8'));
// The scratch config gets the plain names the installer adds, whether or not it has run.
for (const [key, a] of Object.entries(Object.assign({}, cfg.accounts))) {
  const name = String(a.label || '').toLowerCase().split(/[^a-z]/)[0];
  if (name && !cfg.accounts[name]) cfg.accounts[name] = Object.assign({}, a);
}
fs.writeFileSync(path.join(scratch, 'claude-account-router.config.json'), JSON.stringify(cfg, null, 2));
// Two accounts of the config to move chats between: its first two plain names.
const [ACC_A, ACC_B] = Object.keys(cfg.accounts).filter((k) => /^[a-z]+$/.test(k));
const LOG = path.join(scratch, 'claude-account-router.log');
// A chat that is not a Claude chat, so no real launch reads the keys the test sets: ROUTER_TEST_CHAT, or the first Antigravity
// chat in the database (read-only).
function pickChat() {
  if (process.env.ROUTER_TEST_CHAT) return process.env.ROUTER_TEST_CHAT;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(cfg.database, { readOnly: true });
    try { const r = db.prepare("SELECT id FROM conversations WHERE json_extract(extra,'$.backend') = 'antigravity' LIMIT 1").get(); return r && r.id; } finally { db.close(); }
  } catch (e) { return null; }
}
const CHAT = pickChat();
if (!CHAT) { console.log('needs a chat that is not a Claude chat: set ROUTER_TEST_CHAT to one (an Antigravity chat in AionUi will do)'); process.exit(2); }
const base = (process.env.AIONUI_BASE_URL || '').replace(/\/+$/, '');
const hdr = { 'Content-Type': 'application/json', 'x-aionui-runtime-token': process.env.AIONUI_RUNTIME_TOKEN || '',
  'x-aionui-user-id': process.env.AIONUI_USER_ID || '', 'x-aionui-conversation-id': process.env.AIONUI_CONVERSATION_ID || '' };
const put = (body) => fetch(base + '/api/settings/client', { method: 'PUT', headers: hdr, body: JSON.stringify(body) }).then((r) => r.ok);

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '   [' + detail + ']'}`); };
function router(args, env, cwd) {
  const e = Object.assign({}, process.env, env);
  for (const k of Object.keys(env)) if (env[k] === null) delete e[k];
  return spawnSync(process.execPath, [path.join(scratch, 'claude-account-router.js')].concat(args),
    { cwd: cwd || scratch, env: e, encoding: 'utf8', windowsHide: true, timeout: 60000 });
}
const lastLog = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return ''; } };

(async () => {
  const cleanups = [];
  try {
    let r = router(['--version'], { AIONUI_CONVERSATION_ID: null });
    check('outside AionUi it passes straight through', r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout) && !fs.existsSync(LOG), r.stderr || r.stdout);

    r = router(['--version'], { AIONUI_CONVERSATION_ID: CHAT });
    check('a chat with no choice runs on its agent\'s account (or the default)', r.status === 0 && /conv=\w+ agent=\S+ -> /.test(lastLog()) && !/chosen=/.test(lastLog()), lastLog());

    const key = 'aiondx.account.conv.' + CHAT;
    cleanups.push(() => put({ [key]: null }));
    await put({ [key]: { account: ACC_B, at: Date.now(), by: 'test' } });
    r = router(['--version'], { AIONUI_CONVERSATION_ID: CHAT });
    check('a chat moved to the second account launches on it', r.status === 0 && new RegExp(' chosen=' + ACC_B + ' -> ' + ACC_B, 'i').test(lastLog()), lastLog());

    await put({ [key]: 'nosuchaccount' });
    r = router(['--version'], { AIONUI_CONVERSATION_ID: CHAT });
    check('an unknown name is ignored: the agent\'s own account', r.status === 0 && !/chosen=/.test(lastLog().split(' | ').pop()), lastLog());

    await put({ [key]: { account: ACC_A, at: Date.now() } });
    // The session's newest transcript is on the second account; this launch resumes it on the first.
    const cwd = fs.mkdtempSync(path.join(process.env.TEMP, 'aiondx-router-cwd-'));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const id = crypto.randomUUID();
    const slug = fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const work = cfg.accounts[ACC_B].configDir, personal = cfg.accounts[ACC_A].configDir;
    const src = path.join(work, 'projects', slug);
    fs.mkdirSync(path.join(src, id, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(src, id + '.jsonl'), '{"type":"user","test":true}\n');
    fs.writeFileSync(path.join(src, id, 'subagents', 'a.jsonl'), '{}\n');
    fs.mkdirSync(path.join(src, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(src, 'memory', 'MEMORY.md'), '- test\n');
    cleanups.push(() => fs.rmSync(src, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(path.join(personal, 'projects', slug), { recursive: true, force: true }));
    r = router(['--resume', id, '--version'], { AIONUI_CONVERSATION_ID: CHAT }, cwd);
    const dst = path.join(personal, 'projects', slug, id + '.jsonl');
    check('resuming on another account carries the newest transcript over', r.status === 0 && fs.existsSync(dst) &&
      fs.existsSync(path.join(personal, 'projects', slug, id, 'subagents', 'a.jsonl')) && /carried session/.test(lastLog()), lastLog());
    check("and the chat's memory folder, where it has none", fs.existsSync(path.join(personal, 'projects', slug, 'memory', 'MEMORY.md')));
    const before = fs.statSync(dst).mtimeMs;
    r = router(['--resume', id, '--version'], { AIONUI_CONVERSATION_ID: CHAT }, cwd);
    check('a copy that is already the newest is left alone', r.status === 0 && fs.statSync(dst).mtimeMs === before);
    r = router(['--resume', 'not-a-session-id', '--version'], { AIONUI_CONVERSATION_ID: CHAT }, cwd);
    check('a malformed session id copies nothing and still launches', r.status === 0);

    // ---- any agent, no accounts in the config (2026-09-26) ----
    const generic = path.join(scratch, 'generic');
    fs.mkdirSync(generic, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'claude-account-router.js'), path.join(generic, 'claude-account-router.js'));
    fs.writeFileSync(path.join(generic, 'claude-account-router.config.json'), JSON.stringify({ claudeExe: process.execPath, streamProxy: false }));
    const envOf = (res) => { try { return JSON.parse(res.stdout.trim().split(/\r?\n/).pop()); } catch { return null; } };
    const probe = ['-e', 'console.log(JSON.stringify({ dir: process.env.CLAUDE_CONFIG_DIR || null, home: process.env.HOME || null, extra: process.env.AIONDX_TEST_EXTRA || null }))'];
    const genericRun = (extraEnv) => spawnSync(process.execPath, [path.join(generic, 'claude-account-router.js')].concat(probe),
      { cwd: generic, env: Object.assign({}, process.env, { AIONUI_CONVERSATION_ID: CHAT }, extraEnv || {}), encoding: 'utf8', windowsHide: true, timeout: 60000 });
    await put({ [key]: null });
    const akey = 'aiondx.agent.conv.' + CHAT;
    cleanups.push(() => put({ [akey]: null }));
    // What the database says each Claude agent's environment is.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(process.env.APPDATA, 'AionUi', 'aionui', 'aionui-backend.db'), { readOnly: true });
    const envRows = db.prepare("SELECT agent_id, env FROM agent_metadata WHERE backend = 'claude' AND env LIKE '%CLAUDE_CONFIG_DIR%'").all();
    db.close();
    const pick = envRows.map((r) => ({ id: r.agent_id, env: JSON.parse(r.env) }));
    const want = (e, name) => { const x = e.find((v) => v.name === name); return x ? x.value : null; };
    if (pick.length < 2) { check('two Claude agents with their own CLAUDE_CONFIG_DIR exist to test with', false, pick.length); }
    else {
      let g = genericRun({ CLAUDE_CONFIG_DIR: 'X:\\left-over', AIONDX_TEST_EXTRA: 'kept' });
      let e1 = envOf(g);
      check('with no accounts and no choice, the chat keeps the environment AionCore gave it', e1 && e1.dir === 'X:\\left-over' && e1.extra === 'kept', g.stdout + g.stderr);
      await put({ [akey]: { agent: pick[1].id, at: Date.now(), by: 'test' } });
      g = genericRun({ AIONDX_TEST_EXTRA: 'kept' });
      e1 = envOf(g);
      check("a chat moved to another Claude agent gets that agent's own environment from the database",
        e1 && e1.dir === want(pick[1].env, 'CLAUDE_CONFIG_DIR') && e1.home === want(pick[1].env, 'HOME') && e1.extra === 'kept', JSON.stringify([e1, pick[1].env]));
      await put({ [akey]: { agent: pick[0].id, at: Date.now(), by: 'test' } });
      g = genericRun();
      e1 = envOf(g);
      check('and moved to a third, that one', e1 && e1.dir === want(pick[0].env, 'CLAUDE_CONFIG_DIR'), JSON.stringify([e1, pick[0].env]));
      check('the choice is logged with the agent it chose', new RegExp('chosen=' + pick[0].id + ' -> agent ' + pick[0].id).test(fs.readFileSync(path.join(generic, 'claude-account-router.log'), 'utf8')));
      await put({ [akey]: { agent: 'nosuchagent', at: Date.now() } });
      g = genericRun({ CLAUDE_CONFIG_DIR: 'X:\\own' });
      e1 = envOf(g);
      check("an agent the database does not know leaves the chat's own environment", e1 && e1.dir === 'X:\\own', JSON.stringify(e1));
    }
  } catch (e) {
    check('no exception', false, e.message);
  } finally {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* keep cleaning */ } }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* temp */ }
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
