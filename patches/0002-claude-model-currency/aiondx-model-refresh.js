#!/usr/bin/env node
/**
 * aiondx-model-refresh.js - every agent's model picker current at AionDX's start, without anyone opening a chat (a request of 2026-10-11,
 * from a package built on another PC; AionDX should "do this for every agent type across the software as well eventually").
 *
 * The picker is a cache. For a Claude agent AionUi shows agent_metadata.available_models and the `model` and `reasoning_effort` selects in
 * agent_metadata.config_options, and AionCore rewrites them only when a chat of that agent starts. An agent nobody opens keeps an old list:
 * a new model never shows, a renamed one keeps its old name. This program does what AionCore would do at a chat start, for every agent, at
 * AionDX's start (patch 0009 starts it, hidden, with the Node.js AionDX ships) and again every twelve hours while AionDX is open:
 *
 *   1. for each Claude agent, the environment its chats get (the account router's mapping for that agent, else the agent's own variables,
 *      else the default profile), with inherited tokens and AionUi variables taken out first;
 *   2. claude-model-catalog.js for that account's config folder (when its saved catalog is over six hours old): the account's whole offer from
 *      Claude Code's `initialize`, new models added to the folder's availableModels;
 *   3. one more `initialize` with the account's real config folder, which is the list a chat would get, and the agent's rows rewritten in
 *      AionCore's own shape: available_models {available_models:[{id,label,reasoning_efforts}], current_model_id}; the `model` select's options
 *      {value,name,description}; the `reasoning_effort` select's options from EVERY model that has effort levels (AionCore builds it from the
 *      remembered model only, so an agent last left on a model without them lost the select), "ultracode" where a model has xhigh, as AionCore does.
 *      The remembered model and effort stay when they still exist. A row is written only when it changed. Agents on one account share
 *      their launches. Disabled agents are refreshed too (their stale names used to leak into the pickers).
 *
 * Providers. A provider is { id, backends, refresh(ctx) }; Claude is the first. Another agent type is added by writing its provider.
 *
 * Safety. Only available_models, config_options and updated_at are written, and only when the table has the columns and the old values
 * parse as this shape; anything else is left alone and logged. One run at a time (a lock file). A 4-minute deadline ends the process. Every
 * Claude launch is bounded (claude-model-catalog.js). Nothing is sent to a model.
 *
 *   node aiondx-model-refresh.js [--dry-run] [--force] [--no-update] [--db FILE] [--config FILE] [--exe claude.exe]
 *
 * Before the pickers, each provider's update step keeps its CLI current where nothing else does (Claude Code installed with npm).
 *
 * Log: %LOCALAPPDATA%\AionDX\logs\model-refresh.log (newest 400 lines kept).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const catalog = require('./claude-model-catalog.js');

const DEADLINE_MS = 4 * 60000;
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
/** The chats database: AionDX's own data folder, or an earlier AionUi folder that is still being used in place, under the file name
 *  AionCore writes now or the one an earlier version wrote (AionDX, 2026-11-01). The first that exists; the current one's path if none does. */
function findBackendDb(appData) {
  const names = ['aiondx-backend.db', 'aionui-backend.db']; // legacy-name
  const dirs = [path.join(appData, 'AionDX', 'aionui'), path.join(appData, 'AionUi', 'aionui')]; // legacy-name
  for (const n of names) for (const d of dirs) { const f = path.join(d, n); try { if (require('fs').existsSync(f)) return f; } catch (e) { /* next */ } }
  return path.join(dirs[0], names[0]);
}
const DB = val('--db') || findBackendDb(APPDATA);
const LOG_DIR = process.env.AIONDX_REFRESH_LOG_DIR || path.join(LOCAL, 'AionDX', 'logs');
const LOG = path.join(LOG_DIR, 'model-refresh.log');
const LOCK = path.join(LOG_DIR, 'model-refresh.lock');

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  if (process.stdout.isTTY || DRY) console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
    const st = fs.statSync(LOG);
    if (st.size > 200 * 1024) fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').split('\n').slice(-400).join('\n'));
  } catch (e) { /* the log never stops a run */ }
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return undefined; } };

