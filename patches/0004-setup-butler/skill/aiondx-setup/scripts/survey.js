#!/usr/bin/env node
/**
 * survey.js: the read-only inventory step of the aiondx-setup skill.
 *
 *   node survey.js                 print a summary, write the full inventory as JSON
 *   node survey.js --json          print the JSON instead of the summary
 *   node survey.js --out <file>    where to write the JSON (default ~/.aiondx/harvest/<date>/survey.json)
 *   node survey.js --home <dir>    pretend <dir> is the home folder (tests)
 *
 * Why a script and not the agent's own file tools: the harvest must never read secrets, never
 * leave the catalog's locations and never enter a folder the user excluded. Those rules live here,
 * in code, so they hold whichever model runs the skill.
 *
 * What it records, per catalog location: whether it exists, file or folder, size, last modified,
 * and for folders the entry names (not contents). MCP config files are the one exception: it parses
 * them for server names, commands and arguments, and drops every env value. Secret-looking files
 * (.env, auth, credentials, tokens, keys) are listed by name only and never opened. Environment
 * variables are reported by name only.
 *
 * Bread crumbs (Windows): non-Microsoft scheduled tasks, Run keys, the Startup folder, PATH entries
 * inside the user's profile and the agent CLIs found there, global npm packages, VS Code AI
 * extensions, and hand-kept script registries.
 *
 * Deadline 90 s; every child process has its own timeout and no window.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const HOME = opt('--home') ? path.resolve(opt('--home')) : os.homedir();
const PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'catalog.json'), 'utf8'));
const MAX_ENTRIES = 60;

setTimeout(() => { console.error('survey: 90 s deadline passed, stopping'); process.exit(2); }, 90000).unref();

const SECRET_NAME = /(^|[\\/._-])(\.env(\..*)?|auth[^\\/]*\.json|credentials?[^\\/]*|secrets?[^\\/]*|tokens?[^\\/]*\.json|.*\.(key|pem|p12|pfx)|id_(rsa|ed25519)[^\\/]*|keychain[^\\/]*|oauth[^\\/]*\.json)$/i;
const AI_NAME = /claude|codex|gemini|qwen|opencode|cursor|windsurf|codeium|cline|roo|continue|aider|copilot|devin|kiro|amp|goose|anthropic|openai|ollama|lmstudio|aionui|aiondx|mcp/i;
const KEY_ENV = /(API_KEY|_TOKEN|_SECRET|ANTHROPIC|OPENAI|GEMINI|GOOGLE_(API|CLOUD|GENAI)|AZURE_OPENAI|MISTRAL|GROQ|DEEPSEEK|OPENROUTER|XAI_|MOONSHOT|DASHSCOPE|QWEN|AIONUI|CLAUDE)/i;

function expand(p) {
  if (!p) return null;
  let s = p.replace(/^~(?=$|[\\/])/, HOME);
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, v) => {
    if (v.toUpperCase() === 'USERPROFILE' || v.toUpperCase() === 'HOME') return HOME;
    if (opt('--home') && /^(APPDATA|LOCALAPPDATA)$/i.test(v)) return path.join(HOME, 'AppData', v.toUpperCase() === 'APPDATA' ? 'Roaming' : 'Local');
    return process.env[v] || m;
  });
  s = s.replace(/\$(HOME|XDG_CONFIG_HOME)\b/g, (m, v) => (v === 'HOME' ? HOME : process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')));
  return path.normalize(s);
}

function loadExclusions() {
  const f = path.join(HOME, '.aiondx', 'exclusions.txt');
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { lines = []; }
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => path.normalize(expand(l)).toLowerCase());
}
const EXCLUDED = loadExclusions();
const isExcluded = (p) => { const x = path.normalize(p).toLowerCase(); return EXCLUDED.some((e) => x === e || x.startsWith(e.endsWith(path.sep) ? e : e + path.sep)); };

function stat(p) { try { return fs.statSync(p); } catch { return null; } }
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : null);

function describe(p, loc) {
  const r = { path: p, exists: false };
  if (isExcluded(p)) return Object.assign(r, { excluded: true });
  const st = stat(p);
  if (!st) return r;
  r.exists = true;
  r.modified = iso(st.mtime);
  if (st.isDirectory()) {
    r.type = 'dir';
    let names = [];
    try { names = fs.readdirSync(p); } catch (e) { r.error = 'unreadable'; return r; }
    let newest = 0;
    const entries = [];
    for (const n of names) {
      const full = path.join(p, n);
      if (isExcluded(full)) continue;
      const s = stat(full);
      if (!s) continue;
      if (s.mtimeMs > newest) newest = s.mtimeMs;
      if (entries.length < MAX_ENTRIES) entries.push(n + (s.isDirectory() ? '/' : '') + (SECRET_NAME.test(n) ? '  (secret-looking, not read)' : ''));
    }
    r.entries = entries;
    r.count = names.length;
    r.newestInside = newest ? iso(newest) : null;
  } else {
    r.type = 'file';
    r.size = st.size;
    if (SECRET_NAME.test(path.basename(p))) r.secretLooking = true;
    else if (loc && loc.kind === 'mcp') r.mcp = readMcp(p, loc);
  }
  return r;
}

// MCP servers: names, commands, args, urls. Never env values, headers or anything under them.
function readMcp(p, loc) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { error: 'unreadable' }; }
  const servers = [];
  if (/\.toml$/i.test(p)) {
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      // [mcp_servers.name] or [mcp_servers."dotted.name"]; a sub-table such as
      // [mcp_servers.name.env] ends the server and its lines are skipped.
      const h = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/);
      if (h) { cur = { name: h[1] || h[2] }; servers.push(cur); continue; }
      if (/^\s*\[/.test(line)) { cur = null; continue; }
      if (!cur) continue;
      const kv = line.match(/^\s*(command|args|url)\s*=\s*(.+)$/);
      if (kv) cur[kv[1]] = kv[2].trim();
    }
    return { servers };
  }
  let j;
  try { j = JSON.parse(text.replace(/^﻿/, '')); } catch { return { error: 'not JSON' }; }
  const keys = (loc.mcpKeys || ['mcpServers', 'servers', 'mcp.servers', 'context_servers']);
  for (const k of keys) {
    const node = k.split('.').reduce((o, part) => (o && typeof o === 'object' ? o[part] : undefined), j);
    if (!node || typeof node !== 'object') continue;
    const list = Array.isArray(node) ? node.map((v, i) => [v && v.name || String(i), v]) : Object.entries(node);
    for (const [name, v] of list) {
      if (!v || typeof v !== 'object') continue;
      const s = { name };
      if (typeof v.command === 'string') s.command = v.command;
      if (Array.isArray(v.args)) s.args = v.args.map(String);
      if (typeof v.url === 'string') s.url = v.url.replace(/([?&](key|token|api[_-]?key)=)[^&]+/ig, '$1<hidden>');
      if (typeof v.type === 'string') s.type = v.type;
      if (v.env && typeof v.env === 'object') s.envNames = Object.keys(v.env);
      if (v.headers && typeof v.headers === 'object') s.headerNames = Object.keys(v.headers);
      servers.push(s);
    }
  }
  return { servers };
}

function run(cmd, argv, timeout = 20000) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

function breadcrumbs() {
  const out = {};
  const envNames = Object.keys(process.env).filter((k) => KEY_ENV.test(k)).sort();
  out.environmentVariableNames = envNames;
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const inProfile = pathDirs.filter((d) => path.normalize(d).toLowerCase().startsWith(HOME.toLowerCase()));
  out.pathEntriesInProfile = inProfile.map((d) => {
    const st = stat(d);
    let shims = [];
    if (st && st.isDirectory() && !isExcluded(d)) {
      try { shims = fs.readdirSync(d).filter((n) => AI_NAME.test(n)).slice(0, 40); } catch { shims = []; }
    }
    return { dir: d, exists: !!st, aiShims: shims };
  });
  for (const r of CATALOG.registries || []) {
    const p = expand(r[PLATFORM] || r.win);
    if (p) (out.scriptRegistries = out.scriptRegistries || []).push(describe(p, null));
  }
  if (opt('--home')) return out;               // tests: no system queries
  if (PLATFORM === 'win') {
    const csv = run('schtasks.exe', ['/query', '/fo', 'csv', '/nh']);
    out.scheduledTasks = [...new Set(csv.split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter((t) => t && !/^\\Microsoft\\/i.test(t)))].slice(0, 80);
    const runKey = run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
    out.runKeyEntries = runKey.split(/\r?\n/).map((l) => l.trim()).filter((l) => /REG_(SZ|EXPAND_SZ)/.test(l)).map((l) => l.split(/\s{2,}/)[0]);
    const startup = expand('%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
    out.startupFolder = describe(startup, null).entries || [];
  }
  const npm = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '-g', '--depth=0', '--json'], 30000);
  try { out.globalNpmAi = Object.keys(JSON.parse(npm).dependencies || {}).filter((n) => AI_NAME.test(n)); } catch { out.globalNpmAi = []; }
  const ext = expand('~/.vscode/extensions');
  const ed = describe(ext, null);
  out.vscodeAiExtensions = (ed.entries || []).filter((n) => AI_NAME.test(n));
  return out;
}

function main() {
  const tools = [];
  for (const t of CATALOG.tools) {
    const locs = [];
    for (const loc of t.locations) {
      const p = expand(loc[PLATFORM] || (PLATFORM === 'linux' ? loc.mac : null));
      if (!p) continue;
      locs.push(Object.assign({ kind: loc.kind, note: loc.note || undefined }, describe(p, loc)));
    }
    const found = locs.filter((l) => l.exists);
    tools.push({ id: t.id, name: t.name, installed: found.length > 0, locations: locs });
  }
  const result = {
    at: new Date().toISOString(), home: HOME, platform: PLATFORM,
    exclusions: EXCLUDED, tools, breadcrumbs: breadcrumbs(),
  };
  const date = result.at.slice(0, 10);
  const outFile = opt('--out') || path.join(HOME, '.aiondx', 'harvest', date, 'survey.json');
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 1)); }
  catch (e) { console.error('survey: could not write ' + outFile + ': ' + e.message); }
  if (flag('--json')) { console.log(JSON.stringify(result, null, 1)); return 0; }
  const lines = ['AionDX setup survey, ' + date + ' (read-only; full detail in ' + outFile + ')', ''];
  for (const t of tools.filter((x) => x.installed)) {
    lines.push(t.name + ':');
    for (const l of t.locations.filter((x) => x.exists)) {
      const extra = l.type === 'dir' ? l.count + ' entries, newest ' + l.newestInside : (l.size + ' bytes' + (l.mcp && l.mcp.servers ? ', MCP servers: ' + l.mcp.servers.map((s) => s.name).join(', ') : ''));
      lines.push('  ' + l.kind + '  ' + l.path + '  (' + extra + ', modified ' + l.modified + ')' + (l.secretLooking ? '  secret-looking, not read' : ''));
    }
  }
  const missing = tools.filter((x) => !x.installed).map((x) => x.name);
  if (missing.length) lines.push('', 'Not found: ' + missing.join(', '));
  const b = result.breadcrumbs;
  lines.push('', 'Bread crumbs:');
  lines.push('  key-like environment variables (names only): ' + (b.environmentVariableNames.join(', ') || 'none'));
  for (const d of b.pathEntriesInProfile) if (d.aiShims.length) lines.push('  PATH ' + d.dir + ': ' + d.aiShims.join(', '));
  if (b.scheduledTasks) lines.push('  scheduled tasks (non-Microsoft): ' + b.scheduledTasks.length);
  if (b.runKeyEntries) lines.push('  Run key entries: ' + (b.runKeyEntries.join(', ') || 'none'));
  if (b.globalNpmAi && b.globalNpmAi.length) lines.push('  global npm AI packages: ' + b.globalNpmAi.join(', '));
  if (b.vscodeAiExtensions && b.vscodeAiExtensions.length) lines.push('  VS Code AI extensions: ' + b.vscodeAiExtensions.length);
  for (const r of b.scriptRegistries || []) if (r.exists) lines.push('  script registry: ' + r.path + ' (modified ' + r.modified + ')');
  console.log(lines.join('\n'));
  return 0;
}

process.exit(main());
