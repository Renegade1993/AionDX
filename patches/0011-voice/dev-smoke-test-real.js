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
    // A user's path: the provider list already shows ElevenLabs, so nobody touches it - they type a key. Up to 0.26.6 that saved
    // {apiKey} alone and every call then failed "voice: no provider configured" (an earlier version of this test set the provider
    // through the select first, which a user never does, so it never saw that).
    check('the provider select already shows elevenlabs with nothing saved', await js('document.querySelector("#aiondx-voice-provider").value === "elevenlabs"'));
    await humanClick('#aiondx-voice-apikey');
    await js(`(() => { const el = document.querySelector('#aiondx-voice-apikey');
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, 'test-key-123');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 0; })()`);
    await sleep(600);   // the apiKey save's debounce
    const afterKey = await js('window.__aionDxVoice.getSettings().then(s => JSON.stringify(s))');
    check('typing only a key saves the provider the panel shows too', /"provider":"elevenlabs"/.test(afterKey || '') && /test-key-123/.test(afterKey || ''), afterKey);
    check('the voice select is populated from the real listVoices() call',
      await waitFor('document.querySelector("#aiondx-voice-voice").options.length >= 2', 50));
    await js(`(() => { const sel = document.querySelector('#aiondx-voice-voice'); if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
      sel.dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
    await sleep(400);
    const savedConfig = await js('window.__aionDxVoice.getSettings().then(s => JSON.stringify(s))');
    check('setSettings actually reached the stubbed /api/settings/client store', /elevenlabs/.test(savedConfig || '') && /test-key-123/.test(savedConfig || ''), savedConfig);

    // ---- speech language: the same as the app unless chosen, and every transcribe() gets a real code ----
    // (A user's test: short sounds left to auto-detection came back in Japanese and Chinese from English speech.)
    check('the speech language defaults to "the same as the app", naming it',
      await waitFor('document.querySelector("#aiondx-voice-language") && document.querySelector("#aiondx-voice-language").value === "" && /^Same as the app \\(English\\)$/.test(document.querySelector("#aiondx-voice-language").selectedOptions[0].textContent)', 30),
      await js('document.querySelector("#aiondx-voice-language") && document.querySelector("#aiondx-voice-language").selectedOptions[0].textContent'));
    await js(`(() => { window.__transcribeOpts = []; const v = window.__aionDxVoice, orig = v.transcribe.bind(v);
      v.transcribe = function (blob, o) { window.__transcribeOpts.push(o || null); return orig(blob, o); }; return 0; })()`);

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
    check('the mic\'s transcribe() was told the app\'s language', (await js('JSON.stringify(window.__transcribeOpts.pop())')) === '{"language":"en"}', await js('JSON.stringify(window.__transcribeOpts)'));
    await js(`(() => { const s = document.querySelector('#aiondx-voice-language'); s.value = 'ja'; s.dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
    check('choosing a language saves it', await waitFor('window.__aionDxVoice.getSettings().then((s) => s.language === "ja")', 30));
    await humanClick('.aiondx-voice-mic-btn');
    await waitFor('document.querySelector(".aiondx-voice-mic-btn").dataset.state === "recording"');
    await sleep(300);
    await humanClick('.aiondx-voice-mic-btn');
    await waitFor('document.querySelector(".aiondx-voice-mic-btn").dataset.state === "idle"', 60);
    check('and the next transcribe() is told that language instead', (await js('JSON.stringify(window.__transcribeOpts.pop())')) === '{"language":"ja"}', await js('JSON.stringify(window.__transcribeOpts)'));
    await js(`(() => { const s = document.querySelector('#aiondx-voice-language'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return 0; })()`);
    await waitFor('window.__aionDxVoice.getSettings().then((s) => !s.language)', 30);
    await js(`document.querySelector('[data-testid="sendbox-input"]').value = ''; 0`);

    // ---- playback: real synthesize() through the stubbed text-to-speech endpoint ----
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    check('clicking play moves to loading or playing',
      await waitFor('["loading", "playing"].includes(document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state)'));
    check('playback settles back to idle once the clip ends',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 60));
    check('the real module called ElevenLabs\' text-to-speech endpoint',
      await js('window.__fetchCalls.some(c => c.url.indexOf("https://api.elevenlabs.io/v1/text-to-speech/") === 0 && c.method === "POST")'));
    check('both ElevenLabs calls carried the key typed into the panel (not the Windows voice, not no key)',
      await js('["https://api.elevenlabs.io/v1/speech-to-text", "https://api.elevenlabs.io/v1/text-to-speech/"].every((p) => window.__fetchCalls.some((c) => c.url.indexOf(p) === 0 && c.key === "test-key-123"))'),
      JSON.stringify(await js('window.__fetchCalls.filter((c) => /elevenlabs/.test(c.url)).map((c) => c.url.replace("https://api.elevenlabs.io", "") + " " + c.key)')));

    // ---- markdown stripped before it ever reaches the real synthesize() call ----
    const spoken = await js(`window.__aionDxVoiceUI.spokenText(${JSON.stringify('# Title\n\nSee ```js\nconsole.log(1)\n``` and `x` and [a link](http://x).')})`);
    check('spokenText strips markdown the same way against the real module build',
      spoken === 'Title See a snippet of js code. and x and a link.', spoken);

    // ---- the global stop-all control, against the real client ----
    check('the stop-all button is present and starts disabled', await js('!!document.querySelector(".aiondx-voice-stopall-btn") && document.querySelector(".aiondx-voice-stopall-btn").disabled === true'));
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    check('it enables once a real playback starts', await waitFor('document.querySelector(".aiondx-voice-stopall-btn").disabled === false'));
    await humanClick('.aiondx-voice-stopall-btn');
    check('clicking it stops a real in-flight playback', await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 20));

    // ---- a long reply plays in pieces (aiondx-voice.js playChunked), and stopping it stops every later piece ----
    // Click what is on screen: the long reply sits below the fold, and the composer's stop-all scrolls out when it is brought up.
    const clickInView = async (sel) => { await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' }); 0`); await sleep(150); await humanClick(sel); };
    const longText = Array.from({ length: 14 }, (_, i) => `Sentence number ${i + 1} of the long reply, which is here to make it long.`).join(' ');
    await js(`(() => { const row = document.createElement('div'); row.id = 'message-long'; row.setAttribute('data-message-type', 'text'); row.setAttribute('data-message-position', 'left');
      row.innerHTML = '<div data-testid="message-text-content"></div>'; row.firstChild.textContent = ${JSON.stringify(longText)};
      document.querySelector('#message-a1').after(row); return 0; })()`);
    await waitFor('!!document.querySelector("#message-long .aiondx-voice-play-btn")', 40);
    const tts = 'window.__fetchCalls.filter((c) => c.url.indexOf("https://api.elevenlabs.io/v1/text-to-speech/") === 0)';
    const ttsBefore = await js(`${tts}.length`);
    await clickInView('#message-long .aiondx-voice-play-btn');
    check('a long reply starts playing', await waitFor('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state === "playing"', 60));
    const firstPiece = await js(`${tts}[${ttsBefore}] && ${tts}[${ttsBefore}].text`);
    check('its first request is a short first piece, not the whole reply', !!firstPiece && firstPiece.length <= 160 && longText.startsWith(firstPiece), JSON.stringify(firstPiece));
    await clickInView('.aiondx-voice-stopall-btn');
    check('stop-all stops it at once', await waitFor('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state === "idle" && !window.__aionDxVoiceUI.playing()', 20));
    const ttsAtStop = await js(`${tts}.length`);
    await sleep(3500);   // longer than one 1.5 s stub clip: a piece still queued would have started by now
    check('and no later piece is requested or played after the stop', (await js(`${tts}.length`)) === ttsAtStop && (await js('!window.__aionDxVoiceUI.playing()')) && (await js('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state')) === 'idle',
      `requests at stop ${ttsAtStop}, now ${await js(`${tts}.length`)}`);
    // The speaker's own second click, the same.
    await clickInView('#message-long .aiondx-voice-play-btn');
    await waitFor('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state === "playing"', 60);
    await clickInView('#message-long .aiondx-voice-play-btn');
    check('the speaker\'s second click stops it at once', await waitFor('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state === "idle" && !window.__aionDxVoiceUI.playing()', 20));
    const ttsAtClick = await js(`${tts}.length`);
    await sleep(3500);
    check('and nothing more is requested or played after it', (await js(`${tts}.length`)) === ttsAtClick && (await js('!window.__aionDxVoiceUI.playing()')),
      `requests at stop ${ttsAtClick}, now ${await js(`${tts}.length`)}`);
    // Played to the end: every piece in turn, the button "playing" throughout, idle only after the last.
    const ttsBeforeFull = await js(`${tts}.length`);
    await clickInView('#message-long .aiondx-voice-play-btn');
    await waitFor('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state === "playing"', 60);
    let sawIdleEarly = false;
    for (let i = 0; i < 200; i++) {
      const st = await js('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state');
      const n = (await js(`${tts}.length`)) - ttsBeforeFull;
      if (st !== 'playing') { if (n < 3) sawIdleEarly = true; break; }
      await sleep(100);
    }
    const fullTexts = await js(`${tts}.slice(${ttsBeforeFull}).map((c) => c.text)`);
    check('played to the end, it requested every piece in order, and the pieces make up the reply',
      fullTexts.length >= 3 && fullTexts.join(' ') === longText, `${fullTexts.length} pieces`);
    check('the button stayed "playing" until the last piece, then went idle', !sawIdleEarly && (await js('document.querySelector("#message-long .aiondx-voice-play-btn").dataset.state')) === 'idle');

    // ---- a record an earlier build left with a key and no provider (what the user had) is mended on the next load ----
    await js(`window.__aionDxVoice.setSettings({ provider: null })`);
    const broken = await js('window.__aionDxVoice.synthesize("x").then(() => "ok", (e) => e.message)');
    check('(setup) a key with no provider fails the way 0.26.6 did', /no provider configured/.test(broken || ''), broken);
    await js('window.__aionDxVoiceUI.reloadSettings()');
    const mended = await waitFor('window.__aionDxVoice.getSettings().then((s) => s.provider === "elevenlabs" && s.apiKey === "test-key-123")', 40);
    check('the next settings load saves the provider the panel shows, keeping the key', mended, await js('window.__aionDxVoice.getSettings().then((s) => JSON.stringify(s))'));
    check('and synthesize works again', (await js('window.__aionDxVoice.synthesize("x").then(() => "ok", (e) => e.message)')) === 'ok');

  } catch (e) {
    check('smoke test ran without throwing', false, e.stack || String(e));
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})();
