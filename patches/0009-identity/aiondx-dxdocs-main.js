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

const PICTURE_MAX = 400 * 1048576;   // a picture bigger than this is not loaded into the page at all (it is offered to open from its folder)
const PREVIEW_OVER = 8 * 1048576;    // a picture bigger than this is drawn in a doc from a smaller copy, full size on a click
const PREVIEW_EDGE = 3000;           // the smaller copy's longest side
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
      const pending = new Set();
      w = { subs: new Set(), timer: null, w: null, wait: null };
      const onName = (_ev, name) => {
        const n = String(name || '').replace(/\\/g, '/');
        const m = /^(?:\.(?:comments|suggestions)\/)?([^/]+)\.(md|json)$/.exec(n);
        if (!m || n.endsWith('.tmp') || (m[2] === 'json' && n.indexOf('/') < 0) || (m[2] === 'md' && n.indexOf('/') >= 0)) return;
        pending.add(m[1]);
        clearTimeout(w.timer);
        w.timer = setTimeout(() => { for (const id of pending) emit(dir, { kind: 'changed', docsDir: dir, id }); pending.clear(); }, 120);
      };
      const start = () => {
        try { w.w = fs.watch(dir, { persistent: false, recursive: true }, onName); } catch { w.w = fs.watch(dir, { persistent: false }, onName); }
        w.w.on('error', () => { /* the folder went: the page's next list says so */ });
      };
      watchers.set(dir, w);
      if (fs.existsSync(dir)) start();
      else {
        // no docs here yet: the folder is not made just because the panel looked (the first doc makes it); the folder above is watched
        // until it appears, and whatever is in it by then is announced
        try {
          w.wait = fs.watch(path.dirname(dir), { persistent: false }, (_ev, name) => {
            if (String(name || '').toLowerCase() !== path.basename(dir).toLowerCase() || !fs.existsSync(dir) || w.w) return;
            try { w.wait.close(); } catch { /* closed */ }
            w.wait = null;
            start();
            setTimeout(() => { for (const d of D.list(dir)) emit(dir, { kind: 'changed', docsDir: dir, id: d.id }); }, 120);
          });
          w.wait.on('error', () => { /* the folder above went */ });
        } catch { /* the folder above is gone too: the page's next list says so */ }
      }
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
    if (!w.subs.size) { for (const x of [w.w, w.wait]) { try { if (x) x.close(); } catch { /* closed */ } } clearTimeout(w.timer); watchers.delete(dir); }
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
    if (op === 'tabs') return Object.assign({ ok: true }, D.update(dir, req.id, (Array.isArray(req.ops) ? req.ops : []).filter((o) => o && /^((add|rename|move|delete)_tab|set_tab_color)$/.test(o.op)).slice(0, 20), 'you'));
    if (op === 'save') return Object.assign({ ok: true }, D.save(dir, req.id, req.markdown, req.by === 'you' ? 'you' : 'you'));
    if (op === 'history') return { ok: true, versions: D.history(dir, req.id) };
    if (op === 'version') return { ok: true, markdown: D.readVersion(dir, req.id, req.version) };
    if (op === 'restore') return Object.assign({ ok: true }, D.restore(dir, req.id, req.version));
    if (op === 'comments') return { ok: true, comments: D.comments(dir, req.id) };
    if (op === 'comment') return { ok: true, comment: D.addComment(dir, req.id, { quote: req.quote, text: req.text, section: req.section, tab: req.tab, on: req.on, index: req.index, sg: req.sg, by: 'user' }) };
    if (op === 'reply') return { ok: true, comment: D.replyComment(dir, req.id, req.comment, { text: req.text, resolve: req.resolve, by: 'user' }) };
    if (op === 'imagefull') return handle(Object.assign({}, req, { op: 'image', full: true }), sender);
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
      // any size (November 19th, 2026: a 2572 x 4800 sheet showed only "Too large to show (over 15 MB)", and the user judges pixel detail):
      // a big picture is drawn in the doc from a smaller copy and opened full size on a click (op imagefull); the guard only stops a file
      // too big to hold at all
      if (!st.isFile()) return { ok: false, error: 'No such picture: ' + rel };
      if (st.size > PICTURE_MAX) return { ok: false, error: 'This picture is ' + Math.round(st.size / 1048576) + ' MB, too big to load; open it from its folder.', path: f };
      if (!req.full && st.size > PREVIEW_OVER && opts.nativeImage && type !== 'image/svg+xml' && type !== 'image/gif') {
        try {
          const im = opts.nativeImage.createFromPath(f);
          const sz = im.getSize();
          if (sz.width > 0) {
            const k = Math.min(1, PREVIEW_EDGE / Math.max(sz.width, sz.height));
            const small = k < 1 ? im.resize({ width: Math.round(sz.width * k), height: Math.round(sz.height * k), quality: 'good' }) : im;
            return { ok: true, url: 'data:image/jpeg;base64,' + small.toJPEG(90).toString('base64'), preview: true, width: sz.width, height: sz.height, bytes: st.size, path: f };
          }
        } catch { /* drawn whole below */ }
      }
      return { ok: true, url: 'data:' + type + ';base64,' + fs.readFileSync(f).toString('base64'), path: f, bytes: st.size };
    }
    if (op === 'suggestions') return { ok: true, suggestions: D.suggestions(dir, req.id) };
    // a picture pasted or dropped into a doc: DX Docs\pictures\<doc>-<stamp>.<type>, its path for the doc's Markdown
    if (op === 'savepicture') {
      D.read(dir, req.id);
      const m = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.data || ''));
      if (!m) return { ok: false, error: 'Only a picture (PNG, JPEG, GIF, WebP or BMP) can go in a doc.' };
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > PICTURE_MAX) return { ok: false, error: 'That picture is over ' + Math.round(PICTURE_MAX / 1048576) + ' MB.' };
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

