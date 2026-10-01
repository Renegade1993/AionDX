#!/usr/bin/env node
/**
 * claude-account-router - picks the right Claude account AND the newest Claude Code
 * binary before launching claude.exe.
 *
 * WHY THIS EXISTS
 * AionUi routes `backend='claude'` conversations through its direct-CLI path, which spawns
 * plain `claude` from PATH using AionUi's own HOME and ignores the agent's configured
 * command. That is what silently billed both AionUi agents to the main account.
 * It does, however, inject AIONUI_CONVERSATION_ID into that process. This router reads it,
 * looks up which agent owns the conversation, and sets HOME/USERPROFILE and the OAuth token
 * for that account before handing off.
 *
 * That lets both AionUi agents keep backend='claude' (so mid-turn typing and everything else
 * gated on it work natively) while still billing the correct org.
 *
 * WHY IT ALSO PICKS THE BINARY  (AionDX patch 0002, 2026-09-22)
 * Which models AionUi offers is decided entirely by the Claude Code build this router hands
 * off to. The picker is not a list AionUi owns: the ACP bridge asks the Agent SDK, the SDK
 * asks the CLI, and Anthropic's API refuses a model the CLI predates, with "Claude Code
 * <old> does not support this model; version <new> or newer is required".
 *
 * The original router hardcoded the npm-installed binary, and npm never self-updates. The
 * native build under ~\.local\bin does self-update (autoUpdatesChannel in settings.json,
 * plus `claude install latest`). Preferring whichever binary reports the higher version means
 * a newly released model becomes selectable in AionUi on its own, for both accounts, with no
 * edit to this file.
 *
 * The version probe is cached against each file's size and mtime, so an ordinary launch costs
 * one small JSON read and no extra process spawn.
 *
 * SAFETY
 * Every failure path falls through to launching claude.exe completely unmodified, so a bad
 * database read, a missing token, an unreadable cache, or a bug here degrades to "behaves
 * exactly like stock claude", never to a broken CLI. Binary resolution falls back to the npm
 * path this file used before patch 0002. Outside AionUi (no conversation id) it is a pure
 * passthrough, still on the newest binary.
 *
 * REVERTING
 * Whole router:  copy /Y claude-account-router.js.ORIGINAL claude-account-router.js
 * Binary pick:   set "claudeExe" in claude-account-router.config.json to pin one path.
 * Shim entirely: copy /Y claude.cmd.ORIGINAL claude.cmd
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HERE = __dirname;

// node:sqlite is experimental in Node 22 and 24 and says so on stderr, which AionCore logs as the agent's
// own error output. Only that one warning is dropped (AionDX, 2026-09-26).
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite is an experimental feature/i.test(String((warning && warning.message) || warning))) return;
  return emitWarning.call(process, warning, ...rest);
};

/**
 * The real user profile, which is NOT os.homedir() here.
 *
 * AionUi spawns the second agent with HOME and USERPROFILE pointed at
 * C:\Users\<you>\.claude-second-home (agent_metadata.env), which is how the second account gets
 * its own credential store. This router inherits that environment, so os.homedir() returns
 * the sandbox profile and the native build, which lives under the real profile, is invisible.
 *
 * That is not hypothetical. On 2026-09-22 the first version of this file used os.homedir(),
 * every second-account conversation resolved to a claude.exe that does not exist, spawnSync returned
 * ENOENT, this process exited 1, and AionUi reported UserAgentDisconnected about 79 ms into
 * every turn. Main-account conversations were unaffected, which is what made it look like an
 * account problem rather than a path problem.
 *
 * APPDATA is not rewritten by the wrapper or by AionUi, so it is the stable way back to the
 * real profile: C:\Users\<you>\AppData\Roaming -> C:\Users\<you>.
 */
function realProfileDir() {
  const appdata = process.env.APPDATA;
  if (appdata) {
    const derived = path.dirname(path.dirname(appdata));
    if (derived && derived !== '.') return derived;
  }
  return os.homedir();
}

