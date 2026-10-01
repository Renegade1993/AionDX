#!/usr/bin/env node
/**
 * Tests for the claude.exe shim (patch 0005). Run: node patches\0005-claude-exe-shim\test-shim.js
 *
 * Compiles claude-shim.cs into a temp folder beside a fake claude-account-router.js, starts it the
 * way AionUi's backend does (CreateProcess with an argument list, no shell, hidden, piped stdio) and
 * checks what the fake router received:
 *   ARGUMENTS   every argument arrives intact, including one with line breaks, one with quotes,
 *               a trailing backslash, an empty string, spaces, and everything AFTER the multi-line
 *               one (--permission-mode, --mcp-config): the exact arguments cmd.exe was losing
 *   STDIO       stdin reaches the router and its stdout and stderr come back (stream-json runs
 *               over these pipes)
 *   EXIT CODE   the router's exit code is the shim's
 *   ENVIRONMENT the environment is inherited (AIONUI_CONVERSATION_ID is how the router routes)
 * And, as the control, that cmd.exe really does cut the same arguments at the line break.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const SRC = path.join(__dirname, 'claude-shim.cs');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '   ' + String(detail).slice(0, 400) : '')); } };
setTimeout(() => { console.log('DEADLINE: shim tests did not finish in 150 s'); process.exit(2); }, 150000).unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-shim-'));
const exe = path.join(tmp, 'claude.exe');
const out = path.join(tmp, 'received.json');
execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/out:' + exe, SRC], { windowsHide: true, stdio: 'pipe' });
check('the shim compiles', fs.existsSync(exe));

fs.writeFileSync(path.join(tmp, 'claude-account-router.js'), `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.SHIM_TEST_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: input, conv: process.env.AIONUI_CONVERSATION_ID }));
  process.stdout.write('OUT:' + input);
  process.stderr.write('ERR');
  process.exit(7);
});
`);

const ARGS = [
  '--print', '--input-format', 'stream-json',
  '--append-system-prompt', 'Team Lead Model Assignment lives in ~/.claude/CLAUDE.md\nsecond line\n\nfourth line after a blank',
  '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
  '--plugin-dir', 'C:\\Users\\Someone\\AppData\\Roaming\\AionUi\\session-skills\\u\\c',
  '--mcp-config', '{"mcpServers":{"team":{"command":"C:\\\\aioncore.exe","args":["mcp-team-stdio"]}}}',
  'has "quotes" inside', 'trailing backslash\\', '', 'two  spaces',
];

function runShim() {
  return new Promise((resolve) => {
    const child = spawn(exe, ARGS, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { SHIM_TEST_OUT: out, AIONUI_CONVERSATION_ID: 'conv1234' }) });
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('close', (code) => resolve({ code, so, se }));
    child.stdin.end('{"type":"user"}\n');
  });
}

(async () => {
  const r = await runShim();
  let got = null;
  try { got = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { check('the router ran and wrote what it received', false, e.message); }
  if (got) {
    check('every argument arrives intact, in order', JSON.stringify(got.argv) === JSON.stringify(ARGS), JSON.stringify(got.argv));
    const i = got.argv.indexOf('--permission-mode');
    check('--permission-mode survives the multi-line prompt', i > 0 && got.argv[i + 1] === 'bypassPermissions');
    check('--mcp-config and --plugin-dir survive too', got.argv.includes('--mcp-config') && got.argv.includes('--plugin-dir'));
    check('the multi-line prompt keeps all its lines', got.argv[4].split('\n').length === 4);
    check('stdin reaches the router', got.stdin === '{"type":"user"}\n');
    check('environment is inherited', got.conv === 'conv1234');
  }
  check("the router's stdout and stderr come back", r.so === 'OUT:{"type":"user"}\n' && r.se === 'ERR', JSON.stringify(r));
  check("the router's exit code is the shim's", r.code === 7, r.code);

  // Control: the same launch through cmd.exe, the way the .cmd shim was reached, loses the tail.
  const cmdFile = path.join(tmp, 'claude.cmd');
  fs.writeFileSync(cmdFile, '@echo off\r\nnode "%~dp0claude-account-router.js" %*\r\n');
  fs.rmSync(out, { force: true });
  await new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/c', cmdFile].concat(ARGS), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { SHIM_TEST_OUT: out }) });
    child.on('close', resolve);
    child.stdin.end('x');
  });
  let viaCmd = null;
  try { viaCmd = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { viaCmd = null; }
  check('control: through cmd.exe the arguments after the line break are lost',
    viaCmd === null || !viaCmd.argv.includes('--permission-mode'), viaCmd && JSON.stringify(viaCmd.argv));

  // Which Node runs the router (bug sweep, September 26th): the first one new enough for node:sqlite
  // (22.13), node-v* folders compared by number, the standalone app's own copy found when a PC has
  // nothing else, and an old Node used only when there is no other. Stand-in node.exe builds carry the
  // version in their version resource, which is all the shim reads, and write their name when run.
  // Windows resets ProgramFiles when a 64-bit process starts, so an override in the environment never
  // reaches the shim; these cases run a copy built to read SHIM_TEST_PROGRAMFILES in that one place.
  const shimSrc = fs.readFileSync(SRC, 'utf8');
  const PF_READ = 'Environment.GetEnvironmentVariable("ProgramFiles")';
  check('the shim reads ProgramFiles in exactly one place', shimSrc.split(PF_READ).length === 2, shimSrc.split(PF_READ).length - 1);
  const pfSrc = path.join(tmp, 'claude-shim-pf.cs');
  const pfExe = path.join(tmp, 'claude-pf.exe');
  fs.writeFileSync(pfSrc, shimSrc.replace(PF_READ, 'Environment.GetEnvironmentVariable("SHIM_TEST_PROGRAMFILES")'));
  execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/out:' + pfExe, pfSrc], { windowsHide: true, stdio: 'pipe' });
  const stub = (ver, who) => {
    const src = path.join(tmp, `stub-${who}.cs`);
    const dst = path.join(tmp, `stub-${who}.exe`);
    fs.writeFileSync(src, `using System; using System.IO; using System.Reflection;
[assembly: AssemblyFileVersion("${ver}.0")]
static class P { static int Main() { File.WriteAllText(Environment.GetEnvironmentVariable("SHIM_TEST_OUT"), "${who}"); return 0; } }`);
    execFileSync(CSC, ['/nologo', '/target:exe', '/out:' + dst, src], { windowsHide: true, stdio: 'pipe' });
    return dst;
  };
  const OLD = stub('20.18.0', 'v20.18'), MID = stub('24.9.0', 'v24.9'), NEW = stub('24.11.0', 'v24.11');
  const envWith = (over) => {
    const e = {};
    for (const [k, v] of Object.entries(process.env)) if (!Object.keys(over).some((o) => o.toLowerCase() === k.toLowerCase())) e[k] = v;
    return Object.assign(e, over);
  };
  async function whichNode(layout) {
    const root = fs.mkdtempSync(path.join(tmp, 'n-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(pfExe, path.join(bin, 'claude.exe'));
    fs.writeFileSync(path.join(bin, 'claude-account-router.js'), '');
    for (const [rel, file] of layout) {
      const where = path.join(root, rel);
      fs.mkdirSync(path.dirname(where), { recursive: true });
      fs.copyFileSync(file, where);
    }
    fs.rmSync(out, { force: true });
    const env = envWith({ SHIM_TEST_OUT: out, SHIM_TEST_PROGRAMFILES: path.join(root, 'pf'), APPDATA: path.join(root, 'appdata'),
      LOCALAPPDATA: path.join(root, 'local'), PATH: path.join(root, 'path') });
    await new Promise((resolve) => {
      const child = spawn(path.join(bin, 'claude.exe'), ['--version'], { windowsHide: true, stdio: 'ignore', env });
      child.on('close', resolve);
    });
    try { return fs.readFileSync(out, 'utf8'); } catch { return null; }
  }
  const RUNTIME = 'appdata/AionUi/aionui/runtime/node/';
  const OWN_APP = 'local/Programs/AionDX/resources/bundled-aioncore/win32-x64/managed-resources/node/';
  let who = await whichNode([['pf/nodejs/node.exe', OLD], [RUNTIME + 'node-v24.9.0-win-x64/node.exe', MID], [RUNTIME + 'node-v24.11.0-win-x64/node.exe', NEW]]);
  check("Node 20 in Program Files is passed over for AionUi's own, and v24.11 beats v24.9 by number", who === 'v24.11', who);
  who = await whichNode([[OWN_APP + 'node-v24.11.0-win-x64/node.exe', NEW]]);
  check("with no other Node, the standalone app's bundled copy runs the router", who === 'v24.11', who);
  who = await whichNode([['pf/nodejs/node.exe', OLD]]);
  check('with only an old Node, it is still used, so Claude starts', who === 'v20.18', who);
  who = await whichNode([['pf/nodejs/node.exe', NEW], [RUNTIME + 'node-v24.9.0-win-x64/node.exe', MID]]);
  check('a new enough Node.js in Program Files keeps first place', who === 'v24.11', who);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed: ' + (e && e.stack || e)); process.exit(1); });
