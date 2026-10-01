#!/usr/bin/env node
/**
 * apply.js: the import step of the aiondx-setup skill, and of AionDX's one-click setup (the Welcome screen).
 *
 *   node apply.js --survey <survey.json> --plan <plan.json> [--home <dir>]
 *   node apply.js --survey <survey.json> --all [--skip KIND]... [--prefs TEXT | --prefs-file FILE] [--home <dir>]
 *                                        everything the survey found, every agent installed, less the kinds skipped
 *   --text                               a summary for a person instead of the JSON (aiondx setup apply uses it)
 *
 * K, 2026-09-26: "we want a streamlined 'one-click' ish setup process". The survey (survey.js) lists what
 * the other AI apps left on this PC; this copies and wires it, the same way whichever button or agent runs it:
 *   - copies of the chosen files under ~/.aiondx/harvest/<date>/<tool>/, secret-looking files, node_modules,
 *     .git and the like left out; custom agents, commands, skills, prompts and rules also under
 *     ~/.aiondx/<kind>/ (same name, different content: the newer keeps the name, the older gets .<tool>)
 *   - ~/.aiondx/AIONDX.md: the user's own instructions first, then each chosen instructions file whole under
 *     its own heading, newest first, exact duplicates dropped, anything that looks like a key or token removed
 *   - the chosen MCP servers into the AionDX MCP file (~/.aiondx/mcp/servers.json, the Loop tool's format):
 *     how each runs, every env and header value a ${NAME} placeholder, never the value itself; a placeholder
 *     named like an environment variable the user already has is filled from it when the server is used
 *   - AIONDX.md written into each chosen agent's own global instructions file between the AionDX markers,
 *     without the part that came from that same file; the file is backed up first
 *   - harvest/<date>/report.md, and a JSON summary on stdout
 * Every source must be a location the survey found; every write goes inside ~/.aiondx or into one of the agent
 * files in AGENTS below. Deadline 120 s.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const HOME = opt('--home') ? path.resolve(opt('--home')) : os.homedir();
const AIONDX = path.join(HOME, '.aiondx');
setTimeout(() => { console.error('apply: 120 s deadline passed, stopping'); process.exit(2); }, 120000).unref();

const SECRET_NAME = /(^|[\\/._-])(\.env(\..*)?|auth[^\\/]*\.json|credentials?[^\\/]*|secrets?[^\\/]*|tokens?[^\\/]*\.json|.*\.(key|pem|p12|pfx)|id_(rsa|ed25519)[^\\/]*|keychain[^\\/]*|oauth[^\\/]*\.json)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.pytest_cache', '.mypy_cache']);
const COPY_KINDS = ['agents', 'commands', 'skills', 'prompts', 'rules'];
const TEXT_FILE = /\.(md|mdc|markdown|txt|json|jsonc|toml|ya?ml|js|mjs|cjs|ts|py|sh|ps1|cmd|bat|ini|cfg|conf|xml|html?)$/i;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_LOCATION_BYTES = 40 * 1024 * 1024;
const MAX_LOCATION_FILES = 3000;
const LEAVE_OUT_TOOLS = new Set(['aionui']);   // AionDX's own data: already in use, never imported into itself
const BEGIN = '<!-- AionDX instructions: begin -->';
const END = '<!-- AionDX instructions: end -->';
// The Loop tool's own lines for a new AionDX MCP file (aiondx-loop.cs McpFileAbout); kept in step by hand.
const MCP_ABOUT = [
  'The AionDX MCP file: the user\'s MCP servers and their access credentials, in one place every AionDX agent knows (the aiondx-loop skill).',
  'Nothing here is loaded into any chat. An agent uses a server only when the user asks, for one command at a time:',
  '  aiondx mcp list  |  aiondx mcp tools NAME  |  aiondx mcp call NAME TOOL --param key=value',
  'Add a server with aiondx mcp add, or by hand in the mcpServers form Claude Desktop and Claude Code use:',
  '  local:  "name": {"command": "npx", "args": ["-y", "some-mcp-server"], "env": {"API_KEY": "..."}}',
  '  remote: "name": {"type": "http", "url": "https://host/mcp", "headers": {"Authorization": "Bearer ..."}}  ("sse" for the older transport)',
  'Any value can name a secret as ${NAME}: it comes from "secrets" below, or else from the environment.',
  'For now the credentials sit here as plain text: keep this file to yourself.',
];

// Each agent's own global instructions file (research: ! LLM Files\Research\2026-09-26_agent-list-new-chat-and-global-instructions.md).
const localAppData = () => (opt('--home') ? path.join(HOME, 'AppData', 'Local') : process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'));
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', file: () => path.join(!opt('--home') && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : path.join(HOME, '.claude'), 'CLAUDE.md'),
    present: (s) => installed(s, 'claude-code') },
  { id: 'codex', name: 'Codex', file: () => {
    const dir = !opt('--home') && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(HOME, '.codex');
    return fs.existsSync(path.join(dir, 'AGENTS.override.md')) ? path.join(dir, 'AGENTS.override.md') : path.join(dir, 'AGENTS.md');
  }, present: (s) => installed(s, 'codex') },
  { id: 'antigravity', name: 'Antigravity', file: () => path.join(HOME, '.gemini', 'config', 'AGENTS.md'),
    present: () => fs.existsSync(path.join(localAppData(), 'agy', 'bin', 'agy.exe')) || fs.existsSync(path.join(HOME, '.gemini', 'config')) },
  { id: 'gemini-cli', name: 'Gemini CLI', file: () => path.join(HOME, '.gemini', 'GEMINI.md'), present: (s) => installed(s, 'gemini-cli') },
  { id: 'qwen-code', name: 'Qwen Code', file: () => path.join(HOME, '.qwen', 'QWEN.md'), present: (s) => installed(s, 'qwen-code') },
  { id: 'opencode', name: 'OpenCode', file: () => path.join(HOME, '.config', 'opencode', 'AGENTS.md'), present: (s) => installed(s, 'opencode') },
];
function installed(survey, id) { const t = survey.tools.find((x) => x.id === id); return !!(t && t.installed); }

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (p, dir) => { const r = path.relative(path.resolve(dir), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const stamp = () => { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const clock = () => new Date().toTimeString().slice(0, 8).replace(/:/g, '');
function readText(p) { const b = fs.readFileSync(p); return b.toString('utf8').replace(/^﻿/, ''); }

// Strings that look like keys or tokens, removed from instructions text (a file of instructions should not hold one;
// some do). The names of variables stay; only values that look like credentials go.
const SECRET_TEXT = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, /sk-proj-[A-Za-z0-9_-]{20,}/g, /\bsk-[A-Za-z0-9]{32,}\b/g, /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, /\bgh[ousr]_[A-Za-z0-9]{30,}\b/g, /\bAIza[0-9A-Za-z_-]{35}\b/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{16,}/gi,
];
function scrub(text) {
  let n = 0;
  for (const re of SECRET_TEXT) {
    text = text.replace(re, (m, lead) => { n++; return (typeof lead === 'string' ? lead : '') + '<removed by AionDX setup: it looked like a key or token>'; });
  }
  return { text, n };
}

// ------------------------------------------------------------------ the plan

function loadSurvey() {
  const f = opt('--survey');
  if (!f) throw new Error('--survey <survey.json> is required (node survey.js --json --out <file> writes one)');
  const s = JSON.parse(readText(f));
  if (!s || !Array.isArray(s.tools)) throw new Error('that is not a survey: ' + f);
  if (s.home && !same(s.home, HOME)) throw new Error('the survey is of another home folder (' + s.home + ')');
  return s;
}

/** Every location the survey found, with its tool. */
function foundLocations(survey) {
  const out = [];
  for (const t of survey.tools) for (const l of t.locations || []) if (l.exists && !l.excluded) out.push(Object.assign({ tool: t.id, toolName: t.name }, l));
  return out;
}

