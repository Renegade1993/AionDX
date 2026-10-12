#!/usr/bin/env node
/**
 * claude-model-catalog.js - keeps a Claude account's model picker current without anyone running a tool (AionDX, a request of 2026-10-11).
 *
 * Until now the picker's list of explicit versions (claude-opus-5-5, claude-haiku-5-5 ...) was written by hand with
 * tools\sync-claude-model-catalog.js whenever Anthropic shipped a model, and went stale in between. Claude Code itself knows what an account can
 * use: its `initialize` control reply names every model the account is offered, the exact build each alias resolves to today (`resolvedModel`),
 * and each model's effort levels. Asking costs no inference and no call of AionDX's own to Anthropic: it is Claude Code answering.
 *
 * What it does for one Claude config folder:
 *   1. starts the newest Claude Code in a scratch config folder (no `availableModels` allowlist, so the answer is the whole offer; the folder's
 *      sign-in files are copied in and the secure-store key stays the real folder's), sends `initialize`, reads `models`;
 *   2. builds the allowlist: the aliases the CLI offers (opus, fable, sonnet, haiku ...), each alias's resolved build and, where the
 *      family had a 1M-context twin before, that twin, then every entry that was already there (nothing the user could pick is taken away);
 *   3. writes <config folder>\settings.json `availableModels` only when the list changed (every other key kept, atomic write, the previous
 *      file kept as settings.json.bak-<time>, the newest three backups of this kind kept);
 *   4. saves what it learned in <config folder>\aiondx-models.json: when, the CLI version, each model with its effort levels and flags.
 *
 * The router (claude-account-router.js) starts it, detached and hidden, when a Claude chat starts and the saved file is older than six hours
 * (30 minutes after a failure). It is a short run, not a service: a 45-second deadline kills the child and ends the process, a second
 * start while one is running is refused, and it touches nothing outside the config folder. Switch it off with "modelCatalog": false in the
 * router config. By hand:
 *
 *   node claude-model-catalog.js --config-dir DIR [--exe claude.exe] [--force] [--dry-run] [--max-age-hours 6]
 *
 * The folder's sign-in comes from the environment as the router sets it for a chat (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN, HOME).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const STAMP = 'aiondx-models.json';
const DEADLINE_MS = 45000;
const FRESH_MS = 6 * 3600000;
const RETRY_MS = 30 * 60000;
const RUNNING_MS = 2 * 60000;

/** The newest Claude Code the router would run: the native build, else claude on PATH. */
function findExe() {
  const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(native)) return native;
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(d, 'claude.exe');
    if (d && fs.existsSync(f)) return f;
  }
  return null;
}

/** Ask Claude Code for its `initialize` reply. Resolves { models, version } or rejects with a short reason. */
function askClaude(exe, env, cwd, exeArgs, hold) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, (exeArgs || []).concat(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']),
      { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '', settled = false, tick = null;
    const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); if (tick) clearInterval(tick); try { child.kill(); } catch (e) { /* gone */ } fn(v); };
    const timer = setTimeout(() => end(reject, new Error('no answer within ' + DEADLINE_MS / 1000 + ' s')), DEADLINE_MS);
    child.on('error', (e) => end(reject, e));
    child.on('exit', () => end(reject, new Error('claude exited before answering')));
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.type === 'control_response' && j.response && j.response.request_id === 'aiondx-init') {
          if (j.response.subtype === 'error') { end(reject, new Error(String(j.response.error || 'initialize refused'))); return; }
          const r = j.response.response || {};
          const got = { models: Array.isArray(r.models) ? r.models : [], version: r.claude_code_version || '' };
          if (!hold) { end(resolve, got); return; }
          // Warm-up: Claude Code renews the account's cached server data a few seconds after it starts, in the background. Stay
          // until that cache has moved (or hold.ms has passed), so the next launch reads the account's current offer.
          clearTimeout(timer);
          const started = Date.now();
          tick = setInterval(() => {
            if (hold.changed() || Date.now() - started > hold.ms) end(resolve, got);
          }, 500);
          return;
        }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'aiondx-init', request: { subtype: 'initialize' } }) + '\n');
  });
}

