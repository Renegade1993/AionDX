#!/usr/bin/env node
/**
 * test-live-dollar.js - patch 0017 in the real built app, on a hidden desktop and a throwaway profile.
 * A conversation with replies that contain money ("$1M/$2M", "$40,000 ... $12,500", "($30), a $40,000 add-on ($120)") is put in
 * the profile's database; the app opens it. Each reply must show its text as written, with no formula drawn from it. Maths written with
 * two dollar signs must still be drawn.
 *
 *   node tools/test-live-dollar.js [--stage DIR]
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
const profile = path.join(os.tmpdir(), 'aiondx-dollar-profile');
const CID = 'dollar-test-conversation';

const TEXTS = [
  'The plan covers the $1M/$2M general limits, income with extra expense, and $0 on a building.',
  'The limit uses $40,000, a placeholder. On the 5th they wrote "I will update it to reflect the $12,500."',
  'Options: fee ($30), a form to sign, a $40,000 add-on ($120) nobody asked for.',
  'Written as maths: $$x^2 + y^2$$ stays a formula.',
];

if (process.env.DOLLAR_PLAIN) for (let i = 0; i < TEXTS.length; i++) TEXTS[i] = TEXTS[i].replace(/\$/g, 'S');   // a diagnostic: the same replies without dollar signs

const SEED = `
import json, os, sqlite3, sys, time
db = sys.argv[1]
texts = json.loads(sys.argv[2])
c = sqlite3.connect(db, timeout=60)
uid = c.execute("select id from users where id not like 'system%' order by created_at limit 1").fetchone()[0]
now = int(time.time() * 1000)
cid = ${JSON.stringify(CID)}
c.execute("delete from messages where conversation_id=?", (cid,))
c.execute("delete from conversations where id=?", (cid,))
cols = [r[1] for r in c.execute("pragma table_info(conversations)")]
row = {k: None for k in cols}
row.update({"id": cid, "user_id": uid, "name": "DOLLAR TEST", "type": "acp", "extra": json.dumps({"workspace": os.environ["TEMP"], "backend": "claude"}),
            "status": "finished", "source": "aionui", "pinned": 0, "created_at": now - 10**6, "updated_at": now, "name_source": "user"})
c.execute("insert into conversations (%s) values (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values()))
mcols = [r[1] for r in c.execute("pragma table_info(messages)")]
t = now - 10**6
# the shape of a real chat (a person's turn, a reply, tool and thinking records, many turns), as the anchors test seeds it: a chat of a few short
# messages makes AionUi 2.2.2's message list loop on opening in this harness, with or without AionDX (also seen in test-live-anchors.js)
rows = []
n = 0
def add(kind, position, content, msg_id="auto"):
    global n, t
    n += 1
    t += 1000
    r = {k: None for k in mcols}
    r.update({"id": "d%06d" % n, "conversation_id": cid, "msg_id": ("mid%06d" % n) if msg_id == "auto" else msg_id, "type": kind, "content": json.dumps(content), "position": position, "status": "finish", "hidden": 0, "created_at": t})
    rows.append(tuple(r[k] for k in mcols))
FILLER = ('The change touches three files and the tests for them all pass. ' * 5).strip()
for i in range(60):
    add("text", "right", {"content": "question number %d" % (i + 1)})
    add("thinking", "left", {"content": "thinking about turn %d" % i, "status": "done", "duration_ms": 640})
    call = "toolu_%024d" % i
    add("tool_call", "left", {"call_id": call, "name": "PowerShell", "args": {"command": "echo %d" % i}, "status": "completed", "input": {"command": "echo %d" % i}, "output": "output %d" % i}, call)
    add("text", "left", {"content": "reply of turn %d. " % (i + 1) + FILLER})
add("text", "right", {"content": "What does the plan cover?"})
for text in texts:
    add("text", "left", {"content": text})
c.executemany("insert into messages (%s) values (%s)" % (",".join(mcols), ",".join("?" * len(mcols))), rows)
c.commit()
print("seeded", len(texts) + 1)
`;

async function ready(app) { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; }

(async () => {
  const stage = arg('--stage') || undefined;
  const first = await launch({ port: 9611, deadlineMs: 150000, stage, profile });
  try { await ready(first); await sleep(4000); } finally { await first.close(); }
  await sleep(2500);
  const seedFile = path.join(os.tmpdir(), 'aiondx-dollar-seed.py');
  fs.writeFileSync(seedFile, SEED);
  const r = spawnSync('py', ['-I', seedFile, path.join(profile, 'aionui', 'aiondx-backend.db'), JSON.stringify(TEXTS)], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  check('(setup) the replies were put in the profile', /seeded 5/.test(r.stdout || ''), (r.stdout || '') + (r.stderr || ''));

  const app = await launch({ port: 9612, deadlineMs: 600000, stage, profile, keepProfile: true });
  try {
    console.log('app ready: ' + await ready(app));
    await sleep(4000);
    // a page that stops answering must not hold the test until the app's deadline
    const js = (x) => Promise.race([app.js(x), sleep(20000).then(() => { throw new Error('the page did not answer in 20 s: ' + x.slice(0, 60)); })]);
    await js("(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()");
    // AionUi 2.2.2's message list can stop the page a few seconds after a chat opens in this harness (also seen in test-live-anchors.js), so the
    // wait for the replies runs inside the page, in one call, and hands back what it read the moment the last reply is drawn
    const got = await Promise.race([app.js(`new Promise((resolve) => {
      const read = () => {
        const out = [];
        const grab = (root) => { const t = (root.textContent || '').trim(); out.push({ t, k: root.querySelectorAll ? root.querySelectorAll('.katex').length : 0 }); };
        for (const host of document.querySelectorAll('*')) { if (host.shadowRoot) { const b = host.shadowRoot.querySelector('.markdown-shadow-body'); if (b) grab(b); } }
        for (const el of document.querySelectorAll('.markdown-shadow-body')) grab(el);
        return out;
      };
      location.hash = '#/conversation/${CID}';
      const t0 = Date.now();
      const tick = () => {
        const out = read();
        if (out.some((g) => g.t.indexOf('Written as maths') >= 0) || Date.now() - t0 > 60000) resolve(out); else setTimeout(tick, 250);
      };
      tick();
    })`), sleep(90000).then(() => { throw new Error('the page did not answer in 90 s'); })]);
    const find = (needle) => (got || []).find((g) => g.t.indexOf(needle) >= 0);
    const a = find('general limits');
    check('"$1M/$2M" is shown as written and draws no formula', a && a.t.indexOf('$1M/$2M general limits') >= 0 && a.k === 0, JSON.stringify(a));
    const b = find('a placeholder');
    check('"$40,000 ... $12,500" is shown as written, spaces kept, no formula', b && b.t.indexOf('$40,000, a placeholder') >= 0 && b.t.indexOf('$12,500') >= 0 && b.k === 0, JSON.stringify(b));
    const c3 = find('add-on');
    check('"($30) ... a $40,000 add-on ($120)" is shown as written, no formula', c3 && c3.t.indexOf('fee ($30), a form to sign') >= 0 && c3.t.indexOf('$40,000 add-on ($120)') >= 0 && c3.k === 0, JSON.stringify(c3));
    const d = find('Written as maths');
    check('maths with two dollar signs is still drawn as a formula', d && d.k >= 1, JSON.stringify(d));
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
    try {
      const seen = await Promise.race([app.js("document.body.innerText.slice(0, 500).replace(/\\s+/g, ' ')"), sleep(5000).then(() => 'no answer')]);
      console.log('   page shows: ' + seen);
      const shot = await Promise.race([app.send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)]);
      if (shot && shot.result && shot.result.data) { fs.writeFileSync(path.join(os.tmpdir(), 'aiondx-dollar-fail.png'), Buffer.from(shot.result.data, 'base64')); console.log('   screenshot: ' + path.join(os.tmpdir(), 'aiondx-dollar-fail.png')); }
    } catch (x) { /* nothing more to learn */ }
  } finally { await app.close(); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(path.join(os.tmpdir(), 'aiondx-dollar-seed.py'), { force: true }); } catch (e) { /* in use */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
