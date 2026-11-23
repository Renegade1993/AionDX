#!/usr/bin/env node
/**
 * security-sweep.js - does anything that leaves this PC carry a way into the owner's GitHub (or another secret)?
 *
 * Added October 10th, 2026, after a friend who had been sent an installer said it gave him access to the AionDX GitHub
 * repository. The owner's rule: the owner may share push access on purpose, but nothing public may ever grant it. Run it before
 * every upload (! LLM Files\PRE-UPLOAD-PROCEDURE.md). Read-only: nothing is changed anywhere, and no secret is ever printed
 * (a hit shows the first four characters and the length).
 *
 *   node tools\security-sweep.js                 files: the staged installer payload, every tracked file, all of the git history
 *   node tools\security-sweep.js --github        and GitHub's own side: collaborators, invitations, deploy keys, webhooks, Actions secrets
 *   node tools\security-sweep.js --payload DIR   a different payload folder (default vendor\release\stage\AionDX)
 *   node tools\security-sweep.js --allow LOGIN   a collaborator or invitee the owner approved (repeatable); shown, not counted
 *
 * Exit 0 when clean, 1 when something was found, 2 when the sweep itself could not run. The whole run is limited to 5 minutes.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEADLINE = Date.now() + 5 * 60 * 1000;
const args = process.argv.slice(2);
const wantGithub = args.includes('--github');
const pi = args.indexOf('--payload');
const PAYLOAD = pi >= 0 ? path.resolve(args[pi + 1]) : path.join(ROOT, 'vendor', 'release', 'stage', 'AionDX');
// People the owner gave access on purpose (--allow LOGIN, repeatable): listed as allowed, not counted as a finding.
const ALLOWED = args.map((a, i) => (a === '--allow' ? String(args[i + 1] || '').toLowerCase() : '')).filter(Boolean);

// What a secret looks like. Lengths are the real ones, so a test fixture such as "ghp_PLANTED0002" is not a hit.
const PATTERNS = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g],
  ['a GitHub address with a sign-in inside it', /https?:\/\/[^\/\s:@"'<>]+:[^\/\s@"'<>]+@(?:[\w.-]*\.)?github\.com/g],
  // A key has its base64 body right after the marker; a library that only mentions the marker in its code does not.
  ['private key', /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----(?:\\r|\\n|\s)*[A-Za-z0-9+\/]{60,}/g],
  // The real prefixes (api, oauth access, oauth refresh). AionCore's string table holds "sk-ant-" next to provider names.
  ['Anthropic key or token', /\bsk-ant-(?:api|oat|ort|sid)[0-9]{2}-[A-Za-z0-9_-]{30,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  // AionUi's own renderer carries a Firebase web key (public client configuration, in the stock app too); it is not the owner's.
  ['Google API key', /(?<!VITE_FIREBASE_API_KEY:")\bAIza[0-9A-Za-z_-]{35}\b/g],
  // added November 23rd, 2026 (the user asked after the 0.28.5 release: "no api key leaks?"; a check by hand covered these too)
  ['OpenAI key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/g],
  ['OpenAI project key', /\bsk-proj-[A-Za-z0-9_-]{80,}/g],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}/g],
  ['Stripe live key', /\b[sr]k_live_[0-9A-Za-z]{20,}/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['Airtable token', /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
];
// The secret values stored on this PC (MCP server keys, Claude and AionDX sign-ins, the launcher's accounts): any of them found in the payload,
// the files or the history is a leak whatever its format. Gathered once; never printed (a hit names the store it came from, by number).
const LOCAL_SECRETS = (() => {
  const os = require('os');
  const home = os.homedir(), appdata = process.env.APPDATA || '', local = process.env.LOCALAPPDATA || '';
  const stores = [path.join(home, '.aiondx', 'mcp', 'servers.json'), path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude-work', '.credentials.json'),
    path.join(appdata, 'AionDX', 'aiondx-account.json'), path.join(home, '.claude.json'), path.join(local, 'AionDX', 'bin', 'claude-account-router.config.json')];
  const out = [];
  const take = (v, keyName, inMap, from) => {
    if (typeof v === 'string') {
      const s = v.trim().replace(/^Bearer\s+/i, '');
      if (s.length >= 20 && !/\s/.test(s) && !/^[A-Za-z]:\\|^\/|^https?:\/\/[^@]*$/.test(s) && (inMap || /key|token|secret|password|auth|bearer|credential|refresh|access/i.test(keyName || ''))) out.push({ v: s, from });
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => take(x, keyName, inMap, from)); return; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) take(v[k], k, inMap || /^(env|headers)$/i.test(k), from);
  };
  stores.forEach((f, i) => { try { take(JSON.parse(fs.readFileSync(f, 'utf8')), '', false, i + 1); } catch (e) { /* not on this PC */ } });
  const seen = new Set();
  return out.filter((x) => (seen.has(x.v) ? false : (seen.add(x.v), true)));
})();
// Files that exist to hold a sign-in.
const SECRET_FILES = /(^|[\\/])(\.git-credentials|\.netrc|_netrc|\.npmrc|hosts\.yml|id_rsa[^\\/]*|id_ed25519[^\\/]*|personal-token[^\\/]*|[^\\/]*\.(pem|pfx|p12|ppk)|\.env(\.[^\\/]*)?|[^\\/]*credentials?[^\\/]*\.json)$/i;
// These names also exist as harmless files (npm's own .npmrc, a folder of public certificates): they count when their content holds a sign-in.
const NAME_NEEDS_CONTENT = /(^|[\\/])(\.npmrc|\.netrc|_netrc|[^\\/]*\.(pem|pfx|p12|ppk))$/i;
const SIGN_IN_CONTENT = /(_authToken|_auth\s*=|:_password|\bpassword\s|\bmachine\s+\S+\s+login|PRIVATE KEY)/i;

