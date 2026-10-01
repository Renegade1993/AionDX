#!/usr/bin/env node
/**
 * test-setup-cli.js - `aiondx setup scan` and `aiondx setup apply` (patch 0007 1.7.0), the commands the setup's
 * backup agent runs, on a made-up home folder: once with Node.js, once with no Node.js, where they must run the
 * scripts on an Electron app as Node (AionUi.exe on this PC stands in for AionDX.exe on a PC without Node).
 *
 *   node patches\0004-setup-butler\test-setup-cli.js     exit 0 only if every check passes
 *
 * Nothing outside a temp folder is read or written (--home is passed through to the scripts). Deadline 240 s.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

setTimeout(() => { console.log('DEADLINE: 240 s'); process.exit(2); }, 240000).unref();
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const SRC = path.join(__dirname, '..', '0007-loop-tool', 'aiondx-loop.cs');
const SCRIPTS = path.join(__dirname, 'skill', 'aiondx-setup', 'scripts');
const ELECTRON = path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'AionUi', 'AionUi.exe');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-setupcli-'));
const H = path.join(T, 'home');
const EXE = path.join(T, 'aiondx.exe');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']'}`); };
const put = (rel, text) => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

put('.claude/CLAUDE.md', '# Mine\nBe brief.\n');
put('.claude/agents/helper.md', 'helps');
put('.claude.json', JSON.stringify({ mcpServers: { notes: { command: 'notes-server', env: { NOTES_KEY: 'secret-value' } } } }));
put('.codex/AGENTS.md', '# Codex\nTabs.\n');

const run = (argv, extraEnv) => spawnSync(EXE, argv, { encoding: 'utf8', windowsHide: true, timeout: 200000,
  env: Object.assign({}, process.env, { AIONDX_SETUP_SCRIPTS: SCRIPTS, AIONDX_SETUP_STATE: path.join(T, 'state'), AIONDX_LOOP_LOG_DIR: T, AIONDX_LOOP_NO_ANCESTORS: '1' }, extraEnv || {}) });

try {
  const b = spawnSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${EXE}`, SRC], { encoding: 'utf8', windowsHide: true });
  check('aiondx.exe compiles', b.status === 0, b.stdout + b.stderr);

  let r = run(['setup', 'apply', '--all', '--home', H]);
  check('apply before any scan says to scan first', r.status === 1 && /Run aiondx setup scan first/.test(r.stdout), r.stdout);
  r = run(['setup', 'scan', '--home', H]);
  check('setup scan prints the survey summary for a person', r.status === 0 && /AionDX setup survey/.test(r.stdout) && /Claude Code:/.test(r.stdout) && !/secret-value/.test(r.stdout), r.stdout.slice(0, 500) + r.stderr);
  r = run(['setup', 'apply', '--all', '--skip', 'wire', '--prefs', 'Answer in English.', '--home', H]);
  check('setup apply --all prints what it did, the keys still needed and the report', r.status === 0 && /^AionDX setup: done\./.test(r.stdout) &&
    /Brought over: 2 instructions file\(s\), 1 agents/.test(r.stdout) && /Keys still needed: NOTES_KEY/.test(r.stdout) && /Report, with how to undo each change: /.test(r.stdout), r.stdout);
  check('--skip wire left the agents\' own files alone, and --prefs went to the top of AIONDX.md', fs.readFileSync(path.join(H, '.claude', 'CLAUDE.md'), 'utf8') === '# Mine\nBe brief.\n' &&
    /## My instructions for every agent\n\nAnswer in English\./.test(fs.readFileSync(path.join(H, '.aiondx', 'AIONDX.md'), 'utf8')));

  if (fs.existsSync(ELECTRON)) {
    fs.rmSync(path.join(H, '.aiondx'), { recursive: true, force: true });
    const noNode = { AIONDX_SETUP_NO_NODE: '1', AIONDX_SETUP_ELECTRON: ELECTRON };
    r = run(['setup', 'scan', '--home', H], noNode);
    check('with no Node.js, scan runs on the Electron app as Node', r.status === 0 && /AionDX setup survey/.test(r.stdout), r.stdout.slice(0, 400) + r.stderr.slice(0, 400));
    r = run(['setup', 'apply', '--all', '--home', H], noNode);
    check('and so does apply, writing into each agent\'s file', r.status === 0 && /^AionDX setup: done\./.test(r.stdout) &&
      /<!-- AionDX instructions: begin -->/.test(fs.readFileSync(path.join(H, '.claude', 'CLAUDE.md'), 'utf8')), r.stdout.slice(0, 600));
  } else console.log('SKIP  no AionUi.exe here to stand in for AionDX.exe');
  r = run(['setup', 'frob']);
  check('an unknown subcommand prints the usage', r.status === 2 && /aiondx setup scan/.test(r.stdout), r.stdout);
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* a process may still hold a file */ }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
