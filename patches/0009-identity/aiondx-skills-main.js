'use strict';
/**
 * aiondx-skills-main.js - a chat's skills, for the Skills panel (R-128 step 3, November 15th, 2026). The user: "skills should be easy as
 * shit for you to employ, build, and continually iterate on", "can you make sure we have the very best skills integration for agents of any
 * AI-UI out there?".
 *
 * IPC aiondx:skills, ops:
 *   list {conv, ws, team, teamName}   every skill the chat has: name, what it is for, its layer (yours, shared, the project's, AionDX's),
 *                                     its folder, its switch, whether it is pinned, how often this chat used it and when last, and what it
 *                                     costs in context (characters / 4, the description alone, or the whole skill when pinned)
 *   set {ws, name, state}             the switch, written where Claude Code reads it for this chat: skillOverrides in
 *                                     <working folder>\.claude\settings.local.json ("on", "name-only", "user-invocable-only", "off")
 *   pin {key, name, on}               pinned: the whole skill given to the agent at its start (key "c:<conversation>" or "t:<team>")
 *   pins {}                           the pins record
 * Pins live in <userData>\aiondx-skill-pins.json = { "c:<id>": [names], "t:<id>": [names] }; AionDX's Claude launcher adds each pinned
 * skill's text to the system prompt argument at launch (claude-account-router.js pinnedSkills).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');

const STATES = ['on', 'name-only', 'user-invocable-only', 'off'];
const mangle = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); }

/** A SKILL.md's front matter: name and description (YAML's plain and quoted one-line values, and a folded or literal block). */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) {   // a block: the indented lines after it
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(v.charAt(0) === '>' ? ' ' : '\n');
    } else v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    out[kv[1]] = v;
  }
  return out;
}

/** The skill folders of one layer: each folder holding SKILL.md. */
function skillsIn(dir, layer) {
  const out = [];
  let es = [];
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (!e.isDirectory()) continue;
    const d = path.join(dir, e.name);
    let text = null;
    try { text = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'); } catch { continue; }
    const fm = frontMatter(text);
    out.push({ name: fm.name || e.name, folder: e.name, description: String(fm.description || '').slice(0, 600), layer, dir: d, size: text.length,
      userOnly: fm['disable-model-invocation'] === 'true', agentOnly: fm['user-invocable'] === 'false' });
  }
  return out;
}

/** The layers of a chat, lowest first (the same ones the Claude launcher and AionCore's mirror use), with AionDX's own skills first. */
function layersFor(ctx) {
  const L = [];
  if (ctx.builtinDir) L.push({ dir: ctx.builtinDir, layer: { kind: 'aiondx', label: 'AionDX' } });
  L.push({ dir: path.join(ctx.home, '.claude', 'skills'), layer: { kind: 'yours', label: 'Yours' } });
  const reg = readJson(path.join(ctx.userData, 'aiondx-projects.json')) || {};
  for (const r of Array.isArray(reg.skillRoots) ? reg.skillRoots : []) if (typeof r === 'string' && r) L.push({ dir: path.join(r, '.claude', 'skills'), layer: { kind: 'shared', label: 'Shared' } });
  const b = reg.bindings || {};
  let name = (ctx.conv && b['conv:' + ctx.conv]) || (ctx.team && b['team:' + ctx.team]) || null;
  if (!name && ctx.teamName && reg.projects) {
    const words = String(ctx.teamName).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['team', 'dev', 'development'].includes(w));
    let best = null, score = 0, tie = false;
    for (const [k, p] of Object.entries(reg.projects)) {
      const hay = String(p && p.root ? path.basename(p.root) : k).toLowerCase();
      const s = words.filter((w) => hay.includes(w)).length;
      if (s > score) { best = k; score = s; tie = false; } else if (s && s === score) tie = true;
    }
    if (best && !tie) name = best;
  }
  const proj = name && reg.projects && reg.projects[name];
  if (proj && proj.root) L.push({ dir: path.join(proj.root, '.claude', 'skills'), layer: { kind: 'project', label: path.basename(proj.root), project: name } });
  // The chat's own folder and every folder above it: Claude Code reads .claude\skills in each, so the agent has those skills too (November
  // 17th, 2026: chats kept under a client's folder had its 13 skills and used them, and this list showed none). The farthest first, so the
  // nearest wins a name; your home folder is the Yours layer already.
  if (ctx.ws && path.isAbsolute(ctx.ws)) {
    const key = (d) => path.resolve(d).toLowerCase();
    const seen = new Set(L.map((l) => key(l.dir)));
    const homes = new Set([key(ctx.home), key(os.homedir())]);
    const ups = [];
    let d = path.resolve(ctx.ws);
    for (let i = 0; i < 40; i++) { ups.push(d); const p = path.dirname(d); if (p === d) break; d = p; }
    for (const a of ups.reverse()) {
      const dir = path.join(a, '.claude', 'skills');
      if (homes.has(key(a)) || seen.has(key(dir))) continue;
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* none here */ }
      if (!isDir) continue;
      seen.add(key(dir));
      L.push({ dir, layer: { kind: 'folder', label: path.basename(a) || a } });
    }
  }
  return L;
}

