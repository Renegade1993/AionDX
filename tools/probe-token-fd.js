#!/usr/bin/env node
/**
 * probe-token-fd.js - does Claude Code take its OAuth token from an inherited pipe (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) on Windows, and
 * which variables does a tool it runs still see? Offline by construction: HTTPS_PROXY and HTTP_PROXY point at a closed local port, so no
 * request can leave the machine, and the token is a dummy. Answers from `initialize` (account.tokenSource) only; no model call is made.
 *
 *   node tools\probe-token-fd.js [path\to\claude.exe]
 *
 * 40 s deadline per launch; scratch folders are removed.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = process.argv[2] || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const DUMMY = 'sk-ant-oat01-' + 'x'.repeat(40);

function launch(label, envExtra, useFd) {
  return new Promise((resolve) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-fd-'));
    const cfg = path.join(scratch, 'config'); fs.mkdirSync(cfg);
    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg, CLAUDE_SECURESTORAGE_CONFIG_DIR: cfg, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, envExtra);
    for (const k of ['AIONUI_CONVERSATION_ID', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) if (!(k in envExtra)) delete env[k];
    const stdio = useFd ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
    const child = spawn(EXE, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: scratch, env, stdio, windowsHide: true });
    if (useFd) { child.stdio[3].end(DUMMY); }
    let buf = '', done = false;
    const end = (v) => { if (done) return; done = true; try { child.kill(); } catch (e) {} setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {} resolve(v); }, 300); };
    setTimeout(() => end({ label, answer: 'no answer in 40 s' }), 40000);
    child.on('exit', () => end({ label, answer: 'exited: ' + buf.slice(-200) }));
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.type === 'control_response') end({ label, answer: JSON.stringify((j.response.response || {}).account || j.response) });
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'i', request: { subtype: 'initialize' } }) + '\n');
  });
}

(async () => {
  console.log(await launch('no token', {}, false));
  console.log(await launch('CLAUDE_CODE_OAUTH_TOKEN', { CLAUDE_CODE_OAUTH_TOKEN: DUMMY }, false));
  console.log(await launch('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_TOKEN: DUMMY }, false));
  console.log(await launch('fd 3', { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' }, true));
  process.exit(0);
})();
