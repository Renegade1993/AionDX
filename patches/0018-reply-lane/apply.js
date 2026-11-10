#!/usr/bin/env node
/**
 * AionDX patch 0018-reply-lane: Reply puts its quote in one message box, not in every lane's.
 *
 *   node patches\0018-reply-lane\apply.js <extracted-asar-root>
 *
 * Written 2026-11-09 (a request: "When a user hits "reply" with multiple lanes open, it puts the reply in each chatbox across all lanes. it
 * should only go in the last-active chat box").
 *
 * HOW. The Reply button on a text selection emits one page-wide event, sendbox.reply, and every message box on the page listens for it
 * (useEventBus("sendbox.reply", a => setQuote(a))), so on a team page each lane's box takes the quote. The listener is changed to ask
 * window.__aionDxReplyFor(<its own container>, <the reply>) first, when AionDX's page script has defined it, and to take the quote only on
 * yes. With no page script (AionDX switched off), every box takes it as before.
 *
 * SAFETY. Two regexes that survive the bundler renaming variables: the listener, and the box's container ref (the ref the same component
 * reads its textarea through). Exactly one match each, in one file, or nothing is written and the exit code is 1. Re-running on a patched
 * tree finds the new text and changes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Qe("sendbox.reply",a=>lt(a),[])
const LISTEN = /(\w+)\("sendbox\.reply",(\w+)=>(\w+)\(\2\),\[\]\)/g;
// if(Se.current&&it.current===0){const d=Se.current.querySelector("textarea")
const REF = /if\((\w+)\.current&&\w+\.current===0\)\{const \w+=\1\.current\.querySelector\("textarea"\)/;
const DONE = /\("sendbox\.reply",\w+=>\{const \w+=window\.__aionDxReplyFor;/;

function patchFile(text) {
  const listens = text.match(LISTEN) || [];
  if (!listens.length) return DONE.test(text) ? { text, note: 'already done' } : null;
  if (listens.length !== 1) throw new Error('sendbox.reply listener: expected 1 match, found ' + listens.length);
  const ref = REF.exec(text);
  if (!ref) throw new Error('the message box container ref was not found next to the listener');
  const refName = ref[1];
  const out = text.replace(LISTEN, (m, hook, arg, set) =>
    hook + '("sendbox.reply",' + arg + '=>{const f=window.__aionDxReplyFor;if(typeof f==="function"&&' + refName + '.current&&!f(' + refName + '.current,' + arg + '))return;' + set + '(' + arg + ')},[])');
  return { text: out, note: 'sendbox.reply asks window.__aionDxReplyFor (ref ' + refName + ')' };
}

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const dir = path.join(root, 'out', 'renderer', 'assets');
  try {
    const hits = [];
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const p = path.join(dir, n);
      const t = fs.readFileSync(p, 'utf8');
      if (t.indexOf('"sendbox.reply"') < 0 || t.indexOf('emit("sendbox.reply"') >= 0 && !LISTEN.test(t) && !DONE.test(t)) { LISTEN.lastIndex = 0; continue; }
      LISTEN.lastIndex = 0;
      const r = patchFile(t);
      if (r) hits.push({ n, p, t, r });
    }
    if (hits.length !== 1) throw new Error('expected the listener in 1 file, found ' + hits.length + (hits.length ? ' (' + hits.map((h) => h.n).join(', ') + ')' : ''));
    const h = hits[0];
    if (h.r.text !== h.t) fs.writeFileSync(h.p, h.r.text);
    console.log('0018: ' + h.r.note + ' in ' + h.n);
    return 0;
  } catch (e) {
    console.error('0018: ' + e.message);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { patchFile, LISTEN, REF, DONE };