const USE_RE = /"name":"Skill","input":\{"skill":"([^"]+)"|<command-name>\/([A-Za-z0-9:_-]+)<\/command-name>|"name":"Read","input":\{"file_path":"[^"]*?[\\/]skills[\\/]+([^"\\/]+)[\\/]+SKILL\.md"/g;
function countUses(line, counts) {
  if (line.indexOf('"Skill"') < 0 && line.indexOf('<command-name>') < 0 && line.indexOf('SKILL.md') < 0) return;
  USE_RE.lastIndex = 0;
  let m;
  while ((m = USE_RE.exec(line))) {
    const name = String(m[1] || m[2] || m[3]).replace(/^[a-z0-9-]+:/i, '');
    const ts = (/"timestamp":"([^"]+)"/.exec(line) || [])[1];
    const u = counts[name] || (counts[name] = { n: 0, last: null });
    u.n++;
    if (ts && (!u.last || ts > u.last)) u.last = ts;
  }
}
// Each transcript is read once and then only what was added to it: a long chat's transcript runs to hundreds of MB (November 17th, 2026:
// 457 MB, and files over 60 MB used to be skipped, so its skills showed no uses). A first read that runs out of time goes on next time.
const useScans = new Map();   // file -> { offset, tail, dec, counts }
function scanUses(file, deadline) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let c = useScans.get(file);
  if (!c || st.size < c.offset) { c = { offset: 0, tail: '', dec: new StringDecoder('utf8'), counts: {} }; useScans.set(file, c); }
  if (c.offset >= st.size) return withTail(c);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return c.counts; }
  try {
    const buf = Buffer.alloc(8 * 1048576);
    while (c.offset < st.size && Date.now() < deadline) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - c.offset), c.offset);
      if (n <= 0) break;
      c.offset += n;
      const lines = (c.tail + c.dec.write(buf.subarray(0, n))).split('\n');
      c.tail = lines.pop();
      for (const line of lines) countUses(line, c.counts);
    }
  } catch { /* what was read so far stands */ } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
  return withTail(c);
}
/** The counts with the file's last line too, which has no newline yet: counted for this answer only, so it is not counted twice once it ends. */
function withTail(c) {
  if (!c.tail) return c.counts;
  const t = {};
  countUses(c.tail, t);
  if (!Object.keys(t).length) return c.counts;
  const out = {};
  for (const [k, v] of Object.entries(c.counts)) out[k] = { n: v.n, last: v.last };
  for (const [k, v] of Object.entries(t)) {
    const u = out[k] || (out[k] = { n: 0, last: null });
    u.n += v.n;
    if (v.last && (!u.last || v.last > u.last)) u.last = v.last;
  }
  return out;
}

/** This chat's uses of each skill, from Claude Code's transcripts of its working folder (every Claude config folder). Bounded. */
function usesFor(home, ws) {
  const uses = {};
  if (!ws) return uses;
  let cfgs = [];
  try { cfgs = fs.readdirSync(home).filter((n) => /^\.claude(-[A-Za-z0-9_]+)?$/.test(n)); } catch { return uses; }
  const deadline = Date.now() + 4000;
  for (const c of cfgs) {
    const dir = path.join(home, c, 'projects', mangle(ws));
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const counts = scanUses(path.join(dir, f), deadline);
      for (const [name, v] of Object.entries(counts || {})) {
        const u = uses[name] || (uses[name] = { n: 0, last: null });
        u.n += v.n;
        if (v.last && (!u.last || v.last > u.last)) u.last = v.last;
      }
    }
  }
  return uses;
}

function overridesOf(ws) { const s = ws ? readJson(path.join(ws, '.claude', 'settings.local.json')) : null; return (s && s.skillOverrides && typeof s.skillOverrides === 'object') ? s.skillOverrides : {}; }

