#!/usr/bin/env node
/**
 * click-test.js - behavior tests for patch 0001's Loop, driven with REAL mouse input.
 *
 * WHY REAL INPUT
 * The first harness only took screenshots and opened the menu with a scripted `.click()`. A
 * scripted click fires on the element directly, so it cannot catch a menu that rebuilds itself
 * between mouse-down and mouse-up. That bug shipped on 2026-09-22 (a request). A browser only fires `click` when press and release land on the same element, which is
 * what these tests reproduce, holding the button 120 ms the way a person does.
 *
 * WHAT IT CHECKS, against tools\dx-harness\harness.html and its stub backend
 *   toggle-light, toggle-dark  the menu opens, is not rebuilding itself, and "On" takes
 *   solo-fire                  once on and idle, it POSTs the continue message to the
 *                              conversation; pressing send in the box leaves it on (2026-09-24)
 *   team                       one pill per member column; arming one member leaves the other
 *                              alone; it sends through /api/teams/{id}/agents/{slot}/messages,
 *                              never straight to a conversation; it will not fire for a member
 *                              that is running; it does not fire twice inside 60 s; pressing
 *                              send in a member's box leaves its loop on and makes it wait
 *   user-send                  an unsent draft holds it; after your own message it waits a
 *                              minute past the reply, then carries on
 *   why                        the menu and the hover card say why it is not sending
 *   agent-state                green dot while the agent works (the icon spins only when the
 *                              OS allows motion), red when paused or blocked, none when idle
 *   permission                 the Permission pill is a 28 x 28 circle with the shield, a hover
 *                              card and an aria-label; label and caret hidden
 *   column-scroll              clicking into a member's box does not scroll the team page; the
 *                              arrow still does
 *   background                 a member whose page is not open is still ticked (2026-09-23)
 *   paused, lead-last,         a paused member is resumed on schedule, the stated reset time
 *   team-gap, stated-reset     wins, teammates go before the lead, one send per team per 2 min
 *   solo-error                 a failed solo turn waits instead of re-sending every minute
 *   look-light, look-dark      a round 28 x 28 icon button per column and in solo chats; grey off,
 *                              primary on, amber while holding back
 *   explainer                  the hover explainer: delay, wording per chat kind, rules, colours,
 *                              status, placement, AionUi's tooltip look, closes on leave and click
 *   working                    nothing is sent while a member is running, queued, starting, or
 *                              idle with work queued
 *   nudge-backoff              a short reply (nothing to do) stretches the next wait: 2, 5 min;
 *                              a real stretch of work resets it
 *
 *   node tools\dx-harness\click-test.js          run everything, exit 0 only if all pass
 *
 *   keep-warm                  (since 2026-09-25) after short replies the next nudge comes 2, then 4 min
 *                              after the agent's last message; a cold agent is never woken; the Loop
 *                              rests after the hold and carries on once the agent works again
 *   resume-at                  (since 2026-09-26) a resume time from the Loop tool or the menu: holding
 *                              nudges until then, warm past the hold when near, a rest when far, one
 *                              resume nudge at the time (even to a cold agent), Clear, and Off clears it
 *   cold-start, claude-gap     a Loop left on is not woken cold after a restart; Claude members go
 *                              20 s apart, not 2 min
 *   stop-phrase                "time to stop work" to the lead switches off the team's Loops; to a
 *                              member, that member's; "don't stop" does nothing
 *   unsend                     an Unread message in a Claude chat gets Unsend; the request goes to the
 *                              store by msg_id; the router's answer strikes it through, or says too late
 *   notices                    every Loop notice names its team and member or its chat, and a click
 *                              opens it
 *   agent                      the chat's agent (2026-09-26, replacing the account pill): the new-chat
 *                              list; left of the model picker, a bare icon in team columns; a Claude
 *                              switch in place, any other agent as a new chat holding the conversation
 *   respond-now                the tick box in each message box and the bolt on a queued message: a
 *                              busy agent's turn is stopped (solo), a member is interrupted, the lead
 *                              stopped through its run
 *   welcome                    the first-run screen: Antigravity sign-in, the setup brief for another
 *                              agent, Not now, reopening it from Settings
 *   usage                      the Claude usage meter: 5-hour and weekly bars left of the agent control,
 *                              bars alone in a team column, a stale reading hidden; in a team's single view
 *                              (no member column) the member in front has its meter, in full
 *   undo                       (since 2026-10-02) Ctrl+Z and Ctrl+Y in the message box: a typed burst is one step,
 *                              a pause makes a new one, what the page itself changed is not undone into
 *   bubbles                    (since 2026-09-26) chat colours: rows told apart (yours, Loop, agent-to-agent,
 *                              an agent's reply), dark and light sets, text readable in the Markdown shadow
 *                              root, the right-click menu and its jump to the control in Settings, the
 *                              Settings rows, and a team member's colour on its replies, messages, column, name
 *   mcp                        (since 2026-09-26) an agent's MCP change announced with its name; an On/Off switch
 *                              per server in Settings > Tools that reads the state before toggling
 *   drafts                     what you type is kept locally and in the settings store; it comes back
 *                              after a restart and goes once sent (2026-09-26)
 *   backgrounds                a dark and a light background colour, applied at once, stored, reset
 *
 * One headless Edge on a throwaway profile, DevTools protocol on a local port. Hard 600 s deadline;
 * Edge is killed on every exit path.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const BASE = 'file:///C:/AI%20Projects/AionDX/tools/dx-harness/harness.html';
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-edge-profile-cdp');
const SHOTS = path.join(__dirname, 'shots');
const DEFAULT_MSG = 'CONTINUE WORKING. Re-check the project plan and queue files, take the next unfinished item, and keep going until the user interrupts.';
const LOOP_TAG = '[AionDX Loop: sent automatically, not typed by the user] ';
const NUDGE = LOOP_TAG + DEFAULT_MSG;   // what a Loop nudge sends since 2026-09-25

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--window-size=1100,640', `${BASE}?theme=light`,
], { windowsHide: true, stdio: 'ignore' });

function finish(code, msg) {
  if (msg) console.log(msg);
  try { edge.kill(); } catch { /* already gone */ }
  process.exit(code);
}
const deadline = setTimeout(() => finish(2, "DEADLINE: suite did not finish within 900 s"), 900000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('harness.html'));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools target never appeared');
}