const NPM_CLAUDE_EXE = path.join(HERE, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const NATIVE_CLAUDE_EXE = path.join(realProfileDir(), '.local', 'bin', 'claude.exe');
// Kept as a last resort for the case where APPDATA is missing and homedir is the sandbox.
const NATIVE_CLAUDE_EXE_HOMEDIR = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const CONFIG = path.join(HERE, 'claude-account-router.config.json');
const EXE_CACHE = path.join(HERE, 'claude-account-router.exe-cache.json');

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { raw: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const x = a.parts[i] || 0;
    const y = b.parts[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Version of `exe`, cached against its size and mtime so an unchanged binary is never
 *  probed twice. Returns null when the file is missing or will not report a version. */
function versionOf(exe, cache) {
  let st;
  try {
    st = fs.statSync(exe);
  } catch {
    return null;
  }
  const key = exe.toLowerCase();
  const hit = cache[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.version) {
    return parseVersion(hit.version);
  }
  const probe = spawnSync(exe, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  const version = parseVersion(probe.stdout);
  if (!version) return null;
  cache[key] = { size: st.size, mtimeMs: st.mtimeMs, version: version.raw };
  return version;
}

/** An explicit config pin wins outright. Otherwise the highest-versioned candidate wins.
 *  Native is listed first so a tie, or a binary that will not report a version, still
 *  lands on the build that self-updates.
 *
 *  Note that `claude install` DELETES the npm package (observed 2026-09-22: it removed
 *  node_modules\@anthropic-ai\claude-code and the claude.cmd shim with it), so the npm
 *  candidate is usually absent. It stays in the list because a later `npm i -g
 *  @anthropic-ai/claude-code` puts it back, and on that day it may be the newer one. */
/** Every claude.exe on PATH that is Claude Code itself: folders holding an AionDX launcher (this one, or the
 *  copy in %APPDATA%\npm) are skipped, so the search can never land back on a shim. For a PC whose Claude Code
 *  came from somewhere other than its own installer or npm (winget, say). */
function claudeOnPath() {
  const out = [];
  for (const d of String(process.env.PATH || '').split(';')) {
    const dir = d.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    try {
      if (path.resolve(dir).toLowerCase() === path.resolve(HERE).toLowerCase()) continue;
      if (fs.existsSync(path.join(dir, 'claude-account-router.js'))) continue;
      const exe = path.join(dir, 'claude.exe');
      if (fs.existsSync(exe) && !out.some((x) => x.toLowerCase() === exe.toLowerCase())) out.push(exe);
    } catch { /* an unreadable PATH entry */ }
  }
  return out;
}

function resolveClaudeExe(cfg) {
  const GLOBAL_NPM_CLAUDE_EXE = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const candidates = [NATIVE_CLAUDE_EXE, NPM_CLAUDE_EXE, GLOBAL_NPM_CLAUDE_EXE, NATIVE_CLAUDE_EXE_HOMEDIR].concat(claudeOnPath());
  try {
    const pinned = cfg && typeof cfg.claudeExe === 'string' ? cfg.claudeExe.trim() : '';
    if (pinned && fs.existsSync(pinned)) return { exe: pinned, why: 'pinned' };

    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(EXE_CACHE, 'utf8')) || {};
    } catch { /* first run, or unreadable: probe fresh */ }
    const before = JSON.stringify(cache);

    let best = null;
    let bestVersion = null;
    for (const candidate of candidates) {
      const version = versionOf(candidate, cache);
      if (!version) continue;
      if (!bestVersion || isNewer(version, bestVersion)) {
        best = candidate;
        bestVersion = version;
      }
    }

    if (JSON.stringify(cache) !== before) {
      try { fs.writeFileSync(EXE_CACHE, JSON.stringify(cache, null, 2)); } catch { /* cache is only an optimization */ }
    }

    if (best) return { exe: best, why: bestVersion.raw };
  } catch { /* fall through to whatever is on disk */ }

  // Nothing reported a version. Use the first candidate that at least exists, so a CLI
  // that refuses `--version` still launches instead of failing the conversation.
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return { exe: candidate, why: 'unprobed' }; } catch { /* keep looking */ }
  }

  // Nothing exists. Do NOT fall back to `claude` from PATH: the shim beside this file re-enters
  // this router, which would recurse instead of failing. Return the real-profile native path so
  // the error names a real location, and log it as a hard miss.
  return { exe: NATIVE_CLAUDE_EXE, why: 'fallback-nothing-found' };
}

let RESOLVED = { exe: NATIVE_CLAUDE_EXE, why: 'fallback' };

// ---------------------------------------------------------------------------
// Moving a session between accounts (AionDX, 2026-09-25)
// ---------------------------------------------------------------------------

