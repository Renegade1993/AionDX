'use strict';
// probe-undo-k.js - Ctrl+Z in the message box of the staged app the way a person uses it: typed keys, a pause mid-sentence,
// text put in by insertText (IME, dictation, autocorrect), Backspace, a chat switched away and back, a send. Prints what the
// box holds after each Ctrl+Z, and whether anything ahead of AionDX's handler swallowed the key. Writes .tmp\probe-undo-k.out.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./live-app');

const out = [];
const log = (s) => { out.push(s); console.log(s); };

(async () => {
  const app = await launch({ port: 9561, deadlineMs: 280000, stage: process.env.PROBE_STAGE || undefined });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    log('build ' + await app.js('window.__aionDx && window.__aionDx.build'));
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    // what reaches the box after AionDX: every Ctrl+Z keydown, whether it was prevented, and its target
    await app.js(`(() => { window.__zlog = []; document.addEventListener('keydown', (e) => { if ((e.ctrlKey) && /^[zy]$/i.test(e.key)) window.__zlog.push({ k: e.key, prevented: e.defaultPrevented, tag: e.target.tagName, tid: (e.target.closest && e.target.closest('[data-testid]') || {}).dataset ? e.target.closest('[data-testid]').dataset.testid : '' }); }, false); return 0; })()`);
    const mk = (name) => app.js(`(async () => {
      const base = 'http://127.0.0.1:' + window.__backendPort;
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const h = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
      const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
      const a = list.find((x) => x.name === 'Claude Code') || list[0];
      const r = await fetch(base + '/api/conversations', { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify({ name: '${name}', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } }) });
      const c = await r.json(); return (c.data || c).id;
    })()`);
    const c1 = await mk('undo probe one'), c2 = await mk('undo probe two');
    await app.js(`location.hash = '#/conversation/${c1}'; 0`);
    await sleep(3500);
    const TA = `(() => { const t = document.querySelector('[data-testid="sendbox-input"]'); return t && (t.tagName === 'TEXTAREA' ? t : t.querySelector('textarea')); })()`;
    log('box: ' + JSON.stringify(await app.js(`(() => { const t = ${TA}; return t ? { tag: t.tagName, ro: t.readOnly, dis: t.disabled } : document.activeElement && document.activeElement.outerHTML.slice(0, 200); })()`)));
    const val = () => app.js(`(${TA}).value`);
    const focus = () => app.js(`(() => { const t = ${TA}; t.focus(); return document.activeElement === t; })()`);
    const z = async () => { await app.key('z', { ctrl: true }); await sleep(120); return val(); };
    const typeKeys = async (text, gap) => { for (const ch of text) { await app.key(ch === ' ' ? ' ' : ch); if (gap) await sleep(gap); } };
    const clearBox = async () => { await focus(); await app.key('a', { ctrl: true }); await app.key('Backspace'); await sleep(1200); };

    await focus();
    await typeKeys('hello there', 60);
    log('S1 typed with 60 ms between keys: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"');
    await clearBox();
    await typeKeys('first part', 40); await sleep(1500); await typeKeys(' second part', 40);
    log('S2 pause between parts: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"; again -> "' + await z() + '"');
    await clearBox();
    await app.type('dictated words here');
    log('S3 insertText: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"');
    await clearBox();
    await typeKeys('abcdef', 40); await app.key('Backspace'); await app.key('Backspace');
    log('S4 Backspace: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"; again -> "' + await z() + '"');
    await clearBox();
    await typeKeys('draft text', 40); await sleep(1500);
    await app.js(`location.hash = '#/conversation/${c2}'; 0`); await sleep(2500);
    await app.js(`location.hash = '#/conversation/${c1}'; 0`); await sleep(2500);
    await focus();
    log('S5 back from another chat: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"');
    await typeKeys(' more', 40);
    log('S5b typed after: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"');
    await clearBox();
    await typeKeys('slow', 400);
    log('S6 typed at 400 ms a key: "' + await val() + '"; Ctrl+Z -> "' + await z() + '"');
    // the new-chat page's box
    await app.js(`location.hash = '#/guid'; 0`); await sleep(3000);
    const G = `(() => { const t = document.querySelector('[data-testid="guid-input"]'); return t && (t.tagName === 'TEXTAREA' ? t : t.querySelector('textarea')); })()`;
    await app.js(`(${G}).focus(); 0`);
    await typeKeys('new chat words', 60);
    await app.key('z', { ctrl: true }); await sleep(150);
    log('S7 new-chat box: Ctrl+Z -> "' + await app.js(`(${G}).value`) + '"');
    log('keydown log: ' + JSON.stringify(await app.js('window.__zlog')));
  } catch (e) { log('ERROR ' + (e && e.stack || e)); }
  finally {
    fs.writeFileSync(path.join(__dirname, '..', '.tmp', 'probe-undo-k.out'), out.join('\n') + '\n');
    await app.close();
  }
})();
