#!/usr/bin/env node
/**
 * test-live-menu.js - the right-click menu (patches/0009-identity/aiondx-menu.js) in the real built app, on a hidden desktop: a right-click on a link, a picture
 * and a misspelled word in a message box produces the menu it should. AIONDX_MENU_TEST_FILE makes the app write the menu's labels to a file instead of showing
 * a native menu, so nothing appears on screen.
 *   node tools\test-live-menu.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };

(async () => {
  let app = null;
  const logFile = path.join(os.tmpdir(), 'aiondx-menu-test-' + process.pid + '.jsonl');
  try { fs.rmSync(logFile, { force: true }); } catch (e) { /* none */ }
  const lines = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
  const rightClickAt = async (x, y) => {
    const before = lines().length;
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await sleep(60);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2, clickCount: 1 });
    for (let i = 0; i < 40; i++) { await sleep(100); if (lines().length > before) return lines()[lines().length - 1]; }
    return null;
  };
  const centerOf = (sel) => app.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + Math.min(r.height / 2, 14)), w: r.width, h: r.height }; })()`);
  try {
    app = await launch({ port: 9602, profile: path.join(os.tmpdir(), 'aiondx-menu-profile'), deadlineMs: 240000, env: { AIONDX_MENU_TEST_FILE: logFile } });
    for (let i = 0; i < 60; i++) { if ((await app.js('!!window.__aionDx')) === true) break; await sleep(1000); }
    check('the page script is loaded', (await app.js('!!window.__aionDx && typeof window.__aionDx.imagePathAt')) === true || (await app.js('typeof (window.__aionDx || {}).imagePathAt')) === 'function');

    // A link
    await app.js(`(() => { const a = document.createElement('a'); a.id = 'tl'; a.href = 'https://example.com/page'; a.textContent = 'example link'; a.style.cssText = 'position:fixed;left:40px;top:120px;z-index:99999;background:#fff;color:#00f;padding:6px'; document.body.appendChild(a); return 0; })()`);
    await sleep(200);
    const link = await centerOf('#tl');
    const m1 = link && await rightClickAt(link.x, link.y);
    check('right-clicking a web link offers Open link in browser and Copy link', m1 && JSON.stringify(m1.labels) === JSON.stringify(['Open link in browser', 'Copy link']), JSON.stringify(m1));

    // A picture whose file the page knows
    const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await app.js(`(() => { window.__aionDx.rememberImage(${JSON.stringify(DATA)}, 'C:\\\\Users\\\\me\\\\pics\\\\one.png'); const i = document.createElement('img'); i.id = 'pic'; i.src = ${JSON.stringify(DATA)}; i.style.cssText = 'position:fixed;left:40px;top:200px;width:80px;height:80px;z-index:99999;image-rendering:pixelated'; document.body.appendChild(i); return 0; })()`);
    await sleep(300);
    const pic = await centerOf('#pic');
    const m2 = pic && await rightClickAt(pic.x + 10, pic.y + 10);
    check('right-clicking a picture offers Copy image and Open image location, with the file the page knows', m2 && JSON.stringify(m2.labels) === JSON.stringify(['Copy image', 'Open image location']) && /one\.png$/.test(m2.image), JSON.stringify(m2));
    await app.js(`(() => { const i = document.createElement('img'); i.id = 'pic2'; i.src = ${JSON.stringify(DATA + 'AAAA')}; i.style.cssText = 'position:fixed;left:140px;top:200px;width:80px;height:80px;z-index:99999'; document.body.appendChild(i); return 0; })()`);
    await sleep(300);
    const pic2 = await centerOf('#pic2');
    const m3 = pic2 && await rightClickAt(pic2.x + 10, pic2.y + 10);
    check('a picture with no known file says so', m3 && /no file/.test(m3.labels[1] || ''), JSON.stringify(m3));

    // A misspelled word in a text box
    await app.js(`(() => { const t = document.createElement('textarea'); t.id = 'tb'; t.setAttribute('spellcheck', 'true'); t.style.cssText = 'position:fixed;left:40px;top:320px;width:420px;height:60px;z-index:99999;font-size:18px'; document.body.appendChild(t); t.focus(); return 0; })()`);
    await app.send('Input.insertText', { text: 'helo wrold this is a tset' });
    await sleep(2500);
    const tb = await centerOf('#tb');
    const m4 = tb && await rightClickAt(tb.x + 14, tb.y);
    check('the spell checker flags a misspelled word in a text box', m4 && /^helo$/i.test(m4.misspelled), JSON.stringify(m4));
    check('and offers suggestions, Add to dictionary, then Cut, Copy, Paste, Select all', m4 && m4.suggestions.length > 0 && m4.labels.includes('Add to dictionary') && m4.labels.includes('Paste') && m4.labels.includes('Select all'), JSON.stringify(m4));
  } catch (e) {
    check('the test ran', false, e && e.stack || e);
  } finally {
    if (app) await app.close();
    try { fs.rmSync(logFile, { force: true }); } catch (e) { /* none */ }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
