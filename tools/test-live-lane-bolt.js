'use strict';
// test-live-lane-bolt.js - what a team lead's lane looks like when you send it a message while it works: the staged app with the edited
// aiondx-ui.js, a throwaway profile, a two-member team whose lead runs on Haiku. The lead is asked to run a 40-second command; while
// it runs, a second message is typed into its box and sent. The probe writes what the server says (run state, the lead's queue) and
// what the page shows (the last bubbles' markup, any AionDX bolt, the status line) to .tmp\test-live-lane-bolt.out. Spends one short
// Haiku turn. November 28th, 2026 (a lead lane with "Processing... 1 queued" and no bolt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

const OUT = path.join(__dirname, '..', '.tmp', 'test-live-lane-bolt.out');
const lines = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + detail + ']')); };
const log = (s) => { lines.push(String(s)); fs.writeFileSync(OUT, lines.join('\n') + '\n'); };
const WORK = path.join(os.tmpdir(), 'aiondx-bolt-work');
const WANT = (fs.readFileSync(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8').match(/var BUILD = '([^']+)'/) || [])[1];

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const app = await launch({ port: 9611, profile: path.join(os.tmpdir(), 'aiondx-bolt-profile'), deadlineMs: 280000 });
  let teamId = null;
  const call = (method, url, body) => app.js(`(async () => {
      const csrf = window.__coreCsrfToken || ((document.cookie.match(/(?:^|;\\s*)aiondx-csrf-token=([^;]+)/) || document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/) || [])[1] || '');
      const r = await fetch('http://127.0.0.1:' + window.__backendPort + ${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
      let j = null; try { j = await r.json(); } catch (e) { /* none */ }
      return [r.status, j && j.data !== undefined ? j.data : j]; })()`);
  try {
    for (let i = 0; i < 60; i++) { if ((await app.js('!!window.__aionDx && !!window.__backendPort')) === true) break; await sleep(1000); }
    await app.overrideScript('aiondx-ui.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'));
    for (let i = 0; i < 60; i++) { await sleep(1000); if ((await app.js('window.__aionDx && window.__aionDx.build')) === WANT && (await app.js('!!window.__backendPort'))) break; }
    log('build ' + await app.js('window.__aionDx && window.__aionDx.build'));
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    const as = await call('GET', '/api/assistants');
    const claude = (as[1] || []).filter((a) => a && a.enabled !== false && /claude/i.test(String((a.agent && (a.agent.acp_backend || a.agent.backend)) || a.name || '')));
    log('claude assistants: ' + claude.map((a) => a.id + ' ' + a.name).join(', '));
    if (!claude.length) throw new Error('no Claude assistant in this profile');
    const made = await call('POST', '/api/teams', { name: 'Bolt probe', workspace: WORK, agents: [
      { assistant_id: claude[0].id, name: 'Lead', role: 'lead', model: 'haiku' }, { assistant_id: claude[0].id, name: 'Worker', role: 'teammate', model: 'haiku' }] });
    teamId = made[1] && made[1].id;
    log('team ' + made[0] + ' ' + teamId);
    if (!teamId) throw new Error('no team');
    await app.js(`location.hash = '#/team/${teamId}'; 0`);
    await sleep(6000);
    const box = `(() => { const cols = [...document.querySelectorAll('[data-slot-id]')]; const col = cols.find((c) => /lead/i.test(c.getAttribute('data-role') || '')) || cols[0];
      const t = col && col.querySelector('[data-testid="sendbox-input"] textarea, textarea[data-testid="sendbox-input"]'); return t; })()`;
    const sendText = async (text) => {
      await app.js(`(() => { const t = ${box}; t.focus(); return !!t; })()`);
      await app.type(text);
      await sleep(300);
      await app.key('Enter');
    };
    await sendText('Use your Bash tool to run exactly this command, in the foreground, and wait for it: ping -n 60 127.0.0.1 . It takes about a minute; do not shorten it. Then reply with the single word done.');
    let rs = null, lead = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      rs = await call('GET', '/api/teams/' + teamId + '/run-state');
      lead = ((rs[1] && rs[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))) || ((rs[1] && rs[1].slot_work) || [])[0];
      if (lead && (lead.state === 'running' || lead.active_turn_id)) break;
    }
    log('lead working: ' + JSON.stringify(lead));
    for (let i = 0; i < 30; i++) { await sleep(1000); if (/ping -n 60/.test(String(await app.js('document.body.innerText')).split('ping -n 60').length > 2 ? 'ping -n 60' : '')) break; }
    await sleep(2000);
    // the bolt beside Send: the lane works and the box has text
    await app.js(`(() => { const t = ${box}; t.focus(); return 0; })()`);
    await app.type('real quick, a second message while you work');
    await sleep(4500);
    const sendBolt = await app.js(`(() => { const cols = [...document.querySelectorAll('[data-slot-id]')]; const col = cols.find((c) => /lead/i.test(c.getAttribute('data-role') || '')) || cols[0]; return !!(col && col.querySelector('[data-testid="aiondx-solo-bolt"]')); })()`);
    check('the lead lane works and its box has text: a bolt beside Send', sendBolt);
    await app.key('Enter');
    let laneBolt = 0;
    for (let i = 0; i < 12; i++) { await sleep(1000); laneBolt = await app.js(`(() => { const cols = [...document.querySelectorAll('[data-slot-id]')]; const col = cols.find((c) => /lead/i.test(c.getAttribute('data-role') || '')) || cols[0]; return col ? col.querySelectorAll('[data-testid="aiondx-lane-answer-now"]').length : 0; })()`); if (laneBolt) break; }
    check('the message sent while it works has a bolt (answer it now)', laneBolt === 1, laneBolt);
    if (laneBolt) {
      const at = await app.js(`(() => { const b = document.querySelector('[data-testid="aiondx-lane-answer-now"]'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
      let idle = false;
      for (let i = 0; i < 20; i++) { await sleep(1000); const r2 = await call('GET', '/api/teams/' + teamId + '/run-state'); const l2 = ((r2[1] && r2[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))); if (l2 && !l2.active_turn_id) { idle = true; break; } }
      check('pressing it stops the step the lead was on (the minute-long command)', idle);
      await sleep(3000);
      const gone = await app.js(`document.querySelectorAll('[data-testid="aiondx-lane-answer-now"]').length`);
      check('and the bolt goes', gone === 0, gone);
    }
    // the bolt beside Send, pressed: the message goes and the step stops
    await sleep(8000);
    await sendText('Run exactly this again with your Bash tool, in the foreground, and wait for it: ping -n 60 127.0.0.1 . Then reply with the word done.');
    let busy = false;
    for (let i = 0; i < 30; i++) { await sleep(1000); const r3 = await call('GET', '/api/teams/' + teamId + '/run-state'); const l3 = ((r3[1] && r3[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))); if (l3 && l3.active_turn_id) { busy = true; break; } }
    await sleep(9000);
    await app.js(`(() => { const t = ${box}; t.focus(); return 0; })()`);
    await app.type('urgent: answer this one now');
    await sleep(4500);
    const sb = await app.js(`(() => { const cols = [...document.querySelectorAll('[data-slot-id]')]; const col = cols.find((c) => /lead/i.test(c.getAttribute('data-role') || '')) || cols[0]; const b = col && col.querySelector('[data-testid="aiondx-solo-bolt"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check('working again, text in the box: the bolt beside Send', busy && !!sb, JSON.stringify([busy, sb]));
    if (sb) {
      for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: sb.x, y: sb.y, button: 'left', clickCount: 1 });
      let idle2 = false;
      for (let i = 0; i < 20; i++) { await sleep(1000); const r4 = await call('GET', '/api/teams/' + teamId + '/run-state'); const l4 = ((r4[1] && r4[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))); if (l4 && !l4.active_turn_id) { idle2 = true; break; } }
      const boxNow = await app.js(`(${box}).value`);
      const rr = await call('GET', '/api/teams/' + teamId);
      const lr = ((rr[1] && (rr[1].assistants || rr[1].agents)) || []).find((a) => /lead/i.test(String(a.role || '')));
      const mm = lr ? await call('GET', '/api/conversations/' + lr.conversation_id + '/messages?limit=12') : null;
      const ml2 = mm && (Array.isArray(mm[1]) ? mm[1] : ((mm[1] && (mm[1].messages || mm[1].items)) || []));
      const sentIt = (ml2 || []).some((m) => m.position === 'right' && /urgent: answer this one now/.test(JSON.stringify(m.content)));
      check('pressing it sends the message (the box empties) and stops the step', idle2 && sentIt && boxNow === '', JSON.stringify([idle2, sentIt, boxNow]));
    }
    for (let i = 0; i < 2; i++) {
      await sleep(1500);
      rs = await call('GET', '/api/teams/' + teamId + '/run-state');
      lead = ((rs[1] && rs[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))) || ((rs[1] && rs[1].slot_work) || [])[0];
    }
    log('after the second message, run state: ' + JSON.stringify(lead));
    const dom = await app.js(`(() => {
      const cols = [...document.querySelectorAll('[data-slot-id]')]; const col = cols.find((c) => /lead/i.test(c.getAttribute('data-role') || '')) || cols[0];
      if (!col) return { col: false };
      const items = [...col.querySelectorAll('[id^="message-"]')].slice(-4).map((r) => ({ id: r.id, tids: [...r.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).slice(0, 12), text: r.textContent.slice(0, 80), cls: String(r.className).slice(0, 120) }));
      const hits = [...col.querySelectorAll('*')].filter((e) => e.children.length === 0 && /a second message while you work/.test(e.textContent)).map((e) => {
        const chain = []; let x = e; for (let i = 0; i < 8 && x && x !== col; i++, x = x.parentElement) chain.push(x.tagName.toLowerCase() + (x.id ? '#' + x.id : '') + (x.getAttribute('data-testid') ? '[' + x.getAttribute('data-testid') + ']' : '') + '.' + String(x.className).split(/\\s+/).slice(0, 3).join('.'));
        return chain; });
      return { items, hits, bolts: col.querySelectorAll('.aiondx-rn-bolt').length, rnBox: !!col.querySelector('.aiondx-rn'), status: (col.querySelector('[class*="thought"], [data-testid*="thought"]') || {}).textContent || '',
        stop: !!col.querySelector('.sendbox-stop-button, [data-testid="aiondx-stop-btn"]') };
    })()`);
    log('lead column: ' + JSON.stringify(dom, null, 1));
    // the server's own record of the lead's messages: ids, sides and status, to match against the bubbles
    const roster = await call('GET', '/api/teams/' + teamId);
    const leadRow = ((roster[1] && (roster[1].assistants || roster[1].agents)) || []).find((a) => /lead/i.test(String(a.role || '')));
    const msgs = leadRow ? await call('GET', '/api/conversations/' + leadRow.conversation_id + '/messages?limit=8') : null;
    const ml = msgs && (Array.isArray(msgs[1]) ? msgs[1] : ((msgs[1] && (msgs[1].messages || msgs[1].items)) || []));
    log('lead conversation ' + (leadRow && leadRow.conversation_id) + ' messages: ' + JSON.stringify((ml || []).slice(-5).map((m) => ({ id: m.id, msg_id: m.msg_id, pos: m.position, status: m.status, type: m.type, text: String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 60) }))));
    // what a bolt would do: cancel the running turn. Is the message already handed in answered right after?
    if (leadRow) {
      const cv = await call('GET', '/api/conversations/' + leadRow.conversation_id);
      const turn = cv[1] && cv[1].runtime && cv[1].runtime.turn_id;
      const cancel = await call('POST', '/api/conversations/' + leadRow.conversation_id + '/cancel', { turn_id: turn });
      log('cancel ' + turn + ': ' + cancel[0] + ' ' + JSON.stringify(cancel[1]).slice(0, 200));
      for (let i = 0; i < 25; i++) {
        await sleep(1500);
        const rs2 = await call('GET', '/api/teams/' + teamId + '/run-state');
        const l2 = ((rs2[1] && rs2[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || '')));
        if (i % 4 === 0) log('  t+' + Math.round((i + 1) * 1.5) + 's lead ' + (l2 && l2.state) + ' turn ' + (l2 && l2.active_turn_id));
      }
      const after = await call('GET', '/api/conversations/' + leadRow.conversation_id + '/messages?limit=10');
      const al = Array.isArray(after[1]) ? after[1] : ((after[1] && (after[1].messages || after[1].items)) || []);
      log('after the cancel: ' + JSON.stringify(al.slice(-5).map((m) => ({ pos: m.position, status: m.status, type: m.type, text: String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 90) }))));
    }
  } catch (e) { log('ERROR ' + (e && e.stack || e)); }
  finally {
    try { if (teamId) { await call('POST', '/api/teams/' + teamId + '/stop', {}); await call('DELETE', '/api/teams/' + teamId); } } catch (e) { /* closing anyway */ }
    await app.close();
    log(pass + "/" + (pass + fail) + " passed");
    process.exit(fail ? 1 : 0);
  }
})();
