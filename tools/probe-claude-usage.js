#!/usr/bin/env node
/**
 * probe-claude-usage.js - can the 5-hour and weekly usage windows be read with an inference-only token?
 *
 *   node tools\probe-claude-usage.js
 *
 * K, September 26th, 2026: "see if you can figure out any way to get 5-hour usage window usage from the
 * claude api". /api/oauth/usage needs a user:profile token (P-003), and both AionUi Claude agents run on
 * setup-token (user:inference) tokens. But the Messages API answers subscription traffic with the
 * anthropic-ratelimit-unified-* headers, which Claude Code itself reads (5h and 7d utilization, resets,
 * status). This asks, per account in the Claude launcher's config, first the free token-count endpoint and,
 * only if that carries no such header, a one-token Haiku message. It prints the status code and the
 * anthropic-ratelimit-unified-* headers; never a token. 20 s timeout per request.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(process.env.APPDATA || '', 'npm', 'claude-account-router.config.json');
const API = 'https://api.anthropic.com';
const MODEL = 'claude-haiku-4-5-20251001';

function unified(headers) {
  const out = {};
  for (const [k, v] of headers) if (/^anthropic-ratelimit-unified/i.test(k)) out[k] = v;
  return out;
}
async function call(route, token, body) {
  const r = await fetch(API + route, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  let detail = '';
  if (!r.ok) { try { detail = (await r.text()).slice(0, 200); } catch { /* none */ } }
  return { status: r.status, unified: unified(r.headers), detail };
}

(async () => {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { console.log('no router config: ' + e.message); process.exit(1); }
  const seen = new Set();
  for (const [id, a] of Object.entries(cfg.accounts || {})) {
    if (!a || !a.tokenFile || seen.has(a.tokenFile)) continue;
    seen.add(a.tokenFile);
    let token = '';
    try { token = fs.readFileSync(a.tokenFile, 'utf8').trim(); } catch { console.log(`${id}: token file unreadable`); continue; }
    if (!token) { console.log(`${id}: empty token file`); continue; }
    const system = "You are Claude Code, Anthropic's official CLI for Claude.";
    const count = await call('/v1/messages/count_tokens', token, { model: MODEL, system, messages: [{ role: 'user', content: '.' }] }).catch((e) => ({ error: e.message }));
    console.log(`${id} (${a.label || ''}) count_tokens: ` + JSON.stringify(count));
    if (count.unified && Object.keys(count.unified).length) continue;
    const msg = await call('/v1/messages', token, { model: MODEL, max_tokens: 1, system, messages: [{ role: 'user', content: '.' }] }).catch((e) => ({ error: e.message }));
    console.log(`${id} (${a.label || ''}) messages: ` + JSON.stringify(msg));
  }
})();
