#!/usr/bin/env node
/**
 * probe-model-allowlist.js - why a model the account has is missing from a real chat's picker.
 *
 * Asks Claude Code's `initialize` (no inference, nothing sent to a model) for one account's config folder in four ways and prints each list:
 *   real      the real folder, as a chat gets it
 *   scratch   a copy of the folder's sign-in, server cache and settings.json
 *   noallow   the same copy with settings.json's availableModels removed
 *   plus      the same copy with the extra entries given by --add appended to availableModels
 *
 *   node probe-model-allowlist.js --config-dir C:\Users\me\.claude [--token-file F] [--add fable,claude-fable-5-2]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('../patches/0002-claude-model-currency/claude-model-catalog.js');

const a = process.argv.slice(2);
const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const dir = val('--config-dir') || path.join(os.homedir(), '.claude');
const add = (val('--add') || 'fable,claude-fable-5-2').split(',').filter(Boolean);
const exe = val('--exe') || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const hard = setTimeout(() => process.exit(4), 5 * 60000); hard.unref();

function baseEnv() {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^AIONDX_/i.test(k) || /^(CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(k)) delete env[k];
  const tf = val('--token-file');
  if (tf) { try { env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(tf, 'utf8').trim(); } catch (e) { /* none */ } }
  return env;
}
async function ask(label, cfgDir) {
  const env = Object.assign(baseEnv(), { CLAUDE_CONFIG_DIR: cfgDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-probe-'));
  try {
    const got = await catalog.askClaude(exe, env, work);
    console.log('== ' + label + ' (' + got.models.length + ', CLI ' + got.version + ')');
    console.log('   ' + got.models.map((m) => m.value + (m.resolvedModel && m.resolvedModel !== m.value ? '>' + m.resolvedModel : '')).join(', '));
  } catch (e) { console.log('== ' + label + ': ' + e.message); }
  finally { catalog.removeScratch(work); }
}
function copyDir(withSettings) {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-probe-cfg-'));
  for (const f of ['.credentials.json', '.claude.json']) { try { fs.copyFileSync(path.join(dir, f), path.join(s, f)); } catch (e) { /* none */ } }
  if (!fs.existsSync(path.join(s, '.claude.json'))) { try { fs.copyFileSync(path.join(path.dirname(dir), '.claude.json'), path.join(s, '.claude.json')); } catch (e) { /* none */ } }
  if (withSettings) fs.writeFileSync(path.join(s, 'settings.json'), JSON.stringify(withSettings, null, 2));
  return s;
}
(async () => {
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  console.log('allowlist (' + (settings.availableModels || []).length + '): ' + (settings.availableModels || []).join(', '));
  await ask('real', dir);
  const dirs = [];
  const s1 = copyDir(settings); dirs.push(s1); await ask('scratch', s1);
  const noAllow = Object.assign({}, settings); delete noAllow.availableModels;
  const s2 = copyDir(noAllow); dirs.push(s2); await ask('noallow', s2);
  const plus = Object.assign({}, settings, { availableModels: (settings.availableModels || []).concat(add.filter((x) => (settings.availableModels || []).indexOf(x) < 0)) });
  const s3 = copyDir(plus); dirs.push(s3); await ask('plus ' + add.join('+'), s3);
  dirs.forEach((d) => catalog.removeScratch(d));
  process.exit(0);
})();
