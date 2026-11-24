#!/usr/bin/env node
// probe-settings-dom.js - in the staged app (hidden desktop, throwaway profile), prints the class names of a Settings page's elements down a
// few levels, so CSS can be aimed at AionUi's own markup. Read-only.
//   node tools\probe-settings-dom.js "#/settings/account" [depth]   (or the Settings list entry's number: 0 is Account)
'use strict';
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');
const hash = process.argv[2] || '#/settings/account';
const depth = +(process.argv[3] || 6);

(async () => {
  let app = null;
  try {
    app = await launch({ port: 9608, profile: path.join(os.tmpdir(), 'aiondx-probe-dom-profile'), deadlineMs: 180000 });
    for (let i = 0; i < 60; i++) { if ((await app.js('!!window.__aionDx')) === true) break; await sleep(1000); }
    await app.js(`location.hash = '#/settings/system'; 0`);
    await sleep(3000);
    if (/^\d+$/.test(hash)) await app.js(`(() => { const e = document.querySelectorAll('.settings-sider__item')[${hash}]; if (e) e.click(); return 0; })()`);
    else await app.js(`location.hash = ${JSON.stringify(hash)}; 0`);
    for (let i = 0; i < 30; i++) { if (await app.js(`!!document.querySelector('.settings-page-content')`)) break; await sleep(500); }
    await sleep(1500);
    const tree = await app.js(`(() => {
      const host = document.querySelector('.settings-page-content'); if (!host) return 'no page';
      const lines = [];
      const walk = (e, d) => { if (d > ${depth} || lines.length > 220) return; const cs = getComputedStyle(e);
        lines.push('  '.repeat(d) + e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 8).join('.') : '') + ' bg=' + cs.backgroundColor + (e.children.length ? '' : ' "' + (e.textContent || '').trim().slice(0, 40) + '"'));
        [...e.children].forEach((c) => walk(c, d + 1)); };
      walk(host, 0); return lines.join('\\n'); })()`);
    console.log(tree);
  } catch (e) {
    console.log('probe failed: ' + (e && e.stack || e));
  } finally {
    if (app) await app.close();
  }
})();