/** The 1M-context twin rule: a new build gets "[1m]" when an entry of its family already had one. */
function familyOf(id) {
  const m = /^claude-([a-z]+)-/.exec(String(id));
  return m ? m[1] : '';
}

/** The allowlist: default, the CLI's aliases, their resolved builds (with a 1M twin where the family had one), then what was already there. */
function buildList(existing, models) {
  const list = [];
  const add = (v) => { if (v && typeof v === 'string' && list.indexOf(v) < 0) list.push(v); };
  if (existing.indexOf('default') >= 0) add('default');   // exempt from the allowlist; kept only where it already was
  models.forEach((m) => { if (m.value && m.value !== 'default') add(m.value); });
  models.forEach((m) => {
    const r = m.resolvedModel;
    if (!r || /\[/.test(r)) return;
    add(r);
    const fam = familyOf(r);
    if (fam && existing.some((e) => /\[1m\]$/.test(e) && familyOf(e) === fam)) add(r + '[1m]');
  });
  existing.forEach(add);
  return list;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Refresh one config folder. opts: { configDir, exe, force, dryRun, maxAgeMs, env, exeArgs (the tests' stand-in for Claude Code) }.
 * Returns { skipped: why } | { changed, added, list, models } and throws on trouble.
 */
async function refresh(opts) {
  const dir = opts.configDir;
  const stampFile = path.join(dir, STAMP);
  const stamp = readJson(stampFile) || {};
  const now = Date.now();
  if (!opts.force) {
    const maxAge = opts.maxAgeMs === undefined ? FRESH_MS : opts.maxAgeMs;
    if (stamp.at && now - stamp.at < maxAge) return { skipped: 'fresh' };
    if (stamp.failedAt && now - stamp.failedAt < RETRY_MS) return { skipped: 'tried lately' };
    if (stamp.startedAt && now - stamp.startedAt < RUNNING_MS && stamp.pid && stamp.pid !== process.pid) return { skipped: 'another run is going' };
  }
  const exe = opts.exe || findExe();
  if (!exe) throw new Error('no Claude Code found');
  fs.mkdirSync(dir, { recursive: true });
  if (!opts.dryRun) writeAtomic(stampFile, JSON.stringify(Object.assign({}, stamp, { startedAt: now, pid: process.pid }), null, 2));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-catalog-'));
  try {
    const cfgDir = path.join(scratch, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    for (const f of ['.credentials.json']) { try { fs.copyFileSync(path.join(dir, f), path.join(cfgDir, f)); } catch (e) { /* none */ } }
    // The account's own cache of server data (.claude.json: the extra models an account is offered, Fable 5 in place of Fable 5.1 on some),
    // which lives in the config folder when CLAUDE_CONFIG_DIR is set, and beside the default .claude folder otherwise (a finding of
    // 2026-10-11 on another PC: without it the list is the generic one, not the account's).
    const cacheSrc = [path.join(dir, '.claude.json'), path.join(path.dirname(dir), '.claude.json')].find((p) => fs.existsSync(p));
    const cacheDst = path.join(cfgDir, '.claude.json');
    if (cacheSrc) { try { fs.copyFileSync(cacheSrc, cacheDst); } catch (e) { /* in use: the CLI fetches its own */ } }
    const cacheStamp = () => { const c = readJson(cacheDst) || {}; return String(c.cachedGrowthBookFeaturesAt || '') + '|' + JSON.stringify(c.additionalModelOptionsCache || null); };
    const cacheAge = (() => { const c = readJson(cacheDst) || {}; const t = Date.parse(c.cachedGrowthBookFeaturesAt || '') || Number(c.cachedGrowthBookFeaturesAt) || 0; return t ? Date.now() - t : Infinity; })();
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work, { recursive: true });
    const env = Object.assign({}, opts.env || process.env);
    delete env.AIONUI_CONVERSATION_ID; delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CONFIG_DIR = cfgDir;
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = dir;
    let got;
    if (cacheSrc && cacheAge > FRESH_MS && !opts.noWarm) {   // no cache at all: nothing to renew
      // An old (or missing) cache: one launch that waits for the renewal, then the launch whose answer is used.
      const before = cacheStamp();
      try { await askClaude(exe, env, work, opts.exeArgs, { ms: opts.warmMs || 30000, changed: () => cacheStamp() !== before }); } catch (e) { /* the second launch says what is wrong */ }
    }
    got = await askClaude(exe, env, work, opts.exeArgs);
    if (!got.models.length) throw new Error('Claude Code listed no models (not signed in?)');
    const settingsFile = path.join(dir, 'settings.json');
    const settings = readJson(settingsFile);
    if (fs.existsSync(settingsFile) && !settings) throw new Error('settings.json is not valid JSON; left alone');
    const existing = settings && Array.isArray(settings.availableModels) ? settings.availableModels.filter((x) => typeof x === 'string') : [];
    const built = buildList(existing, got.models);
    const added = built.filter((x) => existing.indexOf(x) < 0);
    // Nothing new: the list stays exactly as the user (or an earlier run) left it, order included, and the file is not touched.
    const list = added.length ? built : existing.slice();
    const reordered = false;
    const changed = added.length > 0;
    const snapshot = {
      at: Date.now(), claudeCodeVersion: got.version, written: list,
      models: got.models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel || null, displayName: m.displayName || '', description: m.description || '',
        efforts: m.supportedEffortLevels || [], fast: !!m.supportsFastMode, adaptiveThinking: !!m.supportsAdaptiveThinking })),
    };
    if (opts.dryRun) return { changed, added, list, models: snapshot.models, reordered, dryRun: true };
    if (changed) {
      if (fs.existsSync(settingsFile)) {
        fs.copyFileSync(settingsFile, settingsFile + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));
        const baks = fs.readdirSync(dir).filter((n) => /^settings\.json\.bak-\d{14}$/.test(n)).sort();
        baks.slice(0, Math.max(0, baks.length - 3)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* in use */ } });
      }
      const next = Object.assign({}, settings || {}, { availableModels: list });
      writeAtomic(settingsFile, JSON.stringify(next, null, 2) + '\n');
    }
    writeAtomic(stampFile, JSON.stringify(snapshot, null, 2));
    return { changed, added, list, models: snapshot.models, reordered };
  } catch (e) {
    if (!opts.dryRun) { try { writeAtomic(stampFile, JSON.stringify(Object.assign({}, stamp, { failedAt: Date.now(), failed: String(e.message).slice(0, 200) }), null, 2)); } catch (x) { /* folder unwritable */ } }
    throw e;
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* in use */ }
  }
}

