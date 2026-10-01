#!/usr/bin/env node
/**
 * probe-usage-tap.js - proof, on real calls, that the usage tap (patches\0002...\claude-usage-tap.js) is invisible to
 * Claude Code and reads the account's usage windows. For each account named (default: the first in the router config), one
 * throwaway Haiku turn in the mode AionCore runs Claude in (--print, stream-json both ways), with ANTHROPIC_BASE_URL
 * pointing at the tap. Pass: Claude answers OK, a /v1/messages response came through the tap, and its headers held the
 * 5-hour and 7-day utilization. The token never leaves the child's environment and is never printed.
 *
 *   node tools\probe-usage-tap.js [account ...] [--model haiku]
 *
 * 120 s deadline per account; the child and the tap are stopped on every exit path; the temp folder is removed.
 * About a hundred tokens of Haiku per account.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startTap } = require('../patches/0002-claude-model-currency/claude-stream-proxy.js');

const names = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== 'haiku' && a !== 'sonnet' && a !== 'opus');
const mi = process.argv.indexOf('--model');
const MODEL = mi >= 0 ? process.argv[mi + 1] : 'haiku';
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'npm', 'claude-account-router.config.json'), 'utf8'));
const EXE = path.join(path.dirname(path.dirname(process.env.APPDATA)), '.local', 'bin', 'claude.exe');
const NAMES = Object.keys(cfg.accounts).filter((k) => /^[a-z]+$/.test(k));   // the config's plain account names, in its order

const fmt = (w) => (w && w.u !== null ? Math.round(w.u * 1000) / 10 + '% (' + (w.status || '?') + ', resets ' + new Date(w.reset * 1000).toLocaleString() + ')' : 'none');

async function one(name) {
  const acct = cfg.accounts[name];
  if (!acct) throw new Error('no account named ' + name);
  const cwd = path.join(process.env.TEMP, 'aiondx-tap-probe-' + Date.now().toString(36));
  fs.mkdirSync(cwd, { recursive: true });
  const seen = [];
  const tap = await startTap({ onResponse: (i) => seen.push(i), log: (m) => console.log('  ' + m) });
  const env = Object.assign({}, process.env);
  delete env.AIONUI_CONVERSATION_ID; delete env.ANTHROPIC_API_KEY;
  if (acct.home) { env.HOME = acct.home; env.USERPROFILE = acct.home; }
  env.CLAUDE_CONFIG_DIR = acct.configDir; env.CLAUDE_SECURESTORAGE_CONFIG_DIR = acct.configDir;
  const tok = fs.readFileSync(acct.tokenFile, 'utf8').trim();
  env.CLAUDE_CODE_OAUTH_TOKEN = tok; env.ANTHROPIC_AUTH_TOKEN = tok;
  env.ANTHROPIC_BASE_URL = tap.url;
  const child = spawn(EXE, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--session-id', crypto.randomUUID(), '--model', MODEL, '--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions'],
  { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = { text: '', result: null, err: '' };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) for (const c of j.message.content) if (c.type === 'text') out.text += c.text;
      if (j.type === 'result') out.result = j;
    }
  });
  child.stderr.on('data', (d) => { out.err += d; });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK. Do not use any tools.' }] } }) + '\n');
  const deadline = Date.now() + 120000;
  while (!out.result && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 250));
  try { child.kill(); } catch { /* gone */ }
  tap.close();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* in use */ }
  const withUsage = seen.filter((s) => s.usage);
  console.log(`== ${name} (${acct.label}), model ${MODEL}`);
  console.log('  Claude answered:', JSON.stringify(out.text.slice(0, 40)), '| result:', out.result ? (out.result.subtype + (out.result.is_error ? ' (error)' : '')) : 'none', out.err ? '| stderr: ' + out.err.slice(0, 160) : '');
  console.log('  /v1/messages responses through the tap:', seen.length, '| with usage headers:', withUsage.length, '| statuses:', seen.map((s) => s.status).join(','));
  const u = withUsage[withUsage.length - 1];
  if (u) console.log('  5-hour:', fmt(u.usage.five_hour), '\n  7-day: ', fmt(u.usage.seven_day), '\n  overall:', u.usage.status, '| claim:', u.usage.claim);
  const ok = out.result && !out.result.is_error && /OK/i.test(out.text) && withUsage.length > 0;
  console.log('  ' + (ok ? 'PASS' : 'FAIL'));
  return ok;
}

(async () => {
  const todo = names.length ? names : NAMES.slice(0, 1);
  let all = true;
  for (const n of todo) all = (await one(n).catch((e) => { console.log('== ' + n + '\n  FAIL: ' + e.message); return false; })) && all;
  setTimeout(() => process.exit(all ? 0 : 1), 300);
})();
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 280000).unref();