(async () => {
  const results = [];
  const check = (scenario, name, ok, detail) => results.push({ scenario, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  try {
    const target = await pageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const waiting = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const centerOf = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const humanClick = async (sel) => {
      const p = await centerOf(sel);
      if (!p) throw new Error(`nothing to click at ${sel}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(120);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(350);
    };
    const rightClick = async (sel) => {
      const p = await centerOf(sel);
      if (!p) throw new Error(`nothing to right-click at ${sel}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', clickCount: 1 });
      await sleep(80);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', clickCount: 1 });
      await sleep(300);
    };
    const load = async (query) => {
      await send('Page.navigate', { url: `${BASE}?${query}` });
      await sleep(1600);
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      if (s.result && s.result.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(s.result.data, 'base64'));
    };
    // The button has no text since 2026-09-23; on/off is its aria-pressed. Kept in the old
    // "Loop · On" form so the checks below read the same.
    const label = (scope) => js(`(() => { const b = document.querySelector(${JSON.stringify(`${scope} .aiondx-loop button`)});
      return b ? (b.getAttribute('aria-pressed') === 'true' ? 'Loop · On' : 'Loop · Off') : undefined; })()`);
    const loopState = (scope) => js(`(document.querySelector(${JSON.stringify(`${scope} [data-testid="aiondx-loop"]`)}) || {}).dataset.state`);
    // The hover explainer, driven by real mouse moves: onto the button and past the 350 ms delay,
    // or away to an empty corner.
    const hover = async (sel, waitMs = 600) => {
      const p = await centerOf(sel);
      if (!p) throw new Error(`nothing to hover at ${sel}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await sleep(waitMs);
    };
    const unhover = async () => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(250); };
    const tipInfo = () => js(`(() => { const t = document.querySelector('.aiondx-tip'); if (!t) return null;
      const q = (s) => (t.querySelector(s) || {}).textContent || '';
      return { title: q('.aiondx-tip-title'), agent: q('.aiondx-tip-agent'), body: q('.aiondx-tip-body'), points: [...t.querySelectorAll('.aiondx-tip-list li')].map(li => li.textContent),
        legend: q('.aiondx-tip-legend'), legend2: q('.aiondx-tip-legend2'), now: q('.aiondx-tip-now'), foot: q('.aiondx-tip-foot'), text: t.textContent }; })()`);
    const posts = (pathPrefix) => js(`window.__calls.filter(c => c.method === 'POST' && c.path.indexOf(${JSON.stringify(pathPrefix)}) === 0)`);
    const typeInto = async (sel, text) => { await humanClick(sel); await send('Input.insertText', { text }); await sleep(120); };
    const pressEnter = async () => {
      const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, k));
      await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
      await sleep(200);
    };
    const armVia = async (scope) => {
      await humanClick(`${scope} .aiondx-loop button`);
      await humanClick('.aiondx-menu .arco-dropdown-menu-item');   // first item is "On"
    };

    // ---- toggle, both themes ----
    for (const theme of ['light', 'dark']) {
      const sc = `toggle-${theme}`;
      await load(`theme=${theme}`);
      await humanClick('.aiondx-loop button');
      check(sc, 'menu opens on a real click', await js('!!document.querySelector(".aiondx-menu")'));
      await js('window.__probe = document.querySelector(".aiondx-menu .arco-dropdown-menu-item"); 0');
      await sleep(500);
      check(sc, 'open menu is not rebuilding itself', await js('document.contains(window.__probe)'));
      await humanClick('.aiondx-menu .arco-dropdown-menu-item');
      const l = await label('');
      check(sc, 'clicking On turns it on', l === 'Loop · On', l);
      check(sc, 'menu closes after the choice', await js('!document.querySelector(".aiondx-menu")'));
      await shot(`click-test-${theme}`);
    }

    // ---- solo fire ----
    {
      const sc = 'solo-fire';
      await load('theme=light');
      await armVia('');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const p = await posts('/api/conversations/harness1/messages');
      check(sc, 'posts the continue message to the conversation', p.length === 1 && p[0].body && p[0].body.content === NUDGE, JSON.stringify(p));
      const st = await js('JSON.parse(localStorage.getItem("aionui.dx.harness1"))');
      check(sc, 'records the send', st && st.fires === 1, st && st.fires);
      await humanClick('[data-testid="sendbox-send-btn"]');
      const l = await label('');
      check(sc, 'pressing send in the box keeps it on (since 2026-09-24)', l === 'Loop · On', l);
      const st2 = await js('JSON.parse(localStorage.getItem("aionui.dx.harness1"))');
      check(sc, 'and notes your message so its next nudge waits for the reply', st2 && st2.userSentAt > 0 && st2.why === 'Waiting a minute after your message.', st2 && JSON.stringify([st2.userSentAt, st2.why]));
    }

    // ---- no-reply safety: 3 sends that draw no reply switch it off ----
    // The stub's history never gains a reply, so every send after the first counts as a stall.
    // lastFired is backdated between ticks to step past the 60 s minimum gap. The build before
    // this one lost the count on every send, so this safety could never trip.
    {
      const sc = 'no-reply';
      await load('theme=light');
      await armVia('');
      // Wrapped in a function: top-level `const` in Runtime.evaluate persists between calls, so a
      // second evaluation of a bare `const k = ...` throws and the backdate silently never happens.
      const backdate = '(() => { const k = "aionui.dx.harness1"; const s = JSON.parse(localStorage.getItem(k)); s.lastFired = Date.now() - 61000; localStorage.setItem(k, JSON.stringify(s)); return 0; })()';
      await js('window.__calls.length = 0; 0');
      for (let i = 0; i < 4; i++) {
        await js('window.__aionDx.tickNow()');
        if (i < 3) await js(backdate);
      }
      const sent = (await posts('/api/conversations/harness1/messages')).length;
      check(sc, 'sends 3 times with no reply, then stops', sent === 3, sent);
      const l = await label('');
      check(sc, 'turns itself off', l === 'Loop · Off', l);
      const st = await js('JSON.parse(localStorage.getItem("aionui.dx.harness1"))');
      check(sc, 'says why', st && /no reply after 3 sends/.test(st.offReason || ''), st && st.offReason);
    }

    // ---- team ----
    {
      const sc = 'team';
      await load('team=1&theme=light');
      const n = await js('document.querySelectorAll(".aiondx-loop").length');
      check(sc, 'one pill per member column', n === 2, n);
      await armVia('[data-slot-id="slotB"]');
      check(sc, 'arming the worker turns it on', (await label('[data-slot-id="slotB"]')) === 'Loop · On');
      check(sc, 'the lead is left alone', (await label('[data-slot-id="slotA"]')) === 'Loop · Off');

      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const toB = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'sends through the team runtime to the idle worker', toB.length === 1 && toB[0].body && toB[0].body.content === NUDGE, JSON.stringify(toB));
      check(sc, 'never posts straight into a conversation', (await posts('/api/conversations/')).length === 0);

      await armVia('[data-slot-id="slotA"]');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'does not fire for a member that is running', (await posts('/api/teams/team1/agents/slotA/messages')).length === 0);
      check(sc, 'does not fire the worker twice inside 60 s', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0);

      await humanClick('[data-slot-id="slotA"] [data-testid="sendbox-send-btn"]');
      check(sc, "sending in the lead's box keeps the lead's loop on", (await label('[data-slot-id="slotA"]')) === 'Loop · On');
      check(sc, "and leaves the worker's loop on", (await label('[data-slot-id="slotB"]')) === 'Loop · On');
      const spokeTo = (slot) => js(`(JSON.parse(localStorage.getItem('aionui.dx.team.team1.${slot}')) || {}).userSentAt || 0`);
      check(sc, "and marks only the lead's loop as spoken to", (await spokeTo('slotA')) > 0 && (await spokeTo('slotB')) === 0);
      await shot('click-test-team');
      await humanClick('[data-slot-id="slotB"] [data-testid="sendbox-send-btn"]');
      check(sc, "sending in the worker's box keeps the worker's loop on", (await label('[data-slot-id="slotB"]')) === 'Loop · On');
    }

    // ---- paused members, background ticking, failed solo turns (2026-09-23) ----
    // The stub's error tip is the shape the app stores for Devin's rate-limit failure.
    const RESUME_MEMBER = '[Loop] Resuming you after a pause.';
    const RESUME_LEAD = '[Loop] Resuming you after a pause. A provider limit or a failed turn stopped the team';
    const tipJs = (conv, msAgo) => `(() => { window.__stub.histories[${JSON.stringify(conv)}].push({ id: 'err' + Math.random(),
      position: 'left', type: 'tips', hidden: false, created_at: Date.now() - ${msAgo},
      content: { content: 'The selected Agent returned a non-standard protocol error', type: 'error', error: {
        message: 'The selected Agent returned a non-standard protocol error', code: 'USER_AGENT_PROTOCOL_ERROR',
        detail: 'Agent protocol error (code -32011): Connection error, send a message to continue retrying ({"cognition.ai/errorKind":"resource_exhausted","cognition.ai/retryable":true})' } } }); return 0; })()`;
    const setSlot = (slot, st) => js(`(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work
      .forEach(w => { if (w.slot_id === ${JSON.stringify(slot)}) w.state = ${JSON.stringify(st)}; }); return 0; })()`);
    const saved = (key) => js(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
    const age = (conv, msAgo) => js(`(() => { const h = window.__stub.histories[${JSON.stringify(conv)}];
      h.forEach(m => { if (m.type === 'tips') m.created_at = Date.now() - ${msAgo}; }); return 0; })()`);
    const backdateResume = (key, ms) => js(`(() => { const s = JSON.parse(localStorage.getItem(${JSON.stringify(key)}));
      s.lastResumeAt -= ${ms}; localStorage.setItem(${JSON.stringify(key)}, JSON.stringify(s));
      localStorage.setItem('aionui.dx.teamsend.team1', String(Number(localStorage.getItem('aionui.dx.teamsend.team1')) - ${ms})); return 0; })()`);
    const KEY_A = 'aionui.dx.team.team1.slotA', KEY_B = 'aionui.dx.team.team1.slotB';
    // The shared store and the notices at the top of the window.
    const store = () => js('JSON.parse(JSON.stringify(window.__stub.store))');
    const putStore = (k, v) => js(`(() => { window.__stub.store[${JSON.stringify(k)}] = ${JSON.stringify(v)}; return 0; })()`);
    // Each notice's text and note, without its first line (where it happened, since 2026-09-25).
    const toasts = () => js('[...document.querySelectorAll(".aiondx-toasts .aiondx-toast")].map(t => [...t.querySelectorAll(".aiondx-toast-text, .aiondx-toast-sub")].map(e => e.textContent).join(""))');
    const toastWheres = () => js('[...document.querySelectorAll(".aiondx-toasts .aiondx-toast")].map(t => ({ where: (t.querySelector(".aiondx-toast-where") || {}).textContent || "", href: t.getAttribute("data-href") || "" }))');
    const SOLO_KEY = 'aiondx.loop.conv.harness1';

    // A loop whose page is not open still runs.
    {
      const sc = 'background';
      await load('theme=light');   // solo page; the team is not on screen
      await js(`localStorage.setItem('${KEY_B}', JSON.stringify({ on: true })); 0`);
      // Its last message a minute old: its cache is warm.
      await js(`(() => { window.__stub.histories.convB.push({ id: 'b-warm', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 60000, content: { content: 'next item done' } }); return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const toB = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'ticks a team member whose page is not open', toB.length === 1 && toB[0].body.content === NUDGE, JSON.stringify(toB));
      check(sc, 'draws no pill for it', (await js('document.querySelectorAll(".aiondx-loop").length')) === 1);
    }

    // A paused member is resumed on schedule, not skipped.
    {
      const sc = 'paused';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotB"]');
      await setSlot('slotB', 'paused');
      await js(tipJs('convB', 5 * 60000));
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'waits while a rate limit is fresh (error 5 min old)', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0);
      let st = await saved(KEY_B);
      const want = Date.now() - 5 * 60000 + 20 * 60000;
      check(sc, 'schedules the first try 20 min after the error', st && Math.abs(st.nextRetryAt - want) < 5000, st && st.nextRetryAt - want);
      await humanClick('[data-slot-id="slotB"] .aiondx-loop button');
      const status = await js('(document.querySelector(".aiondx-status") || {}).textContent');
      check(sc, 'the menu says it is paused and when it will retry', /^On\. Paused by the team runtime, usually a provider limit\. Retry 1 of 10 at \d\d:\d\d\./.test(status || ''), status);
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');

      await age('convB', 21 * 60000);
      await js('window.__aionDx.tickNow()');
      let toB = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'resumes once the wait is over', toB.length === 1 && toB[0].body.content.indexOf(RESUME_MEMBER) === 0 && toB[0].body.content.endsWith(DEFAULT_MSG), JSON.stringify(toB));
      st = await saved(KEY_B);
      check(sc, 'counts the try', st && st.resumeAttempts === 1, st && st.resumeAttempts);

      await js('window.__aionDx.tickNow()');   // still paused: the resume hit a live limit
      check(sc, 'does not retry straight away', (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);
      await backdateResume(KEY_B, 11 * 60000);
      await js('window.__aionDx.tickNow()');
      toB = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'retries 10 min after the first try', toB.length === 2, toB.length);
      check(sc, 'loop stays on through the pause', (await label('[data-slot-id="slotB"]')) === 'Loop · On');
    }

    // With the lead and a teammate both paused, the teammate goes first.
    {
      const sc = 'lead-last';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotA"]');
      await armVia('[data-slot-id="slotB"]');
      await setSlot('slotA', 'paused');
      await setSlot('slotB', 'paused');
      await js(tipJs('convA', 25 * 60000));
      await js(tipJs('convB', 25 * 60000));
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'resumes the teammate', (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);
      check(sc, 'holds the lead back', (await posts('/api/teams/team1/agents/slotA/messages')).length === 0);
      await setSlot('slotB', 'running');
      await js('window.__aionDx.tickNow()');
      check(sc, 'keeps 2 min between resumes in one team', (await posts('/api/teams/team1/agents/slotA/messages')).length === 0);
      await js(`localStorage.setItem('aionui.dx.teamsend.team1', String(Date.now() - 130000)); 0`);
      await js('window.__aionDx.tickNow()');
      const toA = await posts('/api/teams/team1/agents/slotA/messages');
      check(sc, 'then resumes the lead, telling it to trust run-state', toA.length === 1 && toA[0].body.content.indexOf(RESUME_LEAD) === 0 && /run-state/.test(toA[0].body.content), JSON.stringify(toA));
    }

    // The button: round, icon only, 28 x 28 like the composer's other circle buttons, in every
    // chat; grey off, primary colour on, amber while holding back. (It was a labelled pill until
    // 2026-09-23; a request: too wide for team columns.)
    for (const theme of ['light', 'dark']) {
      const sc = `look-${theme}`;
      await load(`team=1&theme=${theme}`);
      const rects = await js(`[...document.querySelectorAll('.aiondx-loop button')].map(b => { const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), circle: b.classList.contains('arco-btn-shape-circle'), text: b.textContent.trim() }; })`);
      check(sc, 'one round 28 x 28 icon button per column, no text', rects.length === 2 && rects.every(r => r.w === 28 && r.h === 28 && r.circle && !r.text), JSON.stringify(rects));
      const first = await js(`(() => { const a = document.querySelector('[data-slot-id="slotB"] .sendbox-actions'); return a.firstElementChild.getAttribute('data-testid'); })()`);
      check(sc, 'sits first in the action row, before Permission', first === 'aiondx-loop', first);
      const colours = async () => js(`(() => { const probe = document.createElement('span'); document.body.appendChild(probe);
        probe.style.color = 'rgb(var(--primary-6))'; const primary = getComputedStyle(probe).color;
        probe.style.color = 'rgb(var(--warning-6))'; const warning = getComputedStyle(probe).color; probe.remove();
        const icon = (s) => getComputedStyle(document.querySelector(s + ' .aiondx-loop-icon')).color;
        const bg = (s) => getComputedStyle(document.querySelector(s + ' .aiondx-loop button')).backgroundColor;
        return { primary, warning, iconA: icon('[data-slot-id="slotA"]'), iconB: icon('[data-slot-id="slotB"]'), bgA: bg('[data-slot-id="slotA"]'), bgB: bg('[data-slot-id="slotB"]') }; })()`);
      await armVia('[data-slot-id="slotB"]');
      let c = await colours();
      check(sc, 'off: grey, and a different background from on', (await loopState('[data-slot-id="slotA"]')) === 'off' && c.iconA !== c.primary && c.bgA !== c.bgB, JSON.stringify(c));
      check(sc, 'on: primary colour', (await loopState('[data-slot-id="slotB"]')) === 'on' && c.iconB === c.primary, JSON.stringify(c));
      await hover('[data-slot-id="slotB"] .aiondx-loop button');
      const tipOn = await tipInfo();
      check(sc, 'hover explainer gives the status', tipOn && tipOn.title === 'Loop is on' && /^Now: /.test(tipOn.now), JSON.stringify(tipOn));
      await unhover();
      await js(`(() => { const k = 'aionui.dx.team.team1.slotB'; const s = JSON.parse(localStorage.getItem(k));
        s.nextRetryAt = Date.now() + 5 * 60000; delete s.why; localStorage.setItem(k, JSON.stringify(s)); window.__aionDx.repaint(); return 0; })()`);
      c = await colours();
      check(sc, 'holding back (a retry wait): amber', (await loopState('[data-slot-id="slotB"]')) === 'waiting' && c.iconB === c.warning, JSON.stringify(c));
      await hover('[data-slot-id="slotB"] .aiondx-loop button');
      const tipWait = await tipInfo();
      check(sc, 'hover explainer says why it waits', tipWait && tipWait.title === 'Loop is holding back' && /Retry 1 of 10 at \d\d:\d\d/.test(tipWait.now), JSON.stringify(tipWait));
      await unhover();
      // Its cache: a ring around the button, as full as the time it has left.
      await js(`(() => { const k = 'aionui.dx.team.team1.slotB'; const s = JSON.parse(localStorage.getItem(k));
        s.nextRetryAt = 0; s.lastAt = Date.now() - 60000; localStorage.setItem(k, JSON.stringify(s)); window.__aionDx.repaint(); return 0; })()`);
      const ring = await js(`(() => { const w = document.querySelector('[data-slot-id="slotB"] .aiondx-loop'); const b = getComputedStyle(w, '::before');
        return { warm: w.classList.contains('aiondx-loop--warm'), frac: Number(w.style.getPropertyValue('--aiondx-warm')), content: b.content, width: b.width }; })()`);
      check(sc, 'a warm agent: a ring showing the cache time left', ring.warm && Math.abs(ring.frac - 0.8) < 0.02 && ring.content !== 'none' && ring.width === '34px', JSON.stringify(ring));
      await hover('[data-slot-id="slotB"] .aiondx-loop button');
      const tipWarm = await js(`(document.querySelector('.aiondx-tip .aiondx-tip-cache') || {}).textContent`);
      check(sc, 'the hover card says until when its cache is warm', /^Cache: warm until \d\d:\d\d \(4\smin\)\.$/.test(tipWarm || ''), tipWarm);
      await unhover();
      // Resting: on, not nudging, a dashed ring.
      await js(`(() => { const k = 'aionui.dx.team.team1.slotB'; const s = JSON.parse(localStorage.getItem(k));
        s.lastAt = Date.now() - 400000; s.restingSince = Date.now() - 100000; s.restKind = 'cold'; delete s.why; localStorage.setItem(k, JSON.stringify(s)); window.__aionDx.repaint(); return 0; })()`);
      const rest = await js(`(() => { const b = document.querySelector('[data-slot-id="slotB"] .aiondx-loop button'); const w = b.parentNode;
        return { state: w.dataset.state, border: getComputedStyle(b).borderTopStyle, warm: w.classList.contains('aiondx-loop--warm') }; })()`);
      check(sc, 'resting: dashed, and no ring once the cache has run out', rest.state === 'resting' && rest.border === 'dashed' && !rest.warm, JSON.stringify(rest));
      await hover('[data-slot-id="slotB"] .aiondx-loop button');
      const tipRest = await tipInfo();
      check(sc, 'the hover card says it rests, and why', tipRest && tipRest.title === 'Loop is on, resting' && /Resting: its cache ran out at \d\d:\d\d, and the Loop does not wake a cold agent\./.test(tipRest.now), JSON.stringify(tipRest && [tipRest.title, tipRest.now]));
      await shot(`explainer-team-${theme}`);
      await unhover();
      await armVia('[data-slot-id="slotA"]');
      await shot(`look-team-${theme}`);
      await load(`theme=${theme}`);
      const solo = await js(`(() => { const r = document.querySelector('.aiondx-loop button').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()`);
      check(sc, 'same button in a solo chat', solo === '28x28', solo);
      await armVia('');
      await shot(`look-solo-${theme}`);
    }

    // The hover explainer: what the Loop does, its rules, the colours, the status.
    {
      const sc = 'explainer';
      await load('team=1&theme=light');
      check(sc, 'no native title tooltip to stack with it', (await js(`[...document.querySelectorAll('.aiondx-loop button')].every(b => !b.hasAttribute('title'))`)) === true);
      await hover('[data-slot-id="slotB"] .aiondx-loop button', 150);
      check(sc, 'does not flash open on a passing mouse (under 350 ms)', (await tipInfo()) === null);
      await sleep(450);
      const t = await tipInfo();
      check(sc, 'opens after the delay', !!t);
      check(sc, 'team wording: what it does', t && /^Keeps this team member working\. When it stops with nothing queued/.test(t.body), t && t.body);
      check(sc, 'lists its rules', t && t.points.length === 7 && /Never sends while it works or has work queued/.test(t.points[0])
        && /2, then 4\smin after its last message, inside the 5\smin cache window/.test(t.points[1])
        && /After 45\smin of short replies it rests and lets the cache expire/.test(t.points[2])
        && /never wakes an agent whose cache has run out/.test(t.points[3]) && /teammates first/.test(t.points[4])
        && /saying stop/.test(t.points[5]) && /after 3 nudges with no reply\. Runs on any page/.test(t.points[6]), t && JSON.stringify(t.points));
      check(sc, 'explains the loop colours, the ring and the agent dot', t && /Off/.test(t.legend) && /On/.test(t.legend) && /Holding back/.test(t.legend)
        && /Resting/.test(t.legend) && /Ring: cache time left/.test(t.legend)
        && /Agent dot/.test(t.legend2) && /Working/.test(t.legend2) && /Paused or blocked/.test(t.legend2), t && JSON.stringify([t.legend, t.legend2]));
      check(sc, "says what the agent is doing", t && /^Agent: /.test(t.agent), t && t.agent);
      check(sc, 'says how to change it', t && /^Click to switch it on or off, or edit the message\.$/.test(t.foot), t && t.foot);
      const geo = await js(`(() => { const r = document.querySelector('.aiondx-tip').getBoundingClientRect();
        const b = document.querySelector('[data-slot-id="slotB"] .aiondx-loop button').getBoundingClientRect();
        return { above: r.bottom <= b.top, fits: b.top - r.height - 8 >= 8, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })()`);
      check(sc, 'opens above the button when it fits, always inside the window', geo.above === geo.fits && geo.inside, JSON.stringify(geo));
      const look = await js(`getComputedStyle(document.querySelector('.aiondx-tip .arco-tooltip-content')).backgroundColor`);
      check(sc, "wears AionUi's tooltip colours (white card in light)", look === 'rgb(255, 255, 255)', look);
      await unhover();
      check(sc, 'closes when the mouse leaves', (await tipInfo()) === null);
      await hover('[data-slot-id="slotB"] .aiondx-loop button');
      await humanClick('[data-slot-id="slotB"] .aiondx-loop button');
      check(sc, 'a click opens the menu and closes the explainer', (await js('!!document.querySelector(".aiondx-menu")')) && (await tipInfo()) === null);
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
      await load('theme=light');
      await hover('.aiondx-loop button');
      const solo = await tipInfo();
      check(sc, 'solo wording: this chat, no team rules', solo && /^Keeps this chat working\. When a turn ends/.test(solo.body) && !/lead|Teammates/.test(solo.text) && /rate-limit failure it waits for the reset/.test(solo.points[4]), solo && JSON.stringify(solo));
      check(sc, 'off: title says so, and no status line repeating it', solo && solo.title === 'Loop is off' && solo.now === '', solo && JSON.stringify([solo.title, solo.now]));
      await shot('explainer-solo-light');
      await unhover();
      // Switched itself off (3 sends with no reply): the explainer says why.
      await armVia('');
      await js(`(() => { const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k)); s.on = false; s.offReason = 'no reply after 3 sends';
        localStorage.setItem(k, JSON.stringify(s)); window.__aionDx.repaint(); return 0; })()`);
      await hover('.aiondx-loop button');
      const why = await tipInfo();
      check(sc, 'after switching itself off, it says why', why && why.now === 'Switched off: no reply after 3 sends.', why && why.now);
      await unhover();
    }

    // Your own messages keep the loop on; it holds back for a draft and waits after the reply.
    {
      const sc = 'user-send';
      await load('theme=light');
      await armVia('');
      await js('window.__calls.length = 0; 0');
      await js(`(() => { document.querySelector('[data-testid="sendbox-input"]').value = 'half-written thought'; return 0; })()`);
      await js('window.__aionDx.tickNow()');
      let st = await saved('aionui.dx.harness1');
      check(sc, 'holds back while you have a draft in the box', (await posts('/api/conversations/harness1/messages')).length === 0 && st.why === 'Holding: you have an unsent draft in this box.', st && st.why);
      await js(`(() => { document.querySelector('[data-testid="sendbox-input"]').value = ''; return 0; })()`);
      await humanClick('[data-testid="sendbox-send-btn"]');
      await js(`(() => { const h = window.__stub.histories.harness1;
        h.push({ id: 'u1', position: 'right', type: 'text', hidden: false, created_at: Date.now() - 40000, content: { content: 'check the siege margins' } });
        h.push({ id: 'r1', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 30000, content: { content: 'Checked; margins fixed.' } });
        return 0; })()`);
      await js('window.__aionDx.tickNow()');
      st = await saved('aionui.dx.harness1');
      check(sc, 'after your message it stays on and waits a minute past the reply', st.on && (await posts('/api/conversations/harness1/messages')).length === 0 && st.why === 'Waiting a minute after your message.', st && JSON.stringify([st.on, st.why]));
      await js(`(() => { const h = window.__stub.histories.harness1;
        h.forEach(m => { if (m.id === 'u1') m.created_at = Date.now() - 95000; if (m.id === 'r1') m.created_at = Date.now() - 70000; });
        const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k)); s.userSentAt = Date.now() - 95000; localStorage.setItem(k, JSON.stringify(s)); return 0; })()`);
      await js('window.__aionDx.tickNow()');
      const p = await posts('/api/conversations/harness1/messages');
      check(sc, 'then carries on', p.length === 1 && p[0].body.content === NUDGE, JSON.stringify(p));
    }

    // Every check records why it did not send, and the hover card shows it.
    {
      const sc = 'why';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotA"]');   // the lead, "running" in the stub
      await js('window.__aionDx.tickNow()');
      let st = await saved('aionui.dx.team.team1.slotA');
      check(sc, 'working: says so', st && st.why === 'Not sending: it is working.', st && st.why);
      await setSlot('slotA', 'idle');
      await js(`(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work[0].queued_background_count = 3; return 0; })()`);
      await js('window.__aionDx.tickNow()');
      st = await saved('aionui.dx.team.team1.slotA');
      check(sc, 'queued work: says how much', st && st.why === 'Not sending: it has 3 queued items.', st && st.why);
      await hover('[data-slot-id="slotA"] .aiondx-loop button');
      const t = await tipInfo();
      check(sc, 'the hover card shows the reason', t && t.now === 'Now: Not sending: it has 3 queued items.', t && t.now);
      await unhover();
    }

    // The agent's own state, from the backend: the icon turns while it works, a red dot when paused.
    {
      const sc = 'agent-state';
      await load('team=1&theme=light');
      await js('window.__aionDx.pulseNow()');
      const spin = (sel) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel + ' .aiondx-loop-icon svg')})).animationName`);
      const dotOf = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel + ' .aiondx-loop button')}); const a = getComputedStyle(b, '::after');
        const probe = document.createElement('span'); document.body.appendChild(probe);
        probe.style.color = 'rgb(var(--success-6))'; const green = getComputedStyle(probe).color;
        probe.style.color = 'rgb(var(--danger-6))'; const red = getComputedStyle(probe).color; probe.remove();
        return { bg: a.backgroundColor, content: a.content, green, red }; })()`);
      // The developer's Windows has animations off, which Chromium reports as reduce-motion; headless Edge does too.
      const reduced = await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
      let d = await dotOf('[data-slot-id="slotA"]');
      check(sc, 'a working member: green dot, with animations off', reduced === true && d.content !== 'none' && d.bg === d.green, JSON.stringify(d));
      check(sc, 'and no turning icon while animations are off', (await spin('[data-slot-id="slotA"]')) === 'none');
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      check(sc, 'with animations on, the icon turns as well', (await spin('[data-slot-id="slotA"]')) === 'aiondx-spin');
      await send('Emulation.setEmulatedMedia', { features: [] });
      d = await dotOf('[data-slot-id="slotB"]');
      check(sc, 'an idle member: no dot', d.content === 'none', JSON.stringify(d));
      await setSlot('slotB', 'paused');
      await js('window.__aionDx.pulseNow()');
      d = await dotOf('[data-slot-id="slotB"]');
      check(sc, 'a paused member: red dot', d.bg === d.red && d.content !== 'none', JSON.stringify(d));
      await hover('[data-slot-id="slotB"] .aiondx-loop button');
      const t = await tipInfo();
      check(sc, 'the hover card names the agent state', t && t.agent === 'Agent: paused by the team runtime, usually a provider limit.', t && t.agent);
      await unhover();
      await shot('agent-state-team-light');
      await load('theme=light');
      await js(`(() => { window.__stub.routes['GET /api/conversations/harness1'].data.status = 'running'; return 0; })()`);
      await js('window.__aionDx.pulseNow()');
      d = await dotOf('');
      check(sc, 'a solo chat the backend calls running: green dot', d.bg === d.green && d.content !== 'none', JSON.stringify(d));
      await js(`(() => { window.__stub.routes['GET /api/conversations/harness1'].data.status = 'finished';
        window.__stub.histories.harness1.push({ id: 'fresh', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 1000, content: { content: 'still printing' } }); return 0; })()`);
      await js('window.__aionDx.pulseNow()');
      const fresh = await js(`window.__aionDx.agent('conv:harness1')`);
      check(sc, 'status finished but output a second old: still counts as working', fresh && fresh.state === 'working', JSON.stringify(fresh));
    }

    // The Permission pill: AionUi's own button, shrunk to its shield, with a hover card.
    {
      const sc = 'permission';
      await load('theme=light');
      const g = await js(`(() => { const b = document.querySelector('[data-testid="mode-selector"] button'); const r = b.getBoundingClientRect();
        const vis = (s) => { const e = b.querySelector(s); return e ? getComputedStyle(e).display !== 'none' : null; };
        return { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(b).borderRadius, shield: vis('.i-icon-shield'), label: vis('span.overflow-hidden'), caret: vis('.i-icon-down') }; })()`);
      check(sc, 'a 28 x 28 circle', g.w === 28 && g.h === 28 && /50%/.test(g.radius), JSON.stringify(g));
      check(sc, 'shield shown, label and caret hidden', g.shield === true && g.label === false && g.caret === false, JSON.stringify(g));
      check(sc, 'named for screen readers', (await js(`document.querySelector('[data-testid="mode-selector"] button').getAttribute('aria-label')`)) === 'Permission: Bypass Permissions');
      await hover('[data-testid="mode-selector"] button');
      const t = await tipInfo();
      check(sc, 'hover card names the mode', t && t.title === 'Permission: Bypass Permissions' && /without asking you first/.test(t.body) && t.foot === 'Click to change it.', t && JSON.stringify(t));
      await shot('permission-light');
      await unhover();
      check(sc, 'closes when the mouse leaves', (await tipInfo()) === null);
    }

    // Clicking into a team member's box no longer scrolls its column to the far left.
    {
      const sc = 'column-scroll';
      await load('team=1&wide=1&theme=light');
      const before = await js(`document.getElementById('team-scroller').scrollLeft`);
      await humanClick('[data-slot-id="slotB"] [data-testid="sendbox-input"]');
      await sleep(300);
      const after = await js(`document.getElementById('team-scroller').scrollLeft`);
      check(sc, "clicking into a member's box leaves the view where it is", before === 0 && after === 0, JSON.stringify([before, after]));
      await humanClick('#next-arrow');
      await sleep(300);
      const arrowed = await js(`document.getElementById('team-scroller').scrollLeft`);
      check(sc, 'the side arrow still scrolls', arrowed > 0, arrowed);
    }

    // It never sends to a member that is working or has work queued.
    {
      const sc = 'working';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotB"]');
      await js('window.__calls.length = 0; 0');
      for (const st of ['running', 'queued', 'starting']) {
        await setSlot('slotB', st);
        await js('window.__aionDx.tickNow()');
      }
      await setSlot('slotB', 'idle');
      await js(`(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work[1].queued_background_count = 2; return 0; })()`);
      await js('window.__aionDx.tickNow()');
      check(sc, 'nothing sent while running, queued, starting, or idle with work queued', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0);
    }

    // The cache window (2026-09-25). After a short reply (the agent is waiting on something) the
    // next nudge comes 2, then 4 min after the agent's own last message, always inside Anthropic's
    // 5 min cache window; a cold agent is never woken; after the hold the Loop rests.
    {
      const sc = 'keep-warm';
      await load('theme=light');
      await armVia('');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'switched on for a cold agent, the first nudge goes out (someone asked for it)', (await posts('/api/conversations/harness1/messages')).length === 1);
      // The nudge landed firedAgo ms ago and the agent answered replyAgo ms ago ("still waiting").
      const shortReply = (firedAgoMs, replyAgoMs) => js(`(() => { const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k));
        s.lastFired = Date.now() - ${firedAgoMs}; localStorage.setItem(k, JSON.stringify(s));
        const h = window.__stub.histories.harness1; const nudge = h.filter(m => m.position === 'right').pop(); if (nudge) nudge.created_at = s.lastFired;
        h.push({ id: 'r' + Math.random(), position: 'left', type: 'text', hidden: false, created_at: Date.now() - ${replyAgoMs}, content: { content: 'Tournament still running; nothing to do yet.' } }); return 0; })()`);
      // Everything moves ms into the past: the history, the last nudge, the streak.
      const later = (ms) => js(`(() => { const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k));
        ['lastFired', 'shortSince', 'lastAt', 'onAt'].forEach(f => { if (s[f]) s[f] -= ${ms}; }); localStorage.setItem(k, JSON.stringify(s));
        window.__stub.histories.harness1.forEach(m => { m.created_at -= ${ms}; }); return 0; })()`);
      await shortReply(90000, 70000);
      await js('window.__aionDx.tickNow()');
      let st = await saved('aionui.dx.harness1');
      check(sc, 'after a short reply it waits 2 min from the reply, not 60 s', (await posts('/api/conversations/harness1/messages')).length === 1 && st.nudgeLevel === 1 &&
        Math.abs(st.nextNudgeAt - (Date.now() - 70000 + 120000)) < 5000, st && JSON.stringify([st.nudgeLevel, st.nextNudgeAt - Date.now()]));
      await humanClick('.aiondx-loop button');
      const status = await js('(document.querySelector(".aiondx-status") || {}).textContent');
      check(sc, 'the menu says when the next goes and until when the cache is warm', /Nothing to do after the last nudge\. The next goes at \d\d:\d\d, while its cache is still warm \(until \d\d:\d\d\)\./.test(status || '') &&
        /Cache: warm until \d\d:\d\d/.test(status || ''), status);
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
      await later(60000);
      await js('window.__aionDx.tickNow()');
      check(sc, 'second nudge 2 min after the reply', (await posts('/api/conversations/harness1/messages')).length === 2);
      await shortReply(90000, 70000);
      await js('window.__aionDx.tickNow()');
      st = await saved('aionui.dx.harness1');
      check(sc, 'another short reply: 4 min after it, still inside the window', st && st.nudgeLevel === 2 && (await posts('/api/conversations/harness1/messages')).length === 2 &&
        Math.abs(st.nextNudgeAt - (Date.now() - 70000 + 240000)) < 5000, st && JSON.stringify([st.nudgeLevel, st.nextNudgeAt - Date.now()]));
      await later(180000);
      await js('window.__aionDx.tickNow()');
      check(sc, 'third nudge 4 min after the reply', (await posts('/api/conversations/harness1/messages')).length === 3);
      st = await saved('aionui.dx.harness1');
      const pub = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loopstatus.conv.harness1'];
      check(sc, 'loop_status gets the cache window: last message, warm until, hold', pub && pub.lastAt > 0 && pub.warmUntil === pub.lastAt + 300000 && pub.holdMin === 45, JSON.stringify(pub));
      // The reply to the third nudge, then nothing for 4 min 50 s: past the window, so it rests.
      await shortReply(90000, 70000);
      await later(230000);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      st = await saved('aionui.dx.harness1');
      check(sc, 'a cold agent is never woken: no nudge, it rests', (await posts('/api/conversations/harness1/messages')).length === 0 && st.restingSince > 0 && st.restKind === 'cold' &&
        /^Resting: its cache ran out at \d\d:\d\d, and the Loop does not wake a cold agent\./.test(st.why), st && JSON.stringify([st.restingSince, st.restKind, st.why]));
      check(sc, 'the Loop stays on while it rests', (await label('')) === 'Loop · On' && (await loopState('')) === 'resting');
      await js('window.__aionDx.tickNow()');
      check(sc, 'and stays quiet', (await posts('/api/conversations/harness1/messages')).length === 0);
      // Someone else gives it work; it answers at length. The Loop carries on after that.
      await js(`(() => { const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k)); s.restingSince -= 200000; localStorage.setItem(k, JSON.stringify(s)); return 0; })()`);
      await js(`(() => { const h = window.__stub.histories.harness1;
        h.push({ id: 'u-k', position: 'right', type: 'text', hidden: false, created_at: Date.now() - 95000, content: { content: 'the tournament finished, read the results' } });
        h.push({ id: 'w-long', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 65000, content: { content: 'Read the results; R8 wins 18 of 30. Wrote the report.' } }); return 0; })()`);
      await js('window.__aionDx.tickNow()');
      st = await saved('aionui.dx.harness1');
      check(sc, 'once the agent works again it stops resting and nudges', !st.restingSince && (await posts('/api/conversations/harness1/messages')).length === 1, st && JSON.stringify([st.restingSince, st.why]));
      // The hold: 46 min of short replies, the cache still warm.
      await js(`(() => { const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k)); s.nudgeLevel = 2; s.shortSince = Date.now() - 46 * 60000;
        s.lastFired = Date.now() - 90000; s.nudgeScored = s.fires; localStorage.setItem(k, JSON.stringify(s));
        window.__stub.histories.harness1.push({ id: 'r-hold', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 70000, content: { content: 'still nothing' } }); return 0; })()`);
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      await sleep(300);
      st = await saved('aionui.dx.harness1');
      check(sc, 'after 45 min of short replies it rests (the hold)', (await posts('/api/conversations/harness1/messages')).length === 0 && st.restKind === 'hold' &&
        /^Resting: 45\smin of short replies, so it stopped keeping the cache warm \(warm until \d\d:\d\d\)\./.test(st.why), st && st.why);
      const tt = await toasts();
      const tw = await toastWheres();
      check(sc, 'and says so in a notice naming the chat', tt.length === 1 && /^Loop resting for this chat\.Resting: 45/.test(tt[0]) && tw[0].where === 'Chat: Harness' && tw[0].href === '#/conversation/harness1', JSON.stringify([tt, tw]));
      // The hold is a choice in the menu, and the tool sees it.
      await humanClick('.aiondx-loop button');
      await js(`(() => { const b = document.querySelector('.aiondx-menu .aiondx-hold-btn[data-hold="90"]'); b.scrollIntoView({ block: 'nearest' }); return 0; })()`);
      await humanClick('.aiondx-menu .aiondx-hold-btn[data-hold="90"]');
      st = await saved('aionui.dx.harness1');
      const rec = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loop.conv.harness1'];
      check(sc, 'the menu sets the hold to 90 min, marked, and writes it for the tool', st.holdMin === 90 && rec && rec.holdMin === 90 &&
        (await js(`document.querySelector('.aiondx-menu .aiondx-hold-btn[data-hold="90"]').getAttribute('aria-checked')`)) === 'true', JSON.stringify([st.holdMin, rec && rec.holdMin]));
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
    }

    // Resume at a set time (2026-09-26): a team lead, told to slow down until 12:10, answered each nudge
    // "Holding" and never resumed. Until the time the nudges say it is holding, the hold does not end them,
    // a far-off time lets the cache run out, one nudge goes at the time, and Off clears it.
    {
      const sc = 'resume-at';
      await load('theme=light');
      await armVia('');
      const LOOP_KEY = 'aionui.dx.harness1';
      const sent = async () => (await posts('/api/conversations/harness1/messages')).map((c) => String((c.body && c.body.content) || ''));
      const shortReply = (firedAgoMs, replyAgoMs) => js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}'));
        s.lastFired = Date.now() - ${firedAgoMs}; s.nudgeScored = s.fires; localStorage.setItem('${LOOP_KEY}', JSON.stringify(s));
        const h = window.__stub.histories.harness1; const nudge = h.filter(m => m.position === 'right').pop(); if (nudge) nudge.created_at = s.lastFired;
        h.push({ id: 'r' + Math.random(), position: 'left', type: 'text', hidden: false, created_at: Date.now() - ${replyAgoMs}, content: { content: 'Holding.' } }); return 0; })()`);
      const later = (ms) => js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}'));
        ['lastFired', 'shortSince', 'lastAt', 'onAt'].forEach(f => { if (s[f]) s[f] -= ${ms}; }); localStorage.setItem('${LOOP_KEY}', JSON.stringify(s));
        window.__stub.histories.harness1.forEach(m => { m.created_at -= ${ms}; }); return 0; })()`);
      const fromTool = (fields) => putStore('aiondx.loop.conv.harness1', Object.assign({ v: 1, on: true,
        msg: 'CONTINUE WORKING. Re-check the project plan and queue files, take the next unfinished item, and keep going until the user interrupts.',
        compactAt: 0, holdMin: 45, rev: 50, by: 'agent', who: 'Team Lead', 'for': '', at: Date.now() + 1000, note: 'holding for the new usage window',
        wakeMsg: 'Back to work: take the next item in your queue.', wakeBy: 'Team Lead' }, fields));
      await js('window.__aionDx.tickNow()');   // the first nudge after switching on
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      const wake1 = Date.now() + 20 * 60000;
      await fromTool({ wakeAt: wake1 });
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      let st = await saved(LOOP_KEY);
      check(sc, "the Loop tool's resume time reaches the Loop, with a notice naming who set it", st.wakeAt === wake1 && st.wakeBy === 'Team Lead' &&
        (await toasts()).some((t) => /Team Lead set it to resume at \d\d:\d\d/.test(t)), JSON.stringify([st.wakeAt - wake1, await toasts()]));
      await shortReply(100000, 90000);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, 'holding: the next keep-warm nudge waits 4 min from the reply', (await sent()).length === 0 &&
        /^Holding until \d\d:\d\d, the resume time\. The next keep-warm nudge goes at \d\d:\d\d/.test(st.why || ''), st.why);
      await later(160000);
      await js('window.__aionDx.tickNow()');
      let out = await sent();
      check(sc, 'the keep-warm nudge says it is holding, not "continue working"', out.length === 1 &&
        /^\[AionDX Loop[^\]]*\] Holding until \d\d:\d\d, the resume time Team Lead set\. Nothing to do before then/.test(out[0]), JSON.stringify(out));
      // 50 min of short replies: past the 45 min hold, and it keeps the cache warm anyway (18 min to go).
      await js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}')); s.nudgeLevel = 2; s.shortSince = Date.now() - 50 * 60000; localStorage.setItem('${LOOP_KEY}', JSON.stringify(s)); return 0; })()`);
      await shortReply(90000, 70000);
      await later(180000);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, 'a near resume time keeps the cache warm past the hold', (await sent()).length === 1 && st.restKind !== 'hold', JSON.stringify([st.restKind, st.why]));
      // The time comes, with the agent already cold and the Loop resting: the resume nudge goes all the same.
      await js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}')); s.wakeAt = Date.now() - 5000; s.restingSince = Date.now() - 60000; s.restKind = 'cold';
        s.lastFired = Date.now() - 20 * 60000; localStorage.setItem('${LOOP_KEY}', JSON.stringify(s));
        window.__stub.histories.harness1.forEach(m => { m.created_at = Math.min(m.created_at, Date.now() - 19 * 60000); }); return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      await sleep(300);
      out = await sent();
      st = await saved(LOOP_KEY);
      const rec = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loop.conv.harness1'];
      const pub = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loopstatus.conv.harness1'];
      check(sc, 'at the time, one nudge says so and gives the message, even to a cold, resting agent', out.length === 1 &&
        /^\[AionDX Loop[^\]]*\] It is \d\d:\d\d, the resume time Team Lead set\. Back to work: take the next item in your queue\.$/.test(out[0]), JSON.stringify(out));
      check(sc, 'once only: the time is cleared, for the tool too, and the status says when it resumed', !st.wakeAt && st.wokeAt > 0 && !st.restingSince &&
        rec && rec.wakeAt === 0 && pub && pub.wokeAt > 0, JSON.stringify([st.wakeAt, st.wokeAt, rec && rec.wakeAt, pub && pub.wokeAt]));
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'and does not go again', (await sent()).length === 0);
      // Two hours off: keeping the cache warm that long costs more than one reload, so it rests.
      await fromTool({ wakeAt: Date.now() + 120 * 60000, at: Date.now() + 2000 });
      await js('window.__aionDx.pullNow()');
      await shortReply(90000, 70000);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, 'a resume time 2 h off lets the cache run out', (await sent()).length === 0 && st.restKind === 'resume' &&
        /^Resting until \d\d:\d\d, the resume time: keeping the cache warm that long would cost more than one reload/.test(st.why || ''), JSON.stringify([st.restKind, st.why]));
      // The menu shows it and clears it; the owner sets one from the menu; Off clears it.
      await humanClick('.aiondx-loop button');
      await js(`(() => { document.querySelector('.aiondx-menu .aiondx-resume').scrollIntoView({ block: 'nearest' }); return 0; })()`);
      const note = await js('(document.querySelector(".aiondx-menu .aiondx-resume-note") || {}).textContent');
      check(sc, 'the menu says when it resumes and who set it', /^Resumes at \d\d:\d\d, set by Team Lead\.$/.test(note || ''), note);
      await humanClick('.aiondx-menu .aiondx-resume-clear');
      st = await saved(LOOP_KEY);
      let rec2 = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loop.conv.harness1'];
      check(sc, 'Clear removes it, for the tool too', !st.wakeAt && rec2 && rec2.wakeAt === 0 && st.restKind !== 'resume', JSON.stringify([st.wakeAt, rec2 && rec2.wakeAt, st.restKind]));
      const inHour = new Date(Date.now() + 60 * 60000);
      const hh = ('0' + inHour.getHours()).slice(-2) + ':' + ('0' + inHour.getMinutes()).slice(-2);
      await js(`(() => { const i = document.querySelector('.aiondx-menu .aiondx-resume-time'); i.value = '${hh}'; return 0; })()`);
      await humanClick('.aiondx-menu .aiondx-resume-set');
      st = await saved(LOOP_KEY);
      rec2 = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loop.conv.harness1'];
      check(sc, "The owner's own resume time from the menu, written for the tool", st.wakeAt > Date.now() + 58 * 60000 && st.wakeAt < Date.now() + 61 * 60000 &&
        st.wakeBy === 'the user' && rec2 && rec2.wakeAt === st.wakeAt && rec2.wakeBy === 'the user', JSON.stringify([st.wakeAt - Date.now(), rec2 && rec2.wakeBy]));
      await js(`(() => { document.querySelector('.aiondx-menu [data-choice="off"]').scrollIntoView({ block: 'nearest' }); return 0; })()`);
      await humanClick('.aiondx-menu [data-choice="off"]');
      st = await saved(LOOP_KEY);
      rec2 = (await js('JSON.parse(JSON.stringify(window.__stub.store))'))['aiondx.loop.conv.harness1'];
      check(sc, 'switching the Loop off clears the resume time', !st.on && !st.wakeAt && rec2 && rec2.on === false && rec2.wakeAt === 0, JSON.stringify([st.on, st.wakeAt, rec2 && rec2.wakeAt]));
    }

    // A Loop left on while AionUi was closed: its agent went cold, and nobody asked for a wake.
    {
      const sc = 'cold-start';
      await load('theme=light');
      await js(`localStorage.setItem('aionui.dx.harness1', JSON.stringify({ on: true, fires: 4, lastFired: Date.now() - 3600000 })); 0`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const st = await saved('aionui.dx.harness1');
      check(sc, 'a Loop found on after a restart does not wake a cold agent', (await posts('/api/conversations/harness1/messages')).length === 0 && st.restingSince > 0 && st.restKind === 'cold', st && JSON.stringify([st.restingSince, st.why]));
      check(sc, 'and makes no notice about it (the cache ran out long ago)', (await toasts()).length === 0, JSON.stringify(await toasts()));
    }

    // Claude members go 20 s apart: 2 minutes behind two others would be past their cache window.
    {
      const sc = 'claude-gap';
      await load('team=1&theme=light&claude=1');
      await armVia('[data-slot-id="slotA"]');
      await armVia('[data-slot-id="slotB"]');
      await setSlot('slotA', 'idle');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'two idle Claude members, one send', (await posts('/api/teams/team1/agents/')).length === 1);
      await js(`localStorage.setItem('aionui.dx.teamsend.team1.claude', String(Date.now() - 21000)); 0`);
      await js('window.__aionDx.tickNow()');
      check(sc, 'the other goes 20 s later, not 2 min', (await posts('/api/teams/team1/agents/')).length === 2);
    }

    // Your stop switches the Loop off: to the lead, the team's Loops; to a member, its own.
    {
      const sc = 'stop-phrase';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotA"]');
      await armVia('[data-slot-id="slotB"]');
      const typeAndSend = async (slot, text) => {
        await js(`(() => { document.querySelector('[data-slot-id="${slot}"] [data-testid="sendbox-input"]').value = ${JSON.stringify(text)}; return 0; })()`);
        await humanClick(`[data-slot-id="${slot}"] [data-testid="sendbox-send-btn"]`);
        await js(`(() => { document.querySelector('[data-slot-id="${slot}"] [data-testid="sendbox-input"]').value = ''; return 0; })()`);
      };
      const phrase = (t) => js(`window.__aionDx.saysStop(${JSON.stringify(t)})`);
      check(sc, 'a stop phrase inside a when-clause is not your stop (the 2026-09-25 false positive)',
        (await phrase('can you get the original, replace it/back it up, and then swap it when we are done testing')) === false);
      check(sc, "\"we're done\" still is, ending its clause", (await phrase("If that's all, we're done.")) === true && (await phrase("We're done for today.")) === true &&
        (await phrase("we're done testing the map, now run the build")) === false);
      // R-012, 2026-09-28: a stand-down aimed at some members, or conditional, or carving one out, is not the whole team's stop.
      check(sc, "The owner's message to a team lead (stand-down for two, Builder carries on) stops nothing",
        (await phrase("Don't need to push the maps and the docs endlessly. Have them clean up the things i asked for... then have them stand down once everything is produced... We can let Builder continue working, that lane has top priority.")) === false &&
        (await phrase('Have them clean up the things i asked for... then have them stand down. We can let Builder continue working, that lane has top priority.')) === false);
      check(sc, 'a stop told to be relayed to others, or with a condition after it, is not the Loop\'s',
        (await phrase('have them stand down')) === false && (await phrase('tell Worker to stand down')) === false && (await phrase('stand down once the build lands')) === false &&
        (await phrase('stand down everyone except Builder')) === false && (await phrase("ok that's enough for today, let Worker keep going")) === false);
      check(sc, 'a plain stand-down, said to everyone, still is',
        (await phrase('stand down')) === true && (await phrase('I want everyone to stand down')) === true && (await phrase('tell everyone to stand down')) === true && (await phrase('ok stand down')) === true);
      await typeAndSend('slotB', "don't stop working on the map tests");
      check(sc, '"don\'t stop" leaves it on', (await label('[data-slot-id="slotB"]')) === 'Loop · On');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await typeAndSend('slotA', 'ok, time to stop work for today');
      check(sc, "said to the lead, it switches off every Loop of the team", (await label('[data-slot-id="slotA"]')) === 'Loop · Off' && (await label('[data-slot-id="slotB"]')) === 'Loop · Off');
      const st = await saved(KEY_B);
      check(sc, 'and records your words as the reason', st && st.offReason === 'you said "ok, time to stop work for today"', st && st.offReason);
      await sleep(200);
      const tt = await toasts();
      const tw = await toastWheres();
      check(sc, 'with one notice naming the team', tt.length === 1 && /^Loop off for 2 members of this team: you said stop\./.test(tt[0]) && /^Harness Team · /.test(tw[0].where), JSON.stringify([tt, tw]));
      const rec = (await store())['aiondx.loop.team.team1.slotB'];
      check(sc, 'the tool sees it as your change', rec && rec.on === false && rec.by === 'user', JSON.stringify(rec));
      await armVia('[data-slot-id="slotA"]');
      await armVia('[data-slot-id="slotB"]');
      await typeAndSend('slotB', 'stop');
      check(sc, 'said to a member, only that member\'s Loop goes off', (await label('[data-slot-id="slotB"]')) === 'Loop · Off' && (await label('[data-slot-id="slotA"]')) === 'Loop · On');
      // A solo chat also reads your words from its history (sent from another window, say).
      await load('theme=light');
      await armVia('');
      await js(`(() => { window.__stub.histories.harness1.push({ id: 'gn', position: 'right', type: 'text', hidden: false, created_at: Date.now(), content: { content: 'good night' } }); return 0; })()`);
      await js('window.__aionDx.tickNow()');
      check(sc, 'a solo chat whose history says "good night" goes off', (await label('')) === 'Loop · Off');
    }

    // On until I stop it (2026-09-26, a request): no hold, no cold rest, no giving up; no agent ends it alone.
    {
      const sc = 'forever';
      const LOOP_KEY = 'aionui.dx.harness1';
      const sent = async () => (await posts('/api/conversations/harness1/messages')).length;
      const pickForever = async (scope) => {
        await humanClick(`${scope} .aiondx-loop button`);
        await js(`(() => { document.querySelector('.aiondx-menu [data-choice="forever"]').scrollIntoView({ block: 'nearest' }); return 0; })()`);
        await humanClick('.aiondx-menu [data-choice="forever"]');
      };
      await load('theme=light');
      await humanClick('.aiondx-loop button');
      const items = await js('[...document.querySelectorAll(".aiondx-menu [data-choice]")].map(e => e.getAttribute("data-choice") + ":" + e.querySelector(".aiondx-item-title").textContent)');
      check(sc, 'the menu offers On, On until I stop it, and Off', JSON.stringify(items) === JSON.stringify(['on:On', 'forever:On until I stop it', 'off:Off']), JSON.stringify(items));
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
      await pickForever('');
      let st = await saved(LOOP_KEY);
      let rec = (await store())[SOLO_KEY];
      check(sc, 'choosing it switches the Loop on until you stop it, for the tool too', st.on === true && st.forever === true && st.foreverAt > 0 &&
        rec && rec.on === true && rec.forever === true && rec.foreverAt === st.foreverAt && rec.by === 'user', JSON.stringify([st.forever, rec]));
      check(sc, 'the button shows it (the infinity mark) and says it', await js('document.querySelector(".aiondx-loop").classList.contains("aiondx-loop--forever")') &&
        /until you stop it/.test(await js('document.querySelector(".aiondx-loop button").getAttribute("aria-label")') || ''));
      await humanClick('.aiondx-loop button');
      check(sc, 'the menu marks it and says so', (await js('document.querySelector(".aiondx-menu [data-choice=\\"forever\\"]").getAttribute("aria-checked")')) === 'true' &&
        (await js('document.querySelector(".aiondx-menu [data-choice=\\"on\\"]").getAttribute("aria-checked")')) === 'false' &&
        /On until you stop it\./.test(await js('(document.querySelector(".aiondx-status") || {}).textContent') || ''),
        await js('(document.querySelector(".aiondx-status") || {}).textContent'));
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
      await js('window.__aionDx.tickNow()');   // the first nudge
      // 46 min of short replies, the last 70 s ago: an ordinary Loop rests here (the hold).
      await js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}')); s.nudgeLevel = 2; s.shortSince = Date.now() - 46 * 60000;
        s.lastFired = Date.now() - 90000; s.nudgeScored = s.fires; localStorage.setItem('${LOOP_KEY}', JSON.stringify(s));
        const h = window.__stub.histories.harness1; const nudge = h.filter(m => m.position === 'right').pop(); if (nudge) nudge.created_at = s.lastFired;
        h.push({ id: 'f-r1', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 70000, content: { content: 'still nothing' } }); return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, 'no rest after the hold', st.restKind !== 'hold' && !st.restingSince && /^Nothing to do after the last nudge\. The next goes at/.test(st.why || ''), JSON.stringify([st.restKind, st.why]));
      // Its cache ran out 5 min ago: an ordinary Loop never wakes it.
      await js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}')); s.lastFired = Date.now() - 11 * 60000; localStorage.setItem('${LOOP_KEY}', JSON.stringify(s));
        const h = window.__stub.histories.harness1; h.forEach(m => { m.created_at = Math.min(m.created_at, Date.now() - 11 * 60000); });
        h.push({ id: 'f-r2', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 10 * 60000, content: { content: 'still nothing' } }); return 0; })()`);
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, 'a cold agent is woken all the same', (await sent()) === 1 && !st.restingSince, JSON.stringify([await sent(), st.restKind, st.why]));
      // Three nudges with no reply: an ordinary Loop switches itself off.
      await js(`(() => { const s = JSON.parse(localStorage.getItem('${LOOP_KEY}')); s.stalls = 2; s.lastFired = Date.now() - 270000; s.nudgeScored = s.fires; s.nudgeLevel = 2;
        localStorage.setItem('${LOOP_KEY}', JSON.stringify(s));
        const h = window.__stub.histories.harness1; h.forEach(m => { m.created_at = Math.min(m.created_at, Date.now() - 300000); });
        const nudge = h.filter(m => m.position === 'right').pop(); if (nudge) nudge.created_at = s.lastFired; return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, 'no reply to 3 nudges: it waits, and stays on', st.on === true && st.forever === true && (await sent()) === 0 &&
        /^Paused: no reply to the last 3 nudges\. It carries on when the agent answers, and stays on until you stop it\.$/.test(st.why || ''), JSON.stringify([st.on, st.why]));
      // An agent switching it off on its own (an older Loop tool): kept on, and your record goes back.
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await putStore(SOLO_KEY, { v: 1, on: false, forever: false, msg: DEFAULT_MSG, compactAt: 0, holdMin: 45, rev: 90, by: 'agent', who: 'Harness agent', for: '', at: Date.now() + 1000, note: 'work is done' });
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      st = await saved(LOOP_KEY);
      rec = (await store())[SOLO_KEY];
      check(sc, "an agent's switch-off is refused, and your setting goes back to the store", st.on === true && st.forever === true &&
        rec.on === true && rec.forever === true && rec.by === 'user', JSON.stringify([st.on, rec]));
      // The tool's switch-off after you asked (it carries askedAt): it goes off.
      await putStore(SOLO_KEY, { v: 1, on: false, forever: false, foreverAt: 0, msg: DEFAULT_MSG, compactAt: 0, holdMin: 45, rev: 92, by: 'agent', who: 'Harness agent', for: '',
        at: Date.now() + 2000, note: 'the user asked: "turn off your loop"', askedAt: Date.now() - 5000 });
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      st = await saved(LOOP_KEY);
      check(sc, 'an agent switching it off because you asked (askedAt): off', st.on === false && !st.forever, JSON.stringify([st.on, st.forever, st.offReason]));
      // The agent's Stop button.
      await pickForever('');
      await js(`(() => { const a = document.querySelector('#solo .sendbox-actions'); const b = document.createElement('button'); b.type = 'button';
        b.className = 'arco-btn arco-btn-secondary arco-btn-shape-circle sendbox-stop-button'; b.textContent = 'stop'; a.appendChild(b); return 0; })()`);
      await humanClick('#solo .sendbox-stop-button');
      st = await saved(LOOP_KEY);
      rec = (await store())[SOLO_KEY];
      check(sc, "the agent's Stop button switches it off, as yours", st.on === false && st.offReason === 'you pressed Stop' && rec.on === false && rec.by === 'user', JSON.stringify([st.on, st.offReason, rec]));
      await js(`(() => { document.querySelector('#solo .sendbox-stop-button').remove(); return 0; })()`);
      // Your words in the chat's history.
      await pickForever('');
      await js(`(() => { window.__stub.histories.harness1.push({ id: 'f-off', position: 'right', type: 'text', hidden: false, created_at: Date.now() + 1000, content: { content: 'ok, turn off your loop' } }); return 0; })()`);
      await js('window.__aionDx.tickNow()');
      st = await saved(LOOP_KEY);
      check(sc, '"turn off your loop" in its history switches it off', st.on === false && /^you said "ok, turn off your loop"$/.test(st.offReason || ''), JSON.stringify([st.on, st.offReason]));

      // A team: said to a member, that member's Loop; about another member, only a note for the Loop tool.
      await load('team=1&theme=light');
      await pickForever('[data-slot-id="slotA"]');
      await pickForever('[data-slot-id="slotB"]');
      const typeAndSend = async (slot, text) => {
        await js(`(() => { document.querySelector('[data-slot-id="${slot}"] [data-testid="sendbox-input"]').value = ${JSON.stringify(text)}; return 0; })()`);
        await humanClick(`[data-slot-id="${slot}"] [data-testid="sendbox-send-btn"]`);
        await js(`(() => { document.querySelector('[data-slot-id="${slot}"] [data-testid="sendbox-input"]').value = ''; return 0; })()`);
      };
      await typeAndSend('slotA', 'turn off the loop for Worker, the tests are done');
      await sleep(200);
      let ask = (await store())['aiondx.loopask.team.team1.slotA'];
      check(sc, 'said to the lead about a teammate: both stay on, and the request is noted for the tool', (await label('[data-slot-id="slotA"]')) === 'Loop · On' &&
        (await label('[data-slot-id="slotB"]')) === 'Loop · On' && ask && ask.at > Date.now() - 10000 && /^turn off the loop for Worker/.test(ask.text), JSON.stringify(ask));
      await typeAndSend('slotB', "don't turn off your loop, keep going");
      check(sc, '"don\'t turn off your loop" leaves it on, and notes nothing', (await label('[data-slot-id="slotB"]')) === 'Loop · On' && !(await store())['aiondx.loopask.team.team1.slotB']);
      await typeAndSend('slotB', 'turn off your loop');
      check(sc, 'said to a member, only that member\'s Loop goes off', (await label('[data-slot-id="slotB"]')) === 'Loop · Off' && (await label('[data-slot-id="slotA"]')) === 'Loop · On');
      const off = (t) => js(`window.__aionDx.saysLoopOff(${JSON.stringify(t)})`);
      const asks = (t) => js(`window.__aionDx.asksLoopOff(${JSON.stringify(t)})`);
      const yes = ['turn off your loop', 'Stop the loop.', 'loop off', 'can you turn the loop off?', 'please switch off this loop'];
      const no = ["don't turn off the loop", "when you're done, stop the loop", 'did you turn off the loop?', 'keep the loop on', 'turn off the loop for Worker', 'the loop keeps stopping'];
      const offYes = []; for (const t of yes) offYes.push(await off(t));
      const offNo = []; for (const t of no) offNo.push(await off(t));
      check(sc, 'which words switch its own Loop off', offYes.every((x) => x === true) && offNo.every((x) => x === false), JSON.stringify([offYes, offNo]));
      const askYes = []; for (const t of ["turn off Worker's loop", 'stop all the loops', 'turn off the loop for Worker', 'switch the team loops off']) askYes.push(await asks(t));
      const askNo = []; for (const t of ["don't stop Worker's loop", 'when the build passes, turn off the loops', 'the loop keeps stopping', 'did you turn off the loops?',
        'at the end of the loop, write the log', 'turn off the lights and fix the loop']) askNo.push(await asks(t));
      check(sc, "which words note a request for someone else's Loop", askYes.every((x) => x === true) && askNo.every((x) => x === false), JSON.stringify([askYes, askNo]));
    }

    // A message box with no Loop button says why, in the store (a team's missing buttons, 2026-09-26).
    {
      const sc = 'diag';
      await load('team=1&theme=light');
      await js(`(() => { const a = document.querySelector('[data-slot-id="slotB"] .sendbox-actions'); a.parentNode.removeChild(a); return 0; })()`);
      await js('window.__aionDx.repaint()');
      await sleep(300);
      const d = (await store())['aiondx.diag.loop'] || [];
      const e = d.find((x) => x.kind === 'no-button' && x.where === 'slot slotB');
      check(sc, 'a member box with no actions row is recorded, with where it sits', e && e.inSlot === true && e.hasActions === false && e.routeKind === 'team' &&
        Array.isArray(e.chain) && e.chain.length > 2 && !d.some((x) => x.where === 'slot slotA'), JSON.stringify(d).slice(0, 600));
      await js('window.__aionDx.repaint()');
      check(sc, 'once, not on every repaint', ((await store())['aiondx.diag.loop'] || []).filter((x) => x.where === 'slot slotB').length === 1);
    }

    // AionUi's single view of a team (one member at a time, tabs above): a team's "Loop buttons gone".
    {
      const sc = 'single-view';
      await load('team=1&single=1&front=slotB&theme=light');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      let tg = await js('JSON.stringify(window.__aionDx.targets())');
      check(sc, 'the one message box gets a Loop button, for the member in front', (await js('document.querySelectorAll("#solo .aiondx-loop").length')) === 1 &&
        JSON.parse(tg).length === 1 && JSON.parse(tg)[0].key === 'team:team1:slotB', tg);
      await armVia('#solo');
      check(sc, 'switching it on is that member\'s Loop', (await saved(KEY_B) || {}).on === true && !(await saved(KEY_A) || {}).on, JSON.stringify(await saved(KEY_B)));
      check(sc, 'and nothing is recorded as missing', !((await store())['aiondx.diag.loop'] || []).some((x) => x.kind === 'no-button'), JSON.stringify((await store())['aiondx.diag.loop']));
      await js(`(() => { document.querySelector('#solo [data-testid="sendbox-input"]').value = 'stop'; return 0; })()`);
      await humanClick('#solo [data-testid="sendbox-send-btn"]');
      check(sc, 'your "stop" in that box reaches that member\'s Loop', (await saved(KEY_B) || {}).on === false, JSON.stringify(await saved(KEY_B)));
      await humanClick('[data-testid="team-tab-slotA"]');
      await js('window.__aionDx.repaint()');
      await sleep(200);
      tg = await js('JSON.stringify(window.__aionDx.targets())');
      check(sc, 'another tab in front: the button follows it', JSON.parse(tg).length === 1 && JSON.parse(tg)[0].key === 'team:team1:slotA' &&
        (await js('document.querySelectorAll("#solo .aiondx-loop").length')) === 1, tg);
      await load('team=1&single=1&theme=light');
      tg = await js('JSON.stringify(window.__aionDx.targets())');
      check(sc, 'nothing stored: the lead\'s', JSON.parse(tg).length === 1 && JSON.parse(tg)[0].key === 'team:team1:slotA', tg);
    }

    // AionUi's "Interrupt & send" (a wide button, the same interrupt as Respond now) is hidden; the row's other buttons stay.
    {
      const sc = 'interrupt-btn';
      await load('team=1&theme=light');
      await js(`(() => { const a = document.querySelector('[data-slot-id="slotB"] .sendbox-actions');
        const b = document.createElement('button'); b.id = 'fake-interrupt'; b.type = 'button'; b.className = 'arco-btn arco-btn-secondary arco-btn-size-mini arco-btn-shape-square';
        b.innerHTML = '<span class="i-icon i-icon-lightning"><svg width="14" height="14" viewBox="0 0 48 48"></svg></span><span>Interrupt &amp; send</span>';
        const o = document.createElement('button'); o.id = 'fake-other'; o.type = 'button'; o.className = 'arco-btn arco-btn-secondary arco-btn-size-mini';
        o.innerHTML = '<span class="i-icon i-icon-down"></span><span>Other</span>';
        a.insertBefore(o, a.lastElementChild); a.insertBefore(b, a.lastElementChild); return 0; })()`);
      await sleep(200);
      const shown = (id) => js(`getComputedStyle(document.getElementById('${id}')).display !== 'none'`);
      check(sc, "AionUi's Interrupt & send is hidden (Respond now does the same)", !(await shown('fake-interrupt')));
      check(sc, 'and the other buttons in that row are not', await shown('fake-other') &&
        (await js(`getComputedStyle(document.querySelector('[data-slot-id="slotB"] [data-testid="sendbox-send-btn"]')).display !== 'none'`)));
    }

    // /plugin and /plugins (a tester, 2026-09-26: "we don't have plugin access here and we need it").
    {
      const sc = 'plugins';
      const calls = () => js('JSON.parse(JSON.stringify(window.__pluginCalls))');
      const panelOpen = () => js('!!document.querySelector(".aiondx-plugins-backdrop") && !document.querySelector(".aiondx-plugins-backdrop").hidden');
      const rowsOf = () => js('[...document.querySelectorAll(".aiondx-plugins-row")].map(r => ({ id: r.getAttribute("data-plugin"), meta: r.querySelector(".aiondx-plugins-meta").textContent, desc: r.querySelector(".aiondx-plugins-desc").textContent, btns: [...r.querySelectorAll("button")].map(b => b.textContent) }))');
      const status = () => js('document.querySelector(".aiondx-plugins-status").textContent');
      const settle = async () => { for (let i = 0; i < 30 && (await js('window.__aionDx.plugins().busy')); i++) await sleep(100); await sleep(400); };
      await load('theme=light&plugins=1&sends=1');
      await js('window.__calls.length = 0; 0');
      await typeInto('#solo [data-testid="sendbox-input"]', '/plugins');
      await pressEnter();
      await settle();
      check(sc, '"/plugins" + Enter opens the panel, sends nothing, and empties the box', await panelOpen() &&
        (await posts('/api/conversations/harness1/messages')).length === 0 && (await js('document.querySelector("#solo [data-testid=\\"sendbox-input\\"]").value')) === '');
      let c = await calls();
      check(sc, 'it asks Claude Code for the installed and available plugins and the marketplaces', JSON.stringify(c[0]) === JSON.stringify(['list', '--json', '--available']) &&
        c.some((a) => a[0] === 'marketplace' && a[1] === 'list'), JSON.stringify(c));
      let rows = await rowsOf();
      check(sc, 'Installed shows the one plugin, its marketplace, state and description, with Disable, Update, Uninstall',
        rows.length === 1 && rows[0].id === 'agent-sdk-dev@claude-plugins-official' && /claude-plugins-official · 51\.0k installs · enabled/.test(rows[0].meta) &&
        rows[0].desc === 'Development kit for working with the Claude Agent SDK' && JSON.stringify(rows[0].btns) === JSON.stringify(['Disable', 'Update', 'Uninstall']), JSON.stringify(rows));
      check(sc, 'the tabs count them and the footer names the marketplace', (await js('[...document.querySelectorAll(".aiondx-plugins-tab")].map(b => b.textContent).join("|")')) === 'Installed (1)|Available (3)' &&
        /Marketplaces: claude-plugins-official/.test(await js('document.querySelector(".aiondx-plugins-markets").textContent')));
      await humanClick('.aiondx-plugins-tab[data-tab="available"]');
      rows = await rowsOf();
      check(sc, 'Available lists the rest, most installed first, each with Install', rows.map((r) => r.id.split('@')[0]).join(',') === 'code-review,dataviz,shell-helper' &&
        rows.every((r) => JSON.stringify(r.btns) === '["Install"]'), JSON.stringify(rows.map((r) => r.id)));
      await typeInto('.aiondx-plugins-search', 'chart');
      rows = await rowsOf();
      check(sc, 'search narrows the list', rows.length === 1 && rows[0].id === 'dataviz@claude-plugins-official', JSON.stringify(rows.map((r) => r.id)));
      await js('window.__pluginCalls.length = 0; 0');
      await humanClick('.aiondx-plugins-row[data-plugin="dataviz@claude-plugins-official"] button');
      await settle();
      c = await calls();
      check(sc, 'Install runs "claude plugin install <id> --json", says so, and lists again', JSON.stringify(c[0]) === JSON.stringify(['install', 'dataviz@claude-plugins-official', '--json']) &&
        /^Successfully installed plugin: dataviz@claude-plugins-official \(scope: user\) New Claude chats load it; in an open chat, type \/reload-plugins\.$/.test(await status()) &&
        (await js('[...document.querySelectorAll(".aiondx-plugins-tab")].map(b => b.textContent).join("|")')) === 'Installed (2)|Available (2)', JSON.stringify([c, await status()]));
      await js(`(() => { const s = document.querySelector('.aiondx-plugins-search'); s.value = ''; s.dispatchEvent(new Event('input')); return 0; })()`);
      await humanClick('.aiondx-plugins-tab[data-tab="installed"]');
      await humanClick('.aiondx-plugins-row[data-plugin="agent-sdk-dev@claude-plugins-official"] button[data-act="disable"]');
      await settle();
      rows = await rowsOf();
      const sdk = rows.find((r) => r.id === 'agent-sdk-dev@claude-plugins-official');
      check(sc, 'Disable switches it off and the row offers Enable', sdk && / · disabled/.test(sdk.meta) && sdk.btns[0] === 'Enable' && /Successfully disabled plugin/.test(await status()), JSON.stringify([sdk, await status()]));
      // A marketplace that installs by running its own command: shown first, run only when accepted.
      await humanClick('.aiondx-plugins-tab[data-tab="available"]');
      await js('window.__pluginCalls.length = 0; 0');
      await humanClick('.aiondx-plugins-row[data-plugin="shell-helper@tools-market"] button');
      await settle();
      check(sc, "a marketplace's install command is shown and waits", (await js('(document.querySelector(".aiondx-plugins-pending code") || {}).textContent')) === 'npx shell-helper-setup' &&
        (await calls()).length === 1);
      await humanClick('.aiondx-plugins-accept');
      await settle();
      c = await calls();
      check(sc, 'accepting runs the install with that command\'s hash, and nothing else', JSON.stringify(c[1]) === JSON.stringify(['install', 'shell-helper@tools-market', '--accept-command', 'abc123def', '--json']) &&
        (await js('window.__pluginState.installed.some(p => p.id === "shell-helper@tools-market")')), JSON.stringify(c));
      await typeInto('.aiondx-plugins-source', 'someone/their-plugins');
      await js('window.__pluginCalls.length = 0; 0');
      await humanClick('.aiondx-plugins-add-btn');
      await settle();
      check(sc, 'Add runs "claude plugin marketplace add"', JSON.stringify((await calls())[0]) === JSON.stringify(['marketplace', 'add', 'someone/their-plugins']) &&
        /Successfully added marketplace: someone\/their-plugins/.test(await status()), JSON.stringify([await calls(), await status()]));
      await pressEnter();   // Enter in the source box with it empty: nothing
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
      check(sc, 'Escape closes it', !(await panelOpen()));
      // "/plugin install x@y" with the send button: runs it straight away.
      await js('window.__pluginCalls.length = 0; window.__calls.length = 0; 0');
      await typeInto('#solo [data-testid="sendbox-input"]', '/plugin install code-review@claude-plugins-official');
      await humanClick('#solo [data-testid="sendbox-send-btn"]');
      await settle();
      c = await calls();
      check(sc, '"/plugin install <id>" runs the install at once, and sends nothing', await panelOpen() && JSON.stringify(c[0]) === JSON.stringify(['install', 'code-review@claude-plugins-official', '--json']) &&
        (await posts('/api/conversations/harness1/messages')).length === 0, JSON.stringify(c));
      // The other ways a message leaves the box (a request reached Claude Code anyway):
      // Ctrl+Enter and the draft-queue button (both queue it), an Enter that Windows text input reports as keyCode 229,
      // and, behind all of them, the send itself.
      const closePanel = () => js(`(() => { const b = document.querySelector('.aiondx-plugins-close'); if (b) b.click(); return 0; })()`);
      const noSend = async () => (await posts('/api/conversations/harness1/messages')).length === 0;
      await closePanel();
      await js('window.__calls.length = 0; 0');
      await typeInto('#solo [data-testid="sendbox-input"]', '/plugins');
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
      await sleep(400);
      check(sc, 'Ctrl+Enter (AionUi queues it) opens the panel too', await panelOpen() && await noSend() && !(await js('window.__draftAdds || 0')));
      await closePanel();
      await typeInto('#solo [data-testid="sendbox-input"]', '/plugin');
      await humanClick('#solo [data-testid="sendbox-add-to-draft-btn"]');
      await sleep(300);
      check(sc, 'so does the draft-queue button', await panelOpen() && await noSend() && !(await js('window.__draftAdds || 0')), await js('window.__draftAdds || 0'));
      await closePanel();
      await typeInto('#solo [data-testid="sendbox-input"]', '/plugin');
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
      await sleep(400);
      check(sc, 'and an Enter reported as keyCode 229 with no composition under way', await panelOpen() && await noSend());
      await closePanel();
      const net = await js(`fetch('http://127.0.0.1:58699/api/conversations/harness1/messages', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '/plugin install dataviz@claude-plugins-official' }) })
        .then(async r => ({ status: r.status, body: await r.text() }))`);
      await sleep(600);
      c = await calls();
      check(sc, 'a send that starts with /plugin by any other road is stopped at the send, and the panel runs it', net && net.status === 409 &&
        /Plugins panel/.test(net.body) && await noSend() && await panelOpen() && c.some((a) => a[0] === 'install' && a[1] === 'dataviz@claude-plugins-official'),
        JSON.stringify([net, c.slice(-2)]));
      await closePanel();
      await js('window.__calls.length = 0; 0');
      await typeInto('#solo [data-testid="sendbox-input"]', 'please check the /plugin panel later');
      await pressEnter();
      await sleep(400);
      check(sc, 'a message that only mentions /plugin goes to the agent as usual', !(await panelOpen()) && (await posts('/api/conversations/harness1/messages')).length === 1);
      // Without the app's bridge (WebUI): the panel says what to do instead.
      await load('theme=light');
      await typeInto('#solo [data-testid="sendbox-input"]', '/plugin');
      await pressEnter();
      await sleep(300);
      check(sc, 'in the WebUI it says to ask a Claude agent instead', await panelOpen() && /works in the AionDX app/.test(await status()), await status());
    }

    // Unsend (2026-09-25.5): a message Claude has not read yet ("Unread") can be taken back. The
    // renderer writes aiondx.unsend.req.<msg_id>; the account router answers in aiondx.unsend.result.
    {
      const sc = 'unsend';
      const MSG = '7f3c2a10-0000-4000-8000-000000000077';
      await load('theme=light');
      await js('window.__aionDx.repaint()');
      await sleep(400);
      await js('window.__aionDx.repaint()');
      const btn = () => js(`(() => { const b = document.querySelector('[data-testid="message-status-badge"] [data-testid="aiondx-unsend"]'); return b ? { text: b.textContent, disabled: b.disabled } : null; })()`);
      let b = await btn();
      check(sc, 'an Unread message in a Claude chat gets Unsend beside "Unread"', b && b.text === 'Unsend' && !b.disabled, JSON.stringify(b));
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await humanClick('[data-testid="aiondx-unsend"]');
      await sleep(400);
      const req = (await store())['aiondx.unsend.req.' + MSG];
      check(sc, "clicking it asks the router, by the message's msg_id", req && req.conv === 'harness1' && req.messageId === 'm-77' && Date.now() - req.at < 10000, JSON.stringify(req));
      b = await btn();
      check(sc, 'and the button says it is working on it', b && b.text === 'Unsending...' && b.disabled, JSON.stringify(b));
      // The router's answer.
      await putStore('aiondx.unsend.result.' + MSG, { cancelled: true, conv: 'harness1', messageId: 'm-77', at: Date.now() });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      const row = await js(`(() => { const r = document.getElementById('message-m-77'); const c = r.querySelector('[data-testid="message-text-content"]');
        return { unsent: r.getAttribute('data-aiondx-unsent'), strike: getComputedStyle(c.firstElementChild).textDecorationLine, label: getComputedStyle(c, '::after').content }; })()`);
      check(sc, 'once unsent the message is struck through and marked Unsent', row.unsent === '1' && row.strike === 'line-through' && row.label === '"Unsent"', JSON.stringify(row));
      const tt = await toasts();
      check(sc, 'with a notice naming the chat', tt.length === 1 && /^Unsent\. The agent never saw it\./.test(tt[0]) && (await toastWheres())[0].where === 'Chat: Harness', JSON.stringify([tt, await toastWheres()]));
      await shot('click-test-unsend');
      // Too late: Claude had already taken it.
      await load('theme=light');
      await js('window.__aionDx.repaint()');
      await sleep(400);
      await js('window.__aionDx.repaint()');
      await humanClick('[data-testid="aiondx-unsend"]');
      await sleep(300);
      await putStore('aiondx.unsend.result.' + MSG, { cancelled: false, conv: 'harness1', messageId: 'm-77', at: Date.now() });
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      check(sc, 'if the agent had already taken it, it says so', /^Too late to unsend: the agent had already picked it up\./.test((await toasts())[0] || ''), JSON.stringify(await toasts()));
      // Already read by the time of the click: no request at all.
      await load('theme=light');
      await js(`(() => { window.__stub.routes['GET /api/conversations/harness1/messages/m-77'].data.status = 'finish'; return 0; })()`);
      await js('window.__aionDx.repaint()');
      await sleep(400);
      await js('window.__aionDx.repaint()');
      await humanClick('[data-testid="aiondx-unsend"]');
      await sleep(400);
      check(sc, 'a message read before the click is not requested', !(await store())['aiondx.unsend.req.' + MSG] && /^Too late to unsend/.test((await toasts())[0] || ''), JSON.stringify(await toasts()));
      // Not a Claude chat: no button.
      await load('theme=light&backend=gemini');
      await js('window.__aionDx.repaint()');
      await sleep(400);
      await js('window.__aionDx.repaint()');
      check(sc, 'a chat that is not Claude gets no Unsend', (await btn()) === null);
      // And nothing waits above the box any more.
      await load('team=1&theme=light');
      await js('window.__aionDx.pulseNow()');
      await js(`(() => { document.querySelector('[data-slot-id="slotA"] [data-testid="sendbox-input"]').value = 'goes straight in'; return 0; })()`);
      await humanClick('[data-slot-id="slotA"] [data-testid="sendbox-send-btn"]');
      check(sc, 'a message to a working agent is not held (the outbox is gone)', (await js('document.querySelectorAll("[data-testid=\\"aiondx-outbox\\"]").length')) === 0);
    }

    // A solo chat whose runtime is mid-turn while its status still says finished (seen live).
    {
      const sc = 'solo-runtime';
      await load('theme=light');
      await armVia('');
      await js(`(() => { window.__stub.routes['GET /api/conversations/harness1'].data.runtime = { state: 'running', is_processing: true, supports_midturn_delivery: true }; return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const st = await saved('aionui.dx.harness1');
      check(sc, 'status "finished" with its runtime processing: working, no nudge', (await posts('/api/conversations/harness1/messages')).length === 0 && st.why === 'Not sending: it is working.', st && st.why);
    }

    // After an AionUi restart every member is idle at once. One send per team every 2 minutes.
    {
      const sc = 'team-gap';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotA"]');
      await armVia('[data-slot-id="slotB"]');
      await setSlot('slotA', 'idle');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const n1 = (await posts('/api/teams/team1/agents/')).length;
      check(sc, 'two idle members, one send', n1 === 1, n1);
      await js(`localStorage.setItem('aionui.dx.teamsend.team1', String(Date.now() - 130000)); 0`);
      await js('window.__aionDx.tickNow()');
      const n2 = (await posts('/api/teams/team1/agents/')).length;
      check(sc, 'the other goes 2 minutes later', n2 === 2, n2);
    }

    // An error that states its reset time is waited out exactly (plus 30 s), not for 20 minutes.
    // The tip is the shape the app stored at 09:20 on 2026-09-23 once the Devin proxy passed
    // Devin's own sentence through.
    {
      const sc = 'stated-reset';
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotB"]');
      await setSlot('slotB', 'paused');
      await js(`(() => { const detail = 'Agent internal error (code -32603): Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 45 seconds. Send a message after that to continue.';
        window.__stub.histories.convB.push({ id: 'err-stated', position: 'left', type: 'tips', hidden: false, created_at: Date.now() - 10000,
          content: { content: 'The model provider rate limited the request', type: 'error', source: 'send_failed', code: 'USER_LLM_PROVIDER_RATE_LIMITED', details: detail,
            error: { message: 'The model provider rate limited the request', code: 'USER_LLM_PROVIDER_RATE_LIMITED', ownership: 'user_llm_provider', detail: detail, retryable: true } } });
        return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'waits while the stated reset is pending', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0);
      const st = await saved(KEY_B);
      const want = Date.now() - 10000 + 45000 + 30000;
      check(sc, 'schedules the stated reset plus 30 s', st && Math.abs(st.nextRetryAt - want) < 5000, st && st.nextRetryAt - want);
      await age('convB', 80000);
      await js('window.__aionDx.tickNow()');
      const toB = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'resumes 75 s after the error, not 20 min', toB.length === 1 && toB[0].body.content.indexOf(RESUME_MEMBER) === 0, JSON.stringify(toB));
    }

    // A solo chat whose last turn failed waits instead of re-sending every minute.
    {
      const sc = 'solo-error';
      await load('theme=light');
      await armVia('');
      await js(tipJs('harness1', 60000));
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'waits after a rate-limit failure', (await posts('/api/conversations/harness1/messages')).length === 0);
      await age('harness1', 21 * 60000);
      await js('window.__aionDx.tickNow()');
      const p = await posts('/api/conversations/harness1/messages');
      check(sc, 'retries once the wait is over', p.length === 1 && p[0].body.content === NUDGE, JSON.stringify(p));
      const st = await saved('aionui.dx.harness1');
      check(sc, 'counts it as a retry, not a stall', st && st.errAttempts === 1 && !st.stalls, st && JSON.stringify({ e: st.errAttempts, s: st.stalls }));
      check(sc, 'loop stays on', (await label('')) === 'Loop · On');
    }

    // ---- limits (2026-10-01): the Loop pauses while the account is at its limit, and resumes at the reset ----
    {
      const sc = 'limits';
      await load('theme=light');
      const nowS = Math.floor(Date.now() / 1000);
      await armVia('');
      await putStore('aiondx.usage.acct.k9', { label: 'Main', at: Date.now() - 20000, status: 'rejected',
        five_hour: { u: 1, reset: nowS + 3600, status: 'rejected' }, seven_day: { u: 0.4, reset: nowS + 3 * 86400, status: 'allowed' } });
      await putStore('aiondx.usage.conv.harness1', { acct: 'k9', at: Date.now() });
      await js('window.__aionDx.pullNow()');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'an account at its 5-hour limit gets no nudge', (await posts('/api/conversations/harness1/messages')).length === 0);
      let st = await saved('aionui.dx.harness1');
      check(sc, 'and the Loop says why, and when it carries on', st && /^Paused: your Claude account is at its 5-hour limit\. The Loop carries on at \d\d:\d\d, when it resets\.$/.test(st.why || ''), st && st.why);
      check(sc, 'the Loop stays on', (await label('')) === 'Loop · On');
      await js('window.__aionDx.tickNow()');
      check(sc, 'still none on the next check', (await posts('/api/conversations/harness1/messages')).length === 0);
      // The reset passes.
      await putStore('aiondx.usage.acct.k9', { label: 'Main', at: Date.now() - 20000, status: 'rejected',
        five_hour: { u: 1, reset: nowS - 120, status: 'rejected' }, seven_day: { u: 0.4, reset: nowS + 3 * 86400, status: 'allowed' } });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.tickNow()');
      const p = await posts('/api/conversations/harness1/messages');
      check(sc, 'after the reset it sends one resume nudge that says so', p.length === 1 && /^\[AionDX Loop[^\]]*\] Your Claude account's usage limit has reset \(it is \d\d:\d\d\)\./.test(p[0].body.content), JSON.stringify(p));
      check(sc, 'with the usage line at its end', p.length === 1 && /\n\[Usage: 5-hour 0% \(reset\), week 40%\.\]$/.test(p[0].body.content), p[0] && p[0].body.content);
      st = await saved('aionui.dx.harness1');
      check(sc, 'and the pause is cleared', st && !st.limitUntil && !st.limitDone, st && JSON.stringify([st.limitUntil, st.limitDone]));

      // The usage line on an ordinary nudge, and its warning near a limit.
      await load('theme=light');
      await armVia('');
      await putStore('aiondx.usage.acct.k9', { label: 'Main', at: Date.now() - 20000, status: 'allowed_warning',
        five_hour: { u: 0.93, reset: nowS + 5400, status: 'allowed_warning' }, seven_day: { u: 0.75, reset: nowS + 2 * 86400, status: 'allowed' } });
      await putStore('aiondx.usage.conv.harness1', { acct: 'k9', at: Date.now() });
      await js('window.__aionDx.pullNow()');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const q = await posts('/api/conversations/harness1/messages');
      check(sc, 'a nudge ends with the account usage, and warns near a limit', q.length === 1 && /\n\[Usage: 5-hour 93% \(resets \d\d:\d\d\), week 75% \(resets .+\)\. Close to a limit: plan the work to fit\.\]$/.test(q[0].body.content), JSON.stringify(q));

      // Claude's own limit message, with no usage reading to go by: waited out to the time it states.
      await load('theme=light');
      await armVia('');
      const stated = await js(`(() => { const d = new Date(Date.now() + 180000); d.setSeconds(0, 0);
        const h = d.getHours(), mi = d.getMinutes(); const clock = ((h + 11) % 12 + 1) + ':' + ('0' + mi).slice(-2) + (h < 12 ? 'am' : 'pm');
        window.__stub.histories.harness1.push({ id: 'lim1', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 60000,
          content: { content: "You've hit your limit \u00b7 resets " + clock } });
        return { at: d.getTime() + 30000, clock }; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'a limit message in the chat holds the Loop back', (await posts('/api/conversations/harness1/messages')).length === 0);
      st = await saved('aionui.dx.harness1');
      check(sc, 'until the time it states, plus 30 s (' + stated.clock + ')', st && Math.abs(st.nextRetryAt - stated.at) < 2000, st && st.nextRetryAt - stated.at);
      check(sc, 'and the Loop says the turn failed and when it retries', st && /^The last turn failed\. Retry 1 of 10 at \d\d:\d\d\.$/.test(st.why || ''), st && st.why);
      // An ordinary long message that mentions a limit is not one.
      await load('theme=light');
      await armVia('');
      await js(`(() => { const h = window.__stub.histories.harness1; h.push({ id: 'chat1', position: 'left', type: 'text', hidden: false, created_at: Date.now() - 100000,
        content: { content: "I reached the limit of what the parser can do. " + 'Here is the long explanation of where it stops. '.repeat(20) } }); return 0; })()`);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'a long agent message that mentions a limit is not a limit message', (await posts('/api/conversations/harness1/messages')).length === 1);

      // Clock times in Claude's limit messages.
      const cases = await js(`(() => { const at = new Date(2026, 9, 1, 12, 0, 0).getTime(); const f = (t, a) => window.__aionDx.statedResetMs(t, a === undefined ? at : a); const H = 3600000;
        return { pm: f('5-hour limit reached \u00b7 resets 3pm') / H, half: f('resets at 3:30 pm') / H, am: f('Weekly limit reached \u00b7 resets 11:30 am') / H, h24: f('limit resets at 15:00') / H,
          date: f('limit reached \u00b7 resets Oct 5, 9am') / H, rel: f('Your limit will reset in 19 minutes') / 60000, none: f('5-hour limit reached'), times: f('it resets 5 times a day'),
          zone: f('resets 3pm (America/Denver)', Date.UTC(2026, 9, 1, 20, 0, 0)) / H, zone2: f('resets 9am (America/Denver)', Date.UTC(2026, 9, 1, 20, 0, 0)) / H, bad: f('resets 13pm') }; })()`);
      check(sc, 'a clock time is read as the next time it comes round', cases && cases.pm === 3 && cases.half === 3.5 && cases.am === 23.5 && cases.h24 === 3, JSON.stringify(cases));
      check(sc, 'with a date, and "in N minutes" still works', cases && cases.date === 93 && cases.rel === 19, JSON.stringify(cases));
      check(sc, 'a zone in brackets is used', cases && cases.zone === 1 && cases.zone2 === 19, JSON.stringify(cases));
      check(sc, 'no time, or not a time, gives none', cases && cases.none === 0 && cases.times === 0 && cases.bad === 0, JSON.stringify(cases));
    }

    // ---- schedule send (R-003, 2026-10-01) ----
    {
      const sc = 'sched';
      await load('theme=light');
      const btn = '[data-testid="aiondx-sched-btn"]';
      const schedKeys = async () => Object.keys(await store()).filter(k => k.indexOf('aiondx.sched.') === 0);
      const typeIn = async (sel, text) => { await humanClick(sel); await send('Input.insertText', { text }); await sleep(500); };
      const info = await js(`(() => { const b = document.querySelector('[data-testid="aiondx-sched-btn"]'); if (!b) return null; const w = b.parentNode;
        const n = w.nextElementSibling; return { disabled: b.disabled, next: n && n.querySelector('[data-testid="sendbox-add-to-draft-btn"]') ? 'draft' : (n && n.className), title: b.title, w: Math.round(b.getBoundingClientRect().width) }; })()`);
      check(sc, 'a Schedule send button sits just before the draft button, and is off while the box is empty', info && info.disabled === true && info.next === 'draft' && info.w === 32 && info.title === 'Schedule send: type a message first', JSON.stringify(info));
      await typeIn('[data-testid="sendbox-input"]', 'run the full test pass at noon');
      check(sc, 'it comes on once there is something to send', await js(`!document.querySelector('[data-testid="aiondx-sched-btn"]').disabled`));
      await humanClick(btn);
      await sleep(250);
      const items = await js(`[...document.querySelectorAll('.aiondx-sched-menu .aiondx-sched-quick-item .aiondx-item-title')].map(i => i.textContent)`);
      check(sc, 'it opens a menu of times', items.length === 4 && items[0] === 'In 15 minutes' && items[1] === 'In 1 hour' && /^(Today|Tomorrow) at 9:00$/.test(items[3]), JSON.stringify(items));
      await shot('click-test-sched-menu');
      await humanClick('.aiondx-sched-menu .aiondx-sched-quick-item');
      await sleep(500);
      let keys = await schedKeys();
      let rec = keys.length === 1 ? (await store())[keys[0]] : null;
      check(sc, 'choosing one puts the message in the store for that chat, 15 minutes out', rec && rec.scope === 'conv.harness1' && rec.text === 'run the full test pass at noon' && Math.abs(rec.due - (Date.now() + 900000)) < 20000, JSON.stringify(rec));
      check(sc, 'and empties the box, with a count on the button', (await js(`document.querySelector('[data-testid="sendbox-input"]').value`)) === '' &&
        (await js(`document.querySelector('.aiondx-sched-count').textContent`)) === '1');
      check(sc, 'with a notice that says when', (await toasts()).some(t => /^Scheduled for .+\./.test(t)), JSON.stringify(await toasts()));
      // Due now: it goes out as your own message.
      await putStore(keys[0], Object.assign({}, rec, { due: Date.now() - 5000 }));
      await js('window.__aionDx.pullNow()');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); window.__calls.length = 0; 0');
      await js('window.__aionDx.fireSched()');
      await sleep(900);
      let p = await posts('/api/conversations/harness1/messages');
      check(sc, 'when due it is sent to the chat as your own message', p.length === 1 && p[0].body.content === 'run the full test pass at noon', JSON.stringify(p));
      check(sc, 'once, and it leaves the store', (await schedKeys()).length === 0);
      await js('window.__aionDx.fireSched()');
      await sleep(400);
      check(sc, 'and is not sent again', (await posts('/api/conversations/harness1/messages')).length === 1);
      check(sc, 'with a notice that it went out', (await toasts()).some(t => /^Scheduled message sent\./.test(t)), JSON.stringify(await toasts()));

      // A message due while the app was closed goes out late, and says so.
      await putStore('aiondx.sched.late1', { v: 1, id: 'late1', scope: 'conv.harness1', text: 'good morning', due: Date.now() - 3 * 3600000, at: Date.now() - 4 * 3600000 });
      await js('window.__aionDx.pullNow()');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); window.__calls.length = 0; 0');
      await js('window.__aionDx.fireSched()');
      await sleep(900);
      check(sc, 'one due while the app was closed goes out when it opens, and the notice says it was late',
        (await posts('/api/conversations/harness1/messages')).length === 1 && (await toasts()).some(t => /^Scheduled message sent late \(it was due at \d\d:\d\d\)\./.test(t)), JSON.stringify(await toasts()));

      // Another open window has claimed it: not sent here. A claim that went stale: sent.
      await putStore('aiondx.sched.claim1', { v: 1, id: 'claim1', scope: 'conv.harness1', text: 'claimed elsewhere', due: Date.now() - 1000, at: Date.now() - 5000, claim: { by: 'otherwin', at: Date.now() } });
      await js('window.__aionDx.pullNow()');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.fireSched()');
      await sleep(600);
      check(sc, 'a message another window has just claimed is left to it', (await posts('/api/conversations/harness1/messages')).length === 0 && (await schedKeys()).length === 1);
      await putStore('aiondx.sched.claim1', { v: 1, id: 'claim1', scope: 'conv.harness1', text: 'claimed elsewhere', due: Date.now() - 1000, at: Date.now() - 5000, claim: { by: 'otherwin', at: Date.now() - 300000 } });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.fireSched()');
      await sleep(900);
      check(sc, 'and one whose claim has gone stale is sent', (await posts('/api/conversations/harness1/messages')).length === 1 && (await schedKeys()).length === 0);

      // Cancel from the menu; a time picked by hand; a time that has passed.
      await load('theme=light');
      await typeIn('[data-testid="sendbox-input"]', 'draft for later');
      await humanClick(btn);
      await sleep(250);
      const hand = await js(`(() => { const d = new Date(Date.now() + 2 * 3600000); const p = n => ('0' + n).slice(-2);
        const v = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
        document.querySelector('.aiondx-sched-when').value = v; return new Date(v).getTime(); })()`);
      await humanClick('.aiondx-sched-go');
      await sleep(500);
      keys = await schedKeys();
      rec = keys.length === 1 ? (await store())[keys[0]] : null;
      check(sc, 'a time picked by hand is used as it is', rec && rec.due === hand && rec.text === 'draft for later', JSON.stringify([rec, hand]));
      await humanClick(btn);
      await sleep(250);
      const waiting = await js(`[...document.querySelectorAll('.aiondx-sched-item')].map(r => [r.querySelector('.aiondx-sched-item-when').textContent, r.querySelector('.aiondx-sched-item-text').textContent])`);
      check(sc, 'the menu lists what is waiting, even with the box empty', waiting.length === 1 && waiting[0][1] === '"draft for later"' || waiting.length === 1 && /draft for later/.test(waiting[0][1]), JSON.stringify(waiting));
      await humanClick('.aiondx-sched-cancel');
      await sleep(400);
      check(sc, 'Cancel removes it', (await schedKeys()).length === 0);
      await humanClick('.aiondx-sched-menu .aiondx-sched-quick-item');
      await sleep(200);
      check(sc, 'with nothing in the box the times do nothing', (await schedKeys()).length === 0);
      await typeIn('[data-testid="sendbox-input"]', 'too late');
      await humanClick(btn);
      await sleep(250);
      await js(`(() => { const m = document.querySelector('.aiondx-sched-when'); if (m) { const d = new Date(Date.now() - 86400000); const p = n => ('0' + n).slice(-2);
        m.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); } return 0; })()`);
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await js(`(() => { const g = document.querySelector('.aiondx-sched-go'); if (g) g.click(); return 0; })()`);
      await sleep(300);
      check(sc, 'a time that has passed is refused', (await schedKeys()).length === 0 && (await toasts()).some(t => /^That time has passed\./.test(t)), JSON.stringify(await toasts()));

      // A team member's own box.
      await load('team=1&theme=light');
      await typeIn('[data-slot-id="slotB"] [data-testid="sendbox-input"]', 'worker, rerun the seed check');
      await humanClick('[data-slot-id="slotB"] [data-testid="aiondx-sched-btn"]');
      await sleep(250);
      await humanClick('.aiondx-sched-menu .aiondx-sched-quick-item');
      await sleep(500);
      keys = await schedKeys();
      rec = keys.length === 1 ? (await store())[keys[0]] : null;
      check(sc, "in a team column it is scheduled for that member", rec && rec.scope === 'team.team1.slotB' && rec.text === 'worker, rerun the seed check', JSON.stringify(rec));
      check(sc, "and the lead's column has its own button, with nothing waiting", await js(`document.querySelectorAll('[data-testid="aiondx-sched-btn"]').length === 2 && !document.querySelector('[data-slot-id="slotA"] .aiondx-sched-count').textContent`));
      await putStore(keys[0], Object.assign({}, rec, { due: Date.now() - 2000 }));
      await js('window.__aionDx.pullNow()');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.fireSched()');
      await sleep(900);
      p = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'when due it goes to that member through the team', p.length === 1 && p[0].body.content === 'worker, rerun the seed check', JSON.stringify(p));
    }

    // ---- the sidebar's team spinner (R-007, 2026-10-01) ----
    {
      const sc = 'team-spinner';
      await load('team=1&theme=light');
      await js(`(() => { const w = document.createElement('div'); w.id = 'fake-sider';
        w.innerHTML = '<span data-testid="team-spinner-team1" class="flex items-center justify-center"><span class="arco-spin">spin</span></span>';
        document.body.appendChild(w); return 0; })()`);
      await setSlot('slotA', 'running');
      await js('window.__aionDx.spinReset()');
      await sleep(900);
      const spin = () => js(`(() => { const e = document.querySelector('[data-testid="team-spinner-team1"]'); return { idle: e.getAttribute('data-aiondx-idle'), spin: getComputedStyle(e.querySelector('.arco-spin')).display }; })()`);
      let sp = await spin();
      check(sc, 'a team with a member running keeps its spinner', sp.idle === null && sp.spin !== 'none', JSON.stringify(sp));
      await setSlot('slotA', 'idle');
      await setSlot('slotB', 'paused');
      await js("window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work.forEach(w => { w.active_turn_id = null; }); 0");
      await js('window.__aionDx.spinReset()');
      await sleep(900);
      sp = await spin();
      check(sc, 'a team whose members are all idle or paused loses it, and shows its icon instead', sp.idle === '1' && sp.spin === 'none', JSON.stringify(sp));
      await shot('click-test-team-spinner');
      await setSlot('slotB', 'running');
      await js('window.__aionDx.spinReset()');
      await sleep(900);
      sp = await spin();
      check(sc, 'and gets it back when a member starts', sp.idle === null && sp.spin !== 'none', JSON.stringify(sp));
    }

    // ---- local file and folder links that open outside AionUi (R-014, 2026-10-01) ----
    {
      const sc = 'local-links';
      await load('theme=light');
      await js("window.__stub.routes['POST /api/shell/open-file'] = { success: true }; window.__stub.routes['POST /api/shell/show-item-in-folder'] = { success: true }; 0");
      await js(`(() => { const host = document.createElement('div'); host.className = 'markdown-shadow'; host.id = 'md1'; document.body.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<div class="markdown-shadow-body"><p>See <span data-local-file-path="C:/Work/Project/build/"><button class="markdown-local-file-link">the build folder</button><button class="markdown-local-file-copy">c</button></span> and ' +
          '<span data-local-file-path="C:/Work/Project/notes.md"><button class="markdown-local-file-link">the notes</button></span> and <span data-local-file-path="notes.md"><button class="markdown-local-file-link">relative</button></span></p></div>';
        window.__previewClicks = 0;
        root.querySelectorAll('.markdown-local-file-link').forEach(b => b.addEventListener('click', () => { window.__previewClicks++; }));
        return 0; })()`);
      await js('window.__aionDx.decorateLinks()');
      await sleep(500);
      const inShadow = (sel, act) => js(`(() => { const el = document.getElementById('md1').shadowRoot.querySelector(${JSON.stringify(sel)}); ${act}; return 0; })()`);
      const marks = await js(`[...document.getElementById('md1').shadowRoot.querySelectorAll('span[data-local-file-path]')].map(c => [!!c.querySelector('.aiondx-ext'), c.getAttribute('data-aiondx-dir')])`);
      check(sc, 'a link chip with an absolute path gets an open-outside button, and one with a relative path does not', marks[0][0] === true && marks[1][0] === true && marks[2][0] === false, JSON.stringify(marks));
      check(sc, 'a chip for a folder is known as one', marks[0][1] === '1' && marks[1][1] === null, JSON.stringify(marks));
      await js('window.__calls.length = 0; 0');
      await inShadow('span[data-local-file-path$="notes.md"][data-local-file-path^="C:"] .aiondx-ext', 'el.click()');
      await sleep(300);
      let p = await posts('/api/shell/open-file');
      check(sc, "the button opens the file with the system, and not in AionUi's preview", p.length === 1 && p[0].body.file_path === 'C:/Work/Project/notes.md' && (await js('window.__previewClicks')) === 0, JSON.stringify(p));
      await js('window.__calls.length = 0; 0');
      await inShadow('span[data-local-file-path$="notes.md"][data-local-file-path^="C:"] .aiondx-ext', "el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, shiftKey: true }))");
      await sleep(300);
      p = await posts('/api/shell/show-item-in-folder');
      check(sc, 'Shift+click shows it in its folder', p.length === 1 && p[0].body.file_path === 'C:/Work/Project/notes.md', JSON.stringify(p));
      await js('window.__calls.length = 0; 0');
      await inShadow('span[data-local-file-path$="build/"] .markdown-local-file-link', 'el.click()');
      await sleep(300);
      p = await posts('/api/shell/open-file');
      check(sc, "clicking a folder chip opens the folder in Explorer, not AionUi's preview", p.length === 1 && p[0].body.file_path === 'C:/Work/Project/build/' && (await js('window.__previewClicks')) === 0, JSON.stringify(p));
      await js('window.__calls.length = 0; 0');
      await inShadow('span[data-local-file-path$="notes.md"][data-local-file-path^="C:"] .markdown-local-file-link', 'el.click()');
      await sleep(300);
      check(sc, "clicking a file chip still previews it in AionUi", (await posts('/api/shell/open-file')).length === 0 && (await js('window.__previewClicks')) === 1);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.decorateLinks()');
      await sleep(200);
      check(sc, 'looking again adds no second button', (await js(`document.getElementById('md1').shadowRoot.querySelectorAll('.aiondx-ext').length`)) === 2);
    }

    // ---- Stop must stop (R-017, 2026-10-01): the draft box does not restart the agent after Stop ----
    {
      const sc = 'stop-holds-draft-box';
      // AionUi's CommandQueuePanel as it renders: a box labelled with its title, a header with a mode toggle that flips between "Auto send"
      // and "Manual send", and the list of waiting commands (data-command-queue-list).
      const fakeBox = (where, mode) => js(`(() => { const at = document.querySelector(${JSON.stringify(where)}); const box = document.createElement('div'); box.className = 'fake-draft-box';
        box.setAttribute('aria-label', 'Draft box');
        box.innerHTML = '<div><button type="button" aria-label="Toggle send mode">${mode}</button></div><div><div data-command-queue-list="true"><div>queued one</div></div></div>';
        box.querySelector('button').addEventListener('click', (e) => { e.currentTarget.textContent = e.currentTarget.textContent === 'Auto send' ? 'Manual send' : 'Auto send'; window.__toggles = (window.__toggles || 0) + 1; });
        at.parentNode.insertBefore(box, at); return 0; })()`);
      const mode = (scope) => js(`(() => { const b = document.querySelector(${JSON.stringify((scope ? scope + ' ' : '') + '.fake-draft-box button')}); return b ? b.textContent : null; })()`);
      const addStop = (scope) => js(`(() => { const a = document.querySelector(${JSON.stringify(scope + ' .sendbox-actions')}); const b = document.createElement('button'); b.type = 'button';
        b.className = 'arco-btn arco-btn-secondary arco-btn-shape-circle sendbox-stop-button'; b.textContent = 'stop'; a.appendChild(b); return 0; })()`);

      // A solo chat, draft box on Auto, Loop off: Stop puts it on Manual, and says so.
      await load('theme=light');
      await fakeBox('#solo .sendbox-panel', 'Auto send');
      await addStop('#solo');
      await js('window.__toggles = 0; document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await humanClick('#solo .sendbox-stop-button');
      await sleep(400);
      check(sc, "Stop puts a draft box that sends by itself on Manual send, so it cannot start the agent again", (await mode('')) === 'Manual send' && (await js('window.__toggles')) === 1, await mode(''));
      check(sc, 'and says so, and that its messages are still in it', (await toasts()).some((t) => /is on Manual send now, so it does not start the agent again after Stop\. Its messages are still in it\./.test(t)), JSON.stringify(await toasts()));
      await humanClick('#solo .sendbox-stop-button');
      await sleep(300);
      check(sc, 'a second Stop leaves a box that is already on Manual alone', (await mode('')) === 'Manual send' && (await js('window.__toggles')) === 1);
      // With no draft box there is nothing to hold, and nothing breaks.
      await load('theme=light');
      await addStop('#solo');
      await humanClick('#solo .sendbox-stop-button');
      await sleep(200);
      check(sc, 'with no draft box, Stop does what it did before', (await toasts()).filter((t) => /draft box/.test(t)).length === 0);
      // A team: Stop in one member's column holds that column's box and no other.
      await load('team=1&theme=light');
      await fakeBox('[data-slot-id="slotA"] .sendbox-panel', 'Auto send');
      await fakeBox('[data-slot-id="slotB"] .sendbox-panel', 'Auto send');
      await addStop('[data-slot-id="slotB"]');
      await humanClick('[data-slot-id="slotB"] .sendbox-stop-button');
      await sleep(400);
      check(sc, "Stop in a team member's column holds that member's draft box only", (await mode('[data-slot-id="slotB"]')) === 'Manual send' && (await mode('[data-slot-id="slotA"]')) === 'Auto send', JSON.stringify([await mode('[data-slot-id="slotB"]'), await mode('[data-slot-id="slotA"]')]));
      await shot('click-test-stop-draft-box');
    }

    // ---- shared with agents (P-010, 2026-09-24) ----
    // The Loop's settings live in /api/settings/client, where the agents' Loop tool
    // (patches\0007-loop-tool) reads and writes the same records.
    {
      const sc = 'shared-write';
      await load('theme=light');
      await armVia('');
      let rec = (await store())[SOLO_KEY];
      check(sc, 'switching on from the menu writes the shared record', rec && rec.on === true && rec.by === 'user' && rec.who === 'the user' && rec.msg === DEFAULT_MSG && rec.at > 0, JSON.stringify(rec));
      await humanClick('.aiondx-loop button');
      await js(`(() => { const ta = document.querySelector('.aiondx-textarea'); ta.value = 'Finish the siege AI, then the map tests.'; ta.dispatchEvent(new Event('input')); return 0; })()`);
      rec = (await store())[SOLO_KEY];
      check(sc, 'an edited message is not written on every keystroke', rec.msg === DEFAULT_MSG, rec.msg);
      await sleep(1100);
      rec = (await store())[SOLO_KEY];
      check(sc, 'it is written once typing pauses', rec.msg === 'Finish the siege AI, then the map tests.' && rec.by === 'user', rec.msg);
      await humanClick('.aiondx-menu [data-choice="off"]');
      rec = (await store())[SOLO_KEY];
      check(sc, 'switching off from the menu writes it too', rec.on === false && rec.by === 'user', JSON.stringify(rec));
    }
    {
      const sc = 'shared-read';
      await load('theme=light');
      await putStore(SOLO_KEY, { v: 1, on: true, msg: 'Agent wrote this nudge.', compactAt: 0, rev: 1, by: 'agent', who: 'Harness agent', for: 'Harness agent', at: Date.now(), note: 'long list ahead' });
      await js('window.__aionDx.pullNow()');
      await sleep(200);
      check(sc, "an agent's switch-on shows on the button", (await label('')) === 'Loop · On');
      check(sc, 'with the purple mark', await js('document.querySelector(".aiondx-loop").classList.contains("aiondx-loop--agent")'));
      const tt = await toasts();
      check(sc, 'and a notice naming the agent, what it did, and its note', tt.length === 1 && /^Harness agent switched the Loop on and changed the continue message\.long list ahead$/.test(tt[0]), JSON.stringify(tt));
      check(sc, 'the notice names the chat', (await toastWheres())[0].where === 'Chat: Harness', JSON.stringify(await toastWheres()));
      const aria = await js('document.querySelector(".aiondx-loop button").getAttribute("aria-label")');
      check(sc, 'the aria-label says who changed it', /changed by Harness agent at \d\d:\d\d/.test(aria || ''), aria);
      await hover('.aiondx-loop button');
      const t = await tipInfo();
      check(sc, 'the hover card says who changed it, when, and why', t && /Last changed by Harness agent at \d\d:\d\d: long list ahead\./.test(t.text) && /An agent changed the Loop/.test(t.legend2), t && t.text);
      await unhover();
      await js('window.__aionDx.pullNow()');
      check(sc, 'the notice is shown once', (await toasts()).length === 1);
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const p = await posts('/api/conversations/harness1/messages');
      check(sc, "the nudge sends the agent's message", p.length === 1 && p[0].body.content === LOOP_TAG + 'Agent wrote this nudge.', JSON.stringify(p));
      await putStore(SOLO_KEY, { v: 1, on: false, msg: 'Agent wrote this nudge.', compactAt: 0, rev: 2, by: 'agent', who: 'Harness agent', for: 'Harness agent', at: Date.now() + 5, note: 'done for today' });
      await js('window.__aionDx.pullNow()');
      await sleep(200);
      check(sc, "an agent's switch-off turns it off", (await label('')) === 'Loop · Off');
      await humanClick('.aiondx-loop button');
      const menuText = await js('document.querySelector(".aiondx-menu").textContent');
      check(sc, 'the menu says who switched it off and why', /Off: by Harness agent \(done for today\)\./.test(menuText) && /Last changed by Harness agent at \d\d:\d\d: done for today\./.test(menuText), menuText);
      await humanClick('.aiondx-loop button');
      const older = Date.now() - 5 * 60000;
      await putStore(SOLO_KEY, { v: 1, on: true, msg: 'x', compactAt: 0, rev: 3, by: 'agent', who: 'Harness agent', for: 'Harness agent', at: Date.now() + 10, note: '' });
      await js(`(() => { window.__stub.store[${JSON.stringify(SOLO_KEY)}].at = ${older}; return 0; })()`);
      await js(`(() => { const k = 'aionui.dx.harness1'; const s = JSON.parse(localStorage.getItem(k)); s.sharedAt = ${older - 1}; localStorage.setItem(k, JSON.stringify(s)); return 0; })()`);
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await js('window.__aionDx.pullNow()');
      check(sc, 'a change read late (5 min old) marks the button without a notice', (await toasts()).length === 0 && (await label('')) === 'Loop · On', JSON.stringify(await toasts()));
    }
    {
      const sc = 'shared-team';
      await load('team=1&theme=light');
      await putStore('aiondx.loop.team.team1.slotB', { v: 1, on: true, msg: DEFAULT_MSG, compactAt: 0, rev: 1, by: 'agent', who: 'Lead', for: 'Worker', at: Date.now(), note: 'tournament is done, carry on' });
      await js('window.__aionDx.pullNow()');
      await sleep(200);
      check(sc, "the lead's change switches the worker's Loop on", (await label('[data-slot-id="slotB"]')) === 'Loop · On' && (await label('[data-slot-id="slotA"]')) === 'Loop · Off');
      const tt = await toasts();
      check(sc, 'the notice says whose Loop it was', tt.length === 1 && tt[0].indexOf('Lead switched the Loop on for Worker.') === 0, JSON.stringify(tt));
      const tw = await toastWheres();
      check(sc, 'and names the team and member, linking to the team', tw.length === 1 && tw[0].where === 'Harness Team · Worker' && tw[0].href === '#/team/team1', JSON.stringify(tw));
      await js(`(() => { location.hash = '#/conversation/harness1'; return 0; })()`);
      await sleep(300);
      await humanClick('.aiondx-toasts .aiondx-toast');
      check(sc, 'clicking the notice opens that team', (await js('location.hash')) === '#/team/team1' && (await toasts()).length === 0, await js('location.hash'));
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'and the worker is nudged through the team', (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);

      // A Loop an agent switched on for a team whose page is not open: only the store knows it.
      await load('theme=light');
      await putStore('aiondx.loop.team.team1.slotB', { v: 1, on: true, msg: DEFAULT_MSG, compactAt: 0, rev: 1, by: 'agent', who: 'Lead', for: 'Worker', at: Date.now(), note: '' });
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      check(sc, 'a Loop only the store knows is still ticked, page closed', (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);
    }
    {
      const sc = 'shared-status';
      await load('theme=light');
      await armVia('');
      await js('window.__aionDx.tickNow()');
      const s = await store();
      const st = s['aiondx.loopstatus.conv.harness1'];
      check(sc, 'what the Loop decided is published for loop_status', st && st.on === true && st.fires === 1 && /^Sent a nudge at \d\d:\d\d\.$/.test(st.why) && st.lastFired > 0, JSON.stringify(st));
      check(sc, 'and the engine says it is running, with its build', s['aiondx.engine'] && s['aiondx.engine'].build === (await js('window.__aionDx.build')) && Date.now() - s['aiondx.engine'].at < 30000, JSON.stringify(s['aiondx.engine']));
      const putsBefore = await js("window.__calls.filter(c => c.method === 'PUT').length");
      await js('window.__aionDx.tickNow()');
      await js('window.__aionDx.tickNow()');
      const putsAfter = await js("window.__calls.filter(c => c.method === 'PUT').length");
      check(sc, 'nothing is rewritten while nothing changes', putsAfter - putsBefore <= 1, putsAfter - putsBefore);
    }
    {
      const sc = 'migrate';
      await load('theme=light&on=1');
      await sleep(400);
      const rec = (await store())[SOLO_KEY];
      check(sc, 'a Loop saved before agents could see it is written to the store', rec && rec.on === true && rec.by === 'user', JSON.stringify(rec));
    }
    {
      const sc = 'no-store';
      await load('theme=light&nostore=1');
      await armVia('');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const puts = await js("window.__calls.filter(c => c.method === 'PUT').length");
      check(sc, 'with no store (an older backend) it runs as before and writes nothing', puts === 0 && (await posts('/api/conversations/harness1/messages')).length === 1, puts);
    }
    {
      const sc = 'compact';
      // A request of 2026-10-01: the Loop menu has no compaction item. An agent can still ask for one through the Loop tool.
      await load('theme=light');
      await humanClick('.aiondx-loop button');
      await sleep(300);
      check(sc, 'the Loop menu has no compaction item', await js('!document.querySelector(".aiondx-menu .aiondx-compact") && !/Compact/i.test(document.querySelector(".aiondx-menu").textContent)'));
      await humanClick('.aiondx-loop button');

      await load('team=1&theme=light');
      await js('window.__calls.length = 0; 0');
      await putStore('aiondx.loop.team.team1.slotA', { v: 1, on: false, msg: DEFAULT_MSG, compactAt: Date.now(), rev: 1, by: 'agent', who: 'Lead', for: 'Worker A', at: Date.now(), note: 'context is heavy' });
      await js('window.__aionDx.tickNow()');
      await sleep(300);
      check(sc, 'a member that is working gets it later, not now', (await posts('/api/teams/team1/agents/slotA/messages')).length === 0);
      await hover('[data-slot-id="slotA"] .aiondx-loop button');
      const t = await tipInfo();
      check(sc, 'the hover card says a compaction is waiting', t && /Compaction asked for at \d\d:\d\d; it goes out when the agent stops\./.test(t.now), t && t.now);
      await unhover();
      await setSlot('slotA', 'idle');
      await js('window.__aionDx.tickNow()');
      const toA = await posts('/api/teams/team1/agents/slotA/messages');
      check(sc, 'once it stops, /compact goes through the team', toA.length === 1 && toA[0].body.content === '/compact', JSON.stringify(toA));

      // An agent asks for it through the tool.
      await load('theme=light');
      await putStore(SOLO_KEY, { v: 1, on: false, msg: DEFAULT_MSG, compactAt: Date.now(), rev: 1, by: 'agent', who: 'Harness agent', for: 'Harness agent', at: Date.now(), note: 'context is heavy' });
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const pa = await posts('/api/conversations/harness1/messages');
      check(sc, "an agent's request is sent the same way", pa.length === 1 && pa[0].body.content === '/compact', JSON.stringify(pa));
      const tt = await toasts();
      check(sc, 'with a notice that the agent asked for it', tt.length === 1 && /^Harness agent asked for a compaction\.context is heavy$/.test(tt[0]), JSON.stringify(tt));
      await shot('click-test-agent-notice');
    }

    // ---- the desktop app's backend address (2026-09-24) ----
    // AionUi's desktop window is not served by the backend; the preload sets window.__backendPort and
    // every request must go to http://127.0.0.1:<port>. Until build 2026-09-24.4 the Loop used
    // same-origin paths, so in the real app none of its requests reached the backend, while this page
    // (which stubs fetch) passed every check.
    {
      const sc = 'backend-port';
      await load('theme=light');
      await js('window.__backendPort = 45678; 0');
      await armVia('');
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      await js('window.__aionDx.pullNow()');
      const urls = await js('window.__calls.map(c => c.url)');
      const rel = urls.filter((u) => !/^http:\/\/127\.0\.0\.1:45678\/api\//.test(u));
      check(sc, 'with window.__backendPort set, every Loop request goes to http://127.0.0.1:<port>', urls.length > 0 && rel.length === 0, JSON.stringify(rel.slice(0, 4)));
      const p = await posts('/api/conversations/harness1/messages');
      check(sc, 'and the nudge still goes out', p.length === 1 && p[0].url === 'http://127.0.0.1:45678/api/conversations/harness1/messages', JSON.stringify(p.map((x) => x.url)));
      check(sc, 'the shared store is read and written there too', urls.some((u) => u === 'http://127.0.0.1:45678/api/settings/client') &&
        (await js("window.__calls.some(c => c.method === 'PUT' && c.url === 'http://127.0.0.1:45678/api/settings/client')")), JSON.stringify(urls.slice(0, 6)));
      await js("(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.session_generation = null; return 0; })()");
      await js('window.__calls.length = 0; 0');
      const held = await js("fetch('http://127.0.0.1:45678/api/teams/team1/session', { method: 'POST', credentials: 'include' }).then(r => r.json())");
      const sawRunState = await js("window.__calls.some(c => c.url === 'http://127.0.0.1:45678/api/teams/team1/run-state')");
      const sessionPosted = await js("window.__calls.some(c => c.method === 'POST' && /\\/session$/.test(c.path))");
      check(sc, 'the team-wake guard asks run-state at the backend address and holds the call', held && held.success === true && sawRunState && !sessionPosted, JSON.stringify({ held, sawRunState, sessionPosted }));
      await js('delete window.__backendPort; 0');
    }

    // ---- the AionDX accent row on Settings > Appearance (patch 0009, 2026-09-25) ----
    {
      const sc = 'accent';
      await load('theme=dark');
      // Stand-in for AionUi's theme gallery: cards carry data-testid="theme-card-<id>".
      await js(`(() => { const sec = document.createElement('section'); sec.id = 'fake-appearance';
        const grid = document.createElement('div'); grid.className = 'grid';
        ['light', 'dark', 'aiondx-dark'].forEach(id => { const c = document.createElement('div'); c.setAttribute('data-testid', 'theme-card-' + id); c.textContent = id; grid.appendChild(c); });
        sec.appendChild(grid); document.body.appendChild(sec); return 0; })()`);
      await sleep(400);
      const placed = await js(`(() => { const p = document.querySelector('[data-testid="aiondx-accent"]'); return p ? { after: p.previousElementSibling && p.previousElementSibling.className, swatches: p.querySelectorAll('.aiondx-swatch').length, text: p.textContent } : null; })()`);
      check(sc, 'an AionDX colours row appears right under the theme gallery', placed && placed.after === 'grid' && placed.swatches === 7 && /AionDX colours/.test(placed.text), JSON.stringify(placed));
      await humanClick('[data-testid="aiondx-accent"] .aiondx-swatch[data-color="#a78bfa"]');
      const css1 = await js("(document.getElementById('aiondx-accent-vars') || {}).textContent || ''");
      check(sc, 'a swatch sets --aiondx-accent and its RGB forms', /--aiondx-accent:#a78bfa !important/.test(css1) && /--aiondx-accent-rgb:167, 139, 250 !important/.test(css1), css1);
      const stored = (await store())['aiondx.theme'];
      check(sc, 'the choice goes to the settings store', stored && stored.accent === '#a78bfa' && stored.dividers === true, JSON.stringify(stored));
      check(sc, 'the chosen swatch is marked', await js(`document.querySelector('.aiondx-swatch[data-color="#a78bfa"]').getAttribute('aria-checked') === 'true'`));
      await humanClick('[data-testid="aiondx-accent"] .aiondx-accent-dividers');
      const css2 = await js("(document.getElementById('aiondx-accent-vars') || {}).textContent || ''");
      check(sc, 'switching accent dividers off points them at neutral grey', /--aiondx-divider:#252525 !important/.test(css2) && (await store())['aiondx.theme'].dividers === false, css2);
      await shot('click-test-accent');
      await load('theme=dark&keepls=1');
      const kept = await js("(document.getElementById('aiondx-accent-vars') || {}).textContent || ''");
      check(sc, 'after a reload the choice applies at once, before the store answers', /--aiondx-accent:#a78bfa/.test(kept), kept);
    }


    // ---- drafts that survive closing the app (2026-09-26) ----
    {
      const sc = 'drafts';
      await load('theme=light');
      await humanClick('[data-testid="sendbox-input"]');
      await send('Input.insertText', { text: 'half a thought about the siege AI' });
      await sleep(300);
      const local = await js(`JSON.parse(localStorage.getItem('aionui.dx.draft.conv.harness1') || 'null')`);
      check(sc, 'what you type is saved locally as you type', local && local.text === 'half a thought about the siege AI', JSON.stringify(local));
      await sleep(2300);
      const st = (await store())['aiondx.draft.conv.harness1'];
      check(sc, 'and to the settings store once typing pauses', st && st.text === 'half a thought about the siege AI', JSON.stringify(st));
      // Close and reopen (localStorage survives, as it does in AionUi).
      await load('theme=light&keepls=1');
      await sleep(1500);
      const back = await js(`document.querySelector('[data-testid="sendbox-input"]').value`);
      check(sc, 'after a restart the box gets the draft back', back === 'half a thought about the siege AI', back);
      // A send empties the box (AionUi clears it without an input event): the saved copy goes too.
      await js(`(() => { document.querySelector('[data-testid="sendbox-input"]').value = ''; return 0; })()`);
      await sleep(1300);
      const gone = await js(`localStorage.getItem('aionui.dx.draft.conv.harness1')`);
      check(sc, 'once the box is sent or cleared, the saved draft is removed', gone === null, gone);
      await load('theme=light&keepls=1');
      await sleep(1500);
      check(sc, 'and nothing comes back after the next restart', (await js(`document.querySelector('[data-testid="sendbox-input"]').value`)) === '');
      // Only the store copy survived (a crash lost localStorage): it comes back from there.
      await load('theme=light&seeddraft=' + encodeURIComponent('from the backend copy'));
      await sleep(1500);
      check(sc, 'a draft only the settings store kept still comes back', (await js(`document.querySelector('[data-testid="sendbox-input"]').value`)) === 'from the backend copy');
      // Team columns keep their own drafts.
      await load('team=1&theme=light');
      await humanClick('[data-slot-id="slotB"] [data-testid="sendbox-input"]');
      await send('Input.insertText', { text: 'for the worker only' });
      await sleep(300);
      const tl = await js(`[localStorage.getItem('aionui.dx.draft.team.team1.slotB'), localStorage.getItem('aionui.dx.draft.team.team1.slotA')]`);
      check(sc, "a team member's box has its own draft", tl[0] && JSON.parse(tl[0]).text === 'for the worker only' && tl[1] === null, JSON.stringify(tl));
    }

    // ---- background colours for dark and light mode (2026-09-26) ----
    {
      const sc = 'backgrounds';
      await load('theme=dark');
      await js(`(() => { const sec = document.createElement('section'); const grid = document.createElement('div'); grid.className = 'grid';
        ['light', 'dark', 'aiondx-dark'].forEach(id => { const c = document.createElement('div'); c.setAttribute('data-testid', 'theme-card-' + id); c.textContent = id; grid.appendChild(c); });
        sec.appendChild(grid); document.body.appendChild(sec); return 0; })()`);
      await sleep(400);
      const pick = (mode, hex) => js(`(() => { const i = document.querySelector('.aiondx-bg-pick[data-mode="${mode}"] input'); i.value = '${hex}';
        i.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
      check(sc, 'the colours row has a Dark and a Light background choice', (await js(`document.querySelectorAll('.aiondx-bg-pick').length`)) === 2);
      await pick('dark', '#102030');
      await sleep(500);
      const css = await js(`(document.getElementById('aiondx-accent-vars') || {}).textContent || ''`);
      check(sc, "picking a dark background sets dark mode's backdrop and steps its other surfaces from it",
        /html:root\[data-theme='dark'\]\{--bg-base:#102030 !important;--bg-1:color-mix\(in srgb, #102030 97%, #ffffff\) !important/.test(css) &&
        /body\[arco-theme='dark'\]\{--color-bg-1:color-mix\(in srgb, #102030 97%, #ffffff\) !important/.test(css), css.slice(0, 400));
      const live = await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()`);
      check(sc, 'and the page uses it now', live === '#102030', live);
      check(sc, 'the choice goes to the settings store', ((await store())['aiondx.theme'] || {}).bgDark === '#102030', JSON.stringify((await store())['aiondx.theme']));
      await pick('light', '#f4efe6');
      await sleep(500);
      const css2 = await js(`(document.getElementById('aiondx-accent-vars') || {}).textContent || ''`);
      check(sc, "a light background steps toward black, and the dark one stays",
        /html:root\[data-theme='light'\]\{--bg-base:#f4efe6 !important;--bg-1:color-mix\(in srgb, #f4efe6 97%, #000000\)/.test(css2) && /#102030/.test(css2), css2.slice(0, 200));
      await humanClick('.aiondx-bg-reset[data-mode="dark"]');
      await sleep(300);
      const css3 = await js(`(document.getElementById('aiondx-accent-vars') || {}).textContent || ''`);
      check(sc, 'Reset puts dark mode back on its theme', !/#102030/.test(css3) && /#f4efe6/.test(css3) && ((await store())['aiondx.theme'] || {}).bgDark === null, css3.slice(0, 200));
      await shot('click-test-backgrounds');
    }

    // ---- the context ring's colour zones (R-008, 2026-10-01) ----
    {
      const sc = 'ctx-ring';
      await load('theme=dark');
      const fill = (pct) => js(`(() => { const c = document.querySelector('.context-usage-indicator circle:nth-of-type(2)');
        c.setAttribute('stroke-dashoffset', String(56.5487 * (1 - ${pct} / 100))); return 0; })()`);
      const ring = () => js(`getComputedStyle(document.querySelector('.context-usage-indicator circle:nth-of-type(2)')).stroke`);
      await sleep(300);
      check(sc, 'a ring that is 30% full is blue by default', (await ring()) === 'rgb(59, 130, 246)', await ring());
      const seen = [];
      for (const pct of [50, 65, 80, 95]) { await fill(pct); await sleep(450); seen.push(await ring()); }
      check(sc, 'then green, yellow, orange and red as it fills', JSON.stringify(seen) === JSON.stringify(['rgb(34, 197, 94)', 'rgb(234, 179, 8)', 'rgb(249, 115, 22)', 'rgb(239, 68, 68)']), JSON.stringify(seen));
      await js(`(() => { const sec = document.createElement('section'); const grid = document.createElement('div'); grid.className = 'grid';
        ['light', 'dark', 'aiondx-dark'].forEach(id => { const c = document.createElement('div'); c.setAttribute('data-testid', 'theme-card-' + id); c.textContent = id; grid.appendChild(c); });
        sec.appendChild(grid); document.body.appendChild(sec); return 0; })()`);
      await sleep(500);
      const rows = await js(`[...document.querySelectorAll('.aiondx-ctx-row')].map(r => [r.querySelector('.aiondx-ctx-color').value, r.querySelector('.aiondx-ctx-from').value, r.querySelector('.aiondx-ctx-from').disabled])`);
      check(sc, 'Settings > Appearance has five zones, each with a colour and a start percentage', rows.length === 5 && rows[0][0] === '#3b82f6' && rows[0][2] === true && rows[2][1] === '60' && rows[4][0] === '#ef4444', JSON.stringify(rows));
      const set = (i, sel, v) => js(`(() => { const e = document.querySelectorAll('.aiondx-ctx-row')[${i}].querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
      await set(2, '.aiondx-ctx-color', '#ff00ff');
      await set(4, '.aiondx-ctx-from', '97');
      await sleep(600);
      await fill(65); await sleep(450);
      const c65 = await ring();
      await fill(95); await sleep(450);
      const c95 = await ring();
      check(sc, 'a changed colour and a changed start take effect on the ring', c65 === 'rgb(255, 0, 255)' && c95 === 'rgb(249, 115, 22)', JSON.stringify([c65, c95]));
      const st = ((await store())['aiondx.theme'] || {}).ctx;
      check(sc, 'and go to the settings store', st && st.zones && st.zones.length === 5 && st.zones[2].color === '#ff00ff' && st.zones[4].from === 97, JSON.stringify(st));
      await set(1, '.aiondx-ctx-from', '70');
      await sleep(600);
      const back = await js(`[...document.querySelectorAll('.aiondx-ctx-row .aiondx-ctx-from')].map(i => i.value)`);
      check(sc, 'a start that would pass the next zone is held below it', back[1] === '70' && Number(back[2]) > 70 && Number(back[3]) > Number(back[2]), JSON.stringify(back));
      await js('document.querySelector(".aiondx-ctx-reset").scrollIntoView({ block: "center" }); 0');
      await humanClick('.aiondx-ctx-reset');
      await sleep(400);
      await fill(65); await sleep(450);
      check(sc, 'Reset puts the default zones back', (await ring()) === 'rgb(234, 179, 8)' && ((await store())['aiondx.theme'] || {}).ctx === null, await ring());
      await shot('click-test-ctx-ring');
    }

    // ---- Antigravity sign-in panel (patch 0008, 2026-09-24) ----
    {
      const sc = 'agy-signin';
      await load('theme=light');
      await putStore('aiondx.agy.signin', { state: 'waiting', message: 'A sign-in page opened in your browser; finish it there.', conversation: '666280ed', at: Date.now() });
      await js('window.__aionDx.pullNow()');
      const panel = await js('(() => { const p = document.querySelector(".aiondx-signin"); return p ? p.textContent : null; })()');
      check(sc, 'a waiting sign-in shows the panel with its message', panel && /^Sign in to Antigravity/.test(panel) && /A sign-in page opened in your browser/.test(panel), panel);
      await js(`(() => { const i = document.querySelector('.aiondx-signin-code'); i.value = 'not a code'; return 0; })()`);
      await humanClick('.aiondx-signin-send');
      check(sc, 'text that is not a code is refused and nothing is sent', !(await store())['aiondx.agy.signin.code'] &&
        /does not look like/.test(await js('document.querySelector(".aiondx-signin-note").textContent')));
      await js(`(() => { const i = document.querySelector('.aiondx-signin-code'); i.value = '  4/0AAAAtestcodeXYZ_123-abc  '; return 0; })()`);
      await humanClick('.aiondx-signin-send');
      const sent = (await store())['aiondx.agy.signin.code'];
      check(sc, 'a pasted code goes to the store, trimmed, for the wrapper', sent && sent.code === '4/0AAAAtestcodeXYZ_123-abc' && Date.now() - sent.at < 10000, JSON.stringify(sent));
      await shot('click-test-agy-signin');
      // A Stop in the chat kills the wrapper mid-sign-in and nothing marks it failed: the panel can be closed.
      await humanClick('.aiondx-signin-close');
      check(sc, 'the close button hides the panel', !(await js('!!document.querySelector(".aiondx-signin")')));
      await js('window.__aionDx.pullNow()');
      check(sc, 'and the same sign-in does not bring it back', !(await js('!!document.querySelector(".aiondx-signin")')));
      await putStore('aiondx.agy.signin', { state: 'waiting', message: 'Code received; finishing the sign-in.', conversation: '666280ed', at: Date.now() + 1 });
      await js('window.__aionDx.pullNow()');
      check(sc, 'a newer sign-in record shows it again', await js('!!document.querySelector(".aiondx-signin")'));
      await humanClick('.aiondx-signin-close');
      await putStore('aiondx.agy.signin', { state: 'done', message: 'Antigravity is signed in.', conversation: '666280ed', at: Date.now() });
      await js('window.__aionDx.pullNow()');
      check(sc, 'when the sign-in lands, even with the panel closed, a notice says so', !(await js('!!document.querySelector(".aiondx-signin")')) &&
        (await toasts()).some((t) => /^Antigravity is signed in\./.test(t)), JSON.stringify(await toasts()));
      check(sc, 'the notice links to the chat the sign-in came from', (await toastWheres()).some((w) => w.href === '#/conversation/666280ed' && /^Chat: /.test(w.where)), JSON.stringify(await toastWheres()));
      await putStore('aiondx.agy.signin', { state: 'waiting', message: 'old', conversation: '666280ed', at: Date.now() - 20 * 60000 });
      await js('window.__aionDx.pullNow()');
      check(sc, 'a stale wait (over 16 minutes) shows nothing', !(await js('!!document.querySelector(".aiondx-signin")')));
    }


    // ---- the chat's agent (2026-09-26; the account pill of 2026-09-25 before it) ----
    {
      const sc = 'agent';
      await load('theme=light');
      await sleep(600);
      await js('window.__aionDx.repaint()');
      await sleep(300);
      const ctl = (scope) => js(`(() => { const b = document.querySelector(${JSON.stringify((scope ? scope + ' ' : '') + '[data-testid="aiondx-account"]')}); if (!b) return null;
        const r = b.getBoundingClientRect(); const n = b.nextElementSibling; const nr = n ? n.getBoundingClientRect() : null;
        return { label: b.textContent.trim(), agent: b.getAttribute('data-agent'), chosen: b.classList.contains('aiondx-acct--chosen'),
          compact: b.classList.contains('aiondx-acct--compact'), next: n ? (n.getAttribute('data-testid') || n.className) : null,
          w: Math.round(r.width), h: Math.round(r.height), dy: nr ? Math.abs((r.top + r.height / 2) - (nr.top + nr.height / 2)) : null,
          aria: b.getAttribute('aria-label') }; })()`);
      const menuItems = () => js(`[...document.querySelectorAll('.aiondx-acct-menu .arco-dropdown-menu-item')].map(i => ({ agent: i.getAttribute('data-agent'),
        assistant: i.getAttribute('data-assistant'), on: i.getAttribute('aria-checked'), text: i.textContent, group: i.parentElement.getAttribute('data-group') }))`);
      let p = await ctl('');
      check(sc, "a Claude chat gets the agent control just left of AionUi's model picker, named for its own agent",
        p && p.next === 'acp-model-selector' && p.label === 'Main' && p.agent === 'cc33dd44' && !p.chosen, JSON.stringify(p));
      check(sc, 'its tooltip names the agent in full', p && p.aria === 'Agent: Claude Code (Main). Click to switch this chat to another agent.', p && p.aria);
      await humanClick('[data-testid="aiondx-account"]');
      await sleep(300);
      let items = await menuItems();
      const here = items.filter((i) => i.group === 'here'), fresh = items.filter((i) => i.group === 'new');
      const own = here.find((i) => i.agent === 'cc33dd44'), other = here.find((i) => i.agent === 'aa11bb22');
      check(sc, "the menu lists the new-chat list's Claude agents in its order, its own checked",
        here.length === 2 && here[0] === other && own && own.on === 'true' && /This chat's own agent/.test(own.text) && other.on === 'false', JSON.stringify(here));
      check(sc, 'and every other enabled agent under "Continue in a new chat with", the switched-off Butler left out',
        fresh.map((i) => i.assistant).join() === 'bare:codex,bare:a9f3c21e', JSON.stringify(fresh));
      await humanClick('.aiondx-acct-menu [data-agent="aa11bb22"]');
      const conf = await js(`(document.querySelector('.aiondx-acct-menu') || {}).textContent || ''`);
      check(sc, 'switching to the other Claude agent asks first, and says where the chat goes',
        /^Move this chat to Claude Code \(Second\)\?/.test(conf) && /goes to that agent's account and its organization/.test(conf), conf);
      await putStore('aiondx.usage.conv.harness1', { acct: 'k1', at: Date.now() });
      await js('window.__calls.length = 0; 0');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await humanClick('.aiondx-acct-menu .aiondx-acct-move');
      await sleep(400);
      let st = await store();
      check(sc, "a moved chat forgets which account's usage it was reading, so a limit on the old account cannot hold its Loop back", !st['aiondx.usage.conv.harness1']);
      const restarts = await js(`window.__calls.filter(c => c.method === 'POST' && c.path === '/api/conversations/harness1/runtime/restart').length`);
      check(sc, "Move it records the agent for the Claude launcher and restarts the chat's agent",
        st['aiondx.agent.conv.harness1'] && st['aiondx.agent.conv.harness1'].agent === 'aa11bb22' && restarts === 1, JSON.stringify([st['aiondx.agent.conv.harness1'], restarts]));
      p = await ctl('');
      check(sc, 'the control shows the new agent, marked as chosen for this chat', p && p.label === 'Second' && p.chosen && /its own is Claude Code \(Main\)/.test(p.aria), JSON.stringify(p));
      const tt = await toasts();
      check(sc, 'a notice says it moved, naming the chat', tt.length === 1 && /^Moved to Claude Code \(Second\)\. The agent restarted and carries on there\./.test(tt[0]) &&
        (await toastWheres())[0].where === 'Chat: Harness', JSON.stringify([tt, await toastWheres()]));
      // Back to its own agent: the choice is removed.
      await humanClick('[data-testid="aiondx-account"]');
      await sleep(200);
      await humanClick('.aiondx-acct-menu [data-agent="cc33dd44"]');
      await humanClick('.aiondx-acct-menu .aiondx-acct-move');
      await sleep(400);
      check(sc, 'moving back to its own agent removes the choice', !(await store())['aiondx.agent.conv.harness1'] && (await ctl('')).label === 'Main');
      // The first version's pick (an account name) still shows, and a new pick replaces it.
      await putStore('aiondx.accounts', { v: 1, accounts: [{ id: 'main', label: 'Main (Plan A)' }, { id: 'second', label: 'Second' }],
        agents: { cc33dd44: 'main', 'aa11bb22': 'second' }, defaultAccount: 'main' });
      await putStore('aiondx.account.conv.harness1', { account: 'second', at: Date.now(), by: 'user' });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      p = await ctl('');
      check(sc, "a chat moved by the first version's account pill shows that account's agent", p && p.label === 'Second' && p.chosen, JSON.stringify(p));
      await humanClick('[data-testid="aiondx-account"]');
      await sleep(200);
      await humanClick('.aiondx-acct-menu [data-agent="cc33dd44"]');
      await humanClick('.aiondx-acct-menu .aiondx-acct-move');
      await sleep(400);
      st = await store();
      check(sc, 'and moving it back clears that old record too', !st['aiondx.account.conv.harness1'] && !st['aiondx.agent.conv.harness1'] && (await ctl('')).label === 'Main',
        JSON.stringify(st['aiondx.account.conv.harness1']));
      // Not while it works.
      await js(`(() => { window.__stub.routes['GET /api/conversations/harness1'].data.status = 'running'; return 0; })()`);
      await js('window.__aionDx.pulseNow()');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await humanClick('[data-testid="aiondx-account"]');
      await sleep(200);
      await humanClick('.aiondx-acct-menu [data-agent="aa11bb22"]');
      await humanClick('.aiondx-acct-menu .aiondx-acct-move');
      await sleep(400);
      check(sc, 'while the agent works it is not moved, and says so', !(await store())['aiondx.agent.conv.harness1'] && /^Not moved: this chat is working\./.test((await toasts())[0] || ''), JSON.stringify(await toasts()));
      await js(`(() => { window.__stub.routes['GET /api/conversations/harness1'].data.status = 'finished'; return 0; })()`);
      await js('window.__aionDx.pulseNow()');
      // Another kind of agent: a new chat in the same folder, this conversation in its message box.
      await humanClick('[data-testid="aiondx-account"]');
      await sleep(300);
      await humanClick('.aiondx-acct-menu [data-assistant="bare:codex"]');
      const conf2 = await js(`(document.querySelector('.aiondx-acct-menu') || {}).textContent || ''`);
      check(sc, 'continuing with another kind of agent asks first, and says this chat stays', /^Continue with Codex\?/.test(conf2) && /This chat stays as it is\./.test(conf2), conf2);
      await js('window.__calls.length = 0; 0');
      await humanClick('.aiondx-acct-menu .aiondx-acct-move');
      await sleep(800);
      const created = await js(`window.__calls.filter(c => c.method === 'POST' && c.path === '/api/conversations').map(c => c.body)`);
      check(sc, "Start it creates a chat with that agent in this chat's folder",
        created.length === 1 && created[0].assistant.id === 'bare:codex' && created[0].extra.workspace === 'C:\\work\\harness' && created[0].name === 'Harness (Codex)', JSON.stringify(created));
      const hand = await js(`(() => { const d = JSON.parse(localStorage.getItem('aionui.dx.draft.conv.newconv1') || 'null'); return d && d.text; })()`);
      check(sc, "and this conversation waits in the new chat's message box",
        hand && /^I am moving this conversation to you from Claude Code \(Main\)\./.test(hand) && /\[Me\]\nhello/.test(hand) && /\[Claude Code \(Main\)\]\nhi/.test(hand), hand);
      check(sc, 'the new chat opens', (await js('location.hash')) === '#/conversation/newconv1', await js('location.hash'));
      check(sc, 'nothing reaches the new agent until you send it', (await posts('/api/conversations/newconv1/messages')).length === 0);
      // Team columns: a bare icon left of the model picker's box, Claude to Claude only.
      await load('team=1&theme=light');
      await sleep(900);
      await js('window.__aionDx.repaint()');
      await sleep(400);
      const a = await ctl('[data-slot-id="slotA"]'), b = await ctl('[data-slot-id="slotB"]');
      check(sc, "each team column gets a bare icon, outside the picker's 140 px box and level with it",
        a && b && a.compact && b.compact && a.next === 'lane-picker' && b.next === 'lane-picker' && a.label === '' && a.w <= 26 && a.dy !== null && a.dy < 3, JSON.stringify([a, b]));
      check(sc, "its tooltip names the member's own agent", a && /Claude Code \(Main\)/.test(a.aria) && b && /Claude Code \(Second\)/.test(b.aria), JSON.stringify([a && a.aria, b && b.aria]));
      await shot('click-test-agent-team');
      await js('window.__calls.length = 0; 0');
      await humanClick('[data-slot-id="slotB"] [data-testid="aiondx-account"]');
      await sleep(300);
      items = await menuItems();
      check(sc, 'a member offers only the Claude agents', items.length === 2 && items.every((i) => i.group === 'here'), JSON.stringify(items));
      await humanClick('.aiondx-acct-menu [data-agent="cc33dd44"]');
      await humanClick('.aiondx-acct-menu .aiondx-acct-move');
      await sleep(400);
      const recB = (await store())['aiondx.agent.conv.convB'];
      const rB = await js(`window.__calls.filter(c => c.method === 'POST' && c.path === '/api/teams/team1/agents/slotB/runtime/restart').length`);
      check(sc, "a member's switch is keyed to its own chat and restarts it through the team", recB && recB.agent === 'cc33dd44' && rB === 1, JSON.stringify([recB, rB]));
      // Not a Claude chat: new chats only.
      await load('theme=light&backend=gemini');
      await sleep(600);
      await js('window.__aionDx.repaint()');
      await sleep(300);
      await humanClick('[data-testid="aiondx-account"]');
      await sleep(300);
      items = await menuItems();
      check(sc, 'a chat that is not Claude offers new chats with every enabled agent',
        items.filter((i) => i.group === 'here').length === 1 && items.filter((i) => i.group === 'new').length === 4, JSON.stringify(items));
    }

    // ---- Respond now (2026-09-26, rebuilt 2026-10-01) ----
    {
      const sc = 'respond-now';
      await load('theme=light&sends=1');
      await sleep(500);
      check(sc, "a solo chat has no Respond now tick box: its agent reads a message at its next step already", !(await js(`!!document.querySelector('.aiondx-rn')`)));
      check(sc, 'and an Unread message has no bolt', !(await js(`!!document.querySelector('#message-m-77 .aiondx-rn-bolt')`)));

      await load('team=1&theme=light&sends=1');
      await sleep(700);
      const rn = (slot) => js(`(() => { const l = document.querySelector('[data-slot-id="${slot}"] .aiondx-rn'); if (!l) return null;
        const p = l.closest('.sendbox-panel'); const r = l.getBoundingClientRect(), pr = p.getBoundingClientRect(); const ta = p.querySelector('textarea').getBoundingClientRect();
        return { text: l.textContent, title: l.title, right: Math.round(pr.right - r.right), top: Math.round(r.top - pr.top), clear: r.bottom <= ta.top + 1,
          checked: l.querySelector('input').checked }; })()`);
      const box = await rn('slotB');
      check(sc, 'each team message box has a Respond now tick box in its top-right corner, clear of the text',
        box && box.text === 'Respond now' && box.right < 24 && box.top < 12 && box.clear && /ahead of everything else queued for it/.test(box.title) && /Nothing it is doing is stopped/.test(box.title), JSON.stringify(box));
      await shot('click-test-respond-now');
      const noStop = async () => (await posts('/api/teams/team1/agents/slotB/interrupt')).length === 0 && (await posts('/api/teams/team1/runs/')).length === 0 && (await posts('/api/conversations/')).filter(c => /\/cancel$/.test(c.path)).length === 0;
      await js(`(() => { const w = window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work[1]; w.state = 'running'; w.active_turn_id = 't2';
        w.team_run_id = 'run1'; w.active_turn_started_at_ms = Date.now() - 60000; window.__stub.routes['POST /api/teams/team1/agents/slotB/steer'] = { success: true, data: { outcome: 'delivered_midturn' } }; return 0; })()`);
      await js('window.__aionDx.pulseNow()');
      await humanClick('[data-slot-id="slotB"] .aiondx-rn input');
      check(sc, 'a click ticks it', (await rn('slotB')).checked);
      await js('window.__calls.length = 0; 0');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await typeInto('[data-slot-id="slotB"] [data-testid="sendbox-input"]', 'drop that, fix the build');
      await pressEnter();
      await sleep(700);
      let st = await posts('/api/teams/team1/agents/slotB/steer');
      check(sc, "sending with it ticked asks the team to steer the message to a busy member: one request, the text, no stop", st.length === 1 && st[0].body.content === 'drop that, fix the build' && !st[0].body.message_id && await noStop(), JSON.stringify(st));
      check(sc, 'and no note is piled on the queue, nothing goes the ordinary way', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0);
      check(sc, "the member's box empties, it unticks itself, and a notice says it was handed over", (await js(`document.querySelector('[data-slot-id="slotB"] [data-testid="sendbox-input"]').value`)) === '' &&
        !(await rn('slotB')).checked && /^Worker has your message now and reads it at its next step\. Nothing was stopped\./.test((await toasts())[0] || ''), JSON.stringify(await toasts()));
      // An agent that cannot take it mid-turn: first in the queue.
      await js("window.__stub.routes['POST /api/teams/team1/agents/slotB/steer'] = { success: true, data: { outcome: 'queued_first' } }; 0");
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); window.__calls.length = 0; 0');
      await humanClick('[data-slot-id="slotB"] .aiondx-rn input');
      await typeInto('[data-slot-id="slotB"] [data-testid="sendbox-input"]', 'then the docs');
      await pressEnter();
      await sleep(700);
      check(sc, 'one that cannot is told its message is first in the queue, and nothing is stopped', /^Your message is first in Worker's queue, and is read as soon as its current turn ends\./.test((await toasts())[0] || '') && await noStop(), JSON.stringify(await toasts()));
      // Unticked: an ordinary send, nothing steered.
      await js('window.__calls.length = 0; 0');
      await typeInto('[data-slot-id="slotB"] [data-testid="sendbox-input"]', 'an ordinary one');
      await pressEnter();
      await sleep(700);
      check(sc, 'unticked, a send goes the ordinary way and steers nothing', (await posts('/api/teams/team1/agents/slotB/steer')).length === 0 && (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);
      // The lead, which the interrupt route refuses, is steered the same way.
      await js("window.__stub.routes['POST /api/teams/team1/agents/slotA/steer'] = { success: true, data: { outcome: 'delivered_midturn' } }; 0");
      await js('window.__aionDx.pulseNow()');
      await humanClick('[data-slot-id="slotA"] .aiondx-rn input');
      await js('window.__calls.length = 0; 0');
      await typeInto('[data-slot-id="slotA"] [data-testid="sendbox-input"]', 'lead: answer me first');
      await pressEnter();
      await sleep(700);
      st = await posts('/api/teams/team1/agents/slotA/steer');
      check(sc, 'the lead is steered through the same route, and not stopped through its run', st.length === 1 && st[0].body.content === 'lead: answer me first' && (await posts('/api/teams/team1/runs/')).length === 0 && (await posts('/api/teams/team1/messages')).length === 0, JSON.stringify(st));

      // An AionCore without the route: the message goes as usual, once, and is remembered.
      await js("delete window.__stub.routes['POST /api/teams/team1/agents/slotB/steer']; 0");
      await js('window.__calls.length = 0; document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await humanClick('[data-slot-id="slotB"] .aiondx-rn input');
      await typeInto('[data-slot-id="slotB"] [data-testid="sendbox-input"]', 'old core');
      await pressEnter();
      await sleep(900);
      const usual = await posts('/api/teams/team1/agents/slotB/messages');
      check(sc, 'with no steer route the message is sent the usual way, and says so', (await posts('/api/teams/team1/agents/slotB/steer')).length === 1 && usual.length === 1 && usual[0].body.content === 'old core' &&
        /^Sent as usual: this AionCore cannot put a message ahead of the queue yet\./.test((await toasts())[0] || ''), JSON.stringify([usual, await toasts()]));
      await js('window.__calls.length = 0; 0');
      await humanClick('[data-slot-id="slotB"] .aiondx-rn input');
      await typeInto('[data-slot-id="slotB"] [data-testid="sendbox-input"]', 'old core again');
      await pressEnter();
      await sleep(700);
      check(sc, 'and the next ticked send does not try the route again', (await posts('/api/teams/team1/agents/slotB/steer')).length === 0 && (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);

      // The bolt, on a message of yours that is waiting in a member's queue.
      await load('team=1&theme=light&sends=1');
      await sleep(700);
      await js(`(() => { const R = window.__stub.routes; const w = R['GET /api/teams/team1/run-state'].data.slot_work[1]; w.state = 'running'; w.active_turn_id = 't2'; w.queued_foreground_count = 1;
        w.queued_foreground_message_ids = ['mb1']; w.team_run_id = 'run1';
        R['GET /api/teams/team1/mailbox'] = { success: true, data: [ { id: 'mb1', team_id: 'team1', from_agent_id: 'user', to_agent_id: 'slotB', msg_type: 'message', content: 'check the logs first', summary: null, files: [], read: false, created_at: Date.now() - 5000 },
          { id: 'mb0', team_id: 'team1', from_agent_id: 'user', to_agent_id: 'slotB', msg_type: 'message', content: 'the one it is reading now', summary: null, files: [], read: false, created_at: Date.now() - 60000 } ] };
        R['POST /api/teams/team1/agents/slotB/steer'] = { success: true, data: { outcome: 'moved_to_front', message_id: 'mb1' } };
        window.__stub.histories.convB.push({ id: 'b-8', position: 'right', created_at: Date.now() - 60000, hidden: false, content: JSON.stringify({ content: 'the one it is reading now' }) });
        window.__stub.histories.convB.push({ id: 'b-9', position: 'right', created_at: Date.now() - 5000, hidden: false, content: JSON.stringify({ content: 'check the logs first' }) }); return 0; })()`);
      await js('window.__aionDx.scanQueues()');
      await sleep(300);
      const bolt = await js(`(() => { const b = document.querySelector('#message-b-9 .aiondx-rn-bolt'); if (!b) return null; const r = b.getBoundingClientRect(), q = b.parentElement.getBoundingClientRect();
        return { left: r.right <= q.left, mid: r.top + r.height / 2 >= q.top && r.top + r.height / 2 <= q.bottom, title: b.title, other: !!document.querySelector('#message-b-8 .aiondx-rn-bolt') }; })()`);
      check(sc, 'a message waiting in a member\'s queue gets a bolt just left of it; the one being read does not', bolt && bolt.left && bolt.mid && !bolt.other &&
        /^Respond now: this message goes to the top of the queue and is read at the agent's next step\. Nothing it is doing is stopped\./.test(bolt.title), JSON.stringify(bolt));
      await js('window.__calls.length = 0; document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await humanClick('#message-b-9 .aiondx-rn-bolt');
      await sleep(700);
      st = await posts('/api/teams/team1/agents/slotB/steer');
      check(sc, 'the bolt moves that message to the top of the queue by its id, and stops nothing', st.length === 1 && st[0].body.message_id === 'mb1' && !st[0].body.content && await noStop(), JSON.stringify(st));
      check(sc, 'with no note piled on, and a notice that says where it is', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0 && /^Your message is first in Worker's queue/.test((await toasts())[0] || ''), JSON.stringify(await toasts()));
      // The member starts on it: the bolt goes.
      await js("(() => { const w = window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work[1]; w.queued_foreground_message_ids = []; w.queued_foreground_count = 0; return 0; })()");
      await js('window.__aionDx.scanQueues()');
      await sleep(300);
      check(sc, 'once the member has taken the message, its bolt goes', !(await js(`!!document.querySelector('.aiondx-rn-bolt')`)));
      // An AionCore without the list: no bolts at all.
      await js("(() => { const w = window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work[1]; delete w.queued_foreground_message_ids; w.queued_foreground_count = 1; return 0; })()");
      await js('window.__aionDx.scanQueues()');
      await sleep(300);
      check(sc, 'an AionCore that does not list the queue gets no bolts', !(await js(`!!document.querySelector('.aiondx-rn-bolt')`)));
      // The bolt is found by the text of your message, not by ids and not in the member's last 40 messages (a request of 2026-10-02): the row the page shows for a message you just sent has an id of its
      // own until the chat is read again, and a busy member writes more than 40 messages in a few minutes.
      await load('team=1&theme=light&sends=1');
      await sleep(700);
      await js(`(() => { const R = window.__stub.routes; const w = R['GET /api/teams/team1/run-state'].data.slot_work[1]; w.state = 'running'; w.active_turn_id = 't2'; w.queued_foreground_count = 1;
        w.queued_foreground_message_ids = ['mb1']; w.team_run_id = 'run1';
        R['GET /api/teams/team1/mailbox'] = { success: true, data: [ { id: 'mb1', team_id: 'team1', from_agent_id: 'user', to_agent_id: 'slotB', msg_type: 'message', content: 'check the logs first', summary: null, files: [], read: false, created_at: Date.now() - 5000 } ] };
        const h = window.__stub.histories.convB; for (let i = 0; i < 70; i++) h.push({ id: 'n-' + i, position: 'left', created_at: Date.now() - 4000 + i, hidden: false, content: JSON.stringify({ content: 'tool output ' + i }) });
        document.getElementById('message-b-9').id = 'message-page-own-id'; return 0; })()`);
      await js('window.__aionDx.scanQueues()');
      await sleep(300);
      check(sc, 'a queued message gets its bolt although the page gave its row an id of its own and the member has 70 newer messages', await js(`!!document.querySelector('#message-page-own-id .aiondx-rn-bolt')`));
      await js(`(() => { const row = document.getElementById('message-page-own-id'); const copy = row.cloneNode(true); copy.id = 'message-older'; copy.style.top = '10px'; copy.querySelectorAll('.aiondx-rn-bolt').forEach((b) => b.remove()); row.parentNode.insertBefore(copy, row); return 0; })()`);
      await js('window.__aionDx.repaint()');
      await sleep(200);
      check(sc, 'with the same words sent twice and one waiting, the newest bubble has the bolt and the older one has none', await js(`!!document.querySelector('#message-page-own-id .aiondx-rn-bolt') && !document.querySelector('#message-older .aiondx-rn-bolt')`));
      // A long queue is told once.
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await js(`(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.slot_work[1].queued_background_count = 22; return 0; })()`);
      await js('window.__aionDx.pulseNow()');
      await sleep(300);
      let qt = await toasts();
      check(sc, "a member with 20 or more messages waiting gets one notice, naming it", qt.length === 1 && /^Worker has 23 messages waiting\./.test(qt[0]), JSON.stringify(qt));
      await js('window.__aionDx.pulseNow()');
      await sleep(300);
      check(sc, 'and not again while the queue stays long', (await toasts()).length === 1);
    }

    // ---- Ctrl+Z in the message box (2026-10-02) ----
    {
      const sc = 'undo';
      await load('theme=light&sends=1');
      await sleep(500);
      const box = '[data-testid="sendbox-input"]';
      const val = () => js(`document.querySelector('${box}').value`);
      const ctrl = async (k, shift) => {
        const o = { key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: 2 | (shift ? 8 : 0) };
        await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, o));
        await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, o));
        await sleep(60);
      };
      const typeKeys = async (text) => { for (const ch of text) await send('Input.insertText', { text: ch }); await sleep(60); };
      await humanClick(box);
      await typeKeys('the quick brown fox');
      check(sc, 'typed one letter at a time', (await val()) === 'the quick brown fox', await val());
      await ctrl('z');
      check(sc, 'one Ctrl+Z undoes the whole burst', (await val()) === '', await val());
      await ctrl('y');
      check(sc, 'Ctrl+Y puts it back', (await val()) === 'the quick brown fox', await val());
      await ctrl('z', true);
      check(sc, 'and Ctrl+Shift+Z is the same as Ctrl+Y: it is already the latest, so nothing changes', (await val()) === 'the quick brown fox', await val());
      await ctrl('z');
      await typeKeys('one');
      await sleep(1150);
      await typeKeys(' two');
      await ctrl('z');
      check(sc, 'a pause of over a second ends a step', (await val()) === 'one', await val());
      await ctrl('z');
      check(sc, 'and the first step is next', (await val()) === '', await val());
      // the page emptying the box itself (a send) is not undone into
      await typeKeys('sent text');
      await js(`(() => { const t = document.querySelector('${box}'); const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
      await ctrl('z');
      check(sc, 'after the page empties the box (a send), Ctrl+Z does not bring the sent text back', (await val()) === '', await val());
      check(sc, 'a text box that is not a message box is left alone', await js(`(() => { const t = document.createElement('textarea'); t.id = 'other-box'; document.body.appendChild(t); const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); const r = !e.defaultPrevented; t.remove(); return r; })()`));
    }

    // ---- chat colours and the right-click menu (2026-09-26, build 2026-09-26.3) ----
    {
      const sc = 'bubbles';
      await load('theme=dark&bubbles=1');
      await sleep(700);
      await js('window.__aionDx.repaint()');
      await sleep(300);
      const kinds = await js(`['u1', 'u2', 'u3', 'a1'].map(id => { const r = document.getElementById('message-' + id); return r ? [r.getAttribute('data-aiondx-kind'), r.getAttribute('data-aiondx-agent') || ''].join(':') : null; })`);
      check(sc, "rows are told apart: yours, a Loop nudge, a cross-chat message, the chat agent's reply", JSON.stringify(kinds) === JSON.stringify(['mine:', 'loop:', 'a2a:', 'agent:cc33dd44']), JSON.stringify(kinds));
      await putStore('aiondx.theme', { accent: '#2dd4bf', dividers: true, at: Date.now() + 1000, bubbles: {
        mine: { dark: '#1e40af', light: '#bfdbfe' }, loop: { dark: '#3f3f46' }, a2a: { dark: '#7c2d12' }, agents: { cc33dd44: { dark: '#14532d' } } } });
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      const look = await js(`(() => { const bg = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : null; };
        const host = document.querySelector('#message-a1 .markdown-shadow'); const body = host && host.shadowRoot && host.shadowRoot.querySelector('.markdown-shadow-body');
        return { mine: bg('#message-u1 .bg-aou-2'), mineText: getComputedStyle(document.querySelector('#message-u1 .whitespace-pre-wrap')).color,
          loop: bg('#message-u2 .bg-aou-2'), a2a: bg('#message-u3 .bg-aou-2'), agent: bg('#message-a1 [data-testid="message-text-content"]'),
          agentText: body ? getComputedStyle(body).color : null }; })()`);
      check(sc, 'each kind takes its own dark-mode colour', look && look.mine === 'rgb(30, 64, 175)' && look.loop === 'rgb(63, 63, 70)' &&
        look.a2a === 'rgb(124, 45, 18)' && look.agent === 'rgb(20, 83, 45)', JSON.stringify(look));
      check(sc, "with text that reads on it, inside the reply's Markdown shadow root too", look && look.mineText === 'rgb(255, 255, 255)' && look.agentText === 'rgb(255, 255, 255)', JSON.stringify(look));
      await js(`document.documentElement.setAttribute('data-theme', 'light'); 0`);
      await sleep(200);
      const light = await js(`[getComputedStyle(document.querySelector('#message-u1 .bg-aou-2')).backgroundColor, getComputedStyle(document.querySelector('#message-a1 [data-testid="message-text-content"]')).backgroundColor]`);
      check(sc, 'light mode has its own set: yours in its light colour, the agent (dark only) left as it was', light[0] === 'rgb(191, 219, 254)' && light[1] !== 'rgb(20, 83, 45)', JSON.stringify(light));
      await js(`document.documentElement.setAttribute('data-theme', 'dark'); 0`);
      await sleep(200);
      // Right-click in the message box: no AionDX menu (Electron's Cut/Copy/Paste stays).
      await rightClick('#solo [data-testid="sendbox-input"]');
      check(sc, 'a right-click in the message box leaves it to the Cut/Copy/Paste menu', !(await js('!!document.querySelector(\'[data-testid="aiondx-colour-menu"]\')')));
      await rightClick('#message-u2 .bg-aou-2');
      let menu = await js(`[...document.querySelectorAll('[data-testid="aiondx-colour-menu"] .arco-dropdown-menu-item')].map(i => i.textContent)`);
      check(sc, 'right-clicking a Loop nudge offers the Loop nudges colour', JSON.stringify(menu) === JSON.stringify(['Colour of Loop nudges...']), JSON.stringify(menu));
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
      await rightClick('#message-a1 [data-testid="message-text-content"]');
      menu = await js(`[...document.querySelectorAll('[data-testid="aiondx-colour-menu"] .arco-dropdown-menu-item')].map(i => i.textContent)`);
      check(sc, "right-clicking an agent's reply offers that agent's colour", JSON.stringify(menu) === JSON.stringify(["Colour of Claude Code (Main)'s replies..."]), JSON.stringify(menu));
      await humanClick('[data-testid="aiondx-colour-menu"] [data-colour-key="agent:cc33dd44"]');
      const hash = await js('location.hash');
      await js(`(() => { const sec = document.createElement('section'); sec.id = 'fake-appearance'; const grid = document.createElement('div'); sec.appendChild(grid);
        ['light', 'dark'].forEach(id => { const c = document.createElement('div'); c.setAttribute('data-testid', 'theme-card-' + id); c.textContent = id; grid.appendChild(c); });
        document.body.appendChild(sec); return 0; })()`);
      let focused = null;
      for (let i = 0; i < 12 && !focused; i++) {
        await js('window.__aionDx.repaint()');
        await sleep(250);
        focused = await js(`(() => { const r = document.querySelector('.aiondx-bubble-row.aiondx-colour-focus'); return r ? r.getAttribute('data-bubble') : null; })()`);
      }
      check(sc, "its item opens Settings > Appearance at that agent's control, marked", /^#\/settings\/appearance/.test(hash) && focused === 'agent:cc33dd44', JSON.stringify([hash, focused]));
      const rowsList = await js(`[...document.querySelectorAll('.aiondx-bubble-row')].map(r => r.getAttribute('data-bubble'))`);
      check(sc, 'Settings has your messages, Loop nudges, agent-to-agent, each agent, and each member of the picked team',
        JSON.stringify(rowsList) === JSON.stringify(['mine', 'loop', 'a2a', 'agent:aa11bb22', 'agent:cc33dd44', 'agent:codex', 'agent:a9f3c21e', 'member:team1/slotA', 'member:team1/slotB']), JSON.stringify(rowsList));
      const chip = await js(`(() => { const s = document.querySelector('.aiondx-bubble-row[data-bubble="mine"] .aiondx-bubble-pick[data-mode="dark"] span'); return s ? getComputedStyle(s).backgroundColor : null; })()`);
      check(sc, 'each row shows its colours', chip === 'rgb(30, 64, 175)', chip);
      await js(`(() => { const i = document.querySelector('.aiondx-bubble-row[data-bubble="loop"] .aiondx-bubble-pick[data-mode="light"] input'); i.value = '#fde68a'; i.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
      await sleep(500);
      let theme = (await store())['aiondx.theme'] || {};
      check(sc, 'a colour picked in Settings is kept, for this mode only', theme.bubbles && theme.bubbles.loop && theme.bubbles.loop.light === '#fde68a' && theme.bubbles.loop.dark === '#3f3f46', JSON.stringify(theme.bubbles));
      await humanClick('.aiondx-bubble-row[data-bubble="loop"] .aiondx-bubble-reset');
      theme = (await store())['aiondx.theme'] || {};
      check(sc, 'and Reset clears both of its colours', theme.bubbles && !theme.bubbles.loop, JSON.stringify(theme.bubbles));
      await js(`(() => { const s = document.getElementById('fake-appearance'); if (s) s.remove(); return 0; })()`);

      // A team: a member's own colour goes on its replies, its messages to teammates, its column and its name.
      await load('team=1&theme=dark&bubbles=1');
      const before = await js(`(() => { const col = document.querySelector('[data-slot-id="slotB"] > .h-full');
        return { tint: col && getComputedStyle(col).backgroundColor, name: getComputedStyle(document.querySelector('[data-slot-id="slotB"] .truncate')).color }; })()`);
      await putStore('aiondx.theme', { accent: '#2dd4bf', dividers: true, at: Date.now() + 2000, bubbles: {
        agents: { 'aa11bb22': { dark: '#14532d' } }, members: { 'team1/slotB': { dark: '#6d28d9' }, 'team1/slotA': { dark: '#b45309' } } } });
      await js('window.__aionDx.pullNow()');
      for (let i = 0; i < 6; i++) { await js('window.__aionDx.repaint()'); await sleep(250); }
      const team = await js(`(() => { const w1 = document.getElementById('message-w1'), w2 = document.getElementById('message-w2');
        const col = document.querySelector('[data-slot-id="slotB"] > .h-full');
        return { member: w1 && w1.getAttribute('data-aiondx-member'), agent: w1 && w1.getAttribute('data-aiondx-agent'),
          reply: w1 && getComputedStyle(w1.querySelector('[data-testid="message-text-content"]')).backgroundColor,
          from: w2 && w2.getAttribute('data-aiondx-from'), fromBg: w2 && getComputedStyle(w2.querySelector('.bg-3')).backgroundColor,
          tint: col && getComputedStyle(col).backgroundColor, name: getComputedStyle(document.querySelector('[data-slot-id="slotB"] .truncate')).color }; })()`);
      check(sc, "a member's replies take its own colour over its agent's", team && team.member === 'team1/slotB' && team.agent === 'aa11bb22' && team.reply === 'rgb(109, 40, 217)', JSON.stringify(team));
      check(sc, "a teammate's message takes its sender's colour", team && team.from === 'team1/slotA' && team.fromBg === 'rgb(180, 83, 9)', JSON.stringify(team));
      check(sc, "and the member's column and name carry its colour", team && before && team.tint !== before.tint && team.name !== before.name, JSON.stringify([before, team]));
      await rightClick('[data-slot-id="slotB"] .truncate');
      menu = await js(`[...document.querySelectorAll('[data-testid="aiondx-colour-menu"] .arco-dropdown-menu-item')].map(i => i.textContent)`);
      check(sc, "right-clicking a member's column offers its colour", JSON.stringify(menu) === JSON.stringify(['Colour of Worker...']), JSON.stringify(menu));
      await js('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 0');
    }

    // ---- MCP: an agent's change is announced, and Settings > Tools has a switch per server (2026-09-26) ----
    {
      const sc = 'mcp';
      await load('theme=light');
      await js('document.querySelectorAll(".aiondx-toast").forEach(t => t.remove()); 0');
      await putStore('aiondx.mcp.log', [
        { at: Date.now() - 3600000, who: 'Old Agent', conv: 'harness1', action: 'add', name: 'stale', note: '' },
        { at: Date.now(), who: 'Team Lead', conv: 'harness1', action: 'add', name: 'github', note: 'for the PR work' }]);
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      const tt = await toasts();
      check(sc, "an agent's MCP change is announced with its name and note, an old one is not",
        tt.some((t) => /Team Lead added the MCP server github\./.test(t) && /for the PR work/.test(t)) && !tt.some((t) => /stale/.test(t)), JSON.stringify(tt));
      // Settings > Tools as McpServerHeader.tsx renders a row: the name first, then the status and test buttons.
      await js(`(() => {
        window.__stub.routes['GET /api/mcp/servers'].data = [
          { id: 'mcp-9', name: 'airtable', enabled: false, builtin: false, transport: { type: 'http', url: 'https://x' }, last_test_status: 'disconnected' },
          { id: 'mcp-8', name: 'image-gen', enabled: true, builtin: true, transport: { type: 'stdio', command: 'x' }, last_test_status: 'disconnected' }];
        window.__stub.routes['POST /api/mcp/servers/mcp-9/toggle'] = { success: true, data: { id: 'mcp-9', name: 'airtable', enabled: true } };
        const page = document.createElement('section'); page.id = 'fake-tools';
        page.innerHTML = ['airtable', 'image-gen'].map(n => '<div class="flex items-center justify-between group"><div class="flex items-center gap-2"><span>' + n +
          '</span><span class="flex items-center">o</span></div><div class="flex items-center gap-2 invisible group-hover:visible"></div></div>').join('');
        document.body.appendChild(page); location.hash = '#/settings/tools'; return 0; })()`);
      let sw = null;
      for (let i = 0; i < 10 && !sw; i++) {
        await js('window.__aionDx.repaint()');
        await sleep(200);
        sw = await js(`(() => { const s = document.querySelectorAll('#fake-tools .aiondx-mcp-switch'); return s.length ? [...s].map(x => [x.previousElementSibling.textContent, x.getAttribute('aria-checked')]) : null; })()`);
      }
      check(sc, "Settings > Tools gets an On/Off switch on each server that is not built in, showing its state", JSON.stringify(sw) === JSON.stringify([['airtable', 'false']]), JSON.stringify(sw));
      await js('window.__calls.length = 0; 0');
      await humanClick('#fake-tools .aiondx-mcp-switch');
      await sleep(400);
      const calls = await js(`window.__calls.filter(c => /\\/api\\/mcp\\/servers/.test(c.path)).map(c => c.method + ' ' + c.path)`);
      check(sc, 'the switch reads the state first, then toggles only that server', JSON.stringify(calls.slice(0, 2)) === JSON.stringify(['GET /api/mcp/servers', 'POST /api/mcp/servers/mcp-9/toggle']), JSON.stringify(calls));
      await js(`(() => { const p = document.getElementById('fake-tools'); if (p) p.remove(); location.hash = '#/conversation/harness1'; return 0; })()`);
    }

    // ---- the one-click setup (2026-09-26, a request) ----
    {
      const sc = 'one-click';
      await load('theme=light&welcome=1&setup=1');
      await sleep(3800);
      const w = () => js(`(() => { const d = document.querySelector('.aiondx-welcome'); if (!d) return null;
        return { title: (d.querySelector('.aiondx-welcome-title') || {}).textContent, text: (d.querySelector('.aiondx-welcome-text') || {}).textContent,
          status: (d.querySelector('.aiondx-welcome-status') || {}).textContent, buttons: [...d.querySelectorAll('.aiondx-welcome-actions button')].filter(b => !b.hidden).map(b => b.textContent) }; })()`);
      let v = await w();
      check(sc, 'with the one-click setup, a first run opens on "Look for my setup", Antigravity as the backup', v && v.title === 'Welcome to AionDX' &&
        /bring over what your other AI apps already use/.test(v.text) && /Nothing changes until you press Import/.test(v.text) &&
        JSON.stringify(v.buttons) === JSON.stringify(['Look for my setup', 'Set up with Antigravity instead', 'Not now']), JSON.stringify(v));
      await humanClick('.aiondx-w-scan');
      await sleep(700);
      v = await w();
      const found = await js(`(() => ({ groups: [...document.querySelectorAll('.aiondx-welcome-group')].map(g => g.textContent),
        items: [...document.querySelectorAll('.aiondx-welcome-found .aiondx-welcome-option')].map(o => o.textContent),
        wire: [...document.querySelectorAll('input[data-wire]')].map(i => i.getAttribute('data-wire')),
        checked: [...document.querySelectorAll('.aiondx-welcome input[type=checkbox]')].every(i => i.checked) }))()`);
      check(sc, 'Look for my setup scans and lists what it found, per app, AionDX itself and missing apps left out', v && v.title === 'Here is what AionDX found' &&
        JSON.stringify(found.groups) === JSON.stringify(['Claude Code', 'OpenAI Codex CLI']) && (await js('window.__setupCalls.length')) === 1, JSON.stringify([v, found]));
      check(sc, 'instructions with their dates, folders with their counts (empty ones and settings left out), each MCP server with the keys it needs, and no token',
        found.items.length === 4 && /^Instructions~\\\.claude\\CLAUDE\.md, changed 2026-09-20$/.test(found.items[0]) && /^3 custom agents/.test(found.items[1]) &&
        /^MCP server githubnpx -y server-github --token \*\*\*\. Needs GITHUB_TOKEN$/.test(found.items[2]) && !found.items.join(' ').includes('abc123') && found.checked, JSON.stringify(found.items));
      check(sc, 'and offers to give the instructions to the agents installed, Antigravity included', JSON.stringify(found.wire) === JSON.stringify(['claude-code', 'codex', 'antigravity']), JSON.stringify(found.wire));
      await js(`(() => { const o = [...document.querySelectorAll('.aiondx-welcome-found .aiondx-welcome-option')][3]; o.querySelector('input').click(); document.querySelector('input[data-wire="codex"]').click();
        document.querySelector('.aiondx-welcome-prefs').scrollIntoView({ block: 'center' }); return 0; })()`);
      await sleep(200);
      await typeInto('.aiondx-welcome-prefs', 'Answer briefly.');
      await humanClick('.aiondx-w-import');
      await sleep(700);
      const plan = await js('(window.__setupCalls[1] || {}).plan || null');
      check(sc, 'Import sends exactly what stayed ticked', plan && JSON.stringify(plan.items) === JSON.stringify(['C:\\Users\\tester\\.claude\\CLAUDE.md', 'C:\\Users\\tester\\.claude\\agents']) &&
        JSON.stringify(plan.mcp) === JSON.stringify([{ file: 'C:\\Users\\tester\\.claude.json', name: 'github' }]) && JSON.stringify(plan.wire) === JSON.stringify(['claude-code', 'antigravity']) &&
        plan.prefs === 'Answer briefly.', JSON.stringify(plan));
      v = await w();
      const done = await js(`[...document.querySelectorAll('.aiondx-welcome-done li')].map(l => l.textContent)`);
      check(sc, 'then says what it did: what came over, who reads the instructions, the MCP servers and the keys still needed', v && v.title === 'Your setup is in AionDX' &&
        /^Brought over: 1 instructions file, 3 custom agents\./.test(done[0]) && /now read by Claude Code, Antigravity\.$/.test(done[1]) && /^MCP servers: github, in the AionDX MCP file\. No chat loads them/.test(done[2]) &&
        /^Keys already in your environment variables, used as they are: GITHUB_TOKEN\.$/.test(done[3]) && /^Keys still needed: OTHER_KEY\. Put each in the "secrets" section of /.test(done[4]) &&
        /^1 key-like string was left out/.test(done[5]), JSON.stringify(done));
      check(sc, 'with the report to copy, and the setup marked done', /What changed, and how to undo each change:/.test(v.status) && /report\.md/.test(v.status) &&
        ((await store())['aiondx.welcome'] || {}).done === true && ((await store())['aiondx.welcome'] || {}).mode === 'import', JSON.stringify([v.status, (await store())['aiondx.welcome']]));
      check(sc, 'and Antigravity offered as an extra, not a step', JSON.stringify(v.buttons) === JSON.stringify(['Finish', 'Also sign in to Antigravity (free)']), JSON.stringify(v.buttons));
      await humanClick('.aiondx-w-finish');
      check(sc, 'Finish closes it', !(await w()));
      // A scan that fails says why and points at the backup.
      await load('theme=light&welcome=1&setup=1');
      await sleep(3800);
      await js(`(() => { window.__setupScanAnswer = { ok: false, error: 'survey: could not read' }; return 0; })()`);
      await humanClick('.aiondx-w-scan');
      await sleep(700);
      v = await w();
      check(sc, 'a scan that fails says so, and that Antigravity can do it instead', v && v.title === 'Welcome to AionDX' && /did not finish \(survey: could not read\)/.test(v.status) && /set up with Antigravity instead/.test(v.status), JSON.stringify(v));
      await humanClick('.aiondx-w-agy');
      v = await w();
      check(sc, 'Set up with Antigravity instead opens its sign-in, with a way back', v && v.title === 'Set up with Antigravity' && v.buttons.includes('Sign in to Antigravity (free, with Google)') && v.buttons.includes('Back'), JSON.stringify(v));
      await humanClick('.aiondx-w-back');
      v = await w();
      check(sc, 'and Back returns to Look for my setup', v && v.buttons[0] === 'Look for my setup', JSON.stringify(v));
    }

    // ---- model names with their versions (2026-09-26, the friend's install: "only shows Fable, Opus, Sonnet") ----
    {
      const sc = 'model-labels';
      await load('theme=light');
      await js(`(() => { localStorage.removeItem('aionui.dx.modelLabels'); return 0; })()`);
      const pill = () => js(`(document.querySelector('#solo [data-testid="acp-model-selector"]') || {}).textContent`);
      check(sc, 'the pill starts as AionUi draws it', (await pill()) === 'Sonnet · High', await pill());
      await js(`fetch('http://127.0.0.1:58699/api/conversations/harness1/runtime/ensure', { method: 'POST', credentials: 'include' }).then(r => r.json()).then(j => { window.__ens = j; }); 0`);
      await sleep(700);
      check(sc, "the chat's model list is read for versions, and the pill gets one", (await pill()) === 'Sonnet 5 · High' && !!(await js('window.__ens && window.__ens.data')), await pill());
      await js(`(() => { const m = document.createElement('div'); m.id = 'fake-models'; m.className = 'arco-dropdown-menu';
        for (const n of ['Default (recommended)', 'Opus', 'Opus (1M context)', 'Fable', 'Opus 4.8']) {
          const it = document.createElement('div'); it.className = 'arco-dropdown-menu-item';
          it.innerHTML = '<div class="flex items-center gap-8px w-full min-w-0"><span aria-hidden="true" class="w-16px shrink-0 text-primary"></span><span class="min-w-0 truncate"></span></div>';
          it.querySelector('.truncate').textContent = n; m.appendChild(it); }
        document.body.appendChild(m); return 0; })()`);
      await sleep(400);
      const rows = await js(`[...document.querySelectorAll('#fake-models .truncate')].map(s => s.textContent)`);
      check(sc, 'the model menu rows get theirs: Default names the model it stands for, a row with a version keeps it',
        JSON.stringify(rows) === JSON.stringify(['Default (Opus 5.5)', 'Opus 5.5', 'Opus 5.5 (1M context)', 'Fable 5.1', 'Opus 4.8']), JSON.stringify(rows));
      await js(`(() => { const b = document.querySelector('#solo [data-testid="acp-model-selector"]'); b.firstChild.nodeValue = 'Opus · Low'; return 0; })()`);
      await sleep(150);
      check(sc, 'when AionUi rewrites the pill (a model change), it gets the version again at once', (await pill()) === 'Opus 5.5 · Low', await pill());
      check(sc, 'the names learned are kept for chats whose agent has not started', /"Opus":"Opus 5\.5"/.test(await js("localStorage.getItem('aionui.dx.modelLabels') || ''")));
      await js(`(() => { const p = document.createElement('p'); p.id = 'fake-msg'; p.setAttribute('data-testid', 'message-text-content'); p.textContent = 'Opus'; document.body.appendChild(p); return 0; })()`);
      await sleep(300);
      check(sc, 'text elsewhere on the page is left alone', (await js(`document.getElementById('fake-msg').textContent`)) === 'Opus');
      await js(`(() => { document.getElementById('fake-models').remove(); document.getElementById('fake-msg').remove(); return 0; })()`);
      // The agents' catalog (GET /api/agents/management), where the live app's model lists come from (a chat's own
      // start answered without models in the standalone app, 2026-09-26), and the new-chat page's picker.
      await js(`(() => { window.__stub.routes['GET /api/agents/management'] = { success: true, data: [{ id: 'cc33dd44', name: 'Claude Code (Main)', agent_type: 'acp', backend: 'claude',
        config_options: [{ id: 'model', category: 'model', type: 'select', options: [{ value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' }] }],
        available_models: { available_models: [{ id: 'haiku', label: 'Haiku' }], current_model_id: null } }] }; return 0; })()`);
      await js(`fetch('http://127.0.0.1:58699/api/agents/management', { credentials: 'include' }).then(r => r.json()); 0`);
      await sleep(500);
      check(sc, "the agents' catalog is read for versions too", /"Haiku":"Haiku 4\.5"/.test(await js("localStorage.getItem('aionui.dx.modelLabels') || ''")),
        await js("localStorage.getItem('aionui.dx.modelLabels')"));
      await js(`(() => { const b = document.createElement('button'); b.id = 'fake-guid'; b.className = 'arco-btn sendbox-model-btn guid-config-btn'; b.setAttribute('data-testid', 'guid-model-selector');
        b.innerHTML = '<span class="flex items-center gap-6px min-w-0"><span class="guid-model-label">Haiku</span></span>'; document.body.appendChild(b); return 0; })()`);
      await sleep(400);
      check(sc, "the new-chat page's model picker gets it", (await js(`document.querySelector('#fake-guid .guid-model-label').textContent`)) === 'Haiku 4.5',
        await js(`document.querySelector('#fake-guid .guid-model-label').textContent`));
      await js(`(() => { document.getElementById('fake-guid').remove(); return 0; })()`);
    }

    // ---- Welcome to AionDX (2026-09-26) ----
    {
      const sc = 'welcome';
      await load('theme=dark&welcome=1');
      await sleep(3800);   // first-run setup records itself, then the next store read opens the screen
      const w = () => js(`(() => { const d = document.querySelector('.aiondx-welcome'); if (!d) return null;
        return { title: (d.querySelector('.aiondx-welcome-title') || {}).textContent, text: (d.querySelector('.aiondx-welcome-text') || {}).textContent,
          status: (d.querySelector('.aiondx-welcome-status') || {}).textContent, buttons: [...d.querySelectorAll('.aiondx-welcome-actions button')].filter(b => !b.hidden).map(b => b.textContent),
          ext: (d.querySelector('.aiondx-w-external') || {}).title || '' }; })()`);
      let v = await w();
      check(sc, 'without the one-click setup (WebUI), a first run opens Welcome to AionDX on the Antigravity sign-in, with no talk of a key', v && v.title === 'Welcome to AionDX' &&
        /^Sign in to Antigravity with your Google account/.test(v.text) && /There is no key to paste/.test(v.text) && !/Antigravity key/.test(v.text), JSON.stringify(v));
      check(sc, 'with Antigravity found installed', v && /^Antigravity is installed\./.test(v.status), v && v.status);
      const facts = await js(`[...document.querySelectorAll('.aiondx-welcome .aiondx-welcome-fact')].map(f => f.textContent)`);
      check(sc, "it says Antigravity is Google's, free, with a weekly allowance, and only there to help the user move in (the owner)", facts && facts.length === 2 &&
        /^Free with a Google account/.test(facts[0]) && /refreshes every week/.test(facts[0]) && /does not publish a number/.test(facts[0]) &&
        /^What it does for you/.test(facts[1]) && /helps you move in/.test(facts[1]) && /asking before each change/.test(facts[1]), JSON.stringify(facts));
      check(sc, 'and a way to use another agent instead, its tooltip naming Claude Desktop', v && v.buttons.length === 3 && /Claude in Claude Desktop/.test(v.ext), JSON.stringify(v && v.buttons));
      await shot('click-test-welcome');
      const btn = await js(`(() => { const b = document.querySelector('.aiondx-w-signin'); const cs = getComputedStyle(b);
        return { bg: cs.backgroundColor, fg: cs.color, inline: b.style.backgroundColor }; })()`);
      check(sc, "the sign-in button is drawn in the accent colour with text that reads on it (white on white)",
        btn && btn.inline && btn.bg !== btn.fg && btn.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(btn));
      // Another agent: step 2, then the brief to copy.
      await humanClick('.aiondx-w-external');
      v = await w();
      check(sc, 'Use another agent instead opens the setup step: instructions for every agent and what to bring over', v && v.title === 'Set up your agents' &&
        (await js(`document.querySelectorAll('.aiondx-welcome-option input').length`)) === 4 && !(await js(`document.querySelector('[data-opt="accounts"]').checked`)), JSON.stringify(v));
      await typeInto('.aiondx-welcome-prefs', 'Answer in plain English. Never use em dashes.');
      await js(`(() => { navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; return 0; })()`);
      await humanClick('.aiondx-w-copy');
      await sleep(300);
      const brief = await js('window.__copied || ""');
      check(sc, 'Copy the setup brief copies a brief naming the setup procedure, your instructions and your choices',
        /aiondx-setup\\SKILL\.md/.test(brief) && /> Answer in plain English\. Never use em dashes\./.test(brief) && /\[x\] Agents and their settings/.test(brief) && /\[ \] Sign-ins and accounts/.test(brief), brief.slice(0, 600));
      check(sc, 'the brief says to do every step itself, never to hand the user a script, with the two commands in full (it had handed a tester scripts to run)',
        /Never give me a script or a command to run/.test(brief) && /"%LOCALAPPDATA%\\AionDX\\bin\\aiondx\.exe" setup scan/.test(brief) &&
        /aiondx\.exe" setup apply --all --prefs /.test(brief) && !/--skip mcp/.test(brief), brief.slice(0, 1200));
      check(sc, 'and records the setup as done', ((await store())['aiondx.welcome'] || {}).done === true && ((await store())['aiondx.welcome'] || {}).mode === 'external', JSON.stringify((await store())['aiondx.welcome']));
      // Antigravity: a chat with it, and the brief sent there once it answers.
      await load('theme=light&welcome=1');
      await sleep(3800);
      await js('window.__calls.length = 0; 0');
      await humanClick('.aiondx-w-signin');
      await humanClick('.aiondx-w-signin');   // the owner hit it a bunch: one chat, not several
      await sleep(800);
      await humanClick('.aiondx-w-signin');
      await sleep(400);
      const made = await js(`window.__calls.filter(c => c.method === 'POST' && c.path === '/api/conversations').map(c => c.body)`);
      const first = await posts('/api/conversations/newconv1/messages');
      check(sc, 'Sign in to Antigravity opens one chat with Antigravity, however often it is clicked, and says hello',
        made.length === 1 && made[0].assistant.id === 'bare:a9f3c21e' && first.length >= 1 && /Reply with the single word READY\.$/.test(first[0].body.content), JSON.stringify([made, first.length]));
      // Antigravity's sign-in panel, with its code box, sits above the Welcome screen and takes clicks.
      await putStore('aiondx.agy.signin', { state: 'waiting', message: 'A sign-in page opened in your browser; finish it there.', conversation: 'newconv1', at: Date.now() + 500 });
      await js('window.__aionDx.pullNow()');
      await sleep(400);
      const reach = await js(`(() => { const i = document.querySelector('.aiondx-signin-code'); if (!i) return null; const r = i.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { onTop: at === i, status: (document.querySelector('.aiondx-welcome-status') || {}).textContent }; })()`);
      check(sc, "the sign-in code box sits above the Welcome screen and is reachable (the owner had to press Not now)", reach && reach.onTop, JSON.stringify(reach));
      check(sc, 'and Welcome says where to paste the code', reach && /paste it into the box at the top of the window/.test(reach.status || ''), JSON.stringify(reach));
      await putStore('aiondx.agy.signin', null);
      await js(`(() => { delete window.__stub.store['aiondx.agy.signin']; return 0; })()`);
      await js(`(() => { window.__stub.histories.newconv1.push({ id: 'r1', position: 'left', created_at: Date.now(), hidden: false, content: JSON.stringify({ content: 'READY' }) }); return 0; })()`);
      await sleep(3600);
      v = await w();
      check(sc, 'once Antigravity answers, the setup step opens', v && v.title === 'Set up your agents' && /^Antigravity will do this setup\./.test(v.text), JSON.stringify(v));
      await js('window.__calls.length = 0; 0');
      await humanClick('.aiondx-w-go');
      await sleep(600);
      const briefSent = await posts('/api/conversations/newconv1/messages');
      check(sc, 'Let Antigravity set it up sends it the brief and opens that chat',
        briefSent.length === 1 && /aiondx-setup skill/.test(briefSent[0].body.content) && (await js('location.hash')) === '#/conversation/newconv1' && !(await w()), JSON.stringify(briefSent));
      // The failsafe: no Antigravity on the PC, so setup runs on a working agent (2026-09-26).
      await load('theme=light&welcome=1&noagy=1');
      await sleep(3800);
      v = await w();
      const altBtn = () => js(`(() => { const b = document.querySelector('.aiondx-w-alt'); return b && !b.hidden && b.getBoundingClientRect().width > 0 ? b.textContent : null; })()`);
      check(sc, 'with no Antigravity, step 1 offers setup with a working agent', v && /not on this PC yet/.test(v.status) && /set up with Claude Code/.test(v.status) && /^Set up with Claude Code/.test(await altBtn() || ''), JSON.stringify([v, await altBtn()]));
      const inView = await js(`(() => { const d = document.querySelector('.aiondx-welcome').getBoundingClientRect(); return [...document.querySelectorAll('.aiondx-welcome-actions button')]
        .filter(b => !b.hidden).every(b => { const r = b.getBoundingClientRect(); return r.top >= d.top && r.bottom <= d.bottom + 1; }); })()`);
      check(sc, 'its buttons stay in view with the install line and the explanation above them', inView === true, inView);
      await humanClick('.aiondx-w-alt');
      v = await w();
      check(sc, 'which opens the setup step for that agent', v && v.title === 'Set up your agents' && /^Claude Code \(\w+\) will do this setup\./.test(v.text) && v.buttons.some((b) => /^Let Claude Code \(\w+\) set it up$/.test(b)), JSON.stringify(v));
      await js('window.__calls.length = 0; 0');
      await humanClick('.aiondx-w-go');
      await sleep(700);
      const altChat = await js(`window.__calls.filter(c => c.method === 'POST' && c.path === '/api/conversations').map(c => c.body)`);
      const altBrief = await posts('/api/conversations/newconv1/messages');
      check(sc, 'and sends that agent the brief in a chat of its own', altChat.length === 1 && /^bare:/.test(altChat[0].assistant.id) && altChat[0].assistant.id !== 'bare:a9f3c21e' &&
        altBrief.length === 1 && /aiondx-setup skill/.test(altBrief[0].body.content) && ((await store())['aiondx.welcome'] || {}).mode === 'agent', JSON.stringify([altChat, altBrief.length]));
      // A sign-in that fails also offers it.
      await load('theme=light&welcome=1');
      await sleep(3800);
      check(sc, 'with Antigravity installed the fallback stays hidden', !(await altBtn()));
      await humanClick('.aiondx-w-signin');
      await sleep(600);
      await putStore('aiondx.agy.signin', { state: 'failed', message: 'Antigravity sign-in did not finish within 10 minutes.', conversation: 'newconv1', at: Date.now() + 1000 });
      await js('window.__aionDx.pullNow()');
      await sleep(300);
      v = await w();
      check(sc, "a failed Antigravity sign-in says so and offers the working agent", v && /^Antigravity sign-in did not finish within 10 minutes\. Try again, or set up with Claude Code/.test(v.status) && /^Set up with Claude Code/.test(await altBtn() || ''), JSON.stringify(v));

      // Not now, then reopened from Settings.
      await load('theme=light&welcome=1');
      await sleep(3800);
      await humanClick('.aiondx-w-later');
      check(sc, 'Not now closes it and it stays closed', !(await w()) && ((await store())['aiondx.welcome'] || {}).mode === 'later');
      await js(`(() => { const sec = document.createElement('section'); const grid = document.createElement('div');
        ['light', 'dark'].forEach(id => { const c = document.createElement('div'); c.setAttribute('data-testid', 'theme-card-' + id); c.textContent = id; grid.appendChild(c); });
        sec.appendChild(grid); document.body.appendChild(sec); return 0; })()`);
      await sleep(500);
      await humanClick('[data-testid="aiondx-setup-open"]');
      v = await w();
      check(sc, 'Settings > Appearance has Open AionDX setup, which brings it back', v && v.title === 'Welcome to AionDX', JSON.stringify(v));
    }

    // ---- the Claude usage meter (2026-09-26) ----
    {
      const sc = 'usage';
      await load('theme=light');
      const nowS = Math.floor(Date.now() / 1000);
      await putStore('aiondx.usage.acct.k1', { label: 'Main', at: Date.now() - 60000, status: 'allowed_warning',
        five_hour: { u: 0.92, reset: nowS + 1800, status: 'allowed_warning' }, seven_day: { u: 0.87, reset: nowS + 4 * 86400, status: 'allowed_warning' } });
      await putStore('aiondx.usage.conv.harness1', { acct: 'k1', at: Date.now() });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      const meter = (scope) => js(`(() => { const m = document.querySelector(${JSON.stringify((scope ? scope + ' ' : '') + '[data-testid="aiondx-usage"]')}); if (!m) return null;
        const n = m.nextElementSibling; return { text: m.querySelector('.aiondx-usage-text').textContent, next: n && n.getAttribute('data-testid'),
          bars: [...m.querySelectorAll('.aiondx-usage-bar i')].map(i => i.style.width), title: m.title, compact: m.classList.contains('aiondx-usage--compact'),
          limit: m.getAttribute('data-limit'), h: Math.round(m.getBoundingClientRect().height) }; })()`);
      let um = await meter('');
      check(sc, "a Claude chat shows its account's 5-hour and weekly usage just left of the agent control", um && um.text === '5h 92% \u00b7 wk 87%' &&
        um.next === 'aiondx-account' && parseFloat(um.bars[0]) === 92 && parseFloat(um.bars[1]) === 87 && um.h <= 20, JSON.stringify(um));
      check(sc, 'its tooltip names the account and when each window resets', um && /^Claude usage, Main: 5-hour window 92% \(resets .+\); week 87% \(resets .+\)\. Read at /.test(um.title), um && um.title);
      await shot('click-test-usage');
      await putStore('aiondx.usage.acct.k1', { label: 'Main', at: Date.now() - 45 * 60000, five_hour: { u: 0.5 }, seven_day: { u: 0.5 } });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      um = await meter('');
      check(sc, 'a reading older than 30 minutes is shown dimmed, and its tooltip says how old it is',
        um && await js('document.querySelector(\'[data-testid="aiondx-usage"]\').getAttribute("data-stale")') === '1' && /\(45 minutes ago; it may be higher now\)/.test(um.title), JSON.stringify(um));
      await putStore('aiondx.usage.acct.k1', { label: 'Main', at: Date.now() - 13 * 3600000, five_hour: { u: 0.5 }, seven_day: { u: 0.5 } });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      check(sc, 'a reading older than 12 hours is not shown', !(await meter('')));
      await putStore('aiondx.usage.acct.k1', { label: 'Main', at: Date.now() - 2 * 3600000, five_hour: { u: 0.9, reset: nowS - 600, status: 'allowed_warning' }, seven_day: { u: 0.4, reset: nowS + 86400 } });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      um = await meter('');
      check(sc, 'a window past its reset time reads 0%, not the old figure', um && um.text === '5h 0% \u00b7 wk 40%' && /5-hour window 0% \(has reset\)/.test(um.title), JSON.stringify(um));
      // Where the chat is too narrow for the meter it gives way, and the account pill's hover card carries the figures.
      await putStore('aiondx.usage.acct.k1', { label: 'Main', at: Date.now() - 60000, status: 'allowed_warning',
        five_hour: { u: 0.92, reset: nowS + 1800, status: 'allowed_warning' }, seven_day: { u: 0.87, reset: nowS + 4 * 86400, status: 'allowed_warning' } });
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(300);
      await hover('[data-testid="aiondx-account"]');
      let ti = await tipInfo();
      check(sc, "hovering the account pill shows the agent and the usage", ti && /^Agent: /.test(ti.title) && ti.points.length === 2 && /^5-hour window 92% \(resets /.test(ti.points[0]) && /^Week 87%/.test(ti.points[1]) && /^Claude usage, Main, read just now\.$/.test(ti.body), JSON.stringify(ti));
      await unhover();
      const narrow = await js(`(() => { const m = document.querySelector('[data-testid="aiondx-usage"]'); const p = m.parentNode;
        const keep = p.style.cssText; p.style.cssText = keep + ';width:150px;max-width:150px;overflow:hidden'; window.__aionDx.repaint();
        const r = { narrow: m.getAttribute('data-narrow'), shown: getComputedStyle(m).display !== 'none' }; p.style.cssText = keep; window.__aionDx.repaint(); r.after = m.getAttribute('data-narrow'); return r; })()`);
      check(sc, 'a chat too narrow for the meter hides it, and shows it again when there is room', narrow && narrow.narrow === '1' && narrow.shown === false && narrow.after === null, JSON.stringify(narrow));
      await load('team=1&theme=light');
      await putStore('aiondx.usage.acct.k2', { label: 'Second', at: Date.now(), status: 'rejected',
        five_hour: { u: 1, reset: nowS + 7200, status: 'rejected' }, seven_day: { u: 0.8, reset: nowS + 3 * 86400, status: 'allowed_warning' } });
      await putStore('aiondx.usage.conv.convB', { acct: 'k2', at: Date.now() });
      await sleep(900);
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(400);
      um = await meter('[data-slot-id="slotB"]');
      check(sc, 'a team column shows the bars alone, and a reached limit is marked', um && um.compact && um.limit === 'reached' && /5-hour window 100%, limit reached/.test(um.title), JSON.stringify(um));
      check(sc, 'a member with no reading shows none', !(await meter('[data-slot-id="slotA"]')));
      // The single view of a team: no column around the member in front (a request of 2026-10-02).
      await load('team=1&single=1&front=slotB&theme=light');
      await putStore('aiondx.usage.acct.k2', { label: 'Second', at: Date.now(), status: 'allowed_warning',
        five_hour: { u: 0.6, reset: nowS + 7200, status: 'allowed' }, seven_day: { u: 0.8, reset: nowS + 3 * 86400, status: 'allowed_warning' } });
      await putStore('aiondx.usage.conv.convB', { acct: 'k2', at: Date.now() });
      await sleep(900);
      await js('window.__aionDx.pullNow()');
      await js('window.__aionDx.repaint()');
      await sleep(500);
      um = await meter('');
      check(sc, "the single view of a team shows the usage of the member in front, in full", um && !um.compact && um.text === '5h 60% \u00b7 wk 80%' && /^Claude usage, Second: 5-hour window 60%/.test(um.title), JSON.stringify(um));
      await js("localStorage.setItem('team-active-slot-team1', 'slotA'); window.__aionDx.repaint(); 0");
      await sleep(500);
      check(sc, 'and moves with the tab in front: the lead has no reading, so no meter', !(await meter('')));
    }

    // ---- opening a chat does not start its agent (2026-09-26, a request) ----
    // The page's POST /api/conversations/{id}/runtime/ensure starts a Claude or Codex process; the first message starts it anyway.
    {
      const sc = 'chat-start';
      await load('theme=light');
      await js(`(() => {
        const R = window.__stub.routes;
        const conv = (id, type, hasTask) => ({ success: true, data: { id, name: id, type, status: 'finished', extra: { backend: type === 'acp' ? 'claude' : type },
          runtime: { has_task: hasTask, state: hasTask ? 'idle' : 'none', can_send_message: true, is_processing: false } } });
        const ensured = { success: true, data: { recovered: false, config_options: [{ id: 'model', current_value: 'sonnet' }] } };
        for (const [id, type, hasTask] of [['cold1', 'acp', false], ['cold2', 'acp', false], ['cold3', 'acp', false], ['warm1', 'acp', true], ['agy1', 'antigravity', false], ['cold4', 'acp', false]]) {
          R['GET /api/conversations/' + id] = conv(id, type, hasTask);
          R['POST /api/conversations/' + id + '/runtime/ensure'] = ensured;
          R['POST /api/conversations/' + id + '/messages'] = { success: true, data: { msg_id: 'm-' + id } };
          R['POST /api/conversations/' + id + '/side-question'] = { success: true, data: { answer: 'ok' } };
        }
        window.__ensure = {};
        window.__startEnsure = (id) => {
          const rec = window.__ensure[id] = window.__ensure[id] || [];
          const i = rec.length;
          rec.push('pending');
          fetch('http://127.0.0.1:58699/api/conversations/' + id + '/runtime/ensure', { method: 'POST', credentials: 'include', headers: { 'x-csrf-token': 't' } })
            .then(r => r.json()).then(j => { rec[i] = j && j.data && j.data.config_options ? 'answered' : 'odd'; }, () => { rec[i] = 'failed'; });
          return 0;
        };
        window.__calls.length = 0;
        return 0; })()`);
      const ensures = (id) => js(`window.__calls.filter(c => c.method === 'POST' && c.path === '/api/conversations/${id}/runtime/ensure').length`);
      const state = (id) => js(`JSON.stringify(window.__ensure['${id}'] || [])`);
      const postOrder = (id) => js(`window.__calls.filter(c => c.method === 'POST' && c.path.indexOf('/api/conversations/${id}/') === 0).map(c => c.path.split('/').pop()).join(',')`);
      await js("window.__startEnsure('cold1'); window.__startEnsure('cold1'); 0");
      await sleep(400);
      check(sc, "a chat whose agent is not running: the page's start calls are held, and none reaches the backend", (await ensures('cold1')) === 0 &&
        (await state('cold1')) === '["pending","pending"]' && (await js('window.__aionDx.heldStarts().cold1')) === 2, await state('cold1'));
      const sent = await js("fetch('/api/conversations/cold1/messages', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) }).then(r => r.status)");
      await sleep(400);
      check(sc, 'the first message goes through, then one start call reaches the backend and both callers get its answer', sent === 200 &&
        (await ensures('cold1')) === 1 && (await state('cold1')) === '["answered","answered"]' && !(await js('window.__aionDx.heldStarts().cold1')), await state('cold1'));
      check(sc, 'in that order: the message, then the start', (await postOrder('cold1')) === 'messages,ensure', await postOrder('cold1'));
      await js("window.__startEnsure('warm1'); window.__startEnsure('agy1'); 0");
      await sleep(400);
      check(sc, 'a chat whose agent runs, and an Antigravity chat, get the real call at once', (await ensures('warm1')) === 1 && (await ensures('agy1')) === 1 &&
        (await state('warm1')) === '["answered"]' && (await state('agy1')) === '["answered"]', (await state('warm1')) + (await state('agy1')));
      await js("window.__startEnsure('cold2'); 0");
      await sleep(300);
      const btw = await js("fetch('/api/conversations/cold2/side-question', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'q' }) }).then(r => r.status)");
      await sleep(200);
      check(sc, 'a /btw question starts the agent first, then goes through', btw === 200 && (await postOrder('cold2')) === 'ensure,side-question' &&
        (await state('cold2')) === '["answered"]', await postOrder('cold2'));
      await js("location.hash = '#/conversation/cold3'; window.__startEnsure('cold3'); 0");
      await sleep(500);
      check(sc, 'the open chat is marked while its start is held', (await js("document.documentElement.getAttribute('data-aiondx-held')")) === 'cold3',
        await js("document.documentElement.getAttribute('data-aiondx-held')"));
      await humanClick('#solo [data-testid="acp-model-selector"]');
      await sleep(300);
      check(sc, 'pressing its model pill starts it, so its models load', (await ensures('cold3')) === 1 && (await state('cold3')) === '["answered"]' &&
        !(await js("document.documentElement.getAttribute('data-aiondx-held')")), await state('cold3'));
      await js("location.hash = ''; localStorage.setItem('aionui.dx.disabled', '1'); window.__startEnsure('cold4'); 0");
      await sleep(400);
      check(sc, 'with the kill switch on, the call goes through as stock', (await ensures('cold4')) === 1, await state('cold4'));
      await js("localStorage.removeItem('aionui.dx.disabled'); window.__startEnsure('nosuch'); 0");
      await sleep(400);
      check(sc, 'a chat it cannot look up gets the real call', (await ensures('nosuch')) === 1, await state('nosuch'));
    }

    // ---- opening a team does not wake it (P-011, 2026-09-24) ----
    // The page's POST /api/teams/{id}/session starts a stopped team and drains the lead's mailbox.
    {
      const sc = 'team-wake';
      await load('team=1&theme=light');
      const sessionPosts = () => js("window.__calls.filter(c => c.method === 'POST' && /\\/api\\/teams\\/team1\\/session$/.test(c.path)).length");
      const callSession = (url) => js(`fetch(${JSON.stringify(url)}, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json())`);
      await js("window.__calls.length = 0; 0");
      let r = await callSession('/api/teams/team1/session');
      check(sc, 'a team whose session is running gets the real call', r && r.success === true && (await sessionPosts()) === 1, JSON.stringify(r));
      await js("(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.session_generation = null; return 0; })()");
      await js("window.__calls.length = 0; 0");
      r = await callSession('/api/teams/team1/session');
      check(sc, 'a team with no session is not woken by the page', r && r.success === true && (await sessionPosts()) === 0, JSON.stringify(r));
      check(sc, 'and the Loop script records that it held the call', await js('!!window.__aionDx.heldWakes().team1'));
      r = await callSession('http://127.0.0.1:58699/api/teams/team1/session');
      check(sc, 'the absolute-URL form is held too', r && r.success === true && (await sessionPosts()) === 0);
      const msg = await js("fetch('/api/teams/team1/agents/slotB/messages', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) }).then(r => r.status)");
      check(sc, 'a real message still goes to the backend (it starts the session there)', msg === 200 && (await posts('/api/teams/team1/agents/slotB/messages')).length === 1, msg);
      await js("localStorage.setItem('aionui.dx.disabled', '1'); 0");
      r = await callSession('/api/teams/team1/session');
      check(sc, 'with the kill switch on, the call goes through as stock', (await sessionPosts()) === 1);
      await js("localStorage.removeItem('aionui.dx.disabled'); 0");

      // The Loop itself must not start a stopped team either (2026-09-25: its nudge was the send
      // that started the team after a restart).
      await load('team=1&theme=light');
      await armVia('[data-slot-id="slotB"]');
      await js("(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.session_generation = null; return 0; })()");
      await js('window.__calls.length = 0; 0');
      await js('window.__aionDx.tickNow()');
      const st = await saved(KEY_B);
      check(sc, 'an armed Loop does not nudge a team with no session', (await posts('/api/teams/team1/agents/slotB/messages')).length === 0 &&
        st && st.why === 'Waiting: the team is not started. It starts when you send it a message.', st && st.why);
      await js("(() => { window.__stub.routes['GET /api/teams/team1/run-state'].data.session_generation = 'g2'; return 0; })()");
      await js('window.__aionDx.tickNow()');
      check(sc, 'and nudges it once the session is running', (await posts('/api/teams/team1/agents/slotB/messages')).length === 1);
    }

    clearTimeout(deadline);
    let failed = 0;
    for (const r of results) {
      if (!r.ok) failed++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(13)} ${r.name}${r.ok || !r.detail ? '' : `   [${r.detail}]`}`);
    }
    finish(failed ? 1 : 0, `\n${results.length - failed}/${results.length} passed`);
  } catch (e) {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(13)} ${r.name}`);
    finish(2, `ERROR: ${e.message}`);
  }
})();