/** --all: everything found, less the kinds named with --skip (agents, commands, prompts, skills, rules, instructions,
 *  mcp, wire), with the user's own instructions from --prefs TEXT or --prefs-file FILE. */
function allPlan(survey) {
  const skip = new Set(args.filter((a, i) => args[i - 1] === '--skip').map((s) => s.toLowerCase()));
  const locs = foundLocations(survey).filter((l) => !LEAVE_OUT_TOOLS.has(l.tool) && !skip.has(l.kind));
  let prefs = opt('--prefs') || '';
  if (opt('--prefs-file')) prefs = readText(opt('--prefs-file'));
  return {
    prefs,
    items: locs.filter((l) => (l.kind === 'instructions' && l.type === 'file' && !l.secretLooking) || COPY_KINDS.includes(l.kind)).map((l) => l.path),
    mcp: skip.has('mcp') ? [] : [].concat(...locs.filter((l) => l.kind === 'mcp' && l.mcp && l.mcp.servers).map((l) => l.mcp.servers.map((s) => ({ file: l.path, name: s.name })))),
    wire: skip.has('wire') ? [] : AGENTS.filter((a) => a.present(survey)).map((a) => a.id),
  };
}

/** The plan, checked against the survey: nothing outside what it found is read. */
function checkPlan(survey, plan) {
  const locs = foundLocations(survey);
  const byPath = (p) => locs.find((l) => same(l.path, p));
  const items = [], mcp = [], wire = [], refused = [];
  for (const p of plan.items || []) {
    const l = byPath(String(p));
    if (!l) { refused.push({ path: String(p), why: 'not a location the survey found' }); continue; }
    if (l.kind === 'instructions' && l.type === 'file' && !l.secretLooking) items.push(l);
    else if (COPY_KINDS.includes(l.kind)) items.push(l);
    else refused.push({ path: l.path, why: 'a ' + l.kind + ' location is not imported (it can hold secrets)' });
  }
  for (const m of plan.mcp || []) {
    const l = m && byPath(String(m.file));
    const listed = l && l.kind === 'mcp' && l.mcp && (l.mcp.servers || []).some((s) => s.name === m.name);
    if (!listed) { refused.push({ path: String(m && m.file), why: 'MCP server "' + (m && m.name) + '" is not in the survey' }); continue; }
    mcp.push({ loc: l, name: m.name });
  }
  for (const id of plan.wire || []) {
    const a = AGENTS.find((x) => x.id === id);
    if (a) wire.push(a); else refused.push({ path: String(id), why: 'not an agent AionDX knows how to give instructions to' });
  }
  return { prefs: String(plan.prefs || '').trim(), items, mcp, wire, refused };
}

