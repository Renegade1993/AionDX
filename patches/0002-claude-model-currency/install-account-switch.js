#!/usr/bin/env node
/**
 * install-account-switch.js - per-chat Claude account (AionDX, 2026-09-25).
 *
 * a request of September 25th. The model already switches live from AionUi's own picker. The account is fixed when the
 * Claude process starts, by the account router (%APPDATA%\npm\claude-account-router.js). This:
 *
 *   1. installs the router from this folder (backup: claude-account-router.js.bak-20260925);
 *   2. adds plain names to the router config for each account (taken from its label) so a chat's
 *      choice can name one (backup: claude-account-router.config.json.bak-20260925);
 *   3. writes aiondx.accounts to AionUi's settings store: the account names and labels, and which
 *      account each Claude agent uses by default. The account pill in the renderer reads it.
 *
 *   node patches\0002-claude-model-currency\install-account-switch.js           install
 *   node patches\0002-claude-model-currency\install-account-switch.js --check   report only
 *
 * Step 3 needs AionUi running and the AIONUI_* variables of an agent shell (any Claude chat in
 * AionUi has them). Never prints a token.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const NPM = path.join(process.env.APPDATA, 'npm');
const LIVE = path.join(NPM, 'claude-account-router.js');
const CONFIG = path.join(NPM, 'claude-account-router.config.json');
const SRC = path.join(__dirname, 'claude-account-router.js');
const STAMP = '20260925';
const check = process.argv.includes('--check');
const say = (s) => console.log(s);

function sameFile(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

// 1. the router, and its pass-through for unsending (claude-stream-proxy.js, new on 2026-09-25)
if (sameFile(SRC, LIVE)) say('router: installed copy matches this folder');
else if (check) say('router: installed copy differs from this folder');
else {
  const bak = LIVE + '.bak-' + STAMP;
  if (!fs.existsSync(bak) && fs.existsSync(LIVE)) fs.copyFileSync(LIVE, bak);
  fs.copyFileSync(SRC, LIVE);
  say('router: installed (backup ' + path.basename(bak) + ')');
}
const PROXY_SRC = path.join(__dirname, 'claude-stream-proxy.js');
const PROXY_LIVE = path.join(NPM, 'claude-stream-proxy.js');
if (sameFile(PROXY_SRC, PROXY_LIVE)) say('pass-through: installed copy matches this folder');
else if (check) say('pass-through: ' + (fs.existsSync(PROXY_LIVE) ? 'installed copy differs from this folder' : 'not installed'));
else { fs.copyFileSync(PROXY_SRC, PROXY_LIVE); say('pass-through: installed'); }

// 2. plain account names in the config
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const byDir = {};
for (const [key, a] of Object.entries(cfg.accounts || {})) {
  if (!a || !a.configDir) continue;
  const dir = a.configDir.toLowerCase();
  (byDir[dir] = byDir[dir] || []).push(key);
}
const named = {};   // configDir -> plain name
let added = 0;
for (const [dir, keys] of Object.entries(byDir)) {
  let name = keys.find((k) => /^[a-z]+$/.test(k));
  if (!name) {
    const a = cfg.accounts[keys[0]];
    name = String(a.label || '').toLowerCase().split(/[^a-z]/)[0] || null;
    if (!name || cfg.accounts[name]) continue;
    if (!check) { cfg.accounts[name] = Object.assign({}, a); added++; }
  }
  named[dir] = name;
}
if (added && !check) {
  const bak = CONFIG + '.bak-' + STAMP;
  if (!fs.existsSync(bak)) fs.copyFileSync(CONFIG, bak);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
}
say('config: account names ' + Object.values(named).join(', ') + (added ? ' (' + added + ' added)' : ''));

// 3. the account list for the renderer
const accounts = [];
const agents = {};
for (const [dir, name] of Object.entries(named)) {
  const a = cfg.accounts[name] || cfg.accounts[byDir[dir][0]];
  const label = String(a.label || name).replace(/^\w/, (c) => c.toUpperCase());
  accounts.push({ id: name, label });
  for (const key of byDir[dir]) if (/^[0-9a-f]{8}$/i.test(key)) agents[key] = name;
}
const rec = { v: 1, accounts, agents, defaultAccount: named[(cfg.accounts[cfg.defaultAccount] || {}).configDir ? cfg.accounts[cfg.defaultAccount].configDir.toLowerCase() : ''] || cfg.defaultAccount, at: Date.now() };
say('store record: ' + JSON.stringify(rec));
if (check) process.exit(0);

const base = (process.env.AIONUI_BASE_URL || '').replace(/\/+$/, '');
if (!base || !process.env.AIONUI_RUNTIME_TOKEN) {
  say('store: skipped (no AIONUI_* variables here; run this from an AionUi agent shell)');
  process.exit(0);
}
fetch(base + '/api/settings/client', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'x-aionui-runtime-token': process.env.AIONUI_RUNTIME_TOKEN,
    'x-aionui-user-id': process.env.AIONUI_USER_ID || '',
    'x-aionui-conversation-id': process.env.AIONUI_CONVERSATION_ID || '',
  },
  body: JSON.stringify({ 'aiondx.accounts': rec }),
}).then((r) => { say('store: ' + (r.ok ? 'written' : 'refused (' + r.status + ')')); process.exit(r.ok ? 0 : 1); },
  (e) => { say('store: failed (' + e.message + ')'); process.exit(1); });
