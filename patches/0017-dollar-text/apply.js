#!/usr/bin/env node
/**
 * AionDX patch 0017-dollar-text: a dollar sign in a chat message is a dollar sign, not the start of a formula.
 *
 *   node patches\0017-dollar-text\apply.js <extracted-asar-root>
 *
 * Written 2026-11-02 after a report: "$1M/$2M" and "$40,000 ... $12,500"
 * came out as italic maths with the spaces gone, because remark-math treats any text between two single
 * dollar signs as inline maths. Money is far more common in chats than inline maths.
 *
 * HOW. remark-math's mathText() tokenizer reads the option singleDollarTextMath and, when the app does not
 * pass one (AionUi does not), defaults it to true. This patch changes that default to false. Inline maths
 * written with two dollar signs ($$x^2$$) and block maths ($$ on its own lines) still render; only the
 * single-dollar form stops. The app never sets the option itself, so nothing else changes.
 *
 * SAFETY. The anchor is matched by a regex that survives the bundler renaming variables, and must match
 * exactly once in out/renderer/assets/*.js, or nothing is written and the exit code is 1. Re-running on a
 * patched tree finds the new text and changes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// function mathText(o){let f=(o||{}).singleDollarTextMath;return f==null&&(f=!0),{tokenize:
const ANCHOR = /(\blet (\w+)=\((\w+)\|\|\{\}\)\.singleDollarTextMath;return \2==null&&\(\2=)!0(\),\{tokenize:)/g;
const DONE = /\blet (\w+)=\(\w+\|\|\{\}\)\.singleDollarTextMath;return \1==null&&\(\1=!1\),\{tokenize:/;
const EXPECTED = 1;

function patchAssets(files) {
  const out = Object.assign({}, files);
  let total = 0;
  const hits = [];
  for (const [name, text] of Object.entries(out)) {
    const n = (text.match(ANCHOR) || []).length;
    if (n) { total += n; hits.push(name); }
  }
  if (total === 0) {
    if (Object.values(out).some((t) => DONE.test(t))) return { files: out, notes: ['singleDollarTextMath: already done'] };
    throw new Error('anchor not found: singleDollarTextMath');
  }
  if (total !== EXPECTED) throw new Error('singleDollarTextMath: expected ' + EXPECTED + ' match(es), found ' + total + ' in ' + hits.join(', '));
  for (const name of hits) out[name] = out[name].replace(ANCHOR, (m, a, v, o, b) => a + '!1' + b);
  return { files: out, notes: ['singleDollarTextMath default false: ' + total + ' in ' + hits.join(', ')] };
}

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const dir = path.join(root, 'out', 'renderer', 'assets');
  try {
    const files = {};
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const t = fs.readFileSync(path.join(dir, n), 'utf8');
      if (/singleDollarTextMath/.test(t)) files[n] = t;
    }
    const { files: patched, notes } = patchAssets(files);
    for (const [n, t] of Object.entries(patched)) if (t !== files[n]) fs.writeFileSync(path.join(dir, n), t);
    for (const note of notes) console.log('0017: ' + note);
    return 0;
  } catch (e) {
    console.error('0017: ' + e.message);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { patchAssets, ANCHOR, DONE };
