#!/usr/bin/env node
/**
 * probe-model-options-renewal.js - how Claude Code's extra model offer (additionalModelOptionsCache in .claude.json, where a new Fable
 * reaches the picker) decides the list, and whether Claude Code renews it.
 *
 * Trials, each in a scratch copy of the folder's sign-in and server cache (`initialize` only, nothing sent to a model):
 *   as-is         the cache as it is
 *   stale-at      additionalModelOptionsAnsweredAt set back by --age-days (does Claude Code fetch a new answer?)
 *   no-options    additionalModelOptionsCache and additionalModelOptionsAnsweredAt removed
 *   no-cache      no .claude.json at all
 * For each: the cache's offer before and after a first launch held up to --wait seconds, and the list of a second launch.
 *
 *   node probe-model-options-renewal.js --config-dir C:\Users\me\.claude [--token-file F] [--wait 40] [--age-days 40] [--only a,b]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('../patches/0002-claude-model-currency/claude-model-catalog.js');

const a = process.argv.slice(2);
const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const dir = val('--config-dir') || path.join(os.homedir(), '.claude');
const exe = val('--exe') || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const waitMs = Number(val('--wait') || 40) * 1000;
const ageDays = Number(val('--age-days') || 40);
const only = (val('--only') || '').split(',').filter(Boolean);
const tf = val('--token-file');
const token = tf ? fs.readFileSync(tf, 'utf8').trim() : null;
const hard = setTimeout(() => process.exit(4), 9 * 60000); hard.unref();
const rj = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const brief = (c) => c ? JSON.stringify({ at: c.additionalModelOptionsAnsweredAt && new Date(c.additionalModelOptionsAnsweredAt).toISOString(), opts: (c.additionalModelOptionsCache || []).map((o) => o.value) }) : 'no file';

function env(cfg) {
  const e = Object.assign({}, process.env);
  for (const k of Object.keys(e)) if (/^AIONDX_/i.test(k) || /^(CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(k)) delete e[k];
  if (token) e.CLAUDE_CODE_OAUTH_TOKEN = token;
  e.CLAUDE_CONFIG_DIR = cfg; e.CLAUDE_SECURESTORAGE_CONFIG_DIR = dir;
  return e;
}
async function trial(label, edit) {
  if (only.length && only.indexOf(label) < 0) return;
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-probe-cfg-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-probe-'));
  try {
    try { fs.copyFileSync(path.join(dir, '.credentials.json'), path.join(s, '.credentials.json')); } catch (e) { /* none */ }
    const c = rj(path.join(dir, '.claude.json')) || rj(path.join(path.dirname(dir), '.claude.json')) || {};
    const f = path.join(s, '.claude.json');
    const out = edit(c);
    if (out) fs.writeFileSync(f, JSON.stringify(out));
    const before = brief(rj(f));
    try { await catalog.askClaude(exe, env(s), work, null, { ms: waitMs, changed: () => brief(rj(f)) !== before }); } catch (e) { console.log(label + ': first launch: ' + e.message); }
    const after = brief(rj(f));
    let list = '';
    try { const g = await catalog.askClaude(exe, env(s), work); list = g.models.map((m) => m.value + (m.resolvedModel && m.resolvedModel !== m.value ? '>' + m.resolvedModel : '')).join(', '); } catch (e) { list = e.message; }
    console.log('== ' + label + (token ? ' (token)' : ' (folder sign-in)') + '\n   before ' + before + '\n   after  ' + after + '\n   list   ' + list);
  } finally { catalog.removeScratch(work); catalog.removeScratch(s); }
}
(async () => {
  await trial('as-is', (c) => c);
  await trial('stale-at', (c) => { if (c.additionalModelOptionsAnsweredAt) c.additionalModelOptionsAnsweredAt -= ageDays * 86400000; return c; });
  await trial('no-options', (c) => { delete c.additionalModelOptionsCache; delete c.additionalModelOptionsAnsweredAt; return c; });
  await trial('no-cache', () => null);
  process.exit(0);
})();
