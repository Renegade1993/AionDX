#!/usr/bin/env node
/**
 * probe-claude-login.js - can AionDX drive Claude Code's own sign-in (`claude auth login`, `claude setup-token`) through pipes, so a button
 * in AionDX opens the sign-in page and takes the code back, with no terminal? Offline by construction: the proxies point at a closed local
 * port, so the sign-in cannot finish and nothing leaves the PC. Prints what the CLI wrote in its first seconds (a URL is masked to its host
 * and path), then kills it. A scratch config folder; nothing of the real sign-in is touched.
 *
 *   node tools\probe-claude-login.js [login|setup-token]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const which = process.argv[2] || 'login';
const EXE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-login-'));
const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: scratch, CLAUDE_SECURESTORAGE_CONFIG_DIR: scratch, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
  BROWSER: 'none', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AIONUI_CONVERSATION_ID']) delete env[k];
const argv = which === 'setup-token' ? ['setup-token'] : ['auth', 'login', '--claudeai'];
const child = spawn(EXE, argv, { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let out = '';
const mask = (s) => s.replace(/https?:\/\/[^\s"']+/g, (u) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?<' + [...x.searchParams.keys()].join(',') + '>' : ''); } catch (e) { return '<url>'; } });
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
setTimeout(() => {
  console.log('--- ' + argv.join(' ') + ' (piped, offline), first 12 s:');
  console.log(mask(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(0, 2500) || '(nothing)');
  console.log('--- still running: ' + (child.exitCode === null));
  try { child.kill(); } catch (e) { /* gone */ }
  setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* in use */ } process.exit(0); }, 500);
}, 12000);
