'use strict';
// test-live-dead-stop.js - a Stop is dead (2026-11-28): the staged app with the edited aiondx-ui.js, a throwaway profile, a two-member team
// whose lead runs on Haiku. The lead runs a minute-long command; AionUi's own Stop is pressed in its lane. Then a message goes to the lead the
// way another agent's does (straight to AionCore, past the page): the lead must stay asleep. Then a message typed in its box must wake it.
// Spends two short Haiku turns. Output: .tmp\test-live-dead-stop.out
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

const OUT = path.join(__dirname, '..', '.tmp', 'test-live-dead-stop.out');
const lines = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + detail + ']')); };
const log = (s) => { lines.push(String(s)); fs.writeFileSync(OUT, lines.join('\n') + '\n'); };
const WORK = path.join(os.tmpdir(), 'aiondx-dead-work');
const WANT = (fs.readFileSync(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8').match(/var BUILD = '([^']+)'/) || [])[1];

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const app = await launch({ port: 9613, profile: path.join(os.tmpdir(), 'aiondx-dead-profile'), deadlineMs: 280000 });
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
    const made = await call('POST', '/api/teams', { name: 'Stop probe', workspace: WORK, agents: [
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
    check('the lead is working on a minute-long command', !!(lead && lead.active_turn_id));
    await sleep(6000);
    const stopAt = await app.js(`(() => { const cols = [...document.querySelectorAll('[data-slot-id]')]; const col = cols.find((c) => /lead/i.test(c.getAttribute('data-role') || '')) || cols[0];
      const b = col && col.querySelector('.sendbox-stop-button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check("AionUi's Stop is in the lead lane", !!stopAt);
    if (stopAt) for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: stopAt.x, y: stopAt.y, button: 'left', clickCount: 1 });
    let dead = [];
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const st = await call('GET', '/api/settings/client');
      dead = Object.keys(st[1] || {}).filter((k) => /^aiondx\.dead\./.test(k) && st[1][k]);
      const r1 = await call('GET', '/api/teams/' + teamId + '/run-state');
      const l1 = ((r1[1] && r1[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || '')));
      if (dead.length && l1 && !l1.active_turn_id) break;
    }
    check('Stop: the lead stops and is marked stopped', dead.length >= 1, JSON.stringify(dead));
    await sleep(3000);
    // another agent's message: straight to AionCore (XMLHttpRequest, past the page's own fetch)
    const other = await app.js(`new Promise((res) => { const x = new XMLHttpRequest(); x.open('POST', 'http://127.0.0.1:' + window.__backendPort + '/api/teams/` + teamId + `/messages'); x.withCredentials = true;
      const m = document.cookie.match(/aiondx-csrf-token=([^;]+)/) || document.cookie.match(/aionui-csrf-token=([^;]+)/); const csrf = window.__coreCsrfToken || (m ? m[1] : '');
      x.setRequestHeader('Content-Type', 'application/json'); x.setRequestHeader('x-csrf-token', decodeURIComponent(csrf)); x.onload = () => res([x.status, x.responseText.slice(0, 200)]); x.onerror = () => res([0, 'error']);
      x.send(JSON.stringify({ content: 'From another agent: please start working again.' })); })`);
    log("another agent's message: " + JSON.stringify(other));
    let woke = false;
    for (let i = 0; i < 15; i++) { await sleep(1000); const r2 = await call('GET', '/api/teams/' + teamId + '/run-state'); const l2 = ((r2[1] && r2[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))); if (l2 && l2.active_turn_id) { woke = true; break; } }
    check('a message from another agent does not wake the stopped lead', !woke);
    // yours does
    await sendText('Reply with the single word back.');
    let started = false;
    for (let i = 0; i < 25; i++) { await sleep(1000); const r3 = await call('GET', '/api/teams/' + teamId + '/run-state'); const l3 = ((r3[1] && r3[1].slot_work) || []).find((w) => /lead/i.test(String(w.role || ''))); if (l3 && (l3.active_turn_id || l3.state === 'running')) { started = true; break; } }
    const after = await call('GET', '/api/settings/client');
    check('a message you type in its box wakes it, and the mark goes', started && !Object.keys(after[1] || {}).some((k) => /^aiondx\.dead\./.test(k) && after[1][k]), JSON.stringify(started));
  } catch (e) { log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    try { if (teamId) { await call('POST', '/api/teams/' + teamId + '/stop', {}); await call('DELETE', '/api/teams/' + teamId); } } catch (e) { /* closing anyway */ }
    await app.close();
    log(pass + '/' + (pass + fail) + ' passed');
    process.exit(fail ? 1 : 0);
  }
})();
