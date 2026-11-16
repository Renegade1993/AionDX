'use strict';
/**
 * aiondx-skillhub.js - DX Skills, AionUi's Skills Hub remade (R-128 step 5, November 15th, 2026). Used by aiondx-skills-main.js (ipc
 * aiondx:skills). The user, November 14th: "just remake AionUI's skills hub with our own DX Skills hub and they shouldn't really have to
 * move at all", "PUT THEM WHERE THEY SHOULD BE": official skills in the global library, unofficial ones in the projects they belong to.
 *
 * Nothing moves: AionUi's own store (~\.aiondx\skills) stays where it is and keeps its assistants; the global library is shown read-only
 * and changes only through its own update procedure (update_skills.py status / fetch / apply, apply on the user's yes); imports and new
 * skills go into a project's layer only, after review: an import lands in <project>\.claude\skills-pending\<name> with a review file, and
 * loads only when the user approves it (moved into <project>\.claude\skills). A project opts into a global library skill by a link
 * (a directory junction, as update_skills.py makes them).
 *
 * Ops: hub, review, approve, reject, remove, link, export, import, catalog, library.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) { const parts = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim()); v = parts.join(' '); }
    else v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    out[kv[1]] = v;
  }
  return out;
}
function skillsIn(dir) {
  const out = [];
  let es = [];
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const d = path.join(dir, e.name);
    let text;
    try { text = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'); } catch { continue; }
    const fm = frontMatter(text);
    let linked = null;
    try { const st = fs.lstatSync(d); if (st.isSymbolicLink()) linked = fs.realpathSync(d); else { const real = fs.realpathSync(d); if (real.toLowerCase() !== path.resolve(d).toLowerCase()) linked = real; } } catch { /* plain */ }
    out.push({ name: fm.name || e.name, folder: e.name, description: String(fm.description || '').slice(0, 400), dir: d, linked });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Where everything is: the global library (and the files its update tool wrote about where it came from), the registry's projects. */
function places(ctx) {
  const reg = readJson(path.join(ctx.userData, 'aiondx-projects.json')) || {};
  // the global library: the "Claude Skills" folder (holding its update tool) in one of the shared roots
  const libRoot = ctx.libraryDir || (Array.isArray(reg.skillRoots) ? reg.skillRoots : []).map((r) => path.join(r, 'Claude Skills')).find((p) => exists(path.join(p, 'update_skills.py'))) || null;
  return { reg, libRoot };
}

