#!/usr/bin/env node
/**
 * test-live-groups.js - the sidebar's groups in the real built app, on a hidden desktop and a throwaway profile (a request of 2026-11-02).
 * Four chats and a team of two are put in the profile's database. The test then does what a person does: right-clicks a chat (AionUi's own
 * menu gains "Add to group"), makes a group from the dialog, puts a team in it from the team's right-click menu, takes a chat out, renames,
 * collapses, adds a group from "New Group +" at the foot of the list, picks a group on the new-chat page, and reloads to see it all kept.
 *
 *   node tools/test-live-groups.js [--stage DIR] [--page FILE]     (--page: the real app running an edited aiondx-ui.js without a rebuild)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const profile = path.join(os.tmpdir(), 'aiondx-groups-profile');
const TEAM = 'grp-test-team';
const SLOTS = ['grp-slot-lead', 'grp-slot-mate'], MEMBERS = ['grpmem01', 'grpmem02'];
const CHATS = [['grpchat1', 'GRP ALPHA CHAT', 0], ['grpchat2', 'GRP BETA CHAT', 0], ['grpchat3', 'GRP GAMMA CHAT', 0], ['grpnew01', 'GRP FRESH CHAT', 1]];   // the last is just made

const SEED = `
import json, os, sqlite3, sys, time
db = sys.argv[1]
c = sqlite3.connect(db, timeout=60)
uid = c.execute("select id from users where id not like 'system%' order by created_at limit 1").fetchone()[0]
now = int(time.time() * 1000)
team, slots, members, chats = ${JSON.stringify(TEAM)}, ${JSON.stringify(SLOTS)}, ${JSON.stringify(MEMBERS)}, ${JSON.stringify(CHATS)}
ws = os.environ["TEMP"]
cols = [r[1] for r in c.execute("pragma table_info(conversations)")]
mcols = [r[1] for r in c.execute("pragma table_info(messages)")]
n = 0
def conv(cid, name, extra, created):
    row = {k: None for k in cols}
    row.update({"id": cid, "user_id": uid, "name": name, "type": "acp", "extra": json.dumps(extra), "status": "finished", "source": "aionui", "pinned": 0,
                "created_at": created, "updated_at": now - 1000, "name_source": "user"})
    c.execute("insert into conversations (%s) values (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values()))
    t = created
    global n
    for i in range(30):
        for pos, text in (("right", "question %d" % i), ("left", "answer %d. " % i + "Nothing else to report here. " * 6)):
            n += 1; t += 1000
            r = {k: None for k in mcols}
            r.update({"id": "m%06d" % n, "conversation_id": cid, "msg_id": "mid%06d" % n, "type": "text", "content": json.dumps({"content": text}), "position": pos, "status": "finish", "hidden": 0, "created_at": t})
            c.execute("insert into messages (%s) values (%s)" % (",".join(mcols), ",".join("?" * len(mcols))), tuple(r[k] for k in mcols))
for cid, name, recent in chats:
    conv(cid, name, {"backend": "claude", "workspace": ws}, now - 5000 if recent else now - 10**8)
agents = []
for i in range(2):
    conv(members[i], "GRP MEMBER %d" % i, {"backend": "claude", "workspace": ws, "teamId": team, "slot_id": slots[i], "role": "lead" if i == 0 else "teammate"}, now - 10**8)
    agents.append({"slot_id": slots[i], "name": "Member %d" % i, "role": "lead" if i == 0 else "teammate", "conversation_id": members[i], "backend": "claude", "model": "", "assistant_id": ""})
c.execute("insert into teams (id, user_id, name, workspace, workspace_mode, agents, lead_agent_id, agents_version, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)",
          (team, uid, "GRP TEAM", ws, "shared", json.dumps(agents), slots[0], "1.0.1", now - 10**8, now - 10**6))
c.commit()
print("seeded", n)
`;

async function ready(app) { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; }

(async () => {
  const stage = arg('--stage') || undefined;
  const first = await launch({ port: 9641, deadlineMs: 150000, stage, profile });
  try { await ready(first); await sleep(4000); } finally { await first.close(); }
  await sleep(2500);
  const seedFile = path.join(os.tmpdir(), 'aiondx-groups-seed.py');
  fs.writeFileSync(seedFile, SEED);
  const r = spawnSync('py', ['-I', seedFile, path.join(profile, 'aionui', 'aiondx-backend.db')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  check('(setup) the chats and the team were put in the profile', /seeded 360/.test(r.stdout || ''), (r.stdout || '') + (r.stderr || ''));

  const app = await launch({ port: 9642, deadlineMs: 600000, stage, profile, keepProfile: true });
  const js = (x) => Promise.race([app.js(x), sleep(20000).then(() => { throw new Error('the page did not answer in 20 s: ' + String(x).slice(0, 80)); })]);
  const rclick = async (pt) => { for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type: t, x: pt.x, y: pt.y, button: t === 'mouseMoved' ? 'none' : 'right', clickCount: 1 }); await sleep(700); };
  // where a visible element with this exact text is
  const where = (text, within) => js(`(() => { const root = ${within ? 'document.querySelector(' + JSON.stringify(within) + ')' : 'document'}; if (!root) return null; const e = Array.from(root.querySelectorAll('*')).find((x) => x.children.length === 0 && (x.textContent || '').trim() === ${JSON.stringify(text)} && x.getClientRects().length); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(20, r.width / 2)), y: Math.round(r.top + r.height / 2) }; })()`);
  const clickText = (text, sel) => js(`(() => { const e = Array.from(document.querySelectorAll(${JSON.stringify(sel || '*')})).find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)} && x.getClientRects().length); if (!e) return false; e.click(); return true; })()`);
  const state = () => js(`(() => {
    const g = document.querySelector('[data-testid="aiondx-groups"]');
    const hidden = (t) => { const e = Array.from(document.querySelectorAll('.chat-history__item')).find((x) => (x.textContent || '').trim() === t); return e ? getComputedStyle(e).display === 'none' : null; };
    return {
      has: !!g, last: !!g && g.parentElement && g.parentElement.lastElementChild === g,
      heads: g ? Array.from(g.querySelectorAll('.aiondx-ghead .aiondx-gtitle')).map((x) => x.textContent) : [],
      rows: g ? Array.from(g.querySelectorAll('.aiondx-grow')).map((x) => x.getAttribute('data-aiondx-key') + '|' + x.textContent.trim() + '|' + (x.querySelector('img') ? 'img' : x.querySelector('svg') ? 'svg' : 'none')) : [],
      newLast: !!g && g.lastElementChild && g.lastElementChild.textContent === 'New Group +',
      stockHidden: { alpha: hidden('GRP ALPHA CHAT'), beta: hidden('GRP BETA CHAT') }
    };
  })()`);
  try {
    await ready(app);
    await sleep(5000);
    if (arg('--page')) { await app.overrideScript('aiondx-ui.js', arg('--page')); await sleep(6000); }
    await js("(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()");
    await sleep(1500);
    // the Teams list starts collapsed in a fresh profile
    await js(`(() => { if (!document.querySelector('[data-testid^="team-icon-"]')) document.querySelector('[data-testid="team-section-toggle"]').click(); return 0; })()`);
    await sleep(1500);

    let s = await state();
    check('with no groups there is only "New Group +", after the teams and conversations', s.has && s.last && s.heads.length === 0 && s.newLast, JSON.stringify(s));

    // 1. right-click a chat: AionUi's menu, with a group line added
    let p = await where('GRP ALPHA CHAT');
    check('(setup) the chat is in the sidebar', !!p, 'not found');
    await rclick(p);
    const added = await js(`(() => { const i = document.querySelector('.aiondx-gitem'); return i ? i.textContent : null; })()`);
    const stockItems = await js(`Array.from(document.querySelectorAll('.arco-dropdown-menu-item')).map((e) => e.textContent.trim())`);
    check("AionUi's chat menu keeps its own items and gains \"Add to group\"", added === 'Add to group' && stockItems.indexOf('Rename') >= 0 && stockItems.indexOf('Archive') >= 0, JSON.stringify(stockItems));
    await js(`document.querySelector('.aiondx-gitem').click(); 0`);
    await sleep(500);
    const open1 = await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, ''))`);
    const stockShown = () => js(`Array.from(document.querySelectorAll('.arco-dropdown-menu:not(.aiondx-gmenu)')).filter((m) => { const t = m.closest('.arco-trigger') || m; return getComputedStyle(t).visibility !== 'hidden' && t.getClientRects().length; }).length`);
    check('its chooser lists "New Group +" and nothing to remove yet, and AionUi\'s own menu is out of sight', open1.indexOf('New Group +') >= 0 && open1.indexOf('Remove from group') < 0 && (await stockShown()) === 0, JSON.stringify(open1) + ' shown=' + (await stockShown()));
    // a real press of the mouse, as a person's: AionUi's own menu closes only for one (it ignores events a script makes)
    const pt = await where('New Group +', '.aiondx-gmenu');
    for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type: t, x: pt.x, y: pt.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    await sleep(500);
    check('"New Group +" opens a dialog for the name', await js(`!!document.querySelector('[data-testid="aiondx-group-dialog"]')`));
    await js(`(() => { const i = document.querySelector('[data-testid="aiondx-group-name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Alpha'); i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-testid="aiondx-group-ok"]').click(); return 0; })()`);
    await sleep(900);
    s = await state();
    check('the group exists and holds the chat, with the agent logo; AionUi\'s own row of it is hidden', s.heads.join() === 'Alpha' && s.rows.length === 1 && /^c:grpchat1\|GRP ALPHA CHAT\|img$/.test(s.rows[0]) && s.stockHidden.alpha === true && s.stockHidden.beta === false, JSON.stringify(s));
    check('"New Group +" is still the last line', s.newLast && s.last, JSON.stringify(s));
    const leftover = await js(`Array.from(document.querySelectorAll('.arco-dropdown-menu:not(.aiondx-gmenu)')).map((m) => { const t = m.closest('.arco-trigger') || m; return (m.textContent || '').slice(0, 60) + ' | visibility=' + getComputedStyle(t).visibility + ' display=' + getComputedStyle(t).display + ' attrs=' + t.getAttribute('style'); })`);
    check("AionUi's chat menu is closed once the group is made (arco keeps it in the page, display none)", leftover.every((x) => /display=none/.test(x)) && (await stockShown()) === 0, JSON.stringify(leftover));

    // 2. a team: no menu of its own in AionUi, so AionDX opens one
    p = await where('GRP TEAM');
    await rclick(p);
    const tmenu = await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, ''))`);
    check('right-clicking a team offers the groups and "New Group +"', tmenu.indexOf('Alpha') >= 0 && tmenu.indexOf('New Group +') >= 0, JSON.stringify(tmenu));
    await clickText('Alpha', '.aiondx-gmenu-item');
    await sleep(900);
    s = await state();
    check('the team joins the group with the team icon, beside the chat with its agent logo', s.rows.some((x) => /^t:grp-test-team\|GRP TEAM\|svg$/.test(x)) && s.rows.some((x) => /^c:grpchat1\|.*\|img$/.test(x)), JSON.stringify(s.rows));
    check("the team's own row is out of AionUi's list", await js(`(() => { const i = document.querySelector('[data-testid^="team-icon-"]:not(.aiondx-groups *)'); const row = i && i.closest('.h-34px'); return !!row && getComputedStyle(row.parentElement).display === 'none'; })()`));

    // 3. a row of the group: its menu, then back out
    p = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    await rclick(p);
    const gm = await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, ''))`);
    check('a grouped chat\'s menu shows the current group, "Remove from group" and AionUi\'s own actions', gm.indexOf('Alpha') >= 0 && gm.indexOf('Remove from group') >= 0 && gm.indexOf('More actions\u2026') >= 0, JSON.stringify(gm));
    await clickText('More actions\u2026', '.aiondx-gmenu-item');
    await sleep(700);
    const stock2 = await js(`Array.from(document.querySelectorAll('.arco-dropdown-menu-item')).map((e) => e.textContent.trim())`);
    check("\"More actions\" brings up AionUi's own menu for it (Rename, Archive...)", stock2.indexOf('Rename') >= 0 && stock2.indexOf('Archive') >= 0, JSON.stringify(stock2));
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 0`);
    await sleep(400);
    p = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    await rclick(p);
    await clickText('Remove from group', '.aiondx-gmenu-item');
    await sleep(900);
    s = await state();
    check('"Remove from group" puts the chat back in AionUi\'s list', s.rows.length === 1 && /^t:/.test(s.rows[0]) && s.stockHidden.alpha === false, JSON.stringify(s));

    // 4. rename and collapse
    p = await where('Alpha', '[data-testid="aiondx-groups"]');
    await rclick(p);
    await clickText('Rename group\u2026', '.aiondx-gmenu-item');
    await sleep(400);
    await js(`(() => { const i = document.querySelector('[data-testid="aiondx-group-name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Beta'); i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-testid="aiondx-group-ok"]').click(); return 0; })()`);
    await sleep(700);
    s = await state();
    check('rename changes the heading', s.heads.join() === 'Beta', JSON.stringify(s.heads));
    await js(`document.querySelector('.aiondx-ghead').click(); 0`);
    await sleep(600);
    s = await state();
    check('clicking the heading collapses the group', s.rows.length === 0 && s.heads.join() === 'Beta', JSON.stringify(s));
    await js(`document.querySelector('.aiondx-ghead').click(); 0`);
    await sleep(600);
    check('and again opens it', (await state()).rows.length === 1);

    // 5. "New Group +" at the foot
    await clickText('New Group +', '.aiondx-gnew');
    await sleep(400);
    await js(`(() => { const i = document.querySelector('[data-testid="aiondx-group-name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Gamma'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 0; })()`);
    await sleep(800);
    s = await state();
    check('"New Group +" at the foot adds an empty group above itself (Enter in the dialog creates it)', s.heads.join() === 'Beta,Gamma' && s.newLast && s.last, JSON.stringify(s));

    // 6. the new-chat page
    await js(`location.hash = '#/guid'; 0`);
    await sleep(2500);
    const g0 = await js(`(() => { const b = document.querySelector('[data-testid="aiondx-guid-group"]'); return b ? b.textContent.trim() : null; })()`);
    check('the new-chat page has a Group menu that starts at None', g0 === 'Group: None', g0);
    await js(`document.querySelector('[data-testid="aiondx-guid-group"]').click(); 0`);
    await sleep(400);
    const gl = await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, ''))`);
    check('it lists None, every group and "New Group +"', JSON.stringify(gl) === JSON.stringify(['None', 'Beta', 'Gamma', 'New Group +']), JSON.stringify(gl));
    await clickText('Gamma', '.aiondx-gmenu-item');
    await sleep(500);
    check('picking one shows it on the button', (await js(`document.querySelector('[data-testid="aiondx-guid-group"]').textContent.trim()`)) === 'Group: Gamma');
    // a chat made from here lands in the group; an older chat opened from here does not
    // (the move to a chat is told to the page's own listener rather than opened: a short seeded chat can stop AionUi's page in this harness)
    const move = (to) => js(`(() => { const old = location.href; history.replaceState(null, '', '#/conversation/${to}'); window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: old, newURL: location.href })); return location.hash; })()`);
    await move('grpchat2');
    await sleep(2000);
    s = await state();
    check('a chat that was not just made does not join the group', !s.rows.some((x) => /grpchat2/.test(x)), JSON.stringify(s.rows));
    await js(`(() => { const old = location.href; history.replaceState(null, '', '#/guid'); window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: old, newURL: location.href })); return 0; })()`);
    await sleep(2000);
    check('coming back to the new-chat page starts at None again', (await js(`document.querySelector('[data-testid="aiondx-guid-group"]').textContent.trim()`)) === 'Group: None');
    await js(`document.querySelector('[data-testid="aiondx-guid-group"]').click(); 0`);
    await sleep(300);
    await clickText('Gamma', '.aiondx-gmenu-item');
    await sleep(400);
    await move('grpnew01');
    await sleep(2500);
    s = await state();
    check('a chat just made from the new-chat page joins the picked group', s.rows.some((x) => /^c:grpnew01\|GRP FRESH CHAT/.test(x)), JSON.stringify(s.rows));

    // 7. kept across a reload
    await app.send('Page.reload', { ignoreCache: true });
    await sleep(8000);
    await js("(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()");
    await sleep(2500);
    s = await state();
    check('after a reload the groups, their chats and the hidden rows are as they were', s.heads.join() === 'Beta,Gamma' && s.rows.length === 2 && s.newLast, JSON.stringify(s));
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
    try {
      const shot = await Promise.race([app.send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)]);
      if (shot && shot.result) { fs.writeFileSync(path.join(os.tmpdir(), 'aiondx-groups-fail.png'), Buffer.from(shot.result.data, 'base64')); console.log('   screenshot: ' + path.join(os.tmpdir(), 'aiondx-groups-fail.png')); }
    } catch (x) { /* nothing more */ }
  } finally {
    try {
      const shot = await Promise.race([app.send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)]);
      if (shot && shot.result) fs.writeFileSync(path.join(os.tmpdir(), 'aiondx-groups-final.png'), Buffer.from(shot.result.data, 'base64'));
    } catch (x) { /* none */ }
    await app.close();
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(path.join(os.tmpdir(), 'aiondx-groups-seed.py'), { force: true }); } catch (e) { /* in use */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
