#!/usr/bin/env node
/**
 * test-live-session.js - the real built app gets an AionCore session, and the page's writes are accepted: the main
 * process's Core session reaches "ready", the page has the CSRF cookie AionCore checks, a voice settings save goes
 * through the voice patch's own client, and a write shaped like patch 0001's draft autosave is accepted.
 * In 0.26.0-0.26.3 none of these held (the app looked for renamed cookie names a stock AionCore never sends: every read
 * answered 401, every write 403 "CSRF token validation failed"), with no error anywhere at start-up.
 *   node tools\test-live-session.js
 */
'use strict';
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };

const PUT = (body) => `(async () => { const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client', { method: 'PUT', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'x-csrf-token': window.__coreCsrfToken }, body: JSON.stringify(${JSON.stringify(body)}) });
  return { status: r.status, body: (await r.text()).slice(0, 200) }; })()`;

(async () => {
  let app = null;
  try {
    app = await launch({ port: 9602, profile: path.join(os.tmpdir(), 'aiondx-session-profile'), deadlineMs: 200000 });
    let state = null;
    for (let i = 0; i < 90; i++) {
      state = await app.js('window.__coreUserState && window.__coreUserState.status');
      const live = await app.js(`new Promise((res) => { const s = window.__coreUserLatest; res(s ? s.status : null); })`);
      if (live === 'ready' || state === 'ready') { state = 'ready'; break; }
      if (i === 0) await app.js(`window.__coreUserLatest = window.__coreUserState; window.addEventListener('core-user-state-changed', (e) => { window.__coreUserLatest = e.detail; }); 0`);
      await sleep(1000);
    }
    const latest = await app.js('JSON.stringify(window.__coreUserLatest || window.__coreUserState)');
    check('the main process gets an AionCore session (status "ready")', state === 'ready', latest);
    // From the cookie jar, not document.cookie: the desktop page is a file:// page, which never sees the backend's cookies.
    const port = await app.js('window.__backendPort');
    const jar = await app.send('Network.getCookies', { urls: ['http://127.0.0.1:' + port] });
    const cookies = ((jar && (jar.result || jar).cookies) || []).map((c) => ({ name: c.name, value: c.value }));
    const csrfCookie = cookies.find((c) => c.name === 'aionui-csrf-token');
    check('the browser holds the CSRF cookie AionCore checks, under its stock name, matching the page\'s token',
      !!csrfCookie && csrfCookie.value === (await app.js('window.__coreCsrfToken')), JSON.stringify(cookies.map((c) => c.name)));
    check('and the session cookie, under its stock name', cookies.some((c) => c.name === 'aionui-session'), JSON.stringify(cookies.map((c) => c.name)));
    const read = await app.js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client?keys=theme.activeId', { credentials: 'include' }).then((r) => r.status)`);
    check('a read is answered (not 401)', read === 200, read);

    // AionCore's own answer for the folders the app started it with (AIONUI_CACHE_DIR / _WORK_DIR / _LOG_DIR). In 0.26.0-0.26.4 the
    // app passed them renamed, and AionCore reported cache_dir "" and log_dir "" (work_dir held only because --work-dir also carries it).
    const sys = await app.js(`fetch('http://127.0.0.1:' + window.__backendPort + '/api/system/info', { credentials: 'include' }).then((r) => r.json()).then((j) => j.data || j)`);
    const same = (a, b) => typeof a === 'string' && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
    check('AionCore has the app\'s cache folder (<profile>\\config)', sys && same(sys.cache_dir, path.join(app.profile, 'config')), JSON.stringify(sys));
    check('AionCore has the app\'s log folder (<profile>\\logs)', sys && same(sys.log_dir, path.join(app.profile, 'logs')), JSON.stringify(sys));
    check('AionCore has the app\'s work folder (<profile>\\aionui)', sys && same(sys.work_dir, path.join(app.profile, 'aionui')), JSON.stringify(sys));

    // Voice: the same client and call the settings panel's Save uses.
    for (let i = 0; i < 30 && (await app.js('!!window.__aionDxVoice')) !== true; i++) await sleep(500);
    const saved = await app.js(`window.__aionDxVoice.setSettings({ provider: 'elevenlabs', apiKey: 'live-test-not-a-real-key', voiceId: 'live-test-voice' })
      .then(() => window.__aionDxVoice.getSettings()).then((s) => ({ ok: true, apiKey: s && s.apiKey, voiceId: s && s.voiceId }), (e) => ({ ok: false, err: String(e && e.message || e) }))`);
    check('a voice settings save goes through (the 403 the user saw)', saved && saved.ok, JSON.stringify(saved));
    check('and reads back what was saved', saved && saved.apiKey === 'live-test-not-a-real-key' && saved.voiceId === 'live-test-voice', JSON.stringify(saved));
    const cleared = await app.js(PUT({ 'aiondx.voice.config': null }));
    check('the test key is removed again', cleared && cleared.status === 200, JSON.stringify(cleared));

    // Patch 0001's draft autosave: the same PUT shape (it swallows errors, so this failed with nothing on screen).
    const draft = await app.js(PUT({ 'aionui.dx.draft.live-test': { text: 'live test', at: Date.now() } }));
    check('a write shaped like patch 0001\'s draft autosave is accepted', draft && draft.status === 200, JSON.stringify(draft));
    await app.js(PUT({ 'aionui.dx.draft.live-test': null }));

    // The voice panel the way a user fills it in: the provider list already shows ElevenLabs, so only a key is typed. Up to 0.26.6
    // that stored {apiKey} alone, and every call failed "voice: no provider configured" (the Windows voice read replies, the wake
    // phrase never transcribed). ElevenLabs is stubbed: the point is which key is sent, not a real account.
    await app.js(`location.hash = '#/settings/appearance'; 0`);
    for (let i = 0; i < 40 && !(await app.js(`!!document.querySelector('#aiondx-voice-apikey')`)); i++) await sleep(500);
    // Installed here, after the settings page is up: one installed before opening it was found gone afterwards (a request then
    // reached the real ElevenLabs with the test's made-up key, and was refused). The check below refuses to call without it.
    await app.js(`(() => { window.__eleven = []; const of = window.fetch; window.fetch = function (u, o) { const s = String(u);
      if (/^https:\\/\\/api\\.elevenlabs\\.io\\//.test(s)) { window.__eleven.push({ url: s, key: ((o && o.headers) || {})['xi-api-key'] || null });
        if (/speech-to-text/.test(s)) return Promise.resolve(new Response(JSON.stringify({ text: 'hello' }), { status: 200 }));
        if (/\\/voices/.test(s)) return Promise.resolve(new Response(JSON.stringify({ voices: [] }), { status: 200 }));
        return Promise.resolve(new Response(new Uint8Array(64), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })); }
      return of.apply(this, arguments); }; return 0; })()`);
    await app.js(`document.querySelector('#aiondx-voice-apikey').focus(); 0`);
    await app.type('live-panel-key');
    for (let i = 0; i < 20 && (await app.js('window.__aionDxVoice.getSettings().then((s) => s.apiKey)')) !== 'live-panel-key'; i++) await sleep(250);
    const panelSaved = await app.js('window.__aionDxVoice.getSettings()');
    check('a key typed into the voice panel is saved with the provider the panel shows', panelSaved && panelSaved.apiKey === 'live-panel-key' && panelSaved.provider === 'elevenlabs',
      JSON.stringify(panelSaved && { provider: panelSaved.provider, hasKey: !!panelSaved.apiKey }));
    // Only with the stub still in place: never a real request to ElevenLabs from a test.
    const stubbed = (await app.js('Array.isArray(window.__eleven)')) === true;
    check('(the ElevenLabs stub is in place)', stubbed);
    const synth = stubbed ? await app.js(`window.__aionDxVoice.synthesize('hello').then(() => 'ok', (e) => e.message)`) : 'skipped: no stub';
    const heard = stubbed ? await app.js(`window.__aionDxVoice.transcribe(new Blob(['x'], { type: 'audio/webm' })).then((t) => 'ok', (e) => e.message)`) : 'skipped: no stub';
    const sent = (await app.js('window.__eleven')) || [];
    check('and synthesize/transcribe send that key to ElevenLabs (no "no provider configured", no Windows voice)',
      synth === 'ok' && heard === 'ok' && ['https://api.elevenlabs.io/v1/text-to-speech/', 'https://api.elevenlabs.io/v1/speech-to-text'].every((p) => sent.some((c) => c.url.indexOf(p) === 0 && c.key === 'live-panel-key')),
      JSON.stringify({ synth, heard, sent }));
    await app.js(`location.hash = '#/guid'; 0`);

    // The speaker reads what a reply shows. A reply's text sits in a shadow root next to the <style> AionUi's ShadowView puts
    // there; 0.26.7 read that stylesheet aloud after the reply ("shadow DOM and other code"), along with a code block's Copy
    // label and raw code and any collapsed or hidden text.
    for (let i = 0; i < 40 && (await app.js('location.hash')) !== '#/guid'; i++) await sleep(500);
    await sleep(3000);
    await app.js(`(() => {
      const row = document.createElement('div'); row.id = 'message-livetest1'; row.setAttribute('data-message-type', 'text'); row.setAttribute('data-message-position', 'left');
      row.style.cssText = 'position:fixed;left:20px;top:60px;width:600px;z-index:99999';
      const content = document.createElement('div'); content.setAttribute('data-testid', 'message-text-content');
      const host = document.createElement('div'); host.className = 'markdown-shadow'; content.appendChild(host); row.appendChild(content);
      const root = host.attachShadow({ mode: 'open' });
      const body = document.createElement('div'); body.className = 'markdown-shadow-body';
      body.innerHTML = '<p>Here is the fix.</p><div><button>Copy</button><pre><code class="language-js">console.log(1)</code></pre></div>' +
        '<details><summary>Ran 2 tools</summary><div>collapsed tool output</div></details><span style="display:none">hidden text</span><p>That is all.</p>';
      const st = document.createElement('style'); st.textContent = '/* Shadow DOM CSS variable definitions */ :host { color: inherit } /* Code block horizontal scrollbar */';
      root.appendChild(body); root.appendChild(st); document.body.appendChild(row); return 0; })()`);
    for (let i = 0; i < 30 && !(await app.js(`!!document.querySelector('#message-livetest1 .aiondx-voice-play-btn')`)); i++) await sleep(500);
    await app.js(`(() => { window.__said = []; window.__aionDxVoice.synthesize = function (t) { window.__said.push(t); return Promise.reject(new Error('captured by the test')); }; return 0; })()`);
    await app.js(`document.querySelector('#message-livetest1 .aiondx-voice-play-btn').click(); 0`);
    for (let i = 0; i < 20 && !((await app.js('(window.__said || []).length')) > 0); i++) await sleep(250);
    const said = await app.js('(window.__said || [])[0]');
    check('the speaker sends what a reply shows, not its stylesheet, code, Copy label or hidden text',
      said === 'Here is the fix. a snippet of js code. Ran 2 tools That is all.', JSON.stringify(said));

    // A long reply is read in pieces (playChunked, 0.26.8): the first request is one short piece, so the first sound comes sooner.
    const longText = Array.from({ length: 14 }, (_, i) => `Sentence number ${i + 1} of a long reply, here to make it long.`).join(' ');
    await app.js(`(() => { const row = document.createElement('div'); row.id = 'message-livetest2'; row.setAttribute('data-message-type', 'text'); row.setAttribute('data-message-position', 'left');
      row.style.cssText = 'position:fixed;left:20px;top:260px;width:600px;z-index:99999';
      row.innerHTML = '<div data-testid="message-text-content"></div>'; row.firstChild.textContent = ${JSON.stringify(longText)};
      document.body.appendChild(row); window.__said = []; return 0; })()`);
    for (let i = 0; i < 30 && !(await app.js(`!!document.querySelector('#message-livetest2 .aiondx-voice-play-btn')`)); i++) await sleep(500);
    await app.js(`document.querySelector('#message-livetest2 .aiondx-voice-play-btn').click(); 0`);
    for (let i = 0; i < 20 && !((await app.js('(window.__said || []).length')) > 0); i++) await sleep(250);
    const firstPiece = await app.js('(window.__said || [])[0]');
    check('a long reply\'s first request is one short piece, not the whole reply', typeof firstPiece === 'string' && firstPiece.length <= 160 && longText.startsWith(firstPiece),
      JSON.stringify(firstPiece) + ` (reply ${longText.length} chars)`);
  } catch (e) {
    check('the test ran to the end', false, e && e.stack || e);
  } finally {
    if (app) await app.close();
  }

  // Start-up order: the voice page script loads before AionCore's session is ready (a settings read answers 401 until then), and
  // the start page has no voice panel. The saved settings must still reach the page's voice UI - hands-free and auto-play read them
  // on chat and team pages, where they used to stay empty until Settings > Appearance had been opened once.
  let app2 = null;
  try {
    app2 = await launch({ port: 9602, profile: path.join(os.tmpdir(), 'aiondx-session-profile'), keepProfile: true, deadlineMs: 200000 });
    for (let i = 0; i < 60 && (await app2.js('!!window.__aionDxVoiceUI')) !== true; i++) await sleep(500);
    let seen = null;
    for (let i = 0; i < 60; i++) { seen = await app2.js('window.__aionDxVoiceUI.settings && window.__aionDxVoiceUI.settings()'); if (seen && seen.apiKey) break; await sleep(500); }
    check('after a restart, the saved voice settings reach the page without opening Settings',
      !!seen && seen.apiKey === 'live-panel-key' && seen.provider === 'elevenlabs', JSON.stringify(seen && { provider: seen.provider, hasKey: !!seen.apiKey }) + ' on ' + (await app2.js('location.hash')));
    check('(that was on a page with no voice panel)', (await app2.js(`!!document.querySelector('[data-testid="aiondx-voice-panel"]')`)) === false);
    await app2.js(PUT({ 'aiondx.voice.config': null }));
  } catch (e) {
    check('the restart part ran to the end', false, e && e.stack || e);
  } finally {
    if (app2) await app2.close();
  }
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
