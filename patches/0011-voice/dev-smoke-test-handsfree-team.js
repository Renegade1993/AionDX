#!/usr/bin/env node
/**
 * dev-smoke-test-handsfree-team.js - hands-free conversation mode on a team page, targeting the
 * lead's own column specifically (the scenario a user reported testing: "the wake word on me, the
 * lead agent" - a #/team/<id> page, not #/conversation/<id>, which the first version of this
 * feature matched exclusively). Same real aiondx-voice.js/aiondx-voice-ui.js, real mouse input,
 * fake mic and stubbed fetch as dev-smoke-test-handsfree.js; only the page and the turn-finished
 * source (run-state's slot_work, not a conversation's own status) differ.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9399;
const BASE = 'file:///' + path.join(__dirname, 'dev-harness-handsfree-team.html').split(path.sep).join('/');
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-voice-handsfree-team-profile');

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--window-size=1100,700', BASE,
], { windowsHide: true, stdio: 'ignore' });

function finish(code, msg) {
  if (msg) console.log(msg);
  try { edge.kill(); } catch { /* already gone */ }
  process.exit(code);
}
const deadline = setTimeout(() => finish(2, 'DEADLINE: team hands-free smoke test did not finish within 60 s'), 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('dev-harness-handsfree-team.html'));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools target never appeared');
}

(async () => {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
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
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const waitFor = async (expression, tries = 60) => {
      for (let i = 0; i < tries; i++) { if (await js(expression)) return true; await sleep(100); }
      return false;
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
      await sleep(200);
    };
    const speak = async (text, speakMs = 120) => {
      await js(`window.__sttQueue.push(${JSON.stringify(text)})`);
      await js('window.__hf.level = 1');
      await sleep(speakMs);
      await js('window.__hf.level = 0');
    };

    await sleep(500);
    await js(`window.__aionDxVoice.setSettings({ provider: 'elevenlabs', apiKey: 'test-key', voiceId: 'v1' })`);

    check('two composers on the page (lead and teammate columns)', (await js('document.querySelectorAll("[data-testid=\\"sendbox-input\\"]").length')) === 2);

    // ---- enabling hands-free on a team page targets the lead's column, not the teammate's ----
    await humanClick('#aiondx-voice-handsfree');
    check('it starts the wake stage on the team page',
      await waitFor('window.__aionDxVoiceUI.hfState().active && window.__aionDxVoiceUI.hfState().state === "wake"'));
    check('the wake badge is visible in the lead\'s column specifically',
      await js('!document.querySelector(\'[data-slot-id="slotA"] .aiondx-voice-hf\').hidden'));
    check('and hidden in the teammate\'s column, even though it has its own badge element too',
      await js('document.querySelector(\'[data-slot-id="slotB"] .aiondx-voice-hf\').hidden === true'));

    // ---- the wake phrase and the turn both flow through the lead's own composer ----
    await speak('Hey AionDX');
    check('wake phrase heard -> listening', await waitFor('window.__aionDxVoiceUI.hfState().state === "listening"', 40));
    await speak('what is the project status');
    check('the turn is auto-sent through the lead\'s composer specifically',
      await waitFor('(window.__sentMessages || []).includes("what is the project status")', 40));
    check('the teammate\'s composer was never touched',
      await js('document.querySelectorAll("[data-slot-id=\\"slotB\\"] [data-testid=\\"sendbox-input\\"]")[0].value === ""'));
    check('waiting for the reply, read from run-state (not a conversation status)',
      await waitFor('window.__aionDxVoiceUI.hfState().state === "waiting-reply"', 20));

    // ---- run-state staying "running" must not be mistaken for finished ----
    await sleep(600);
    check('still waiting while run-state says the lead is running', await js('window.__aionDxVoiceUI.hfState().state === "waiting-reply"'));

    // ---- once the lead's slot goes idle, the reply (in the lead's column) auto-plays ----
    await js(`window.__agentReply('The project is on track.')`);
    await js(`window.__runState.leadState = 'idle'`);
    check('the reply in the lead\'s column auto-plays',
      await waitFor('["loading", "playing"].includes((document.querySelector("[data-slot-id=\\"slotA\\"] .aiondx-voice-play-btn") || {}).dataset && document.querySelector("[data-slot-id=\\"slotA\\"] .aiondx-voice-play-btn").dataset.state)', 40));
    check('back to listening once it finishes, not the wake phrase',
      await waitFor('window.__aionDxVoiceUI.hfState().state === "listening"', 40));

    // ---- the stop-all button in the lead's column tears it down ----
    await humanClick('[data-slot-id="slotA"] .aiondx-voice-stopall-btn');
    check('the lead column\'s stop-all button ends hands-free mode',
      await js('window.__aionDxVoiceUI.hfState().active === false'));

  } catch (e) {
    check('smoke test ran without throwing', false, e.stack || String(e));
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})();
