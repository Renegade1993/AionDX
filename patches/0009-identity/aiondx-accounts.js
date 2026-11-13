'use strict';
// aiondx-accounts.js (patches/0009-identity): adding a Claude account from the new-chat page's "+ Add account" (R-119, 2026-11-13).
//
// The user names the account and picks what it may do before the sign-in starts:
//   full     Claude subscription, full sign-in (claude auth login --claudeai): model calls, Claude Docs and connectors, claude.ai skills,
//            file upload; it keeps a renewal key, so it stays current by itself.
//   token    Claude subscription, model calls only (claude setup-token): a long-lived key for model calls and nothing else.
//   console  Anthropic Console, API billing (claude auth login --console).
//   Options: --sso (the organisation's single sign-on) and --email (filled in on the sign-in page).
// Claude Code fixes the scopes each kind asks for; the dialog says which, and this checks afterwards which were granted.
//
// The account signs in to its own folder, %USERPROFILE%\.claude-<name>, so it never touches the PC's other sign-ins. After the sign-in,
// verify reads what was saved and asks Claude Code itself: for full and console, .credentials.json's keys (access and renewal), their
// expiry and the granted scopes, then `claude auth status --json`; for token, the key Claude Code printed is taken from its output,
// written to <folder>\aiondx-oauth-token (never sent to the page), and checked with `claude auth status --json` under that key.
// save then adds it to the Claude launcher's accounts (claude-account-router.config.json) and to AionDX's projects registry
// (accountDocs.<name>: Claude Docs and connectors on or off for chats on this account). Nothing here prints or returns a key.
//
// Requests (ipc "aiondx:accounts"): start {name, kind, sso, email} | poll | code {code} | cancel | verify {name} |
//   save {name, label, kind, docs, domain} | list.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_\-]{20,}/;
const SCOPE_WORDS = {
  'user:inference': 'model calls', 'user:profile': 'your profile (name, plan)', 'user:sessions:claude_code': 'Claude Code sessions',
  'user:mcp_servers': 'connectors, Claude Docs among them', 'user:file_upload': 'file upload', 'user:plugins': 'plugins',
};
const KIND_ASKS = {
  full: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins'],
  token: ['user:inference'],
  console: ['user:inference', 'user:profile'],
};

