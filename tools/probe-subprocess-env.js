#!/usr/bin/env node
/**
 * probe-subprocess-env.js - which token variables does a command that Claude Code runs (a hook here; tools are started the same way) still
 * see? Offline by construction: the proxies point at a closed local port and the tokens are dummies. A SessionStart hook writes the names of
 * the variables it was given that look like secrets, and whether each holds the dummy.
 *
 *   node tools\probe-subprocess-env.js [path\to\claude.exe]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = process.argv[2] || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const DUMMY = 'sk-ant-oat01-' + 'q'.repeat(40);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-subenv-'));
const cfg = path.join(scratch, 'config'); fs.mkdirSync(cfg);
const out = path.join(scratch, 'hook-env.json');
const hookJs = path.join(scratch, 'hook.js');
fs.writeFileSync(hookJs, "const fs=require('fs');const o={};for(const k of Object.keys(process.env)){if(/TOKEN|AUTH|KEY|SECRET/i.test(k))o[k]=process.env[k]===" + JSON.stringify(DUMMY) + "?'the token':'other'}fs.writeFileSync(" + JSON.stringify(out) + ",JSON.stringify(o));");
const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"' + process.execPath + '" "' + hookJs + '"' }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"' + process.execPath + '" "' + hookJs + '"' }] }] } };
fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(settings));
const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg, CLAUDE_SECURESTORAGE_CONFIG_DIR: cfg, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_OAUTH_TOKEN: DUMMY, ANTHROPIC_AUTH_TOKEN: DUMMY });
delete env.AIONUI_CONVERSATION_ID; delete env.ANTHROPIC_API_KEY;
const child = spawn(EXE, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let done = false;
const end = (why) => {
  if (done) return; done = true;
  let r = null; try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { /* none */ }
  console.log(why + ': ' + (r ? JSON.stringify(r) : 'the hook did not run'));
  try { child.kill(); } catch (e) {}
  setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {} process.exit(0); }, 400);
};
const poll = setInterval(() => { if (fs.existsSync(out)) { clearInterval(poll); setTimeout(() => end('hook ran'), 300); } }, 250);
setTimeout(() => end('timeout'), 45000);
child.on('exit', () => setTimeout(() => end('claude exited'), 500));
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
