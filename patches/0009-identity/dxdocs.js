'use strict';
// dxdocs.js (patches/0009-identity): DX Docs, AionDX's own living documents (R-121; spec ! LLM Files\2026-11-13_SPEC_DX-Docs.md).
//
// Claude Docs' behaviour, on the user's own disk, for any agent: an agent creates a doc as a skeleton (a heading per section, each section
// "pending" with what it will hold), then fills the sections one by one while the user watches it in the chat's right-hand sidebar; the
// user comments on a passage and the agent is told; every change keeps the version before it. No sign-in to anyone.
//
// A doc is <root>\DX Docs\<id>.md (Markdown). A pending section's body is the line <!-- aiondx:pending <intent> -->. Comments are in
// <root>\DX Docs\.comments\<id>.json; earlier versions in <root>\DX Docs\.history\<id>\<stamp>.md (the last 50). <root> is the project the chat is
// bound to in aiondx-projects.json, otherwise the chat's working folder.
//
// One library for both sides: the app's main process (aiondx-dxdocs-main.js) and the agents' commands and tools (the aiondx Loop tool runs
// this file as a command line: node dxdocs.js <command> --json <args>). Writes are atomic (a .tmp file renamed over the doc).

const fs = require('fs');
const path = require('path');
// charts (R-125): beside this file wherever it goes (patches, out/aiondx, the aiondx tool's bin folder)
const CHARTS = (() => { try { return require('./dxcharts.js'); } catch { return null; } })();
// tabs and the Markdown helpers both sides share (DX Docs mirror): beside this file too
const MD = require('./dxdocs-md.js');
// the diagram kinds the page's Mermaid (11.x) draws, by a block's first word
const MERMAID_KINDS = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie',
  'quadrantChart', 'requirementDiagram', 'gitGraph', 'mindmap', 'timeline', 'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'kanban',
  'architecture-beta', 'radar-beta', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment', 'zenuml', 'treemap-beta'];
/** What in a doc's Markdown cannot be drawn: chart blocks that do not read, mermaid blocks of an unknown kind. [] when all is well. */
function drawProblems(md) {
  const out = CHARTS ? CHARTS.check(md).map((p) => 'the chart at line ' + p.line + (p.section ? ' (section "' + p.section + '")' : '') + ': ' + p.error) : [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (h) { section = h[1]; continue; }
    const qb = /^(```|~~~)\s*(choice|approve)\s*$/.exec(lines[i]);
    if (qb) {
      let j = i + 1;
      const body = [];
      while (j < lines.length && lines[j].indexOf(qb[1]) !== 0) body.push(lines[j++]);
      const r = j >= lines.length ? { error: 'it has no closing ' + qb[1] } : MD.blockSpec(qb[2], body.join('\n'));
      if (r.error) out.push('the ' + (qb[2] === 'choice' ? 'question' : 'approval') + ' block at line ' + (i + 1) + (section ? ' (section "' + section + '")' : '') + ': ' + r.error +
        (qb[2] === 'choice' ? ' (a choice block is {"question":"...","options":["A","B"],"multi":false})' : ' (an approve block is {"label":"Approve the plan"})'));
      i = j;
      continue;
    }
    const f = /^(```|~~~)\s*mermaid\s*$/.exec(lines[i]);
    if (!f) continue;
    let j = i + 1, first = '';
    while (j < lines.length && lines[j].indexOf(f[1]) !== 0) { const t = lines[j].trim(); if (!first && t && !t.startsWith('%%') && t !== '---') first = t; j++; }
    if (j >= lines.length) out.push('the diagram at line ' + (i + 1) + (section ? ' (section "' + section + '")' : '') + ' has no closing ' + f[1]);
    else {
      const kind = (first.split(/[\s:]/)[0] || '');
      if (MERMAID_KINDS.indexOf(kind) < 0) out.push('the diagram at line ' + (i + 1) + (section ? ' (section "' + section + '")' : '') + ' starts with "' + kind.slice(0, 40) + '"; a mermaid block starts with its kind: ' + MERMAID_KINDS.slice(0, 18).join(', ') + ' ...');
    }
    i = j;
  }
  return out;
}
const CHART_HELP = 'A chart block is JSON, like {"type":"bar","title":"...","unit":"...","x":["Q1","Q2"],"series":[{"name":"2026","values":[3,5]}]} or {"type":"line","columns":["Month","Sales"],"rows":[["Jan",3],["Feb",5]]}; types: bar, stacked, hbar, line, area, pie, scatter.';

const PENDING_RE = /^<!--\s*aiondx:pending\s*([\s\S]*?)\s*-->\s*$/;
const HISTORY_KEEP = 50;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
// "DX Docs", not "Docs": Windows folder names ignore case, and many projects already keep their own documents in "docs"
const DOCS_FOLDER = 'DX Docs';

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}
function stamp(d) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}
function slugOf(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'doc';
}

