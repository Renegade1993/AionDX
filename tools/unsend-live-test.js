#!/usr/bin/env node
/**
 * unsend-live-test.js - Unsend end to end with the real pieces: a real Claude (throwaway Haiku
 * session, first configured account) launched through a scratch copy of the account router and its
 * pass-through, the real AionUi settings store, and the real API.
 *
 * Turn 1 runs a 25-second sleep; a second message (uuid X, carrying a codeword) arrives mid-turn;
 * then aiondx.unsend.req.X goes into the store the way the renderer's Unsend button writes it. Pass:
 * the router answers aiondx.unsend.result.X = {cancelled: true} in the store, AionCore's side of the
 * stream never sees the router's own control_response, and the codeword never appears in a reply.
 *
 *   node tools\unsend-live-test.js
 *
 * Needs AionUi running and an agent shell's AIONUI_* variables (the chat id is this shell's own, so
 * its runtime token is accepted). 240 s deadline; the child is killed on every exit path; the store
 * keys, the scratch router and the session's project folder are removed.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NPM = path.join(process.env.APPDATA, 'npm');
const PATCH = path.join(__dirname, '..', 'patches', '0002-claude-model-currency');
const scratch = fs.mkdtempSync(path.join(process.env.TEMP, 'aiondx-unsend-live-'));
for (const f of ['claude-account-router.js', 'claude-stream-proxy.js']) fs.copyFileSync(path.join(PATCH, f), path.join(scratch, f));
fs.copyFileSync(path.join(NPM, 'claude-account-router.config.json'), path.join(scratch, 'claude-account-router.config.json'));
const cwd = fs.mkdtempSync(path.join(process.env.TEMP, 'aiondx-unsend-cwd-'));
const conv = process.env.AIONUI_CONVERSATION_ID;
const base = (process.env.AIONUI_BASE_URL || '').replace(/\/+$/, '');
const hdr = { 'Content-Type': 'application/json', 'x-aionui-runtime-token': process.env.AIONUI_RUNTIME_TOKEN || '',
  'x-aionui-user-id': process.env.AIONUI_USER_ID || '', 'x-aionui-conversation-id': conv || '' };
if (!conv || !base) { console.log('needs an agent shell (AIONUI_* variables)'); process.exit(2); }
const api = (method, p, body) => fetch(base + p, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const session = crypto.randomUUID();
const X = crypto.randomUUID();
const CODE = 'MANGO-' + Math.floor(1000 + Math.random() * 9000);
const child = spawn(process.execPath, [path.join(scratch, 'claude-account-router.js'), '--print', '--input-format', 'stream-json',
  '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--session-id', session, '--model', 'haiku',
  '--permission-mode', 'bypassPermissions'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lines.push(l); }
});
child.stderr.on('data', () => {});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const user = (text, uuid) => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session, uuid });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cleanup(code) {
  try { child.kill(); } catch { /* gone */ }
  try { await api('PUT', '/api/settings/client', { ['aiondx.unsend.req.' + X]: null, ['aiondx.unsend.result.' + X]: null }); } catch { /* best effort */ }
  const root = path.join(process.env.USERPROFILE, '.claude', 'projects');
  try { for (const sub of fs.readdirSync(root)) if (/aiondx-unsend-cwd/.test(sub)) fs.rmSync(path.join(root, sub), { recursive: true, force: true }); } catch { /* none */ }
  for (const d of [scratch, cwd]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  process.exit(code);
}
setTimeout(() => { console.log('DEADLINE'); cleanup(2); }, 240000);

(async () => {
  user('Run this exact shell command with your Bash tool and wait for it to finish: sleep 25 . Then reply with the single word DONE.', crypto.randomUUID());
  for (let i = 0; i < 80 && !lines.some((l) => /"tool_use"/.test(l)); i++) await sleep(500);
  console.log('tool call running:', lines.some((l) => /"tool_use"/.test(l)));
  user(`Also, put the codeword ${CODE} in your next reply.`, X);
  for (let i = 0; i < 20 && !lines.some((l) => l.includes(X) && /"queued"/.test(l)); i++) await sleep(250);
  console.log('Claude queued it:', lines.some((l) => l.includes(X) && /"queued"/.test(l)));
  const t0 = Date.now();
  await api('PUT', '/api/settings/client', { ['aiondx.unsend.req.' + X]: { conv, messageId: 'live-test', at: Date.now() } });
  let result = null;
  for (let i = 0; i < 40 && !result; i++) {
    await sleep(250);
    const d = await api('GET', '/api/settings/client?keys=aiondx.unsend.result.' + X);
    result = d && d.data && d.data['aiondx.unsend.result.' + X];
  }
  console.log('store answer after', Date.now() - t0, 'ms:', JSON.stringify(result));
  const req = await api('GET', '/api/settings/client?keys=aiondx.unsend.req.' + X);
  console.log('request key removed:', !(req && req.data && req.data['aiondx.unsend.req.' + X]));
  for (let i = 0; i < 120 && !lines.some((l) => /"type":"result"/.test(l)); i++) await sleep(500);
  await sleep(6000);
  const leaked = lines.filter((l) => /"control_response"/.test(l) && /aiondx-/.test(l));
  const mentioned = lines.some((l) => /"type":"assistant"/.test(l) && l.includes(CODE));
  const cancelledFrame = lines.some((l) => /command_lifecycle/.test(l) && l.includes(X) && /"cancelled"/.test(l));
  console.log("router's own control_response reached AionCore's side:", leaked.length);
  console.log('lifecycle cancelled frame for X passed through:', cancelledFrame);
  console.log('codeword in a reply:', mentioned);
  console.log(result && result.cancelled && !leaked.length && !mentioned ? 'VERDICT: unsent end to end' : 'VERDICT: FAILED');
  await cleanup(0);
})().catch(async (e) => { console.log('ERROR', e.message); await cleanup(1); });
