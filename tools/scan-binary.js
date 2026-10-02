#!/usr/bin/env node
/**
 * scan-binary.js - does a file (an exe, a dll, an asar, a whole folder) contain text it should not ship with? Reads the bytes, as ASCII and as
 * UTF-16 (Windows resources and .NET strings are the latter), and reports the terms found with a little context.
 *
 *   node tools\scan-binary.js <file or folder> [term ...]      default terms: the Windows user name, the machine name, this project's folder
 *
 * Exit code 1 when anything is found. Read-only.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const target = process.argv[2];
if (!target) { console.error('usage: node scan-binary.js <file or folder> [term ...]'); process.exit(2); }
const extra = process.argv.slice(3);
const terms = extra.length ? extra : [os.userInfo().username, os.hostname(), 'AI Projects\\AionDX', 'AI Projects/AionDX'];
const lc = terms.map((t) => t.toLowerCase());

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) yield* walk(path.join(p, e)); } else yield p;
}
function utf16(s) { return Buffer.from(s, 'utf16le'); }
let hits = 0, scanned = 0;
for (const f of walk(target)) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { continue; }
  scanned++;
  const lower = Buffer.from(buf.toString('latin1').toLowerCase(), 'latin1');
  terms.forEach((t, i) => {
    for (const [kind, needle] of [['ascii', Buffer.from(lc[i], 'latin1')], ['utf16', utf16(lc[i])]]) {
      let at = lower.indexOf(needle), n = 0;
      while (at >= 0) {
        n++;
        if (n <= 2) {
          const ctx = lower.slice(Math.max(0, at - 50), at + needle.length + 50);
          const text = kind === 'utf16' ? buf.slice(Math.max(0, at - 50), at + needle.length + 50).toString('utf16le') : buf.slice(Math.max(0, at - 50), at + needle.length + 50).toString('latin1');
          console.log(path.relative(process.cwd(), f) + ' [' + kind + ' ' + JSON.stringify(t) + ' x' + (n) + ']: ' + JSON.stringify(text.replace(/[^\x20-\x7e]/g, '.')));
        }
        at = lower.indexOf(needle, at + needle.length);
      }
      if (n) hits += n;
    }
  });
}
console.log('scanned ' + scanned + ' file(s), ' + hits + ' hit(s) for ' + terms.map((t) => JSON.stringify(t)).join(', '));
process.exit(hits ? 1 : 0);
