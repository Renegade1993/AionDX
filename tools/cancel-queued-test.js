#!/usr/bin/env node
/**
 * cancel-queued-test.js - does Claude Code drop a queued mid-turn message when told
 * `cancel_async_message`, in the mode AionCore runs it in (--print, stream-json in and out,
 * --replay-user-messages)? Step 0 for "unsend a message the agent has not read yet".
 *
 * A throwaway Haiku session on the first account in the router config: turn 1 asks it to run a 25-second sleep;
 * while that runs, a second message (uuid X) arrives mid-turn, and then a control_request
 * cancel_async_message for X. Pass: the control response says cancelled, a command_lifecycle
 * 'cancelled' frame names X, and the codeword in X never appears in any reply.
 *
 *   node tools\cancel-queued-test.js
 *
 * 240 s deadline; the child is killed on every exit path; the temp folder and the session's
 * project folder are removed.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'npm', 'claude-account-router.config.json'), 'utf8'));
const acct = cfg.accounts[Object.keys(cfg.accounts).find((k) => /^[a-z]+$/.test(k))];
const EXE = path.join(path.dirname(path.dirname(process.env.APPDATA)), '.local', 'bin', 'claude.exe');
const cwd = path.join(process.env.TEMP, 'aiondx-cancel-test-' + Date.now().toString(36));
fs.mkdirSync(cwd, { recursive: true });
const env = Object.assign({}, process.env);
delete env.AIONUI_CONVERSATION_ID; delete env.ANTHROPIC_API_KEY;
env.CLAUDE_CONFIG_DIR = acct.configDir;
env.CLAUDE_SECURESTORAGE_CONFIG_DIR = acct.configDir;
const tok = acct.tokenFile && fs.existsSync(acct.tokenFile) ? fs.readFileSync(acct.tokenFile, 'utf8').trim() : '';
if (tok) { env.CLAUDE_CODE_OAUTH_TOKEN = tok; env.ANTHROPIC_AUTH_TOKEN = tok; }

const session = crypto.randomUUID();
const X = crypto.randomUUID();
const CODE = 'BANANA-' + Math.floor(1000 + Math.random() * 9000);
const child = spawn(EXE, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--replay-user-messages', '--session-id', session, '--model', 'haiku', '--permission-mode', 'bypassPermissions'],
  { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = [];
let buf = '';
const events = { lifecycle: [], controlResponse: null, results: 0, texts: [] };
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    lines.push(line);
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'control_response' && j.response && j.response.request_id === 'aiondx-test-1') events.controlResponse = j.response;
    if (j.type === 'system' && j.subtype === 'command_lifecycle') events.lifecycle.push({ uuid: j.uuid || (j.command && j.command.uuid), phase: j.phase || j.state || j.status, raw: line.slice(0, 200) });
    if (j.type === 'result') events.results++;
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const c of j.message.content) if (c.type === 'text') events.texts.push(c.text);
    }
  }
});
child.stderr.on('data', () => {});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const user = (text, uuid) => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session, uuid });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function done(code) {
  try { child.kill(); } catch { /* gone */ }
  for (const d of [acct.configDir]) {
    const root = path.join(d, 'projects');
    try { for (const sub of fs.readdirSync(root)) if (/aiondx-cancel-test/.test(sub)) fs.rmSync(path.join(root, sub), { recursive: true, force: true }); } catch { /* none */ }
  }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(code);
}
setTimeout(() => { console.log('DEADLINE'); done(2); }, 240000);

(async () => {
  user('Run this exact shell command with your Bash tool and wait for it: sleep 25 . Then reply with the single word DONE.', crypto.randomUUID());
  // Wait until the tool call is running.
  for (let i = 0; i < 60 && !lines.some((l) => /"tool_use"/.test(l)); i++) await sleep(500);
  console.log('tool call seen:', lines.some((l) => /"tool_use"/.test(l)));
  user(`Also, reply with the codeword ${CODE} in your next message.`, X);
  await sleep(1500);
  send({ type: 'control_request', request_id: 'aiondx-test-1', request: { subtype: 'cancel_async_message', message_uuid: X } });
  for (let i = 0; i < 20 && !events.controlResponse; i++) await sleep(500);
  console.log('control response:', JSON.stringify(events.controlResponse));
  // Let the turn finish, and any follow-up turn that X would have opened.
  for (let i = 0; i < 120 && events.results < 1; i++) await sleep(500);
  await sleep(8000);
  const mentioned = events.texts.some((t) => t.includes(CODE)) || lines.some((l) => l.includes(CODE) && /"type":"assistant"/.test(l));
  const lc = lines.filter((l) => /command_lifecycle/.test(l) && l.includes(X)).map((l) => l.slice(0, 260));
  console.log('lifecycle frames for X:', lc.length ? lc.join('\n   ') : '(none)');
  console.log('results:', events.results, '| replies:', JSON.stringify(events.texts).slice(0, 300));
  console.log(!mentioned && events.controlResponse && !/error/i.test(JSON.stringify(events.controlResponse))
    ? 'VERDICT: the queued message was dropped before the agent read it' : 'VERDICT: not dropped (see above)');
  done(0);
})().catch((e) => { console.log('ERROR', e.message); done(1); });
