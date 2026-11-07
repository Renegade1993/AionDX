#!/usr/bin/env node
/**
 * test-refresh-launcher.js - aiondx-refresh-launcher.js against made-up folders. Nothing real is touched.
 *   node patches\0002-claude-model-currency\test-refresh-launcher.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };
const TOOL = path.join(__dirname, 'aiondx-refresh-launcher.js');
const FILES = ['claude-account-router.js', 'claude-stream-proxy.js', 'claude-model-catalog.js', 'aiondx-model-refresh.js'];

function make(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-launcher-' + tag + '-'));
  const roaming = path.join(root, 'Roaming'), local = path.join(root, 'Local'), bin = path.join(root, 'bin');
  for (const d of [path.join(roaming, 'npm'), path.join(local, 'AionDX'), bin, path.join(roaming, 'AionDX', 'aionui')]) fs.mkdirSync(d, { recursive: true });
  // the shipped copy of the tool and its four files, in a folder of their own
  fs.copyFileSync(TOOL, path.join(bin, 'aiondx-refresh-launcher.js'));
  for (const f of FILES) fs.writeFileSync(path.join(bin, f), '// new ' + f + '\nclaude-stream-proxy.js\n');
  fs.writeFileSync(path.join(roaming, 'AionDX', 'aionui', 'aiondx-backend.db'), 'x');
  return { root, roaming, local, bin };
}
const run = (m, extra) => spawnSync(process.execPath, [path.join(m.bin, 'aiondx-refresh-launcher.js'), '--roaming', m.roaming, '--local', m.local].concat(extra || []), { encoding: 'utf8', windowsHide: true, timeout: 30000 });
const npm = (m, f) => path.join(m.roaming, 'npm', f);
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

// an older AionDX launcher: its router names the proxy, and its config names the chats database under the old folder
{
  const m = make('old');
  for (const f of FILES) fs.writeFileSync(npm(m, f), '// old ' + f + '\nclaude-stream-proxy.js\nAIONUI_CONVERSATION_ID\n');
  const oldDb = path.join(m.roaming, 'AionUi', 'aionui', 'aionui-backend.db');   // legacy-name
  fs.writeFileSync(npm(m, 'claude-account-router.config.json'), JSON.stringify({ database: oldDb, accounts: { a: { label: 'x' } }, defaultAccount: 'a' }, null, 2));
  const c = run(m, ['--check']);
  check('--check reports what differs and changes nothing', c.status === 0 && /differs/.test(c.stdout) && rd(npm(m, 'claude-account-router.js')).startsWith('// old'), c.stdout + c.stderr);
  const r = run(m);
  check('the four files are replaced by the shipped ones', r.status === 0 && FILES.every((f) => rd(npm(m, f)).startsWith('// new ' + f)), r.stdout + r.stderr);
  check('each old file is kept beside it', FILES.every((f) => fs.readdirSync(path.join(m.roaming, 'npm')).some((n) => n.startsWith(f + '.bak-') && rd(path.join(m.roaming, 'npm', n)).startsWith('// old'))));
  const cfg = JSON.parse(rd(npm(m, 'claude-account-router.config.json')));
  check('the config points at the moved chats database and keeps its accounts', cfg.database === path.join(m.roaming, 'AionDX', 'aionui', 'aiondx-backend.db') && cfg.accounts.a.label === 'x' && cfg.defaultAccount === 'a', JSON.stringify(cfg));
  check('the old config is kept', fs.readdirSync(path.join(m.roaming, 'npm')).some((n) => n.startsWith('claude-account-router.config.json.bak-')));
  const again = run(m);
  check('a second run finds nothing to change', again.status === 0 && /up to date/.test(again.stdout) && !/updated/.test(again.stdout), again.stdout);
  check('a log line is written', /launcher/.test(rd(path.join(m.local, 'AionDX', 'logs', 'launcher-refresh.log')) || ''));
  fs.rmSync(m.root, { recursive: true, force: true });
}

// a router that is not AionDX's is left alone
{
  const m = make('foreign');
  fs.writeFileSync(npm(m, 'claude-account-router.js'), '// somebody else\'s router\n');
  const r = run(m);
  check('a router that is not AionDX\'s is left alone', r.status === 0 && /not AionDX/.test(r.stdout) && rd(npm(m, 'claude-account-router.js')).startsWith('// somebody'), r.stdout);
  fs.rmSync(m.root, { recursive: true, force: true });
}

// no launcher at all (a new PC)
{
  const m = make('none');
  const r = run(m);
  check('no launcher in %APPDATA%\\npm: nothing to do, exit 0', r.status === 0 && /nothing to refresh/.test(r.stdout) && !fs.existsSync(npm(m, 'claude-account-router.js')), r.stdout);
  fs.rmSync(m.root, { recursive: true, force: true });
}

// a config whose database still exists is not rewritten
{
  const m = make('keep');
  for (const f of FILES) fs.writeFileSync(npm(m, f), '// new ' + f + '\nclaude-stream-proxy.js\n');
  const db = path.join(m.roaming, 'AionDX', 'aionui', 'aiondx-backend.db');
  fs.writeFileSync(npm(m, 'claude-account-router.config.json'), JSON.stringify({ database: db }));
  const r = run(m);
  check('a config whose database exists, and files already current, are left as they are', r.status === 0 && /up to date/.test(r.stdout) && !fs.readdirSync(path.join(m.roaming, 'npm')).some((n) => /\.bak-/.test(n)), r.stdout);
  fs.rmSync(m.root, { recursive: true, force: true });
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
