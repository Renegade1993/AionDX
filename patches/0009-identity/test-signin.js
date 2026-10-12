'use strict';
// test-signin.js - the main process's aiondx:signin (patches/0009-identity), run on its own: the block is taken out of apply.js's helper,
// given a stand-in electron, and pointed at a stand-in Claude Code (a small program named claude.exe that runs a script that
// acts like `claude auth login` and `claude auth status --json`). No network, nothing real is signed in.
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 90000);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-signin-test-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
// claude.exe: a small program that runs "node fake-claude.js <its arguments>" with its own input and output.
const cs = path.join(root, 'stand-in.cs');
fs.writeFileSync(cs, 'using System; using System.Diagnostics; using System.Linq; static class P { static int Main(string[] a) { ' +
  'var psi = new ProcessStartInfo(' + JSON.stringify(process.execPath) + ', "\\"" + ' + JSON.stringify(path.join(root, 'fake-claude.js')) + ' + "\\" " + string.Join(" ", a.Select(x => "\\"" + x + "\\""))) { UseShellExecute = false }; ' +
  'var p = Process.Start(psi); p.WaitForExit(); return p.ExitCode; } }');
require('child_process').execFileSync(path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  ['/nologo', '/target:exe', '/out:' + path.join(bin, 'claude.exe'), cs], { cwd: root, windowsHide: true, timeout: 60000 });
const fake = path.join(root, 'fake-claude.js');
const state = path.join(root, 'signed-in.json');
fs.writeFileSync(fake, `
const fs = require('fs');
const a = process.argv.slice(2);
const st = ${JSON.stringify(state)};
if (a[0] === 'auth' && a[1] === 'status') {
  const s = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, 'utf8')) : null;
  process.stdout.write(JSON.stringify(s ? { loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'Example', subscriptionType: 'pro', configDirectory: process.env.CLAUDE_CONFIG_DIR || '' } : { loggedIn: false, authMethod: 'none' }));
  process.exit(s ? 0 : 1);
}
if (a[0] === 'auth' && a[1] === 'login') {
  fs.writeFileSync(${JSON.stringify(path.join(root, 'login-env.json'))}, JSON.stringify({ dir: process.env.CLAUDE_CONFIG_DIR || null, tok: process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || null }));
  process.stdout.write('\\x1b[2KOpening browser to sign in…\\nIf the browser didn\\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; if (buf.indexOf('\\n') >= 0) { if (buf.trim() === 'GOOD-CODE') { fs.writeFileSync(st, '{}'); process.stdout.write('Login successful.\\n'); process.exit(0); } process.stdout.write('Invalid code\\n'); process.exit(1); } });
  return;
}
process.exit(3);
`);

