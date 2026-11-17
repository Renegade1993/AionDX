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
    check('watching does not make the folder (no empty DX Docs left in a project folder)', !fs.existsSync(dir));
    const c = D.create(dir,{ title: 'Plan', sections: [{ heading: 'Goals', intent: 'goals' }] });
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
    r = await svc.handle({ op: 'docx', docsDir: dir, id: 'plan', pictures: [] }, wc);
    check('Word export writes Docs\\<id>.docx (DX Docs mirror, step 4)', r.ok && fs.readFileSync(path.join(dir, 'plan.docx')).slice(0, 2).toString() === 'PK', JSON.stringify(r));
    r = await svc.handle({ op: 'read', docsDir: dir, id: '..\\..\\x' }, wc).catch((e) => ({ ok: false, error: e.message }));
    check('an id that leaves the folder is refused', r.ok === false);
    // pictures (November 13th): relative to the DX Docs folder, under the project's root only, pictures only
    fs.mkdirSync(path.join(dir, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pictures', 'massif.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    r = await svc.handle({ op: 'image', docsDir: dir, src: 'pictures/massif.jpg' }, wc);
    check('a picture beside the doc comes back as a data URL', r.ok && r.url === 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64'), JSON.stringify(r).slice(0, 120));
    r = await svc.handle({ op: 'image', docsDir: dir, src: 'pictures/massif%20x.jpg' }, wc);
    check('a missing one says so', r.ok === false && /No such picture/.test(r.error), JSON.stringify(r));
    fs.writeFileSync(path.join(path.dirname(path.dirname(dir)), 'outside.png'), 'x');
    r = await svc.handle({ op: 'image', docsDir: dir, src: '../../outside.png' }, wc);
    check('one outside the project is refused', r.ok === false && /outside this project/.test(r.error), JSON.stringify(r));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    r = await svc.handle({ op: 'image', docsDir: dir, src: 'notes.txt' }, wc);
    check('a file that is not a picture is refused', r.ok === false && /Not a picture/.test(r.error), JSON.stringify(r));
    // documents and tabs from the panel (DX Docs mirror, November 15th)
    r = await svc.handle({ op: 'rename', docsDir: dir, id: 'plan', title: 'Launch plan' }, wc);
    check('rename from the panel', r.ok && D.read(dir, 'plan').title === 'Launch plan' && D.author(dir, 'plan').by === 'you', JSON.stringify(r));
    r = await svc.handle({ op: 'tabs', docsDir: dir, id: 'plan', ops: [{ op: 'add_tab', title: 'Budget' }, { op: 'replace_section', heading: 'x', body: 'not a tab op' }] }, wc);
    check('the panel\'s tab changes go through, and only tab operations', r.ok && JSON.stringify(D.read(dir, 'plan').tabs.map((t) => t.title)) === '["Overview","Budget"]', JSON.stringify(r));
    r = await svc.handle({ op: 'read', docsDir: dir, id: 'plan', tab: 't2' }, wc);
    check('read one tab: its own view', r.ok && r.tab && r.tab.markdown === '# Launch plan\n\n' && r.tabs.length === 2, JSON.stringify(r.tab));
    D.update(dir, 'plan', [{ op: 'write', tab: 't2', markdown: '## Costs\n\nLow.' }]);
    r = await svc.handle({ op: 'docx', docsDir: dir, id: 'plan', tab: 't2', pictures: [] }, wc);
    check('Word export of one tab: <id>-<tab>.docx', r.ok && fs.existsSync(path.join(dir, 'plan-budget.docx')), JSON.stringify(r));
    const all = M.exportAll(D.read(dir, 'plan').markdown);
    check('Word export of every tab: each tab a part under its own heading, its sections one level down', /^# Launch plan\n\n## Overview\n\nMine\.\n\n## Budget\n\n### Costs\n\nLow\.\n/.test(all), all);
    r = await svc.handle({ op: 'delete', docsDir: dir, id: 'plan' }, wc);
    const dl = await svc.handle({ op: 'deleted', docsDir: dir }, wc);
    const ls = await svc.handle({ op: 'list', docsDir: dir }, wc);
    check('delete to the recycle folder; the list says one is deleted', r.ok && dl.deleted.length === 1 && ls.docs.length === 0 && ls.deleted === 1, JSON.stringify([dl, ls]));
    r = await svc.handle({ op: 'undelete', docsDir: dir, deleted: dl.deleted[0].deleted }, wc);
    check('and back', r.ok && r.id === 'plan' && D.read(dir, 'plan').title === 'Launch plan', JSON.stringify(r));
    // every project's docs
    const proj = path.join(root, 'Atlas');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ projects: { atlas: { root: proj, name: 'Atlas' }, empty: { root: path.join(root, 'nothing') } } }));
    D.create(path.join(proj, 'DX Docs'), { title: 'Atlas notes' });
    r = await svc.handle({ op: 'alldocs', docsDir: dir }, wc);
    check('all docs: this chat\'s folder first, then every project with docs, each named', r.ok && r.folders.length === 2 && r.folders[0].docsDir === dir && r.folders[1].name === 'Atlas' && r.folders[1].docs[0].title === 'Atlas notes', JSON.stringify(r).slice(0, 400));
    r = await svc.handle({ op: 'read', docsDir: path.join(proj, 'DX Docs'), id: 'atlas-notes' }, wc);
    check('and a doc from another project can then be opened', r.ok && r.title === 'Atlas notes', JSON.stringify(r).slice(0, 200));
    // a look (dxdoc_look): an agent asks through a file, the app draws it (here a stand-in for its hidden window), the agent gets a PNG
    D.update(dir, 'plan', [{ op: 'write', tab: 't1', markdown: '## Sales\n\n```chart\n{"type":"bar","title":"First","x":["a"],"series":[{"name":"s","values":[1]}]}\n```\n\n```chart\n{"type":"line","title":"Second","x":["a","b"],"series":[{"name":"s","values":[1,2]}]}\n```' }]);
    const pages = [];
    const fakePng = Buffer.from('89504e470d0a1a0a', 'hex');
    const stop = M.lookService(path.join(data, 'dx-look'), async (page) => { pages.push(fs.readFileSync(page, 'utf8')); return { png: fakePng, width: 720, height: 380 }; }, null);
    try {
      const lk = await D.look(data, dir, { doc: 'plan', tab: 't1', what: 'chart', index: 1 }, 8000);
      check('a look: the app draws the one chart asked for (the second) and hands back its PNG', fs.existsSync(lk.png) && lk.width === 720 && pages.length === 1 && /Second/.test(pages[0]) && !/First/.test(pages[0]) && /dx-chart-svg/.test(pages[0]), JSON.stringify(lk));
      const bad = await D.look(data, dir, { doc: 'plan', tab: 't1', what: 'chart', index: 5 }, 8000).then(() => '', (e) => e.message);
      check('asking for a chart the tab does not have says how many it has', /has 2 charts; "index" counts from 0/.test(bad), bad);
      const whole = await D.look(data, dir, { doc: 'plan', tab: 't1' }, 8000);
      check('a look at the whole tab', fs.existsSync(whole.png) && pages.length === 2 && /First/.test(pages[1]) && /Second/.test(pages[1]));
    } finally { stop(); }
    const off = await D.look(data, dir, { doc: 'plan' }, 1200).then(() => '', (e) => e.message);
    check('with AionDX not drawing, the asker is told it needs AionDX open', /needs AionDX open/.test(off), off);
    await svc.handle({ op: 'unwatch', docsDir: dir }, wc);
    check('unwatch closes the watcher when nobody watches', svc.watchers.size === 0);
    await svc.handle({ op: 'watch', docsDir: dir }, wc);
    sent.length = 0;
    D.create(dir, { title: 'Later' });
    await sleep(500);
    check('a folder already there is watched straight away', sent.some(([, p]) => p.kind === 'changed' && p.id === 'later'), JSON.stringify(sent));
    await svc.handle({ op: 'unwatch', docsDir: dir }, wc);
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