function hub(ctx) {
  const { reg, libRoot } = places(ctx);
  const layers = [];
  if (libRoot && exists(libRoot)) {
    let source = '', commit = '';
    try { const s = fs.readFileSync(path.join(libRoot, 'anthropic', 'SOURCE.md'), 'utf8'); source = (/Repository:\s*(\S+)/.exec(s) || [])[1] || ''; commit = (/Commit:\s*([0-9a-f]{7,40})/.exec(s) || [])[1] || ''; } catch { /* none */ }
    layers.push({ kind: 'library', label: 'Global library (official, read-only)', dir: path.join(libRoot, 'anthropic', 'skills'), readOnly: true, source, commit, skills: skillsIn(path.join(libRoot, 'anthropic', 'skills')) });
    layers.push({ kind: 'method', label: 'Global library: method skills (read-only)', dir: path.join(libRoot, 'method'), readOnly: true, skills: skillsIn(path.join(libRoot, 'method')) });
  }
  layers.push({ kind: 'yours', label: 'Yours, on this PC (every Claude chat)', dir: path.join(ctx.home, '.claude', 'skills'), skills: skillsIn(path.join(ctx.home, '.claude', 'skills')) });
  for (const r of Array.isArray(reg.skillRoots) ? reg.skillRoots : []) layers.push({ kind: 'shared', label: 'Shared: ' + path.basename(r), dir: path.join(r, '.claude', 'skills'), readOnly: true, skills: skillsIn(path.join(r, '.claude', 'skills')) });
  for (const [key, p] of Object.entries(reg.projects || {})) {
    if (!p || !p.root) continue;
    layers.push({ kind: 'project', project: key, label: path.basename(p.root), dir: path.join(p.root, '.claude', 'skills'), skills: skillsIn(path.join(p.root, '.claude', 'skills')),
      pending: skillsIn(path.join(p.root, '.claude', 'skills-pending')).map((s) => {
        const rv = readJson(path.join(s.dir, '.aiondx-review.json')) || {};
        if (!rv.files) Object.assign(rv, reviewFolder(s.dir));   // a proposal from an agent: reviewed when it is shown
        const cur = path.join(p.root, '.claude', 'skills', s.folder, 'SKILL.md');
        if (exists(cur)) { try { rv.change = lineChange(fs.readFileSync(cur, 'utf8'), fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')); } catch { /* unreadable */ } }
        return Object.assign(s, { review: rv });
      }) });
  }
  layers.push({ kind: 'store', label: 'AionUi\'s skill store (assistants)', dir: path.join(ctx.home, '.aiondx', 'skills'), skills: skillsIn(path.join(ctx.home, '.aiondx', 'skills')) });
  layers.push({ kind: 'aiondx', label: 'AionDX\'s own (every chat)', dir: ctx.builtinDir, readOnly: true, skills: skillsIn(ctx.builtinDir) });
  return { ok: true, layers, libraryRoot: libRoot };
}

/** How a new SKILL.md differs from the one it would replace: lines added and taken out (as a multiset of lines). */
function lineChange(oldText, newText) {
  const count = (t) => { const m = new Map(); for (const l of String(t).split(/\r?\n/)) m.set(l, (m.get(l) || 0) + 1); return m; };
  const a = count(oldText), b = count(newText);
  let added = 0, removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0));
  return { added, removed };
}

function projectRoot(ctx, key) {
  const { reg } = places(ctx);
  const p = reg.projects && reg.projects[key];
  if (!p || !p.root) throw new Error('There is no project called ' + key + '.');
  return p.root;
}

// ---------------------------------------------------------------- review (what an imported skill would do)
const FLAGS = [
  [/\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*\|\s*(sh|bash|iex|Invoke-Expression|python|node)\b/i, 'downloads something and runs it'],
  [/\b(Invoke-Expression|iex)\b|\beval\s*\(|\bexec\s*\(/i, 'runs text as code'],
  [/\b(requests\.(get|post)|urllib|fetch\(|http\.request|https?:\/\/(?!github\.com\/anthropics|github\.com\/openai)[^\s'")]+)/i, 'reaches the network'],
  [/\.ssh|id_rsa|\.aws[\\/]credentials|\.credentials\.json|\bAPI_KEY\b|\bTOKEN\b|password/i, 'touches keys, tokens or passwords'],
  [/\brm\s+-rf\b|Remove-Item[^\n]*-Recurse|shutil\.rmtree|rmdir\s+\/s/i, 'deletes folders'],
  [/[A-Za-z0-9+/]{200,}={0,2}/, 'holds a long encoded blob'],
  [/\b(reg\s+add|Set-ItemProperty[^\n]*HKLM|schtasks|New-ScheduledTask|crontab)\b/i, 'changes the system or schedules itself'],
];
const SCRIPT_RE = /\.(py|js|mjs|cjs|ts|ps1|psm1|sh|bash|bat|cmd|vbs|exe|dll|rb|pl)$/i;
function reviewFolder(dir) {
  const files = [], scripts = [], flags = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') walk(p, r); continue; }
      if (e.name === '.aiondx-review.json') continue;
      const size = fs.statSync(p).size;
      files.push({ path: r, size });
      if (SCRIPT_RE.test(e.name)) scripts.push(r);
      if (/\.(exe|dll)$/i.test(e.name)) { flags.push({ file: r, line: 0, why: 'a program, not readable text' }); continue; }
      if (size > 2 * 1048576) continue;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      lines.forEach((ln, i) => { for (const [re, why] of FLAGS) if (re.test(ln)) flags.push({ file: r, line: i + 1, why, text: ln.trim().slice(0, 160) }); });
    }
  };
  walk(dir, '');
  return { files, scripts, flags: flags.slice(0, 200) };
}

// ---------------------------------------------------------------- import
function hiddenRun(exe, args, timeoutMs, cwd) {
  const r = cp.spawnSync(exe, args, { windowsHide: true, timeout: timeoutMs || 120000, encoding: 'utf8', cwd });
  if (r.status !== 0) throw new Error(exe + ' failed: ' + String(r.stderr || r.stdout || r.error || '').trim().slice(0, 300));
  return r.stdout;
}
const TAR = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
/** Every skill folder (holding SKILL.md) under a folder, the folder itself first. */
function findSkills(dir, depth) {
  if (exists(path.join(dir, 'SKILL.md'))) return [dir];
  if ((depth || 0) > 4) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') out = out.concat(findSkills(path.join(dir, e.name), (depth || 0) + 1));
  return out;
}
/** A link the user gave, as something to download: a GitHub repository or a folder in one (its ZIP), or a ZIP or .skill address. */
function downloadUrl(u) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(\/.*)?)?\/?$/.exec(u);
  if (m) return { url: 'https://codeload.github.com/' + m[1] + '/' + m[2] + '/zip/' + (m[3] ? 'refs/heads/' + m[3] : 'HEAD'), sub: m[4] ? m[4].replace(/^\//, '') : '', repo: m[1] + '/' + m[2] };
  if (/^https:\/\/\S+\.(zip|skill)(\?\S*)?$/i.test(u)) return { url: u, sub: '' };
  return null;
}
async function importSkills(ctx, source, projectKey) {
  const root = projectRoot(ctx, projectKey);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-skill-import-'));
  try {
    let from = null, sub = '';
    const src = String(source || '').trim();
    if (/^https:\/\//i.test(src)) {
      const d = downloadUrl(src);
      if (!d) throw new Error('That link is not a GitHub repository or folder, or a .zip or .skill file.');
      const res = await (ctx.fetch || fetch)(d.url, { redirect: 'follow' });
      if (!res.ok) throw new Error('The download failed (' + res.status + ').');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 50 * 1048576) throw new Error('That download is over 50 MB; a skill is not that big.');
      fs.writeFileSync(path.join(tmp, 'in.zip'), buf);
      fs.mkdirSync(path.join(tmp, 'x'));
      hiddenRun(TAR(), ['-xf', path.join(tmp, 'in.zip'), '-C', path.join(tmp, 'x')]);
      from = path.join(tmp, 'x');
      sub = d.sub;
      if (sub) { const top = fs.readdirSync(from).filter((n) => fs.statSync(path.join(from, n)).isDirectory()); if (top.length === 1) from = path.join(from, top[0], sub); }
    } else if (exists(src) && fs.statSync(src).isDirectory()) from = src;
    else if (exists(src) && /\.(zip|skill)$/i.test(src)) {
      fs.mkdirSync(path.join(tmp, 'x'));
      hiddenRun(TAR(), ['-xf', src, '-C', path.join(tmp, 'x')]);
      from = path.join(tmp, 'x');
    } else throw new Error('Choose a .zip or .skill file, a folder, or paste a GitHub link.');
    if (!exists(from)) throw new Error('Nothing at that place in the download.');
    const found = findSkills(from);
    if (!found.length) throw new Error('No skill in it (no folder holding a SKILL.md).');
    const pend = path.join(root, '.claude', 'skills-pending');
    const out = [];
    for (const d of found.slice(0, 50)) {
      const fm = frontMatter(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'));
      const name = String(fm.name || path.basename(d)).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
      if (!NAME_RE.test(name)) continue;
      const dest = path.join(pend, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(pend, { recursive: true });
      fs.cpSync(d, dest, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
      const rv = Object.assign({ source: src, at: new Date().toISOString(), approved: false }, reviewFolder(dest));
      fs.writeFileSync(path.join(dest, '.aiondx-review.json'), JSON.stringify(rv, null, 1));
      out.push({ name, dir: dest, files: rv.files.length, scripts: rv.scripts.length, flags: rv.flags.length, exists: exists(path.join(root, '.claude', 'skills', name)) });
    }
    return { ok: true, project: projectKey, imported: out };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
}

function approve(ctx, projectKey, name, replace) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Which skill?');
  const root = projectRoot(ctx, projectKey);
  const from = path.join(root, '.claude', 'skills-pending', name), to = path.join(root, '.claude', 'skills', name);
  if (!exists(from)) throw new Error('No skill ' + name + ' is waiting for review in that project.');
  if (exists(to) && !replace) return { ok: false, exists: true, error: 'The project already has a skill called ' + name + '. Replace it?' };
  if (exists(to)) fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  const rv = readJson(path.join(to, '.aiondx-review.json')) || {};
  rv.approved = true; rv.approvedAt = new Date().toISOString();
  fs.writeFileSync(path.join(to, '.aiondx-review.json'), JSON.stringify(rv, null, 1));
  return { ok: true, dir: to };
}
function reject(ctx, projectKey, name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Which skill?');
  const d = path.join(projectRoot(ctx, projectKey), '.claude', 'skills-pending', name);
  fs.rmSync(d, { recursive: true, force: true });
  return { ok: true };
}
/** A skill taken out of a project's layer (or AionUi's store, or yours). A link is unlinked, never followed. */
function remove(ctx, dir) {
  const d = path.resolve(String(dir || ''));
  const h = hub(ctx);
  const layer = h.layers.find((l) => l.skills.some((s) => path.resolve(s.dir).toLowerCase() === d.toLowerCase()));
  if (!layer) throw new Error('That is not a skill AionDX knows.');
  if (layer.readOnly) throw new Error('That layer is read-only here.');
  let st; try { st = fs.lstatSync(d); } catch { throw new Error('It is not there.'); }
  const s = layer.skills.find((x) => path.resolve(x.dir).toLowerCase() === d.toLowerCase());
  if (st.isSymbolicLink() || (s && s.linked)) fs.rmdirSync(d);   // a junction: the link goes, its target stays
  else fs.rmSync(d, { recursive: true, force: true });
  return { ok: true };
}
/** A project opts into a global library skill: a junction in its layer, as update_skills.py links them. */
function link(ctx, projectKey, name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Which skill?');
  const { libRoot } = places(ctx);
  const target = [path.join(libRoot || '', 'anthropic', 'skills', name), path.join(libRoot || '', 'method', name)].find((p) => exists(path.join(p, 'SKILL.md')));
  if (!target) throw new Error('The global library has no skill called ' + name + '.');
  const at = path.join(projectRoot(ctx, projectKey), '.claude', 'skills', name);
  if (exists(at)) throw new Error('The project already has a skill called ' + name + '.');
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
  return { ok: true, dir: at, target };
}
function exportZip(dir, to) {
  const d = path.resolve(String(dir || ''));
  if (!exists(path.join(d, 'SKILL.md'))) throw new Error('That folder holds no SKILL.md.');
  fs.rmSync(to, { force: true });
  hiddenRun(TAR(), ['-a', '-c', '-f', to, '-C', path.dirname(fs.realpathSync(d)), path.basename(fs.realpathSync(d))]);
  return { ok: true, file: to };
}

// ---------------------------------------------------------------- the official catalogs (read-only browsing)
const CATALOGS = { anthropic: { repo: 'anthropics/skills', label: 'Anthropic' }, openai: { repo: 'openai/skills', label: 'OpenAI' } };
const catalogCache = {};
async function catalog(ctx, which) {
  const c = CATALOGS[which];
  if (!c) throw new Error('Anthropic\'s or OpenAI\'s?');
  const hit = catalogCache[which];
  if (hit && Date.now() - hit.at < 3600000) return hit.r;
  const f = ctx.fetch || fetch;
  const tr = await f('https://api.github.com/repos/' + c.repo + '/git/trees/HEAD?recursive=1', { headers: { 'User-Agent': 'AionDX', Accept: 'application/vnd.github+json' } });
  if (!tr.ok) throw new Error('GitHub did not answer (' + tr.status + (tr.status === 403 ? ', its hourly limit for this PC is used up' : '') + ').');
  const tree = (await tr.json()).tree || [];
  const paths = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/.test(t.path)).map((t) => t.path).slice(0, 120);
  const { libRoot } = places(ctx);
  const have = new Set(libRoot ? skillsIn(path.join(libRoot, 'anthropic', 'skills')).map((s) => s.folder) : []);
  const skills = [];
  for (const p of paths) {
    const folder = p.split('/').slice(-2, -1)[0] || p;
    let fm = {};
    try { const raw = await f('https://raw.githubusercontent.com/' + c.repo + '/HEAD/' + p, { headers: { 'User-Agent': 'AionDX' } }); if (raw.ok) fm = frontMatter(await raw.text()); } catch { /* listed without one */ }
    skills.push({ name: fm.name || folder, folder, path: p.replace(/\/SKILL\.md$/, ''), description: String(fm.description || '').slice(0, 400), inLibrary: which === 'anthropic' && have.has(folder),
      url: 'https://github.com/' + c.repo + '/tree/HEAD/' + p.replace(/\/SKILL\.md$/, '') });
  }
  const r = { ok: true, which, label: c.label, repo: c.repo, skills };
  catalogCache[which] = { at: Date.now(), r };
  return r;
}

/** The global library's own update procedure, run hidden: status and fetch change nothing; apply only on the user's yes. */
function library(ctx, cmd, clone, yes) {
  const { libRoot } = places(ctx);
  if (!libRoot || !exists(path.join(libRoot, 'update_skills.py'))) throw new Error('The global library\'s update tool is not on this PC.');
  if (!['status', 'fetch', 'apply'].includes(cmd)) throw new Error('status, fetch or apply.');
  if (cmd === 'apply' && !yes) throw new Error('Applying an update changes what every Claude chat on this PC loads; it needs your yes.');
  const args = ['-B', path.join(libRoot, 'update_skills.py'), cmd].concat(cmd === 'apply' ? [String(clone || '')] : []);
  const r = cp.spawnSync(ctx.py || 'py', args, { windowsHide: true, timeout: 600000, encoding: 'utf8', cwd: libRoot });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const cloneDir = (/clone[^\n]*?([A-Z]:\\[^\s\n]+)/i.exec(out) || [])[1] || null;
  return { ok: r.status === 0, output: out.slice(-12000), clone: cmd === 'fetch' ? cloneDir : undefined };
}

module.exports = { lineChange, hub, reviewFolder, importSkills, approve, reject, remove, link, exportZip, catalog, library, downloadUrl, frontMatter };
