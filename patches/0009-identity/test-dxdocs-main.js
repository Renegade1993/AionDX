'use strict';
// test-dxdocs-main.js - the DX Docs main-process side (aiondx-dxdocs-main.js): only folders handed out by "where" are usable, list and read
// with comments, the user's save, and the watcher telling the page when an agent changes a doc. A made-up folder; no window.
//   node patches\0009-identity\test-dxdocs-main.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const M = require(path.join(__dirname, 'aiondx-dxdocs-main.js'));
const D = require(path.join(__dirname, 'dxdocs.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-dxdocs-main-'));
(async () => {
  try {
    const data = path.join(root, 'data'), ws = path.join(root, 'ws');
    fs.mkdirSync(data); fs.mkdirSync(ws);
    const svc = M.create({ dataDir: () => data, printPdf: async (html) => Buffer.from('%PDF-1.4 ' + html.length) });
    const sent = [];
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]) });
    let r = await svc.handle({ op: 'list', docsDir: path.join(ws, 'DX Docs') }, wc).catch((e) => ({ ok: false, error: e.message }));
    check('a folder not handed out by "where" is refused', r.ok === false && /not opened as a DX Docs folder/.test(r.error), JSON.stringify(r));
    r = await svc.handle({ op: 'where', convId: 'c1', workspace: ws }, wc);
    const dir = r.docsDir;
    check('where: the chat\'s Docs folder (its working folder here)', r.ok && dir === path.join(ws, 'DX Docs'), JSON.stringify(r));
    await svc.handle({ op: 'watch', docsDir: dir }, wc);
    const c = D.create(dir, { title: 'Plan', sections: [{ heading: 'Goals', intent: 'goals' }] });
    await sleep(500);
    check('an agent creating a doc is told to the page', sent.some(([ch, p]) => ch === 'aiondx:dxdocs-event' && p.kind === 'changed' && p.id === 'plan' && p.docsDir === dir), JSON.stringify(sent));
    sent.length = 0;
    D.update(dir, 'plan', [{ op: 'replace_section', heading: 'Goals', body: 'Win.' }]);
    await sleep(500);
    check('and its edits too (once per burst, not per write)', sent.filter(([, p]) => p.id === 'plan').length === 1, JSON.stringify(sent));
    r = await svc.handle({ op: 'list', docsDir: dir }, wc);
    check('list', r.ok && r.docs.length === 1 && r.docs[0].title === 'Plan');
    await svc.handle({ op: 'comment', docsDir: dir, id: 'plan', quote: 'Win.', text: 'Bigger.' }, wc);
    r = await svc.handle({ op: 'read', docsDir: dir, id: 'plan' }, wc);
    check('read gives the Markdown, its sections and its comments', r.ok && /## Goals\n\nWin\./.test(r.markdown) && r.comments.length === 1 && r.comments[0].by === 'user', JSON.stringify(r).slice(0, 300));
    r = await svc.handle({ op: 'save', docsDir: dir, id: 'plan', markdown: '# Plan\n\nMine.\n' }, wc);
    check('save (the user\'s edit) keeps the version before', r.ok && r.previous && (await svc.handle({ op: 'history', docsDir: dir, id: 'plan' }, wc)).versions.length === 2);
    r = await svc.handle({ op: 'pdf', docsDir: dir, id: 'plan', html: '<h1>Plan</h1>' }, wc);
    check('PDF export writes Docs\\<id>.pdf', r.ok && fs.readFileSync(path.join(dir, 'plan.pdf'), 'utf8').startsWith('%PDF'), JSON.stringify(r));
    r = await svc.handle({ op: 'read', docsDir: dir, id: '..\\..\\x' }, wc).catch((e) => ({ ok: false, error: e.message }));
    check('an id that leaves the folder is refused', r.ok === false);
    await svc.handle({ op: 'unwatch', docsDir: dir }, wc);
    check('unwatch closes the watcher when nobody watches', svc.watchers.size === 0);
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
