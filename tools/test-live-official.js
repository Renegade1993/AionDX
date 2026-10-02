#!/usr/bin/env node
/**
 * test-live-official.js - patch 0010 in the real app: the built, staged AionDX in a throwaway profile (tools\live-app.js).
 *
 *   node tools\test-live-official.js [--stage DIR]
 *
 * Checks, on the running app: no screen the app has says AionUi (every route's visible text and every attribute that shows
 * as text), no Chinese on an English screen, the About page (name, version, three links), no request to Google Analytics, a
 * picture attached to a message box surviving the window being reloaded, and the dialog for removing a team member having
 * its own English buttons. Nothing of the installed AionDX or its data is touched.
 */
'use strict';
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const VERSION_RE = /^\d+\.\d+\.\d+/;

(async () => {
  const app = await launch({ port: 9558, deadlineMs: 420000, stage: arg('--stage') || undefined, env: { AIONDX_NO_UPDATE_CHECK: '1' } });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    check('the app is AionDX (page title)', (await app.js('document.title')) === 'AionDX', await app.js('document.title'));

    // Every route's visible text, and the text of the attributes that show as text.
    const visible = () => app.js(`(() => {
      const out = [document.body.innerText];
      document.querySelectorAll('[title],[aria-label],[placeholder],[alt]').forEach((e) => { ['title', 'aria-label', 'placeholder', 'alt'].forEach((a) => { const v = e.getAttribute(a); if (v) out.push(v); }); });
      return out.join('\\n');
    })()`);
    const routes = ['#/guid', '#/settings/about', '#/settings/system', '#/settings/model', '#/settings/agent', '#/assistants', '#/settings/skills', '#/settings/tools',
      '#/settings/appearance', '#/settings/webui', '#/settings/pet', '#/settings/archived', '#/scheduled'];
    const named = [], cjk = [], keysSeen = [];
    for (const r of routes) {
      await app.js(`location.hash = '${r}'; 0`);
      await sleep(1600);
      const text = await visible();
      const t = String(text);
      const hit = t.split('\n').filter((l) => /AionU[iI]/.test(l)).map((l) => l.trim().slice(0, 100));
      if (hit.length) named.push(r + ' :: ' + hit.slice(0, 3).join(' | '));
      const keys = t.split('\n').filter((l) => /aionui/.test(l)).map((l) => l.trim().slice(0, 70));
      if (keys.length) keysSeen.push(r + ' :: ' + keys.slice(0, 2).join(' | '));
      const zh = t.split('\n').filter((l) => /[㐀-鿿぀-ヿ가-힯]/.test(l)).map((l) => l.trim().slice(0, 80));
      if (zh.length) cjk.push(r + ' :: ' + zh.slice(0, 3).join(' | '));
    }
    check('no route the app has shows the name AionUi (' + routes.length + ' routes, text and attributes)', named.length === 0, named.join(' ;; '));
    console.log('       (lower-case aionui left, as the data folder and a built-in tool key: ' + keysSeen.length + ' screen(s) ' + JSON.stringify(keysSeen).slice(0, 200) + ')');
    check('and none shows Chinese, Japanese or Korean text on an English screen', cjk.length === 0, cjk.join(' ;; '));

    // The About page.
    await app.js(`location.hash = '#/settings/about'; 0`);
    await sleep(2000);
    const about = await app.js(`(() => {
      const t = [...document.querySelectorAll('h1,h2,h3,.arco-typography')].map((e) => e.textContent.trim()).filter(Boolean);
      const v = [...document.querySelectorAll('span')].map((e) => e.textContent.trim()).find((x) => /^v\\d+\\.\\d+\\.\\d+/.test(x)) || '';
      const rows = [...document.querySelectorAll('.cursor-pointer.group')].map((e) => e.textContent.trim()).filter((x) => /documentation|update log|issue|bug|contact|website/i.test(x));
      return { title: t[0] || '', version: v, rows, text: document.body.innerText };
    })()`);
    check('About: the title is AionDX', about && about.title === 'AionDX', about && about.title);
    check('About: the version is the AionDX version', about && VERSION_RE.test(String(about.version).replace(/^v/, '')) && about.version !== 'v2.2.2', about && about.version);
    check('About: three links (help, update log, report issue), no contact or website of AionUi', about && about.rows.length === 3 && !about.rows.some((x) => /contact|website/i.test(x)), about && JSON.stringify(about.rows));
    check('About: it has the Check for updates button', about && /check for updates/i.test(about.text), about && about.text.slice(0, 200));

    // No analytics request left the page.
    const ga = await app.js(`performance.getEntriesByType('resource').filter((e) => /google-analytics|googletagmanager|sentry/i.test(e.name)).map((e) => e.name.slice(0, 80))`);
    check('no request went to Google Analytics or Sentry from the page', Array.isArray(ga) && ga.length === 0, JSON.stringify(ga));

    // A conversation, a picture pasted into its message box, the window reloaded.
    const mk = (name) => app.js(`(async () => {
      const base = 'http://127.0.0.1:' + window.__backendPort;
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const h = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
      const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
      const a = list.find((x) => x.name === 'Claude Code') || list[0];
      const r = await fetch(base + '/api/conversations', { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify({ name: '${name}', assistant: { id: a.id, locale: 'en-US' }, extra: { workspace: '', custom_workspace: false } }) });
      const c = await r.json(); return (c.data || c).id;
    })()`);
    const conv = await mk('picture draft');
    const BOX = `(() => { const t = document.querySelector('[data-testid="sendbox-input"]'); return t && (t.tagName === 'TEXTAREA' ? t : t.querySelector('textarea')); })()`;
    const strip = () => app.js(`(() => { const t = ${BOX}; const p = t && t.closest('.sendbox-panel'); return p ? [...p.querySelectorAll('img')].length : -1; })()`);
    await app.js(`location.hash = '#/conversation/${conv}'; 0`);
    await sleep(3000);
    await app.js(`(() => {
      const bin = atob('${PNG}'); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u8], 'image.png', { type: 'image/png' }));
      const t = ${BOX}; t.focus(); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
    await sleep(3000);
    check('a pasted picture shows in the message box', (await strip()) === 1, await strip());
    await app.js(`location.hash = '#/guid'; 0`);
    await sleep(1500);
    await app.js(`location.hash = '#/conversation/${conv}'; 0`);
    await sleep(2500);
    check('and is still there after leaving the chat and coming back', (await strip()) === 1, await strip());
    await app.send('Page.reload', { ignoreCache: false });
    for (let i = 0; i < 60; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; }
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    await app.js(`location.hash = '#/conversation/${conv}'; 0`);
    await sleep(3500);
    check('and after the window was reloaded, as an app restart would', (await strip()) === 1, await strip());

    // The dialog for removing a team member.
    const team = await app.js(`(async () => {
      const base = 'http://127.0.0.1:' + window.__backendPort;
      const csrf = window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '';
      const h = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
      const list = (await (await fetch(base + '/api/assistants', { credentials: 'include' })).json()).data || [];
      const a = list.find((x) => x.name === 'Claude Code') || list[0];
      const body = { name: 'dialog team', agents: [{ name: 'Lead', role: 'lead', model: 'default', assistant_id: a.id }, { name: 'Worker', role: 'teammate', model: 'default', assistant_id: a.id }] };
      const r = await fetch(base + '/api/teams', { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify(body) });
      const j = await r.json();
      return { status: r.status, id: (j.data || j).id || null, keys: Object.keys(j.data || j).slice(0, 8) };
    })()`);
    if (team && team.id) {
      await app.js(`location.hash = '#/team/${team.id}'; 0`);
      await sleep(5000);
      const slot = await app.js(`(() => { const t = [...document.querySelectorAll('[data-testid^="team-tab-"]')].find((e) => /^team-tab-[0-9a-f-]{8,}$/.test(e.getAttribute('data-testid')) && e.getAttribute('data-team-tab-role') !== 'leader'); return t ? t.getAttribute('data-testid').slice('team-tab-'.length) : null; })()`);
      check('the team page shows a member tab', !!slot, slot);
      if (slot) {
        await app.js(`(() => { const tab = document.querySelector('[data-testid="team-tab-${slot}"]'); tab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); tab.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); tab.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })); return 1; })()`);
        await sleep(500);
        const clicked = await app.js(`(() => { const x = document.querySelector('[data-testid="team-tab-remove-${slot}"]'); if (!x) return false; x.click(); return true; })()`);
        await sleep(900);
        const dlg = await app.js(`(() => { const m = document.querySelector('.arco-modal'); if (!m) return null; return { title: (m.querySelector('.arco-modal-title') || {}).textContent || '', body: (m.querySelector('.arco-modal-content') || {}).textContent || '', buttons: [...m.querySelectorAll('.arco-modal-footer button')].map((b) => b.textContent.trim()) }; })()`);
        check('the remove button opens a confirm dialog', clicked && !!dlg, JSON.stringify([clicked, dlg]));
        check('whose buttons are Cancel and Remove, in English', dlg && JSON.stringify(dlg.buttons) === JSON.stringify(['Cancel', 'Remove']), dlg && JSON.stringify(dlg.buttons));
        check('and whose title and text are English', dlg && !/[\u3400-\u9fff]/.test(dlg.title + dlg.body) && /remove/i.test(dlg.title + dlg.body), dlg && JSON.stringify([dlg.title, dlg.body]));
      }
    } else console.log('team not created:', JSON.stringify(team));
  } finally {
    await app.close();
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
