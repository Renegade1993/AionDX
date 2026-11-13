'use strict';
// test-accounts.js - "+ Add account" (aiondx-accounts.js) with a stand-in Claude Code: the sign-in each kind starts (full, token, console,
// with SSO and the email), the long-lived key taken from setup-token's output and never handed to the page, the check of what was saved
// (keys, renewal, scopes granted against those asked, Claude Code's own status), and the save into the launcher's accounts and the
// projects registry. A made-up home and data folder; nothing real is read or written.
//   node patches\0009-identity\test-accounts.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const A = require(path.join(__dirname, 'aiondx-accounts.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-accounts-'));
const home = path.join(root, 'home'), router = path.join(root, 'router'), data = path.join(root, 'data');
for (const d of [home, router, data]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(router, 'claude-account-router.js'), '// stand-in');
fs.writeFileSync(path.join(router, 'claude-account-router.config.json'), JSON.stringify({ accounts: { personal: { label: 'personal (Pro)', configDir: path.join(home, '.claude') } } }));
fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [], projects: {}, bindings: {}, accountDocs: { personal: 'on', work: 'off' } }));
const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(90);
const spawned = [];
let plan = null;   // what the stand-in sign-in does
function fakeSpawn(exe, args, opts) {
  const ch = new EventEmitter();
  ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter();
  ch.stdin = { written: [], write(s) { this.written.push(s); } };
  ch.kill = () => ch.emit('exit', null);
  spawned.push({ exe, args, env: opts.env, child: ch });
  setTimeout(() => {
    ch.stdout.emit('data', 'Opening browser to sign in...\nIf the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&x=1\n');
    if (plan) setTimeout(() => plan(ch, opts.env), 50);
  }, 30);
  return ch;
}
let status = { loggedIn: true, email: 'someone@example.com', subscriptionType: 'pro', authMethod: 'claude.ai' };
const statusCalls = [];
function fakeExecFile(exe, args, opts, cb) { statusCalls.push({ args, env: opts.env }); setTimeout(() => cb(null, JSON.stringify(status)), 10); }
const svc = A.create({ home, routerDir: () => router, dataDir: () => data, findClaude: () => 'C:/fake/claude.exe', spawn: fakeSpawn, execFile: fakeExecFile });
const H = (req) => svc.handle(req);
const waitDone = async () => { for (let i = 0; i < 100; i++) { const p = await H({ op: 'poll' }); if (p.state !== 'running') return p; await new Promise((r) => setTimeout(r, 30)); } return null; };

