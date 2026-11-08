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
  'function buildSpawnEnv(dirs, extraEnv) {',
  '  const { PREBUILDS_ONLY: _prebuildsOnly, ...parentEnv } = process.env;',
  '  return {',
  '    ...parentEnv,',
  '    AIONUI_CACHE_DIR: dirs.cacheDir,',
  '    AIONUI_WORK_DIR: dirs.workDir,',
  '    AIONUI_LOG_DIR: dirs.logDir,',
  '    ...extraEnv',
  '  };',
  '}',
  'const other = process.env.AIONUI_LOG_DIR_OVERRIDE;',
  // the error catalog, in both forms a bundle carries it (quoted JSON and a minified object literal), and its colour map
  '"ownership":{"aionui":"App","user_agent":"Agent"},"codes":{"AIONUI_STREAM_BROKEN":{"title":"Response stream was interrupted"},"AIONUI_CONVERSATION_BUSY":{"title":"Busy"}}',
  'ownership:{aionui:"应用",user_agent:"Agent"},codes:{AIONUI_STATE_INCONSISTENT:{title:"x"},AIONUI_PERMISSION_ERROR:{title:"x"},AIONUI_INTERNAL_ERROR:{title:"x"}}',
  'Rr={aionui:"red",user_agent:"orange"}',
  // the core source: the variant serde derives the wire code from, and one that only starts like it
  'pub enum AgentErrorCode { AionuiStreamBroken, AionuiConversationBusyRetry }',
  'const link = "aionui://open";',
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
    ok(`${mode}: the folder variables AionCore is started with keep their names`,
      out.includes('AIONUI_CACHE_DIR: dirs.cacheDir') && out.includes('AIONUI_WORK_DIR: dirs.workDir') && out.includes('AIONUI_LOG_DIR: dirs.logDir'), out);
    ok(`${mode}: a longer variable that only starts with one is still renamed`, out.includes('AIONDX_LOG_DIR_OVERRIDE'));
    ok(`${mode}: the five error codes AionCore sends keep their names, quoted and unquoted`,
      ['AIONUI_STREAM_BROKEN', 'AIONUI_CONVERSATION_BUSY', 'AIONUI_STATE_INCONSISTENT', 'AIONUI_PERMISSION_ERROR', 'AIONUI_INTERNAL_ERROR'].every((c) => out.includes(c)) && !/AIONDX_(STREAM|CONVERSATION|STATE|PERMISSION|INTERNAL)/.test(out), out);
    ok(`${mode}: the enum variant the wire code comes from keeps its name`, out.includes('AionuiStreamBroken,'));
    ok(`${mode}: a variant that only starts like one is still renamed`, out.includes('AiondxConversationBusyRetry'));
    ok(`${mode}: the ownership key stays aionui in the minified catalog and its colour map`, out.includes('ownership:{aionui:"应用"') && out.includes('Rr={aionui:"red"'));
    ok(`${mode}: an aionui: that is not an object key (a link scheme) is still renamed`, out.includes('"aiondx://open"'));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const spawnEnv = (p) => `function buildSpawnEnv(dirs, extraEnv) {\n  const { PREBUILDS_ONLY: _prebuildsOnly, ...parentEnv } = process.env;\n  return {\n    ...parentEnv,\n` +
  `    ${p}_CACHE_DIR: dirs.cacheDir,\n    ${p}_WORK_DIR: dirs.workDir,\n    ${p}_LOG_DIR: dirs.logDir,\n    ...extraEnv\n  };\n}\n`;
const main = (s, c, p) => `const CORE_SESSION_COOKIE = "${s}";\nconst CORE_CSRF_COOKIE = "${c}";\n` + spawnEnv(p || (s.startsWith('aiondx') ? 'AIONDX' : 'AIONUI'));
// The stock binary keeps its strings run together (AIONUI_WORK_DIRAIONCORE_BOOTSTRAP_SECRET): a name is found inside a longer run.
const stockCore = Buffer.from('\0set-cookie\0aionui-session\0x-csrf-token\0aionui-csrf-token\0aionui/logsAIONUI_LOG_DIRaionuiAIONUI_WORK_DIRAIONCORE_BOOTSTRAP_SECRETAIONUI_CACHE_DIR\0', 'utf8');
const renamedCore = Buffer.from('\0aiondx-session\0aiondx-csrf-token\0AIONDX_CACHE_DIR\0AIONDX_WORK_DIR\0AIONDX_LOG_DIR\0', 'utf8');

