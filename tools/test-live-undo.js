'use strict';
// probe-undo13.js - the message box's own Ctrl+Z / Ctrl+Y in the real app, with the edited aiondx-ui.js served in place of the built one.
const path = require('path');
const fs = require('fs');
const { launch, sleep } = require('./live-app');
// the page script's own build stamp: the reload is done when the page reports it
const WANT_BUILD = (fs.readFileSync(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8').match(/var BUILD = '([^']+)'/) || [])[1];

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + detail + ']')); };

(async () => {
  const app = await launch({ port: 9557, deadlineMs: 280000 });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    if (!process.env.UNDO_AS_BUILT) await app.overrideScript('aiondx-ui.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'));
    for (let i = 0; i < 90; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, build: window.__aionDx && window.__aionDx.build, port: window.__backendPort || null })'); if (st && st.dx && st.port && (process.env.UNDO_AS_BUILT || st.build === WANT_BUILD)) break; }
    console.log('build', await app.js('window.__aionDx && window.__aionDx.build'));
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    const conv = await app.js(`(async () => {
      const base = 'http://127.0.0.1:' + window.__backendPort;
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const h = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
      const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
      const a = list.find((x) => x.name === 'Claude Code') || list[0];
      const r = await fetch(base + '/api/conversations', { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify({ name: 'undo probe', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } }) });
      const c = await r.json(); return { id: (c.data || c).id };
    })()`);
    for (const [label, hash, tid] of [['chat box', '#/conversation/' + conv.id, 'sendbox-input'], ['new-chat box', '#/guid', 'guid-input']]) {
      await app.js(`location.hash = '${hash}'; 0`);
      await sleep(3200);
      const TA = `(() => { const t = document.querySelector('[data-testid="${tid}"]'); return t && (t.tagName === 'TEXTAREA' ? t : t.querySelector('textarea')); })()`;
      const val = () => app.js(`(${TA}).value`);
      const focus = () => app.js(`(() => { const t = ${TA}; t.focus(); return document.activeElement === t; })()`);
      const ctrl = async (k, shift) => { await app.key(k, { ctrl: true, shift: !!shift }); await sleep(80); };
      const typeKeys = async (text) => { for (const ch of text) await app.key(ch); };
      const clearBox = () => app.js(`(() => { const t = ${TA}; const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return 0; })()`);

      await clearBox();
      await typeKeys('the quick brown fox jumps');
      await ctrl('z');
      check(label + ': typing is undone a word at a time (as in other programs)', (await val()) === 'the quick brown fox ', await val());
      await ctrl('z');
      check(label + ': and the word before it next', (await val()) === 'the quick brown ', await val());
      await ctrl('y');
      check(label + ': Ctrl+Y puts a word back', (await val()) === 'the quick brown fox ', await val());
      await ctrl('y');
      check(label + ': and the next', (await val()) === 'the quick brown fox jumps', await val());
      for (let i = 0; i < 5; i++) await ctrl('z');
      check(label + ': five words, five presses to an empty box', (await val()) === '', await val());
      await ctrl('z');
      check(label + ': another Ctrl+Z has nothing further to undo, and changes nothing', (await val()) === '', await val());
      await ctrl('z', true);
      check(label + ': Ctrl+Shift+Z redoes too', (await val()) === 'the ', await val());

      await clearBox();
      await typeKeys('abc');
      await sleep(1250);
      await typeKeys('def');
      await ctrl('z');
      check(label + ': a pause of over a second makes a new step', (await val()) === 'abc', await val());
      await ctrl('z');
      check(label + ': and the first step goes next', (await val()) === '', await val());
      await ctrl('y'); await ctrl('y');
      check(label + ': redo twice brings both back', (await val()) === 'abcdef', await val());

      await ctrl('z');                         // back to "abc"
      await typeKeys('X');
      await ctrl('y');
      check(label + ': typing after an undo ends the redo line', (await val()) === 'abcX', await val());

      await clearBox();
      await typeKeys('hello world');
      await sleep(1250);
      for (let i = 0; i < 5; i++) await app.key('Backspace');
      check(label + ': five Backspaces', (await val()) === 'hello ', await val());
      await ctrl('z');
      check(label + ': are one step to undo', (await val()) === 'hello world', await val());

      // the page emptying the box itself (a send) is not something to undo into
      await app.js(`(() => { const t = ${TA}; const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return 0; })()`);
      await sleep(200);
      await ctrl('z');
      check(label + ': after the page empties the box, Ctrl+Z does not put the old text back', (await val()) === '', await val());
      await typeKeys('new text');
      await ctrl('z'); await ctrl('z'); await ctrl('z');
      check(label + ': and the next typing undoes only itself', (await val()) === '', await val());

      // A paste. AionUi's box takes a text paste over and writes the text in itself with no input event (its PasteService); sent here
      // the way the browser sends one, so AionUi's own handler does the writing. Until November 24th, 2026 this started the history
      // again, and Ctrl+Z after a paste did nothing.
      const paste = (text) => app.js(`(() => { const t = ${TA}; t.focus(); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 0; })()`);
      await clearBox();
      await typeKeys('before ');
      await sleep(300);
      await paste('PASTED');
      await sleep(300);
      check(label + ': a paste goes in where the caret is', (await val()) === 'before PASTED', await val());
      await ctrl('z');
      check(label + ': Ctrl+Z takes the paste back out', (await val()) === 'before ', await val());
      await ctrl('z');
      check(label + ': and the typing before it next', (await val()) === '', await val());
      await ctrl('y'); await ctrl('y');
      check(label + ': Ctrl+Y twice puts both back', (await val()) === 'before PASTED', await val());
      await app.js(`(() => { const t = ${TA}; t.setSelectionRange(t.value.length, t.value.length); return 0; })()`);
      await typeKeys('after');
      await ctrl('z');
      check(label + ': typing after a paste is its own step', (await val()) === 'before PASTED', await val());
      // the page writing text in (voice, an @@ name picked, a message taken back): its own step too
      await app.js(`(() => { const t = ${TA}; const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(t, t.value + ' spoken words'); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return 0; })()`);
      await sleep(200);
      await ctrl('z');
      check(label + ': text the page put in (voice, an @@ name) is undone by one Ctrl+Z', (await val()) === 'before PASTED', await val());

      // a caret moved (arrow keys, a click) ends the step: the edit there is undone on its own
      await clearBox();
      await typeKeys('one two');
      for (let i = 0; i < 3; i++) await app.key('ArrowLeft');
      await typeKeys('X');
      check(label + ': typing after the caret was moved', (await val()) === 'one Xtwo', await val());
      await ctrl('z');
      check(label + ': is undone on its own', (await val()) === 'one two', await val());

      // undo of a deletion brings the text back selected, as it was
      await clearBox();
      await typeKeys('keep this');
      await sleep(1200);
      await app.js(`(() => { const t = ${TA}; t.setSelectionRange(5, 9); return 0; })()`);
      await app.key('Delete');
      check(label + ': a selected word deleted', (await val()) === 'keep ', await val());
      await ctrl('z');
      const sel = await app.js(`(() => { const t = ${TA}; return [t.value, t.selectionStart, t.selectionEnd]; })()`);
      check(label + ': Ctrl+Z brings it back, selected again', sel[0] === 'keep this' && sel[1] === 5 && sel[2] === 9, JSON.stringify(sel));

      // the right-click menu's Undo and Redo (patch 0009) ask the page through these
      await clearBox();
      await typeKeys('menu words');
      const ms = await app.js('window.__aionDx.undoMenu()');
      check(label + ': the right-click menu learns the box has a step to undo and none to redo', ms && ms.own === true && ms.canUndo === true && ms.canRedo === false, JSON.stringify(ms));
      await app.js('window.__aionDx.undoStep(-1)');
      check(label + ': its Undo takes a word back out', (await val()) === 'menu ', await val());
      await app.js('window.__aionDx.undoStep(1)');
      check(label + ': its Redo puts it back', (await val()) === 'menu words', await val());
    }
    // another chat in the same box: its text is a new start, never a step on top of the first chat's
    const conv2 = await app.js(`(async () => {
      const base = 'http://127.0.0.1:' + window.__backendPort;
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
      const a = list.find((x) => x.name === 'Claude Code') || list[0];
      const r = await fetch(base + '/api/conversations', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'undo probe two', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } }) });
      const c = await r.json(); return (c.data || c).id;
    })()`);
    const BOX = `(() => { const t = document.querySelector('[data-testid="sendbox-input"]'); return t && (t.tagName === 'TEXTAREA' ? t : t.querySelector('textarea')); })()`;
    await app.js(`location.hash = '#/conversation/${conv.id}'; 0`);
    await sleep(3000);
    await app.js(`(${BOX}).focus(); 0`);
    await app.js(`(() => { const t = ${BOX}; const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return 0; })()`);
    await sleep(300);
    for (const ch of 'first chat') await app.key(ch);
    await app.js(`location.hash = '#/conversation/${conv2}'; 0`);
    await sleep(3000);
    await app.js(`(() => { const t = ${BOX}; const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(t, 'second chat draft'); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return 0; })()`);
    await sleep(200);
    await app.key('z', { ctrl: true });
    await sleep(120);
    const v2 = await app.js(`(${BOX}).value`);
    check('in another chat, Ctrl+Z does not bring the first chat\'s text in', v2 !== 'first chat' && v2.indexOf('first chat') < 0, v2);
    await app.js(`location.hash = '#/conversation/${conv.id}'; 0`);
    await sleep(3000);
    const back = await app.js(`(${BOX}).value`);
    await app.js(`(${BOX}).focus(); 0`);
    await app.key('z', { ctrl: true });
    await sleep(120);
    const v1 = await app.js(`(${BOX}).value`);
    check('back in the first chat, its own history is still there (Ctrl+Z takes its last word out)', back === 'first chat' && v1 === 'first ', JSON.stringify([back, v1]));

    // a different text field is left to the browser
    await app.js(`(() => { document.querySelectorAll('#probe-ta').forEach((e) => e.remove()); const t = document.createElement('textarea'); t.id = 'probe-ta'; t.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:60px;z-index:99999'; document.documentElement.appendChild(t); t.focus(); return 0; })()`);
    await app.type('plain field');
    await app.key('z', { ctrl: true });
    await sleep(80);
    check('another text box is left to the browser: its own Ctrl+Z works as before', (await app.js(`document.getElementById('probe-ta').value`)) === '', await app.js(`document.getElementById('probe-ta').value`));
  } finally {
    await app.close();
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