function plain(s) { return String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); }
function linkIn(s) { const m = /https:\/\/\S+/.exec(s); return m ? m[0].replace(/[)\].,]+$/, '') : null; }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function create(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const findClaude = o.findClaude || (() => {
    const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
      const f = path.join(d.replace(/^"|"$/g, ''), 'claude.exe');
      try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
    }
    const native = path.join(home, '.local', 'bin', 'claude.exe');
    return fs.existsSync(native) ? native : null;
  });
  const routerDir = o.routerDir || (() => {
    if (process.env.AIONDX_ROUTER_DIR) return process.env.AIONDX_ROUTER_DIR;
    const dirs = [process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'AionDX', 'bin') : '', process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : ''];
    return dirs.find((d) => d && fs.existsSync(path.join(d, 'claude-account-router.js'))) || null;
  });
  const dataDir = o.dataDir || (() => null);
  const spawn = o.spawn || cp.spawn;
  const execFile = o.execFile || cp.execFile;
  const folderOf = (name) => path.join(home, '.claude-' + name);
  const tokenFileOf = (name) => path.join(folderOf(name), 'aiondx-oauth-token');
  const envFor = (dir, token) => {
    const env = Object.assign({}, process.env);
    for (const k of ['ELECTRON_RUN_AS_NODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AIONUI_CONVERSATION_ID', 'AIONDX_CONVERSATION_ID']) delete env[k];
    env.CLAUDE_CONFIG_DIR = dir;
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = dir;
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return env;
  };
  let run = null;   // { child, out, code, name, kind, started }

  async function start(req) {
    const name = String(req.name || '');
    if (!NAME_RE.test(name)) return { ok: false, error: 'Give the account a short name: letters, digits and dashes (for example work2).' };
    const kind = KIND_ASKS[req.kind] ? req.kind : 'full';
    if (run && run.code === null) return { ok: false, error: 'A sign-in is already going; finish it or cancel it first.' };
    const exe = findClaude();
    if (!exe) return { ok: false, error: 'Claude Code is not installed on this PC.' };
    const dir = folderOf(name);
    fs.mkdirSync(dir, { recursive: true });
    const args = kind === 'token' ? ['setup-token'] : ['auth', 'login', kind === 'console' ? '--console' : '--claudeai'];
    if (kind !== 'token' && req.sso) args.push('--sso');
    const email = String(req.email || '').trim();
    if (kind !== 'token' && email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { ok: false, error: 'That email address does not look right.' };
      args.push('--email', email);
    }
    const child = spawn(exe, args, { env: envFor(dir), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const r = { child, out: '', code: null, name, kind, started: Date.now() };
    run = r;
    const take = (d) => { if (r.out.length < 40000) r.out += d; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { r.out += String(e && e.message || e); r.code = -1; });
    child.on('exit', (code) => {
      r.code = code === null ? -1 : code;
      clearTimeout(r.timer);
      // the long-lived key setup-token prints: kept in the account's own folder, never handed to the page
      if (r.kind === 'token') {
        const m = TOKEN_RE.exec(plain(r.out));
        if (m) { try { fs.writeFileSync(tokenFileOf(r.name), m[0]); } catch { /* verify says so */ } }
        r.out = plain(r.out).replace(new RegExp(TOKEN_RE.source, 'g'), '(key saved)');
      }
    });
    r.timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 600000);
    for (let i = 0; i < 60 && r.code === null && !linkIn(plain(r.out)); i++) await new Promise((res) => setTimeout(res, 250));
    const url = linkIn(plain(r.out));
    return { ok: r.code === null || r.code === 0, url, kind, folder: dir };
  }

  function poll() {
    if (!run) return { ok: true, state: 'none' };
    const text = plain(run.out).replace(new RegExp(TOKEN_RE.source, 'g'), '(key saved)').slice(-600);
    if (run.code === null) return { ok: true, state: 'running', asksCode: /paste|code/i.test(text), text };
    return { ok: true, state: run.code === 0 ? 'done' : 'failed', text };
  }

  function code(req) {
    if (!run || run.code !== null) return { ok: false, error: 'No sign-in is waiting for a code.' };
    const c = String(req.code || '').trim();
    if (!c || c.length > 2000 || /[\r\n]/.test(c)) return { ok: false, error: 'That does not look like a sign-in code.' };
    run.child.stdin.write(c + '\n');
    return { ok: true };
  }

  function cancel() {
    if (run && run.code === null) { try { run.child.kill(); } catch { /* gone */ } }
    return { ok: true };
  }

  function authStatus(dir, token) {
    const exe = findClaude();
    if (!exe) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(exe, ['auth', 'status', '--json'], { env: envFor(dir, token), windowsHide: true, timeout: 30000 }, (err, stdout) => {
        let j = null;
        try { j = JSON.parse(stdout); } catch { /* no answer */ }
        resolve(j);
      });
    });
  }

  /** What the sign-in saved, checked: the keys, their expiry, the scopes granted, and Claude Code's own answer with them. */
  async function verify(req) {
    const name = String(req.name || '');
    if (!NAME_RE.test(name)) return { ok: false, error: 'Which account?' };
    const dir = folderOf(name);
    const token = (() => { try { const t = fs.readFileSync(tokenFileOf(name), 'utf8').trim(); return TOKEN_RE.test(t) ? t : null; } catch { return null; } })();
    const cred = ((readJson(path.join(dir, '.credentials.json')) || {}).claudeAiOauth) || null;
    const out = { ok: false, name, folder: dir, kind: null, key: '', renewsUntil: 0, expiresAt: 0, scopes: [], scopeWords: [], missing: [], loggedIn: false, email: '', plan: '', method: '' };
    if (cred && cred.accessToken) {
      out.kind = 'full';
      const renew = !!cred.refreshToken && !(Number(cred.refreshTokenExpiresAt) > 0 && Number(cred.refreshTokenExpiresAt) < Date.now());
      out.key = renew ? 'sign-in key with a renewal key' : (cred.refreshToken ? 'sign-in key whose renewal key has run out' : 'sign-in key without a renewal key');
      out.renewsUntil = renew ? Number(cred.refreshTokenExpiresAt) || 0 : 0;
      out.expiresAt = Number(cred.expiresAt) || 0;
      out.scopes = Array.isArray(cred.scopes) ? cred.scopes.slice() : [];
      out.plan = cred.subscriptionType || '';
      out.renews = renew;
    } else if (token) {
      out.kind = 'token';
      out.key = 'long-lived key for model calls';
      out.scopes = ['user:inference'];
    }
    if (!out.kind) { out.error = 'No key was saved for this account. The sign-in did not finish; start it again.'; return out; }
    const want = KIND_ASKS[req.kind] || KIND_ASKS[out.kind];
    out.scopeWords = out.scopes.map((s) => SCOPE_WORDS[s] || s);
    out.missing = want.filter((s) => out.scopes.indexOf(s) < 0).map((s) => SCOPE_WORDS[s] || s);
    const st = await authStatus(dir, out.kind === 'token' ? token : null);
    if (st) { out.loggedIn = !!st.loggedIn; out.email = st.email || ''; out.plan = st.subscriptionType || out.plan; out.method = st.authMethod || ''; out.org = st.orgName || ''; }
    out.ok = out.loggedIn && (out.kind === 'token' || out.renews !== false);
    if (!out.loggedIn) out.error = 'Claude Code does not accept the saved key. Start the sign-in again.';
    return out;
  }

  /** The verified account into the launcher's accounts and the projects registry. */
  function save(req) {
    const name = String(req.name || '');
    if (!NAME_RE.test(name)) return { ok: false, error: 'Which account?' };
    const dir = routerDir();
    if (!dir) return { ok: false, error: 'AionDX’s Claude launcher is not installed, so there is no account list to add it to.' };
    const file = path.join(dir, 'claude-account-router.config.json');
    let cfg = {};
    if (fs.existsSync(file)) { cfg = readJson(file); if (!cfg) return { ok: false, error: 'The launcher’s settings file is not readable, so nothing was changed.' }; }
    if (!cfg.accounts || typeof cfg.accounts !== 'object') cfg.accounts = {};
    const domain = req.domain === 'work' ? 'work' : 'personal';
    let label = String(req.label || name).trim().slice(0, 40) || name;
    // the launcher tells a work account from a personal one by its label (projectSetup: /work/i)
    if (domain === 'work' && !/work/i.test(label)) label += ' (work)';
    if (domain === 'personal' && /work/i.test(label)) return { ok: false, error: 'A personal account’s name cannot contain "work"; AionDX would treat it as a work account.' };
    const entry = { label, configDir: folderOf(name), addedBy: 'aiondx', addedAt: Date.now() };
    if (req.kind === 'token') { entry.signIn = 'token'; entry.tokenFile = tokenFileOf(name); }
    cfg.accounts[name] = Object.assign({}, cfg.accounts[name] || {}, entry);
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-accounts');
    fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2));
    fs.renameSync(file + '.tmp', file);
    const dd = dataDir();
    if (dd) {
      const rf = path.join(dd, 'aiondx-projects.json');
      const reg = readJson(rf) || { version: 1, skillRoots: [], projects: {}, bindings: {} };
      reg.accountDocs = reg.accountDocs && typeof reg.accountDocs === 'object' ? reg.accountDocs : {};
      reg.accountDocs[name] = req.docs && req.kind !== 'token' ? 'on' : 'off';
      if (fs.existsSync(rf)) fs.copyFileSync(rf, rf + '.bak-accounts');
      fs.writeFileSync(rf + '.tmp', JSON.stringify(reg, null, 2));
      fs.renameSync(rf + '.tmp', rf);
    }
    return { ok: true, name, label, domain, docs: !!(req.docs && req.kind !== 'token') };
  }

  /** The accounts the launcher knows that AionDX added, for the new-chat page's pills and the chats' account menu. */
  function list() {
    const dir = routerDir();
    const cfg = dir ? readJson(path.join(dir, 'claude-account-router.config.json')) : null;
    const out = [];
    for (const [id, a] of Object.entries((cfg && cfg.accounts) || {})) {
      if (!a || a.addedBy !== 'aiondx' || !NAME_RE.test(id)) continue;
      out.push({ id, label: a.label || id, kind: a.signIn === 'token' ? 'token' : 'full' });
    }
    return { ok: true, accounts: out };
  }

  async function handle(req) {
    const op = req && req.op;
    if (op === 'start') return start(req);
    if (op === 'poll') return poll();
    if (op === 'code') return code(req);
    if (op === 'cancel') return cancel();
    if (op === 'verify') return verify(req);
    if (op === 'save') return save(req);
    if (op === 'list') return list();
    return { ok: false, error: 'unknown request' };
  }
  return { handle, folderOf, tokenFileOf };
}

function install(electron) {
  const svc = create({ dataDir: () => electron.app.getPath('userData') });
  electron.ipcMain.handle('aiondx:accounts', async (_e, req) => {
    try { return await svc.handle(req || {}); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

module.exports = { install, create, NAME_RE, TOKEN_RE, SCOPE_WORDS, KIND_ASKS };