/** Where a chat's docs live: its bound project's root, else its working folder. */
function resolveRoot(o) {
  const opts = o || {};
  let project = null, root = null;
  const reg = opts.dataDir ? readJson(path.join(opts.dataDir, 'aiondx-projects.json')) : null;
  if (reg) {
    const b = reg.bindings || {};
    const key = (opts.convId && b['conv:' + opts.convId]) || (opts.teamId && b['team:' + opts.teamId]) || null;
    const p = key && reg.projects && reg.projects[key];
    if (p && p.root && fs.existsSync(p.root)) { project = key; root = p.root; }
  }
  if (!root && opts.workspace && fs.existsSync(opts.workspace)) root = opts.workspace;
  if (!root) return null;
  return { root, project, docsDir: path.join(root, DOCS_FOLDER) };
}

// ---------------------------------------------------------------- the Markdown, as a title and sections

/** { title, lead, sections:[{heading, level, body}] }: lines up to the first heading below the title are the lead. Code fences are kept whole. */
function parse(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let title = '', i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^#\s+/.test(lines[i])) { title = lines[i].replace(/^#\s+/, '').trim(); i++; }
  const lead = [], sections = [];
  let cur = null, fence = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^(#{2,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { cur = { heading: h[2].trim(), level: h[1].length, body: [] }; sections.push(cur); continue; }
    (cur ? cur.body : lead).push(l);
  }
  const trimEnd = (a) => { while (a.length && !a[a.length - 1].trim()) a.pop(); return a; };
  const trimStart = (a) => { while (a.length && !a[0].trim()) a.shift(); return a; };
  for (const s of sections) s.body = trimStart(trimEnd(s.body)).join('\n');
  return { title, lead: trimStart(trimEnd(lead)).join('\n'), sections };
}
function render(doc) {
  const out = [];
  out.push('# ' + (doc.title || 'Untitled'), '');
  if (doc.lead) out.push(doc.lead, '');
  for (const s of doc.sections) {
    out.push('#'.repeat(Math.min(6, Math.max(2, s.level || 2))) + ' ' + s.heading, '');
    if (s.body) out.push(s.body, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}
function pendingOf(body) { const m = PENDING_RE.exec(String(body || '').trim()); return m ? m[1] || 'this section' : null; }
/** A tab's Markdown as a doc of its own (title, lead, sections), and back. */
function parseTab(T, tab) { return parse('# ' + (T.title || 'Untitled') + '\n\n' + (tab.body || '')); }
function bodyOf(doc) { return render({ title: 'x', lead: doc.lead, sections: doc.sections }).replace(/^# x\n\n?/, '').replace(/\n+$/, ''); }
/** Every section of every tab: [{ tab, heading, level, body }]. */
function allSections(md) {
  const T = MD.splitTabs(md);
  const out = [];
  for (const t of T.tabs) for (const s of parseTab(T, t).sections) out.push(Object.assign({ tab: t.implicit ? '' : t.id }, s));
  return out;
}
function tabNames(T) { return T.tabs.map((t) => '"' + t.title + '" (' + t.id + ')').join(', '); }
/** The tab an operation is for: its "tab" (id or title); a doc with one tab needs none. */
function pickTab(T, op) {
  if (op.tab != null && String(op.tab).trim()) {
    const t = MD.findTab(T, op.tab);
    if (!t) throw new Error('No tab "' + op.tab + '". Tabs: ' + (T.tabs[0].implicit ? 'none (this doc has no tabs; leave "tab" out, or add one with add_tab)' : tabNames(T)) + '.');
    return t;
  }
  if (T.tabs.length === 1) return T.tabs[0];
  throw new Error('This doc has tabs; say which one with "tab" (its id or title): ' + tabNames(T) + '.');
}
function newTabId(T) { let n = T.tabs.length + 1; const have = new Set(T.tabs.map((t) => t.id)); while (have.has('t' + n)) n++; return 't' + n; }
/** A doc with no tabs becomes one with a first tab holding what it had. */
function makeExplicit(T, firstTitle) {
  if (T.tabs.length === 1 && T.tabs[0].implicit) T.tabs = [{ id: 't1', title: String(firstTitle || 'Overview').trim() || 'Overview', parent: '', body: T.tabs[0].body }];
}
function subtreeIds(T, id) { const ids = [id]; for (let k = 0; k < ids.length; k++) for (const t of T.tabs) if (t.parent === ids[k]) ids.push(t.id); return ids; }
const TAB_OPS = ['add_tab', 'rename_tab', 'move_tab', 'delete_tab'];
function tabOp(T, op) {
  const k = op.op;
  if (k === 'add_tab') {
    const title = String(op.title || '').trim();
    if (!title) throw new Error('add_tab needs a "title".');
    makeExplicit(T, op.first_tab_title);
    const parent = op.parent ? MD.findTab(T, op.parent) : null;
    if (op.parent && !parent) throw new Error('No tab "' + op.parent + '" to put it under. Tabs: ' + tabNames(T) + '.');
    let body = op.body != null ? String(op.body).trim() : '';
    if (!body && Array.isArray(op.sections)) body = bodyOf({ lead: '', sections: op.sections.filter((s) => s && String(s.heading || '').trim()).map((s) => ({ heading: String(s.heading).trim(), level: s.level || 2,
      body: s.body ? String(s.body) : '<!-- aiondx:pending ' + String(s.intent || 'this section').replace(/-->/g, '- ->').trim() + ' -->' })) });
    const t = { id: newTabId(T), title, parent: parent ? parent.id : '', body };
    // after: a tab; else at the end of its parent's tabs (or the end of the doc)
    let at = T.tabs.length;
    const after = op.after ? MD.findTab(T, op.after) : null;
    if (op.after && !after) throw new Error('No tab "' + op.after + '" to put it after. Tabs: ' + tabNames(T) + '.');
    if (after) { const ids = subtreeIds(T, after.id); at = Math.max(...ids.map((id) => T.tabs.findIndex((x) => x.id === id))) + 1; }
    else if (parent) { const ids = subtreeIds(T, parent.id); at = Math.max(...ids.map((id) => T.tabs.findIndex((x) => x.id === id))) + 1; }
    T.tabs.splice(at, 0, t);
    return t.id;
  }
  if (T.tabs.length === 1 && T.tabs[0].implicit) throw new Error('This doc has no tabs yet; add one with add_tab.');
  const t = MD.findTab(T, op.tab);
  if (!t) throw new Error('No tab "' + (op.tab || '') + '". Tabs: ' + tabNames(T) + '.');
  if (k === 'rename_tab') { t.title = String(op.to || '').trim() || t.title; return t.id; }
  if (k === 'delete_tab') {
    const ids = subtreeIds(T, t.id);
    if (ids.length >= T.tabs.length) throw new Error('That would delete every tab; a doc keeps at least one.');
    T.tabs = T.tabs.filter((x) => ids.indexOf(x.id) < 0);
    return t.id;
  }
  if (k === 'move_tab') {
    // the tab moves with its sub-tabs: before or after another tab (taking that tab's parent), or under a parent (at its end), or to the top level
    const ids = subtreeIds(T, t.id);
    const block = T.tabs.filter((x) => ids.indexOf(x.id) >= 0);
    const rest = T.tabs.filter((x) => ids.indexOf(x.id) < 0);
    const ref = op.before || op.after;
    let at;
    if (ref) {
      const r = MD.findTab({ tabs: rest }, ref);
      if (!r) throw new Error('No tab "' + ref + '" to move it ' + (op.before ? 'before' : 'after') + ' (not itself or one of its own sub-tabs). Tabs: ' + tabNames(T) + '.');
      t.parent = r.parent;
      if (op.before) at = rest.indexOf(r);
      else { const rids = subtreeIds({ tabs: rest }, r.id); at = Math.max(...rids.map((id) => rest.findIndex((x) => x.id === id))) + 1; }
    } else if (op.parent !== undefined) {
      const p = op.parent ? MD.findTab({ tabs: rest }, op.parent) : null;
      if (op.parent && !p) throw new Error('No tab "' + op.parent + '" to move it under (not itself or one of its own sub-tabs).');
      t.parent = p ? p.id : '';
      if (p) { const pids = subtreeIds({ tabs: rest }, p.id); at = Math.max(...pids.map((id) => rest.findIndex((x) => x.id === id))) + 1; } else at = rest.length;
    } else throw new Error('move_tab needs "before", "after" or "parent" ("" for the top level).');
    rest.splice(at, 0, ...block);
    T.tabs = rest;
    return t.id;
  }
  throw new Error('Unknown tab operation "' + k + '".');
}
const norm = (h) => String(h || '').replace(/^#+\s*/, '').trim().toLowerCase();
function findSection(doc, heading) {
  const n = norm(heading);
  const i = doc.sections.findIndex((s) => norm(s.heading) === n);
  if (i < 0) throw new Error('No section "' + heading + '". Sections: ' + (doc.sections.map((s) => '"' + s.heading + '"').join(', ') || 'none') + '.');
  return i;
}
// a section's extent: its own body plus any deeper sections under it (a "replace" of a ## replaces its ### too only when asked)
function subtreeEnd(doc, i) { let j = i + 1; while (j < doc.sections.length && doc.sections[j].level > doc.sections[i].level) j++; return j; }

// ---------------------------------------------------------------- docs on disk

function docPath(docsDir, id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('A doc id is its file name without .md (letters, digits, dashes): got "' + id + '".');
  return path.join(docsDir, id + '.md');
}
function info(docsDir, id) {
  const f = docPath(docsDir, id);
  const st = fs.statSync(f);
  const md = fs.readFileSync(f, 'utf8');
  const T = MD.splitTabs(md);
  const secs = allSections(md);
  const pending = secs.filter((s) => pendingOf(s.body)).length;
  const comments = (readJson(path.join(docsDir, '.comments', id + '.json')) || []).filter((c) => !c.resolved).length;
  return { id, title: T.title || id, path: f, modified: st.mtimeMs, sections: secs.length, tabs: T.tabs[0].implicit ? 0 : T.tabs.length, pending, openComments: comments };
}
function list(docsDir) {
  if (!fs.existsSync(docsDir)) return [];
  return fs.readdirSync(docsDir).filter((f) => f.endsWith('.md') && ID_RE.test(f.slice(0, -3)))
    .map((f) => { try { return info(docsDir, f.slice(0, -3)); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.modified - a.modified);
}
/** Who wrote what (DX Docs mirror, step 2): { current: { by, at }, versions: { <version>: by } } beside the kept versions. */
function authorsFile(docsDir, id) { return path.join(docsDir, '.history', id, 'authors.json'); }
function readAuthors(docsDir, id) { try { const a = JSON.parse(fs.readFileSync(authorsFile(docsDir, id), 'utf8')); return a && typeof a === 'object' ? a : {}; } catch { return {}; } }
function writeAuthors(docsDir, id, a) { fs.mkdirSync(path.dirname(authorsFile(docsDir, id)), { recursive: true }); writeAtomic(authorsFile(docsDir, id), JSON.stringify(a, null, 1)); }
/** The doc as it now stands was written by `by` ('you', 'agent', or 'you (restored ...)'). */
function wroteBy(docsDir, id, by) { const a = readAuthors(docsDir, id); a.current = { by: String(by || 'agent').slice(0, 80), at: Date.now() }; writeAuthors(docsDir, id, a); }
function snapshot(docsDir, id) {
  const f = docPath(docsDir, id);
  if (!fs.existsSync(f)) return null;
  const dir = path.join(docsDir, '.history', id);
  fs.mkdirSync(dir, { recursive: true });
  const name = stamp(new Date()) + '.md';
  fs.copyFileSync(f, path.join(dir, name));
  { const a = readAuthors(docsDir, id); a.versions = a.versions || {}; a.versions[name.slice(0, -3)] = (a.current && a.current.by) || ''; writeAuthors(docsDir, id, a); }
  const all = fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) { try { fs.unlinkSync(path.join(dir, old)); } catch { /* next time */ } }
  return name.slice(0, -3);
}
function create(docsDir, o) {
  const title = String((o && o.title) || '').trim();
  if (!title) throw new Error('A doc needs a title.');
  let id = (o && o.id && ID_RE.test(o.id)) ? o.id : slugOf(title);
  for (let n = 2; fs.existsSync(path.join(docsDir, id + '.md')); n++) id = slugOf(title).slice(0, 56) + '-' + n;
  const skeleton = (secs) => {
    const out = [];
    for (const s of secs || []) {
      const heading = String((s && s.heading) || '').trim();
      if (!heading) continue;
      const body = s.body ? String(s.body) : '<!-- aiondx:pending ' + String(s.intent || 'this section').replace(/-->/g, '- ->').trim() + ' -->';
      out.push({ heading, level: s.level || 2, body });
    }
    return out;
  };
  let text;
  const tabs = Array.isArray(o && o.tabs) ? o.tabs.filter((t) => t && String(t.title || '').trim()) : [];
  if (tabs.length) {
    // a doc made with tabs: each tab its own skeleton; a tab may name an earlier tab as its parent
    const T = { title, tabs: [] };
    tabs.forEach((t, k) => {
      const parent = t.parent ? MD.findTab(T, t.parent) : null;
      T.tabs.push({ id: 't' + (k + 1), title: String(t.title).trim(), parent: parent ? parent.id : '', body: bodyOf({ lead: String(t.lead || ''), sections: skeleton(t.sections) }) });
    });
    if (o.lead || (o.sections && o.sections.length)) T.tabs[0].body = bodyOf({ lead: String(o.lead || ''), sections: skeleton(o.sections) }) + (T.tabs[0].body ? '\n\n' + T.tabs[0].body : '');
    text = MD.joinTabs(T);
  } else text = render({ title, lead: String((o && o.lead) || ''), sections: skeleton(o && o.sections) });
  writeAtomic(docPath(docsDir, id), text);
  wroteBy(docsDir, id, (o && o.by) || 'agent');
  return { id, path: docPath(docsDir, id), title };
}
/** A new title for the doc (its file name, the id, stays). */
function rename(docsDir, id, title, by) { return update(docsDir, id, [{ op: 'set_title', title }], by || 'you'); }
/** Delete: the doc, its comments, suggestions and versions go to DX Docs\.recycle\<id>-<stamp>\ (restorable; the last 50 deletions kept). */
function remove(docsDir, id, by) {
  const f = docPath(docsDir, id);
  if (!fs.existsSync(f)) throw new Error('No doc "' + id + '" in ' + docsDir + '.');
  const title = MD.splitTabs(fs.readFileSync(f, 'utf8')).title || id;
  const name = id + '--' + stamp(new Date());
  const bin = path.join(docsDir, '.recycle', name);
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(f, path.join(bin, id + '.md'));
  for (const [sub, file] of [['.comments', id + '.json'], ['.suggestions', id + '.json'], ['.history', id]]) {
    const from = path.join(docsDir, sub, file);
    if (fs.existsSync(from)) { fs.mkdirSync(path.join(bin, sub), { recursive: true }); fs.renameSync(from, path.join(bin, sub, file)); }
  }
  writeAtomic(path.join(bin, 'deleted.json'), JSON.stringify({ id, title, at: Date.now(), by: String(by || 'you').slice(0, 80) }, null, 1));
  const all = fs.readdirSync(path.join(docsDir, '.recycle')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) { try { fs.rmSync(path.join(docsDir, '.recycle', old), { recursive: true, force: true }); } catch { /* next time */ } }
  return { id, deleted: name };
}
/** The deleted docs, newest first: [{ deleted, id, title, at, by }]. */
function recycled(docsDir) {
  const dir = path.join(docsDir, '.recycle');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => { const m = readJson(path.join(dir, name, 'deleted.json')); return m ? Object.assign({ deleted: name }, m) : null; })
    .filter(Boolean).sort((a, b) => b.at - a.at);
}
/** A deleted doc back, under its own id (or id-2 and so on when that is taken). */
function undelete(docsDir, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}--[0-9-]+$/.test(String(name || ''))) throw new Error('Which deleted doc?');
  const bin = path.join(docsDir, '.recycle', name);
  const m = readJson(path.join(bin, 'deleted.json'));
  if (!m) throw new Error('That deleted doc is not in the recycle folder.');
  let id = m.id;
  for (let n = 2; fs.existsSync(path.join(docsDir, id + '.md')); n++) id = m.id.slice(0, 74) + '-' + n;
  fs.renameSync(path.join(bin, m.id + '.md'), path.join(docsDir, id + '.md'));
  for (const [sub, file, to] of [['.comments', m.id + '.json', id + '.json'], ['.suggestions', m.id + '.json', id + '.json'], ['.history', m.id, id]]) {
    const from = path.join(bin, sub, file);
    if (fs.existsSync(from)) { fs.mkdirSync(path.join(docsDir, sub), { recursive: true }); fs.renameSync(from, path.join(docsDir, sub, to)); }
  }
  fs.rmSync(bin, { recursive: true, force: true });
  return { id, title: m.title };
}
/** The doc: its Markdown and sections; with tabs, each tab with its sections. o.tab: that tab's own Markdown too (its view). */
function read(docsDir, id, o) {
  const f = docPath(docsDir, id);
  if (!fs.existsSync(f)) throw new Error('No doc "' + id + '" in ' + docsDir + '.');
  const markdown = fs.readFileSync(f, 'utf8');
  const T = MD.splitTabs(markdown);
  const secs = (t) => parseTab(T, t).sections.map((s) => ({ heading: s.heading, level: s.level, pending: pendingOf(s.body), chars: s.body.length }));
  const out = { id, path: f, title: T.title, markdown, sections: allSections(markdown).map((s) => Object.assign({ heading: s.heading, level: s.level, pending: pendingOf(s.body), chars: s.body.length }, s.tab ? { tab: s.tab } : {})) };
  if (!T.tabs[0].implicit) out.tabs = T.tabs.map((t) => ({ id: t.id, title: t.title, parent: t.parent || '', sections: secs(t) }));
  if (o && o.tab != null && String(o.tab).trim()) {
    const t = MD.findTab(T, o.tab);
    if (!t) throw new Error('No tab "' + o.tab + '". Tabs: ' + (T.tabs[0].implicit ? 'none' : tabNames(T)) + '.');
    out.tab = { id: t.id, title: t.title, parent: t.parent || '', markdown: MD.tabView(markdown, t.id) };
  }
  return out;
}
/** Apply operations in order, all or nothing; the version before is kept in the history. With tabs, each section operation names its tab. */
function update(docsDir, id, ops, by) {
  const f = docPath(docsDir, id);
  if (!fs.existsSync(f)) throw new Error('No doc "' + id + '" in ' + docsDir + '.');
  if (!Array.isArray(ops) || !ops.length) throw new Error('Give one or more operations.');
  let T = MD.splitTabs(fs.readFileSync(f, 'utf8'));
  const done = [];
  const tabsMade = [];
  for (const op of ops) {
    const k = op && op.op;
    if (TAB_OPS.indexOf(k) >= 0) { const tid = tabOp(T, op); if (k === 'add_tab') tabsMade.push(tid); done.push(k); continue; }
    if (k === 'set_title') { T.title = String(op.title || '').trim() || T.title; done.push(k); continue; }
    if (k === 'write' && !(op.tab != null && String(op.tab).trim())) { T = MD.splitTabs(String(op.markdown || '').replace(/\r\n/g, '\n')); done.push(k); continue; }
    if (k === 'replace_text' && !(op.tab != null && String(op.tab).trim())) {
      const find = String(op.find || '');
      if (!find) throw new Error('replace_text needs the text to find.');
      const text = MD.joinTabs(T);
      const count = text.split(find).length - 1;
      if (!count) throw new Error('The text to replace was not found: "' + find.slice(0, 80) + '".');
      if (count > 1 && !op.all) throw new Error('The text to replace occurs ' + count + ' times; give more of it, or "all": true.');
      T = MD.splitTabs(op.all ? text.split(find).join(String(op.replace || '')) : text.replace(find, () => String(op.replace || '')));
      done.push(k);
      continue;
    }
    if (['replace_section', 'append_section', 'insert_after', 'append_to_section', 'rename_section', 'delete_section', 'replace_text', 'set_lead', 'write'].indexOf(k) < 0) {
      throw new Error('Unknown operation "' + k + '". Use replace_section, append_to_section, append_section, insert_after, rename_section, delete_section, replace_text, set_title, set_lead or write; ' +
        'for tabs add_tab, rename_tab, move_tab, delete_tab, and "tab" (an id or title) on any section operation.');
    }
    const tab = pickTab(T, op);
    const doc = parseTab(T, tab);
    let body = null;
    if (k === 'replace_section') {
      const i = findSection(doc, op.heading);
      doc.sections[i].body = String(op.body || '').trim();
      if (op.with_subsections) doc.sections.splice(i + 1, subtreeEnd(doc, i) - i - 1);
    } else if (k === 'append_section') {
      doc.sections.push({ heading: String(op.heading || '').trim() || 'New section', level: op.level || 2, body: String(op.body || '').trim() });
    } else if (k === 'insert_after') {
      const i = findSection(doc, op.after);
      doc.sections.splice(subtreeEnd(doc, i), 0, { heading: String(op.heading || '').trim() || 'New section', level: op.level || doc.sections[i].level, body: String(op.body || '').trim() });
    } else if (k === 'append_to_section') {
      const i = findSection(doc, op.heading);
      const cur = pendingOf(doc.sections[i].body) ? '' : doc.sections[i].body;
      doc.sections[i].body = (cur ? cur + '\n\n' : '') + String(op.body || '').trim();
    } else if (k === 'rename_section') {
      const i = findSection(doc, op.heading);
      doc.sections[i].heading = String(op.to || '').trim() || doc.sections[i].heading;
    } else if (k === 'delete_section') {
      const i = findSection(doc, op.heading);
      doc.sections.splice(i, subtreeEnd(doc, i) - i);
    } else if (k === 'replace_text') {
      // within one tab ("tab" given)
      const find = String(op.find || '');
      if (!find) throw new Error('replace_text needs the text to find.');
      const text = bodyOf(doc);
      const count = text.split(find).length - 1;
      if (!count) throw new Error('The text to replace was not found in tab "' + tab.title + '": "' + find.slice(0, 80) + '".');
      if (count > 1 && !op.all) throw new Error('The text to replace occurs ' + count + ' times in that tab; give more of it, or "all": true.');
      body = op.all ? text.split(find).join(String(op.replace || '')) : text.replace(find, () => String(op.replace || ''));
    } else if (k === 'set_lead') {
      doc.lead = String(op.body || '').trim();
    } else if (k === 'write') {
      // one tab's whole Markdown ("tab" given); a title line at its top is the doc's title
      const v = MD.splitTabs(String(op.markdown || '').replace(/\r\n/g, '\n'));
      if (v.title) T.title = v.title;
      body = v.tabs.map((x) => x.body).filter(Boolean).join('\n\n');
    } else {
      throw new Error('Unknown operation "' + k + '". Use replace_section, append_to_section, append_section, insert_after, rename_section, delete_section, replace_text, set_title, set_lead or write; ' +
        'for tabs add_tab, rename_tab, move_tab, delete_tab, and "tab" on any section operation.');
    }
    tab.body = body !== null ? body.trim() : bodyOf(doc);
    done.push(k);
  }
  const text = MD.joinTabs(T);
  const bad = drawProblems(text);
  if (bad.length) throw new Error('Nothing was written: ' + bad.join('; ') + '. ' + CHART_HELP);
  const version = snapshot(docsDir, id);
  writeAtomic(f, text);
  wroteBy(docsDir, id, by || 'agent');
  const secs = allSections(fs.readFileSync(f, 'utf8'));
  const out = { id, path: f, done, previous: version, pending: secs.filter((s) => pendingOf(s.body)).map((s) => s.heading) };
  if (tabsMade.length) out.tabs_added = tabsMade;
  return out;
}
/** The user's own edit from the sidebar: the whole Markdown, the version before kept. */
function save(docsDir, id, markdown, by) {
  const previous = snapshot(docsDir, id);
  writeAtomic(docPath(docsDir, id), String(markdown || '').replace(/\r\n/g, '\n'));
  wroteBy(docsDir, id, by || 'you');
  return { id, previous };
}
function history(docsDir, id) {
  docPath(docsDir, id);
  const dir = path.join(docsDir, '.history', id);
  if (!fs.existsSync(dir)) return [];
  const who = readAuthors(docsDir, id).versions || {};
  return fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort().reverse().map((x) => {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(x);
    return { version: x.slice(0, -3), at: m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0, by: who[x.slice(0, -3)] || '' };
  });
}
function readVersion(docsDir, id, version) {
  if (!/^[0-9-]+$/.test(String(version || ''))) throw new Error('Which version?');
  return fs.readFileSync(path.join(docsDir, '.history', id, version + '.md'), 'utf8');
}
function restore(docsDir, id, version) { return save(docsDir, id, readVersion(docsDir, id, version), 'you (restored an earlier version)'); }
/** Who wrote the doc as it stands, and when. */
function author(docsDir, id) { const a = readAuthors(docsDir, id); return a.current || null; }

// ---------------------------------------------------------------- comments

// ---- suggestions (DX Docs mirror, step 3): proposed changes the user accepts or rejects; the doc is untouched until then
function suggestionsFile(docsDir, id) { docPath(docsDir, id); return path.join(docsDir, '.suggestions', id + '.json'); }
function readSuggestions(docsDir, id) { try { const a = JSON.parse(fs.readFileSync(suggestionsFile(docsDir, id), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeSuggestions(docsDir, id, all) { fs.mkdirSync(path.dirname(suggestionsFile(docsDir, id)), { recursive: true }); writeAtomic(suggestionsFile(docsDir, id), JSON.stringify(all, null, 1)); }
function countOf(text, find) { return find ? String(text).split(find).length - 1 : 0; }
/** An agent proposes: these words (find, as they stand in the doc, once) become these (replace; '' deletes them). */
function suggest(docsDir, id, o) {
  const md = fs.readFileSync(docPath(docsDir, id), 'utf8');
  const find = String((o && o.find) || ''), replace = String((o && o.replace) == null ? '' : o.replace);
  if (!find) throw new Error('A suggestion needs "find": the words as they stand in the doc.');
  if (find === replace) throw new Error('"replace" is the same as "find": nothing would change.');
  const n = countOf(md, find);
  if (!n) throw new Error('The words to change were not found in the doc: "' + find.slice(0, 80) + '". Quote them exactly as they stand (dxdoc_read shows the doc).');
  if (n > 1) throw new Error('Those words occur ' + n + ' times; quote more of them so they occur once.');
  const bad = drawProblems(md.replace(find, () => replace));
  if (bad.length) throw new Error('Nothing was suggested: ' + bad.join('; ') + '. ' + CHART_HELP);
  const all = readSuggestions(docsDir, id);
  const s = { id: 's' + (all.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1), find, replace, note: String((o && o.note) || '').slice(0, 2000),
    by: String((o && o.by) || 'agent').slice(0, 80), at: Date.now(), status: 'open' };
  all.push(s);
  writeSuggestions(docsDir, id, all);
  return { suggestion: s };
}
/** The open suggestions; one whose words are no longer in the doc (or no longer once) is marked stale. */
function suggestions(docsDir, id) {
  const md = fs.existsSync(docPath(docsDir, id)) ? fs.readFileSync(docPath(docsDir, id), 'utf8') : '';
  return readSuggestions(docsDir, id).filter((s) => s.status === 'open').map((s) => Object.assign({}, s, { stale: countOf(md, s.find) !== 1 }));
}
/** accept (applies it, a version kept), reject (the user says no), withdraw (the agent takes it back). */
function decide(docsDir, id, sid, verdict, by) {
  const all = readSuggestions(docsDir, id);
  const s = all.find((x) => x.id === sid && x.status === 'open');
  if (!s) throw new Error('No open suggestion "' + sid + '" on that doc.');
  if (['accept', 'reject', 'withdraw'].indexOf(verdict) < 0) throw new Error('verdict: accept, reject or withdraw.');
  let saved = null;
  if (verdict === 'accept') {
    const md = fs.readFileSync(docPath(docsDir, id), 'utf8');
    const n = countOf(md, s.find);
    if (n !== 1) throw new Error(n ? 'The words it changes now occur ' + n + ' times; it cannot be applied as it is.' : 'The words it changes are no longer in the doc; it cannot be applied.');
    saved = save(docsDir, id, md.replace(s.find, () => s.replace), (s.by === 'agent' ? 'the agent' : s.by) + ', accepted by ' + (by || 'you'));
  }
  s.status = verdict === 'accept' ? 'accepted' : verdict === 'reject' ? 'rejected' : 'withdrawn';
  s.decidedAt = Date.now(); s.decidedBy = verdict === 'withdraw' ? s.by : (by || 'you');
  writeSuggestions(docsDir, id, all);
  return { suggestion: s, saved };
}
function commentsFile(docsDir, id) { docPath(docsDir, id); return path.join(docsDir, '.comments', id + '.json'); }
function comments(docsDir, id) { return readJson(commentsFile(docsDir, id)) || []; }
function addComment(docsDir, id, o) {
  const text = String((o && o.text) || '').trim();
  if (!text) throw new Error('A comment needs some text.');
  const all = comments(docsDir, id);
  const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), by: String((o && o.by) || 'user'),
    quote: String((o && o.quote) || '').slice(0, 2000), section: String((o && o.section) || ''), text, replies: [], resolved: false };
  if (o && o.tab) c.tab = String(o.tab).slice(0, 80);
  all.push(c);
  writeAtomic(commentsFile(docsDir, id), JSON.stringify(all, null, 2));
  return c;
}
function replyComment(docsDir, id, commentId, o) {
  const all = comments(docsDir, id);
  const c = all.find((x) => x.id === commentId);
  if (!c) throw new Error('No comment "' + commentId + '" on "' + id + '".');
  const text = String((o && o.text) || '').trim();
  if (text) c.replies.push({ at: Date.now(), by: String((o && o.by) || 'agent'), text });
  if (o && o.resolve !== undefined) c.resolved = !!o.resolve;
  writeAtomic(commentsFile(docsDir, id), JSON.stringify(all, null, 2));
  return c;
}

module.exports = { suggest, suggestions, decide, author, drawProblems, DOCS_FOLDER, resolveRoot, parse, render, pendingOf, list, info, create, read, update, save, history, readVersion, restore,
  comments, addComment, replyComment, slugOf, ID_RE, PENDING_RE, rename, remove, recycled, undelete, allSections, MD };

// ---------------------------------------------------------------- command line: node dxdocs.js <command> --json '<args>' | --json-file F
// Every command needs where the docs are: --docs-dir DIR, or --data-dir DIR --conv ID [--team ID] --workspace DIR. Prints one JSON answer.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const done = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(code || 0); };
  try {
    let args = {};
    if (opt('--json-file')) args = JSON.parse(fs.readFileSync(opt('--json-file'), 'utf8'));
    else if (opt('--json')) args = JSON.parse(opt('--json'));
    let docsDir = opt('--docs-dir');
    let where = null;
    if (!docsDir) {
      where = resolveRoot({ dataDir: opt('--data-dir'), convId: opt('--conv'), teamId: opt('--team'), workspace: opt('--workspace') });
      if (!where) done({ ok: false, error: 'No folder for docs: the chat has no project and no working folder.' }, 1);
      docsDir = where.docsDir;
    }
    const r = cmd === 'where' ? { docsDir, root: where && where.root, project: where && where.project }
      : cmd === 'list' ? { docs: list(docsDir) }
      : cmd === 'create' ? create(docsDir, args)
      : cmd === 'read' ? read(docsDir, args.doc, { tab: args.tab })
      : cmd === 'update' ? update(docsDir, args.doc, args.ops)
      : cmd === 'comments' ? { comments: comments(docsDir, args.doc) }
      : cmd === 'reply' ? replyComment(docsDir, args.doc, args.comment, { text: args.text, resolve: args.resolve, by: args.by || 'agent' })
      : cmd === 'history' ? { versions: history(docsDir, args.doc) }
      : cmd === 'suggest' ? suggest(docsDir, args.doc, { find: args.find, replace: args.replace, note: args.note, by: args.by || 'agent' })
      : cmd === 'suggestions' ? { suggestions: suggestions(docsDir, args.doc) }
      : cmd === 'withdraw' ? decide(docsDir, args.doc, args.suggestion, 'withdraw', 'agent')
      : null;
    if (!r) done({ ok: false, error: 'Commands: where, list, create, read, update, comments, reply, history, suggest, suggestions, withdraw.' }, 2);
    done(Object.assign({ ok: true, docsDir }, r));
  } catch (e) {
    done({ ok: false, error: e.message }, 1);
  }
}
