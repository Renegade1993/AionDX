#!/usr/bin/env node
/**
 * AionDX patch 0019-question-notice: every question an agent asks raises its desktop notice, and AionDX hears of each one.
 *
 *   node patches\0019-question-notice\apply.js <extracted-asar-root>
 *
 * Written 2026-11-09 (a request: "i'm not seeing question notifications pop in time").
 *
 * HOW. AionUi's notifier (the hook behind "Notify me when an agent needs me") reads the live event stream and notifies on a permission or an
 * ask, keyed by chat and message: `${conversation_id}:${msg_id}`. An agent's second question inside the same message has the same key, so it
 * never notified. The key now carries the question's own id (call or request id) as well. And the notifier tells AionDX's page script of
 * each question it saw (window.__aionDxOnAsk), so AionDX's own backstop (questions the stream never delivered, polled through
 * /api/conversations/{id}/confirmations) does not notify a second time for one already notified.
 *
 * SAFETY. One regex that survives the bundler renaming variables; exactly one match in one file, or nothing is written and the exit code
 * is 1. Re-running on a patched tree finds the new text and changes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// if(KAa.has(a.type)){const s=a.msg_id?`${a.conversation_id??""}:${a.msg_id}`:null;
const ANCHOR = /if\((\w+)\.has\((\w+)\.type\)\)\{const (\w+)=\2\.msg_id\?`\$\{\2\.conversation_id\?\?""\}:\$\{\2\.msg_id\}`:null;/g;
const DONE = /window\.__aionDxOnAsk/;

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const dir = path.join(root, 'out', 'renderer', 'assets');
  try {
    const hits = [];
    let done = false;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const p = path.join(dir, n);
      const t = fs.readFileSync(p, 'utf8');
      if (DONE.test(t)) done = true;
      const c = (t.match(ANCHOR) || []).length;
      if (c) hits.push({ n, p, t, c });
    }
    if (!hits.length) { if (done) { console.log('0019: already done'); return 0; } throw new Error('anchor not found: the question notifier'); }
    if (hits.length !== 1 || hits[0].c !== 1) throw new Error('expected 1 match, found ' + hits.map((h) => h.n + ' x' + h.c).join(', '));
    const h = hits[0];
    const out = h.t.replace(ANCHOR, (m, set, a, key) =>
      'if(' + set + '.has(' + a + '.type)){try{window.__aionDxOnAsk&&window.__aionDxOnAsk(' + a + ')}catch(e){}' +
      'const ' + key + '=' + a + '.msg_id?`${' + a + '.conversation_id??""}:${' + a + '.msg_id}:${(d=>d?(d.call_id||d.callId||d.request_id||d.requestId||(d.toolCall&&d.toolCall.toolCallId)||d.tool_call_id||d.id||""):"")(' + a + '.data)}`:null;');
    fs.writeFileSync(h.p, out);
    console.log('0019: question notices keyed per question, AionDX told of each, in ' + h.n);
    return 0;
  } catch (e) {
    console.error('0019: ' + e.message);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { ANCHOR, DONE };
