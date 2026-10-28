#!/usr/bin/env node
/**
 * Tests for patch 0012. Run: node patches\0012-mcp-oauth-ui-state\test.js
 *
 * Reads the renderer chunk that defines markLoginRequired out of app.asar.stock (so it keeps
 * working after a build), applies the patch in memory and on a throwaway tree, and checks: the
 * anchor lands with its expected count; isAuthenticated is forced to false, not carried forward;
 * a second run changes nothing; a missing or doubled anchor refuses and writes nothing; the
 * patched chunk still parses as an ES module.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const patch = require('./apply.js');
const ROOT = path.resolve(__dirname, '..', '..');
// The stock asar: an installed AionUi's backup, else an installed AionDX's (same build), else
// the copy tools/fetch-aionui-base.js unpacks into vendor/aionui-base.
const STOCK = [
  'C:\\Program Files\\AionUi\\resources\\app.asar.stock',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'AionDX', 'resources', 'app.asar.stock'),
  path.join(ROOT, 'vendor', 'aionui-base', 'resources', 'app.asar'),
].find((p) => fs.existsSync(p)) || 'C:\\Program Files\\AionUi\\resources\\app.asar.stock';
const ASAR = path.join(ROOT, 'vendor', 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '   ' + String(detail).slice(0, 300) : '')); } };
setTimeout(() => { console.log('DEADLINE: 0012 tests did not finish in 150 s'); process.exit(2); }, 150000).unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-0012-'));
const listing = execFileSync(process.execPath, [ASAR, 'list', STOCK], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const assets = listing.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[\\/]out[\\/]renderer[\\/]assets[\\/][^\\/]+\.js$/.test(l));
const files = {};
for (const a of assets) {
  const inner = a.replace(/^[\\/]/, '');
  const d = fs.mkdtempSync(path.join(tmp, 'x-'));
  execFileSync(process.execPath, [ASAR, 'extract-file', STOCK, inner], { cwd: d, windowsHide: true, stdio: 'ignore' });
  const t = fs.readFileSync(path.join(d, path.basename(inner)), 'utf8');
  if (/markLoginRequired/.test(t)) files[path.basename(inner)] = t;
}
check('stock chunk with markLoginRequired was read', Object.keys(files).length === 1, Object.keys(files).join(', '));

let r;
try { r = patch.patchAssets(files); } catch (e) { check('applies to the stock renderer', false, e.message); process.exit(1); }
check('applies to the stock renderer', r.notes.every((n) => !/already/.test(n)), r.notes.join(' | '));
const all = Object.values(r.files).join('\n');
check('isAuthenticated is forced to false, not carried forward',
  /markLoginRequired:\w+\.useCallback\(\w+=>\{\w+\(\w+=>\(\{\.\.\.\w+,\[\w+\]:\{isAuthenticated:!1,needsLogin:!0,isChecking:!1\}\}\)\)\},\[\]\)/.test(all));
check('the old carried-forward form is gone', !/isAuthenticated:\w+\[\w+\]\?\.isAuthenticated\?\?!1,needsLogin:!0/.test(all));

const twice = patch.patchAssets(r.files);
check('a second run changes nothing', Object.keys(twice.files).every((n) => twice.files[n] === r.files[n]) && twice.notes.every((n) => /already done/.test(n)));

let threw = null;
const broken = Object.assign({}, files);
for (const n of Object.keys(broken)) broken[n] = broken[n].replace(/markLoginRequired/g, 'markLoginRequiredX');
try { patch.patchAssets(broken); } catch (e) { threw = e.message; }
check('a missing anchor refuses', threw && /anchor not found/.test(threw), threw);
threw = null;
const doubled = Object.assign({}, files);
const first = Object.keys(doubled)[0];
doubled[first] += '\n' + doubled[first].match(patch.ANCHOR)[0] + ';';
try { patch.patchAssets(doubled); } catch (e) { threw = e.message; }
check('a doubled anchor refuses', threw && /expected 1 match\(es\), found 2/.test(threw), threw);

// ES module syntax of the changed chunk
let parsedOk = true, bad = '';
for (const [n, t] of Object.entries(r.files)) {
  if (t === files[n]) continue;
  const f = path.join(tmp, n.replace(/\.js$/, '.mjs'));
  fs.writeFileSync(f, t);
  const s = spawnSync(process.execPath, ['--check', f], { windowsHide: true, encoding: 'utf8' });
  if (s.status !== 0) { parsedOk = false; bad = n + ': ' + s.stderr; break; }
}
check('the patched chunk still parses as an ES module', parsedOk, bad);

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