const findings = [];
const note = (where, what, extra) => findings.push({ where, what, extra: extra || '' });
const mask = (s) => s.slice(0, 4) + '... (' + s.length + ' characters)';
const out = (s) => process.stdout.write(s + '\n');

function scanBuffer(buf, where) {
  const text = buf.toString('latin1');
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) && n < 3) { note(where, name, mask(m[0])); n++; }
  }
  for (const s of LOCAL_SECRETS) if (text.indexOf(s.v) >= 0) note(where, 'a secret value stored on this PC', 'from store ' + s.from + ', ' + s.v.length + ' characters');
}

function walk(dir, fn) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (Date.now() > DEADLINE) throw new Error('deadline');
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' || dir.indexOf('resources') >= 0) walk(p, fn); }
    else if (e.isFile()) fn(p);
  }
}

function scanFile(file, rel) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return; }
  if (SECRET_FILES.test(file)) {
    let hit = true;
    if (NAME_NEEDS_CONTENT.test(file)) { try { hit = st.size < 1024 * 1024 && SIGN_IN_CONTENT.test(fs.readFileSync(file, 'latin1')); } catch (e) { hit = true; } }
    if (hit) note(rel, 'a file that holds a sign-in', path.basename(file));
  }
  if (st.size === 0 || st.size > 400 * 1024 * 1024) return;
  const fd = fs.openSync(file, 'r');
  try {
    const CH = 32 * 1024 * 1024, OVER = 256;
    let pos = 0;
    const buf = Buffer.alloc(CH + OVER);
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CH + OVER, st.size - pos), pos);
      if (n <= 0) break;
      scanBuffer(buf.subarray(0, n), rel);
      pos += CH;
    }
  } finally { fs.closeSync(fd); }
}

function git(argv) {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 120000 });
}

function scanHistory() {
  return new Promise((resolve) => {
    const p = spawn('git', ['log', '--all', '-p', '--no-color'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const kill = setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, 150000);
    let tail = '';
    let commit = '';
    p.stdout.on('data', (d) => {
      const text = tail + d.toString('latin1');
      const cut = Math.max(0, text.length - 300);
      const body = text.slice(0, cut);
      tail = text.slice(cut);
      const c = /^commit ([0-9a-f]{40})/m.exec(body);
      if (c) commit = c[1].slice(0, 8);
      for (const [name, re] of PATTERNS) { re.lastIndex = 0; const m = re.exec(body); if (m) note('git history' + (commit ? ' (near ' + commit + ')' : ''), name, mask(m[0])); }
    });
    p.on('close', () => { clearTimeout(kill); resolve(); });
    p.on('error', () => { clearTimeout(kill); resolve(); });
  });
}

function api(token, urlPath) {
  return new Promise((resolve) => {
    const r = https.request({ host: 'api.github.com', path: urlPath, method: 'GET', timeout: 30000,
      headers: { 'User-Agent': 'aiondx-security-sweep', Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token } },
      (rs) => { let b = ''; rs.on('data', (d) => { b += d; }); rs.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not JSON */ } resolve({ code: rs.statusCode, json: j }); }); });
    r.on('timeout', () => { r.destroy(); resolve({ code: -1, json: null }); });
    r.on('error', () => resolve({ code: -2, json: null }));
    r.end();
  });
}

