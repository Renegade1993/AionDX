'use strict';
// test-live-oct9.js - the October 9th list in the real app (the staged build, a throwaway profile), with the edited
// aionui-dx.js served in place of the built one: the picture viewer, the usage settings panel and usage alerts, the
// Respond-now bolt's fallback match, and AionCore's new routes (open-path, steer with unsend).
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };

(async () => {
  const app = await launch({ port: 9561, deadlineMs: 280000 });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    await app.overrideScript('aionui-dx.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aionui-dx.js'));
    for (let i = 0; i < 90; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, build: window.__aionDx && window.__aionDx.build, port: window.__backendPort || null })'); if (st && st.dx && st.port && st.build === '2026-10-09.1') break; }
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

    // ---- AionCore: the new routes
    let r = await app.js(`window.__t.call('POST', '/api/shell/open-path', { path: 'C:/definitely/not/here/' + Date.now(), action: 'auto' })`);
    check('open-path exists and says a missing path is not found (400, not 404)', r.status === 400 && /not found/i.test(JSON.stringify(r.json)), JSON.stringify(r));
    r = await app.js(`window.__t.call('POST', '/api/shell/open-path', {})`);
    check('open-path refuses a body with no path', r.status === 400 || r.status === 422, JSON.stringify(r));
    r = await app.js(`window.__t.call('POST', '/api/teams/nope/agents/nope/steer', { message_id: 'x', unsend: true })`);
    check('steer takes the unsend field (an unknown team is 404, not a parse error)', r.status === 404 || r.status === 403 || r.status === 400, JSON.stringify(r));
    check('...and not a 422 for the new field', r.status !== 422, JSON.stringify(r));

    // ---- the picture viewer
    const v = await app.js(`(async () => {
      const mk = (c) => { const cv = document.createElement('canvas'); cv.width = 120; cv.height = 80; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 120, 80); return cv.toDataURL('image/png'); };
      const box = document.createElement('div'); box.id = 'vtest'; document.body.appendChild(box);
      const row1 = document.createElement('div'); row1.id = 'message-v1'; row1.innerHTML = '<img id="vi1" alt="first" src="' + mk('#c33') + '">';
      const row2 = document.createElement('div'); row2.id = 'message-v2';
      const host = document.createElement('div'); host.className = 'markdown-shadow'; row2.appendChild(host);
      const sr = host.attachShadow({ mode: 'open' }); sr.innerHTML = '<img id="vi2" alt="second" src="' + mk('#3c3') + '">';
      const row3 = document.createElement('div'); row3.id = 'message-v3'; row3.innerHTML = '<img id="vi3" alt="third" src="' + mk('#33c') + '"><img alt="icon" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
      box.append(row1, row2, row3);
      await new Promise((r) => setTimeout(r, 400));
      return window.__aionDx.viewerPictures().map((p) => p.alt);
    })()`);
    check('the viewer lists chat pictures in order, including one inside a shadow root, and skips tiny icons', JSON.stringify(v) === JSON.stringify(['first', 'second', 'third']), JSON.stringify(v));
    await app.js(`document.getElementById('vi1').click(); 0`);
    await sleep(300);
    let st = await app.js('window.__aionDx.viewer()');
    check('clicking a picture opens the viewer on it, with Previous off', st && st.i === 0 && st.n === 3 && st.prevOff === true && st.nextOff === false && /1 \/ 3/.test(st.count), JSON.stringify(st));
    await app.js(`document.querySelector('.aiondx-viewer-next').click(); 0`);
    await sleep(200);
    st = await app.js('window.__aionDx.viewer()');
    check('the Next button goes to the second picture (the one in the shadow root)', st && st.i === 1 && /2 \/ 3/.test(st.count) && /second/.test(st.count), JSON.stringify(st));
    await app.key('ArrowRight');
    await sleep(200);
    st = await app.js('window.__aionDx.viewer()');
    check('the right arrow key goes to the third, and Next is then off', st && st.i === 2 && st.nextOff === true, JSON.stringify(st));
    await app.key('ArrowLeft');
    await sleep(200);
    await app.js(`document.querySelector('.aiondx-viewer-prev').click(); 0`);
    await sleep(200);
    st = await app.js('window.__aionDx.viewer()');
    check('Previous works from the keyboard and the button', st && st.i === 0 && st.prevOff === true, JSON.stringify(st));
    await app.js(`document.querySelector('.aiondx-viewer-stage img').click(); 0`);
    await sleep(150);
    st = await app.js('window.__aionDx.viewer()');
    check('clicking the picture zooms it', st && st.scale === 2, JSON.stringify(st));
    await app.key('Escape');
    await sleep(200);
    st = await app.js('window.__aionDx.viewer()');
    check('Esc closes the viewer', st === null, JSON.stringify(st));
    await app.js(`document.getElementById('vtest').remove(); 0`);

    // ---- usage settings, and usage alerts on a chat
    const conv = await app.js(`(async () => {
      const list = (await window.__t.call('GET', '/api/assistants')).json.data || [];
      const a = list.find((x) => x.name === 'Claude Code') || list[0];
      const c = await window.__t.call('POST', '/api/conversations', { name: 'usage alert probe', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '' } });
      return { id: (c.json.data || c.json).id, status: c.status };
    })()`);
    check('a chat for the alert test exists', !!conv.id, JSON.stringify(conv));
    const nowS = Math.floor(Date.now() / 1000);
    const put = (obj) => app.js(`window.__t.call('PUT', '/api/settings/client', ${JSON.stringify(obj)})`);
    await put({
      ['aiondx.usage.conv.' + conv.id]: { acct: 'probeacct', at: Date.now() },
      ['aiondx.usage.acct.probeacct']: { label: 'probe account', at: Date.now(), status: 'allowed', five_hour: { u: 0.5, reset: nowS + 7200, status: 'allowed' }, seven_day: { u: 0.2, reset: nowS + 5 * 86400, status: 'allowed' } },
      ['aiondx.usagealert.conv.' + conv.id]: { rules: [{ window: '5h', at: 0.8, notify: 'self', by: 'agent', who: 'Probe', conv: conv.id, message: 'Wrap up.' }], at: Date.now(), rev: 1 },
    });
    await app.js('window.__aionDx.pullNow()');
    await sleep(500);
    let us = await app.js('window.__aionDx.usageSettings()');
    check('the renderer reads the alert rule from the store', us.alerts['conv.' + conv.id] && us.alerts['conv.' + conv.id].rules.length === 1, JSON.stringify(us.alerts));
    const msgs = async () => {
      const m = await app.js(`window.__t.call('GET', '/api/conversations/${conv.id}/messages?limit=50')`);
      const arr = (m.json && (m.json.data && (m.json.data.items || m.json.data.messages || m.json.data))) || [];
      return JSON.stringify(arr);
    };
    check('under the threshold nothing is sent', !/AionDX usage alert/.test(await msgs()));
    await put({ ['aiondx.usage.acct.probeacct']: { label: 'probe account', at: Date.now(), status: 'allowed', five_hour: { u: 0.83, reset: nowS + 7200, status: 'allowed' }, seven_day: { u: 0.2, reset: nowS + 5 * 86400, status: 'allowed' } } });
    await sleep(3500);
    await app.js('window.__aionDx.pullNow()');
    await sleep(2500);
    let text = await msgs();
    check('crossing the threshold sends the alert at once, naming the account, the percent and the rule\'s own words', /AionDX usage alert/.test(text) && /probe account/.test(text) && /83%/.test(text) && /Wrap up\./.test(text), text.slice(0, 400));
    us = await app.js('window.__aionDx.usageSettings()');
    check('and it records that it went off for this window', Object.keys(us.fired['conv.' + conv.id] || {}).length === 1, JSON.stringify(us.fired));
    await sleep(3500);
    await app.js('window.__aionDx.pullNow()');
    await sleep(1500);
    text = await msgs();
    check('the same window does not send it twice', (text.match(/AionDX usage alert/g) || []).length === 1, (text.match(/AionDX usage alert/g) || []).length);

    // the settings panel
    await app.js(`window.__aionDx.openUsagePanel({ kind: 'conv', key: 'conv:${conv.id}', convId: '${conv.id}' }); 0`);
    await sleep(300);
    const panelText = await app.js(`(() => { const p = document.querySelector('[data-testid="aiondx-usage-panel"]'); return p ? p.textContent : null; })()`);
    check('the usage panel opens, with the current usage and the rule listed', !!panelText && /5-hour window \d+%/.test(panelText) && /5-hour window at 80%/.test(panelText), panelText);
    await app.js(`(() => { const s = document.querySelector('.aiondx-uspanel [data-f="pollSec"]'); s.value = '10'; s.dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
    await app.js(`(() => { const p = document.querySelector('.aiondx-uspanel [data-f="npct"]'); p.value = '95'; const w = document.querySelector('.aiondx-uspanel [data-f="nwin"]'); w.value = 'week'; document.querySelector('.aiondx-uspanel [data-act="add"]').click(); return 0; })()`);
    await sleep(800);
    const cfg = await app.js(`window.__t.call('GET', '/api/settings/client?keys=aiondx.usage.config,aiondx.usagealert.conv.${conv.id}')`);
    const data = cfg.json.data || {};
    check('changing the refresh rate saves it to the store', data['aiondx.usage.config'] && data['aiondx.usage.config'].pollSec === 10, JSON.stringify(data['aiondx.usage.config']));
    const rules = (data['aiondx.usagealert.conv.' + conv.id] || {}).rules || [];
    check('adding an alert saves it as the user\'s, next to the agent\'s', rules.length === 2 && rules.some((x) => x.window === 'week' && x.at === 0.95 && x.by === 'user') && rules.some((x) => x.by === 'agent'), JSON.stringify(rules));
    await app.key('Escape');
    await sleep(200);
    check('Esc closes the panel', await app.js(`!document.querySelector('[data-testid="aiondx-usage-panel"]')`));
    await app.js(`(() => { window.__aionDx.usageSettings().cfg.pollSec = 3; return 0; })()`);
    await app.js(`window.__t.call('PUT', '/api/settings/client', { 'aiondx.usage.config': { pollSec: 3, writeSec: 60, alerts: true } })`);

    // ---- the Respond-now bolt: a queued message whose text no bubble shows is matched through the Unread badge
    const bolt = await app.js(`(() => {
      const col = document.createElement('div'); col.setAttribute('data-slot-id', 'slotB'); col.id = 'bolttest';
      col.innerHTML = '<div id="message-b1" data-testid="message-text-right"><div data-testid="message-text-content">an older, read message</div></div>' +
        '<div id="message-b2" data-testid="message-text-right"><div data-testid="message-text-content">what the page shows</div><div data-testid="message-status-badge">Unread</div></div>';
      document.body.appendChild(col);
      const q = { t: { kind: 'team', key: 'team:T:slotB', teamId: 'T', slotId: 'slotB', role: '' }, items: [{ id: 'mail1', want: 'what the mailbox has, worded differently', at: 5 }] };
      const rows = window.__aionDx.queuedRowsOf(q);
      const exact = window.__aionDx.queuedRowsOf({ t: q.t, items: [{ id: 'mail2', want: 'an older, read message', at: 1 }] });
      col.remove();
      return { rows, exact };
    })()`);
    check('a queued message with different text takes the Unread bubble', bolt.rows.length === 1 && bolt.rows[0].id === 'mail1' && bolt.rows[0].byBadge === true, JSON.stringify(bolt));
    check('and one whose text matches still takes its own bubble by text', bolt.exact.length === 1 && bolt.exact[0].id === 'mail2' && !bolt.exact[0].byBadge, JSON.stringify(bolt));

    // ---- a picture attached to a message box comes back after leaving the chat (and the new-chat page)
    const paste = (box) => app.js(`(async () => {
      const ta = document.querySelector('[data-testid="${box}"]');
      const el = ta && (ta.tagName === 'TEXTAREA' ? ta : ta.querySelector('textarea'));
      if (!el) return 'no box';
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48; cv.getContext('2d').fillRect(0, 0, 64, 48);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'draft-pic.png', { type: 'image/png' }));
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'pasted';
    })()`);
    const panelPics = (box) => app.js(`(() => {
      const ta = document.querySelector('[data-testid="${box}"]');
      const panel = ta && (ta.closest('.sendbox-panel') || ta.closest('[class*="sendbox"]') || ta.parentElement.parentElement);
      return panel ? panel.querySelectorAll('img').length : -1;
    })()`);
    for (const [label, hash, box] of [['chat box', '#/conversation/' + conv.id, 'sendbox-input'], ['new-chat page', '#/guid', 'guid-input']]) {
      await app.js(`location.hash = '${hash}'; 0`);
      await sleep(3500);
      const before = await panelPics(box);
      const pr = await paste(box);
      await sleep(3000);
      const after = await panelPics(box);
      check(label + ': a pasted picture shows in the box (' + pr + ')', pr === 'pasted' && after > before, JSON.stringify({ before, after }));
      await app.js(`location.hash = '#/settings'; 0`);
      await sleep(1500);
      await app.js(`location.hash = '${hash}'; 0`);
      await sleep(3500);
      const back = await panelPics(box);
      check(label + ': and is still there after leaving and coming back', back > before, JSON.stringify({ before, after, back }));
      const ls = await app.js(`localStorage.getItem('aiondx.sbdraft.v1')`);
      console.log('      ' + label + ' sbdraft: ' + String(ls).slice(0, 160));
    }
  } catch (e) {
    fail++;
    console.log('FAIL  the run threw: ' + (e && e.stack || e));
  } finally {
    await app.close();
  }
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