// ------------------------------------------------------------------ copying

/** Copies a file or folder, leaving out secret-looking files and heavy folders, within size limits. */
function copyTree(src, dst, stats, skipped) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(src); } catch { skipped.push({ path: src, why: 'unreadable' }); return; }
    for (const n of names) {
      const s = path.join(src, n);
      if (SKIP_DIRS.has(n.toLowerCase())) { skipped.push({ path: s, why: 'a dependency or version-control folder' }); continue; }
      if (SECRET_NAME.test(n)) { skipped.push({ path: s, why: 'secret-looking, not read' }); continue; }
      let sst;
      try { sst = fs.lstatSync(s); } catch { continue; }
      if (sst.isSymbolicLink()) { skipped.push({ path: s, why: 'a link' }); continue; }
      copyTree(s, path.join(dst, n), stats, skipped);
    }
    return;
  }
  if (SECRET_NAME.test(path.basename(src))) { skipped.push({ path: src, why: 'secret-looking, not read' }); return; }
  if (st.size > MAX_FILE) { skipped.push({ path: src, why: 'larger than 5 MB' }); return; }
  if (stats.files >= MAX_LOCATION_FILES || stats.bytes + st.size > MAX_LOCATION_BYTES) { skipped.push({ path: src, why: 'past the size limit for one location' }); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (TEXT_FILE.test(src)) {
    // Text is copied with anything that looks like a key or token taken out: instructions and scripts sometimes hold one.
    const s = scrub(fs.readFileSync(src, 'utf8'));
    stats.secrets = (stats.secrets || 0) + s.n;
    fs.writeFileSync(dst, s.n ? (src.endsWith('.md') ? withoutBlock(s.text) : s.text) : (src.endsWith('.md') ? withoutBlock(fs.readFileSync(src, 'utf8')) : fs.readFileSync(src, 'utf8')));
  } else fs.copyFileSync(src, dst);
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* the date is only for ordering */ }
  stats.files++;
  stats.bytes += st.size;
}

