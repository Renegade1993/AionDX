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
  } catch (e) {
    check('the test ran to the end', false, e && e.stack || e);
  } finally {
    if (app) await app.close();
  }
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
