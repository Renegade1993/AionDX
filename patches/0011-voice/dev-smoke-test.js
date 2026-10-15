#!/usr/bin/env node
/**
 * dev-smoke-test.js - a quick functional check of aiondx-voice-ui.js against dev-harness.html and
 * voice-provider.stub.js, the same DevTools-protocol technique tools\dx-harness\click-test.js uses
 * for patch 0001 (real mouse input, one headless Edge, a local debugging port). Not the full
 * click-test.js style suite; just enough to prove the mic button, the playback button and the
 * settings panel work end to end against a stand-in provider before the real one is wired in.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9344;
const BASE = 'file:///' + path.join(__dirname, 'dev-harness.html').replace(/\\/g, '/');
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-voice-smoke-profile');

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--window-size=900,700', BASE,
], { windowsHide: true, stdio: 'ignore' });

function finish(code, msg) {
  if (msg) console.log(msg);
  try { edge.kill(); } catch { /* already gone */ }
  process.exit(code);
}
const deadline = setTimeout(() => finish(2, 'DEADLINE: smoke test did not finish within 60 s'), 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('dev-harness.html'));
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
    const waitFor = async (expression, tries = 40) => {
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

    await sleep(600);   // first render pass

    // ---- mic button present, idle ----
    check('mic button is inserted in .sendbox-actions', await js('!!document.querySelector(".sendbox-actions .aiondx-voice-mic-btn")'));
    check('mic button starts idle', (await js('document.querySelector(".aiondx-voice-mic-btn").dataset.state')) === 'idle');

    // ---- record, stop, transcript lands in the box ----
    await humanClick('.aiondx-voice-mic-btn');
    check('clicking the mic starts recording', await waitFor('document.querySelector(".aiondx-voice-mic-btn").dataset.state === "recording"'));
    await sleep(500);
    await humanClick('.aiondx-voice-mic-btn');
    check('stopping moves to transcribing then back to idle',
      await waitFor('document.querySelector(".aiondx-voice-mic-btn").dataset.state === "idle"', 60));
    const taValue = await js('document.querySelector("[data-testid=\\"sendbox-input\\"]").value');
    check('the stub transcript landed in the composer', /stub transcript/.test(taValue || ''), taValue);
    const transcribeCalls = await js('window.__aionDxVoiceStubCalls.filter(c => c.name === "transcribe").length');
    check('transcribe() was called on the voice module', transcribeCalls === 1, transcribeCalls);

    // ---- playback button on the agent message ----
    check('play button is inserted on the agent message', await js('!!document.querySelector("#message-a1 .aiondx-voice-play-btn")'));
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    check('clicking play moves to loading or playing',
      await waitFor('["loading", "playing"].includes(document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state)'));
    check('playback settles back to idle once the clip ends',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 60));
    const synthCalls = await js('window.__aionDxVoiceStubCalls.filter(c => c.name === "synthesize").length');
    check('synthesize() was called with the message text', synthCalls === 1 && (await js('window.__aionDxVoiceStubCalls.find(c => c.name === "synthesize").args[0]')).includes('Hello from the agent'));

    // ---- clicking play again while it is playing stops it ----
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "playing"');
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    check('clicking play again while it plays stops it',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 20));

    // ---- settings panel ----
    check('the settings panel was inserted after the theme card', await js('!!document.querySelector("[data-testid=\\"aiondx-voice-panel\\"]")'));
    check('the provider select is populated', await waitFor('document.querySelector("#aiondx-voice-provider").options.length >= 2'));
    check('the voice select is populated', await waitFor('document.querySelector("#aiondx-voice-voice").options.length >= 2'));
    // Focus it first, the way a real user would: refreshVoicePanel only skips overwriting the box
    // while it holds focus (the same guard patch 0001's own colour inputs use).
    await humanClick('#aiondx-voice-apikey');
    await js(`(() => { const el = document.querySelector('#aiondx-voice-apikey');
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, 'sk-test-123');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
    await sleep(600);
    const saved = await js('window.__aionDxVoice.getSettings().then(s => s.apiKey)');
    check('typing an API key saves it through setSettings()', saved === 'sk-test-123', saved);
    const status = await js('document.querySelector("[data-testid=\\"aiondx-voice-status\\"]").textContent');
    check('the panel shows a saved status', /saved/i.test(status || ''), status);

  } catch (e) {
    check('smoke test ran without throwing', false, e.stack || String(e));
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})();
