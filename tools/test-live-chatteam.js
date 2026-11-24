#!/usr/bin/env node
/**
 * test-live-chatteam.js - AionCore patch core-0025 (R-134) in the real built app, on a hidden desktop and in a throwaway profile: a chat is
 * made through the app's own API, made the lead of a new team in place (same id), a member is added, then the team is dissolved back into
 * plain chats, nothing deleted. No agent is started (nothing is sent), so nothing is spent. The staged app must carry AionDX's AionCore
 * (tools\build-release.ps1 -AionDxCore).
 *   node tools\test-live-chatteam.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };

const WORK = path.join(os.tmpdir(), 'aiondx-chatteam-work');

(async () => {
  let app = null;
  try {
    fs.mkdirSync(WORK, { recursive: true });
    app = await launch({ port: 9605, profile: path.join(os.tmpdir(), 'aiondx-chatteam-profile'), deadlineMs: 240000 });
    for (let i = 0; i < 60; i++) { if ((await app.js('!!window.__aionDx && !!window.__backendPort')) === true) break; await sleep(1000); }
    const call = (method, url, body) => app.js(`(async () => {
      const csrf = window.__coreCsrfToken || ((document.cookie.match(/(?:^|;\\s*)aionui-csrf-token=([^;]+)/) || [])[1] || '');
      const r = await fetch('http://127.0.0.1:' + window.__backendPort + ${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
      let j = null; try { j = await r.json(); } catch (e) { /* none */ }
      return [r.status, j]; })()`);
    const data = (r) => (r && r[1] && r[1].data !== undefined) ? r[1].data : (r && r[1]);

    const as = await call('GET', '/api/assistants');
    const list = (data(as) || []).filter((a) => a && a.id && a.enabled !== false);
    check('the app lists assistants', as[0] === 200 && list.length >= 1, as[0] + ' ' + list.length);
    const a1 = list[0];
    console.log('using', a1.id);

    // A plain chat, in its own folder.
    const cr = await call('POST', '/api/conversations', { name: 'Chat to team test', assistant: { id: a1.id, locale: 'en-US' }, extra: { workspace: WORK, custom_workspace: true } });
    const conv = data(cr);
    check('a plain chat is created', cr[0] >= 200 && cr[0] < 300 && conv && conv.id, cr[0] + ' ' + JSON.stringify(cr[1]).slice(0, 300));
    if (!conv || !conv.id) throw new Error('no chat, nothing more to test');

    // 1. Chat to team.
    const made = await call('POST', '/api/teams/from-conversation', { conversation_id: conv.id, name: 'Grown team' });
    const team = data(made);
    const lead = team && (team.assistants || team.agents || [])[0];
    check('POST /api/teams/from-conversation makes it the lead of a new team, the same chat', made[0] === 201 && team && team.name === 'Grown team' && lead && lead.conversation_id === conv.id && /^lead/.test(lead.role),
      made[0] + ' ' + JSON.stringify(made[1]).slice(0, 400));
    if (!team || !team.id) throw new Error('no team');
    const g1 = data(await call('GET', '/api/conversations/' + conv.id)) || {};
    const ex1 = g1.extra || {};
    check('the chat keeps its id, name and folder, and is marked as the team\'s lead', g1.id === conv.id && ex1.teamId === team.id && ex1.role === 'lead' && path.resolve(String(ex1.workspace || '')).toLowerCase() === path.resolve(WORK).toLowerCase(),
      JSON.stringify({ id: g1.id, teamId: ex1.teamId, role: ex1.role, ws: ex1.workspace }));
    const again = await call('POST', '/api/teams/from-conversation', { conversation_id: conv.id, name: 'Twice' });
    check('the same chat cannot be made a team twice', again[0] >= 400 && again[0] < 500, again[0] + ' ' + JSON.stringify(again[1]).slice(0, 200));
    const missing = await call('POST', '/api/teams/from-conversation', { conversation_id: 'not-a-chat', name: 'x' });
    check('a chat that does not exist is refused', missing[0] >= 400 && missing[0] < 500, missing[0]);
    const extraField = await call('POST', '/api/teams/from-conversation', { conversation_id: conv.id, name: 'x', role: 'lead' });
    check('a field the route does not take is refused', extraField[0] >= 400 && extraField[0] < 500, extraField[0]);

    // A member added the usual way.
    const add = await call('POST', '/api/teams/' + team.id + '/agents', { assistant_id: a1.id, name: 'Helper', role: 'teammate', model: '' });
    const member = data(add);
    check('a member can be added to the grown team', add[0] >= 200 && add[0] < 300 && member && member.conversation_id, add[0] + ' ' + JSON.stringify(add[1]).slice(0, 300));
    const tl = data(await call('GET', '/api/teams')) || [];
    check('the team is in the team list with both', tl.some((t) => t.id === team.id && (t.assistants || t.agents || []).length === 2), JSON.stringify(tl.map((t) => t.id)));

    // 2. Team back to chats.
    const dis = await call('POST', '/api/teams/' + team.id + '/dissolve', {});
    const dd = data(dis);
    check('POST /api/teams/{id}/dissolve hands back both chats', dis[0] === 200 && dd && dd.members && dd.members.length === 2 && dd.members.some((m) => m.conversation_id === conv.id), dis[0] + ' ' + JSON.stringify(dis[1]).slice(0, 400));
    const gone = await call('GET', '/api/teams/' + team.id);
    check('the team is gone', gone[0] === 404 || gone[0] === 403 || (gone[0] >= 400), gone[0]);
    const g2 = data(await call('GET', '/api/conversations/' + conv.id)) || {};
    check('the former lead is a plain chat again, same id and folder', g2.id === conv.id && !(g2.extra || {}).teamId && path.resolve(String((g2.extra || {}).workspace || '')).toLowerCase() === path.resolve(WORK).toLowerCase(), JSON.stringify(g2.extra || {}).slice(0, 300));
    const g3 = await call('GET', '/api/conversations/' + (member && member.conversation_id));
    check('the member is kept as a plain chat', g3[0] === 200 && !((data(g3) || {}).extra || {}).teamId, g3[0]);
    const g4 = await call('POST', '/api/conversations/' + conv.id + '/runtime/restart', {});
    check('the former lead is a solo chat to AionCore again (its own restart route answers, not TEAM_RUNTIME_REQUIRED)', !(g4[1] && g4[1].code === 'TEAM_RUNTIME_REQUIRED'), JSON.stringify(g4).slice(0, 200));
    await call('DELETE', '/api/conversations/' + conv.id);
    if (member && member.conversation_id) await call('DELETE', '/api/conversations/' + member.conversation_id);
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
  } finally {
    if (app) await app.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* leave it */ }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
