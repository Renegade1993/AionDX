#!/usr/bin/env node
/**
 * AionDX patch 0013-chat-anchors: the side rail of a long chat stops costing the page its speed.
 *
 *   node patches\0013-chat-anchors\apply.js <extracted-asar-root> [--check]
 *
 * A request of 2026-10-24: the interface lagged badly in a team lead's chat of 37,000 messages, and the fix had to be in the
 * interface itself. Measured on a copy of that chat (a throwaway profile, a hidden desktop), the rail beside the chat was the cost:
 *   - it downloaded the chat's whole history on every open (177 requests of 200 messages, 48 MB) to read the user turns out of it;
 *   - it drew one element for every turn (2,800 here) although it shows 20 at a time, and redrew all of them for every message
 *     the chat received and for every pointer move over it.
 *
 * What it changes (out/renderer/assets, the chunk that holds the message list):
 *   history   the rail's loader asks window.__aionDxAnchors (patch 0001's script) first: one request to AionCore's
 *             /api/conversations/{id}/anchors (patch core-0009), and the old paged download only when that fails
 *   ticks     only the ticks in view, and a few above and below, are drawn; the first one carries the offset that keeps the
 *             rest where they were (the stack keeps its full height, and the hover maths never read the elements)
 *
 * SAFETY. Same rule as 0003, 0006, 0009 and 0012: every edit must match its expected count, or show its marker on a tree this
 * patch already changed, or nothing is written and the exit code is 1. --check reports and writes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ext = process.argv[2];
const CHECK = process.argv.includes('--check');
if (!ext || !fs.existsSync(path.join(ext, 'out', 'renderer', 'assets'))) {
  console.error('usage: node apply.js <extracted asar dir> [--check]');
  process.exit(2);
}

const W = '[\\w$]+';
const mark = (id) => '/*AIONDX-0013:' + id + '*/';
const STRIDE = 12;     // a tick is 2 px high and the gap is 10 (geometry.ts: TICK_HEIGHT + TICK_GAP)
const BUFFER = 8;      // ticks drawn beyond each edge of the view

const dir = path.join(ext, 'out', 'renderer', 'assets');
const files = fs.readdirSync(dir).filter((n) => /\.js$/.test(n)).map((n) => path.join(dir, n));
const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

function find(re) {
  const hits = [];
  for (const [f, t] of texts) { const m = t.match(new RegExp(re.source, 'g')); if (m) hits.push({ f, n: m.length }); }
  return hits;
}
const done = (id) => [...texts.values()].some((t) => t.includes('AIONDX-0013:' + id + '*/'));

// The names the minifier gave the rail's scroll state, read from the line that decides whether the "more above/below" hints show.
const HINTS = new RegExp('(' + W + ')=(' + W + ')&&(' + W + ')>1,(' + W + ')=\\2&&\\3\\+(' + W + ')<(' + W + ')-1', 'g');

const EDITS = [
  ['H1 history from one request',
    new RegExp('(' + W + ')\\((' + W + '),\\{contentMode:"compact"\\}\\)\\.then\\((' + W + ')=>\\{(' + W + ')\\|\\|(' + W + ')\\.current!==\\2\\|\\|(' + W + ')\\((' + W + ')\\(\\3\\)\\)\\}\\)', 'g'),
    (m, load, id, res, gone, ref, set, build) =>
      '(window.__aionDxAnchors?window.__aionDxAnchors(' + id + ',' + load + '):' + load + '(' + id + ',{contentMode:"compact"})).then(' + res + '=>{' + gone + '||' + ref + '.current!==' + id + '||' + set + '(' + build + '(' + res + '))})' + mark('H1')],
  ['T1 only the ticks in view',
    new RegExp('(' + W + ')\\.map\\(\\((' + W + '),(' + W + ')\\)=>(' + W + ')\\.createElement\\("span",\\{key:\\2\\.messageId,(role:"button".*?onKeyDown:' + W + '=>\\{\\(' + W + '\\.key==="Enter"\\|\\|' + W + '\\.key===" "\\)&&\\(' + W + '\\.preventDefault\\(\\),' + W + '\\(\\2\\)\\)\\})\\}\\)\\)', 'g'),
    null, 1],
];