// ---- which Claude Code: the newest real build (never a launcher), as the router chooses it
function claudeCandidates() {
  const out = [];
  const add = (p) => { try { if (p && fs.existsSync(p) && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p); } catch (e) { /* unreadable */ } };
  const pkg = (dir) => path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  add(path.join(path.dirname(path.dirname(APPDATA)), '.local', 'bin', 'claude.exe'));
  add(pkg(path.join(APPDATA, 'npm')));
  add(pkg(path.join(LOCAL, 'Programs', 'nodejs')));
  for (const d of String(process.env.PATH || '').split(';').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    add(pkg(d));
    try { if (!fs.existsSync(path.join(d, 'claude-account-router.js'))) add(path.join(d, 'claude.exe')); } catch (e) { /* unreadable */ }
  }
  return out;
}
function versionOf(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function newestClaude() {
  let best = null, bestV = null;
  for (const c of claudeCandidates()) {
    const v = versionOf(c);
    if (!v) continue;
    if (!bestV || v[0] > bestV[0] || (v[0] === bestV[0] && (v[1] > bestV[1] || (v[1] === bestV[1] && v[2] > bestV[2])))) { best = c; bestV = v; }
  }
  return best ? { exe: best, version: bestV.join('.') } : null;
}

// ---- the environment a chat of this agent gets
function routerConfig() {
  const explicit = val('--config');
  for (const f of [explicit, path.join(__dirname, 'claude-account-router.config.json'), path.join(APPDATA, 'npm', 'claude-account-router.config.json')]) {
    if (f && fs.existsSync(f)) { const c = readJson(f); if (c) return c; }
  }
  return null;
}
function envFor(row, cfg) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (/^AIONDX_/i.test(k) || /^(CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)$/i.test(k)) delete env[k];
  }
  const list = (s) => { const v = parse(s); return Array.isArray(v) ? v : []; };
  for (const e of list(row.env).concat(list(row.env_override))) if (e && typeof e.name === 'string' && typeof e.value === 'string') env[e.name] = e.value;
  const acct = cfg && cfg.accounts ? cfg.accounts[row.agent_id] : null;
  if (acct) {
    if (acct.home) { env.HOME = acct.home; env.USERPROFILE = acct.home; }
    if (acct.configDir) { env.CLAUDE_CONFIG_DIR = acct.configDir; env.CLAUDE_SECURESTORAGE_CONFIG_DIR = acct.configDir; }
    if (acct.tokenFile) { try { const t = fs.readFileSync(acct.tokenFile, 'utf8').trim(); if (t) env.CLAUDE_CODE_OAUTH_TOKEN = t; } catch (e) { /* missing file: the folder's own sign-in */ } }
  }
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || path.dirname(path.dirname(APPDATA)), '.claude');
  return { env, dir };
}

// ---- AionCore's shapes
function effortsOf(m) { return Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((x) => typeof x === 'string') : []; }
// AionCore adds the synthetic `ultracode` level to a model that has xhigh, and only then (claude_conn.rs, the initialize reply).
function withUltra(list) { return list.indexOf('xhigh') >= 0 && list.indexOf('ultracode') < 0 ? list.concat(['ultracode']) : list; }
function orderEfforts(set) { return EFFORT_ORDER.filter((e) => set.has(e)).concat([...set].filter((e) => EFFORT_ORDER.indexOf(e) < 0)); }

