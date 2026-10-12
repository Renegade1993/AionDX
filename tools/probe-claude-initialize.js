#!/usr/bin/env node
/**
 * probe-claude-initialize.js - what Claude Code itself says about the models an account can use, with no inference spent.
 *
 * Starts the newest Claude Code the way AionCore does (--print, stream-json both ways), sends the `initialize` control request and prints
 * the `models` the CLI answers with: value, display name, description, effort levels. Run with an empty settings file (the default here:
 * a throwaway config folder with no `availableModels` allowlist) it shows what the CLI knows by itself; with --real it uses the
 * account's own config folder, allowlist and all. The account's token comes from the router config the same way the other probes do.
 *
 *   node tools\probe-claude-initialize.js [account] [--real] [--json]
 *
 * Nothing is sent to the model; the child is killed on every exit path; 40 s deadline.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const real = args.includes('--real');
const asJson = args.includes('--json');
const want = args.find((a) => !a.startsWith('--'));
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'npm', 'claude-account-router.config.json'), 'utf8'));
const names = Object.keys(cfg.accounts).filter((k) => /^[a-z]+$/.test(k));
const name = want && cfg.accounts[want] ? want : names[0];
const acct = cfg.accounts[name];
const EXE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-init-'));
const work = path.join(scratch, 'work');
fs.mkdirSync(work, { recursive: true });
const env = Object.assign({}, process.env);
delete env.AIONUI_CONVERSATION_ID; delete env.ANTHROPIC_API_KEY;
env.CLAUDE_CONFIG_DIR = real ? acct.configDir : path.join(scratch, 'config');
if (!real) fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
env.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
const tok = acct.tokenFile && fs.existsSync(acct.tokenFile) ? fs.readFileSync(acct.tokenFile, 'utf8').trim() : '';
if (tok) { env.CLAUDE_CODE_OAUTH_TOKEN = tok; env.ANTHROPIC_AUTH_TOKEN = tok; }

const extra = process.env.PROBE_SETTINGS ? ['--settings', process.env.PROBE_SETTINGS] : [];
const child = spawn(EXE, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'].concat(extra), { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  try { child.kill(); } catch (e) { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* in use */ }
  process.exit(code);
};
setTimeout(() => { console.log('no answer within 40 s'); finish(2); }, 40000).unref();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let j; try { j = JSON.parse(line); } catch (e) { continue; }
    if (j.type === 'control_response' && j.response && j.response.request_id === 'init-1') {
      const r = j.response.response || {};
      if (asJson) { console.log(JSON.stringify(r, null, 2)); finish(0); return; }
      console.log('account ' + name + (real ? ' (its own config)' : ' (empty config: no allowlist)') + ' ; keys: ' + Object.keys(r).join(', '));
      const models = r.models || [];
      console.log('models: ' + models.length);
      models.forEach((m) => console.log('  ' + String(m.value).padEnd(28) + ' ' + String(m.displayName || '').padEnd(26) + ' effort=' + JSON.stringify(m.supportedEffortLevels || m.effortLevels || (m.supportsEffort ? 'yes' : '-')) + '  ' + String(m.description || '').slice(0, 70)));
      finish(0);
    }
  }
});
child.on('exit', () => { if (!done) { console.log('claude exited before answering'); finish(3); } });
child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } }) + '\n');
