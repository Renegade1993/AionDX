#!/usr/bin/env node
/**
 * test-plugins.js: the main process's aiondx:plugins handler (the helper block in apply.js), run outside Electron with
 * a stand-in ipcMain. It checks what the handler refuses, then runs a real "claude plugin list --json" through it
 * when claude is on PATH (skipped, and said so, when it is not). 60 s deadline.
 *
 *   node patches\0009-identity\test-plugins.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);
const src = fs.readFileSync(path.join(__dirname, 'apply.js'), 'utf8');
const a = src.indexOf('const HELPER = `');
const b = src.indexOf('${HELPER_END}\n`;', a);
// eslint-disable-next-line no-unused-vars
const HELPER_BEGIN = '/* AIONDX-0009 BEGIN', HELPER_END = '/* AIONDX-0009 END */';
// eslint-disable-next-line no-eval
const helper = eval(src.slice(a + 'const HELPER = '.length, b + '${HELPER_END}\n`'.length));
// Only the plugins block: the rest of the helper starts programs and reads the asar.
const start = helper.indexOf('(function __aiondxPlugins() {');
const end = helper.indexOf('})();', start) + '})();'.length;
const block = helper.slice(start, end);

const handlers = {};
const electron = { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
// eslint-disable-next-line no-new-func
new Function('require$$0$2', 'path__namespace', 'fs__namespace', 'require', 'process', block)(electron, path, fs, require, process);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
(async () => {
  const run = handlers['aiondx:plugins'];
  check('the handler is registered', typeof run === 'function');
  const refused = async (args, re) => { const r = await run(null, { args }); return r.ok === false && re.test(r.error || ''); };
  check('no arguments is refused', await refused([], /bad arguments/));
  check('a command other than the plugin ones is refused', await refused(['eval', 'x'], /not a plugin command: eval/));
  check('a marketplace command other than add, list, remove, update is refused', await refused(['marketplace', 'nuke'], /not a marketplace command/));
  check('an option outside the list is refused (-y would accept a marketplace command unseen)', await refused(['install', 'x@y', '-y'], /option not allowed here: -y/));
  check('a quote or a control character is refused', await refused(['install', 'x"y'], /bad arguments/) && await refused(['install', 'a\nb'], /bad arguments/));
  check('more than 12 arguments is refused', await refused(new Array(13).fill('x').map((x, i) => (i ? x : 'list')), /bad arguments/));
  check('an option value is skipped, not read as an option', (await run(null, { args: ['list', '--scope', '-weird'] })).error !== 'option not allowed here: -weird');

  const pathDirs = String(process.env.PATH || '').split(path.delimiter);
  const hasClaude = pathDirs.some((d) => ['claude.exe', 'claude.cmd'].some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch { return false; } }));
  if (hasClaude) {
    const r = await run(null, { args: ['list', '--json', '--available'] });
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* reported below */ }
    check('claude plugin list --json --available runs through it and answers JSON', r.ok && j && Array.isArray(j.installed) && Array.isArray(j.available),
      (r.error || r.err || r.out || '').slice(0, 300));
    const m = await run(null, { args: ['marketplace', 'list'] });
    check('claude plugin marketplace list runs through it', m.ok && /marketplace/i.test(m.out), (m.error || m.err || '').slice(0, 300));
  } else {
    console.log('SKIP  claude is not on PATH here: the live runs were not made');
  }

  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n      ${x.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  clearTimeout(deadline);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