/** The two new column values for one row, from the models a chat of it would get; null when the old values are not the expected shape. */
function shapeRow(row, models) {
  const am = parse(row.available_models || 'null');
  const co = parse(row.config_options || '[]');
  if (am !== null && (typeof am !== 'object' || (am.available_models !== undefined && !Array.isArray(am.available_models)))) return null;
  if (!Array.isArray(co)) return null;
  const ids = models.map((m) => m.value);
  const current = am && ids.indexOf(am.current_model_id) >= 0 ? am.current_model_id : 'default';
  const nextAm = {
    available_models: models.map((m) => {
      const e = withUltra(effortsOf(m));
      const o = { id: m.value, label: m.displayName || m.value };
      if (e.length) o.reasoning_efforts = e;
      return o;
    }),
    current_model_id: current,
  };
  const nextCo = co.map((o) => Object.assign({}, o));
  let modelSel = nextCo.find((o) => o && o.id === 'model');
  if (!modelSel) { modelSel = { id: 'model', category: 'model', type: 'select', currentValue: current, options: [] }; nextCo.push(modelSel); }
  modelSel.options = models.map((m) => Object.assign({ value: m.value, name: m.displayName || m.value }, m.description ? { description: m.description } : {}));
  if (ids.indexOf(modelSel.currentValue) < 0) modelSel.currentValue = current;
  const all = new Set();
  models.forEach((m) => withUltra(effortsOf(m)).forEach((e) => all.add(e)));
  let effSel = nextCo.find((o) => o && o.id === 'reasoning_effort');
  if (all.size) {
    if (!effSel) { effSel = { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: null, options: [] }; nextCo.push(effSel); }
    effSel.options = orderEfforts(all).map((e) => ({ value: e, name: e }));
    if (effSel.currentValue != null && !all.has(effSel.currentValue)) effSel.currentValue = null;
  }
  return { available_models: JSON.stringify(nextAm), config_options: JSON.stringify(nextCo) };
}
const sameJson = (a, b) => { const x = parse(a || 'null'), y = parse(b || 'null'); return JSON.stringify(x) === JSON.stringify(y); };

// ---- keeping an npm-installed Claude Code current (a request of 2026-10-11: follow npm's `latest` always)
//
// A native install (%USERPROFILE%\.local\bin) updates itself. An npm install never does, so a new model never reaches its picker (2.1.289
// resolved `haiku` to Haiku 4.5; 2.1.296 to Haiku 5.5). For every npm prefix holding the package: the installed version from its
// package.json, the channel's version from `npm view`, and when that is newer and no claude.exe from the prefix is running, an install
// into a staging folder beside it, a check that the staged claude.exe answers --version, and a swap of the package folder by two renames
// (the old one is put back if the second fails). npm never writes into the real prefix, so a hand-made claude.cmd there (an account
// router) is left alone. "cliUpdate": false in the router config switches it off; "cliChannel" picks the npm tag (default "latest").
const PKG = '@anthropic-ai/claude-code';
function npmRun(argv, timeout) {
  const npm = process.env.AIONDX_NPM || 'npm.cmd';   // AIONDX_NPM: the tests' stand-in (a command line)
  const q = (a) => /[\s"&|<>^]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a;
  return spawnSync(npm + ' ' + argv.map(q).join(' '), [], { encoding: 'utf8', shell: true, windowsHide: true, timeout: timeout || 300000 });
}
function npmPrefixes() {
  const out = [];
  const add = (d) => { try { if (d && fs.existsSync(path.join(d, 'node_modules', ...PKG.split('/'), 'package.json'))) { const r = fs.realpathSync(d); if (!out.some((x) => x.toLowerCase() === r.toLowerCase())) out.push(r); } } catch (e) { /* unreadable */ } };
  if (process.env.AIONDX_NPM_PREFIXES !== undefined) { process.env.AIONDX_NPM_PREFIXES.split(';').forEach(add); return out; }   // tests
  add(path.join(APPDATA, 'npm'));
  add(path.join(LOCAL, 'Programs', 'nodejs'));
  for (const d of String(process.env.PATH || '').split(';').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)) add(d);
  return out;
}
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
function runningFrom(dir) {
  if (process.env.AIONDX_RUNNING_PATHS !== undefined) return process.env.AIONDX_RUNNING_PATHS.split(';').filter((p) => p && p.toLowerCase().startsWith(dir.toLowerCase())).length;   // tests
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((p) => p && p.toLowerCase().startsWith(dir.toLowerCase())).length;
}
function updateNpmClaude(cfg) {
  if (cfg && cfg.cliUpdate === false) { log('claude: CLI updates are switched off ("cliUpdate": false)'); return []; }
  const channel = (cfg && typeof cfg.cliChannel === 'string' && cfg.cliChannel) || 'latest';
  const results = [];
  const prefixes = npmPrefixes();
  if (!prefixes.length) return results;
  let tags = null;
  const v = npmRun(['view', PKG, 'dist-tags', '--json'], 60000);
  try { tags = JSON.parse(v.stdout); } catch (e) { /* offline, or npm missing */ }
  const want = tags && tags[channel];
  if (!want) { log('claude: npm did not say which version is "' + channel + '" (' + String(v.stderr || v.error || '').trim().split(/\r?\n/).pop() + '); no CLI update'); return results; }
  for (const prefix of prefixes) {
    const dest = path.join(prefix, 'node_modules', ...PKG.split('/'));
    const have = (readJson(path.join(dest, 'package.json')) || {}).version;
    if (!have || cmpVer(want, have) <= 0) { log('claude: ' + prefix + ' has ' + have + ' (' + channel + ' is ' + want + ')'); results.push({ prefix, state: 'current', have }); continue; }
    if (DRY) { log('claude: would update ' + prefix + ' from ' + have + ' to ' + want); results.push({ prefix, state: 'would-update' }); continue; }
    if (runningFrom(dest) > 0) { log('claude: ' + prefix + ' has ' + have + '; ' + want + ' waits until no Claude Code from it is running'); results.push({ prefix, state: 'pending' }); continue; }
    const stage = path.join(prefix, '.aiondx-staging');
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      const r = npmRun(['install', '-g', '--prefix', stage, PKG + '@' + want, '--no-fund', '--no-audit']);
      const staged = path.join(stage, 'node_modules', ...PKG.split('/'));
      if (r.status !== 0 || !fs.existsSync(staged)) throw new Error('npm exit ' + r.status + ': ' + String(r.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | '));
      const exe = path.join(staged, 'bin', 'claude.exe');
      const ver = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (ver.status !== 0 || !/\d+\.\d+\.\d+/.test(String(ver.stdout))) throw new Error('the staged claude.exe did not answer --version');
      const old = dest + '.old-' + Date.now();
      fs.renameSync(dest, old);
      try { fs.renameSync(staged, dest); } catch (e) { fs.renameSync(old, dest); throw new Error('swap failed, the old copy is back: ' + e.code); }
      try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { /* removed next run */ }
      log('claude: ' + prefix + ' updated from ' + have + ' to ' + want);
      results.push({ prefix, state: 'updated', have, now: want });
    } catch (e) {
      log('claude: updating ' + prefix + ' failed: ' + e.message);
      results.push({ prefix, state: 'failed', why: e.message });
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* removed next run */ }
      // folders an earlier swap could not delete
      try { for (const n of fs.readdirSync(path.dirname(dest))) if (/^claude-code\.old-\d+$/.test(n)) fs.rmSync(path.join(path.dirname(dest), n), { recursive: true, force: true }); } catch (e) { /* next run */ }
    }
  }
  return results;
}

