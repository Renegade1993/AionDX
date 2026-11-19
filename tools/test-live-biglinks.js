'use strict';
// test-live-biglinks.js - big files go in as links (November 17th, 2026), in the real app (the staged build, a throwaway profile) with the
// edited aiondx-ui.js served in place of the built one. A 200 MB file in %TEMP% is dropped with a real drag (Input.dispatchDragEvent, so
// the page gets real File objects with paths) onto a solo Claude chat's message box and onto the new-chat page's box. Checked: no upload
// request is made, the file shows in the box, the message goes out with it as a local attachment, AionCore accepts it (an upload outside
// its folder would be refused), and the agent is given the file's real path. Spends one short Claude turn. Touches nothing of the user's:
// the file is made in %TEMP%\aiondx-biglink-test and removed at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 900) + ']')); };

const DIR = path.join(os.tmpdir(), 'aiondx-biglink-test');
const BIG = path.join(DIR, 'big-installer-200mb.bin');
const FOLDER = path.join(DIR, 'Survey sheets');   // a folder dropped into the box goes in as a link too (November 17th, 2026)

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const fd = fs.openSync(BIG, 'w'); fs.ftruncateSync(fd, 200 * 1048576); fs.closeSync(fd);
  fs.mkdirSync(FOLDER, { recursive: true }); fs.writeFileSync(path.join(FOLDER, 'sheet-1.txt'), 'one');
  const app = await launch({ port: 9571, deadlineMs: 480000 });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    await app.overrideScript('aiondx-ui.js', path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'));
    for (let i = 0; i < 90; i++) { await sleep(1000); const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; }
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop,.aiondx-coach,.aiondx-whatsnew{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    check('the page has a path for a dropped file (electronAPI.getPathForFile)', await app.js(`typeof (window.electronAPI || {}).getPathForFile === 'function'`));
    await app.js(`window.__t = {
      base: 'http://127.0.0.1:' + window.__backendPort,
      csrf: () => window.__coreCsrfToken || (document.cookie.match(/aionui-csrf-token=([^;]+)/) || [])[1] || '',
      async call(method, url, body) {
        const r = await fetch(this.base + url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': this.csrf() }, body: body ? JSON.stringify(body) : undefined });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, json: j };
      },
    }; 0`);

    // every request the page makes, with its body and its answer
    await app.send('Network.enable', { maxPostDataSize: 65536 });
    const reqs = () => {
      const byId = {};
      app.events.forEach((e) => {
        if (e.method === 'Network.requestWillBeSent') byId[e.params.requestId] = Object.assign(byId[e.params.requestId] || {}, { url: e.params.request.url, method: e.params.request.method, body: e.params.request.postData });
        if (e.method === 'Network.responseReceived') (byId[e.params.requestId] = byId[e.params.requestId] || {}).status = e.params.response.status;
      });
      return Object.values(byId).filter((r) => r.url);
    };
    const dropOn = async (sel, what) => {
      const p = await app.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!p) return false;
      const data = { items: [], files: [what || BIG], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) { await app.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data }); await sleep(150); }
      return true;
    };

    // 1. A solo Claude chat's message box.
    const conv = await app.js(`(async () => {
      const l = ((await window.__t.call('GET', '/api/assistants')).json || {}).data || [];
      const a = l.find((x) => x.name === 'Claude Code') || l[0];
      const r = await window.__t.call('POST', '/api/conversations', { name: 'big file probe', assistant: { id: a.id, locale: 'en-US', conversation_overrides: { permission: 'yolo' } }, extra: { workspace: ${JSON.stringify(DIR)} } });
      const c = r.json && (r.json.data || r.json); return { status: r.status, id: c && c.id };
    })()`);
    check('a solo Claude chat was created', conv && conv.id, JSON.stringify(conv));
    if (!conv || !conv.id) return;
    await app.js(`location.hash = '#/conversation/${conv.id}'; 0`);
    await sleep(6000);
    app.events.length = 0;
    check('the drop reached the message box', await dropOn('.sendbox-panel'));
    await sleep(2500);
    const box = await app.js(`(document.querySelector('.sendbox-panel') || {}).innerText || ''`);
    check('the 200 MB file shows in the box', /big-installer-200mb\.bin/.test(box), box.slice(0, 400));
    const uploads = reqs().filter((r) => /\/api\/fs\/upload/.test(r.url));
    check('and no upload was made', uploads.length === 0, JSON.stringify(uploads));
    check('there is no "Failed to process dropped files"', !/Failed to process/.test(await app.js('document.body.innerText')));
    await app.js(`(() => { const t = document.querySelector('.sendbox-panel textarea'); t.focus(); return 0; })()`);
    await app.type('Reply with only the full path of the attached file, nothing else.');
    await sleep(300);
    app.events.length = 0;
    await app.key('Enter');
    await sleep(4000);
    const sent = reqs().filter((r) => r.method === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(r.url));
    const files = sent.map((r) => { try { return JSON.parse(r.body).files; } catch (e) { return null; } });
    check('the message went with the file as a local attachment, its own path',
      sent.length === 1 && JSON.stringify(files[0]) === JSON.stringify([{ kind: 'local', path: BIG }]), JSON.stringify(sent).slice(0, 600));
    check('and AionCore accepted it', sent.length === 1 && sent[0].status >= 200 && sent[0].status < 300, JSON.stringify(sent.map((r) => r.status)));
    let said = '';
    for (let i = 0; i < 45 && !/aiondx-biglink-test/i.test(said); i++) {
      await sleep(2000);
      said = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/conversations/${conv.id}/messages?limit=20'); const d = rs.json && (rs.json.data || rs.json); const l = Array.isArray(d) ? d : (d && (d.items || d.messages)) || [];
        return l.filter((m) => m && m.position !== 'right' && m.role !== 'user').map((m) => JSON.stringify(m.content || m)).join(' | '); })()`) || '';
    }
    check('the agent was given the real path (its reply names the file\'s folder)', /aiondx-biglink-test/i.test(said) && /big-installer-200mb\.bin/i.test(said), said.slice(0, 600));

    // 1b. A folder dropped into the same box: shown there, sent as a link to it, accepted, its path given to the agent
    await sleep(3000);
    app.events.length = 0;
    check('a folder dropped into the box', await dropOn('.sendbox-panel', FOLDER));
    await sleep(2500);
    const fbox = await app.js(`(document.querySelector('.sendbox-panel') || {}).innerText || ''`);
    check('the folder shows in the box like a file', /Survey sheets/.test(fbox), fbox.slice(0, 300));
    check('and nothing was uploaded, no failure', reqs().filter((r) => /\/api\/fs\/upload/.test(r.url)).length === 0 && !/Failed to process/.test(await app.js('document.body.innerText')));
    await app.js(`(() => { const t = document.querySelector('.sendbox-panel textarea'); t.focus(); return 0; })()`);
    await app.type('Reply with only the full path of the attached folder, nothing else.');
    await sleep(300);
    app.events.length = 0;
    await app.key('Enter');
    await sleep(4000);
    const fsent = reqs().filter((r) => r.method === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(r.url));
    const ffiles = fsent.map((r) => { try { return JSON.parse(r.body).files; } catch (e) { return null; } });
    check('the message went with the folder as a local attachment, and AionCore (core-0023) accepted it',
      fsent.length === 1 && JSON.stringify(ffiles[0]) === JSON.stringify([{ kind: 'local', path: FOLDER }]) && fsent[0].status >= 200 && fsent[0].status < 300, JSON.stringify(fsent).slice(0, 600));
    let fsaid = '';
    for (let i = 0; i < 45 && !/Survey sheets/i.test(fsaid); i++) {
      await sleep(2000);
      fsaid = await app.js(`(async () => { const rs = await window.__t.call('GET', '/api/conversations/${conv.id}/messages?limit=20'); const d = rs.json && (rs.json.data || rs.json); const l = Array.isArray(d) ? d : (d && (d.items || d.messages)) || [];
        return l.filter((m) => m && m.position !== 'right' && m.role !== 'user').map((m) => JSON.stringify(m.content || m)).join(' | '); })()`) || '';
    }
    check('the agent was given the folder\'s path', /Survey sheets/i.test(fsaid), fsaid.slice(-400));

    // 2. The new-chat page's box: the file is attached there and the chat it starts gets it as a link.
    await app.js(`location.hash = '#/guid'; 0`);
    await sleep(4000);
    app.events.length = 0;
    const guidSel = await app.js(`(() => { const t = document.querySelector('[data-testid="guid-send-btn"]'); let e = t; for (let i = 0; e && i < 12; i++) { e = e.parentElement; if (e && e.querySelector('textarea')) return 'found'; } return null; })()`);
    check('the new-chat page has its box', guidSel === 'found', String(guidSel));
    await app.js(`(() => { const t = document.querySelector('[data-testid="guid-send-btn"]'); let e = t; for (let i = 0; e && i < 12; i++) { e = e.parentElement; if (e && e.querySelector('textarea')) { e.setAttribute('data-dx-guid-box', '1'); break; } } return 0; })()`);
    await dropOn('[data-dx-guid-box] textarea');
    await sleep(2500);
    check('the file is attached on the new-chat page, with no upload', reqs().filter((r) => /\/api\/fs\/upload/.test(r.url)).length === 0 &&
      /big-installer-200mb\.bin|File\(1\)/.test(await app.js(`(document.querySelector('[data-dx-guid-box]') || {}).innerText || ''`)), await app.js(`(document.querySelector('[data-dx-guid-box]') || {}).innerText || ''`));
    await app.js(`(() => { const t = document.querySelector('[data-dx-guid-box] textarea'); t.focus(); return 0; })()`);
    await app.type('Say only OK.');
    await sleep(300);
    await app.js(`document.querySelector('[data-testid="guid-send-btn"]').click(); 0`);
    let carried = null;
    for (let i = 0; i < 15 && !carried; i++) {
      await sleep(1000);
      carried = reqs().find((r) => r.method === 'POST' && r.body && r.body.indexOf('big-installer-200mb.bin') >= 0 && /"kind"/.test(r.body) && r.status);
    }
    const kinds = carried ? (carried.body.match(/"kind":"(upload|local)"/g) || []) : [];
    check('the chat it starts sends the file as a local attachment, and AionCore accepts it',
      carried && kinds.length > 0 && kinds.every((k) => /local/.test(k)) && carried.status >= 200 && carried.status < 300, JSON.stringify(carried).slice(0, 700));
  } finally {
    await app.close();
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (x) {} process.exit(2); });