function list(ctx) {
  const pins = readJson(path.join(ctx.userData, 'aiondx-skill-pins.json')) || {};
  const pinned = new Set([].concat(pins['c:' + ctx.conv] || [], ctx.team ? pins['t:' + ctx.team] || [] : []));
  const teamPinned = new Set(ctx.team ? pins['t:' + ctx.team] || [] : []);
  const over = overridesOf(ctx.ws);
  const uses = usesFor(ctx.home, ctx.ws);
  const byName = new Map();
  for (const l of layersFor(ctx)) for (const s of skillsIn(l.dir, l.layer)) {
    const had = byName.get(s.name);
    s.shadows = had ? had.layer.label : null;   // a nearer layer's skill of the same name wins
    byName.set(s.name, s);
  }
  const skills = [...byName.values()].map((s) => {
    const u = uses[s.name] || uses[s.folder] || { n: 0, last: null };
    const on = pinned.has(s.name);
    return Object.assign(s, { state: STATES.includes(over[s.name]) ? over[s.name] : 'on', pinned: on, teamPinned: teamPinned.has(s.name), uses: u.n, lastUsed: u.last,
      cost: Math.round((on ? s.size : (s.name.length + s.description.length + 20)) / 4) });
  }).sort((a, b) => (b.pinned - a.pinned) || (b.uses - a.uses) || a.name.localeCompare(b.name));
  return { ok: true, skills, total: skills.length, used: skills.filter((s) => s.uses).length, cost: skills.filter((s) => s.state === 'on' || s.pinned).reduce((n, s) => n + s.cost, 0) };
}

function setState(ws, name, state) {
  if (!ws || !path.isAbsolute(ws)) return { ok: false, error: 'This chat has no working folder.' };
  if (!STATES.includes(state)) return { ok: false, error: 'A switch is on, name only, you only, or off.' };
  if (!/^[A-Za-z0-9:_.-]{1,80}$/.test(String(name || ''))) return { ok: false, error: 'Which skill?' };
  const f = path.join(ws, '.claude', 'settings.local.json');
  const s = readJson(f) || {};
  s.skillOverrides = s.skillOverrides && typeof s.skillOverrides === 'object' ? s.skillOverrides : {};
  if (state === 'on') delete s.skillOverrides[name]; else s.skillOverrides[name] = state;
  if (!Object.keys(s.skillOverrides).length) delete s.skillOverrides;
  writeJson(f, s);
  return { ok: true, state };
}

function setPin(userData, key, name, on) {
  if (!/^[ct]:[A-Za-z0-9_-]{1,80}$/.test(String(key || ''))) return { ok: false, error: 'Which chat or team?' };
  if (!/^[A-Za-z0-9:_.-]{1,80}$/.test(String(name || ''))) return { ok: false, error: 'Which skill?' };
  const f = path.join(userData, 'aiondx-skill-pins.json');
  const p = readJson(f) || {};
  const l = new Set(p[key] || []);
  if (on) l.add(name); else l.delete(name);
  if (l.size) p[key] = [...l].sort(); else delete p[key];
  writeJson(f, p);
  return { ok: true, pins: p[key] || [] };
}

const notesDir = () => process.env.AIONDX_REQUEST_NOTES_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'AionDX', 'request-notes');
/** The newest request notes, newest first, each with the user's mark (fit, did not fit) if any, and counts by group. */
function notesList(dir, limit) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(dir, 'review.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* none yet */ }
  const marks = readJson(path.join(dir, 'marks.json')) || {};
  const all = [];
  for (const l of lines) { try { all.push(JSON.parse(l)); } catch { /* a torn line */ } }
  const counts = {};
  for (const e of all) { const k = e.group + ':' + e.note; counts[k] = (counts[k] || 0) + 1; }
  const fit = Object.values(marks).filter((v) => v === true).length, miss = Object.values(marks).filter((v) => v === false).length;
  const items = all.slice(-Math.max(1, Math.min(1000, limit))).reverse().map((e) => Object.assign({}, e, { fit: marks[String(e.at)] === undefined ? null : marks[String(e.at)] }));
  return { ok: true, dir, total: all.length, counts, marked: { fit, miss }, items };
}
function notesMark(dir, at, fit) {
  if (!Number.isFinite(at) || at <= 0) return { ok: false, error: 'Which note?' };
  const f = path.join(dir, 'marks.json');
  const m = readJson(f) || {};
  if (fit === null) delete m[String(at)]; else m[String(at)] = fit;
  fs.mkdirSync(dir, { recursive: true });
  writeJson(f, m);
  return { ok: true, at, fit };
}

