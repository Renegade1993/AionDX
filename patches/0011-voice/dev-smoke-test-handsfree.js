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
      await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.scrollIntoView({ block: "center" }); return 0; })()`);   // a long reply can push the target below the fold
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

    // ---- a failed transcribe() during the wake stage is surfaced, not swallowed (the actual bug) ----
    // This is Core Engineer's fix (1bb6fe4, onTranscribeError) wired through: before it, a clip
    // that failed to transcribe was dropped with no signal at all, indistinguishable from the mic
    // never having heard anything - exactly the "wake phrase does nothing" report. No sttQueue
    // push here: the stub's failure path never reads the queue, so this must not consume a slot a
    // later real speak() call expects.
    await js('window.__sttFailNext = 1');
    await js('window.__hf.level = 1');
    await sleep(120);
    await js('window.__hf.level = 0');
    check('a failed transcribe shows the real reason, not the generic stall hint',
      await waitFor('/transcription failed/i.test(document.querySelector(".aiondx-voice-hf-text").textContent || "")', 40),
      await js('document.querySelector(".aiondx-voice-hf-text").textContent'));
    // The badge is a narrow ellipsized chip (0.26.6 on a team page read `Listening for "Hey AionDX" — trans…`): the reason comes
    // first, and the whole text is on hover and in the settings panel.
    check('the badge leads with the reason, so even its cut-off part says what is wrong',
      /^Transcription failed: .*429/.test(await js('document.querySelector(".aiondx-voice-hf-text").textContent')), await js('document.querySelector(".aiondx-voice-hf-text").textContent'));
    check('the badge carries the full text as its tooltip',
      await js('(() => { const b = document.querySelector(".sendbox-actions .aiondx-voice-hf"); return b.title === b.querySelector(".aiondx-voice-hf-text").textContent && /429 quota exceeded/.test(b.title) && /Hey AionDX/.test(b.title); })()'),
      await js('document.querySelector(".sendbox-actions .aiondx-voice-hf").title'));
    check('the settings panel mirrors the same transcribe-error text',
      await js('/transcription failed/i.test(document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").textContent || "")'));
    check('hands-free keeps listening after one failed clip, it does not tear down',
      await js('window.__aionDxVoiceUI.hfState().active && window.__aionDxVoiceUI.hfState().state === "wake"'));

    // ---- what the wake listener heard, when it was not the phrase ----
    await speak('yes  sir,   its   so   sunny');   // letters s and runs of spaces: the heard line collapses only the spaces
    check('a clip that is not the wake phrase is shown as heard, in the badge\'s tooltip',
      await waitFor('/Heard: “yes sir, its so sunny”/.test(document.querySelector(".sendbox-actions .aiondx-voice-hf").title)', 40),
      await js('document.querySelector(".sendbox-actions .aiondx-voice-hf").title'));
    check('and in the settings panel\'s status line',
      await js('/Heard: “yes sir, its so sunny”/.test(document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").textContent)'),
      await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-status\\"]").textContent'));
    check('the badge itself keeps its short text (the heard line is not crammed into it)',
      !/Heard:/.test(await js('document.querySelector(".aiondx-voice-hf-text").textContent')));
    check('a clip that transcribed clears the earlier failure from the badge',
      /^Listening for “Hey AionDX”/.test(await js('document.querySelector(".aiondx-voice-hf-text").textContent')),
      await js('document.querySelector(".aiondx-voice-hf-text").textContent'));
    check('still at the wake stage: that was not the phrase', await js('window.__aionDxVoiceUI.hfState().state === "wake"'));

    // ---- React replacing the composer's own DOM (same route, fresh nodes) must not leave the
    // UI stuck on stale references - the other half of the actual bug, alongside the swallowed
    // transcribe error: a long wake/listen cycle easily outlives one render pass, and a captured
    // reference from several stages back would silently stop reaching anything live. ----
    const freshTa = await js(`(() => { window.__replaceComposer(); return !!document.querySelector('[data-testid="sendbox-input"]'); })()`);
    check('a fresh composer is in the DOM after the simulated re-render', freshTa);
    check('hands-free re-attaches to it: the badge in the new composer is visible and still "wake"',
      await waitFor('(() => { const b = document.querySelector(".sendbox-actions .aiondx-voice-hf"); return !!b && !b.hidden && b.getAttribute("data-state") === "wake"; })()', 30));

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
    // Long enough to be read in several pieces (playChunked): hands-free must listen again only after the LAST one.
    const longReply = Array.from({ length: 14 }, (_, i) => `It is sunny today, part ${i + 1}, and the forecast says it will stay that way.`).join(' ');
    await js('window.__ttsTexts = []');
    await js(`window.__agentReply(${JSON.stringify(longReply)})`);
    await js(`window.__conv.status = 'finished'`);
    check('the reply auto-plays once the turn finishes',
      await waitFor('["loading", "playing"].includes((document.querySelector("#message-a1 .aiondx-voice-play-btn") || {}).dataset && document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state)', 40));

    // ---- after playback, it goes straight back to listening, NOT the wake phrase ----
    // Watch the stage while the pieces play: still "speaking" after the first piece has played, "listening" only once all have.
    let stillSpeakingAfterFirst = false, piecesWhenListening = -1;
    for (let i = 0; i < 150; i++) {
      const st = await js('window.__aionDxVoiceUI.hfState().state');
      const n = await js('(window.__ttsTexts || []).length');
      if (st === 'speaking' && n >= 2) stillSpeakingAfterFirst = true;
      if (st === 'listening') { piecesWhenListening = n; break; }
      await sleep(100);
    }
    const spokenPieces = await js('window.__ttsTexts || []');
    check('the long reply was read in several pieces that make up the whole reply', spokenPieces.length >= 3 && spokenPieces.join(' ') === longReply, spokenPieces.length + ' pieces');
    check('hands-free was still "speaking" after the first piece had played', stillSpeakingAfterFirst);
    check('after the reply finishes playing, hands-free listens again directly (no wake phrase needed)', piecesWhenListening !== -1);
    check('and only after the last piece: every piece had been read by then', piecesWhenListening === spokenPieces.length && spokenPieces.length >= 3 &&
      (await js('document.querySelector("#message-a1 .aiondx-voice-play-btn").dataset.state')) === 'idle', `${piecesWhenListening} of ${spokenPieces.length}`);
    check('it did not go back through the wake stage to get there',
      await js('window.__aionDxVoiceUI.hfState().state !== "wake"'));

    // ---- the wake phrase said again at the start of a message is not sent with it ----
    await js(`window.__conv.status = 'running'`);   // hold the reply, so the next steps do not replay the long one above
    await speak('Hey AionDX, what is the time');
    check('a message that starts with the wake phrase is sent without it',
      await waitFor('(window.__sentMessages || []).includes("what is the time")', 40), JSON.stringify(await js('window.__sentMessages')));
    check('and the phrase itself never reaches the chat', !(await js('window.__sentMessages')).some((m) => /aion/i.test(m)));
    await waitFor('window.__aionDxVoiceUI.hfState().state === "waiting-reply"', 20);
    await js(`window.__agentReply('It is noon.')`);
    await js(`window.__conv.status = 'finished'`);
    await waitFor('window.__aionDxVoiceUI.hfState().state === "listening"', 60);
    const sentBeforeBare = await js('window.__sentMessages.length');
    await speak('Hey AionDX');
    await sleep(1500);
    check('a message that is only the wake phrase is not sent', (await js('window.__sentMessages.length')) === sentBeforeBare, JSON.stringify(await js('window.__sentMessages.slice(-2)')));
    check('it keeps listening for the message instead', await js('window.__aionDxVoiceUI.hfState().state === "listening"'));

    // ---- a spoken stop phrase tears the whole thing down ----
    await speak('okay please stop listening now');
    check('a spoken stop phrase ends hands-free mode entirely',
      await waitFor('window.__aionDxVoiceUI.hfState().active === false', 40));
    check('the badge is hidden once it is torn down', await js('document.querySelector("[data-testid=\\"aiondx-voice-hf-badge\\"]").hidden === true'));

    // ---- re-enabling, then the stop-all button tears it down too (the exit control, not just voice) ----
    await humanClick('#aiondx-voice-handsfree');   // unchecked by the teardown above's refresh; this checks it again
    check('re-enabling starts the wake stage again',
      await waitFor('window.__aionDxVoiceUI.hfState().active && window.__aionDxVoiceUI.hfState().state === "wake"', 40));
    // "Hey AionDX, read me the news" in one breath: the request comes in the wake clip itself and is sent from it.
    await js(`window.__conv.status = 'running'`);
    await speak('Hey AionDX, read me the news');
    check('a request said with the wake phrase in one breath is sent, without the phrase',
      await waitFor('(window.__sentMessages || []).includes("read me the news")', 40), JSON.stringify(await js('window.__sentMessages.slice(-2)')));
    check('and hands-free waits for its reply (no second utterance needed)', await waitFor('window.__aionDxVoiceUI.hfState().state === "waiting-reply"', 20));
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

    // ---- auto-play falls back to the system voice when no key is set, and stop-all can still
    // stop it - the owner's merge brought in systemSpeak() as an alternative to a real Audio
    // element, and hands-free's own auto-play (waitForReplyThenPlay) calls the same startPlayback()
    // the manual speaker button does, so this should already work by construction; proving it
    // live rather than trusting that reading, the same way the stale-DOM-reference bug turned out
    // to need an actual re-render in a real harness rather than just reasoning about the code.
    // The key is cleared only AFTER the utterance is sent, not before enabling hands-free: speech
    // to text has no free fall-back in this module (PATCH.md says so plainly), so wake-phrase
    // detection and utterance capture need a working provider too - clearing it any earlier just
    // breaks the mic, never reaching a reply to auto-play at all. The realistic shape of this case
    // is a key revoked mid-conversation (expired, removed in Settings) between a turn being sent
    // and its reply coming back, not "no key, ever" - that case can never reach auto-play in the
    // first place, hands-free or not. ----
    await js(`window.__aionDxVoiceUI.setHfTestOpts({
      levelSource: window.__hfLevelSource, createRecorder: window.__hfCreateRecorder,
      pollMs: 10, minSpeechMs: 30, silenceMs: 50, threshold: 0.5, maxSegmentMs: 4000
    })`);   // restored: the previous test broke createRecorder on purpose to force a startup failure
    await js(`window.__conv.status = 'running'`);   // left 'finished' by the cycle above; a stale 'finished' here would let
                                                       // waitForReplyThenPlay's poll grab message-a1's old reply instead of waiting for a new one

    await humanClick('#aiondx-voice-handsfree');
    check('hands-free starts again (provider still configured - the mic needs it)',
      await waitFor('window.__aionDxVoiceUI.hfState().active && window.__aionDxVoiceUI.hfState().state === "wake"', 40));
    await speak('Hey AionDX');
    await waitFor('window.__aionDxVoiceUI.hfState().state === "listening"', 40);
    await speak('Tell me a joke');
    await waitFor('(window.__sentMessages || []).includes("Tell me a joke")', 40);
    check('the utterance was sent while the key still worked',
      await js('(window.__sentMessages || []).includes("Tell me a joke")'));

    await js(`window.__aionDxVoice.setSettings({ provider: null, apiKey: null })`);   // the key goes away while the reply is in flight
    await js('window.__aionDxVoiceUI.reloadSettings()');   // removed outside this page's panel: the page re-reads it (the fall-back needs to know there is no key)
    await waitFor('!window.__aionDxVoiceUI.settings().apiKey', 30);
    await js(`window.__agentReply('No key needed for this one.')`);
    await js(`window.__conv.status = 'finished'`);
    check('the reply auto-plays through the system voice, not a dead-end error',
      await waitFor('(window.__systemSpeechCalls || []).includes("No key needed for this one.")', 40),
      JSON.stringify(await js('window.__systemSpeechCalls')));
    check('the play button shows "playing" for the system-voice utterance too',
      await waitFor('(document.querySelector("#messages > :last-child .aiondx-voice-play-btn") || {}).dataset && document.querySelector("#messages > :last-child .aiondx-voice-play-btn").dataset.state === "playing"', 20));

    const cancelledBefore = await js('window.__systemSpeechCancelled');
    await humanClick('.aiondx-voice-stopall-btn');
    check('the stop-all button cancels the system voice (speechSynthesis.cancel, not audio.pause on nothing)',
      (await js('window.__systemSpeechCancelled')) > cancelledBefore);
    check('the play button settles back to idle after stop-all cancels the system voice',
      await js('document.querySelector("#messages > :last-child .aiondx-voice-play-btn").dataset.state') === 'idle');
    const stopAllTore = await js('window.__aionDxVoiceUI.hfState().active === false');

    // ---- with a key saved, an ElevenLabs failure shows its error: the Windows voice is only for "no key at all" ----
    await js(`window.__aionDxVoice.setSettings({ provider: 'elevenlabs', apiKey: 'saved-key', voiceId: 'v1' })`);
    await js('window.__aionDxVoiceUI.reloadSettings()');
    await waitFor('window.__aionDxVoiceUI.settings().apiKey === "saved-key"', 30);
    await js(`window.__agentReply('A reply read with the saved key.'); window.__ttsFailNext = 1; window.__ttsKeys = []`);
    const rowSel = await js(`'#' + document.getElementById('messages').lastElementChild.id`);
    await waitFor(`!!document.querySelector('${rowSel} .aiondx-voice-play-btn')`, 30);
    const spokenBefore = (await js('window.__systemSpeechCalls.length'));
    await humanClick(`${rowSel} .aiondx-voice-play-btn`);
    check('with a key saved, the saved key is what goes to ElevenLabs', await waitFor('(window.__ttsKeys || []).includes("saved-key")', 30), JSON.stringify(await js('window.__ttsKeys')));
    check('and its failure shows as an error on the button',
      await waitFor(`document.querySelector('${rowSel} .aiondx-voice-play-btn').dataset.state === 'error'`, 30),
      await js(`document.querySelector('${rowSel} .aiondx-voice-play-btn').getAttribute('aria-label')`));
    check('not covered up by the Windows voice', (await js('window.__systemSpeechCalls.length')) === spokenBefore, JSON.stringify(await js('window.__systemSpeechCalls')));

    check('stop-all tore hands-free down too, same as it does for a real Audio element', stopAllTore);

  } catch (e) {
    check('smoke test ran without throwing', false, e.stack || String(e));
  }

  clearTimeout(deadline);
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})();
