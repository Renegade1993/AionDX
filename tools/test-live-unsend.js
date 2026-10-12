'use strict';
// test-live-unsend.js - Unsend of a team member's waiting message in the real app (the staged build, a throwaway profile), with the
// edited aionui-dx.js served in place of the built one. A Worker is held mid-turn on a permission prompt (a tool call nobody approves),
// a second message to it waits as "Unread", and the Unsend button on that bubble is clicked. Uses the real Claude Code agent for one
// short first turn, so it spends a little of the account's usage.
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 700) + ']')); };

(async () => {
  const app = await launch({ port: 9562, deadlineMs: 290000 });
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

    const asst = await app.js(`(async () => { const l = ((await window.__t.call('GET', '/api/assistants')).json || {}).data || []; const a = l.find((x) => x.name === 'Claude Code') || l[0]; return a ? { id: a.id, name: a.name } : null; })()`);
    console.log('assistant', JSON.stringify(asst));
    const made = await app.js(`window.__t.call('POST', '/api/teams', { name: 'unsend probe', agents: [{ name: 'Lead', role: 'lead', model: 'default', assistant_id: ${JSON.stringify(asst && asst.id)} }, { name: 'Worker', role: 'teammate', model: 'default', assistant_id: ${JSON.stringify(asst && asst.id)} }] })`);
    const team = made.json && (made.json.data || made.json);
    check('a team was created', made.status < 300 && team && team.id, JSON.stringify(made).slice(0, 400));
    if (!team || !team.id) return;
    console.log('team keys', Object.keys(team).join(','), 'agents', JSON.stringify((team.assistants || team.agents || []).map((a) => ({ slot: a.slot_id, name: a.name, role: a.role, conv: a.conversation_id, keys: Object.keys(a).join("|") }))));
    const worker = (team.assistants || team.agents || []).find((a) => /worker/i.test(a.name) || a.role === 'teammate');
    check('the team has a Worker member', !!worker, JSON.stringify(team.assistants || team.agents));
    if (!worker) return;
    await app.js(`location.hash = '#/team/${team.id}'; 0`);
    await sleep(6000);

    // 1. a first message: a tool call that waits for approval, which holds the Worker mid-turn
    let r = await app.js(`window.__t.call('POST', '/api/teams/${team.id}/agents/${worker.slot_id}/messages', { content: 'Use the Bash tool right now to run exactly this command: py -c "import time; time.sleep(90)"   Do nothing else.' })`);
    check('the first message is accepted', r.status < 300, JSON.stringify(r).slice(0, 300));
    let held = false;
    for (let i = 0; i < 45 && !held; i++) {
      await sleep(2000);
      const s = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/teams/${team.id}/run-state'); return JSON.stringify(rs.json).slice(0, 600); })()`);
      if (i % 5 === 0) console.log('run-state', s);
      held = /permission|confirm|waiting|working|running/i.test(s) && i >= 4;
    }
    // 2. the second message, which has to wait
    const wm = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/conversations/${worker.conversation_id}/messages?limit=30'); const d = rs.json && (rs.json.data || rs.json); const l = Array.isArray(d) ? d : (d && (d.items || d.messages)) || []; return JSON.stringify(l.slice(-4).map((m) => ({ t: m.type, p: m.position, st: m.status, c: JSON.stringify(m.content).slice(0, 700) }))); })()`);
    console.log('worker messages before the second send', wm);
    const marker = 'SECOND-' + Date.now().toString(36);
    r = await app.js(`window.__t.call('POST', '/api/teams/${team.id}/agents/${worker.slot_id}/messages', { content: 'Reply with only the word ${marker}' })`);
    check('the second message is accepted', r.status < 300, JSON.stringify(r).slice(0, 300));
    await sleep(6000);
    const dom = await app.js(`(() => {
      const bs = [...document.querySelectorAll('[data-testid="message-status-badge"]')];
      return { badges: bs.map((b) => ({ text: b.textContent, unsend: !!b.querySelector('.aiondx-unsend'), row: (b.closest('[id^="message-"]') || {}).id || null, rowText: ((b.closest('[id^="message-"]') || {}).textContent || '').slice(0, 80) })),
               bolts: document.querySelectorAll('.aiondx-rn-bolt').length, url: location.hash };
    })()`);
    const probe = await app.js(`(() => {
      const out = { marker: [], unread: [], bolt: [] };
      const chain = (e) => { const p = []; for (let n = e, i = 0; n && i < 7; n = n.parentElement, i++) p.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.getAttribute('data-testid') ? '[' + n.getAttribute('data-testid') + ']' : '') + (n.getAttribute('data-slot-id') ? '{slot}' : '')); return p.join(' < '); };
      document.querySelectorAll('*').forEach((e) => { if (e.children.length === 0) { const t = e.textContent || ''; if (t.indexOf('${marker}') >= 0 && out.marker.length < 4) out.marker.push(chain(e)); if (/^\s*Unread\s*$/.test(t) && out.unread.length < 6) out.unread.push(chain(e) + ' | testid=' + e.getAttribute('data-testid')); } });
      document.querySelectorAll('.aiondx-rn-bolt').forEach((b) => out.bolt.push(chain(b)));
      out.diag = window.__aionDx && window.__aionDx.diag ? 'has diag' : 'no diag';
      return JSON.stringify(out);
    })()`);
    console.log('probe', probe);
    console.log('dom', JSON.stringify(dom));
    const row = await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker}') >= 0); return r ? { id: r.id, badge: !!r.querySelector('[data-testid="message-status-badge"]'), foot: !!r.querySelector('.aiondx-unsend-foot'), btn: !!r.querySelector('.aiondx-unsend'), bolt: !!r.querySelector('.aiondx-rn-bolt'), btnText: (r.querySelector('.aiondx-unsend') || {}).textContent || null } : null; })()`);
    console.log('row', JSON.stringify(row));
    console.log('runUnsend', await app.js('window.__aionDx.runUnsend()'));
    console.log('row after run', JSON.stringify(await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker}') >= 0); return r ? { foot: !!r.querySelector('.aiondx-unsend-foot'), btn: !!r.querySelector('.aiondx-unsend'), html: r.innerHTML.slice(0, 600) } : null; })()`)));
    console.log('state', JSON.stringify(await app.js('window.__aionDx.teamUnsendState()')));
    const mine = row && row.btn ? row : null;
    check('the waiting message is drawn with its Respond-now bolt', !!(row && row.bolt), JSON.stringify(row));
    check('and has an Unsend button (under the bubble when there is no Unread badge)', !!mine, JSON.stringify(row));
    const mb = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/teams/${team.id}/mailbox'); const d = rs.json && (rs.json.data || rs.json); return JSON.stringify(Array.isArray(d) ? d.slice(-4).map((m) => ({ id: m.id, to: m.to_slot_id || m.to, read: m.read, status: m.status, c: String(m.content || '').slice(0, 40) })) : d).slice(0, 700); })()`);
    console.log('mailbox', mb);
    if (mine) {
      await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker}') >= 0); r.querySelector('.aiondx-unsend').click(); return 1; })()`);
      let after = null;
      for (let i = 0; i < 14; i++) {
        await sleep(2000);
        after = await app.js(`(() => {
          const row = [...document.querySelectorAll('[id^="message-"]')].find((x) => x.textContent.indexOf('${marker}') >= 0);
          return { unsent: row ? row.getAttribute('data-aiondx-unsent') : 'norow', badge: row ? !!row.querySelector('[data-testid="message-status-badge"]') : null,
                   notices: [...document.querySelectorAll('.arco-message, .arco-notification, [class*="aiondx-notice"], [class*="aiondx-toast"]')].map((n) => n.textContent.slice(0, 120)) };
        })()`);
        if (after.unsent === '1' || (after.notices && after.notices.length)) break;
      }
      console.log('after click', JSON.stringify(after));
      check('after Unsend the message is marked as taken back', after && after.unsent === '1', JSON.stringify(after));
      const mb2 = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/teams/${team.id}/mailbox'); const d = rs.json && (rs.json.data || rs.json); return JSON.stringify(Array.isArray(d) ? d.slice(-4).map((m) => ({ id: m.id, read: m.read, status: m.status, c: String(m.content || '').slice(0, 40) })) : d).slice(0, 700); })()`);
      console.log('mailbox after', mb2);
    }

    // Edit: a third waiting message, taken back with its text put in the Worker's message box
    const marker3 = 'THIRD-' + Date.now().toString(36);
    r = await app.js(`window.__t.call('POST', '/api/teams/${team.id}/agents/${worker.slot_id}/messages', { content: 'Reply with only the word ${marker3}' })`);
    check('the third message is accepted', r.status < 300, JSON.stringify(r).slice(0, 300));
    let edit = null;
    for (let i = 0; i < 8 && !(edit && edit.btn); i++) {
      await sleep(2000);
      edit = await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker3}') >= 0); return r ? { btn: !!r.querySelector('.aiondx-edit'), unsend: !!r.querySelector('.aiondx-unsend') } : null; })()`);
    }
    check('the waiting message has an Edit button beside Unsend', !!(edit && edit.btn && edit.unsend), JSON.stringify(edit));
    if (edit && edit.btn) {
      await app.js(`(() => { const r = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker3}') >= 0); r.querySelector('.aiondx-edit').click(); return 1; })()`);
      let box = null;
      for (let i = 0; i < 12; i++) {
        await sleep(1500);
        box = await app.js(`(() => {
          const col = [...document.querySelectorAll('[data-slot-id]')].find((c) => c.getAttribute('data-slot-id') === '${worker.slot_id}');
          const ta = (col || document).querySelector('[data-testid="sendbox-input"]');
          const t = ta && (/^(TEXTAREA|INPUT)$/.test(ta.tagName) ? ta : ta.querySelector('textarea, input'));
          const row = [...document.querySelectorAll('[data-testid="message-text-right"]')].find((x) => x.textContent.indexOf('${marker3}') >= 0 && !x.closest('.sendbox-panel'));
          return { value: t ? t.value : null, unsent: row ? row.getAttribute('data-aiondx-unsent') : 'norow' };
        })()`);
        if (box.value && box.value.indexOf(marker3) >= 0) break;
      }
      console.log('after edit', JSON.stringify(box));
      check('Edit put the message text in the Worker\'s message box', !!(box && box.value && box.value.indexOf('Reply with only the word ' + marker3) >= 0), JSON.stringify(box));
      check('and the original bubble is marked as taken back', !!(box && box.unsent === '1'), JSON.stringify(box));
      const mb3 = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/teams/${team.id}/mailbox'); const d = rs.json && (rs.json.data || rs.json); return JSON.stringify(Array.isArray(d) ? d.slice(-3).map((m) => ({ read: m.read, c: String(m.content || '').slice(0, 44) })) : d).slice(0, 500); })()`);
      console.log('mailbox after edit', mb3);
    }
  } finally {
    await app.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