// ---- a look at a doc (DX Docs mirror, the dxdoc_look tool): the doc, or one chart, drawing or diagram in it, drawn as the panel draws it,
// as a PNG an agent opens to check its own work before it says it is done (Claude Docs' agents look at their charts the same way).
// Agents ask through files: <userData>\dx-look\<id>.req.json { docsDir, doc, tab, what: doc|chart|drawing|diagram, index }; the app draws
// it in a hidden window and writes <id>.png and <id>.done.json { ok, png, width, height } (or { ok:false, error }). Only a doc in a folder
// named "DX Docs" is read; nothing in it runs (charts and drawings are drawn by the engine; diagrams by the app's own Mermaid, strict).
const LOOK_CSS = [
  'html,body{margin:0;background:#fff}body{font:14px/1.6 "Segoe UI",Arial,sans-serif;color:#1d2129}.dx-body{padding:20px 26px;width:760px;box-sizing:border-box}',
  'h1{font-size:24px;margin:0 0 14px}h2{font-size:18px;margin:22px 0 8px}h3{font-size:15.5px}h4{font-size:14px}table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #d4d4d4;padding:4px 8px}th{background:#f3f3f3}',
  'pre{background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap}code{font-family:Consolas,monospace}blockquote{border-left:3px solid #ccc;margin:8px 0;padding:2px 12px;color:#444}',
  ':root,.aiondx-dx{--dxc1:#2f6fdb;--dxc2:#e8743b;--dxc3:#19a979;--dxc4:#945ecf;--dxc5:#d64a7b;--dxc6:#13a4b4;--dxc7:#b88a12;--dxc8:#6e7b8b;--dxc-bg:#fff}',
  '.dx-chart{margin:10px 0 18px;position:relative}.dx-chart-svg,.dx-drawing-svg{display:block;width:100%;height:auto}.dx-chart-data,.dx-chart-tablewrap,.dx-fig-comment,.dx-fig-badge{display:none}',
  '.dx-chart figcaption{font-size:12px;color:#666}.dx-ch-title{font:600 13px "Segoe UI",Arial;fill:#1d2129}.dx-ch-tick,.dx-ch-legend,.dx-ch-axis{font:11px "Segoe UI",Arial;fill:#666}',
  '.dx-ch-grid{stroke:#ebebeb}.dx-ch-zero{stroke:#999}.dx-ch-line{fill:none;stroke-width:2;stroke-linejoin:round}.dx-ch-area{opacity:.18}.dx-ch-pct{font:600 11px "Segoe UI",Arial;fill:#fff}',
  '.dx-ch-val{font:600 10.5px "Segoe UI",Arial;fill:#333}.dx-ch-conn{stroke:#999;stroke-dasharray:2 2}.dx-ch-note line{stroke:#888}.dx-ch-note text{font:11px "Segoe UI",Arial;fill:#111}',
  '.dx-ch-target line{stroke:#d33;stroke-dasharray:6 4;stroke-width:1.5}.dx-ch-target text{font:600 11px "Segoe UI",Arial;fill:#d33}',
  '.dx-ch-val,.dx-ch-target text,.dx-ch-note text{paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}',
  '.dx-chart--bad{padding:8px 10px;border:1px dashed #d33;border-radius:6px;color:#444;font-size:12px}',
  '.dx-mermaid{margin:10px 0 18px}.dx-mermaid svg{display:block;max-width:100%;height:auto;margin:0 auto}.dx-mermaid[data-drawn="1"] pre{display:none}',
  '.dx-drawing{margin:10px 0 18px}.dx-dr-title{font:600 14px "Segoe UI",Arial;fill:#1d2129}.dx-dr-qname,.dx-dr-label{font:600 12px "Segoe UI",Arial;fill:#333}.dx-dr-box{stroke:#c8c8c8}',
  '.dx-dr-q0{fill:#e9f6ee}.dx-dr-q1{fill:#e8effc}.dx-dr-q2{fill:#f3f3f3}.dx-dr-q3{fill:#fcecec}.dx-dr-axis,.dx-dr-stem{stroke:#888;stroke-width:1.5}.dx-dr-small{font:11px "Segoe UI",Arial;fill:#666}',
  '.dx-dr-dot{fill:#2f6fdb}.dx-dr-item,.dx-dr-ptitle,.dx-dr-roofname{font:600 12px "Segoe UI",Arial;fill:#1d2129}.dx-dr-point{font:11.5px "Segoe UI",Arial;fill:#333}.dx-dr-date{font:600 11px "Segoe UI",Arial;fill:#2f6fdb}',
  '.dx-dr-roof{fill:#e8effc;stroke:#2f6fdb}.dx-dr-pillar{fill:#f5f5f5;stroke:#c8c8c8}.dx-dr-base{fill:#ededed;stroke:#c8c8c8}',
  '.dx-pending{color:#888;font-style:italic}.dx-tabmark{margin:18px 0 8px;padding:4px 10px;border-radius:6px;background:#f0f0f0;font-size:12px;font-weight:600}',
  '.dx-chip{display:inline-block;padding:0 7px;border-radius:10px;background:#efefef;font-size:.92em}.dx-chip-caret{opacity:.6;font-size:.8em}',
  '.dx-callout{border-left:4px solid #888;background:#f5f5f5;border-radius:0 8px 8px 0;padding:6px 12px;margin:10px 0}.dx-callout-tag{font-size:11.5px;font-weight:700;color:#666}',
  '.dx-choice,.dx-approve{margin:10px 0;padding:10px 12px;border:1px solid #ddd;border-radius:10px;background:#fafafa}.dx-choice-q,.dx-approve-label{font-weight:600}.dx-choice-opt{display:block}.dx-choice-state,.dx-approve-state{font-size:12px;color:#777}',
  '.dx-csv,.dx-mdblock{margin:10px 0;border:1px solid #ddd;border-radius:8px;padding:4px 8px}.dx-math--block{display:block;text-align:center;margin:10px 0}mark{background:#ffe680}img{max-width:100%}'
].join('\n');
/** The Markdown a look draws: the doc's open tab (or its only one), or one chart, drawing or diagram in it (the nth of its kind, from 0). */
function lookMarkdown(markdown, req) {
  const MD = D.MD;
  const view = req.tab ? MD.tabView(markdown, req.tab) : MD.splitTabs(markdown).tabs.length > 1 ? MD.tabView(markdown, MD.splitTabs(markdown).tabs[0].id) : markdown;
  const what = String(req.what || 'doc');
  if (what === 'doc') return view;
  const langs = what === 'chart' ? ['chart'] : what === 'diagram' ? ['mermaid'] : what === 'drawing' ? ['drawing', 'svg'] : null;
  if (!langs) throw new Error('"what" is doc, chart, drawing or diagram.');
  const lines = view.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const f = /^(```|~~~)\s*([\w+-]*)\s*$/.exec(lines[i]);
    if (!f) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].indexOf(f[1]) !== 0) j++;
    if (langs.indexOf(f[2].toLowerCase()) >= 0) blocks.push(lines.slice(i, j + 1).join('\n'));
    i = j;
  }
  const n = Math.max(0, +req.index || 0);
  if (!blocks[n]) throw new Error('That ' + (req.tab ? 'tab' : 'doc') + ' has ' + blocks.length + ' ' + what + (blocks.length === 1 ? '' : 's') + '; "index" counts from 0.');
  return blocks[n];
}
/** The page a look draws, with the app's own Mermaid and KaTeX beside it (file URLs). */
function lookPage(markdown, req, docsDir, rendererDir) {
  const { pathToFileURL } = require('url');
  const MD = D.MD;
  let md = lookMarkdown(markdown, req);
  // charts that read a CSV file are drawn from it here
  const CH = require('./dxcharts.js');
  const load = D.csvLoader(docsDir);
  let html = MD.toHtml(md);
  html = html.replace(/<figure class="dx-chart dx-chart--csv" data-src="([^"]*)" data-csv="[^"]*">[\s\S]*?<\/figure>/g, (m, src) => {
    const text = src.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const p = CH.parse(text);
    return CH.toHtml(text, { csvText: p.pending ? load(p.pending) : false });
  });
  const mm = rendererDir ? path.join(rendererDir, 'aiondx-mermaid.min.js') : '';
  const kx = rendererDir ? path.join(rendererDir, 'aiondx-katex') : '';
  const has = (f) => f && fs.existsSync(f);
  return '<!doctype html><html><head><meta charset="utf-8"><title>drawing</title>' +
    (has(path.join(kx, 'katex.min.css')) ? '<link rel="stylesheet" href="' + pathToFileURL(path.join(kx, 'katex.min.css')).href + '">' : '') +
    '<style>' + LOOK_CSS + '</style></head><body class="aiondx-dx"><div class="dx-body" id="dx">' + html + '</div>' +
    (has(mm) ? '<script src="' + pathToFileURL(mm).href + '"></script>' : '') + (has(path.join(kx, 'katex.min.js')) ? '<script src="' + pathToFileURL(path.join(kx, 'katex.min.js')).href + '"></script>' : '') +
    '<script>(async function () {' +
    'try { document.querySelectorAll(".dx-math").forEach(function (el) { try { window.katex.render(el.getAttribute("data-tex") || "", el, { throwOnError: true, displayMode: el.classList.contains("dx-math--block"), trust: false, strict: "ignore" }); } catch (e) {} }); } catch (e) {}' +
    'try { if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", flowchart: { htmlLabels: false } }); var hs = document.querySelectorAll(".dx-mermaid"); for (var i = 0; i < hs.length; i++) { try { var o = await window.mermaid.render("dxl" + i, hs[i].getAttribute("data-src") || ""); hs[i].innerHTML = o.svg; hs[i].setAttribute("data-drawn", "1"); } catch (e) { hs[i].setAttribute("data-drawn", "bad"); } } } } catch (e) {}' +
    'var b = document.getElementById("dx"); var only = b.children.length === 1 && !/^H[1-6]$/.test(b.children[0].tagName); if (only) b.style.width = "720px";' +
    'document.title = "ready:" + Math.ceil(b.getBoundingClientRect().width) + "x" + Math.ceil(b.scrollHeight); })();</script></body></html>';
}
/** One request: drawn by capture(htmlFile) (the app's hidden window), answered in files. */
async function lookOne(dir, name, capture, rendererDir) {
  const base = path.join(dir, name.replace(/\.req\.json$/, ''));
  const done = (o) => { try { fs.writeFileSync(base + '.done.json', JSON.stringify(o)); } catch { /* the asker times out */ } };
  let req;
  try { req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return; }
  try { fs.unlinkSync(path.join(dir, name)); } catch { return; }   // taken (another window may race for it)
  try {
    const docsDir = path.resolve(String(req.docsDir || ''));
    if (path.basename(docsDir) !== D.DOCS_FOLDER) throw new Error('Only a doc in a DX Docs folder can be looked at.');
    const r = D.read(docsDir, String(req.doc || ''));
    const page = base + '.html';
    fs.writeFileSync(page, lookPage(r.markdown, req, docsDir, rendererDir));
    const shot = await capture(page);
    try { fs.unlinkSync(page); } catch { /* left for the sweep */ }
    fs.writeFileSync(base + '.png', shot.png);
    done({ ok: true, png: base + '.png', width: shot.width, height: shot.height });
  } catch (e) {
    done({ ok: false, error: String((e && e.message) || e) });
  }
}
/** Watch <userData>\dx-look for requests (and sweep answers over an hour old). Returns a stop function. */
function lookService(dir, capture, rendererDir) {
  fs.mkdirSync(dir, { recursive: true });
  let busy = false, again = false;
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          if (/\.req\.json$/.test(f)) await lookOne(dir, f, capture, rendererDir);
          else { try { if (now - fs.statSync(p).mtimeMs > 3600000) fs.unlinkSync(p); } catch { /* gone */ } }
        }
      } while (again);
    } catch { /* the next request tries again */ } finally { busy = false; }
  };
  let w = null;
  try { w = fs.watch(dir, { persistent: false }, (ev, f) => { if (f && /\.req\.json$/.test(String(f))) run(); }); } catch { w = null; }
  const t = setInterval(run, 3000);
  if (t.unref) t.unref();
  run();
  return () => { try { if (w) w.close(); } catch { /* closed */ } clearInterval(t); };
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
  const svc = create({ dataDir: () => app.getPath('userData'), shell, printPdf, nativeImage: electron.nativeImage });
  // looks: a hidden window that draws offscreen (nothing reaches the screen) at the page's own size, then its frame as a PNG
  const capture = async (page) => {
    const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: true, backgroundThrottling: false } });
    try {
      await w.loadFile(page);
      let size = null;
      for (let i = 0; i < 150 && !size; i++) {
        const m = /^ready:(\d+)x(\d+)$/.exec(w.webContents.getTitle());
        if (m) size = [+m[1], +m[2]]; else await new Promise((r) => setTimeout(r, 100));
      }
      if (!size) throw new Error('The doc did not finish drawing in 15 seconds.');
      const W = Math.min(1600, Math.max(200, size[0])), H = Math.min(6000, Math.max(80, size[1]));
      w.setContentSize(W, H);
      await new Promise((r) => setTimeout(r, 250));
      let img = await new Promise((resolve) => {
        const to = setTimeout(() => resolve(null), 4000);
        w.webContents.once('paint', (_e, _dirty, image) => { clearTimeout(to); resolve(image); });
        w.webContents.invalidate();
      });
      if (!img || img.isEmpty()) img = await w.webContents.capturePage();
      if (!img || img.isEmpty()) throw new Error('The drawing came out empty.');
      const sz = img.getSize();
      return { png: img.toPNG(), width: sz.width, height: sz.height };
    } finally { w.destroy(); }
  };
  try { lookService(path.join(app.getPath('userData'), 'dx-look'), capture, path.join(__dirname, '..', 'renderer')); } catch { /* looks are not available; the asker is told */ }
  ipcMain.handle('aiondx:dxdocs', async (event, req) => {
    try { return await svc.handle(req || {}, event.sender); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

module.exports = { install, create, exportAll, lookService, lookMarkdown, lookPage };
