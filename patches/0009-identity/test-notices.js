'use strict';
// test-notices.js - the notification bell's checks (aiondx-notices.js) on a made-up data folder: each notice appears only while its
// condition holds and is gone when it stops holding. Nothing real is read.
//   node patches\0009-identity\test-notices.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require(path.join(__dirname, 'aiondx-notices.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-notices-'));
try {
  const data = path.join(root, 'AionDX');
  fs.mkdirSync(path.join(data, 'aiondx-launches'), { recursive: true });
  const home = path.join(root, 'home');
  const personal = path.join(home, '.claude'), work = path.join(home, '.claude-work');
  fs.mkdirSync(personal, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const reg = (accountDocs, projects, bindings) => fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, skillRoots: [], projects: projects || {}, bindings: bindings || {}, accountDocs }));
  const launch = (conv, rec) => fs.writeFileSync(path.join(data, 'aiondx-launches', conv + '.json'), JSON.stringify(Object.assign({ v: 1, at: 1000, pid: 4242 }, rec)));
  const signIn = (dir, on) => { const f = path.join(dir, '.credentials.json'); if (on) fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: Date.now() + 86400000 } })); else try { fs.unlinkSync(f); } catch (e) {} };
  const alive = { pidAlive: () => true }, dead = { pidAlive: () => false };

  check('the folder names map to the sign-in account names', N.signInAccountFor(personal) === '' && N.signInAccountFor(work) === 'work' && N.signInAccountFor('C:/x/other') === null);
  reg({ personal: 'on', work: 'off' });
  signIn(personal, true);
  launch('c1', { project: null, acct: 'personal', docs: false, fullSignIn: true, signInDir: personal });
  let n = N.noticesFor(data, 'c1', alive);
  check('Docs turned on after the agent started: one reconnect notice, with a Reconnect button', n.length === 1 && n[0].kind === 'reconnect' && /^docs-reconnect:c1:1000$/.test(n[0].id) && n[0].action.op === 'reconnect', JSON.stringify(n));
  check('the same, with no agent running: nothing (the next message starts a current one)', N.noticesFor(data, 'c1', dead).length === 0);
  launch('c1', { project: null, acct: 'personal', docs: true, fullSignIn: true, signInDir: personal, at: 2000 });
  check('after the reconnect (a launch with Docs on): the notice is gone', N.noticesFor(data, 'c1', alive).length === 0);
  reg({ personal: 'off', work: 'off' });
  launch('c1', { project: null, acct: 'personal', docs: false, fullSignIn: true, signInDir: personal });
  check('Docs off for the account: nothing', N.noticesFor(data, 'c1', alive).length === 0);

  reg({ personal: 'off', work: 'on' });
  launch('w1', { project: null, acct: 'work', docs: true, fullSignIn: false, signInDir: work });
  n = N.noticesFor(data, 'w1', alive);
  check('Docs on for a work chat whose account is not signed in: a sign-in notice naming the work account, button for account "work"', n.length === 1 && n[0].kind === 'signin' && /work Claude account/.test(n[0].text) && n[0].action.op === 'signin' && n[0].action.account === 'work', JSON.stringify(n));
  check('the sign-in notice shows with no agent running too', N.noticesFor(data, 'w1', dead).length === 1);
  signIn(work, true);
  n = N.noticesFor(data, 'w1', alive);
  check('signed in now, the agent started before it: a reconnect notice', n.length === 1 && n[0].id === 'signin-reconnect:w1:1000', JSON.stringify(n));
  launch('w1', { project: null, acct: 'work', docs: true, fullSignIn: true, signInDir: work, at: 3000 });
  check('after the reconnect: nothing', N.noticesFor(data, 'w1', alive).length === 0);
  fs.writeFileSync(path.join(work, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: Date.now() - 1000 } }));
  n = N.noticesFor(data, 'w1', alive);
  check('a sign-in whose renewal key ran out counts as not signed in', n.length === 1 && n[0].kind === 'signin', JSON.stringify(n));

  // a bound project decides, as in the launcher
  reg({ personal: 'off', work: 'off' }, { atlas: { root: root, domain: 'personal', accounts: ['personal'], docs: 'on' } });
  launch('p1', { project: 'atlas', acct: 'personal', docs: false, fullSignIn: true, signInDir: personal });
  check('a project with Docs on overrides the account being off', N.noticesFor(data, 'p1', alive).length === 1);
  launch('p2', { project: 'atlas', acct: 'work', docs: false, fullSignIn: true, signInDir: personal });
  check('a project whose domain the account does not own: nothing', N.noticesFor(data, 'p2', alive).length === 0);
  reg({ personal: 'off', work: 'off', work2: 'on' });
  launch('a1', { project: null, acct: 'work', accountKey: 'work2', docs: false, fullSignIn: true, signInDir: personal });
  launch('a2', { project: null, acct: 'work', accountKey: 'work', docs: false, fullSignIn: true, signInDir: personal });
  check('an added account\'s own Docs setting wins over its domain\'s (work2 on while work is off)', N.noticesFor(data, 'a1', alive).length === 1 && N.noticesFor(data, 'a2', alive).length === 0);
  check('no launch record, or an odd id: nothing', N.noticesFor(data, 'none', alive).length === 0 && N.noticesFor(data, '../x', alive).length === 0);
  check('this process counts as alive; pid 0 does not', N.pidAlive(process.pid) && !N.pidAlive(0));

  // the ipc handler: one sign-in notice per account across chats
  let handler = null;
  N.install({ ipcMain: { handle: (ch, f) => { if (ch === 'aiondx:notices') handler = f; } } }, () => data);
  reg({ personal: 'off', work: 'on' });
  signIn(work, false);
  launch('w2', { project: null, acct: 'work', docs: true, fullSignIn: false, signInDir: work });
  (async () => {
    const r = await handler({}, { op: 'check', convIds: ['w1', 'w2', 'c1'] });
    check('the handler answers for several chats, one sign-in notice per account', r.ok && r.notices.filter((x) => x.kind === 'signin').length === 1, JSON.stringify(r));
    const bad = await handler({}, { op: 'other' });
    check('an unknown request is refused', bad.ok === false);
    console.log(`\n${pass}/${pass + fail} passed`);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
  })();
} catch (e) {
  check('no exception', false, e.stack);
  console.log(`\n${pass}/${pass + fail} passed`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
}