/** Where a location's copy goes: harvest/<date>/<tool>/ plus its path under the home folder (or its drive path). */
function harvestPath(harvest, tool, p) {
  const rel = inside(p, HOME) ? path.relative(HOME, p) : p.replace(/^([A-Za-z]):/, '$1').replace(/^[\\/]+/, '');
  return path.join(harvest, tool, rel);
}

function treeSignature(p) {
  const parts = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const full = path.join(d, n);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, rel + n + '/'); else parts.push(rel + n + ':' + st.size + ':' + fs.readFileSync(full).toString('base64').length);
    }
  };
  walk(p, '');
  return parts.join('|');
}
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.isDirectory() !== sb.isDirectory()) return false;
    if (sa.isDirectory()) return treeSignature(a) === treeSignature(b);
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}
function newest(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  try { for (const n of fs.readdirSync(p)) m = Math.max(m, newest(path.join(p, n))); } catch { /* as far as it reads */ }
  return m;
}
function suffixed(name, tool) {
  const ext = path.extname(name);
  return ext && ext.length < 8 ? name.slice(0, -ext.length) + '.' + tool + ext : name + '.' + tool;
}

/** One entry of a copied agents/commands/... folder into ~/.aiondx/<kind>/: kept, the newer by name, the older beside it. */
function organize(kind, tool, harvestCopy, counts) {
  const dir = path.join(AIONDX, kind);
  let names = [];
  try { names = fs.readdirSync(harvestCopy); } catch { return; }
  for (const n of names) {
    const src = path.join(harvestCopy, n);
    const dst = path.join(dir, n);
    if (!fs.existsSync(dst)) { copyInto(src, dst); counts.added++; continue; }
    if (sameContent(src, dst)) { counts.same++; continue; }
    if (newest(src) > newest(dst)) {
      const older = path.join(dir, suffixed(n, 'before-' + tool));
      if (!fs.existsSync(older)) fs.renameSync(dst, older); else fs.rmSync(dst, { recursive: true, force: true });
      copyInto(src, dst);
    } else {
      const aside = path.join(dir, suffixed(n, tool));
      if (fs.existsSync(aside)) fs.rmSync(aside, { recursive: true, force: true });
      copyInto(src, aside);
    }
    counts.renamed++;
  }
}
function copyInto(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) copyInto(path.join(src, n), path.join(dst, n)); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* ordering only */ }
}

// ------------------------------------------------------------------ MCP servers

