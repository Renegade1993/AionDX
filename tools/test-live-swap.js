#!/usr/bin/env node
/**
 * test-live-swap.js - AionCore patch core-0006 in the real built app, on a hidden desktop and in a throwaway profile: a team is made through the app's own API, a
 * member and then the lead are swapped for another assistant, and the roster is read back. No agent is started (the team has no session until a message is sent), so
 * nothing is spent and no agent runs. The staged app must carry AionDX's AionCore (tools\build-release.ps1 -AionDxCore).
 *   node tools\test-live-swap.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };

const WORK = path.join(os.tmpdir(), 'aiondx-swap-work');

(async () => {
  let app = null;
  try {
    fs.mkdirSync(WORK, { recursive: true });   // a team's folder has to exist
    app = await launch({ port: 9603, profile: path.join(os.tmpdir(), 'aiondx-swap-profile'), deadlineMs: 240000 });
    for (let i = 0; i < 60; i++) { if ((await app.js('!!window.__aionDx && !!window.__backendPort')) === true) break; await sleep(1000); }
    // The page's own fetch, with its session: [status, body].
    const call = (method, url, body) => app.js(`(async () => {
      const csrf = window.__coreCsrfToken || ((document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/) || [])[1] || '');
      const r = await fetch('http://127.0.0.1:' + window.__backendPort + ${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
      let j = null; try { j = await r.json(); } catch (e) { /* none */ }
      return [r.status, j]; })()`);
    const data = (r) => (r && r[1] && r[1].data !== undefined) ? r[1].data : (r && r[1]);

    const as = await call('GET', '/api/assistants');
    const list = (data(as) || []).filter((a) => a && a.id && a.enabled !== false);
    check('the app lists assistants to build a team from', as[0] === 200 && list.length >= 2, as[0] + ' ' + list.length);
    const ids = list.map((a) => a.id);
    // Prefer assistants of different kinds, so the swap changes the backend.
    const byBackend = {};
    list.forEach((a) => { const k = (a.agent && (a.agent.acp_backend || a.agent.type)) || '?'; if (!byBackend[k]) byBackend[k] = a; });
    const kinds = Object.keys(byBackend);
    const a1 = byBackend[kinds[0]], a2 = byBackend[kinds[1]] || list[1];
    console.log('using', a1.id, '(' + kinds[0] + ') and', a2.id, '(' + (kinds[1] || kinds[0]) + ')');

    const made = await call('POST', '/api/teams', { name: 'Swap test', workspace: WORK, agents: [
      { assistant_id: a1.id, name: 'Lead', role: 'lead', model: '' }, { assistant_id: a1.id, name: 'Worker', role: 'teammate', model: '' }] });
    const team = data(made);
    check('a team is created with a lead and a worker', made[0] >= 200 && made[0] < 300 && team && team.id && (team.assistants || team.agents || []).length === 2, made[0] + ' ' + JSON.stringify(made[1]).slice(0, 300));
    if (!team || !team.id) throw new Error('no team, nothing more to test');
    const roster = async () => { const g = await call('GET', '/api/teams/' + team.id); const d = data(g) || {}; return d.assistants || d.agents || []; };
    let r0 = await roster();
    const worker = r0.find((m) => m.name === 'Worker'), lead = r0.find((m) => m.role === 'lead' || m.role === 'leader');
    check('the roster has both', worker && lead, JSON.stringify(r0).slice(0, 300));

    // 1. Swap the worker.
    const swapped = await call('POST', '/api/teams/' + team.id + '/agents/' + worker.slot_id + '/replace', { assistant_id: a2.id, name: 'Coder' });
    const sd = data(swapped);
    check('POST .../replace answers with the new member', swapped[0] === 200 && sd && sd.slot_id === worker.slot_id && sd.name === 'Coder' && sd.conversation_id && sd.conversation_id !== worker.conversation_id, swapped[0] + ' ' + JSON.stringify(swapped[1]).slice(0, 400));
    let r1 = await roster();
    const worker1 = r1.find((m) => m.slot_id === worker.slot_id);
    check('the slot keeps its id and role, with a new conversation and the new assistant, saved in the roster', worker1 && worker1.name === 'Coder' && worker1.role === worker.role && worker1.conversation_id !== worker.conversation_id &&
      (worker1.assistant_id === a2.id || worker1.assistant_id === undefined), JSON.stringify(worker1));
    check('the lead was not touched', (r1.find((m) => m.role === lead.role) || {}).conversation_id === lead.conversation_id);

    // 2. Swap the lead (a removal is refused, a replacement is not).
    const lswap = await call('POST', '/api/teams/' + team.id + '/agents/' + lead.slot_id + '/replace', { assistant_id: a2.id });
    let r2 = await roster();
    const lead2 = r2.find((m) => m.slot_id === lead.slot_id);
    check('the lead can be swapped: same slot and name, a new conversation', lswap[0] === 200 && lead2 && lead2.name === lead.name && lead2.conversation_id !== lead.conversation_id && (lead2.role === 'lead' || lead2.role === 'leader'), lswap[0] + ' ' + JSON.stringify(lead2));

    // 3. Refusals.
    const noAssistant = await call('POST', '/api/teams/' + team.id + '/agents/' + worker.slot_id + '/replace', { assistant_id: '' });
    check('an empty assistant id is refused', noAssistant[0] >= 400 && noAssistant[0] < 500, noAssistant[0]);
    const unknownSlot = await call('POST', '/api/teams/' + team.id + '/agents/not-a-slot/replace', { assistant_id: a2.id });
    check('an unknown slot is refused', unknownSlot[0] >= 400 && unknownSlot[0] < 500, unknownSlot[0] + ' ' + JSON.stringify(unknownSlot[1]).slice(0, 200));
    const unknownField = await call('POST', '/api/teams/' + team.id + '/agents/' + worker.slot_id + '/replace', { assistant_id: a2.id, role: 'lead' });
    check('a field the route does not take is refused', unknownField[0] >= 400 && unknownField[0] < 500, unknownField[0]);
    const unknownAssistant = await call('POST', '/api/teams/' + team.id + '/agents/' + worker.slot_id + '/replace', { assistant_id: 'bare:does-not-exist' });
    check('an assistant that does not exist is refused', unknownAssistant[0] >= 400, unknownAssistant[0] + ' ' + JSON.stringify(unknownAssistant[1]).slice(0, 200));
    const after = await roster();
    check('and the roster is unchanged by the refusals', JSON.stringify(after.map((m) => [m.slot_id, m.conversation_id])) === JSON.stringify(r2.map((m) => [m.slot_id, m.conversation_id])));
    await call('DELETE', '/api/teams/' + team.id);
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
  } finally {
    if (app) await app.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* leave it */ }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
