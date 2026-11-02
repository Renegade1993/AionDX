#!/usr/bin/env node
/**
 * test-live-context.js - the context ring in the real built app, on a hidden desktop and a throwaway profile.
 * A team of two members and a solo chat are put in the profile's database, each with the usage record AionCore keeps for a chat that has run
 * (acp_session.session_config.runtime.context_usage: used and size) and no agent running. Opening them after a restart must show the ring with
 * its reading for every one: a team's members as well as the solo chat. (2026-11-02: teams opened without starting their agents had no ring,
 * because the page looked for the count in a field AionCore never writes.)
 *
 *   node tools/test-live-context.js [--stage DIR]
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
const profile = path.join(os.tmpdir(), 'aiondx-context-profile');
const TEAM = 'context-test-team', SOLO = 'context-test-solo';
const SLOTS = ['ctx-slot-lead', 'ctx-slot-mate'];
const MEMBER_CONV = ['ctxlead1', 'ctxmate1'];
// used / window for: the two members, the solo chat
const USAGE = [[50000, 200000], [900000, 1000000], [100000, 200000]];

const SEED = `
import json, os, sqlite3, sys, time
db = sys.argv[1]
c = sqlite3.connect(db, timeout=60)
uid = c.execute("select id from users where id not like 'system%' order by created_at limit 1").fetchone()[0]
now = int(time.time() * 1000)
team, solo = ${JSON.stringify(TEAM)}, ${JSON.stringify(SOLO)}
slots, convs, usage = ${JSON.stringify(SLOTS)}, ${JSON.stringify(MEMBER_CONV)}, ${JSON.stringify(USAGE)}
ws = os.environ["TEMP"]
cols = [r[1] for r in c.execute("pragma table_info(conversations)")]
mcols = [r[1] for r in c.execute("pragma table_info(messages)")]
def conv(cid, name, extra):
    row = {k: None for k in cols}
    row.update({"id": cid, "user_id": uid, "name": name, "type": "acp", "extra": json.dumps(extra), "status": "finished", "source": "aionui", "pinned": 0,
                "created_at": now - 10**7, "updated_at": now - 10**6, "name_source": "user"})
    c.execute("insert into conversations (%s) values (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values()))
n = 0
t = now - 10**7
def msgs(cid):
    global n, t
    for i in range(30):
        for kind, pos, content in (("text", "right", {"content": "question %d" % i}), ("text", "left", {"content": "answer %d. " % i + "Nothing else to report here. " * 6})):
            n += 1; t += 1000
            r = {k: None for k in mcols}
            r.update({"id": "m%06d" % n, "conversation_id": cid, "msg_id": "mid%06d" % n, "type": kind, "content": json.dumps(content), "position": pos, "status": "finish", "hidden": 0, "created_at": t})
            c.execute("insert into messages (%s) values (%s)" % (",".join(mcols), ",".join("?" * len(mcols))), tuple(r[k] for k in mcols))
def session(cid, used, size):
    cfg = {"runtime": {"context_usage": {"used": used, "size": size}}}
    c.execute("insert or replace into acp_session (conversation_id, agent_source, agent_id, session_id, session_status, session_config, last_active_at) values (?,?,?,?,?,?,?)",
              (cid, "builtin", "claude", None, "idle", json.dumps(cfg), now - 10**6))
agents = []
for i in range(2):
    conv(convs[i], "CTX MEMBER %d" % i, {"backend": "claude", "agent_id": "ctx-agent", "workspace": ws, "teamId": team, "slot_id": slots[i], "role": "lead" if i == 0 else "teammate"})
    msgs(convs[i]); session(convs[i], *usage[i])
    agents.append({"slot_id": slots[i], "name": "Member %d" % i, "role": "lead" if i == 0 else "teammate", "conversation_id": convs[i], "backend": "claude", "model": "", "assistant_id": ""})
c.execute("insert into teams (id, user_id, name, workspace, workspace_mode, agents, lead_agent_id, agents_version, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)",
          (team, uid, "CTX TEAM", ws, "shared", json.dumps(agents), slots[0], "1.0.1", now - 10**7, now - 10**6))
conv(solo, "CTX SOLO", {"backend": "claude", "agent_id": "ctx-agent", "workspace": ws})
msgs(solo); session(solo, *usage[2])
# the Claude account reading the launcher records (the usage meter), for the lead only: the other member and the solo chat have no record of
# their own and run on the same agent
acct = {"label": "test account", "at": now, "status": "allowed", "five_hour": {"u": 0.4, "reset": int(now / 1000) + 3600, "status": "allowed"}, "seven_day": {"u": 0.2, "reset": int(now / 1000) + 86400, "status": "allowed"}}
for key, val in (("aiondx.usage.acct.ctxacct", acct), ("aiondx.usage.conv." + convs[0], {"acct": "ctxacct", "at": now})):
    c.execute("insert or replace into client_preferences (user_id, key, value, updated_at) values (?,?,?,?)", (uid, key, json.dumps(val), now))
c.commit()
print("seeded", n)
`;

async function ready(app) { for (let i = 0; i < 120; i++) { const st = await app.js('({ port: window.__backendPort || null })'); if (st && st.port) return true; await sleep(1000); } return false; }

// one call inside the page: opens the route, waits for the rings to be drawn, hands back what each one says
const READ = (hash, want) => `new Promise((resolve) => {
  const isTeam = ${hash.indexOf('#/team/') === 0};
  const read = () => {
    const out = [];
    const slots = Array.from(document.querySelectorAll('[data-slot-id]'));
    if (!isTeam && slots.length) return out;      // still the team page: the chat has not been drawn yet
    const boxes = isTeam ? slots : [document];
    for (const b of boxes) {
      const ind = b.querySelector('.sendbox-actions .context-usage-indicator');
      if (!ind) { out.push(null); continue; }
      const arc = ind.querySelectorAll('circle')[1];
      const off = arc ? Number(arc.getAttribute('stroke-dashoffset')) : NaN;
      const circ = arc ? Number(arc.getAttribute('stroke-dasharray')) || 56.5487 : 56.5487;
      out.push({ meter: !!b.querySelector('[data-testid="aiondx-usage"]'), title: ind.title || '', pct: isNaN(off) ? null : Math.round((1 - off / circ) * 100), ours: ind.classList.contains('aiondx-ctx'), slot: b.getAttribute && b.getAttribute('data-slot-id') });
    }
    return out;
  };
  location.hash = ${JSON.stringify(hash)};
  const t0 = Date.now();
  const tick = () => {
    const out = read();
    if ((out.length >= ${want} && out.every((x) => x && x.pct !== null && x.pct > 0 && x.meter)) || Date.now() - t0 > 45000) resolve(out); else setTimeout(tick, 300);
  };
  tick();
})`;

(async () => {
  const stage = arg('--stage') || undefined;
  const first = await launch({ port: 9621, deadlineMs: 150000, stage, profile });
  try { await ready(first); await sleep(4000); } finally { await first.close(); }
  await sleep(2500);
  const seedFile = path.join(os.tmpdir(), 'aiondx-context-seed.py');
  fs.writeFileSync(seedFile, SEED);
  const r = spawnSync('py', ['-I', seedFile, path.join(profile, 'aionui', 'aiondx-backend.db')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  check('(setup) the team, the solo chat and their usage records were put in the profile', /seeded 180/.test(r.stdout || ''), (r.stdout || '') + (r.stderr || ''));

  const app = await launch({ port: 9622, deadlineMs: 600000, stage, profile, keepProfile: true });
  try {
    await ready(app);
    await sleep(4000);
    // --page FILE: the real app running an edited page script without a rebuild
    if (arg('--page')) { await app.overrideScript('aiondx-ui.js', arg('--page')); await sleep(6000); }
    await app.js("(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()");
    const wait = (p) => Promise.race([p, sleep(90000).then(() => { throw new Error('the page did not answer in 90 s'); })]);
    const team = await wait(app.js(READ('#/team/' + TEAM, 2)));
    check('the team page draws a ring for each of its two members', Array.isArray(team) && team.length === 2 && team.every(Boolean), JSON.stringify(team));
    if (Array.isArray(team) && team.length === 2 && team.every(Boolean)) {
      const bySlot = {}; team.forEach((x) => { bySlot[x.slot] = x; });
      const a = bySlot[SLOTS[0]], b = bySlot[SLOTS[1]];
      check('the first member reads 25% (50K of 200K)', a && Math.abs(a.pct - 25) <= 1, JSON.stringify(a));
      check('the second member reads 90% (900K of 1000K)', b && Math.abs(b.pct - 90) <= 1, JSON.stringify(b));
      check('both members show the account usage meter, though only the first has a record of its own', a && b && a.meter && b.meter, JSON.stringify({ first: a && a.meter, second: b && b.meter }));
    }
    const solo = await wait(app.js(READ('#/conversation/' + SOLO, 1)));
    check('a solo chat that has run draws its ring at 50% (100K of 200K)', Array.isArray(solo) && solo[0] && Math.abs(solo[0].pct - 50) <= 1, JSON.stringify(solo));
    check('and the account usage meter, from the agent it shares with the team', Array.isArray(solo) && solo[0] && solo[0].meter, JSON.stringify(solo));
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
  } finally { await app.close(); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(path.join(os.tmpdir(), 'aiondx-context-seed.py'), { force: true }); } catch (e) { /* in use */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
