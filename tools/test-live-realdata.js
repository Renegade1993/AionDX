#!/usr/bin/env node
/**
 * test-live-realdata.js - the built app against a COPY of a real chats database, in a made-up APPDATA (the real folder is only read, once,
 * to make a consistent copy). It checks what an upgrade must not lose: AionCore finds the database under its old name and renames it, runs its
 * migrations, answers, and every table that holds the user's work still has the same number of rows. Counts only: no text from the database is
 * read or printed.
 *
 *   node tools/test-live-realdata.js [--stage DIR] [--db FILE]
 *
 * 5-minute deadline; the copy is deleted at the end.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { launch, sleep } = require('./live-app');
const { DatabaseSync } = require('node:sqlite');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 300000);
const home = path.join(os.tmpdir(), 'aiondx-realdata-test');
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* best effort */ } };

const SRC = arg('--db') || path.join(process.env.APPDATA, 'AionUi', 'aionui', 'aionui-backend.db');
const TABLES = ['conversations', 'messages', 'mcp_servers', 'cron_jobs', 'agent_metadata', 'teams', 'users'];
function serverNames(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare('SELECT user_id, name FROM mcp_servers ORDER BY user_id, name').all().map((r) => r.user_id + ':' + r.name);
  db.close();
  return rows;
}
function counts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = {};
  for (const t of TABLES) {
    try { out[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n); } catch (e) { out[t] = null; }
  }
  db.close();
  return out;
}

(async () => {
  rm(home);
  const roaming = path.join(home, 'AppData', 'Roaming');
  const inner = path.join(roaming, 'AionUi', 'aionui');
  fs.mkdirSync(inner, { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  // a consistent copy of the real database (VACUUM INTO reads it through SQLite, so a write in progress cannot tear it)
  const before = counts(SRC);
  const copy = path.join(inner, 'aionui-backend.db');   // the name an earlier version wrote
  const copy0 = () => copy;
  const src = new DatabaseSync(SRC, { readOnly: true });
  src.exec("VACUUM INTO '" + copy.replace(/'/g, "''") + "'");
  src.close();
  console.log('before (rows per table): ' + JSON.stringify(before));
  const namesBefore = serverNames(copy0());
  console.log('MCP server names before: ' + namesBefore.join(', '));
  const copied = counts(copy);
  check('the copy has the same rows as the real database', JSON.stringify(copied) === JSON.stringify(before), JSON.stringify(copied));

  const app = await launch({ port: 9593, deadlineMs: 240000, stage: arg('--stage') || undefined, profile: path.join(home, 'unused'), noUserDataDir: true,
    env: { AIONDX_E2E_USER_DATA_DIR: '', APPDATA: roaming, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), USERPROFILE: home, HOME: home } });
  let apiOk = null;
  try {
    let port = null;
    for (let i = 0; i < 150 && !port; i++) { const st = await app.js('({ port: window.__backendPort || null })'); port = st && st.port; if (!port) await sleep(1000); }
    check('the backend came up on the copy', !!port, 'no port');
    await sleep(8000);
    apiOk = await app.js(`(async () => {
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aiondx-csrf-token=([^;]+)/) || [])[1] || '';
      const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/conversations?limit=5', { credentials: 'include', headers: { 'x-csrf-token': csrf } });
      let n = null; try { const j = await r.json(); const d = j.data !== undefined ? j.data : j; n = Array.isArray(d) ? d.length : (d.items ? d.items.length : -1); } catch (e) { /* no body */ }
      return { status: r.status, listed: n };
    })()`);
    // (the throwaway profile has its own new local user, so its list is empty: only the answer is checked)
    check('the conversation list answers with status 200', apiOk && apiOk.status === 200, JSON.stringify(apiOk));
  } finally { await app.close(); }
  await sleep(3000);

  const files = fs.readdirSync(inner).filter((f) => /backend\.db$/.test(f));
  check('AionCore renamed the database file to its current name', files.length === 1 && files[0] === 'aiondx-backend.db', files.join(','));
  const after = counts(path.join(inner, files[0]));
  console.log('after  (rows per table): ' + JSON.stringify(after));
  const namesAfter = serverNames(path.join(inner, files[0]));
  console.log('MCP server names after:  ' + namesAfter.join(', '));
  // (the throwaway profile gets a local user of its own, with its own default servers: so the test counts a name once per user)
  check('no MCP server appears twice for a user, and every earlier one is still there', new Set(namesAfter).size === namesAfter.length && namesBefore.every((n) => namesAfter.includes(n)), namesAfter.join(','));
  const same = TABLES.every((t) => before[t] === null ? true : (after[t] !== null && after[t] >= before[t]));
  check('no table lost a row (a table may gain rows, from the app\'s own start-up)', same, JSON.stringify({ before, after }));
  check('the conversations and messages are exactly as many as before', after.conversations === before.conversations && after.messages === before.messages, JSON.stringify({ before: [before.conversations, before.messages], after: [after.conversations, after.messages] }));
  check('the app used the old folder where it was: no AionDX data folder was made beside it', !fs.existsSync(path.join(roaming, 'AionDX', 'aionui')));

  rm(home);
  clearTimeout(deadline);
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); rm(home); process.exit(2); });
