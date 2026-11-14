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
  const doc = parse(fs.readFileSync(f, 'utf8'));
  const pending = doc.sections.filter((s) => pendingOf(s.body)).length;
  const comments = (readJson(path.join(docsDir, '.comments', id + '.json')) || []).filter((c) => !c.resolved).length;
  return { id, title: doc.title || id, path: f, modified: st.mtimeMs, sections: doc.sections.length, pending, openComments: comments };
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
  const doc = { title, lead: String((o && o.lead) || ''), sections: [] };
  for (const s of (o && o.sections) || []) {
    const heading = String(s.heading || '').trim();
    if (!heading) continue;
    const body = s.body ? String(s.body) : '<!-- aiondx:pending ' + String(s.intent || 'this section').replace(/-->/g, '- ->').trim() + ' -->';
    doc.sections.push({ heading, level: s.level || 2, body });
  }
  writeAtomic(docPath(docsDir, id), render(doc));
  wroteBy(docsDir, id, (o && o.by) || 'agent');
  return { id, path: docPath(docsDir, id), title };
}
function read(docsDir, id) {
  const f = docPath(docsDir, id);
  if (!fs.existsSync(f)) throw new Error('No doc "' + id + '" in ' + docsDir + '.');
  const markdown = fs.readFileSync(f, 'utf8');
  const doc = parse(markdown);
  return { id, path: f, title: doc.title, markdown, sections: doc.sections.map((s) => ({ heading: s.heading, level: s.level, pending: pendingOf(s.body), chars: s.body.length })) };
}
/** Apply operations in order, all or nothing; the version before is kept in the history. */
function update(docsDir, id, ops) {
  const f = docPath(docsDir, id);
  if (!fs.existsSync(f)) throw new Error('No doc "' + id + '" in ' + docsDir + '.');
  if (!Array.isArray(ops) || !ops.length) throw new Error('Give one or more operations.');
  const doc = parse(fs.readFileSync(f, 'utf8'));
  let body = null;
  const done = [];
  for (const op of ops) {
    const k = op && op.op;
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
      const find = String(op.find || '');
      if (!find) throw new Error('replace_text needs the text to find.');
      const text = render(doc);
      const count = text.split(find).length - 1;
      if (!count) throw new Error('The text to replace was not found: "' + find.slice(0, 80) + '".');
      if (count > 1 && !op.all) throw new Error('The text to replace occurs ' + count + ' times; give more of it, or "all": true.');
      const next = op.all ? text.split(find).join(String(op.replace || '')) : text.replace(find, () => String(op.replace || ''));
      const re = parse(next);
      doc.title = re.title; doc.lead = re.lead; doc.sections = re.sections;
    } else if (k === 'set_title') {
      doc.title = String(op.title || '').trim() || doc.title;
    } else if (k === 'set_lead') {
      doc.lead = String(op.body || '').trim();
    } else if (k === 'write') {
      body = String(op.markdown || '');
    } else {
      throw new Error('Unknown operation "' + k + '". Use replace_section, append_to_section, append_section, insert_after, rename_section, delete_section, replace_text, set_title, set_lead or write.');
    }
    done.push(k);
  }
  const text = body !== null ? body.replace(/\r\n/g, '\n') : render(doc);
  const bad = drawProblems(text);
  if (bad.length) throw new Error('Nothing was written: ' + bad.join('; ') + '. ' + CHART_HELP);
  const version = snapshot(docsDir, id);
  writeAtomic(f, text);
  wroteBy(docsDir, id, 'agent');
  return { id, path: f, done, previous: version, pending: parse(fs.readFileSync(f, 'utf8')).sections.filter((s) => pendingOf(s.body)).map((s) => s.heading) };
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
  comments, addComment, replyComment, slugOf, ID_RE, PENDING_RE };

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
      : cmd === 'read' ? read(docsDir, args.doc)
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