// ---- the account's model offer that Claude Code can no longer renew (2026-11-11: Fable 5.2 never reached a chat; a request for a fix
// that holds for every future model)
//
// Claude Code's own list has the aliases (fable, opus, sonnet, haiku), each pointing at the newest build its version knows. One entry can be
// replaced by the account's model offer: `additionalModelOptionsCache` in the config folder's .claude.json, which Claude Code fetches from
// Anthropic at start (/api/claude_cli/bootstrap). A chat AionDX starts signs in with the account's token file (CLAUDE_CODE_OAUTH_TOKEN, a
// `claude setup-token` token without the user:profile scope). For such a token the server sends a narrowed answer with no offer, and Claude
// Code then keeps the offer it saved last, with no end date (Claude Code 2.1.322: `C = narrowed && additional_model_options == null`, and
// the saved offer is kept). Measured on November 11th: the main account's offer was last answered on October 12th and named Fable 5.1, so every
// chat listed `claude-fable-5-1[1m]` and never `fable` (Fable 5.2); the second account's named Fable 5. With the offer emptied, the same Claude Code
// listed `fable > claude-fable-5-2` on both accounts.
//
// So in every config folder whose chats sign in with a token, an offer older than a day (no answer can renew it) is emptied, under Claude
// Code's own lock (<file>.lock, a folder), with a copy of the file kept beside it. Claude Code then uses its built-in list, which moves with
// each Claude Code update. An offer answered within the day (a full sign-in, /login) is left alone. Every other key is kept as it was.
const OFFER_FROZEN_MS = 24 * 3600000;
const pauseMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait */ } };
function withConfigLock(file, fn) {
  const lock = file + '.lock';
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // proper-lockfile (Claude Code's) refreshes its lock every few seconds and treats one older than 10 s as abandoned
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch (x) { /* gone */ }
      if (i >= 20) return { busy: true };
      pauseMs(250);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch (e) { /* gone */ } }
}
function thawModelOffer(dir) {
  const file = path.join(dir, '.claude.json');
  const peek = readJson(file);
  if (!peek) return { state: 'none' };
  const offer = peek.additionalModelOptionsCache;
  if (!Array.isArray(offer) || !offer.length) return { state: 'none' };
  const at = typeof peek.additionalModelOptionsAnsweredAt === 'number' ? peek.additionalModelOptionsAnsweredAt : 0;
  if (Date.now() - at < OFFER_FROZEN_MS) return { state: 'fresh' };
  const had = offer.map((o) => o && o.value).filter(Boolean);
  const since = at ? new Date(at).toISOString().slice(0, 10) : 'an unknown date';
  if (DRY) { log('claude: would empty the model offer in ' + file + ' (' + had.join(', ') + ', last answered ' + since + ')'); return { state: 'would-clear', had }; }
  try {
    const r = withConfigLock(file, () => {
      const text = fs.readFileSync(file, 'utf8');
      const c = JSON.parse(text);
      if (!Array.isArray(c.additionalModelOptionsCache) || !c.additionalModelOptionsCache.length) return { state: 'none' };
      const bak = file + '.aiondx-bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.writeFileSync(bak, text);
      const baks = fs.readdirSync(dir).filter((n) => /^\.claude\.json\.aiondx-bak-\d{14}$/.test(n)).sort();
      baks.slice(0, Math.max(0, baks.length - 3)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* in use */ } });
      c.additionalModelOptionsCache = [];
      const tmp = file + '.aiondx-tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
      fs.renameSync(tmp, file);
      return { state: 'cleared', had };
    });
    if (r.busy) { log('claude: ' + file + ' stayed locked; its model offer is emptied next run'); return { state: 'busy' }; }
    if (r.state === 'cleared') log('claude: emptied the model offer in ' + file + ' (' + had.join(', ') + ', last answered ' + since + '; a token sign-in cannot renew it), so Claude Code lists its own newest models');
    return r;
  } catch (e) { log('claude: emptying the model offer in ' + file + ' failed: ' + e.message); return { state: 'failed' }; }
}
/** Each config folder whose chats sign in with a token, once. */
function thawOffers(rows, cfg) {
  const seen = new Set(), out = [];
  for (const row of rows) {
    const e = envFor(row, cfg);
    if (!e.env.CLAUDE_CODE_OAUTH_TOKEN) continue;
    const k = path.resolve(e.dir).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(Object.assign({ dir: e.dir }, thawModelOffer(e.dir)));
  }
  return out;
}

