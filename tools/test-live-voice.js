#!/usr/bin/env node
/**
 * test-live-voice.js - the voice patch (patches/0011-voice) in the real built app, on a hidden desktop: its two scripts are in the page, load, and
 * build the client, and nothing is called out to ElevenLabs without a key.
 *   node tools\test-live-voice.js
 */
'use strict';
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };

(async () => {
  let app = null;
  try {
    app = await launch({ port: 9601, profile: path.join(os.tmpdir(), 'aiondx-voice-profile'), deadlineMs: 200000 });
    for (let i = 0; i < 60; i++) { const st = await app.js('!!(window.__aionDx && window.__aionDxVoiceUI)'); if (st === true) break; await sleep(1000); }
    check('both voice scripts are tagged into the page', (await app.js(`document.querySelectorAll('script[src*="aiondx-voice"]').length`)) === 2);
    check('the voice module loads and offers the client', (await app.js(`typeof (window.AionDxVoice || {}).createVoiceClient`)) === 'function');
    check('the UI loads and built its client', (await app.js(`!!window.__aionDxVoiceUI && typeof window.__aionDxVoice === 'object'`)) === true);
    // With no key set, asking for speech is refused before any network call.
    const r = await app.js(`(async () => { const calls = []; const of = window.fetch; window.fetch = function (u) { calls.push(String(u)); return of.apply(this, arguments); };
      let err = null; try { await window.__aionDxVoice.synthesize('hello'); } catch (e) { err = String(e && e.message || e); }
      window.fetch = of; return { err, outside: calls.filter((u) => /elevenlabs/i.test(u)).length }; })()`);
    check('with no key set, speech is refused and nothing goes to ElevenLabs', r && r.err && r.outside === 0, JSON.stringify(r));
    // The speaker button on a reply, with no key: the voice Windows has (speechSynthesis) is used, and nothing goes to ElevenLabs.
    await app.js(`(() => { window.__spoken = []; window.__elevenCalls = 0;
      const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); u.volume = 0; return speak(u); };   // silent: a test never talks on the user's speakers
      const of = window.fetch; window.fetch = function (u) { if (/elevenlabs/i.test(String(u))) window.__elevenCalls++; return of.apply(this, arguments); };
      const row = document.createElement('div'); row.id = 'message-test1'; row.setAttribute('data-message-type', 'text'); row.setAttribute('data-message-position', 'left');
      row.innerHTML = '<div data-testid="message-text-content">Hello there. This is a test of the system voice.</div>'; row.style.cssText = 'position:fixed;left:20px;top:20px;z-index:99999';
      document.body.appendChild(row); return 0; })()`);
    for (let i = 0; i < 20 && (await app.js(`!!document.querySelector('#message-test1 [data-testid="aiondx-voice-play-btn"]')`)) !== true; i++) await sleep(500);
    check('a reply gets its speaker button', (await app.js(`!!document.querySelector('#message-test1 [data-testid="aiondx-voice-play-btn"]')`)) === true);
    await app.js(`document.querySelector('#message-test1 [data-testid="aiondx-voice-play-btn"]').click(); 0`);
    await sleep(1200);
    const spoken = await app.js('JSON.stringify(window.__spoken)');
    check('pressing it with no key reads the reply with the system voice, in sentences, and calls nobody', /Hello there\./.test(spoken || '') && /system voice/.test(spoken || '') && (await app.js('window.__elevenCalls')) === 0, spoken);
    await app.js(`window.speechSynthesis.cancel(); 0`);
  } catch (e) {
    check('the test ran', false, e && e.message);
  } finally {
    if (app) await app.close();
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
