#!/usr/bin/env node
/**
 * audit-literals.js - the code around each bare "AionUi" string literal in the main and renderer bundles, so each can be
 * classed as display text (to rename), a folder or product key (to leave: the data folder and protocol are shared with
 * AionUi on purpose), or a log line.
 *
 *   node tools\audit-literals.js <extracted asar dir> [needle]       default needle: AionUi (exact, case-sensitive)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const needle = process.argv[3] || 'AionUi';
if (!dir) { console.error('usage: node audit-literals.js <dir> [needle]'); process.exit(2); }
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/out[\/\\](renderer[\/\\]assets|main|preload)[\/\\].*\.js$/.test(p) && !/aionui-dx\.js$/.test(p)) files.push(p);
  }
})(dir);
const NL = String.fromCharCode(10);
const seen = new Set();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const q of ['"', "'", '`']) {
    const lit = q + needle + q;
    let i = -1;
    while ((i = s.indexOf(lit, i + 1)) >= 0) {
      const ctx = s.slice(Math.max(0, i - 90), i + lit.length + 70).split(NL).join(' ');
      const key = ctx.slice(60, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(path.basename(f) + ':' + i + '  ' + ctx);
    }
  }
}
console.log(seen.size + ' distinct contexts');