let bad = 0;
const plan = [];
// H1
{
  const [id, re, repl] = EDITS[0];
  const hits = find(re);
  const total = hits.reduce((a, h) => a + h.n, 0);
  if (total === 0 && done('H1')) console.log('0013 ' + id + ': already applied');
  else if (total !== 1) { console.error('0013 ' + id + ': expected 1 match, found ' + total + '; nothing written'); bad++; }
  else { console.log('0013 ' + id + ': 1 match in ' + path.basename(hits[0].f)); plan.push({ f: hits[0].f, re, repl }); }
}
// T1: needs the scroll state names from the hint line in the same chunk
{
  const [id, re] = EDITS[1];
  const hits = find(re);
  const total = hits.reduce((a, h) => a + h.n, 0);
  if (total === 0 && done('T1')) console.log('0013 ' + id + ': already applied');
  else if (total !== 1) { console.error('0013 ' + id + ': expected 1 match, found ' + total + '; nothing written'); bad++; }
  else {
    const f = hits[0].f;
    const hint = texts.get(f).match(HINTS);
    if (!hint || hint.length !== 1) { console.error('0013 ' + id + ': could not read the rail scroll state (' + (hint ? hint.length : 0) + ' matches); nothing written'); bad++; }
    else {
      const m = new RegExp(HINTS.source).exec(hint[0]);
      const scrollTop = m[3], viewportHeight = m[5];
      console.log('0013 ' + id + ': 1 match in ' + path.basename(f) + ' (scrollTop ' + scrollTop + ', view height ' + viewportHeight + ')');
      plan.push({ f, re, repl: (all, list, item, idx, ns, rest) => {
        const a = 'Math.max(0,Math.floor(' + scrollTop + '/' + STRIDE + ')-' + BUFFER + ')';
        const b = 'Math.min(' + list + '.length,Math.ceil((' + scrollTop + '+' + viewportHeight + ')/' + STRIDE + ')+' + BUFFER + ')';
        return '(()=>{const __a=' + a + ',__b=' + b + ';return ' + list + '.slice(__a,__b).map((' + item + ',__i)=>{const ' + idx + '=__i+__a;return ' + ns + '.createElement("span",{key:' + item + '.messageId,style:__i===0&&__a>0?{marginTop:__a*' + STRIDE + '}:void 0,' + rest + '})})})()' + mark('T1');
      } });
    }
  }
}
// W1: the message list keeps a bounded number of messages while the user is following the bottom.
//
// A chat left open keeps receiving messages and AionUi never lets go of one: every message stays in the list and in the page. Measured on
// a copy of a long chat (a throwaway profile, a hidden desktop), typing one character costs 48 ms with 49 rows loaded, 105 ms with 420,
// 292 ms with 1,224 and 619 ms with 2,559: the message box resizes itself on every key, which makes the browser lay the page out about six
// times per key, and each layout walks every row that is mounted. A restart goes back to 49 rows, which is why quitting the app "fixed" it.
//
// So when the list is at its bottom (the scroll-to-bottom button is not showing), nothing older is being read, and the list holds 200
// messages or more, it drops to the newest 100. The pagination state is told where the list now begins (a cursor built from the new first
// message, the shape AionCore's own cursors have), so scrolling up loads the older messages again through AionUi's own paging. While the
// user has scrolled away, or an anchor window or an earlier page is loading, nothing is dropped. (The page's hasMoreAfter flag cannot
// gate this: it turns true when any older page loads, because the loader ORs it in, and never turns false again.)
const KEEP_AT = 200, KEEP_TO = 100;
{
  const id = 'W1 a bounded message list';
  const COMP = new RegExp('=\\(\\{emptySlot:(' + W + ')\\}\\)=>\\{const (' + W + ')=(' + W + ')\\(\\),(' + W + ')=(' + W + ')\\(\\),(' + W + ')=(' + W + ')\\(\\),', 'g');
  const UPD = new RegExp('\\{const (' + W + ')=(' + W + ')\\(\\),(' + W + ')=(' + W + ')\\(\\),(' + W + ')=' + W + '\\(\\),(' + W + ')=(' + W + ')\\(\\),(' + W + ')=(' + W + ')\\.useRef\\(\\3\\);', 'g');
  const RET = new RegExp('return (' + W + ')\\.length===0&&(' + W + ')\\?(' + W + ')\\.createElement\\((' + W + '),\\{rowWidthClass:(' + W + ')\\}\\):', 'g');
  const BTN = new RegExp('\\{handleScrollerRef:(' + W + '),handleContentRef:' + W + ',handleScroll:' + W + ',handleWheel:' + W + ',handlePointerDown:' + W + ',showScrollButton:(' + W + '),scrollToBottom:' + W + ',scrollElementIntoView:' + W + ',hideScrollButton:' + W + '\\}=', 'g');
  const esc = (n) => n.replace(/\$/g, '\\$');
  const REACT = new RegExp('\\[(' + W + '),(' + W + ')\\]=(' + W + ')\\.useState\\(\\),(' + W + ')=\\3\\.useRef\\(""\\)', 'g');
  const hits = find(RET);
  const total = hits.reduce((a, h) => a + h.n, 0);
  if (done('W1')) console.log('0013 ' + id + ': already applied');
  else if (total !== 1) { console.error('0013 ' + id + ': expected 1 match for the component\'s return, found ' + total + '; nothing written'); bad++; }
  else {
    const f = hits[0].f, t = texts.get(f);
    const one = (re, what) => { const m = t.match(new RegExp(re.source, 'g')); if (!m || m.length !== 1) { console.error('0013 ' + id + ': expected 1 match for ' + what + ', found ' + (m ? m.length : 0) + '; nothing written'); bad++; return null; } return new RegExp(re.source).exec(m[0]); };
    const comp = one(COMP, 'the component\'s first hooks'), upd = one(UPD, 'the list updater hooks'), btn = one(BTN, 'the scroll button state'), react = one(REACT, 'the React hooks object');
    if (comp && upd && btn && react) {
      const listVar = comp[2], listHook = comp[3], pagVar = comp[6], pagHook = comp[7];
      const setList = upd[2], setPag = upd[7], updListHook = upd[4];
      if (updListHook !== listHook) { console.error('0013 ' + id + ': the list hook differs between the component (' + listHook + ') and the updater (' + updListHook + '); nothing written'); bad++; }
      else {
        const showBtn = btn[2], R = react[3];
        // The scroller element: setScrollerRef stores it in a ref and passes it to the hook's handleScrollerRef.
        const ref = one(new RegExp('useCallback\\((' + W + ')=>\\{(' + W + ')\\.current=\\1,' + esc(btn[1]) + '\\(\\1\\)\\}'), 'the scroller ref');
        if (!ref) { /* reported */ }
        else {
        const scroller = ref[2];
        console.log('0013 ' + id + ': 1 match in ' + path.basename(f) + ' (list ' + listVar + ', pagination ' + pagVar + ', button ' + showBtn + ', scroller ' + scroller + ', updaters ' + setList + '/' + setPag + ')');
        // At the bottom means the scroller itself is within 80 px of its end. The scroll button alone is not enough: it is false while a
        // user scrolls up with the wheel until the hook catches up, and the list was trimmed under a reader once on a seeded chat.
        const code = '{const __dxL=' + setList + '(),__dxP=' + setPag + '();' + R + '.useEffect(()=>{' +
          'if(' + showBtn + '||' + listVar + '.length<' + KEEP_AT + '||' + pagVar + '.isLoadingBefore||' + pagVar + '.isLoadingAnchor)return;' +
          'const __s=' + scroller + '.current;if(!__s||__s.scrollHeight-__s.clientHeight-__s.scrollTop>80)return;' +
          'const __f=' + listVar + '[' + listVar + '.length-' + KEEP_TO + '];if(!__f||__f.created_at==null||!__f.id)return;' +
          'const __c="v1."+btoa(JSON.stringify({created_at:__f.created_at,id:__f.id})).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");' +
          '__dxL(__l=>__l.length>=' + KEEP_AT + '?__l.slice(-' + KEEP_TO + '):__l);__dxP(__p=>({...__p,oldestCursor:__c,hasMoreBefore:!0}))},' +
          '[' + listVar + '.length,' + showBtn + ',' + pagVar + '.isLoadingBefore,' + pagVar + '.isLoadingAnchor])}' + mark('W1');
        plan.push({ f, re: RET, repl: (all) => code + all });
        }
      }
    }
  }
}
if (bad) process.exit(1);
if (CHECK) { console.log('0013: check only, nothing written'); process.exit(0); }
for (const { f, re, repl } of plan) texts.set(f, texts.get(f).replace(new RegExp(re.source, 'g'), repl));
const changed = new Set(plan.map((p) => p.f));
for (const f of changed) fs.writeFileSync(f, texts.get(f));
console.log('0013: wrote ' + changed.size + ' file(s)');
