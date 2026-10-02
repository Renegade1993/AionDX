#!/usr/bin/env node
/**
 * scrub-user-quotes.js - takes the project owner's own words out of text that is published. Comments and notes here credit a change to
 * the request that caused it, by quoting the request after the owner's alias, and that is the owner's writing, so it does not go public.
 * Each such quotation (an attribution to the alias, then a quotation that is at least 20 characters, on one line or running over
 * comment lines) becomes "a request of 2026-01-01", or "a request" with no date. The rest of the comment stays.
 *
 *   node tools\scrub-user-quotes.js --alias X <file ...>            rewrite the files
 *   node tools\scrub-user-quotes.js --alias X --check <file ...>    report what would change, write nothing
 *   node tools\scrub-user-quotes.js --alias X --left <file ...>     list the lines that still pair the alias with a double quote
 *
 * The alias is an argument so that this file does not name the person it protects.
 */
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const aliasAt = args.indexOf('--alias');
const ALIAS = aliasAt >= 0 ? args[aliasAt + 1] : '';
const CHECK = args.includes('--check');
const LEFT = args.includes('--left');
const files = args.filter((a, i) => !a.startsWith('--') && i !== aliasAt + 1);
if (!ALIAS || !files.length) { console.error('usage: node scrub-user-quotes.js --alias NAME [--check|--left] <file ...>'); process.exit(2); }
const esc = ALIAS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE = '(?:\\d{4}-\\d{2}-\\d{2}|' + MONTH + ' \\d{1,2}(?:st|nd|rd|th)?(?:, \\d{4})?)';
// The alias, then any of: a date, "after ...", a verb of saying; then a colon or comma; then a quotation mark (possibly after ( or ** or *).
const ATTRIB = new RegExp('\\b' + esc + '(?:\\u2019s|\'s)?(?:[ ,]+(?:' + DATE + '|after [^"\\u201c\\n]{1,40}|said|asked|wrote|wants?|saw|reported|on [A-Za-z ]{1,20}))*\\s*[:,]?\\s*\\(?\\*{0,2}["\\u201c]', 'g');
const MIN_QUOTE = 20;
const MAX_QUOTE = 1800;

function scrub(text) {
  let out = '', last = 0, count = 0;
  ATTRIB.lastIndex = 0;
  let m;
  while ((m = ATTRIB.exec(text))) {
    const q = m.index + m[0].length - 1;                 // the opening quotation mark
    let e = -1;
    for (let i = q + 1; i < Math.min(text.length, q + MAX_QUOTE); i++) {
      const c = text[i];
      if ((c === '"' || c === '”') && text[i - 1] !== '\\') { e = i; break; }
    }
    if (e < 0 || e - q - 1 < MIN_QUOTE) continue;
    let end = e + 1;
    while (text[end] === '*') end++;                      // *"quoted"*  (Markdown italics)
    const d = new RegExp(DATE).exec(m[0]);
    const rep = 'a request' + (d ? ' of ' + d[0] : '');
    out += text.slice(last, m.index) + rep;
    last = end;
    count++;
    ATTRIB.lastIndex = end;
  }
  return { text: out + text.slice(last), count };
}

let total = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  if (LEFT) {
    const word = new RegExp('\\b' + esc + '\\b');
    raw.split(/\r?\n/).forEach((line, i) => { if (word.test(line) && /["“]/.test(line)) console.log(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 200)); });
    continue;
  }
  const r = scrub(raw);
  if (r.count) { total += r.count; console.log((CHECK ? 'would change ' : 'changed ') + f + ': ' + r.count + ' quotation(s)'); if (!CHECK) fs.writeFileSync(f, r.text); }
}
if (!LEFT) console.log(total + ' quotation(s) ' + (CHECK ? 'found' : 'replaced'));
