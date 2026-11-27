'use strict';
// test-live-theme.js - the AionDX theme kept through AionUi's own light/dark button, and the accent under every theme, in the real app
// (the staged one, with the edited aiondx-ui.js served in place of the built one). November 26th, 2026: the button had put AionUi's own
// Dark in place of AionDX Dark on the user's machine, and the red accent showed nowhere.
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./live-app');

const WANT_BUILD = (fs.readFileSync(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8').match(/var BUILD = '([^']+)'/) || [])[1];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + detail + ']')); };

(async () => {
  const app = await launch({ port: 9563, deadlineMs: 280000 });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    if (!process.env.THEME_AS_BUILT) await app.overrideScript('aiondx-ui.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'));
    for (let i = 0; i < 90; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, build: window.__aionDx && window.__aionDx.build, port: window.__backendPort || null })'); if (st && st.dx && st.port && (process.env.THEME_AS_BUILT || st.build === WANT_BUILD)) break; }
    console.log('build', await app.js('window.__aionDx && window.__aionDx.build'));
    await app.js(`(() => { const s = document.createElement('style'); s.id = 'probe-quiet'; s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    const prefs = (keys) => app.js(`(async () => { const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client?keys=' + encodeURIComponent(${JSON.stringify(keys)}), { credentials: 'include' }); const j = await r.json(); return j.data || j; })()`);
    const putPref = (obj) => app.js(`(async () => { const csrf = window.__coreCsrfToken || (document.cookie.match(/aiondx-csrf-token=([^;]+)/) || document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const r = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/settings/client', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(${JSON.stringify(obj)}) }); return r.status; })()`);
    // first-run setup installs the AionDX themes and makes AionDX Dark the active one (then reloads once)
    let p = null;
    for (let i = 0; i < 40; i++) { p = await prefs('theme.activeId,theme.userThemes'); if (p && p['theme.activeId'] === 'aiondx-dark') break; await sleep(1000); }
    check('first-run setup made AionDX Dark the theme', p && p['theme.activeId'] === 'aiondx-dark', JSON.stringify(p && p['theme.activeId']));
    for (let i = 0; i < 30; i++) { if (process.env.THEME_AS_BUILT || await app.js('window.__aionDx && window.__aionDx.build') === WANT_BUILD) break; await sleep(1000); }
    const tokens = () => app.js(`(() => { const t = document.getElementById('theme-tokens'); return { mode: document.documentElement.getAttribute('data-theme'), arco: document.body.getAttribute('arco-theme'), ours: !!(t && /aiondx/.test(t.textContent)) }; })()`);
    await app.js(`location.hash = '#/settings/appearance'; 0`);
    let btn = null;
    for (let i = 0; i < 20; i++) { await sleep(500); btn = await app.js(`(() => { const b = document.querySelector('[data-testid="theme-toggle"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); if (btn) break; }
    check('AionUi\'s light/dark button is on the Settings page', !!btn);
    const press = async () => {
      const b = await app.js(`(() => { const b = document.querySelector('[data-testid="theme-toggle"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
    };
    await press();
    let ok = false, last = null;
    for (let i = 0; i < 20; i++) { await sleep(500); p = await prefs('theme.activeId'); last = await tokens(); if (p['theme.activeId'] === 'aiondx-light' && last.mode === 'light' && last.ours) { ok = true; break; } }
    check('the button from AionDX Dark: AionDX Light, saved and on screen (not AionUi\'s own Light)', ok, JSON.stringify([p, last]));
    await sleep(1500);
    await press();
    ok = false;
    for (let i = 0; i < 20; i++) { await sleep(500); p = await prefs('theme.activeId'); last = await tokens(); if (p['theme.activeId'] === 'aiondx-dark' && last.mode === 'dark' && last.ours) { ok = true; break; } }
    check('and back: AionDX Dark', ok, JSON.stringify([p, last]));
    // the accent under AionUi's own Dark (picked from the gallery, so it stays)
    await putPref({ 'aiondx.theme': { dividers: true, accent: '#e63333', at: Date.now() + 5000 } });
    const card = await app.js(`(() => { const c = document.querySelector('[data-testid="theme-card-dark"]'); if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check('the gallery has AionUi\'s own Dark', !!card);
    if (card) for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: card.x, y: card.y, button: 'left', clickCount: 1 });
    let p6 = '';
    for (let i = 0; i < 20; i++) { await sleep(500); p = await prefs('theme.activeId'); p6 = await app.js(`getComputedStyle(document.body).getPropertyValue('--primary-6').trim()`); if (p['theme.activeId'] === 'dark' && p6.replace(/\s/g, '') === '230,51,51') break; }
    check('AionUi\'s own Dark picked from the gallery stays chosen', p['theme.activeId'] === 'dark', JSON.stringify(p));
    check('and the red accent is its main colour', p6.replace(/\s/g, '') === '230,51,51', p6);
    await sleep(3500);
    check('still the chosen one a few seconds later', (await prefs('theme.activeId'))['theme.activeId'] === 'dark');
  } catch (e) { console.log('ERROR', e && e.stack || e); fail++; }
  finally { await app.close(); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
