'use strict';
// aiondx-dxdocs-main.js (patches/0009-identity): DX Docs for the chat's right-hand sidebar (R-121). The page asks where a chat's docs are
// (op where), lists, reads, saves and comments through the engine (dxdocs.js), and is told when a doc changes on disk (an agent writing it):
// the DX Docs folder is watched while the sidebar shows it, and each change is sent as {kind:'changed', docsDir, id}. PDF export prints the
// rendered doc with Electron's own printer (no Office). Only DX Docs folders handed out by "where" can be read or written.
//
// ipc "aiondx:dxdocs": where {convId, teamId, workspace} | list | read | save | history | version | restore | comments | comment | reply |
//   watch | unwatch | pdf {docsDir, id, html} | reveal {docsDir, id} | image {docsDir, src}. Events: "aiondx:dxdocs-event".

const fs = require('fs');
const path = require('path');
const D = require('./dxdocs.js');

const exportAll = (md) => D.MD.exportAll(md);

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
      const onName = (_ev, name) => {
        const n = String(name || '').replace(/\\/g, '/');
        const m = /^(?:\.(?:comments|suggestions)\/)?([^/]+)\.(md|json)$/.exec(n);
        if (!m || n.endsWith('.tmp') || (m[2] === 'json' && n.indexOf('/') < 0) || (m[2] === 'md' && n.indexOf('/') >= 0)) return;
        pending.add(m[1]);
        clearTimeout(w.timer);
        w.timer = setTimeout(() => { for (const id of pending) emit(dir, { kind: 'changed', docsDir: dir, id }); pending.clear(); }, 120);
      };
      for (const sub of ['.comments', '.suggestions']) { try { fs.mkdirSync(path.join(dir, sub), { recursive: true }); } catch { /* read-only */ } }
      try { w.w = fs.watch(dir, { persistent: false, recursive: true }, onName); } catch { w.w = fs.watch(dir, { persistent: false }, onName); }
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
    if (op === 'alldocs') {
      // every project's DX Docs (aiondx-projects.json), each folder opened for this page; the chat's own folder first when given
      const reg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir() || '', 'aiondx-projects.json'), 'utf8')); } catch { return null; } })();
      const dirs = [];
      const add = (d, project, name) => { const r = path.resolve(d); if (!dirs.some((x) => x.docsDir === r)) dirs.push({ docsDir: r, project: project || null, name: name || path.basename(path.dirname(r)) }); };
      if (req.docsDir && allowed.has(path.resolve(String(req.docsDir)))) add(req.docsDir, null, null);
      for (const [key, p] of Object.entries((reg && reg.projects) || {})) if (p && p.root && fs.existsSync(p.root)) add(path.join(p.root, D.DOCS_FOLDER), key, p.name || path.basename(p.root));
      const out = [];
      for (const d of dirs) {
        const docs = D.list(d.docsDir);
        if (!docs.length) continue;
        allowed.add(d.docsDir);
        out.push(Object.assign({}, d, { docs }));
      }
      return { ok: true, folders: out };
    }
    const dir = ok(req.docsDir);
    if (op === 'list') return { ok: true, docs: D.list(dir), deleted: D.recycled(dir).length };
    if (op === 'create') return Object.assign({ ok: true }, D.create(dir, { title: req.title, sections: req.sections, by: 'you' }));
    if (op === 'read') return Object.assign({ ok: true }, D.read(dir, req.id, { tab: req.tab }), { comments: D.comments(dir, req.id), author: D.author(dir, req.id), suggestions: D.suggestions(dir, req.id) });
    if (op === 'rename') return Object.assign({ ok: true }, D.rename(dir, req.id, req.title, 'you'));
    if (op === 'delete') return Object.assign({ ok: true }, D.remove(dir, req.id, 'you'));
    if (op === 'deleted') return { ok: true, deleted: D.recycled(dir) };
    if (op === 'undelete') return Object.assign({ ok: true }, D.undelete(dir, req.deleted));
    if (op === 'tabs') return Object.assign({ ok: true }, D.update(dir, req.id, (Array.isArray(req.ops) ? req.ops : []).filter((o) => o && /^(add|rename|move|delete)_tab$/.test(o.op)).slice(0, 20), 'you'));
    if (op === 'save') return Object.assign({ ok: true }, D.save(dir, req.id, req.markdown, req.by === 'you' ? 'you' : 'you'));
    if (op === 'history') return { ok: true, versions: D.history(dir, req.id) };
    if (op === 'version') return { ok: true, markdown: D.readVersion(dir, req.id, req.version) };
    if (op === 'restore') return Object.assign({ ok: true }, D.restore(dir, req.id, req.version));
    if (op === 'comments') return { ok: true, comments: D.comments(dir, req.id) };
    if (op === 'comment') return { ok: true, comment: D.addComment(dir, req.id, { quote: req.quote, text: req.text, section: req.section, tab: req.tab, on: req.on, index: req.index, sg: req.sg, by: 'user' }) };
    if (op === 'reply') return { ok: true, comment: D.replyComment(dir, req.id, req.comment, { text: req.text, resolve: req.resolve, by: 'user' }) };
    if (op === 'image') {
      // a picture a doc shows: relative to the DX Docs folder, or a path or file: URL under the project's root (the folder above it)
      let src = String(req.src || '');
      if (/^file:/i.test(src)) { try { src = require('url').fileURLToPath(src); } catch { return { ok: false, error: 'bad file URL' }; } }
      else { try { src = decodeURIComponent(src); } catch { /* as written */ } }
      const root = path.dirname(dir);
      const f = path.resolve(dir, src);
      const rel = path.relative(root, f);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'That picture is outside this project.' };
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
      const type = types[path.extname(f).toLowerCase()];
      if (!type) return { ok: false, error: 'Not a picture.' };
      let st; try { st = fs.statSync(f); } catch { return { ok: false, error: 'No such picture: ' + rel }; }
      if (!st.isFile() || st.size > 15 * 1048576) return { ok: false, error: 'Too large to show (over 15 MB).' };
      return { ok: true, url: 'data:' + type + ';base64,' + fs.readFileSync(f).toString('base64') };
    }
    if (op === 'suggestions') return { ok: true, suggestions: D.suggestions(dir, req.id) };
    // a picture pasted or dropped into a doc: DX Docs\pictures\<doc>-<stamp>.<type>, its path for the doc's Markdown
    if (op === 'savepicture') {
      D.read(dir, req.id);
      const m = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.data || ''));
      if (!m) return { ok: false, error: 'Only a picture (PNG, JPEG, GIF, WebP or BMP) can go in a doc.' };
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 15 * 1048576) return { ok: false, error: 'That picture is over 15 MB.' };
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      const name = req.id + '-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext;
      fs.mkdirSync(path.join(dir, 'pictures'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pictures', name), buf);
      return { ok: true, path: 'pictures/' + name };
    }
    // a CSV file a chart reads (inside the project only)
    if (op === 'readcsv') { const t = D.csvLoader(dir)(req.src); return t === false ? { ok: false, error: 'No such CSV file in this project: ' + String(req.src || '') } : { ok: true, text: t }; }
    // the user's own Suggesting mode: their change proposed, not made
    if (op === 'suggest') return Object.assign({ ok: true }, D.suggest(dir, req.id, { find: req.find, replace: req.replace, note: req.note, by: 'you' }));
    if (op === 'decide') return Object.assign({ ok: true }, D.decide(dir, req.id, req.suggestion, req.verdict === 'accept' ? 'accept' : 'reject', 'you'));
    if (op === 'watch') { watch(dir, sender); return { ok: true }; }
    if (op === 'unwatch') { unwatch(dir, sender); return { ok: true }; }
    if (op === 'reveal') {
      const f = path.join(dir, String(req.id || '') + '.md');
      if (opts.shell && fs.existsSync(f)) opts.shell.showItemInFolder(f);
      return { ok: true };
    }
    if (op === 'docx') {
      const r = D.read(dir, req.id, { tab: req.tab });   // the id must be a doc in this folder
      const tabSlug = r.tab ? '-' + D.slugOf(r.tab.title) : '';
      const out = path.join(dir, req.id + tabSlug + '.docx');
      const pics = Array.isArray(req.pictures) ? req.pictures.slice(0, 64).map((p) => (p && typeof p.png === 'string' && p.png.length < 20 * 1048576 ? { png: p.png, w: Number(p.w) || 640, h: Number(p.h) || 360 } : null)) : [];
      // one tab: that tab's view; all of a doc with tabs: each tab a part of its own, its title the part's heading
      const md = r.tab ? r.tab.markdown : exportAll(r.markdown);
      fs.writeFileSync(out, await require('./dxdocs-word.js').toDocx(md, { docsDir: dir, title: r.title + (r.tab ? ': ' + r.tab.title : ''), pictures: pics, loadCsv: D.csvLoader(dir) }));
      if (opts.shell) opts.shell.showItemInFolder(out);
      return { ok: true, path: out };
    }
    if (op === 'mdcopy') {
      // a Markdown copy to hand to anyone (one tab, or every tab as one document): DX Docs\exports\<id>[-<tab>].md, shown in its folder
      const r = D.read(dir, req.id, { tab: req.tab });
      const out = path.join(dir, 'exports', req.id + (r.tab ? '-' + D.slugOf(r.tab.title) : '') + '.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.tab ? r.tab.markdown : exportAll(r.markdown));
      if (opts.shell) opts.shell.showItemInFolder(out);
      return { ok: true, path: out };
    }
    if (op === 'pdf') {
      if (!opts.printPdf) return { ok: false, error: 'PDF export is not available here.' };
      const rp = D.read(dir, req.id, { tab: req.tab });   // the id (and tab) must be in this folder
      const out = path.join(dir, req.id + (rp.tab ? '-' + D.slugOf(rp.tab.title) : '') + '.pdf');
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

module.exports = { install, create, exportAll };
