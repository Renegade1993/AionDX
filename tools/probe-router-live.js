#!/usr/bin/env node
/**
 * probe-router-live.js - one throwaway Haiku turn through the INSTALLED account router, the way AionCore launches
 * Claude (--print, stream-json both ways), to show that what is installed in %APPDATA%\npm works end to end:
 * Claude answers, the proxy's usage tap saw the call, and (with the AIONUI_* variables of an AionUi agent shell, and
 * the Loop tool installed) `aiondx usage` then reports this chat's usage from it.
 *
 *   node tools\probe-router-live.js
 *
 * 120 s deadline; the child is killed on every exit path. About a hundred tokens of Haiku on the account this chat
 * runs on. Prints no token and no credentials.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROUTER = path.join(process.env.APPDATA, 'npm', 'claude-account-router.js');
const cwd = path.join(process.env.TEMP, 'aiondx-router-probe-' + Date.now().toString(36));
fs.mkdirSync(cwd, { recursive: true });
const args = [ROUTER, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
  '--session-id', crypto.randomUUID(), '--model', 'haiku', '--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions'];
const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '', answer = '', result = null, err = '';
const done = (code) => {
  try { child.kill(); } catch (e) { /* already gone */ }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(code);
};
const timer = setTimeout(() => { console.log('FAIL: no answer within 120 s'); done(1); }, 120000);
child.stderr.on('data', (d) => { err += d.toString('utf8'); });
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) o.message.content.forEach((c) => { if (c.type === 'text') answer += c.text; });
    if (o.type === 'result') { result = o; clearTimeout(timer); finish(); }
  }
});
child.on('exit', (c) => { if (!result) { console.log('FAIL: Claude exited ' + c + ' before answering. ' + err.slice(0, 300)); clearTimeout(timer); done(1); } });
function finish() {
  const ok = /READY/i.test(answer) && !result.is_error;
  console.log((ok ? 'PASS' : 'FAIL') + ': Claude answered through the installed router: ' + JSON.stringify(answer.slice(0, 60)) + (result.is_error ? ' (error result)' : ''));
  if (ok) {
    const exe = path.join(process.env.LOCALAPPDATA || '', 'AionDX', 'bin', 'aiondx.exe');
    if (fs.existsSync(exe) && process.env.AIONUI_BASE_URL) {
      setTimeout(() => {
        const r = spawnSync(exe, ['usage'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
        console.log('aiondx usage says:\n' + String(r.stdout || r.stderr).trim());
        done(0);
      }, 1500);
      return;
    }
  }
  done(ok ? 0 : 1);
}
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply with the single word READY.' }] } }) + '\n');
