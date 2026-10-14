#!/usr/bin/env node
/**
 * dev-smoke-test-handsfree.js - hands-free conversation mode end to end, against the real
 * aiondx-voice.js (its wake-phrase listener and utterance capture) and the real
 * aiondx-voice-ui.js, driven with real mouse input through DevTools in headless Edge. No real
 * microphone or network: window.fetch is stubbed and the VAD's mic is a fake level source + fake
 * recorder, injected through aiondx-voice-ui.js's own window.__aionDxVoiceUI.setHfTestOpts (the
 * same technique Voice Core Engineer's test-wake.js uses for aiondx-voice.js directly).
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9388;
const BASE = 'file:///' + path.join(__dirname, 'dev-harness-handsfree.html').split(path.sep).join('/');
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-voice-handsfree-profile');

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--window-size=900,700', BASE,
], { windowsHide: true, stdio: 'ignore' });

function finish(code, msg) {
  if (msg) console.log(msg);
  try { edge.kill(); } catch { /* already gone */ }
  process.exit(code);
}
const deadline = setTimeout(() => finish(2, 'DEADLINE: hands-free smoke test did not finish within 60 s'), 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('dev-harness-handsfree.html'));
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
    // Speaks for speakMs then goes silent: enough to clear minSpeechMs (30) while speaking and
    // silenceMs (50) once quiet, both set generously short in dev-harness-handsfree.html's
    // setHfTestOpts so this test runs in well under a second per segment.
    const speak = async (text, speakMs = 120) => {
      await js(`window.__sttQueue.push(${JSON.stringify(text)})`);
      await js('window.__hf.level = 1');
      await sleep(speakMs);
      await js('window.__hf.level = 0');
    };

    await sleep(500);

    // ---- settings: hands-free off by default, provider configured directly (its own UI is covered elsewhere) ----
    check('hands-free is off by default', await js('window.__aionDxVoiceUI.hfState().active === false'));
    await js(`window.__aionDxVoice.setSettings({ provider: 'elevenlabs', apiKey: 'test-key', voiceId: 'v1' })`);

    // ---- enabling it starts the wake-phrase stage ----
    await humanClick('#aiondx-voice-handsfree');
    check('checking the box starts the wake-phrase stage',
      await waitFor('window.__aionDxVoiceUI.hfState().active && window.__aionDxVoiceUI.hfState().state === "wake"'));
    check('the wake-phrase default is "Hey AionDX"', await js('document.querySelector("#aiondx-voice-wakephrase").value') === 'Hey AionDX');
    check('the badge names the wake phrase', (await js('document.querySelector(".aiondx-voice-hf-text").textContent')).includes('Hey AionDX'));
    // The dot is a bare <span>, inline by default, so width/height do nothing to it unless some
    // rule gives it a box - color and animation were being applied correctly but to a zero-size
    // element, which is indistinguishable from "not lit" no matter what data-state says.
    check('the state dot actually has a visible box, not just a colour nothing renders',
      (await js('document.querySelector(".aiondx-voice-hf-dot").getBoundingClientRect().width')) > 0);
    // The settings panel's own status line, not just the composer badge: the bug report this test
    // suite exists for was "no badge appears anywhere", and the badge lives only in a
    // conversation's composer - never visible from the Settings page itself. This line is.
    check('the settings panel itself says hands-free is running, not just the composer badge',
      (await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").textContent')).includes('running'));
    check('that status line is not hidden', await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").hidden') === false);

    // ---- saying the wake phrase moves to "listening for your message" ----
    await speak('Hey AionDX');
    check('the wake phrase moves to the listening stage',
      await waitFor('window.__aionDxVoiceUI.hfState().state === "listening"', 40));

    // ---- the captured utterance is sent the same way the mic button's transcript is ----
    await speak('What is the weather today');
    check('the utterance was auto-sent (the composer\'s send button fired)',
      await waitFor('(window.__sentMessages || []).includes("What is the weather today")', 40));
    check('the box was cleared after sending (the real send button\'s own behaviour)',
      await js('document.querySelector("[data-testid=\\"sendbox-input\\"]").value === ""'));
    check('hands-free moved to waiting for the reply',
      await waitFor('window.__aionDxVoiceUI.hfState().state === "waiting-reply"', 20));

    // ---- once the turn finishes, the newest reply auto-plays - no click ----
    await js(`window.__agentReply('It is sunny today.')`);
    await js(`window.__conv.status = 'finished'`);
    check('the reply auto-plays once the turn finishes',
      await waitFor('["loading", "playing"].includes((document.querySelector("#message-a1 .aiondx-voice-play-btn") || {}).dataset && document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state)', 40));

    // ---- after playback, it goes straight back to listening, NOT the wake phrase ----
    check('after the reply finishes playing, hands-free listens again directly (no wake phrase needed)',
      await waitFor('window.__aionDxVoiceUI.hfState().state === "listening"', 40));
    check('it did not go back through the wake stage to get there',
      await js('window.__aionDxVoiceUI.hfState().state !== "wake"'));

    // ---- a spoken stop phrase tears the whole thing down ----
    await speak('okay please stop listening now');
    check('a spoken stop phrase ends hands-free mode entirely',
      await waitFor('window.__aionDxVoiceUI.hfState().active === false', 40));
    check('the badge is hidden once it is torn down', await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-badge\\"]").hidden === true'));

    // ---- re-enabling, then the stop-all button tears it down too (the exit control, not just voice) ----
    await humanClick('#aiondx-voice-handsfree');   // unchecked by the teardown above's refresh; this checks it again
    check('re-enabling starts the wake stage again',
      await waitFor('window.__aionDxVoiceUI.hfState().active && window.__aionDxVoiceUI.hfState().state === "wake"', 40));
    await humanClick('.aiondx-voice-stopall-btn');
    check('the stop-all button also tears down hands-free mode, not just playback',
      await js('window.__aionDxVoiceUI.hfState().active === false'));

    // ---- unchecking the setting while active tears it down too ----
    await humanClick('#aiondx-voice-handsfree');
    await waitFor('window.__aionDxVoiceUI.hfState().active', 40);
    await humanClick('#aiondx-voice-handsfree');
    check('unchecking the setting tears hands-free down',
      await waitFor('window.__aionDxVoiceUI.hfState().active === false', 40));

    // ---- a real failure to start must say so, not silently revert (the reported bug) ----
    // Breaking createRecorder makes aiondx-voice.js's own opts validation reject immediately
    // (the same shape a real getUserMedia/permission failure rejects with), standing in for a
    // mic the OS or Electron refuses - without needing a real denied permission to reproduce.
    await js(`window.__aionDxVoiceUI.setHfTestOpts({ createRecorder: undefined })`);
    await humanClick('#aiondx-voice-handsfree');
    check('a startup failure switches hands-free off again', await waitFor('window.__aionDxVoiceUI.hfState().active === false', 40));
    check('and the checkbox reflects it (not left checked with nothing running)',
      await waitFor('document.querySelector("#aiondx-voice-handsfree").checked === false', 20));
    check('the settings panel explains why, instead of the toggle just silently reverting',
      await waitFor('document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").textContent.indexOf("stopped") >= 0', 20),
      await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").textContent'));
    check('that error note is marked as a problem (not the neutral styling)',
      await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").getAttribute("data-ok")') === '0');

  } catch (e) {
    check('smoke test ran without throwing', false, e.stack || String(e));
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})();
