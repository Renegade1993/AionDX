'use strict';
// test-launcher.js - `aiondx launcher` (what `aiondx usage` and `usage alert` say when a chat has no reading): a real process chain built
// from stand-ins. node runs a file named claude-account-router.js, which starts a copy of node named claude.exe, which runs aiondx.exe.
// Three routers: an older hand-made one (no usage tap), AionDX's (it names claude-stream-proxy.js), and none (claude.exe started directly).
//
//   node patches\0007-loop-tool\test-launcher.js [path\to\aiondx.exe]     (default: builds one from aiondx-loop.cs into a temp folder)
//
// 90 s deadline; the temp folder is removed.
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 90000);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-launcher-test-'));
try {
  let exe = process.argv[2];
  if (!exe) {
    exe = path.join(root, 'aiondx.exe');
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/out:' + exe, path.join(__dirname, 'aiondx-loop.cs')], { cwd: root, windowsHide: true, timeout: 60000 });
  }
  const claude = path.join(root, 'claude.exe');
  fs.copyFileSync(process.execPath, claude);   // a process named claude.exe
  // What "Claude" does here: run aiondx.exe launcher and print what it said.
  const inner = path.join(root, 'inner.js');
  fs.writeFileSync(inner, "const r = require('child_process').spawnSync(process.argv[2], ['launcher'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); process.stdout.write(r.stdout || r.stderr || '');");
  const routerBody = (aiondx) => (aiondx ? "// starts claude-stream-proxy.js\n" : "// an older hand-made router\n") +
    "const r = require('child_process').spawnSync(process.argv[2], [process.argv[3], process.argv[4]], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); process.stdout.write(r.stdout || '');";
  const run = (dir, aiondx) => {
    fs.mkdirSync(dir, { recursive: true });
    const router = path.join(dir, 'claude-account-router.js');
    fs.writeFileSync(router, routerBody(aiondx));
    return spawnSync(process.execPath, [router, claude, inner, exe], { encoding: 'utf8', windowsHide: true, timeout: 40000 }).stdout || '';
  };

  let out = run(path.join(root, 'nodejs-bin'), false);
  check('an older router in the chain is named, and said not to read usage', /started by .*nodejs-bin\\claude-account-router\.js, an older launcher that is not AionDX's/.test(out), out);
  check('...with what to do about it, keeping the account mapping', /aiondx doctor/.test(out) && /account mapping/.test(out), out);
  out = run(path.join(root, 'aiondx-bin'), true);
  check("AionDX's router in the chain is recognised", /runs through AionDX's launcher \(.*aiondx-bin\\claude-account-router\.js\)/.test(out), out);
  out = spawnSync(claude, [inner, exe], { encoding: 'utf8', windowsHide: true, timeout: 40000 }).stdout || '';
  check('a claude.exe with no router above it is said to be started directly', /was started directly/.test(out), out);
  out = spawnSync(exe, ['launcher'], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: Object.assign({}, process.env) }).stdout || '';
  check('outside any Claude process it says so', /No Claude Code process was found above this one|runs through AionDX's launcher/.test(out), out);
} catch (e) {
  check('no exception', false, e.message);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* in use */ }
  clearTimeout(deadline);
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