async function githubSide() {
  const remote = git(['remote', 'get-url', 'origin']).trim();
  const m = /github\.com[\/:]([^\/]+)\/([^\/.]+?)(?:\.git)?$/.exec(remote);
  if (!m) { note('github', 'the origin remote is not a GitHub address', remote.replace(/\/\/[^@\/]*@/, '//***@')); return; }
  const owner = m[1], repo = m[2];
  let token = '';
  try {
    const fill = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: Object.assign({}, process.env, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }) });
    token = ((fill.split('\n').find((l) => l.startsWith('password=')) || '').slice(9)).trim();
  } catch (e) { /* no stored sign-in */ }
  if (!token) { out('GitHub side: skipped, git has no stored GitHub sign-in on this PC.'); return; }
  const base = '/repos/' + owner + '/' + repo;
  const get = async (suffix) => api(token, base + suffix);
  const repoInfo = await get('');
  out('GitHub side: ' + owner + '/' + repo + ' is ' + (repoInfo.json && repoInfo.json.private ? 'private' : 'public'));
  const collab = await get('/collaborators');
  const others = Array.isArray(collab.json) ? collab.json.map((c) => c.login).filter((l) => l.toLowerCase() !== owner.toLowerCase()) : null;
  if (others === null) note('github', 'collaborators could not be read', 'HTTP ' + collab.code);
  else {
    const allowed = others.filter((l) => ALLOWED.includes(l.toLowerCase()));
    const unknown = others.filter((l) => !ALLOWED.includes(l.toLowerCase()));
    if (allowed.length) out('GitHub side: allowed by the owner (--allow): ' + allowed.join(', '));
    if (unknown.length) note('github', 'people other than the owner can push or read', unknown.join(', '));
  }
  const inv = await get('/invitations');
  const invited = Array.isArray(inv.json) ? inv.json.map((i) => (i.invitee && i.invitee.login) || '?') : [];
  const invUnknown = invited.filter((l) => !ALLOWED.includes(l.toLowerCase()));
  if (invUnknown.length) note('github', 'open invitations', invUnknown.join(', '));
  const keys = await get('/keys');
  if (Array.isArray(keys.json) && keys.json.length) note('github', 'deploy keys exist', keys.json.map((k) => k.title + (k.read_only ? ' (read only)' : ' (can write)')).join(', '));
  const hooks = await get('/hooks');
  if (Array.isArray(hooks.json) && hooks.json.length) note('github', 'webhooks exist', String(hooks.json.length));
  const sec = await get('/actions/secrets');
  if (sec.json && sec.json.total_count) note('github', 'Actions secrets exist', String(sec.json.total_count));
  out('GitHub side: collaborators ' + (Array.isArray(collab.json) ? collab.json.length : '?') + ', invitations ' + (Array.isArray(inv.json) ? inv.json.length : '?') +
      ', deploy keys ' + (Array.isArray(keys.json) ? keys.json.length : '?') + ', webhooks ' + (Array.isArray(hooks.json) ? hooks.json.length : '?') +
      ', Actions secrets ' + (sec.json && sec.json.total_count !== undefined ? sec.json.total_count : '?'));
}

(async () => {
  try {
    // 1. the installer's payload
    if (fs.existsSync(PAYLOAD)) {
      let files = 0;
      walk(PAYLOAD, (f) => { files++; scanFile(f, 'payload: ' + path.relative(PAYLOAD, f)); });
      out('payload: ' + files + ' files in ' + PAYLOAD);
      out('secret values from this PC looked for: ' + LOCAL_SECRETS.length);
    } else out('payload: ' + PAYLOAD + ' is not there (build the staged app first); skipped');
    // 2. everything git tracks (and what is waiting to be added)
    const names = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    let tracked = 0;
    for (const n of names) {
      if (Date.now() > DEADLINE) throw new Error('deadline');
      const f = path.join(ROOT, n);
      try { if (!fs.statSync(f).isFile()) continue; } catch (e) { continue; }
      tracked++;
      scanFile(f, 'file: ' + n);
    }
    out('files: ' + tracked + ' tracked or about to be');
    // 3. every commit
    await scanHistory();
    out('history: all commits scanned');
    // 4. GitHub's own side
    if (wantGithub) await githubSide();
  } catch (e) {
    out('the sweep could not finish: ' + e.message);
    process.exit(2);
  }
  const seen = new Set();
  const unique = findings.filter((f) => { const k = f.where + '|' + f.what + '|' + f.extra; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!unique.length) { out('CLEAN: nothing in the payload, the files or the history gives access to anything.'); process.exit(0); }
  out('FOUND ' + unique.length + ' thing(s):');
  unique.slice(0, 60).forEach((f) => out('  ' + f.what + (f.extra ? ' [' + f.extra + ']' : '') + '  in ' + f.where));
  process.exit(1);
})();