function routerLog(line) {
  try { fs.appendFileSync(path.join(HERE, 'claude-account-router.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* never fatal */ }
}

/** When this launch resumes a session (--resume <id>), make sure the account about to run it has
 *  the newest copy of its transcript, copied from whichever account's config folder has the most
 *  recent one. The folder name under projects\ comes from the working folder, which is the same
 *  whichever account runs the chat. Any failure leaves things as they were: Claude then reports
 *  the session missing and AionCore starts a fresh one, which is what happened before this. */
function carryTranscript(targetDir, dirs) {
  try {
    const i = args.indexOf('--resume');
    const id = i >= 0 ? args[i + 1] : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !targetDir) return;
    if (!dirs.some((d) => d.toLowerCase() === targetDir.toLowerCase())) dirs = dirs.concat([targetDir]);
    if (dirs.length < 2) return;
    // The folder Claude files this working folder's sessions under; checked first, then every folder.
    const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
    let best = null;
    for (const d of dirs) {
      const root = path.join(d, 'projects');
      let subs = [];
      try { subs = fs.existsSync(path.join(root, slug, id + '.jsonl')) ? [slug] : fs.readdirSync(root); } catch { continue; }
      for (const sub of subs) {
        const f = path.join(root, sub, id + '.jsonl');
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) best = { f, sub, dir: d, mtimeMs: st.mtimeMs };
      }
    }
    if (!best || best.dir.toLowerCase() === targetDir.toLowerCase()) return;
    const dstDir = path.join(targetDir, 'projects', best.sub);
    const dst = path.join(dstDir, id + '.jsonl');
    try { if (fs.statSync(dst).mtimeMs >= best.mtimeMs) return; } catch { /* not there yet */ }
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(best.f, dst);
    const side = path.join(path.dirname(best.f), id);   // its subagents and tool-results
    if (fs.existsSync(side)) fs.cpSync(side, path.join(dstDir, id), { recursive: true, force: true });
    // The chat's own memory folder (Claude keeps one per working folder), only where there is none yet.
    const mem = path.join(path.dirname(best.f), 'memory');
    if (fs.existsSync(mem) && !fs.existsSync(path.join(dstDir, 'memory'))) fs.cpSync(mem, path.join(dstDir, 'memory'), { recursive: true });
    routerLog(`carried session ${id} from ${best.dir} to ${targetDir}`);
  } catch (e) {
    routerLog(`could not carry the session transcript: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Any agent, not just two accounts (AionDX, 2026-09-26)
// ---------------------------------------------------------------------------
// K: "it seems you built it around my use case specifically. it needs to be omni-compatible. it needs
// to draw on the same list of available agents (dynamically) as is shown on the 'new chat' screen".
// The renderer's pill writes aiondx.agent.conv.<conversation id> = {agent: <agent_id>} for a chat moved
// to another Claude agent. Every agent AionUi knows keeps its own environment in agent_metadata.env
// (HOME, CLAUDE_CONFIG_DIR and so on: that is what puts two Claude agents on two accounts), and AionCore
// hands a chat's process its own agent's. So a moved chat gets the chosen agent's environment in place of
// its own agent's. A config file's named accounts (token files; K's machine) still win where they exist.

const DEFAULT_DB = path.join(process.env.APPDATA || path.join(realProfileDir(), 'AppData', 'Roaming'), 'AionUi', 'aionui', 'aionui-backend.db');

/** What the database says about this chat: its agent, its user, any per-chat choice, and every Claude
 *  agent's environment. Read-only; any failure leaves the fields empty. */
function readChat(dbPath, convId) {
  const out = { agentId: null, userId: null, chosenAgent: null, chosenAccount: null, envs: {} };
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT extra, user_id FROM conversations WHERE id = ?').get(convId);
    if (row) {
      out.userId = row.user_id;
      try { out.agentId = (JSON.parse(row.extra || '{}') || {}).agent_id || null; } catch { /* no agent */ }
    }
    const pref = (key) => {
      try {
        const r = db.prepare('SELECT value FROM client_preferences WHERE key = ? AND user_id = ?').get(key, out.userId);
        return r && r.value ? JSON.parse(r.value) : null;
      } catch { return null; }
    };
    const a = pref('aiondx.agent.conv.' + convId);
    if (a) out.chosenAgent = typeof a === 'string' ? a : (a.agent || null);
    const b = pref('aiondx.account.conv.' + convId);   // the first version's per-chat account (2026-09-25)
    if (b) out.chosenAccount = typeof b === 'string' ? b : (b.account || null);
    try {
      const rows = db.prepare("SELECT agent_id, env, user_id FROM agent_metadata WHERE backend = 'claude' AND (user_id = ? OR user_id IS NULL)").all(out.userId);
      for (const r of rows) {
        let e = [];
        try { e = JSON.parse(r.env || '[]'); } catch { e = []; }
        if (!out.envs[r.agent_id] || r.user_id) out.envs[r.agent_id] = Array.isArray(e) ? e : [];
      }
    } catch { /* an older database: no per-agent env */ }
  } catch { /* database busy or missing */ }
  finally { try { if (db) db.close(); } catch { /* closed */ } }
  return out;
}

/** The chosen agent's environment in place of this chat's agent's: what the chat's agent set and the
 *  chosen one does not is put back (HOME and USERPROFILE to the real profile) or removed. */
function swapAgentEnv(env, fromList, toList) {
  const to = new Map((toList || []).filter((e) => e && e.name).map((e) => [String(e.name), String(e.value == null ? '' : e.value)]));
  for (const e of fromList || []) {
    if (!e || !e.name || to.has(String(e.name))) continue;
    if (/^(HOME|USERPROFILE)$/i.test(e.name)) env[e.name] = realProfileDir();
    else delete env[e.name];
  }
  for (const [k, v] of to) env[k] = v;
}

/** Every folder a Claude session of this user could live in: each account's and each Claude agent's
 *  CLAUDE_CONFIG_DIR, and the default one. */
function claudeDirs(cfg, facts) {
  const dirs = [path.join(realProfileDir(), '.claude')];
  const add = (d) => { if (d && !dirs.some((x) => x.toLowerCase() === String(d).toLowerCase())) dirs.push(String(d)); };
  for (const a of Object.values((cfg && cfg.accounts) || {})) add(a && a.configDir);
  for (const list of Object.values(facts.envs || {})) {
    for (const e of list) if (e && e.name === 'CLAUDE_CONFIG_DIR') add(e.value);
    const home = list.find((e) => e && /^(HOME|USERPROFILE)$/i.test(e.name));
    if (home && !list.some((e) => e && e.name === 'CLAUDE_CONFIG_DIR')) add(path.join(String(home.value), '.claude'));
  }
  return dirs;
}

function handOff(env) {
  const r = spawnSync(RESOLVED.exe, args, {
    stdio: 'inherit',
    env: env || process.env,
    windowsHide: true,
  });
  if (r.error) { console.error(r.error.message); process.exit(1); }
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

/** AionCore's own session (stream-json in and out) runs Claude behind the pass-through in
 *  claude-stream-proxy.js, so a message Claude has not read yet can be taken back (AionDX,
 *  2026-09-25). "streamProxy": false in the config switches it off. Any trouble loading it: the
 *  plain launch above, on the same account. */
function isStreamSession() {
  const i = args.indexOf('--input-format');
  return i >= 0 && args[i + 1] === 'stream-json';
}
/** The account this launch belongs to, for the usage meter (October 1st, 2026: the numbers now come from Claude's own
 *  traffic through the proxy's loopback tap, claude-stream-proxy.js, so no call of AionDX's own is made). All the
 *  meter needs is a store key and a label: the key is a hash (of the token, else of the credentials file's path, else of
 *  the config folder's), the label the config's account name or the plan ("Pro", "Max") from the credentials file.
 *  The token itself goes along only when the config asks for the old direct probe ("usageProbe": true), which called
 *  the API with it and is off (Anthropic's terms do not permit a Free, Pro or Max OAuth token in any tool but Claude
 *  Code). "usageMeter": false switches the meter off. */
function usageFor(env, cfg, label) {
  if ((cfg && cfg.usageMeter === false) || process.env.AIONDX_NO_USAGE === '1') return null;
  const probe = !!(cfg && cfg.usageProbe === true);
  const hash = (s) => require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 12);
  const named = /^(its own agent|account|agent .*)$/.test(String(label || '')) ? '' : String(label || '');
  const token = String(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (token) return Object.assign({ key: hash(token), label: named, probe }, probe ? { token } : {});
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || realProfileDir(), '.claude');
  const file = path.join(dir, '.credentials.json');
  let plan = '', hasToken = false;
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
    if (o && o.accessToken) { hasToken = true; plan = String(o.subscriptionType || ''); }
  } catch { /* a login kept in the system's secure store has no file: the meter does not need one */ }
  const lab = named || (plan ? plan[0].toUpperCase() + plan.slice(1) : '');
  if (hasToken) return Object.assign({ key: hash('file:' + path.resolve(file).toLowerCase()), label: lab, probe }, probe ? { tokenFile: file } : {});
  return { key: hash('dir:' + path.resolve(dir).toLowerCase()), label: lab, probe: false };
}
function proxyOff(env, convId, dbPath, usage, cfg) {
  let proxy;
  try {
    proxy = require(path.join(HERE, 'claude-stream-proxy.js'));
  } catch (e) {
    routerLog(`conv=${convId} stream proxy unavailable (${e.message}); plain launch`);
    handOff(env);
    return;
  }
  const headers = process.env.AIONUI_RUNTIME_TOKEN ? {
    'x-aionui-runtime-token': process.env.AIONUI_RUNTIME_TOKEN,
    'x-aionui-user-id': process.env.AIONUI_USER_ID || '',
    'x-aionui-conversation-id': convId,
  } : null;
  proxy.startProxy({
    exe: RESOLVED.exe, args, env, convId, database: dbPath, usage,
    tap: !(cfg && cfg.usageTap === false), approve: !(cfg && cfg.autoApprove === false),   // each can be switched off in the config
    apiBase: String(process.env.AIONUI_BASE_URL || '').replace(/\/+$/, ''), apiHeaders: headers,
    log: (m) => routerLog(`conv=${convId} ${m}`),
  }).then((code) => process.exit(code), () => process.exit(1));
}

// ---- everything below is best-effort; any throw lands in the catch and passes through ----
try {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch { /* no config: still route to the newest binary, stock account behaviour */ }

  RESOLVED = resolveClaudeExe(cfg);

  const convId = process.env.AIONUI_CONVERSATION_ID;
  if (!convId) handOff(null); // not an AionUi conversation: stock behaviour

  const dbPath = (cfg && cfg.database) || DEFAULT_DB;
  const facts = readChat(dbPath, convId);
  const accounts = (cfg && cfg.accounts) || {};
  const agentId = facts.agentId;
  const env = Object.assign({}, process.env);
  let chosen = facts.chosenAgent && facts.chosenAgent !== agentId ? facts.chosenAgent : null;
  let account = null;
  let label;
  if (chosen && accounts[chosen]) account = accounts[chosen];
  else if (!chosen && facts.chosenAccount && accounts[facts.chosenAccount]) { account = accounts[facts.chosenAccount]; chosen = facts.chosenAccount; }
  else if (!chosen && cfg && cfg.accounts && agentId) account = accounts[agentId] || accounts[cfg.defaultAccount] || null;

  if (account) {
    // A named account from the config (K's machine: token files). HOME picks the credential store; an
    // account without its own home gets the real profile when the chat was moved to it.
    const home = account.home || (chosen ? realProfileDir() : null);
    if (home) { env.HOME = home; env.USERPROFILE = home; }
    if (account.configDir) {
      env.CLAUDE_CONFIG_DIR = account.configDir;
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = account.configDir;
    }
    if (account.tokenFile && fs.existsSync(account.tokenFile)) {
      const tok = fs.readFileSync(account.tokenFile, 'utf8').trim();
      if (tok) { env.CLAUDE_CODE_OAUTH_TOKEN = tok; env.ANTHROPIC_AUTH_TOKEN = tok; }
    }
    delete env.ANTHROPIC_API_KEY;
    label = account.label || 'account';
  } else if (chosen) {
    // Any other Claude agent AionUi knows: its own environment in place of this chat's agent's.
    swapAgentEnv(env, facts.envs[agentId], facts.envs[chosen]);
    if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    label = 'agent ' + chosen;
  } else {
    label = 'its own agent';
  }

  // Resuming a session: bring the newest copy of its transcript to the folder about to run it first.
  // Claude keeps a session under <config dir>\projects\<folder>\<id>.jsonl, so a chat that moved would
  // otherwise find nothing, and AionCore would start it over with no memory of the chat.
  carryTranscript(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || realProfileDir(), '.claude'), claudeDirs(cfg, facts));

  // Always log the decision. One short line per launch, and it is the only durable record of
  // which account actually answered a conversation and which build served it. Trimmed so it
  // cannot grow unbounded.
  try {
    const logFile = path.join(HERE, 'claude-account-router.log');
    const build = RESOLVED.exe.toLowerCase().includes('.local') ? 'native' : 'npm';
    fs.appendFileSync(logFile, `${new Date().toISOString()} conv=${convId} agent=${agentId}${chosen ? ' chosen=' + chosen : ''} -> ${label} [cli ${RESOLVED.why} ${build}]\n`);
    const st = fs.statSync(logFile);
    if (st.size > 512 * 1024) {
      const keep = fs.readFileSync(logFile, 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(logFile, keep);
    }
  } catch { /* logging must never break a launch */ }

  if (!(cfg && cfg.streamProxy === false) && isStreamSession()) proxyOff(env, convId, dbPath, usageFor(env, cfg, label), cfg);
  else handOff(env);
} catch (e) {
  if (process.env.CLAUDE_ROUTER_DEBUG === '1') {
    try { fs.appendFileSync(path.join(HERE, 'claude-account-router.log'), `${new Date().toISOString()} ERROR ${e.message}\n`); } catch {}
  }
  handOff(null);
}