function install(electron, opts) {
  const o = opts || {};
  const userData = () => o.userData || electron.app.getPath('userData');
  const home = () => process.env.AIONDX_SKILLS_HOME || os.homedir();
  const builtin = () => path.join(userData(), 'aionui', 'builtin-skills', 'auto-inject');
  electron.ipcMain.handle('aiondx:skills', async (_e, req) => {
    try {
      const op = req && req.op;
      if (op === 'list') return list({ conv: String(req.conv || ''), ws: String(req.ws || ''), team: req.team ? String(req.team) : null, teamName: req.teamName || null, home: home(), userData: userData(), builtinDir: builtin() });
      if (op === 'set') return setState(String(req.ws || ''), req.name, req.state);
      if (op === 'pin') return setPin(userData(), req.key, req.name, !!req.on);
      // request notes (P-012): the user's review list, read from this PC's own folder only (%LOCALAPPDATA%\AionDX\request-notes; the
      // planning hook writes it); marks are kept beside it. Nothing here goes into a package, an export or a profile copy.
      if (op === 'notesList') return notesList(notesDir(), Number(req.limit) || 200);
      if (op === 'notesMark') return notesMark(notesDir(), Number(req.at), req.fit === true ? true : req.fit === false ? false : null);
      // agents' skill changes: reviewed first, or applied (November 16th, 2026); read by the loop tool's skills propose
      if (op === 'reviewGet') { const j = readJson(path.join(userData(), 'aiondx-skills.json')) || {}; return { ok: true, review: ['auto', 'always', 'off'].indexOf(j.review) >= 0 ? j.review : 'auto' }; }
      if (op === 'reviewSet') {
        const v = String(req.review || '');
        if (['auto', 'always', 'off'].indexOf(v) < 0) return { ok: false, error: 'auto, always or off' };
        const f = path.join(userData(), 'aiondx-skills.json');
        writeJson(f, Object.assign(readJson(f) || {}, { review: v }));
        return { ok: true, review: v };
      }
      // DX Skills (aiondx-skillhub.js)
      const H = require('./aiondx-skillhub.js');
      const hctx = { userData: userData(), home: home(), builtinDir: builtin() };
      if (op === 'hub') return H.hub(hctx);
      if (op === 'review') return { ok: true, review: H.reviewFolder(String(req.dir || '')) };
      if (op === 'import') {
        let source = req.source;
        if (!source && (req.pick === 'file' || req.pick === 'folder')) {
          const d = await electron.dialog.showOpenDialog({ title: 'Choose a skill to import', properties: req.pick === 'file' ? ['openFile'] : ['openDirectory'], filters: req.pick === 'file' ? [{ name: 'Skill', extensions: ['zip', 'skill'] }] : undefined });
          if (!d || d.canceled || !d.filePaths[0]) return { ok: false, canceled: true };
          source = d.filePaths[0];
        }
        return await H.importSkills(hctx, source, String(req.project || ''));
      }
      if (op === 'approve') return H.approve(hctx, String(req.project || ''), req.name, !!req.replace);
      if (op === 'reject') return H.reject(hctx, String(req.project || ''), req.name);
      if (op === 'remove') return H.remove(hctx, req.dir);
      if (op === 'link') return H.link(hctx, String(req.project || ''), req.name);
      if (op === 'export') {
        const d = await electron.dialog.showSaveDialog({ title: 'Export the skill as a ZIP', defaultPath: path.join(os.homedir(), 'Downloads', path.basename(String(req.dir || 'skill')) + '.zip'), filters: [{ name: 'ZIP', extensions: ['zip'] }] });
        if (!d || d.canceled || !d.filePath) return { ok: false, canceled: true };
        return H.exportZip(req.dir, d.filePath);
      }
      if (op === 'catalog') return await H.catalog(hctx, String(req.which || ''));
      if (op === 'library') return H.library(hctx, String(req.cmd || ''), req.clone, req.yes === true);
      if (op === 'pins') return { ok: true, pins: readJson(path.join(userData(), 'aiondx-skill-pins.json')) || {} };
      return { ok: false, error: 'unknown request' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { install, list, setState, setPin, frontMatter, usesFor, layersFor };
