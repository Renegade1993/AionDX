#!/usr/bin/env node
/**
 * probe-picker-diff.js - what aiondx-model-refresh.js would change in one agent's stored picker, field by field, without writing anything.
 * Offline by construction (proxies point at a closed local port): the list is what Claude Code answers from the account's cached data.
 *
 *   node tools\probe-picker-diff.js AGENT_ID CONFIG_DIR
 */
'use strict';
process.removeAllListeners('warning');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shapeRow } = require('../patches/0002-claude-model-currency/aiondx-model-refresh.js');
const cat = require('../patches/0002-claude-model-currency/claude-model-catalog.js');
const { DatabaseSync } = require('node:sqlite');

const [agentId, dir] = process.argv.slice(2);
const db = new DatabaseSync(path.join(process.env.APPDATA, 'AionUi', 'aionui', 'aionui-backend.db'), { readOnly: true });
const row = db.prepare('select id, agent_id, name, available_models, config_options from agent_metadata where agent_id = ?').get(agentId);
db.close();
if (!row) { console.log('no agent ' + agentId); process.exit(1); }
const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' });
delete env.ANTHROPIC_AUTH_TOKEN; delete env.AIONUI_CONVERSATION_ID;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-pickerdiff-'));
cat.askClaude(path.join(os.homedir(), '.local', 'bin', 'claude.exe'), env, work).then((got) => {
  const n = shapeRow(row, got.models);
  const a = JSON.parse(row.available_models), b = JSON.parse(n.available_models);
  const len = Math.max(a.available_models.length, b.available_models.length);
  for (let i = 0; i < len; i++) {
    const x = JSON.stringify(a.available_models[i]), y = JSON.stringify(b.available_models[i]);
    if (x !== y) console.log('model ' + i + ': ' + x + '\n      => ' + y);
  }
  if (a.current_model_id !== b.current_model_id) console.log('current: ' + a.current_model_id + ' => ' + b.current_model_id);
  const ca = JSON.parse(row.config_options), cb = JSON.parse(n.config_options);
  cb.forEach((o) => {
    const old = ca.find((x) => x.id === o.id);
    if (JSON.stringify(old) === JSON.stringify(o)) return;
    console.log('select ' + o.id + ': current ' + (old && old.currentValue) + ' => ' + o.currentValue);
    console.log('   was: ' + (old ? (old.options || []).map((x) => x.value).join(',') : '(none)'));
    console.log('   now: ' + (o.options || []).map((x) => x.value).join(','));
    if (old) (old.options || []).forEach((x, k) => { const y = (o.options || [])[k]; if (y && x.value === y.value && JSON.stringify(x) !== JSON.stringify(y)) console.log('   text ' + JSON.stringify(x) + ' => ' + JSON.stringify(y)); });
  });
}).catch((e) => console.log('failed: ' + e.message)).finally(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* in use */ } process.exit(0); });
