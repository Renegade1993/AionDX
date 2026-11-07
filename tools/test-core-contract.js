#!/usr/bin/env node
/**
 * test-core-contract.js - brand-names.js leaves AionCore's cookie names alone (both modes), and check-core-contract.js
 * catches an app and an AionCore that disagree on them.
 *
 *   node tools/test-core-contract.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check } = require('./check-core-contract.js');

const results = [];
const ok = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });

// The shapes these names have in the real bundle: main's constants, the page's cookie lookup, and a longer name that is
// not a cookie and is renamed as before.
const SAMPLE = [
  'const CORE_SESSION_COOKIE = "aionui-session";',
  'const CORE_CSRF_COOKIE = "aionui-csrf-token";',
  "var m = document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/);",
  'emit("aionui-session-message", x);',
  'const label = "AionUi desktop";',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-core-contract-'));
try {
  for (const mode of ['asar', 'core']) {
    const f = path.join(tmp, `sample-${mode}.js`);
    fs.writeFileSync(f, SAMPLE);
    const run = spawnSync(process.execPath, [path.join(__dirname, 'brand-names.js'), f, '--mode', mode], { encoding: 'utf8' });
    const out = fs.readFileSync(f, 'utf8');
    ok(`${mode}: brand-names ran`, run.status === 0, run.stderr);
    ok(`${mode}: the session cookie name stays aionui-session`, out.includes('CORE_SESSION_COOKIE = "aionui-session"'), out);
    ok(`${mode}: the CSRF cookie name stays aionui-csrf-token`, out.includes('CORE_CSRF_COOKIE = "aionui-csrf-token"'));
    ok(`${mode}: the page's cookie lookup keeps the same name`, out.includes('aionui-csrf-token=([^;]+)'));
    ok(`${mode}: a longer name that only starts with it is still renamed`, out.includes('"aiondx-session-message"') && !out.includes('aionui-session-message'));
    ok(`${mode}: everything else is still renamed`, out.includes('"AionDX desktop"'));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const main = (s, c) => `const CORE_SESSION_COOKIE = "${s}";\nconst CORE_CSRF_COOKIE = "${c}";\n`;
const stockCore = Buffer.from('\0set-cookie\0aionui-session\0x-csrf-token\0aionui-csrf-token\0', 'utf8');
const renamedCore = Buffer.from('\0aiondx-session\0aiondx-csrf-token\0', 'utf8');

ok('a stock-named app and the stock AionCore agree', check(main('aionui-session', 'aionui-csrf-token'), stockCore).problems.length === 0);
const broken = check(main('aiondx-session', 'aiondx-csrf-token'), stockCore);
ok('the 0.26.0 mismatch (renamed app, stock AionCore) is caught, both names', broken.problems.length === 2, broken.problems.join(' | '));
ok('a renamed app and a renamed AionCore agree', check(main('aiondx-session', 'aiondx-csrf-token'), renamedCore).problems.length === 0);
ok('a stock-named app and a renamed AionCore are caught too', check(main('aionui-session', 'aionui-csrf-token'), renamedCore).problems.length === 2);
ok('a missing constant is reported, not passed', check('const CORE_CSRF_COOKIE = "aionui-csrf-token";', stockCore).problems.length === 1);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${!r.ok && r.detail ? ' -- ' + r.detail : ''}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