/** The chosen server's definition from its own file, with every env and header value left out. */
function readServer(loc, name) {
  const text = readText(loc.path);
  if (/\.toml$/i.test(loc.path)) {
    const s = { env: [] };
    let section = null;
    const head = (h) => h.replace(/^"|"$/g, '');
    for (const line of text.split(/\r?\n/)) {
      const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (h) {
        const parts = h[1].split('.').map((x) => head(x.trim()));
        section = parts[0] === 'mcp_servers' && parts[1] === name ? (parts[2] === 'env' ? 'env' : parts.length === 2 ? 'server' : 'other') : null;
        continue;
      }
      if (!section) continue;
      const kv = line.match(/^\s*([A-Za-z0-9_."-]+)\s*=\s*(.+?)\s*$/);
      if (!kv) continue;
      const key = head(kv[1]);
      if (section === 'env') { s.env.push(key); continue; }
      if (section !== 'server') continue;
      const v = kv[2];
      if (key === 'command' || key === 'url' || key === 'type' || key === 'cwd') { const m = v.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/); if (m) s[key] = m[1] !== undefined ? JSON.parse('"' + m[1] + '"') : m[2]; }
      else if (key === 'args') { try { s.args = JSON.parse(v.replace(/'/g, '"')); } catch { /* left out */ } }
      else if (key === 'env') { const names = v.match(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g); if (names) s.env.push(...names.map((x) => x.replace(/\s*=$/, ''))); }
    }
    return s;
  }
  const j = JSON.parse(text);
  const keys = loc.mcpKeys || ['mcpServers', 'servers', 'mcp.servers', 'context_servers'];
  for (const k of keys) {
    const node = k.split('.').reduce((o, part) => (o && typeof o === 'object' ? o[part] : undefined), j);
    if (!node || typeof node !== 'object') continue;
    const list = Array.isArray(node) ? node.map((v, i) => [v && v.name || String(i), v]) : Object.entries(node);
    for (const [n, v] of list) {
      if (n !== name || !v || typeof v !== 'object') continue;
      return {
        type: typeof v.type === 'string' ? v.type : typeof v.transport === 'string' ? v.transport : undefined,
        command: typeof v.command === 'string' ? v.command : undefined,
        args: Array.isArray(v.args) ? v.args.map(String) : undefined,
        url: typeof v.url === 'string' ? v.url : typeof v.serverUrl === 'string' ? v.serverUrl : undefined,
        cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
        env: v.env && typeof v.env === 'object' ? Object.keys(v.env) : [],
        headers: v.headers && typeof v.headers === 'object' ? Object.keys(v.headers) : [],
      };
    }
  }
  return null;
}

const envName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
const serverName = (s) => { const n = String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64); return n || 'server'; };

/** A URL with its query values replaced: keys often travel there. */
function safeUrl(u) {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) x.searchParams.set(k, '${' + envName(k) + '}');
    return x.toString().replace(/%24%7B/g, '${').replace(/%7D/g, '}');
  } catch { return u; }
}

function withLock(file, work) {
  const lock = file + '.lock';
  const until = Date.now() + 10000;
  let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      if (Date.now() > until) throw new Error('another program has held ' + lock + ' for 10 s');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return work(); } finally { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(lock); } catch { /* gone */ } }
}

function importMcp(chosen, notes) {
  const file = path.join(AIONDX, 'mcp', 'servers.json');
  const out = { file, added: [], same: [], renamed: [], placeholders: [], failed: [] };
  if (!chosen.length) return out;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withLock(file, () => {
    let doc = null;
    if (fs.existsSync(file)) {
      try { doc = JSON.parse(readText(file)); } catch (e) { throw new Error(file + ' is not valid JSON, so no MCP server was added to it: ' + e.message); }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = { _about: MCP_ABOUT, mcpServers: {}, secrets: {} };
    if (!doc.mcpServers || typeof doc.mcpServers !== 'object') doc.mcpServers = {};
    if (!doc.secrets || typeof doc.secrets !== 'object') doc.secrets = {};
    for (const c of chosen) {
      let def;
      try { def = readServer(c.loc, c.name); } catch (e) { out.failed.push({ name: c.name, why: e.message }); continue; }
      if (!def || (!def.command && !def.url)) { out.failed.push({ name: c.name, why: 'no command or url in ' + c.loc.path }); continue; }
      const entry = { description: 'Imported from ' + c.loc.toolName + ' (' + c.loc.path + ') by AionDX setup' };
      if (def.url) {
        entry.type = /sse/i.test(def.type || '') ? 'sse' : 'http';
        entry.url = safeUrl(def.url);
        if (def.headers && def.headers.length) {
          entry.headers = {};
          for (const h of def.headers) { const n = envName(serverName(c.name) + '_' + h); entry.headers[h] = '${' + n + '}'; out.placeholders.push(n); }
        }
      } else {
        entry.type = 'stdio';
        entry.command = def.command;
        if (def.args && def.args.length) entry.args = def.args;
        if (def.cwd) entry.cwd = def.cwd;
        if (def.env && def.env.length) {
          entry.env = {};
          for (const k of def.env) { entry.env[k] = '${' + k + '}'; out.placeholders.push(k); }
        }
      }
      let name = serverName(c.name);
      const have = Object.keys(doc.mcpServers).find((k) => k.toLowerCase() === name.toLowerCase());
      if (have) {
        const old = doc.mcpServers[have] || {};
        if ((old.command || '') === (entry.command || '') && JSON.stringify(old.args || []) === JSON.stringify(entry.args || []) && (old.url || '') === (entry.url || '')) {
          out.same.push(have);
          continue;
        }
        let alt = serverName(name + '-' + c.loc.tool), i = 2;
        while (Object.keys(doc.mcpServers).some((k) => k.toLowerCase() === alt.toLowerCase())) alt = serverName(name + '-' + c.loc.tool + '-' + i++);
        out.renamed.push({ from: name, to: alt });
        name = alt;
      }
      doc.mcpServers[name] = entry;
      out.added.push(name);
    }
    const tmp = file + '.new-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, file);
  });
  out.placeholders = [...new Set(out.placeholders)].sort();
  const have = out.placeholders.filter((n) => process.env[n]);
  if (out.placeholders.length) {
    notes.push('MCP servers name ' + out.placeholders.length + ' secret(s): ' + out.placeholders.join(', ') + '. ' +
      (have.length ? have.join(', ') + ' already set in your environment, used as is. ' : '') +
      'Put any other in the "secrets" section of ' + file + ', or set it as an environment variable.');
  }
  out.fromEnvironment = have;
  return out;
}

// ------------------------------------------------------------------ instructions

/** A file's own text, without the block an earlier AionDX setup wrote into it. */
function withoutBlock(text) {
  const re = new RegExp('\\n*' + BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g');
  return text.replace(/\r\n/g, '\n').replace(re, '\n');
}

function assemble(plan, harvest, notes) {
  const files = plan.items.filter((l) => l.kind === 'instructions').map((l) => ({ l, text: withoutBlock(readText(l.path)), mtime: fs.statSync(l.path).mtimeMs }));
  files.sort((a, b) => b.mtime - a.mtime);
  const sections = [];
  let removed = 0;
  const seen = new Set();
  if (plan.prefs) sections.push({ source: null, title: 'My instructions for every agent', text: scrub(plan.prefs).text });
  for (const f of files) {
    const norm = f.text.replace(/\r\n/g, '\n').trim();
    if (!norm) continue;
    if (seen.has(norm)) { notes.push(f.l.path + ' is the same as a file already included; left out once.'); continue; }
    seen.add(norm);
    const s = scrub(norm);
    removed += s.n;
    sections.push({ source: f.l.path, title: 'From ' + f.l.toolName + ' (' + f.l.path.replace(HOME, '~') + ', modified ' + new Date(f.mtime).toISOString().slice(0, 10) + ')', text: s.text });
  }
  if (removed) notes.push(removed + ' string(s) that looked like keys or tokens were left out of AIONDX.md.');
  return { sections, removed };
}

function render(sections, date) {
  const lines = ['# AionDX instructions', '',
    '<!-- Assembled by AionDX setup on ' + date + '. The master copy for every agent; each agent\'s own file gets it between the AionDX markers. -->', ''];
  for (const s of sections) lines.push('## ' + s.title, '', s.text.trim(), '');
  return lines.join('\n');
}

/** AIONDX.md into one agent's file, between the markers, without the part that came from that file itself. */
function wire(agent, sections, date, backups, notes) {
  const file = agent.file();
  const own = sections.filter((s) => !(s.source && same(s.source, file)));
  if (!own.length || (own.length === sections.length - 1 && own.every((s) => !s.source) && !own.length)) {
    return { agent: agent.id, name: agent.name, file, skipped: 'nothing it does not already have' };
  }
  if (!own.some((s) => s.text.trim())) return { agent: agent.id, name: agent.name, file, skipped: 'nothing to add' };
  const exists = fs.existsSync(file);
  const before = exists ? readText(file) : '';
  const crlf = /\r\n/.test(before);
  const body = [BEGIN, '<!-- Written by AionDX setup on ' + date + '. The master copy is ~/.aiondx/AIONDX.md; delete from the begin marker to the end marker to take it out. -->', '']
    .concat(own.map((s) => '## ' + s.title + '\n\n' + s.text.trim() + '\n')).concat([END]).join('\n');
  const re = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let after = re.test(before) ? before.replace(/\r\n/g, '\n').replace(re, body) : (before.replace(/\r\n/g, '\n').replace(/\s*$/, '') + (before.trim() ? '\n\n' : '') + body + '\n');
  if (crlf) after = after.replace(/\n/g, '\r\n');
  let backup = null;
  if (exists) {
    backup = path.join(backups, agent.id, path.basename(file));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.aiondx-new';
  fs.writeFileSync(tmp, (exists && fs.readFileSync(file).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '﻿' : '') + after);
  fs.renameSync(tmp, file);
  return { agent: agent.id, name: agent.name, file, created: !exists, backup };
}

// ------------------------------------------------------------------ the run

function main() {
  const survey = loadSurvey();
  let plan;
  if (flag('--all')) plan = allPlan(survey);
  else {
    const pf = opt('--plan');
    if (!pf) throw new Error('--plan <plan.json> or --all is required');
    plan = JSON.parse(readText(pf));
  }
  const p = checkPlan(survey, plan);
  const date = stamp();
  const harvest = path.join(AIONDX, 'harvest', date);
  const backups = path.join(harvest, 'backups', clock());
  fs.mkdirSync(harvest, { recursive: true });
  const notes = [];
  const skipped = [];
  const copied = [];
  const organized = {};
  for (const l of p.items) {
    const dst = harvestPath(harvest, l.tool, l.path);
    const stats = { files: 0, bytes: 0 };
    try { copyTree(l.path, dst, stats, skipped); } catch (e) { skipped.push({ path: l.path, why: e.message }); continue; }
    copied.push({ tool: l.tool, kind: l.kind, from: l.path, to: dst, files: stats.files, bytes: stats.bytes });
    if (stats.secrets) notes.push(stats.secrets + ' string(s) that looked like keys or tokens were left out of the copy of ' + l.path + '.');
    if (COPY_KINDS.includes(l.kind) && l.type === 'dir' && stats.files) {
      const counts = organized[l.kind] = organized[l.kind] || { added: 0, same: 0, renamed: 0 };
      organize(l.kind, l.tool, dst, counts);
    }
  }
  const ins = assemble(p, harvest, notes);
  const md = path.join(AIONDX, 'AIONDX.md');
  let mdBackup = null;
  if (ins.sections.length) {
    if (fs.existsSync(md)) { mdBackup = path.join(backups, 'AIONDX.md'); fs.mkdirSync(path.dirname(mdBackup), { recursive: true }); fs.copyFileSync(md, mdBackup); }
    fs.writeFileSync(md, render(ins.sections, date));
  }
  let mcp;
  try { mcp = importMcp(p.mcp, notes); } catch (e) { mcp = { file: path.join(AIONDX, 'mcp', 'servers.json'), added: [], same: [], renamed: [], placeholders: [], failed: [{ name: '*', why: e.message }] }; }
  const wired = ins.sections.length ? p.wire.map((a) => { try { return wire(a, ins.sections, date, backups, notes); } catch (e) { return { agent: a.id, name: a.name, file: a.file(), error: e.message }; } }) : [];
  const report = path.join(harvest, 'report.md');
  writeReport(report, { survey, p, copied, organized, ins, md, mdBackup, mcp, wired, skipped, notes, date });
  const result = {
    ok: true, date, aiondx: AIONDX, aiondxMd: ins.sections.length ? md : null, report,
    copied: copied.map((c) => ({ tool: c.tool, kind: c.kind, from: c.from, files: c.files })), organized,
    instructions: ins.sections.map((s) => s.title), secretsRemoved: ins.removed,
    mcp: { file: mcp.file, added: mcp.added, same: mcp.same, renamed: mcp.renamed, failed: mcp.failed, placeholders: mcp.placeholders, fromEnvironment: mcp.fromEnvironment || [] },
    wired, refused: p.refused, skipped: skipped.length, notes,
  };
  console.log(flag('--text') ? textSummary(result) : JSON.stringify(result, null, 1));
  return 0;
}

/** --text: the summary for a person (what an agent shows the user after `aiondx setup apply`). */
function textSummary(r) {
  const L = ['AionDX setup: done.'];
  const byKind = {};
  for (const c of r.copied) byKind[c.kind] = (byKind[c.kind] || 0) + (c.kind === 'instructions' ? 1 : c.files);
  const parts = Object.keys(byKind).filter((k) => byKind[k]).map((k) => byKind[k] + ' ' + (k === 'instructions' ? 'instructions file(s)' : k));
  L.push(parts.length ? 'Brought over: ' + parts.join(', ') + '. The copies are in ' + r.aiondx + '.' : 'Nothing was copied.');
  const wired = r.wired.filter((w) => !w.skipped && !w.error);
  if (r.aiondxMd) L.push('Instructions for every agent: ' + r.aiondxMd + (wired.length ? '; written into ' + wired.map((w) => w.name + ' (' + w.file + ')').join(', ') : '') + '.');
  for (const w of r.wired.filter((x) => x.error)) L.push(w.name + ' was not changed: ' + w.error + '.');
  const m = r.mcp;
  if (m.added.length || m.same.length) L.push('MCP servers in ' + m.file + ': ' + (m.added.join(', ') || 'none new') + (m.same.length ? ' (already there: ' + m.same.join(', ') + ')' : '') + '. No chat loads them.');
  for (const x of m.failed) L.push('MCP server not added: ' + x.name + ' (' + x.why + ').');
  const need = m.placeholders.filter((n) => !m.fromEnvironment.includes(n));
  if (m.fromEnvironment.length) L.push('Keys already in the environment, used as they are: ' + m.fromEnvironment.join(', ') + '.');
  if (need.length) L.push('Keys still needed: ' + need.join(', ') + '. Put each in the "secrets" section of ' + m.file + ', or set it as an environment variable.');
  if (r.secretsRemoved) L.push(r.secretsRemoved + ' key-like string(s) were left out of the instructions.');
  for (const x of r.refused) L.push('Left out: ' + x.path + ' (' + x.why + ').');
  L.push('Report, with how to undo each change: ' + r.report);
  return L.join('\n');
}

function writeReport(file, r) {
  const L = ['# AionDX setup report, ' + r.date, ''];
  L.push('## Brought over', '');
  if (!r.copied.length) L.push('Nothing was copied.');
  for (const c of r.copied) L.push('- ' + c.kind + ' from ' + c.from + ': ' + c.files + ' file(s), copied to ' + c.to);
  for (const k of Object.keys(r.organized)) { const o = r.organized[k]; L.push('- ~/.aiondx/' + k + '/: ' + o.added + ' new, ' + o.same + ' already there, ' + o.renamed + ' kept beside an older or newer one of the same name'); }
  L.push('', '## Instructions', '');
  if (r.ins.sections.length) {
    L.push('~/.aiondx/AIONDX.md holds, in this order:');
    for (const s of r.ins.sections) L.push('- ' + s.title);
    if (r.mdBackup) L.push('', 'The AIONDX.md from before is kept at ' + r.mdBackup + '.');
  } else L.push('No instructions were chosen, so AIONDX.md was left as it was.');
  L.push('', '## MCP servers', '');
  L.push('Added to ' + r.mcp.file + ': ' + (r.mcp.added.join(', ') || 'none') + '.');
  if (r.mcp.same.length) L.push('Already there: ' + r.mcp.same.join(', ') + '.');
  for (const x of r.mcp.renamed) L.push(x.from + ' is there with another command, so this one is ' + x.to + '.');
  for (const x of r.mcp.failed) L.push('Not added: ' + x.name + ' (' + x.why + ').');
  L.push('No chat loads these; an agent uses one when you ask it to (aiondx mcp tools NAME, aiondx mcp call NAME TOOL).');
  L.push('', '## Changed outside ~/.aiondx', '');
  const changed = r.wired.filter((w) => !w.skipped && !w.error);
  if (!changed.length) L.push('Nothing.');
  for (const w of changed) {
    L.push('- ' + w.name + ': ' + w.file + (w.created ? ' (made new)' : '') + '. To undo: ' +
      (w.backup ? 'copy ' + w.backup + ' back over it, or ' : '') + 'delete everything from "' + BEGIN + '" to "' + END + '".');
  }
  for (const w of r.wired.filter((x) => x.skipped || x.error)) L.push('- ' + w.name + ': ' + (w.error ? 'not changed, ' + w.error : 'not changed, ' + w.skipped) + '.');
  if (r.notes.length || r.p.refused.length) {
    L.push('', '## For you to check', '');
    for (const n of r.notes) L.push('- ' + n);
    for (const x of r.p.refused) L.push('- Left out: ' + x.path + ' (' + x.why + ').');
  }
  L.push('', r.skipped.length + ' file(s) or folder(s) were left out of the copies: secret-looking files, dependency and version-control folders, links, or past the size limits.');
  fs.writeFileSync(file, L.join('\n') + '\n');
}

try { process.exit(main()); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); }