ok('a stock-named app and the stock AionCore agree', check(main('aionui-session', 'aionui-csrf-token'), stockCore).problems.length === 0);
const broken = check(main('aiondx-session', 'aiondx-csrf-token'), stockCore);
ok('the 0.26.0 mismatch (renamed app, stock AionCore) is caught: both cookies and all three variables', broken.problems.length === 5, broken.problems.join(' | '));
ok('a renamed app and a renamed AionCore agree', check(main('aiondx-session', 'aiondx-csrf-token'), renamedCore).problems.length === 0);
ok('a stock-named app and a renamed AionCore are caught too', check(main('aionui-session', 'aionui-csrf-token'), renamedCore).problems.length === 5);
// 2026-11-08: a renamed core still holds the old names inside longer ones; a substring search passed it.
const decoyCore = Buffer.concat([renamedCore, Buffer.from('\0aionui-session-title\0crates\\aionui-session\\src\\a.rs\0crates/aionui-csrf-token/x\0AIONUI_CACHE_DIR_OVERRIDE\0AIONUI_WORK_DIR_X\0AIONUI_LOG_DIR2\0', 'latin1')]);
ok('names that only start a longer name, or sit in a crate path, do not count', check(main('aionui-session', 'aionui-csrf-token'), decoyCore).problems.length === 5);
const packedCore = Buffer.from('; Max-Age=\0aionui-sessionsec-websocket-protocolfailedaionui-csrf-token/api/authRK_DIRaionuiAIONUI_CACHE_DIRAIONUI_WORK_DIRAIONUI_LOG_DIR\0', 'latin1');
ok('a name packed against the next string literal still counts', check(main('aionui-session', 'aionui-csrf-token'), packedCore).problems.length === 0);
ok('a missing constant is reported, not passed', check('const CORE_CSRF_COOKIE = "aionui-csrf-token";\n' + spawnEnv('AIONUI'), stockCore).problems.length === 1);

// The start-up variables (0.26.0-0.26.4: the cookies fixed, the folder variables still renamed in the app alone).
const envOnly = check(main('aionui-session', 'aionui-csrf-token', 'AIONDX'), stockCore);
ok('a renamed app\'s folder variables and the stock AionCore are caught, all three', envOnly.problems.length === 3 && envOnly.problems.every((p) => /does not read/.test(p)), envOnly.problems.join(' | '));
ok('the variables are read from buildSpawnEnv, not the ones it strips', JSON.stringify(check(main('aionui-session', 'aionui-csrf-token'), stockCore).found.env) === '["AIONUI_CACHE_DIR","AIONUI_WORK_DIR","AIONUI_LOG_DIR"]');
// The error catalog (the other direction: codes AionCore sends, looked up by the page).
const catalog = (p, owner) => `{"ownership":{"${owner || 'aionui'}":"App","user_agent":"Agent"},"codes":{"${p}_STREAM_BROKEN":{"title":"t"},"USER_AGENT_DISCONNECTED":{"title":"t"},"OLD_CODE_NO_CORE_SENDS":{"title":"t"}}}`;
const coreWithCodes = Buffer.concat([stockCore, Buffer.from('AIONUI_CONVERSATION_BUSYAIONUI_STREAM_BROKENAIONUI_STATE_INCONSISTENTUSER_AGENT_DISCONNECTED')]);
const good = check(main('aionui-session', 'aionui-csrf-token'), coreWithCodes, [catalog('AIONUI')]);
ok('a catalog with the stock codes and the stock AionCore agree', good.problems.length === 0, good.problems.join(' | '));
ok('only brand-prefixed codes are held to it (a code no AionCore sends any more is not the rename\'s business)', JSON.stringify(good.found.codes) === '["AIONUI_STREAM_BROKEN"]');
const renamedCodes = check(main('aionui-session', 'aionui-csrf-token'), coreWithCodes, [catalog('AIONDX')]);
ok('a catalog renamed to AIONDX_* is caught, naming what AionCore sends', renamedCodes.problems.length === 1 && /has AIONDX_STREAM_BROKEN.*sends AIONUI_STREAM_BROKEN/.test(renamedCodes.problems[0]), renamedCodes.problems.join(' | '));
ok('codes in the main process count too, not only the page', check(main('aionui-session', 'aionui-csrf-token') + catalog('AIONDX'), coreWithCodes, []).problems.length === 1);
const mixedOwners = check(main('aionui-session', 'aionui-csrf-token'), coreWithCodes, [catalog('AIONUI'), 'ownership:{aiondx:"应用",user_agent:"Agent"}']);
ok('ownership labels renamed in some languages only are caught', mixedOwners.problems.length === 1 && /ownership/.test(mixedOwners.problems[0]), mixedOwners.problems.join(' | '));
ok('ownership labels the same in every language pass', check(main('aionui-session', 'aionui-csrf-token'), coreWithCodes, [catalog('AIONUI'), 'ownership:{aionui:"应用",user_agent:"Agent"}']).problems.length === 0);

ok('a main process with no buildSpawnEnv is reported, not passed', check('const CORE_SESSION_COOKIE = "aionui-session";\nconst CORE_CSRF_COOKIE = "aionui-csrf-token";\n', stockCore).problems.some((p) => /buildSpawnEnv/.test(p)));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${!r.ok && r.detail ? ' -- ' + r.detail : ''}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