module.exports = { refresh, buildList, familyOf, askClaude, STAMP };

if (require.main === module) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const dir = val('--config-dir') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const hours = val('--max-age-hours');
  const hard = setTimeout(() => process.exit(4), 2 * DEADLINE_MS + 45000);   // the kill switch: two launches and the warm-up wait, then out
  hard.unref();
  refresh({ configDir: dir, exe: val('--exe'), force: a.includes('--force'), dryRun: a.includes('--dry-run'), maxAgeMs: hours ? Number(hours) * 3600000 : undefined })
    .then((r) => {
      if (r.skipped) { if (process.stdout.isTTY) console.log('skipped: ' + r.skipped); process.exit(0); }
      if (process.stdout.isTTY || a.includes('--dry-run')) {
        console.log((r.dryRun ? 'would write ' : 'wrote ') + r.list.length + ' entries; ' + (r.changed ? 'new: ' + (r.added.join(', ') || '(order only)') : 'no change'));
        r.models.forEach((m) => console.log('  ' + String(m.value).padEnd(10) + ' -> ' + String(m.resolvedModel).padEnd(20) + ' efforts ' + m.efforts.join('/')));
      }
      process.exit(0);
    })
    .catch((e) => { if (process.stdout.isTTY || a.includes('--dry-run')) console.log('failed: ' + e.message); process.exit(1); });
}
