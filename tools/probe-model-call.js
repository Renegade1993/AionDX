#!/usr/bin/env node
// probe-model-call.js MODEL [configDir] [tokenFile] - one one-word call to MODEL, signed in as an AionDX chat is (config folder + token
// file). Prints the answer, which model answered and the cost. Proves a model is usable on an account, not only listed.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const [model, dir = path.join(os.homedir(), '.claude'), tokenFile = path.join(os.homedir(), '.claude', 'personal-token.txt')] = process.argv.slice(2);
const env = Object.assign({}, process.env);
for (const k of Object.keys(env)) if (/^AIONDX_|^CLAUDE_CODE_ENTRYPOINT$|^CLAUDECODE$|^ANTHROPIC_|^CLAUDE_CONFIG_DIR$|^CLAUDE_CODE_OAUTH_TOKEN$/i.test(k)) delete env[k];
env.CLAUDE_CONFIG_DIR = dir;
env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-probe-call-'));
const r = spawnSync(path.join(os.homedir(), '.local', 'bin', 'claude.exe'), ['-p', 'Reply with only the word OK', '--model', model, '--output-format', 'json', '--max-turns', '1'],
  { env, cwd: work, encoding: 'utf8', windowsHide: true, timeout: 120000 });
try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* in use */ }
try {
  const j = JSON.parse(r.stdout);
  console.log('result: ' + j.result + ' | is_error: ' + j.is_error + ' | answered by: ' + Object.keys(j.modelUsage || {}).join(',') + ' | cost $' + j.total_cost_usd);
} catch (e) { console.log('exit ' + r.status + ' ' + String(r.stdout).slice(0, 400) + ' ' + String(r.stderr).slice(0, 400)); }