// The block, out of the template it lives in.
const src = fs.readFileSync(path.join(__dirname, 'apply.js'), 'utf8');
const m = /const HELPER = `([\s\S]*?)\n`;/.exec(src);
const HELPER_BEGIN = '/* B', HELPER_END = '/* E */';
const body = eval('`' + m[1] + '`');
const k = body.indexOf('(function __aiondxSignin');
const block = body.slice(k, body.indexOf(HELPER_END, k));
const handlers = {};
const electron = { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
process.env.PATH = bin + path.delimiter + process.env.PATH;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited';
new Function('path__namespace', 'fs__namespace', 'require$$0$2', 'require', block)(path, fs, electron, require);
const call = (req) => handlers['aiondx:signin'](null, req);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    check('the handler is registered', typeof handlers['aiondx:signin'] === 'function');
    let r = await call({ op: 'status', agent: 'claude' });
    check('status before: Claude Code installed, not signed in', r.ok && r.installed && r.loggedIn === false, JSON.stringify(r));
    r = await call({ op: 'start', agent: 'claude' });
    check('start returns the sign-in link Claude Code printed', r.ok && r.url === 'https://claude.com/cai/oauth/authorize?code=true&state=abc', JSON.stringify(r));
    const le = JSON.parse(fs.readFileSync(path.join(root, 'login-env.json'), 'utf8'));
    check("no inherited token reaches the sign-in (it would sign in as that token)", le.tok === null, JSON.stringify(le));
    r = await call({ op: 'start', agent: 'claude' });
    check('a second start while one is going is refused', r.ok === false && /already going/.test(r.error), JSON.stringify(r));
    r = await call({ op: 'poll' });
    check('poll: running', r.state === 'running', JSON.stringify(r));
    r = await call({ op: 'code', code: 'two\nlines' });
    check('a code with a line break is refused', r.ok === false, JSON.stringify(r));
    r = await call({ op: 'code', code: 'GOOD-CODE' });
    check('a code is passed on', r.ok, JSON.stringify(r));
    for (let i = 0; i < 20 && (await call({ op: 'poll' })).state === 'running'; i++) await sleep(150);
    r = await call({ op: 'poll' });
    check('poll: done after a good code', r.state === 'done' && /Login successful/.test(r.text) && !/\x1b/.test(r.text), JSON.stringify(r));
    r = await call({ op: 'status', agent: 'claude' });
    check('status after: signed in, with the account it says', r.loggedIn === true && r.email === 'someone@example.com' && r.plan === 'pro', JSON.stringify(r));
    fs.unlinkSync(state);
    r = await call({ op: 'start', agent: 'claude', account: 'second' });
    const le2 = JSON.parse(fs.readFileSync(path.join(root, 'login-env.json'), 'utf8'));
    check('a second account signs in to its own folder, %USERPROFILE%\.claude-<name>', r.ok && le2.dir === path.join(os.homedir(), '.claude-second'), JSON.stringify([r, le2]));
    r = await call({ op: 'code', code: 'BAD' });
    for (let i = 0; i < 20 && (await call({ op: 'poll' })).state === 'running'; i++) await sleep(150);
    r = await call({ op: 'poll' });
    check('a bad code: failed, with what Claude Code said', r.state === 'failed' && /Invalid code/.test(r.text), JSON.stringify(r));
    try { fs.rmdirSync(path.join(os.homedir(), '.claude-second')); } catch (e) { /* not empty: left */ }
    r = await call({ op: 'start', agent: 'claude', account: '..\\..\\Windows' });
    check('an account name that is not a short word is refused (no folder outside the profile)', r.ok === false && /short word/.test(r.error), JSON.stringify(r));
    const rdir = path.join(root, 'router'); fs.mkdirSync(rdir); process.env.AIONDX_ROUTER_DIR = rdir;
    fs.writeFileSync(path.join(rdir, 'claude-account-router.config.json'), JSON.stringify({ database: 'x', accounts: { personal: { label: 'Personal', configDir: 'C:/p', tokenFile: 'C:/t' } } }));
    r = await call({ op: 'register', agent: 'claude', account: 'second', label: 'Second (Pro)' });
    const cfg = JSON.parse(fs.readFileSync(path.join(rdir, 'claude-account-router.config.json'), 'utf8'));
    check("register adds the account to the launcher's list, keeping the others", r.ok && cfg.accounts.second.configDir === path.join(os.homedir(), '.claude-second') && cfg.accounts.second.label === 'Second (Pro)' && cfg.accounts.personal.tokenFile === 'C:/t' && cfg.database === 'x', JSON.stringify(cfg));
    check('...with a copy of the old list kept', fs.existsSync(path.join(rdir, 'claude-account-router.config.json.bak-signin')));
    fs.writeFileSync(path.join(rdir, 'claude-account-router.config.json'), '{ broken');
    r = await call({ op: 'register', agent: 'claude', account: 'third' });
    check('a launcher config that is not JSON is left alone', r.ok === false && fs.readFileSync(path.join(rdir, 'claude-account-router.config.json'), 'utf8') === '{ broken', JSON.stringify(r));
    r = await call({ op: 'start', agent: 'codex' });
    check('another agent is not started here (yet)', r.ok === false, JSON.stringify(r));
    r = await call({ op: 'start', agent: 'claude' });
    r = await call({ op: 'cancel' });
    await sleep(400);
    r = await call({ op: 'poll' });
    check('cancel ends a sign-in', r.state === 'failed', JSON.stringify(r));
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* in use */ }
    clearTimeout(deadline);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
