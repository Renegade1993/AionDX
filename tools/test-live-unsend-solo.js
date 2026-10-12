'use strict';
// test-live-unsend-solo.js - Unsend and Edit of an Unread message in a SOLO Claude chat, in the real app (the staged build, a throwaway
// profile), with the edited aionui-dx.js served in place of the built one. A real Claude turn is held in a running tool call (the chat
// runs with its permissions auto-approved: a turn waiting on a permission card refuses a message sent into it), a second message waits as
// "Unread", and the Unsend and Edit buttons beside the badge are pressed.
//
// What this test can reach: the page's half. The account router that takes the message back out of Claude reads the real database of the
// installed app, so in a throwaway profile it never sees the request: the page's own 20-second notice "this chat's Claude process did not
// answer" is the expected end here. The router's half is covered by patches\0002-claude-model-currency\test-stream-proxy.js (a stand-in
// Claude and a real SQLite database) and tools\cancel-queued-test.js (the real Claude Code). Spends one short Claude turn.
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 700) + ']')); };

(async () => {
  const app = await launch({ port: 9563, deadlineMs: 290000 });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    await app.overrideScript('aionui-dx.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aionui-dx.js'));
    for (let i = 0; i < 90; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, build: window.__aionDx && window.__aionDx.build, port: window.__backendPort || null })'); if (st && st.dx && st.build && st.port) break; }
    console.log('build', await app.js('window.__aionDx && window.__aionDx.build'));
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    await app.js(`window.__t = {
      base: 'http://127.0.0.1:' + window.__backendPort,
      csrf: () => window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '',
      async call(method, url, body) {
        const r = await fetch(this.base + url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': this.csrf() }, body: body ? JSON.stringify(body) : undefined });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, json: j };
      },
    }; 0`);
    const conv = await app.js(`(async () => {
      const l = ((await window.__t.call('GET', '/api/assistants')).json || {}).data || [];
      const a = l.find((x) => x.name === 'Claude Code') || l[0];
      const r = await window.__t.call('POST', '/api/conversations', { name: 'unsend solo probe', assistant: { id: a.id, locale: 'en-US', conversation_overrides: { permission: 'yolo' } }, extra: { workspace: '', custom_workspace: false } });
      const c = r.json && (r.json.data || r.json); return { status: r.status, id: c && c.id };
    })()`);
    check('a solo Claude chat was created', conv && conv.id, JSON.stringify(conv));
    if (!conv || !conv.id) return;
    await app.js(`location.hash = '#/conversation/${conv.id}'; 0`);
    await sleep(5000);
    let r = await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/messages', { content: 'Use the Bash tool right now to run exactly this command: py -c "import time; time.sleep(80)"   Do nothing else.' })`);
    check('the first message is accepted', r.status < 300, JSON.stringify(r).slice(0, 300));
    let running = false;
    for (let i = 0; i < 40 && !running; i++) {
      await sleep(2000);
      const m = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/conversations/${conv.id}/messages?limit=20'); const d = rs.json && (rs.json.data || rs.json); const l = Array.isArray(d) ? d : (d && (d.items || d.messages)) || []; return JSON.stringify(l.map((x) => x.type + ':' + x.status)); })()`);
      running = /tool_call:work/.test(m);
    }
    check('the first turn is held in a running tool call', running);
    const waiting = async (marker) => {
      const rr = await app.js(`window.__t.call('POST', '/api/conversations/${conv.id}/messages', { content: 'Reply with only the word ${marker}' })`);
      check('the waiting message ' + marker + ' is accepted', rr.status < 300, JSON.stringify(rr).slice(0, 300));
      let row = null;
      for (let i = 0; i < 8 && !(row && row.btn); i++) {
        await sleep(1500);
        row = await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker}') >= 0); return r ? { id: r.id, badge: !!r.querySelector('[data-testid="message-status-badge"]'), btn: !!r.querySelector('.aiondx-unsend'), edit: !!r.querySelector('.aiondx-edit') } : null; })()`);
      }
      return row;
    };
    const requested = async () => {
      for (let i = 0; i < 6; i++) {
        const k = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/settings/client'); const d = rs.json && (rs.json.data || rs.json); return Object.keys(d || {}).filter((x) => x.indexOf('aiondx.unsend.req.') === 0).length; })()`);
        if (k > 0) return k;
        await sleep(700);
      }
      return 0;
    };
    const m1 = 'SOLO-A-' + Date.now().toString(36);
    let row = await waiting(m1);
    console.log('row', JSON.stringify(row));
    check('it shows Unread with Unsend and Edit beside it', !!(row && row.badge && row.btn && row.edit), JSON.stringify(row));
    if (row && row.btn) {
      await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${m1}') >= 0); r.querySelector('.aiondx-unsend').click(); return 1; })()`);
      check('Unsend writes its request for the chat\'s router', (await requested()) > 0);
    }
    // wait for the page's 20-second give-up so the second request starts clean
    await sleep(22000);
    const m2 = 'SOLO-B-' + Date.now().toString(36);
    row = await waiting(m2);
    check('a second waiting message has Edit', !!(row && row.edit), JSON.stringify(row));
    if (row && row.edit) {
      await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${m2}') >= 0); r.querySelector('.aiondx-edit').click(); return 1; })()`);
      check('Edit writes the same request', (await requested()) > 0);
      const box = await app.js(`(() => { const t = document.querySelector('[data-testid="sendbox-input"]'); const ta = t && (/^(TEXTAREA|INPUT)$/.test(t.tagName) ? t : t.querySelector('textarea')); return ta ? ta.value : null; })()`);
      check('and leaves the box alone until the message is really taken back', box === '' || box === null, JSON.stringify(box));
    }
  } finally {
    await app.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
