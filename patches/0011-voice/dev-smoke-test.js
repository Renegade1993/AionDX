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
    // A plain scripted .click(), for the one spot where two clicks need to land closer together
    // than humanClick's ~320ms of press/settle overhead allows (racing a second message's play
    // against the stub's 150ms synthesize() delay on the first).
    const fastClick = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

    await sleep(600);   // first render pass

    // ---- spokenText(): markdown stripped so ElevenLabs reads naturally, not literal syntax ----
    const spoken = (raw) => js(`window.__aionDxVoiceUI.spokenText(${JSON.stringify(raw)})`);
    check('a fenced code block becomes a short spoken placeholder, not read verbatim',
      await spoken('Here is the fix:\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nThat should do it.')
        .then((s) => /a snippet of js code/i.test(s) && !/function add/.test(s) && /Here is the fix/.test(s) && /That should do it/.test(s)),
      await spoken('Here is the fix:\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nThat should do it.'));
    check('a fenced block with no language hint still gets a placeholder',
      await spoken('```\nraw text\n```').then((s) => /code block/i.test(s) && !/raw text/.test(s)));
    check('inline code spans are read plainly, backticks stripped',
      await spoken('Set `maxRetries` to 3.').then((s) => s === 'Set maxRetries to 3.'), await spoken('Set `maxRetries` to 3.'));
    check('headings, bold, italic and list markers are stripped',
      await spoken('# Summary\n\nThis is **important** and *urgent*.\n\n- first item\n- second item\n1. step one')
        .then((s) => s === 'Summary This is important and urgent. first item second item step one'),
      await spoken('# Summary\n\nThis is **important** and *urgent*.\n\n- first item\n- second item\n1. step one'));
    check('a markdown link reads its text, not the brackets or URL',
      await spoken('See [the docs](https://example.com/docs) for more.').then((s) => s === 'See the docs for more.'));
    check('plain text with no markdown passes through unchanged (aside from whitespace)',
      await spoken('Just a plain sentence, nothing special.').then((s) => s === 'Just a plain sentence, nothing special.'));

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

    // ---- the global "stop all reading" button ----
    check('a stop-all button is inserted in the composer, next to the mic', await js('!!document.querySelector(".sendbox-actions .aiondx-voice-stopall-btn")'));
    check('it starts disabled with nothing playing', await js('document.querySelector(".aiondx-voice-stopall-btn").disabled === true'));
    await humanClick('#message-a1 .aiondx-voice-play-btn');
    check('it becomes enabled once something is reading', await waitFor('document.querySelector(".aiondx-voice-stopall-btn").disabled === false'));
    await humanClick('.aiondx-voice-stopall-btn');
    check('clicking it stops the playback that was in flight',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 20));
    check('and disables itself again once nothing is playing', await js('document.querySelector(".aiondx-voice-stopall-btn").disabled === true'));

    // ---- regression: a second message's play button must not leave the first stuck "loading" ----
    // Before the fix, clicking message 2 while message 1 was still waiting on synthesize() never
    // touched message 1's button (nothing reset it), and message 1's request, once it resolved,
    // could go on to fight message 2's for the one Audio element - a real bug this project's user
    // hit during live testing, not just a cosmetic one: a dangling request plus a button with no
    // way out looks exactly like a hang.
    const synthBeforeRace = await js('window.__aionDxVoiceStubCalls.filter(c => c.name === "synthesize").length');
    await fastClick('#message-a1 .aiondx-voice-play-btn');
    check('message 1 starts loading', await js('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "loading"'));
    await fastClick('#message-a2 .aiondx-voice-play-btn');   // landed well inside the stub's 150ms synthesize() delay on message 1
    check('message 1 is released back to idle, not left stuck loading',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 10));
    check('message 2 goes on to play and then settle, unaffected by message 1\'s stale request',
      await waitFor('["loading", "playing"].includes(document.querySelector("#message-a2 .aiondx-voice-play-btn").dataset.state)'));
    check('message 2 settles back to idle once its clip ends',
      await waitFor('document.querySelector("#message-a2 .aiondx-voice-play-btn").dataset.state === "idle"', 60));
    check('message 1 never re-entered loading/playing once superseded (no stale resolve fired)',
      await waitFor('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state === "idle"', 5));
    const synthAfterRace = await js('window.__aionDxVoiceStubCalls.filter(c => c.name === "synthesize").length');
    check('both requests reached the module (message 1\'s discarded client-side, message 2\'s honoured)',
      synthAfterRace - synthBeforeRace === 2, `before=${synthBeforeRace} after=${synthAfterRace}`);
    check('only one playback is ever active at once: the stop-all button is idle again at the end',
      await js('document.querySelector(".aiondx-voice-stopall-btn").disabled === true'));

    // ---- only what a reply shows is read: its shadow root also holds ShadowView's <style> ----
    // 0.26.7: the speaker read a team member's reply, then went on with "shadow DOM and other code" - the CSS comments of the
    // stylesheet AionUi puts in each reply's shadow root, along with a code block's raw text, its Copy button and collapsed output.
    await js(`(() => {
      const row = document.createElement('div'); row.id = 'message-shadow1'; row.setAttribute('data-message-type', 'text'); row.setAttribute('data-message-position', 'left');
      const content = document.createElement('div'); content.setAttribute('data-testid', 'message-text-content');
      const host = document.createElement('div'); host.className = 'markdown-shadow'; content.appendChild(host); row.appendChild(content);
      const root = host.attachShadow({ mode: 'open' });
      const body = document.createElement('div'); body.className = 'markdown-shadow-body';
      body.innerHTML = '<p>Here is the fix.</p><div><button>Copy</button><pre><code class="language-js">console.log("raw code")</code></pre></div>' +
        '<details><summary>Ran 2 tools</summary><div>collapsed tool output</div></details><span style="display:none">hidden debug</span>' +
        '<span aria-hidden="true">decorative</span><span class="aiondx-loop-pill">Loop</span><p>That is all.</p>';
      const st = document.createElement('style'); st.textContent = '/* Shadow DOM CSS variable definitions */ :host { color: red } /* Code block horizontal scrollbar */';
      root.appendChild(body); root.appendChild(st);
      document.querySelector('#message-a2').after(row); return 0; })()`);
    await waitFor('!!document.querySelector("#message-shadow1 .aiondx-voice-play-btn")', 40);
    const synthBeforeShadow = await js('window.__aionDxVoiceStubCalls.filter(c => c.name === "synthesize").length');
    await humanClick('#message-shadow1 .aiondx-voice-play-btn');
    await waitFor(`window.__aionDxVoiceStubCalls.filter(c => c.name === "synthesize").length > ${synthBeforeShadow}`, 30);
    const shadowSaid = await js('window.__aionDxVoiceStubCalls.filter(c => c.name === "synthesize").pop().args[0]');
    check('a reply in a shadow root is read as it shows: its text, the code block named', /^Here is the fix\. a snippet of js code\. Ran 2 tools That is all\.$/.test(shadowSaid), shadowSaid);
    check('and nothing it does not show: no stylesheet, raw code, Copy button, collapsed or hidden text, or another patch\'s pill',
      !/Shadow DOM|scrollbar|:host|raw code|Copy|collapsed|hidden debug|decorative|Loop/.test(shadowSaid), shadowSaid);
    await humanClick('.aiondx-voice-stopall-btn');
    await waitFor('document.querySelector("#message-shadow1 .aiondx-voice-play-btn").dataset.state === "idle"', 40);

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
