#!/usr/bin/env node
/**
 * pack-asar.js - packs an extracted AionUi app into an asar the way the stock one is packed.
 *
 *   node tools\pack-asar.js <extracted dir> <stock app.asar> <output app.asar>
 *
 * WHY. `asar pack` with no options puts every file inside the archive. The stock app.asar marks 214
 * files "unpacked": four native modules (better-sqlite3, keytar, @napi-rs/canvas, rollup), the JS
 * around them, and out/main/builtin-mcp-browser.js and builtin-mcp-image-gen.js. Electron reads an
 * unpacked file from resources\app.asar.unpacked instead of the archive. Packed inside, a native
 * module is copied to %TEMP% on every launch before it loads (the *.tmp.node files found there on
 * September 26th), which antivirus software may flag. Research: ! LLM Files\Research\
 * 2026-09-26_installer-and-breadcrumbs.md, gotcha 3.
 *
 * So this reads the stock header, and every file and folder it marks unpacked is marked unpacked
 * here too; their contents stay in the app.asar.unpacked folder that AionUi's installer put on disk.
 * AionDX changes none of them: the build refuses to run if one of them differs from that folder's
 * copy (<stock app.asar>.unpacked). A difference from the header's own hash is only reported:
 * AionUi 2.2.2's installer ships a better_sqlite3.node whose hash differs from the one its header
 * records (1,901,568 bytes on disk, 1,902,080 in the header, both dated September 9th's install),
 * and the file on disk is the one every AionUi 2.2.2 PC runs. The packer writes copies of the
 * unpacked files to <output>.unpacked, which is not shipped.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require(require.resolve('@electron/asar', { paths: [path.join(__dirname, '..', 'vendor')] }));

const [extArg, stockArg, outArg] = process.argv.slice(2);
if (!extArg || !stockArg || !outArg) { console.error('usage: node pack-asar.js <extracted dir> <stock app.asar> <output app.asar>'); process.exit(2); }
const ext = path.resolve(extArg), stock = path.resolve(stockArg), out = path.resolve(outArg);

const header = asar.getRawHeader(stock).header;
const unpackedFiles = new Map();   // relative path (forward slashes) -> integrity hash from the stock header
const unpackedDirs = new Set();
(function walk(node, pre) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = pre ? pre + '/' + k : k;
    if (v.files) { if (v.unpacked) unpackedDirs.add(p); walk(v, p); }
    else if (v.unpacked) unpackedFiles.set(p, v.integrity && v.integrity.hash);
  }
})(header, '');

// Every stock-unpacked file must be present, and the same as the installed copy beside the stock asar.
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const onDisk = stock + '.unpacked';
let bad = 0;
for (const [rel, hash] of unpackedFiles) {
  const f = path.join(ext, ...rel.split('/'));
  if (!fs.existsSync(f)) { console.error('missing unpacked file: ' + rel); bad++; continue; }
  const got = sha(f);
  const installed = path.join(onDisk, ...rel.split('/'));
  if (fs.existsSync(installed) && sha(installed) !== got) { console.error('changed unpacked file (AionDX must not patch it): ' + rel); bad++; }
  if (hash && hash !== got) console.log('note: ' + rel + ' differs from the stock header\'s hash (as AionUi installed it)');
}
if (bad) { console.error(bad + ' problem(s); nothing written.'); process.exit(1); }

const streams = [];
(function walk(dir, rel) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      streams.push({ path: r, type: 'directory', unpacked: unpackedDirs.has(r) });
      walk(abs, r);
    } else if (st.isFile()) {
      streams.push({ path: r, type: 'file', stat: { mode: st.mode, size: st.size }, unpacked: unpackedFiles.has(r),
        streamGenerator: () => fs.createReadStream(abs) });
    }
  }
})(ext, '');

// @electron/asar 4.3 hashes small files by the archive-relative path, which resolves against the current
// folder (lib/filesystem.js insertFile), then shares identical files by that hash. Run from anywhere else, a
// file with the same relative path there was hashed instead (bug sweep, September 26th: two LICENSE entries
// pointed at another file's bytes). From inside the tree, every relative path is the file itself.
process.chdir(ext);
asar.createPackageFromStreams(out, streams).then(() => {
  const marked = asar.getRawHeader(out).header;
  let n = 0;
  (function walk(node) { for (const v of Object.values(node.files || {})) { if (v.files) walk(v); else if (v.unpacked) n++; } })(marked);
  console.log(`packed ${streams.length} entries into ${out}; ${n} file(s) marked unpacked (stock: ${unpackedFiles.size})`);
  if (n !== unpackedFiles.size) { console.error('unpacked count differs from stock'); process.exit(1); }
  // Every packed entry's recorded hash is its own source file's.
  let wrong = 0, checked = 0;
  (function walk(node, rel) {
    for (const [k, v] of Object.entries(node.files || {})) {
      const r = rel ? rel + '/' + k : k;
      if (v.files) { walk(v, r); continue; }
      if (v.unpacked || !v.integrity) continue;
      checked++;
      const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(ext, ...r.split('/')))).digest('hex');
      if (got !== v.integrity.hash) { if (wrong < 10) console.error('wrong hash for ' + r); wrong++; }
    }
  })(marked, '');
  if (wrong) { console.error(wrong + ' packed entries carry another file\'s hash; the asar is not usable.'); process.exit(1); }
  console.log(`checked ${checked} packed entries against their sources`);
}, (e) => { console.error('pack failed: ' + (e && e.stack || e)); process.exit(1); });
