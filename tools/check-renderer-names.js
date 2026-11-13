#!/usr/bin/env node
// check-renderer-names.js - fails when a name is declared twice at the same level of patches\0001-renderer-dx\aiondx-ui.js.
//
// The renderer is one long function. Two `function showTip` declarations in it do not raise an error: the later one silently replaces the
// earlier everywhere (2026-11-13: the tips' showTip/hideTip/placeTip replaced the Loop hover card's, and 15 click tests failed). This reads the
// file with a small scanner (strings, comments, regex literals and template literals skipped), tracks brace depth, and reports every function
// or var name declared more than once at the same depth inside the same enclosing block.
//   node tools\check-renderer-names.js [file]          exit 0 clean, 1 duplicates found
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js');
const src = fs.readFileSync(file, 'utf8');

// Blank out strings, comments, template literals and regex literals, keeping line breaks, so braces and names inside them are not seen.
function blank(s) {
  let out = '', i = 0, prevSig = '';
  const n = s.length;
  const keep = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += keep(s[i]); i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'") {
      out += ' '; i++;
      while (i < n && s[i] !== c) { if (s[i] === '\\') { out += ' '; i++; } out += keep(s[i]); i++; }
      out += ' '; i++; prevSig = 'x'; continue;
    }
    if (c === '`') {
      out += ' '; i++;
      while (i < n && s[i] !== '`') { if (s[i] === '\\') { out += ' '; i++; } out += keep(s[i]); i++; }
      out += ' '; i++; prevSig = 'x'; continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$|return$|typeof$/.test(prevSig)) {
      // a regex literal
      out += ' '; i++; let cls = false;
      while (i < n && (s[i] !== '/' || cls)) { if (s[i] === '\\') { out += ' '; i++; } else if (s[i] === '[') cls = true; else if (s[i] === ']') cls = false; out += keep(s[i]); i++; }
      out += ' '; i++;
      while (i < n && /[a-z]/i.test(s[i])) { out += ' '; i++; }
      prevSig = 'x'; continue;
    }
    out += c;
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) { let w = c, j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(s[j])) { w += s[j]; j++; } out += s.slice(i + 1, j); i = j; prevSig = w === 'return' || w === 'typeof' ? w : 'x'; continue; }
      prevSig = c;
    }
    i++;
  }
  return out;
}

const text = blank(src);
const lines = text.split('\n');
const scopes = [{ names: new Map() }];   // a stack of blocks; each records the names declared directly in it
const dups = [];
const DECL = /\b(function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/g;
for (let ln = 0; ln < lines.length; ln++) {
  const line = lines[ln];
  let k = 0;
  // walk the line: declarations take the block they appear in, braces open and close blocks
  const events = [];
  let m;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(line))) events.push({ at: m.index, name: m[2] || m[3], kind: m[2] ? 'function' : 'var' });
  for (let i = 0; i < line.length; i++) {
    while (k < events.length && events[k].at === i) {
      const e = events[k++];
      const top = scopes[scopes.length - 1].names;
      if (top.has(e.name)) dups.push({ name: e.name, kind: e.kind, first: top.get(e.name), again: ln + 1 });
      else top.set(e.name, ln + 1);
    }
    if (line[i] === '{') scopes.push({ names: new Map() });
    else if (line[i] === '}' && scopes.length > 1) scopes.pop();
  }
}
// var redeclared as var in one function is legal and sometimes deliberate (loop counters); only functions, and a function and a var sharing a
// name, are reported, plus vars whose first declaration is far away (more than 200 lines: two features, not one loop).
const real = dups.filter((d) => d.kind === 'function' || d.again - d.first > 200);
if (!real.length) { console.log(`check-renderer-names: ${path.basename(file)} clean`); process.exit(0); }
for (const d of real) console.log(`DUPLICATE ${d.kind} ${d.name}: line ${d.first} and line ${d.again}`);
console.log(`check-renderer-names: ${real.length} name(s) declared twice in one block; the later replaces the earlier`);
process.exit(1);
