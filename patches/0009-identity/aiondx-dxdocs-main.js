'use strict';
// aiondx-dxdocs-main.js (patches/0009-identity): DX Docs for the chat's right-hand sidebar (R-121). The page asks where a chat's docs are
// (op where), lists, reads, saves and comments through the engine (dxdocs.js), and is told when a doc changes on disk (an agent writing it):
// the DX Docs folder is watched while the sidebar shows it, and each change is sent as {kind:'changed', docsDir, id}. PDF export prints the
// rendered doc with Electron's own printer (no Office). Only DX Docs folders handed out by "where" can be read or written.
//
// ipc "aiondx:dxdocs": where {convId, teamId, workspace} | list | read | save | history | version | restore | comments | comment | reply |
//   watch | unwatch | pdf {docsDir, id, html} | reveal {docsDir, id}. Events: "aiondx:dxdocs-event".

const fs = require('fs');
const path = require('path');
const D = require('./dxdocs.js');

function create(o) {
  const opts = o || {};
  const allowed = new Set();
  const watchers = new Map();   // docsDir -> { w, timer, subs:Set(webContents) }
  const dataDir = opts.dataDir || (() => null);
  const ok = (dir) => {
    const d = path.resolve(String(dir || ''));
    if (!allowed.has(d)) throw new Error('That folder was not opened as a DX Docs folder.');
    return d;
  };
  function emit(dir, payload) {
    const w = watchers.get(dir);
    if (!w) return;
    for (const wc of w.subs) { try { if (!wc.isDestroyed()) wc.send('aiondx:dxdocs-event', payload); } catch { /* gone */ } }
  }
  function watch(dir, wc) {
    let w = watchers.get(dir);
    if (!w) {
      fs.mkdirSync(dir, { recursive: true });
      const pending = new Set();
      w = { subs: new Set(), timer: null, w: null };
      w.w = fs.watch(dir, { persistent: false }, (_ev, name) => {
        const n = String(name || '');
        if (!n.endsWith('.md') || n.endsWith('.tmp')) return;
        pending.add(n.slice(0, -3));
        clearTimeout(w.timer);
        w.timer = setTimeout(() => { for (const id of pending) emit(dir, { kind: 'changed', docsDir: dir, id }); pending.clear(); }, 120);
      });
      w.w.on('error', () => { /* the folder went: the page's next list says so */ });
      watchers.set(dir, w);
    }
    if (wc) {
      w.subs.add(wc);
      if (wc.once) wc.once('destroyed', () => unwatch(dir, wc));
    }
  }
  function unwatch(dir, wc) {
    const w = watchers.get(dir);
    if (!w) return;
    if (wc) w.subs.delete(wc); else w.subs.clear();
    if (!w.subs.size) { try { w.w.close(); } catch { /* closed */ } clearTimeout(w.timer); watchers.delete(dir); }
  }
  async function handle(req, sender) {
    const op = req && req.op;
    if (op === 'where') {
      const r = D.resolveRoot({ dataDir: dataDir(), convId: req.convId, teamId: req.teamId, workspace: req.workspace });
      if (!r) return { ok: false, error: 'This chat has no project and no working folder for docs.' };
      allowed.add(path.resolve(r.docsDir));
      return { ok: true, docsDir: path.resolve(r.docsDir), root: r.root, project: r.project };
    }
    const dir = ok(req.docsDir);
    if (op === 'list') return { ok: true, docs: D.list(dir) };
    if (op === 'create') return Object.assign({ ok: true }, D.create(dir, { title: req.title, sections: req.sections }));
    if (op === 'read') return Object.assign({ ok: true }, D.read(dir, req.id), { comments: D.comments(dir, req.id) });
    if (op === 'save') return Object.assign({ ok: true }, D.save(dir, req.id, req.markdown));
    if (op === 'history') return { ok: true, versions: D.history(dir, req.id) };
    if (op === 'version') return { ok: true, markdown: D.readVersion(dir, req.id, req.version) };
    if (op === 'restore') return Object.assign({ ok: true }, D.restore(dir, req.id, req.version));
    if (op === 'comments') return { ok: true, comments: D.comments(dir, req.id) };
    if (op === 'comment') return { ok: true, comment: D.addComment(dir, req.id, { quote: req.quote, text: req.text, section: req.section, by: 'user' }) };
    if (op === 'reply') return { ok: true, comment: D.replyComment(dir, req.id, req.comment, { text: req.text, resolve: req.resolve, by: 'user' }) };
    if (op === 'watch') { watch(dir, sender); return { ok: true }; }
    if (op === 'unwatch') { unwatch(dir, sender); return { ok: true }; }
    if (op === 'reveal') {
      const f = path.join(dir, String(req.id || '') + '.md');
      if (opts.shell && fs.existsSync(f)) opts.shell.showItemInFolder(f);
      return { ok: true };
    }
    if (op === 'pdf') {
      if (!opts.printPdf) return { ok: false, error: 'PDF export is not available here.' };
      D.read(dir, req.id);   // the id must be a doc in this folder
      const out = path.join(dir, req.id + '.pdf');
      fs.writeFileSync(out, await opts.printPdf(String(req.html || '')));
      if (opts.shell) opts.shell.showItemInFolder(out);
      return { ok: true, path: out };
    }
    return { ok: false, error: 'unknown request' };
  }
  return { handle, watchers };
}

function install(electron) {
  const { ipcMain, app, BrowserWindow, shell } = electron;
  const printPdf = async (html) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      return await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    } finally { w.destroy(); }
  };
  const svc = create({ dataDir: () => app.getPath('userData'), shell, printPdf });
  ipcMain.handle('aiondx:dxdocs', async (event, req) => {
    try { return await svc.handle(req || {}, event.sender); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

module.exports = { install, create };
