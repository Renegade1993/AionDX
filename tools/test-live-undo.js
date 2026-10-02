'use strict';
// probe-undo13.js - the message box's own Ctrl+Z / Ctrl+Y in the real app, with the edited aionui-dx.js served in place of the built one.
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + detail + ']')); };

(async () => {
  const app = await launch({ port: 9557, deadlineMs: 280000 });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    await app.overrideScript('aionui-dx.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aionui-dx.js'));
    for (let i = 0; i < 90; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, build: window.__aionDx && window.__aionDx.build, port: window.__backendPort || null })'); if (st && st.dx && st.port && st.build === '2026-10-02.1') break; }
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
      check(label + ': a sentence typed at one go is undone by one Ctrl+Z', (await (async () => { await ctrl('z'); return val(); })()) === '', await val());
      await ctrl('y');
      check(label + ': and Ctrl+Y puts it back', (await val()) === 'the quick brown fox jumps', await val());
      await ctrl('z');
      await ctrl('z');
      check(label + ': another Ctrl+Z has nothing further to undo, and changes nothing', (await val()) === '', await val());
      await ctrl('z', true);
      check(label + ': Ctrl+Shift+Z redoes too', (await val()) === 'the quick brown fox jumps', await val());

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
      await ctrl('z');
      check(label + ': and the next typing undoes only itself', (await val()) === '', await val());
    }
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
