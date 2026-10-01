#!/usr/bin/env node
/**
 * probe-claude-stream.js - what Claude Code itself says on stdout, and what it accepts on stdin, in the mode AionCore
 * runs it in (--print, stream-json both ways, --permission-prompt-tool stdio). Two questions, one throwaway Haiku
 * session each, on the first account in the router config:
 *
 *   node tools\probe-claude-stream.js rate    does a normal turn print rate_limit_event frames, and what is in them
 *                                             (utilization per window, status, reset)? The usage meter can read these
 *                                             from the official client's own output instead of a separate API call.
 *   node tools\probe-claude-stream.js perm    in permission mode "default" a Bash command raises can_use_tool; answer it
 *                                             with {behavior:"allow", updatedInput:<its input>} the way the proxy will,
 *                                             and see the command run. Pass: the file the command writes exists.
 *
 * 150 s deadline; the child is killed on every exit path; the temp folder is removed. A few hundred tokens.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODE = process.argv[2] || 'rate';
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'npm', 'claude-account-router.config.json'), 'utf8'));
const acct = cfg.accounts[Object.keys(cfg.accounts).find((k) => /^[a-z]+$/.test(k))];
const EXE = path.join(path.dirname(path.dirname(process.env.APPDATA)), '.local', 'bin', 'claude.exe');
const cwd = path.join(process.env.TEMP, 'aiondx-stream-probe-' + Date.now().toString(36));
fs.mkdirSync(cwd, { recursive: true });
const env = Object.assign({}, process.env);
delete env.AIONUI_CONVERSATION_ID; delete env.ANTHROPIC_API_KEY;
env.CLAUDE_CONFIG_DIR = acct.configDir;
env.CLAUDE_SECURESTORAGE_CONFIG_DIR = acct.configDir;
const tok = acct.tokenFile && fs.existsSync(acct.tokenFile) ? fs.readFileSync(acct.tokenFile, 'utf8').trim() : '';
if (tok) { env.CLAUDE_CODE_OAUTH_TOKEN = tok; env.ANTHROPIC_AUTH_TOKEN = tok; }

const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
  '--session-id', crypto.randomUUID(), '--model', 'haiku', '--permission-prompt-tool', 'stdio',
  '--permission-mode', MODE === 'perm' ? 'default' : 'bypassPermissions'];
const child = spawn(EXE, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const types = {};
const found = { rate: [], ask: [], answered: false, results: 0, texts: [], toolResults: [] };
let buf = '';
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

function cleanup(code, msg) {
  if (msg) console.log(msg);
  try { child.kill(); } catch { /* gone */ }
  setTimeout(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* in use */ } process.exit(code); }, 600);
}
setTimeout(() => cleanup(2, 'DEADLINE'), 150000).unref();

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const k = j.type + (j.subtype ? '/' + j.subtype : '');
    types[k] = (types[k] || 0) + 1;
    if (j.type === 'rate_limit_event') found.rate.push(j);
    const lk = JSON.stringify(j).match(/"[A-Za-z_]*(?:limit|Limit|utiliz)[A-Za-z_]*"/g); if (lk && j.type !== 'rate_limit_event') (found.limitKeys = found.limitKeys || {})[k] = [...new Set(lk)].join(',');
    if (j.type === 'system' && j.subtype === 'init') console.log('init: permissionMode=' + j.permissionMode + ' model=' + j.model);
    if (j.type === 'control_request' && j.request && j.request.subtype === 'can_use_tool') {
      found.ask.push({ tool: j.request.tool_name, input: j.request.input, keys: Object.keys(j.request) });
      send({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'allow', updatedInput: j.request.input } } });
      found.answered = true;
    }
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const c of j.message.content) if (c.type === 'tool_result') found.toolResults.push(String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 120));
    }
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) for (const c of j.message.content) if (c.type === 'text') found.texts.push(c.text.slice(0, 80));
    if (j.type === 'result') {
      found.results++;
      report();
      cleanup(0);
    }
  }
});
child.stderr.on('data', () => {});
child.on('exit', () => { if (!found.results) { report(); cleanup(1, 'claude exited before a result'); } });

function report() {
  console.log('line types:', JSON.stringify(types));
  console.log('limit-ish keys per line type:', JSON.stringify(found.limitKeys || {}));
  if (MODE === 'rate') {
    console.log('rate_limit_event frames:', found.rate.length);
    for (const r of found.rate.slice(0, 3)) console.log('  ' + JSON.stringify(r).slice(0, 700));
  } else {
    console.log('can_use_tool requests:', JSON.stringify(found.ask.map((a) => ({ tool: a.tool, keys: a.keys, input: JSON.stringify(a.input).slice(0, 120) }))));
    console.log('answered:', found.answered, '| file written:', fs.existsSync(path.join(cwd, 'probe-out.txt')), '| tool results:', JSON.stringify(found.toolResults));
  }
  console.log('replies:', JSON.stringify(found.texts));
}

const prompt = MODE === 'perm'
  ? 'Use the Bash tool to run exactly: echo probe-ok > probe-out.txt . Then reply with the single word DONE.'
  : 'Reply with the single word OK. Do not use any tools.';
send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
