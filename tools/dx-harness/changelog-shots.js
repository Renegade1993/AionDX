#!/usr/bin/env node
/**
 * changelog-shots.js - makes the Changelog's pictures (Settings > About > Changelog, November 17th, 2026). Runs the whole click suite with
 * AIONDX_CHANGELOG_SHOTS set: at the moment each What's new item's control is on screen, its section calls clogShot (or clogMenu), which
 * puts a tip's bubble with the item's name on the control and saves a close-up, light and dark, as
 * patches\0001-renderer-dx\changelog\v<release>-<item>-<light|dark>.png. The build copies that folder to out\renderer\aiondx-changelog.
 * Then it lists every item of every release (read from the renderer) that has no picture, and the pictures no item asks for.
 *
 *   node tools\dx-harness\changelog-shots.js             (start it hidden, like the click suite: tools\run-changelog-shots.cmd)
 *
 * A new release's items get pictures by adding a clogShot call in the section that shows each one, then running this.
 * Exit 0 only when every item has both pictures.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'patches', '0001-renderer-dx', 'changelog');
fs.mkdirSync(OUT, { recursive: true });
// --sections a b c: only those click sections (through run-sections.js), keeping the pictures already made. The whole suite with pictures
// can outrun its own 1500 s limit (November 17th, 2026: 21 of 34 made), so the rest are made section by section.
const si = process.argv.indexOf('--sections');
const sections = si >= 0 ? process.argv.slice(si + 1).filter((a) => !a.startsWith('--')) : null;
const keep = process.argv.includes('--keep') || !!sections;   // keep pictures made before (default: start clean, so none is stale)
if (!keep) for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
const r = spawnSync(process.execPath, sections ? [path.join(__dirname, 'run-sections.js')].concat(sections) : [path.join(__dirname, 'click-test.js')],
  { cwd: __dirname, env: Object.assign({}, process.env, { AIONDX_CHANGELOG_SHOTS: OUT }), encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
const log = String(r.stdout || '') + String(r.stderr || '');
fs.writeFileSync(path.join(ROOT, '.tmp', 'changelog-shots.out'), log);
const clogLines = log.split('\n').filter((l) => /^CLOG /.test(l));
// every item the renderer lists (the same names it asks for)
const ui = fs.readFileSync(path.join(ROOT, 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8');
const block = ui.slice(ui.indexOf('var WHATS_NEW = {'), ui.indexOf('var WHATS_NEW_KEY'));
const slug = (t) => String(t).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
const un = (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\'/g, "'");
const want = [];
let rel = null;
for (const line of block.split('\n')) {
  const m = /release: '([^']+)'/.exec(line);
  if (m) rel = m[1];
  const it = /^\s*\['((?:[^'\\]|\\.)*)', '/.exec(line);
  if (it && rel) want.push('v' + rel.replace(/\./g, '-') + '-' + slug(un(it[1])));
}
const have = new Set(fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).map((f) => f.replace(/-(light|dark)\.png$/, '')));
const missing = want.filter((p) => !fs.existsSync(path.join(OUT, p + '-light.png')) || !fs.existsSync(path.join(OUT, p + '-dark.png')));
const extra = [...have].filter((p) => want.indexOf(p) < 0);
console.log(clogLines.join('\n'));
console.log(`\n${want.length} items; ${want.length - missing.length} with both pictures; click suite exit ${r.status}`);
if (missing.length) console.log('missing:\n  ' + missing.join('\n  '));
if (extra.length) console.log('pictures no item asks for:\n  ' + extra.join('\n  '));
process.exit(missing.length ? 1 : 0);
