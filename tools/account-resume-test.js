#!/usr/bin/env node
/**
 * account-resume-test.js - can a Claude Code session started on one account be resumed on the
 * other once its transcript is copied across? (Step 0 of per-chat account switching; research:
 * ! LLM Files\Research\2026-09-25_model-and-account-per-chat.md.)
 *
 * Starts a throwaway session on account A with a codeword and a request to think, checks the
 * transcript holds signed thinking, copies it into account B's config folder, resumes it on B,
 * and reports whether B answered with the codeword or refused (a signature 400, say). Then it
 * deletes the throwaway transcripts from both folders and its temp working folder.
 *
 *   node tools\account-resume-test.js [from] [to]        default: the first two accounts in the router config
 *
 * Reads the account router's config (%APPDATA%\npm\claude-account-router.config.json) for each
 * account's config folder, home and token file. Never prints a token. Each claude call has a
 * 240 s limit; the whole run a 600 s deadline.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const deadline = setTimeout(() => { console.log('DEADLINE: 600 s'); process.exit(2); }, 600000);
const CFG = path.join(process.env.APPDATA, 'npm', 'claude-account-router.config.json');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const pick = (name) => {
  if (cfg.accounts[name]) return cfg.accounts[name];
  const hit = Object.values(cfg.accounts).find((a) => (a.label || '').toLowerCase().startsWith(name));
  if (!hit) throw new Error('no account ' + name);
  return hit;
};
const NAMES = Object.keys(cfg.accounts).filter((k) => /^[a-z]+$/.test(k));   // the config's plain account names, in its order
const FROM = pick(process.argv[2] || NAMES[0]);
const TO = pick(process.argv[3] || NAMES[1]);
const EXE = path.join(path.dirname(path.dirname(process.env.APPDATA)), '.local', 'bin', 'claude.exe');
const cwd = path.join(process.env.TEMP, 'aiondx-acct-test-' + Date.now().toString(36));
fs.mkdirSync(cwd, { recursive: true });
const id = crypto.randomUUID();
const CODE = 'PINEAPPLE-' + Math.floor(1000 + Math.random() * 9000);

function envFor(a) {
  const env = Object.assign({}, process.env);
  delete env.AIONUI_CONVERSATION_ID;   // not an AionUi chat
  delete env.ANTHROPIC_API_KEY;
  env.HOME = a.home || path.dirname(path.dirname(process.env.APPDATA));
  env.USERPROFILE = env.HOME;
  env.CLAUDE_CONFIG_DIR = a.configDir;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = a.configDir;
  env.MAX_THINKING_TOKENS = '3000';   // signed thinking in the transcript, the part a foreign account might refuse
  if (a.tokenFile && fs.existsSync(a.tokenFile)) {
    const t = fs.readFileSync(a.tokenFile, 'utf8').trim();
    if (t) { env.CLAUDE_CODE_OAUTH_TOKEN = t; env.ANTHROPIC_AUTH_TOKEN = t; }
  }
  return env;
}
function run(a, argv) {
  const r = spawnSync(EXE, argv, { cwd, env: envFor(a), encoding: 'utf8', windowsHide: true, timeout: 240000, input: '' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, out, raw: (r.stdout || '').slice(0, 600), err: (r.stderr || '').slice(0, 600), error: r.error && r.error.message };
}
function findTranscript(configDir) {
  const root = path.join(configDir, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function cleanup() {
  for (const a of [FROM, TO]) {
    const f = findTranscript(a.configDir);
    if (f) {
      try { fs.rmSync(f, { force: true }); } catch { /* keep going */ }
      try { fs.rmSync(path.join(path.dirname(f), id), { recursive: true, force: true }); } catch { /* keep going */ }
      // The whole project folder is this test's own (its name carries the temp folder's name).
      try { if (/aiondx-acct-test/.test(path.basename(path.dirname(f)))) fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* keep going */ }
    }
  }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp */ }
}

try {
  console.log(`session ${id}, codeword ${CODE}, ${FROM.label} -> ${TO.label}`);
  const a = run(FROM, ['-p', `ultrathink. Remember this codeword for later: ${CODE}. Then work out, reasoning step by step in your head, which is larger: 37 times 43, or 19 squared plus 1234. Reply with only the larger number.`,
    '--session-id', id, '--output-format', 'json', '--model', 'sonnet', '--effort', 'high']);
  console.log('A: exit', a.status, '| result:', a.out ? JSON.stringify(a.out.result).slice(0, 120) : a.raw, a.err ? '| stderr: ' + a.err : '', a.error || '');
  const src = findTranscript(FROM.configDir);
  if (!src) throw new Error('no transcript on account A');
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
  let thinking = 0, signed = 0;
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) if (c.type === 'thinking') { thinking++; if (c.signature) signed++; }
  }
  console.log(`transcript: ${lines.length} lines, ${thinking} thinking blocks, ${signed} signed`);
  const dstDir = path.join(TO.configDir, 'projects', path.basename(path.dirname(src)));
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, path.join(dstDir, id + '.jsonl'));
  const b = run(TO, ['-p', 'What codeword did I give you earlier? Reply with the codeword only.', '--resume', id, '--output-format', 'json', '--model', 'sonnet', '--effort', 'high']);
  const text = b.out ? String(b.out.result || '') : '';
  console.log('B: exit', b.status, '| is_error:', b.out && b.out.is_error, '| result:', JSON.stringify(text).slice(0, 160), b.err ? '| stderr: ' + b.err : '', b.error || '');
  console.log(text.includes(CODE) ? 'VERDICT: resumed on the other account with its memory intact'
    : 'VERDICT: the other account did NOT continue the session' + (b.raw && !b.out ? ' (raw: ' + b.raw + ')' : ''));
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  cleanup();
  clearTimeout(deadline);
}
