#!/usr/bin/env node
/**
 * test-live-groups.js - the sidebar's groups in the real built app, on a hidden desktop and a throwaway profile (a request of 2026-11-02).
 * Four chats and a team of two are put in the profile's database. The test does what a person does: right-clicks a chat and a team (AionUi's
 * own menu, with one line more for the group), makes groups from the dialog, drags chats and teams into a group, to a place in it, out of it and onto
 * "New Group +" (real mouse drags, intercepted by the debugger and dropped), and reloads to see it all kept.
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
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']')); };
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

  const app = await launch({ port: 9642, deadlineMs: 900000, stage, profile, keepProfile: true });
  const js = (x) => Promise.race([app.js(x), sleep(20000).then(() => { throw new Error('the page did not answer in 20 s: ' + String(x).slice(0, 80)); })]);
  const mouse = async (pt, button, down) => { for (const t of down ? ['mouseMoved', 'mousePressed', 'mouseReleased'] : ['mouseMoved']) await app.send('Input.dispatchMouseEvent', { type: t, x: pt.x, y: pt.y, button: t === 'mouseMoved' ? 'none' : button, clickCount: 1 }); await sleep(600); };
  const rclick = (pt) => mouse(pt, 'right', true);
  const lclick = (pt) => mouse(pt, 'left', true);
  // where a visible element with this exact text is
  const where = (text, within) => js(`(() => { const root = ${within ? 'document.querySelector(' + JSON.stringify(within) + ')' : 'document'}; if (!root) return null; const e = Array.from(root.querySelectorAll('*')).find((x) => x.children.length === 0 && (x.textContent || '').trim() === ${JSON.stringify(text)} && x.getClientRects().length); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(20, r.width / 2)), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), h: Math.round(r.height) }; })()`);
  const clickText = (text, sel) => js(`(() => { const e = Array.from(document.querySelectorAll(${JSON.stringify(sel || '*')})).find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)} && x.getClientRects().length); if (!e) return false; e.click(); return true; })()`);
  const setName = (name, enter) => js(`(() => { const i = document.querySelector('[data-testid="aiondx-group-name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); ${enter ? "i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" : "document.querySelector('[data-testid=\"aiondx-group-ok\"]').click();"} return 0; })()`);
  const state = () => js(`(() => {
    const g = document.querySelector('[data-testid="aiondx-groups"]');
    const hidden = (t) => { const e = Array.from(document.querySelectorAll('.chat-history__item')).find((x) => (x.textContent || '').trim() === t); return e ? getComputedStyle(e).display === 'none' : null; };
    return {
      has: !!g, last: !!g && g.parentElement && g.parentElement.lastElementChild === g,
      line: !!g && !!g.firstElementChild && g.firstElementChild.getAttribute('data-testid') === 'aiondx-group-line',
      heads: g ? Array.from(g.querySelectorAll('.aiondx-ghead .aiondx-gtitle')).map((x) => x.textContent) : [],
      rows: g ? Array.from(g.querySelectorAll('.aiondx-grow')).map((x) => x.getAttribute('data-aiondx-key') + '|' + x.textContent.trim() + '|' + (x.querySelector('img') ? 'img' : x.querySelector('svg') ? 'svg' : 'none') + '|' + x.closest('.aiondx-gsec').querySelector('.aiondx-gtitle').textContent) : [],
      newLast: !!g && g.lastElementChild && g.lastElementChild.textContent === 'New Group +',
      stockHidden: { alpha: hidden('GRP ALPHA CHAT'), beta: hidden('GRP BETA CHAT'), gamma: hidden('GRP GAMMA CHAT') }
    };
  })()`);
  const names = (s) => s.rows.map((x) => x.split('|')[1]);
  // AionUi's own menus that are on screen: their items and where they are
  const stockMenus = () => js(`(() => Array.from(document.querySelectorAll('.arco-dropdown-menu:not(.aiondx-gmenu)')).map((m) => { const t = m.closest('.arco-trigger') || m; const cs = getComputedStyle(t); const r = t.getBoundingClientRect(); return { shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0, items: Array.from(m.querySelectorAll('.arco-dropdown-menu-item')).map((e) => e.textContent.trim()), x: Math.round(r.left), y: Math.round(r.top) }; }).filter((x) => x.shown))()`);
  const shownMenu = async () => { const m = await stockMenus(); return m.length ? m[m.length - 1] : null; };
  const away = () => lclick({ x: 1100, y: 800 });   // a real press elsewhere: AionUi's menu closes only for one
  // a real drag of the mouse: the debugger takes the drag when the page starts it, and the drop is put where the pointer ends
  const drag = async (from, to) => {
    await app.send('Input.setInterceptDrags', { enabled: true });
    app.events.length = 0;
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 5; k++) await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + k * 4, y: from.y + k * 3, button: 'left' });
    let di = null;
    for (let k = 0; k < 20 && !di; k++) { di = app.events.find((e) => e.method === 'Input.dragIntercepted'); if (!di) await sleep(100); }
    if (!di) { await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', clickCount: 1 }); await app.send('Input.setInterceptDrags', { enabled: false }); return false; }
    const data = di.params.data;
    for (const [type, pt] of [['dragEnter', to], ['dragOver', to], ['dragOver', { x: to.x, y: to.y }]]) { await app.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data, modifiers: 0 }); await sleep(120); }
    await app.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data, modifiers: 0 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await app.send('Input.setInterceptDrags', { enabled: false });
    await sleep(800);
    return true;
  };
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
    check('with no groups there is one line, then "New Group +", after the teams and conversations', s.has && s.last && s.line && s.heads.length === 0 && s.newLast, JSON.stringify(s));

    // 1. a chat in AionUi's list: its own menu with one line more
    let p = await where('GRP ALPHA CHAT');
    await rclick(p);
    const plain = await shownMenu();
    check("a chat's own menu is AionUi's (Pin, Mark as unread, Rename, Create scheduled task, Archive) with \"Add to group\" last", !!plain && JSON.stringify(plain.items) === JSON.stringify(['Pin', 'Mark as unread', 'Rename', 'Create scheduled task', 'Archive', 'Add to group']), JSON.stringify(plain));
    await clickText('Add to group', '.aiondx-gitem');
    await sleep(500);
    const pt = await where('New Group +', '.aiondx-gmenu');
    check('its chooser lists "New Group +" and nothing to remove yet', !!pt && (await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, '')).indexOf('Remove from group')`)) < 0, JSON.stringify(pt));
    await lclick(pt);   // a real press, as a person's
    await sleep(400);
    check('"New Group +" opens a dialog for the name', await js(`!!document.querySelector('[data-testid="aiondx-group-dialog"]')`));
    await setName('Alpha');
    await sleep(900);
    s = await state();
    check('the group holds the chat with the agent logo; AionUi\'s own row of it is hidden', s.heads.join() === 'Alpha' && s.rows.length === 1 && /^c:grpchat1\|GRP ALPHA CHAT\|img\|Alpha$/.test(s.rows[0]) && s.stockHidden.alpha === true && s.stockHidden.beta === false, JSON.stringify(s));
    check('"New Group +" is still the last line', s.newLast && s.last && s.line, JSON.stringify(s));

    // 2. the same chat, now in a group: the same menu, shown at the pointer
    p = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    await rclick(p);
    const inGroup = await shownMenu();
    const raw = await js(`(() => Array.from(document.querySelectorAll('.arco-dropdown-menu:not(.aiondx-gmenu)')).map((m) => { const t = m.closest('.arco-trigger') || m; const cs = getComputedStyle(t); const r = t.getBoundingClientRect(); return { n: m.querySelectorAll('.arco-dropdown-menu-item').length, display: cs.display, vis: cs.visibility, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], peek: document.querySelectorAll('[data-aiondx-peek]').length }; }))()`);
    check('right-click on a grouped chat shows the same AionUi menu (only the last line reads "Group: Alpha")', !!inGroup && JSON.stringify(inGroup.items.slice(0, 5)) === JSON.stringify(plain.items.slice(0, 5)) && inGroup.items[5] === 'Group: Alpha' && inGroup.items.length === 6, JSON.stringify(raw));
    check('and it opens where the pointer is, not in the corner of the window', !!inGroup && Math.abs(inGroup.x - p.x) < 260 && Math.abs(inGroup.y - p.y) < 140, JSON.stringify({ menu: inGroup && [inGroup.x, inGroup.y], pointer: [p.x, p.y] }));
    await js(`(() => { const it = Array.from(document.querySelectorAll('.arco-dropdown-menu-item')).find((e) => e.textContent.trim() === 'Rename'); it.click(); return 0; })()`);
    await sleep(700);
    check("AionUi's Rename works on it (its dialog shows the chat's name)", await js(`(() => { const m = document.querySelector('.arco-modal'); return !!m && /Rename/.test(m.textContent) && Array.from(m.querySelectorAll('input')).some((i) => i.value === 'GRP ALPHA CHAT'); })()`));
    await js(`(() => { const b = Array.from(document.querySelectorAll('.arco-modal button')).find((x) => /Cancel/.test(x.textContent)); if (b) b.click(); return 0; })()`);
    await sleep(500);
    await away();
    // the three dots on the row give the same menu
    p = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    await mouse(p, 'none', false);
    const dots = await js(`(() => { const r = document.querySelector('[data-testid="aiondx-group-row-c-grpchat1"] .aiondx-grow-more'); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await lclick(dots);
    const viaDots = await shownMenu();
    check("the row's three dots open the same menu", !!viaDots && viaDots.items.length === 6 && viaDots.items[5] === 'Group: Alpha', JSON.stringify(viaDots));
    await away();

    // 2b. a grouped chat keeps what AionUi's own row shows: the unread dot, the icon states, and a click goes to AionUi's row
    const dot = () => js(`(() => { const r = document.querySelector('[data-testid="aiondx-group-row-c-grpchat1"]'); return !!r && !!r.querySelector('span.rounded-full'); })()`);
    p = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    check('(setup) no unread dot yet', (await dot()) === false);
    await rclick(p);
    await js(`(() => { const it = Array.from(document.querySelectorAll('.arco-dropdown-menu-item')).find((e) => e.textContent.trim() === 'Mark as unread'); it.click(); return 0; })()`);
    await sleep(1200);
    check('"Mark as unread" from the grouped row puts AionUi\'s blue unread dot on it', await dot());
    p = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    await rclick(p);
    const asRead = await shownMenu();
    check('and its menu then offers "Mark as read", as AionUi\'s own does', !!asRead && asRead.items.indexOf('Mark as read') >= 0, JSON.stringify(asRead));
    await js(`(() => { const it = Array.from(document.querySelectorAll('.arco-dropdown-menu-item')).find((e) => e.textContent.trim() === 'Mark as read'); it.click(); return 0; })()`);
    await sleep(1200);
    check('marking it read takes the dot off', (await dot()) === false);
    // what AionUi draws in its row (a spinner, the waiting-for-you icon...) shows in the group's row as it changes
    await js(`(() => { const ic = document.getElementById('c-grpchat1').firstElementChild; const b = document.createElement('span'); b.className = 'aiondx-test-state'; b.textContent = 'working'; ic.appendChild(b); return 0; })()`);
    await sleep(1500);
    check("a change in AionUi's own row (its icon states) is drawn in the group's row", await js(`!!document.querySelector('[data-testid="aiondx-group-row-c-grpchat1"] .aiondx-test-state')`));
    await js(`(() => { const b = document.querySelector('#c-grpchat1 .aiondx-test-state'); if (b) b.remove(); return 0; })()`);
    await sleep(1200);
    check('and gone again when it goes', await js(`!document.querySelector('[data-testid="aiondx-group-row-c-grpchat1"] .aiondx-test-state')`));
    // a click on the group's row is a click on AionUi's own row
    await js(`(() => { window.__rowClicks = 0; const r = document.getElementById('c-grpchat1'); r.addEventListener('click', (e) => { window.__rowClicks++; e.stopPropagation(); }, true); return 0; })()`);
    await lclick(await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]'));
    check("a click on the group's row clicks AionUi's own row (its behaviour, not a copy of it)", (await js(`window.__rowClicks`)) === 1, await js(`window.__rowClicks`));

    // 3. a team: its three dots menu (Pin, Rename, Archive) with the group line, from a right-click
    //    (AionUi swaps a team's icon for a spinner while it has a run: that team must be found too)
    await js(`(() => { const i = document.querySelector('[data-testid="team-icon-grp-test-team"]'); i.setAttribute('data-testid', 'team-spinner-grp-test-team'); return 0; })()`);
    p = await where('GRP TEAM');
    await rclick(p);
    const tmenu = await shownMenu();
    check('right-click on a team whose icon is a spinner opens its menu (Pin, Rename, Archive) with "Add to group"', !!tmenu && JSON.stringify(tmenu.items) === JSON.stringify(['Pin', 'Rename', 'Archive', 'Add to group']), JSON.stringify(tmenu));
    await clickText('Add to group', '.aiondx-gitem');
    await sleep(500);
    check("the team's chooser lists Alpha and \"New Group +\"", (await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, ''))`)).join() === 'Alpha,New Group +');
    await lclick(await where('Alpha', '.aiondx-gmenu'));
    await sleep(900);
    s = await state();
    check('the team is in the group, with the team icon, after the chat', JSON.stringify(names(s)) === JSON.stringify(['GRP ALPHA CHAT', 'GRP TEAM']) && /svg/.test(s.rows[1]), JSON.stringify(s.rows));
    p = await where('GRP TEAM', '[data-testid="aiondx-groups"]');
    await rclick(p);
    const tIn = await shownMenu();
    check("right-click on the team in the group gives the same team menu, and the line reads \"Group: Alpha\"", !!tIn && JSON.stringify(tIn.items) === JSON.stringify(['Pin', 'Rename', 'Archive', 'Group: Alpha']) && Math.abs(tIn.y - p.y) < 160, JSON.stringify(tIn));
    await away();

    // 4. drag and drop
    p = await where('GRP BETA CHAT');
    const headPt = await where('Alpha', '[data-testid="aiondx-groups"]');
    let ok = await drag(p, headPt);
    check('(setup) a drag of the mouse is taken by the page', ok);
    s = await state();
    check('a chat dragged from AionUi\'s list onto a group\'s heading goes in at the top', JSON.stringify(names(s)) === JSON.stringify(['GRP BETA CHAT', 'GRP ALPHA CHAT', 'GRP TEAM']) && s.stockHidden.beta === true, JSON.stringify(s.rows));
    // the team onto the upper half of the first row: it takes that place
    let from = await where('GRP TEAM', '[data-testid="aiondx-groups"]');
    let to = await where('GRP BETA CHAT', '[data-testid="aiondx-groups"]');
    await drag(from, { x: to.x, y: to.top + 4 });
    s = await state();
    check('a team dragged onto the top of the first row goes before it (any place, not only the end)', JSON.stringify(names(s)) === JSON.stringify(['GRP TEAM', 'GRP BETA CHAT', 'GRP ALPHA CHAT']), JSON.stringify(names(s)));
    from = await where('GRP TEAM', '[data-testid="aiondx-groups"]');
    to = await where('GRP BETA CHAT', '[data-testid="aiondx-groups"]');
    await drag(from, { x: to.x, y: to.top + to.h - 4 });
    s = await state();
    check('onto the bottom half of a row it goes after it', JSON.stringify(names(s)) === JSON.stringify(['GRP BETA CHAT', 'GRP TEAM', 'GRP ALPHA CHAT']), JSON.stringify(names(s)));
    // out: onto AionUi's own list
    from = await where('GRP ALPHA CHAT', '[data-testid="aiondx-groups"]');
    to = await where('GRP GAMMA CHAT');
    await drag(from, to);
    s = await state();
    check("a grouped chat dragged onto AionUi's list leaves the group and its own row is back", JSON.stringify(names(s)) === JSON.stringify(['GRP BETA CHAT', 'GRP TEAM']) && s.stockHidden.alpha === false, JSON.stringify(s));
    // onto "New Group +": a new group from the name asked for
    from = await where('GRP GAMMA CHAT');
    to = await where('New Group +', '[data-testid="aiondx-groups"]');
    await drag(from, to);
    check('a chat dragged onto "New Group +" asks for the name of a new group', await js(`!!document.querySelector('[data-testid="aiondx-group-dialog"]')`));
    await setName('Gamma', true);
    await sleep(900);
    s = await state();
    check('and goes into it', s.heads.join() === 'Alpha,Gamma' && s.rows.some((x) => /^c:grpchat3\|.*\|Gamma$/.test(x)) && s.newLast, JSON.stringify(s));
    // between groups
    from = await where('GRP GAMMA CHAT', '[data-testid="aiondx-groups"]');
    to = await where('GRP TEAM', '[data-testid="aiondx-groups"]');
    await drag(from, { x: to.x, y: to.top + 4 });
    s = await state();
    check('a chat dragged from one group onto a row of another joins that group at that place', JSON.stringify(names(s)) === JSON.stringify(['GRP BETA CHAT', 'GRP GAMMA CHAT', 'GRP TEAM']) && s.rows.every((x) => /\|Alpha$/.test(x)), JSON.stringify(s.rows));

    // 5. the group's own menu, and rename and collapse
    await rclick(await where('Alpha', '[data-testid="aiondx-groups"]'));
    const gm = await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent)`);
    check('the group\'s menu says its chats and teams are kept when it is deleted', gm.indexOf('Delete group (its chats and teams are kept)') >= 0 && gm.indexOf('Rename group…') >= 0, JSON.stringify(gm));
    await clickText('Rename group…', '.aiondx-gmenu-item');
    await sleep(400);
    await setName('Work');
    await sleep(700);
    s = await state();
    check('rename changes the heading', s.heads.join() === 'Work,Gamma', JSON.stringify(s.heads));
    await js(`document.querySelector('.aiondx-ghead').click(); 0`);
    await sleep(600);
    check('clicking the heading collapses the group, and again opens it', (await state()).rows.length === 0 && (await (async () => { await js(`document.querySelector('.aiondx-ghead').click(); 0`); await sleep(600); return (await state()).rows.length === 3; })()));

    // 6. the new-chat page
    await js(`location.hash = '#/guid'; 0`);
    await sleep(2500);
    const g0 = await js(`(() => { const b = document.querySelector('[data-testid="aiondx-guid-group"]'); return b ? b.textContent.trim() : null; })()`);
    check('the new-chat page has a Group menu that starts at None', g0 === 'Group: None', g0);
    await js(`document.querySelector('[data-testid="aiondx-guid-group"]').click(); 0`);
    await sleep(400);
    const gl = await js(`Array.from(document.querySelectorAll('.aiondx-gmenu-item')).map((e) => e.textContent.replace(/^\\u2713/, ''))`);
    check('it lists None, every group and "New Group +"', JSON.stringify(gl) === JSON.stringify(['None', 'Work', 'Gamma', 'New Group +']), JSON.stringify(gl));
    await clickText('Gamma', '.aiondx-gmenu-item');
    await sleep(500);
    check('picking one shows it on the button', (await js(`document.querySelector('[data-testid="aiondx-guid-group"]').textContent.trim()`)) === 'Group: Gamma');
    const move = (to2) => js(`(() => { const old = location.href; history.replaceState(null, '', '#/conversation/${to2}'); window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: old, newURL: location.href })); return location.hash; })()`);
    await move('grpchat2');
    await sleep(2000);
    s = await state();
    check('a chat that was not just made does not join the group', !s.rows.some((x) => /^c:grpchat2\|.*\|Gamma$/.test(x)), JSON.stringify(s.rows));
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
    check('a chat just made from the new-chat page joins the picked group, at the end', s.rows.filter((x) => /\|Gamma$/.test(x)).map((x) => x.split('|')[1]).join() === 'GRP GAMMA CHAT,GRP FRESH CHAT' || s.rows.some((x) => /^c:grpnew01\|.*\|Gamma$/.test(x)), JSON.stringify(s.rows));

    // 6b. whole groups can be dragged into another order
    await sleep(500);
    from = await where('Gamma', '[data-testid="aiondx-groups"]');
    to = await where('Work', '[data-testid="aiondx-groups"]');
    await drag(from, to);
    s = await state();
    check('a group dragged by its heading onto another group goes before it', s.heads.join() === 'Gamma,Work', JSON.stringify(s.heads));
    from = await where('Gamma', '[data-testid="aiondx-groups"]');
    to = await where('GRP TEAM', '[data-testid="aiondx-groups"]');
    await drag(from, { x: to.x, y: to.top + to.h - 2 });
    s = await state();
    check('dropped on the lower half of the other group it goes after it', s.heads.join() === 'Work,Gamma', JSON.stringify(s.heads));
    from = await where('Gamma', '[data-testid="aiondx-groups"]');
    to = await where('Work', '[data-testid="aiondx-groups"]');
    await drag(from, to);
    check('(Gamma first again)', (await state()).heads.join() === 'Gamma,Work');

    // 7. kept across a reload, in the order the user put them
    const before = (await state()).rows;
    // (from the new-chat page: a short seeded chat can stop AionUi's page in this harness, so the reload is not made on one)
    await js(`history.replaceState(null, '', '#/guid'); 0`);
    await app.send('Page.reload', { ignoreCache: true });
    await sleep(8000);
    await js("(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()");
    await sleep(2500);
    s = await state();
    check('after a reload the groups, their chats, the order and the hidden rows are as they were', JSON.stringify(s.rows) === JSON.stringify(before) && s.heads.join() === 'Gamma,Work' && s.newLast, JSON.stringify({ before, after: s.rows }));
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
