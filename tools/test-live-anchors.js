#!/usr/bin/env node
/**
 * test-live-anchors.js - patches core-0009 and 0013 in the real built app, on a hidden desktop and a throwaway profile.
 * A conversation of 600 user turns (4,200 messages) is put in the profile's database; the app opens it. The rail beside the chat must
 *   - get its turns from one request to /anchors, and download no history page by page;
 *   - draw only the ticks in view, not one for each turn;
 *   - still show the preview card when the pointer is over it, and still move its window when it is scrolled.
 * (The bounded message list is not checked here: see the note in the test body.)
 *
 *   node tools/test-live-anchors.js [--stage DIR]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const profile = path.join(os.tmpdir(), 'aiondx-anchors-profile');
const TURNS = 600;
const CID = 'anchors-test-conversation';

const SEED = `
import json, os, sqlite3, sys, time
db = sys.argv[1]
c = sqlite3.connect(db, timeout=60)
uid = c.execute("select id from users where id not like 'system%' order by created_at limit 1").fetchone()[0]
now = int(time.time() * 1000)
cid = ${JSON.stringify(CID)}
c.execute("delete from messages where conversation_id=?", (cid,))
c.execute("delete from conversations where id=?", (cid,))
cols = [r[1] for r in c.execute("pragma table_info(conversations)")]
row = {k: None for k in cols}
row.update({"id": cid, "user_id": uid, "name": "ANCHORS TEST", "type": "acp", "extra": json.dumps({"workspace": os.environ["TEMP"], "backend": "claude"}),
            "status": "finished", "source": "aionui", "pinned": 0, "created_at": now - 10**9, "updated_at": now, "name_source": "user"})
c.execute("insert into conversations (%s) values (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values()))
mcols = [r[1] for r in c.execute("pragma table_info(messages)")]
FILLER = ('The change touches three files and the tests for them all pass. ' * 5).strip()
rows = []
t = now - 10**9
n = 0
def add(kind, position, content, msg_id="auto"):
    global n, t
    n += 1
    t += 1000
    r = {k: None for k in mcols}
    r.update({"id": "m%06d" % n, "conversation_id": cid, "msg_id": ("mid%06d" % n) if msg_id == "auto" else msg_id, "type": kind, "content": json.dumps(content), "position": position, "status": "finish", "hidden": 0, "created_at": t})
    rows.append(tuple(r[k] for k in mcols))
for i in range(${TURNS}):
    # The shapes of a real agent chat: a user text, thinking, a tool call, replies, an empty-turn tip.
    add("text", "right", {"content": "question number %d  with   odd\\n whitespace" % (i + 1)})
    add("thinking", "left", {"content": "thinking about turn %d" % i, "status": "done", "duration_ms": 640})
    call = "toolu_%024d" % i
    add("tool_call", "left", {"call_id": call, "name": "PowerShell", "args": {"command": "echo %d" % i}, "status": "completed", "input": {"command": "echo %d" % i}, "output": "output %d" % i}, call)
    add("text", "left", {"content": "first reply of turn %d. " % (i + 1) + FILLER})
    add("text", "left", {"content": "second reply of turn %d. " % (i + 1) + FILLER})
    add("tips", "left", {"content": "", "type": "info", "code": "ACP_EMPTY_TURN", "params": None, "supersedes_key": None}, None)
    add("text", "left", {"content": "third reply of turn %d. " % (i + 1) + FILLER})
c.executemany("insert into messages (%s) values (%s)" % (",".join(mcols), ",".join("?" * len(mcols))), rows)
c.commit()
print("seeded", n)
`;

async function ready(app) { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; }

(async () => {
  const stage = arg('--stage') || undefined;
  const first = await launch({ port: 9601, deadlineMs: 150000, stage, profile });
  try { await ready(first); await sleep(4000); } finally { await first.close(); }
  await sleep(2500);
  const seedFile = path.join(os.tmpdir(), 'aiondx-anchors-seed.py');
  fs.writeFileSync(seedFile, SEED);
  const r = spawnSync('py', ['-I', seedFile, path.join(profile, 'aionui', 'aionui-backend.db')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  check('(setup) the conversation was put in the profile', /seeded 4200/.test(r.stdout || ''), (r.stdout || '') + (r.stderr || ''));

  const app = await launch({ port: 9602, deadlineMs: 1200000, stage, profile, keepProfile: true });
  try {
    await ready(app);
    await sleep(4000);
    // A fresh profile opens the Welcome screen over the page: hide it, as the other live tests do.
    await app.js("(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()");
    await app.send('Network.enable');
    app.events.length = 0;
    await app.js("location.hash = '#/conversation/" + CID + "'; 0");
    let ticks = 0;
    for (let i = 0; i < 90; i++) { await sleep(500); ticks = await app.js("document.querySelectorAll('[data-testid=\"message-anchor-tick\"]').length"); if (ticks > 0) break; }
    await sleep(3000);
    const urls = app.events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params.request.url);
    const anchors = urls.filter((u) => /\/anchors(\?|$)/.test(u));
    const paged = urls.filter((u) => /\/messages\?[^#]*\bbefore=/.test(u));
    ticks = await app.js("document.querySelectorAll('[data-testid=\"message-anchor-tick\"]').length");
    check('the rail got its turns from one /anchors request', anchors.length === 1, JSON.stringify(anchors.map((u) => u.split('/api/')[1])));
    check('and downloaded no history page by page (older pages are only asked for by scrolling)', paged.length === 0, paged.length + ' requests');
    check('the rail draws only the ticks in view, not 600', ticks > 0 && ticks <= 60, ticks);
    const first0 = await app.js("(() => { const t = document.querySelectorAll('[data-testid=\"message-anchor-tick\"]'); return t.length ? t[t.length - 1].getAttribute('data-anchor-index') : null; })()");
    check('the newest turn is the last one drawn (the rail follows the chat to its end)', String(first0) === String(TURNS), first0);

    // Pointer over the rail: the preview card shows the question and the first reply of the turn under it.
    const zone = await app.js("(() => { const z = document.querySelector('[data-testid=\"message-anchor-rail-zone\"]'); if (!z) return null; const r = z.getBoundingClientRect(); return { x: Math.round(r.left + 6), y: Math.round(r.bottom - 6), top: Math.round(r.top + r.height / 2) }; })()");
    check('the rail is on the page', !!zone, JSON.stringify(zone));
    if (zone) {
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: zone.x, y: zone.y });
      await sleep(400);
      const card = await app.js("(() => { const c = document.querySelector('[data-testid=\"message-anchor-preview\"]'); return c ? c.textContent : null; })()");
      check('hovering a tick shows the preview card with its question and first reply', card && /^question number \d+ with odd whitespace/.test(card) && /first reply of turn \d+\. The change touches/.test(card), card);
      // Scroll the rail up by wheel: the ticks drawn change to an earlier part of the conversation.
      await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zone.x, y: zone.top, deltaX: 0, deltaY: -6000 });
      await sleep(800);
      const after = await app.js("(() => { const t = document.querySelectorAll('[data-testid=\"message-anchor-tick\"]'); return { n: t.length, last: t.length ? Number(t[t.length - 1].getAttribute('data-anchor-index')) : 0, first: t.length ? Number(t[0].getAttribute('data-anchor-index')) : 0 }; })()");
      check('scrolling the rail draws an earlier window of ticks', after.n > 0 && after.n <= 60 && after.last < TURNS - 100, JSON.stringify(after));
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: zone.x, y: zone.top });
      await sleep(400);
      const card2 = await app.js("(() => { const c = document.querySelector('[data-testid=\"message-anchor-preview\"]'); return c ? c.textContent : null; })()");
      const num = card2 && /question number (\d+)/.exec(card2);
      check('and the card follows the pointer to a turn inside that window', num && Number(num[1]) >= after.first && Number(num[1]) <= after.last + 1, JSON.stringify({ card2, after }));
    }

    // The bounded message list (0013 W1) is checked on a copy of a real long chat by hand: on this seeded chat AionUi 2.2.2 itself freezes
    // when the list is scrolled back to its bottom, with or without AionDX (October 24th, 2026; see patches/0013-chat-anchors/PATCH.md).
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
  } finally { await app.close(); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(path.join(os.tmpdir(), 'aiondx-anchors-seed.py'), { force: true }); } catch (e) { /* in use */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