(async () => {
  try {
    check('a name that is not a short word is refused before anything starts', (await H({ op: 'start', name: 'Work 2!' })).ok === false && spawned.length === 0);
    // full sign-in: the stand-in writes credentials with a renewal key and these scopes
    plan = (ch, env) => {
      fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000,
        refreshTokenExpiresAt: Date.now() + 30 * 86400000, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'], subscriptionType: 'pro' } }));
      ch.emit('exit', 0);
    };
    let r = await H({ op: 'start', name: 'work2', kind: 'full', sso: true, email: 'someone@example.com' });
    const s1 = spawned[0];
    check('full: claude auth login --claudeai --sso --email, in the account\'s own folder, with no inherited key', r.ok && r.url === 'https://claude.ai/oauth/authorize?code=true&x=1' &&
      JSON.stringify(s1.args) === JSON.stringify(['auth', 'login', '--claudeai', '--sso', '--email', 'someone@example.com']) &&
      s1.env.CLAUDE_CONFIG_DIR === path.join(home, '.claude-work2') && s1.env.CLAUDE_SECURESTORAGE_CONFIG_DIR === s1.env.CLAUDE_CONFIG_DIR && !('CLAUDE_CODE_OAUTH_TOKEN' in s1.env), JSON.stringify([r, s1.args]));
    check('the sign-in finishes by itself (poll says done)', ((await waitDone()) || {}).state === 'done');
    let v = await H({ op: 'verify', name: 'work2', kind: 'full' });
    check('verify: a sign-in key with a renewal key, its renewal date, the plan and Claude Code\'s own status', v.ok && v.kind === 'full' && v.key === 'sign-in key with a renewal key' &&
      v.renewsUntil > Date.now() && v.loggedIn && v.email === 'someone@example.com' && v.plan === 'pro' && statusCalls[0].env.CLAUDE_CONFIG_DIR === path.join(home, '.claude-work2'), JSON.stringify(v));
    check('verify names what was granted in words, and what was asked for but not granted (plugins)', v.scopeWords.indexOf('connectors, Claude Docs among them') >= 0 &&
      JSON.stringify(v.missing) === JSON.stringify(['plugins']), JSON.stringify([v.scopeWords, v.missing]));
    check('verify returns no key', !/"a"|"r"|sk-ant/.test(JSON.stringify(v)) && !('accessToken' in v));
    r = await H({ op: 'save', name: 'work2', label: 'Client B', kind: 'full', docs: true, domain: 'work' });
    const cfg = JSON.parse(fs.readFileSync(path.join(router, 'claude-account-router.config.json'), 'utf8'));
    const reg = JSON.parse(fs.readFileSync(path.join(data, 'aiondx-projects.json'), 'utf8'));
    check('save: the launcher gets the account (its folder, a work label), the old accounts stay, a backup is kept', r.ok && cfg.accounts.work2 && cfg.accounts.work2.label === 'Client B (work)' &&
      cfg.accounts.work2.configDir === path.join(home, '.claude-work2') && cfg.accounts.work2.addedBy === 'aiondx' && !cfg.accounts.work2.signIn && cfg.accounts.personal &&
      fs.existsSync(path.join(router, 'claude-account-router.config.json.bak-accounts')), JSON.stringify(cfg));
    check('save: Claude Docs on for this account alone (accountDocs.work2), the others unchanged', reg.accountDocs.work2 === 'on' && reg.accountDocs.work === 'off' && reg.accountDocs.personal === 'on', JSON.stringify(reg.accountDocs));
    check('a personal account whose name says work is refused (AionDX would treat it as work)', (await H({ op: 'save', name: 'x1', label: 'my work', kind: 'full', domain: 'personal' })).ok === false);
    // model calls only: setup-token prints the key; it is saved in the folder, never returned, and checked under that key
    plan = (ch) => { ch.stdout.emit('data', '\nYour OAuth token (valid for 1 year):\n\n' + TOKEN + '\n\nStore this token securely.\n'); ch.emit('exit', 0); };
    r = await H({ op: 'start', name: 'calls', kind: 'token', sso: true, email: 'x@example.com' });
    check('token: claude setup-token, with no SSO or email flags (it takes none)', r.ok && JSON.stringify(spawned[1].args) === JSON.stringify(['setup-token']), JSON.stringify(spawned[1].args));
    const p2 = await waitDone();
    check('the key printed by setup-token is saved in the account\'s folder and blanked out of what the page sees', p2 && p2.state === 'done' && !/sk-ant-oat01/.test(JSON.stringify(p2)) && /\(key saved\)/.test(p2.text) &&
      fs.readFileSync(path.join(home, '.claude-calls', 'aiondx-oauth-token'), 'utf8') === TOKEN, JSON.stringify(p2));
    statusCalls.length = 0;
    status = { loggedIn: true, email: '', subscriptionType: 'pro', authMethod: 'oauth_token' };
    v = await H({ op: 'verify', name: 'calls', kind: 'token' });
    check('verify (token): a long-lived key for model calls, accepted by Claude Code when run with it', v.ok && v.kind === 'token' && v.key === 'long-lived key for model calls' &&
      JSON.stringify(v.scopes) === '["user:inference"]' && statusCalls[0].env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && !/sk-ant/.test(JSON.stringify(v)), JSON.stringify(v));
    r = await H({ op: 'save', name: 'calls', label: 'Calls only', kind: 'token', docs: true, domain: 'personal' });
    const cfg2 = JSON.parse(fs.readFileSync(path.join(router, 'claude-account-router.config.json'), 'utf8'));
    const reg2 = JSON.parse(fs.readFileSync(path.join(data, 'aiondx-projects.json'), 'utf8'));
    check('save (token): the launcher runs it on the key file, and Claude Docs stays off (a model-calls key cannot load it)', r.ok && cfg2.accounts.calls.signIn === 'token' &&
      cfg2.accounts.calls.tokenFile === path.join(home, '.claude-calls', 'aiondx-oauth-token') && reg2.accountDocs.calls === 'off' && r.docs === false, JSON.stringify([cfg2.accounts.calls, reg2.accountDocs]));
    // console, and a sign-in that is refused
    plan = (ch) => ch.emit('exit', 1);
    r = await H({ op: 'start', name: 'api1', kind: 'console' });
    check('console: claude auth login --console', JSON.stringify(spawned[2].args) === JSON.stringify(['auth', 'login', '--console']));
    const p3 = await waitDone();
    check('a sign-in that ends badly says failed, and verify finds no key', p3.state === 'failed' && (await H({ op: 'verify', name: 'api1' })).ok === false);
    const l = await H({ op: 'list' });
    check('list: only the accounts AionDX added, with their labels and kinds', JSON.stringify(l.accounts) === JSON.stringify([{ id: 'work2', label: 'Client B (work)', kind: 'full' }, { id: 'calls', label: 'Calls only', kind: 'token' }]), JSON.stringify(l));
    // a sign-in the page shows a code for
    plan = null;
    r = await H({ op: 'start', name: 'codeflow', kind: 'full' });
    spawned[3].child.stdout.emit('data', 'Paste code here if prompted > ');
    const p4 = await H({ op: 'poll' });
    const c = await H({ op: 'code', code: 'abc#123' });
    check('when the page shows a code, poll says so and the code goes to Claude Code\'s input', p4.state === 'running' && p4.asksCode && c.ok && spawned[3].child.stdin.written[0] === 'abc#123\n');
    check('a second sign-in while one runs is refused', (await H({ op: 'start', name: 'other', kind: 'full' })).ok === false);
    await H({ op: 'cancel' });
    check('cancel ends it', ((await waitDone()) || {}).state === 'failed');
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
