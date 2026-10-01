#!/usr/bin/env node
/**
 * Tests for patch 0006. Run: node patches\0006-butler-to-antigravity\test.js
 *
 * Reads the renderer chunks that mention the Butler out of app.asar.stock (so it keeps working
 * after a build), applies the patch in memory and on a throwaway tree, and checks: every edit
 * lands with its expected count; nothing that says "Butler" in English is left; a second run
 * changes nothing; a missing or doubled anchor refuses and writes nothing; every patched chunk
 * still parses as an ES module.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const patch = require('./apply.js');
const ROOT = path.resolve(__dirname, '..', '..');
const STOCK = 'C:\\Program Files\\AionUi\\resources\\app.asar.stock';
const ASAR = path.join(ROOT, 'vendor', 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '   ' + String(detail).slice(0, 300) : '')); } };
setTimeout(() => { console.log('DEADLINE: 0006 tests did not finish in 150 s'); process.exit(2); }, 150000).unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-0006-'));
const listing = execFileSync(process.execPath, [ASAR, 'list', STOCK], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const assets = listing.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[\\/]out[\\/]renderer[\\/]assets[\\/][^\\/]+\.js$/.test(l));
const files = {};
for (const a of assets) {
  const inner = a.replace(/^[\\/]/, '');
  const d = fs.mkdtempSync(path.join(tmp, 'x-'));
  execFileSync(process.execPath, [ASAR, 'extract-file', STOCK, inner], { cwd: d, windowsHide: true, stdio: 'ignore' });
  const t = fs.readFileSync(path.join(d, path.basename(inner)), 'utf8');
  if (/aionui-assistant|[Bb]utler/.test(t)) files[path.basename(inner)] = t;
}
check('stock chunks that mention the Butler were read', Object.keys(files).length >= 2, Object.keys(files).join(', '));

let r;
try { r = patch.patchAssets(files); } catch (e) { check('applies to the stock renderer', false, e.message); process.exit(1); }
check('applies to the stock renderer', r.notes.every((n) => !/already/.test(n)), r.notes.join(' | '));
const all = Object.values(r.files).join('\n');
check('the hook now targets plain Antigravity', new RegExp('const \\w+="' + patch.TARGET + '",\\w+=\\w+=>\\{const \\w+=new Set').test(all));
check('no English Butler label is left',
  !/"Ask the Butler"|"Enabled the AionUi Butler for you"|"Let the butler set it up"|chatting with the butler|\{butler:"AionUi Butler"/.test(all));
check('the new labels are in', /"Ask Antigravity"/.test(all) && /"Let Antigravity set it up"/.test(all) && /"Enabled Antigravity for you"/.test(all));
check('other languages keep their own words', /\{butler:"AionUi 管家"/.test(all) && /Butler fragen/.test(all));
check('the onboarding featured assistant points at Antigravity', all.includes('{id:"' + patch.TARGET + '",nameKey:"onboarding.cast.butler"'));

const twice = patch.patchAssets(r.files);
check('a second run changes nothing', Object.keys(twice.files).every((n) => twice.files[n] === r.files[n]) && twice.notes.every((n) => /already done/.test(n)));

let threw = null;
const broken = Object.assign({}, files);
for (const n of Object.keys(broken)) broken[n] = broken[n].replace(/solveWithButler:"Ask the Butler"/g, 'solveWithButler:"Ask the Maid"');
try { patch.patchAssets(broken); } catch (e) { threw = e.message; }
check('a missing anchor refuses', threw && /Ask the Butler/.test(threw), threw);
threw = null;
const doubled = Object.assign({}, files);
const first = Object.keys(doubled).find((n) => doubled[n].includes(':"Let the butler set it up"'));
doubled[first] += '\nvar zz={x:"Let the butler set it up"};';
try { patch.patchAssets(doubled); } catch (e) { threw = e.message; }
check('a doubled anchor refuses', threw && /expected \d+ match\(es\), found \d+/.test(threw), threw);

// ES module syntax of every changed chunk
let parsedOk = true, bad = '';
for (const [n, t] of Object.entries(r.files)) {
  if (t === files[n]) continue;
  const f = path.join(tmp, n.replace(/\.js$/, '.mjs'));
  fs.writeFileSync(f, t);
  const s = spawnSync(process.execPath, ['--check', f], { windowsHide: true, encoding: 'utf8' });
  if (s.status !== 0) { parsedOk = false; bad = n + ': ' + s.stderr; break; }
}
check('every patched chunk still parses as an ES module', parsedOk, bad);

// apply.js end to end on a throwaway tree
const tree = path.join(tmp, 'tree', 'out', 'renderer', 'assets');
fs.mkdirSync(tree, { recursive: true });
for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(tree, n), t);
fs.writeFileSync(path.join(tree, 'unrelated.js'), 'export const a = 1;');
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'apply.js'), path.join(tmp, 'tree')], { windowsHide: true, encoding: 'utf8' });
const r1 = run();
const snap1 = Object.fromEntries(fs.readdirSync(tree).map((n) => [n, fs.readFileSync(path.join(tree, n), 'utf8')]));
const r2 = run();
const snap2 = Object.fromEntries(fs.readdirSync(tree).map((n) => [n, fs.readFileSync(path.join(tree, n), 'utf8')]));
check('apply.js exits 0, then 0 again with identical files', r1.status === 0 && r2.status === 0 && JSON.stringify(snap1) === JSON.stringify(snap2), r1.stderr + r2.stderr);
check('files with nothing to change are not rewritten', snap1['unrelated.js'] === 'export const a = 1;');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
