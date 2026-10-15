#!/usr/bin/env node
/**
 * dev-smoke-test-real.js - like dev-smoke-test.js, but against dev-harness-real.html: the real
 * aiondx-voice.js (window.AionDxVoice) and the real aiondx-voice-ui.js wiring
 * (window.__aionDxVoice = AionDxVoice.createVoiceClient(...)), with only window.fetch stubbed
 * (the settings store's GET/PUT and ElevenLabs' three endpoints) - no stand-in UI shim. This is
 * the "end to end against the real implementation" check, not just the UI-shaped stub.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9377;
const BASE = 'file:///' + path.join(__dirname, 'dev-harness-real.html').split(path.sep).join('/');
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-voice-real-smoke-profile');

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
const deadline = setTimeout(() => finish(2, 'DEADLINE: real-module smoke test did not finish within 60 s'), 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('dev-harness-real.html'));
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
    const waitFor = async (expression, tries = 50) => {
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

    await sleep(700);

    // ---- the real module is what's loaded ----
    check('window.AionDxVoice (the real module) is present', await js('typeof window.AionDxVoice === "object"'));
    check('aiondx-voice-ui.js built the client from it', await js('typeof window.__aionDxVoice === "object" && typeof window.__aionDxVoice.transcribe === "function"'));
    check('it is not the dev stub', await js('typeof window.__aionDxVoiceStubCalls === "undefined"'));

    // ---- configure a provider through the settings panel before anything can transcribe/synthesize ----
    check('the settings panel is present', await js('!!document.querySelector("[data-testid=\\"aiondx-voice-panel\\"]")'));
    check('the provider select offers elevenlabs', await waitFor('[...document.querySelectorAll("#aiondx-voice-provider option")].some(o => o.value === "elevenlabs")'));
    await js(`(() => { document.querySelector('#aiondx-voice-provider').value = 'elevenlabs';
      document.querySelector('#aiondx-voice-provider').dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
    await humanClick('#aiondx-voice-apikey');
    await js(`(() => { const el = document.querySelector('#aiondx-voice-apikey');
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, 'test-key-123');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
    await sleep(600);   // the apiKey save's debounce
    check('the voice select is populated from the real listVoices() call',
      await waitFor('document.querySelector("#aiondx-voice-voice").options.length >= 2', 50));
    await js(`(() => { const sel = document.querySelector('#aiondx-voice-voice'); if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
      sel.dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
    await sleep(400);
    const savedConfig = await js('window.__aionDxVoice.getSettings().then(s => JSON.stringify(s))');
    check('setSettings actually reached the stubbed /api/settings/client store', /elevenlabs/.test(savedConfig || '') && /test-key-123/.test(savedConfig || ''), savedConfig);

    // ---- mic: record, stop, real transcribe() through the stubbed ElevenLabs endpoint ----
    await humanClick('.aiondx-voice-mic-btn');
    check('clicking the mic starts recording', await waitFor('document.querySelector(".aiondx-voice-mic-btn").dataset.state === "recording"'));
    await sleep(500);
    await humanClick('.aiondx-voice-mic-btn');
    check('stopping settles back to idle', await waitFor('document.querySelector(".aiondx-voice-mic-btn").dataset.state === "idle"', 60));
    const taValue = await js('document.querySelector("[data-testid=\\"sendbox-input\\"]").value');
    check('the real module\'s transcript landed in the composer', taValue === 'real-module transcript', taValue);
    check('the real module called ElevenLabs\' speech-to-text endpoint',
      await js('window.__fetchCalls.some(c => c.url === "https://api.elevenlabs.io/v1/speech-to-text" && c.method === "POST")'));

    // ---- playback: real synthesize() through the stubbed text-to-speech endpoint ----
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    check('clicking play moves to loading or playing',
      await waitFor('["loading", "playing"].includes(document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state)'));
    check('playback settles back to idle once the clip ends',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 60));
    check('the real module called ElevenLabs\' text-to-speech endpoint',
      await js('window.__fetchCalls.some(c => c.url.indexOf("https://api.elevenlabs.io/v1/text-to-speech/") === 0 && c.method === "POST")'));

  } catch (e) {
    check('smoke test ran without throwing', false, e.stack || String(e));
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})();
