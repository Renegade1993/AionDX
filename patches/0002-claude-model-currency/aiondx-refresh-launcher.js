#!/usr/bin/env node
/**
 * aiondx-refresh-launcher.js - brings AionDX's Claude launcher files in %APPDATA%\npm up to the version that ships with the app.
 * Run by the installer after the files are copied, and by hand:  node aiondx-refresh-launcher.js [--check] [--roaming DIR] [--local DIR]
 *
 * WHY (2026-11-02). A PC that already had AionDX's launcher (the claude-account-router.js and its companions) in %APPDATA%\npm kept the
 * old copy across an update, because the installer left that folder alone. From 0.26.0 AionCore hands an agent its conversation as
 * AIONDX_CONVERSATION_ID (it was AIONUI_CONVERSATION_ID), so the old copy no longer knew which chat it was starting: it passed every
 * Claude agent straight through, with no per-chat account, no usage readings (the meter's numbers stopped), and its config still named the
 * chats database under its old name and folder. The shipped router also reads either name now; this keeps the copies in step.
 *
 * WHAT. Only when %APPDATA%\npm\claude-account-router.js is AionDX's (it names claude-stream-proxy.js). Each of the four files that
 * differs from the shipped one is replaced, the old one kept beside it as <name>.bak-<date-time>; the config's "database" is pointed at the
 * moved chats database when the old path no longer exists. Nothing else in the folder is touched. Exit 0 whether or not anything changed;
 * 2 only for an unreadable folder. Never prints a token.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const check = process.argv.includes('--check');
const ROAMING = arg('--roaming') || process.env.APPDATA;
const LOCAL = arg('--local') || process.env.LOCALAPPDATA;
const SRC = __dirname;
const NPM = path.join(ROAMING || '', 'npm');
const FILES = ['claude-account-router.js', 'claude-stream-proxy.js', 'claude-model-catalog.js', 'aiondx-model-refresh.js'];
const out = [];
const say = (s) => { out.push(s); console.log(s); };
const stamp = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); })();
const same = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (e) { return false; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

function main() {
  if (!ROAMING) { say('launcher: no APPDATA'); return 2; }
  const live = path.join(NPM, 'claude-account-router.js');
  if (!exists(live)) { say('launcher: none in ' + NPM + '; nothing to refresh'); return 0; }
  let text = '';
  try { text = fs.readFileSync(live, 'utf8'); } catch (e) { say('launcher: ' + live + ' cannot be read (' + e.code + ')'); return 2; }
  if (text.indexOf('claude-stream-proxy.js') < 0) { say('launcher: the router in ' + NPM + ' is not AionDX\'s; left alone'); return 0; }
  let changed = 0;
  for (const f of FILES) {
    const from = path.join(SRC, f), to = path.join(NPM, f);
    if (!exists(from)) continue;
    if (same(from, to)) continue;
    if (check) { say('launcher: ' + f + ' differs from the shipped copy'); changed++; continue; }
    try {
      if (exists(to)) fs.copyFileSync(to, to + '.bak-' + stamp);
      const tmp = to + '.aiondx-tmp';
      fs.copyFileSync(from, tmp);
      fs.renameSync(tmp, to);
      say('launcher: ' + f + ' updated (old copy kept as ' + f + '.bak-' + stamp + ')');
      changed++;
    } catch (e) { say('launcher: ' + f + ' not updated (' + e.code + ')'); }
  }
  // the router's config: the chats database moved with the data folder
  const cfgFile = path.join(NPM, 'claude-account-router.config.json');
  try {
    const raw = fs.readFileSync(cfgFile, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.database === 'string' && cfg.database && !exists(cfg.database)) {
      const dirs = [path.join(ROAMING, 'AionDX', 'aionui'), path.join(ROAMING, 'AionUi', 'aionui')];   // legacy-name
      const names = ['aiondx-backend.db', 'aionui-backend.db'];   // legacy-name
      let found = null;
      for (const d of dirs) for (const n of names) if (!found && exists(path.join(d, n))) found = path.join(d, n);
      if (found) {
        if (check) { say('launcher: the config names a chats database that is gone (' + cfg.database + ')'); changed++; }
        else {
          fs.copyFileSync(cfgFile, cfgFile + '.bak-' + stamp);
          cfg.database = found;
          fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
          say('launcher: config database now ' + found + ' (old config kept as claude-account-router.config.json.bak-' + stamp + ')');
          changed++;
        }
      } else say('launcher: the config names a chats database that is gone and no other was found');
    }
  } catch (e) { /* no config, or not JSON: the router reads its own default */ }
  if (!changed) say('launcher: ' + NPM + ' is up to date');
  return 0;
}

let rc = 0;
try { rc = main(); } catch (e) { say('launcher: failed (' + e.message + ')'); rc = 2; }
try {
  if (LOCAL && !check) {
    const dir = path.join(LOCAL, 'AionDX', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'launcher-refresh.log'), new Date().toISOString() + '\n  ' + out.join('\n  ') + '\n');
  }
} catch (e) { /* a log is a nicety */ }
process.exit(rc);
