#!/usr/bin/env node
// probe-settings-lines.js - in the staged app (hidden desktop, throwaway profile), lists every thin horizontal line drawn in the Settings
// list: elements 1 to 4 px tall, or with a visible top or bottom border, with their classes and colours. Read-only. For 0.28.6 item 10
// (a heavy dark rule under the "Agents and chats" block).
//   node tools\probe-settings-lines.js
'use strict';
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

(async () => {
  let app = null;
  try {
    app = await launch({ port: 9607, profile: path.join(os.tmpdir(), 'aiondx-probe-lines-profile'), deadlineMs: 180000 });
    for (let i = 0; i < 60; i++) { if ((await app.js('!!window.__aionDx')) === true) break; await sleep(1000); }
    await app.js(`location.hash = '#/settings/system'; 0`);
    await sleep(4000);
    const found = await app.js(`(() => {
      const sider = document.querySelector('.settings-sider'); if (!sider) return 'no sider';
      const out = [];
      sider.querySelectorAll('*').forEach((e) => {
        ['::before', '::after'].forEach((pe) => { const ps = getComputedStyle(e, pe); if (ps.content && ps.content !== 'none' && ps.content !== 'normal') out.push({ pseudo: pe, cls: String(e.className).slice(0, 120), content: ps.content.slice(0, 40), h: ps.height, w: ps.width, bg: ps.backgroundColor, bb: ps.borderBottomWidth + ' ' + ps.borderBottomColor, pos: ps.position, bottom: ps.bottom }); });
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        const bt = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none', bb = parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none';
        const thin = r.height > 0 && r.height <= 4 && r.width > 60;
        const shadow = cs.boxShadow && cs.boxShadow !== 'none';
        if (thin || bt || bb || (shadow && r.width > 150)) out.push({ tag: e.tagName, cls: String(e.className).slice(0, 160), testid: e.getAttribute('data-testid'), y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
          bt: bt ? cs.borderTopWidth + ' ' + cs.borderTopColor : '', bb: bb ? cs.borderBottomWidth + ' ' + cs.borderBottomColor : '', shadow: shadow ? cs.boxShadow.slice(0, 120) : '', bg: thin ? cs.backgroundColor : '' });
      });
      const at = [];
      const typ = [...sider.querySelectorAll('.settings-sider__item, .aiondx-setnav-item')].find((x) => /Typing/.test(x.textContent));
      const tr = typ ? typ.getBoundingClientRect() : { bottom: 240, left: 10, width: 240 };
      for (let y = Math.round(tr.bottom) - 2; y <= Math.round(tr.bottom) + 10; y++) {
        const els = document.elementsFromPoint(Math.round(tr.left + tr.width / 2), y).slice(0, 4).map((x) => { const c = getComputedStyle(x); return x.tagName + '.' + String(x.className).slice(0, 70) + ' bg=' + c.backgroundColor + ' bb=' + c.borderBottomWidth + '/' + c.borderBottomColor + ' sh=' + c.boxShadow.slice(0, 60); });
        at.push(y + ': ' + els.join(' | '));
      }
      return { typingRect: { top: Math.round(tr.top), bottom: Math.round(tr.bottom) }, at, out }; })()`);
    console.log(JSON.stringify(found, null, 1));
  } catch (e) {
    console.log('probe failed: ' + (e && e.stack || e));
  } finally {
    if (app) await app.close();
  }
})();
