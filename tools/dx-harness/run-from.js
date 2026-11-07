#!/usr/bin/env node
/**
 * run-from.js - runs the click suite from one scenario to the end, skipping the ones before it, so a scenario can be tried in under a minute.
 *
 *   node tools\dx-harness\run-from.js swap            from the scenario named swap (its  const sc = 'swap';  line) to the end
 *   node tools\dx-harness\run-from.js options links   the named scenarios only, in file order
 *
 * It writes click-test-run.tmp.js beside click-test.js (a copy with the earlier scenarios cut out, and the few helpers that sit among them kept),
 * runs it, and deletes it. Scenarios that depend on state set up by an earlier one will fail here and pass in the whole suite; the whole suite is the check.
 * Headless Edge on its own debugging port, killed on exit.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const names = process.argv.slice(2);
if (!names.length) { console.log('usage: node tools\\dx-harness\\run-from.js <scenario> [more scenarios]'); process.exit(2); }
const src = fs.readFileSync(path.join(__dirname, 'click-test.js'), 'utf8');
const startOf = (name) => {
  const at = src.indexOf("const sc = '" + name + "';");
  if (at < 0) throw new Error('no scenario named ' + name);
  return src.lastIndexOf('\n    {', at) + 1;
};
const first = src.indexOf("const sc = '");
const firstBlock = src.lastIndexOf('\n    {', first) + 1;
const endMarker = src.indexOf('    clearTimeout(deadline);');
// Helpers declared on one line among the cut scenarios (store, toasts, posts, ...) are kept, when nothing before the cut declares them.
const prefix = src.slice(0, firstBlock);
const cutRegion = src.slice(firstBlock, endMarker);
const seen = new Set();
const helpers = cutRegion.split('\n').filter((l) => {
  const m = /^    const (\w+) = (?:async )?\(?.*;\s*$/.exec(l);
  if (!m || seen.has(m[1]) || new RegExp('\\bconst ' + m[1] + '\\b').test(prefix)) return false;
  const opens = (l.match(/[({[]/g) || []).length, closes = (l.match(/[)}\]]/g) || []).length;
  if (opens !== closes) return false;
  seen.add(m[1]);
  return true;
}).join('\n') + '\n';
let body;
if (names.length === 1) {
  body = src.slice(startOf(names[0]), endMarker);
} else {
  const picks = names.map((n) => { const a = startOf(n); const b = src.indexOf('\n    {', a + 5); return [a, src.indexOf('\n    }\n', a) + 7, n]; });
  body = picks.sort((x, y) => x[0] - y[0]).map((p) => src.slice(p[0], p[1])).join('\n');
}
const out = src.slice(0, firstBlock) + helpers + body + src.slice(endMarker);
const tmp = path.join(__dirname, 'click-test-run.tmp.js');
fs.writeFileSync(tmp, out);
try { spawnSync('taskkill', ['/F', '/IM', 'msedge.exe'], { windowsHide: true, timeout: 15000 }); } catch (e) { /* none running */ }
const r = spawnSync(process.execPath, [tmp], { stdio: 'inherit', windowsHide: true, timeout: 600000 });
try { fs.rmSync(tmp, { force: true }); } catch (e) { /* leave it */ }
process.exit(r.status === null ? 2 : r.status);