// ---- the Claude provider
const claudeProvider = {
  id: 'claude',
  backends: ['claude'],
  update(ctx) { return updateNpmClaude(routerConfig()); },
  async refresh(ctx) {
    const found = ctx.exe ? { exe: ctx.exe, version: '?' } : newestClaude();
    if (!found) { log('claude: no Claude Code on this PC; nothing to refresh'); return { updates: [] }; }
    const cfg = routerConfig();
    const thawed = thawOffers(ctx.rows, cfg).filter((t) => t.state === 'cleared');
    // --quick (AionDX's runs every 15 minutes): no Claude Code launch when every picker already has every model its account's catalog lists;
    // the full run (at AionDX's start and every 12 hours) asks Claude Code. Added 2026-11-10: the 15-minute run launched Claude Code for each
    // account every time, about 190 launches a day that found nothing.
    if (args.includes('--quick') && !FORCE && !thawed.length) {
      const short = [];
      for (const row of ctx.rows) {
        if (row.enabled === 0) continue;
        let cat = [];
        try { cat = (JSON.parse(fs.readFileSync(path.join(envFor(row, cfg).dir, 'aiondx-models.json'), 'utf8')).models || []).map((m) => m && m.value).filter((v) => v && v !== 'default'); } catch (e) { short.push(row.name || row.agent_id); continue; }
        const am = parse(row.available_models || 'null');
        if (row.enabled === 0 || (am !== null && (typeof am !== 'object' || !Array.isArray(am.available_models)))) continue;   // the full run leaves these alone too
        const have = new Set(am && Array.isArray(am.available_models) ? am.available_models.map((m) => m && m.id) : []);
        if (cat.some((v) => !have.has(v))) short.push(row.name || row.agent_id);
      }
      if (!short.length) { log('claude: quick check: every picker has its account\'s models'); return { updates: [] }; }
      log('claude: quick check: missing models in ' + short.join(', ') + '; asking Claude Code');
    }
    log('claude: Claude Code ' + found.version + ' at ' + found.exe);
    const groups = new Map();   // config folder -> { env, rows }
    for (const row of ctx.rows) {
      const e = envFor(row, cfg);
      const key = path.resolve(e.dir).toLowerCase() + '|' + (e.env.CLAUDE_CODE_OAUTH_TOKEN ? 't' : '');
      if (!groups.has(key)) groups.set(key, { env: e.env, dir: e.dir, rows: [] });
      groups.get(key).rows.push(row);
    }
    const updates = [];
    await Promise.all([...groups.values()].map(async (g) => {
      const names = g.rows.map((r) => r.name || r.agent_id).join(', ');
      try {
        const thawedHere = thawed.some((t) => path.resolve(t.dir).toLowerCase() === path.resolve(g.dir).toLowerCase());
        const c = await catalog.refresh({ configDir: g.dir, exe: found.exe, env: g.env, force: FORCE || thawedHere, dryRun: DRY, exeArgs: ctx.exeArgs });
        if (c.skipped) log('claude: catalog for ' + g.dir + ' ' + c.skipped);
        else log('claude: catalog for ' + g.dir + (c.changed ? ', new in the picker list: ' + c.added.join(', ') : ', no new models'));
      } catch (e) { log('claude: catalog for ' + g.dir + ' failed: ' + e.message); }
      let got;
      try {
        const env = Object.assign({}, g.env, { CLAUDE_CONFIG_DIR: g.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: g.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || g.dir });
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-refresh-'));
        try { got = await catalog.askClaude(found.exe, env, work, ctx.exeArgs); } finally { if (catalog.removeScratch) catalog.removeScratch(work); else { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* in use */ } } }
      } catch (e) { log('claude: the list for ' + names + ' could not be read: ' + e.message); return; }
      if (!got.models.length) { log('claude: Claude Code listed no models for ' + names + ' (not signed in?); rows left alone'); return; }
      // The account catalog's models too (a request of 2026-11-09: "Fable 5.2 didn't get auto-loaded into the interface....fix this
      // systemically"). Asked in the account's real config folder, Claude Code lists models from that folder's cached server data, which can
      // be days old: on November 9th it left out Fable 5.2, Fable 5 and the fable alias, while the catalog (asked with a fresh copy of the same
      // cache) had them. Each catalog model the answer lacks goes in after the catalog model before it.
      try {
        const stamp = JSON.parse(fs.readFileSync(path.join(g.dir, 'aiondx-models.json'), 'utf8'));
        const cat = Array.isArray(stamp && stamp.models) ? stamp.models.filter((m) => m && m.value && m.value !== 'default') : [];
        const have = new Set(got.models.map((m) => m.value));
        const added = [];
        cat.forEach((m, i) => {
          if (have.has(m.value)) return;
          let at = 0;
          for (let j = i - 1; j >= 0; j--) { const k = got.models.findIndex((x) => x.value === cat[j].value); if (k >= 0) { at = k + 1; break; } }
          if (!at) at = Math.min(1, got.models.length);
          got.models.splice(at, 0, { value: m.value, displayName: m.displayName || m.value, description: m.description || '', supportedEffortLevels: Array.isArray(m.efforts) ? m.efforts : [] });
          have.add(m.value);
          added.push(m.value);
        });
        if (added.length) log('claude: from the account catalog, missing from the CLI\'s answer for ' + names + ': ' + added.join(', '));
      } catch (e) { /* no catalog yet: the CLI's answer alone */ }
      for (const row of g.rows) {
        const next = shapeRow(row, got.models);
        if (!next) { log('claude: ' + (row.name || row.agent_id) + ': its stored picker is not in the expected shape; left alone'); continue; }
        if (sameJson(next.available_models, row.available_models) && sameJson(next.config_options, row.config_options)) { log('claude: ' + (row.name || row.agent_id) + ': picker already current (' + got.models.length + ' models)'); continue; }
        updates.push({ id: row.id, name: row.name || row.agent_id, available_models: next.available_models, config_options: next.config_options, count: got.models.length });
      }
    }));
    return { updates };
  },
};
const PROVIDERS = [claudeProvider];

