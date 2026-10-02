#!/usr/bin/env node
/**
 * test-live-butler-name.js - the built-in assistants carry the AionDX name (core-0003-names): the staged AionDX starts on a throwaway profile, and the Butler must read
 * AionDX Butler, in its name, its English name and its description.
 *
 *   node tools/test-live-butler-name.js [--stage DIR]
 */
'use strict';
const path = require('path');
const os = require('os');
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };
const profile = path.join(os.tmpdir(), 'aiondx-butler-profile');
const butler = (app) => app.js(`(async () => {
  const base = 'http://127.0.0.1:' + window.__backendPort;
  const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
  const b = list.find((x) => x.id === 'aionui-assistant');
  return b ? { name: b.name, en: b.name_i18n && b.name_i18n['en-US'], description: String(b.description || '').slice(0, 60), builtin: b.source } : null;
})()`);
async function ready(app) { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; }

(async () => {
  // AionCore writes its built-in assistants into the database at every start (materialize_builtin_definitions, an upsert by id), so a PC that already has the Butler
  // as AionUi Butler gets the new name at its next start; this checks what the built-in data says.
  const now = await launch({ port: 9562, deadlineMs: 150000, stage: arg('--stage') || undefined, profile });
  try {
    await ready(now);
    await sleep(3000);
    const after = await butler(now);
    check('AionDX names its Butler AionDX Butler (name and English name)', after && after.name === 'AionDX Butler' && after.en === 'AionDX Butler', JSON.stringify(after));
    check('and its description says AionDX', after && /AionDX/.test(after.description) && !/AionUi/.test(after.description), JSON.stringify(after));
  } finally { await now.close(); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