function db(readOnly) { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(DB, { readOnly }); if (!readOnly) d.exec('PRAGMA busy_timeout = 10000'); return d; }

/** The scratch folders earlier runs could not remove: Claude Code still had its working folder open when the run ended, so each start of
 *  AionDX left an empty %TEMP%\aiondx-refresh-* behind (more than 150 by October 24th, 2026). Any older than an hour go now. */
function sweepScratch() {
  const tmp = os.tmpdir();
  let n = 0;
  try {
    for (const e of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^aiondx-(refresh|catalog)-(?!test-)/.test(e.name)) continue;
      const p = path.join(tmp, e.name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3600000) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch (x) { /* in use */ }
    }
  } catch (e) { /* no temp folder */ }
  if (n) log('removed ' + n + ' scratch folder(s) earlier runs left in ' + tmp);
}

async function main(opts) {
  opts = opts || {};
  if (!fs.existsSync(DB)) { log('no AionUi database at ' + DB + '; nothing to do'); return 0; }
  // one run at a time
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const lock = readJson(LOCK);
  if (lock && lock.at && Date.now() - lock.at < DEADLINE_MS + 30000 && lock.pid !== process.pid) { log('another refresh is running (pid ' + lock.pid + ')'); return 0; }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
  sweepScratch();
  try {
    const d0 = db(true);
    let cols, rows;
    try {
      cols = d0.prepare('PRAGMA table_info(agent_metadata)').all().map((c) => c.name);
      const need = ['id', 'agent_id', 'name', 'backend', 'enabled', 'env', 'available_models', 'config_options', 'updated_at'];
      const missing = need.filter((c) => cols.indexOf(c) < 0);
      if (missing.length) { log('the agent table does not have ' + missing.join(', ') + ' (a newer AionCore?); nothing written'); return 0; }
      const ovr = cols.indexOf('env_override') >= 0 ? ', env_override' : '';
      rows = d0.prepare('SELECT id, agent_id, name, backend, enabled, env' + ovr + ', available_models, config_options FROM agent_metadata').all();
    } finally { d0.close(); }
    const all = [];
    for (const p of PROVIDERS) {
      const mine = rows.filter((r) => p.backends.indexOf(r.backend) >= 0);
      if (!mine.length) continue;
      if (p.update && !opts.noUpdate && !args.includes('--no-update')) { try { p.update({}); } catch (e) { log(p.id + ': update failed: ' + e.message); } }
      try { const r = await p.refresh({ rows: mine, exe: opts.exe || val('--exe'), exeArgs: opts.exeArgs }); all.push(...r.updates); }
      catch (e) { log(p.id + ': failed: ' + e.message); }
    }
    if (!all.length) { log('every picker is current'); return 0; }
    if (DRY) { all.forEach((u) => log('would rewrite ' + u.name + ' (' + u.count + ' models)')); return 0; }
    const d1 = db(false);
    try {
      const st = d1.prepare('UPDATE agent_metadata SET available_models = ?, config_options = ?, updated_at = ? WHERE id = ?');
      for (const u of all) { st.run(u.available_models, u.config_options, Date.now(), u.id); log('rewrote ' + u.name + "'s picker (" + u.count + ' models)'); }
    } finally { d1.close(); }
    return 0;
  } finally {
    try { const l = readJson(LOCK); if (l && l.pid === process.pid) fs.unlinkSync(LOCK); } catch (e) { /* gone */ }
  }
}

module.exports = { main, shapeRow, envFor, claudeCandidates, updateNpmClaude, npmPrefixes, thawModelOffer, PROVIDERS };

if (require.main === module) {
  const hard = setTimeout(() => { log('stopped at the 4-minute deadline'); process.exit(4); }, DEADLINE_MS);
  hard.unref();
  process.removeAllListeners('warning');   // node:sqlite's experimental notice
  main().then((code) => process.exit(code), (e) => { log('failed: ' + e.message); process.exit(1); });
}
