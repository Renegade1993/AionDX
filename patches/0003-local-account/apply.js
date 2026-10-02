#!/usr/bin/env node
/**
 * AionDX patch 0003-local-account: AionUi opens without an aionui.com sign-in.
 *
 *   node patches\0003-local-account\apply.js <extracted-asar-root>
 *
 * Patches two files inside an extracted app.asar, in place:
 *   out/main/index.js       the main process's AuthManager always reports a signed-in LOCAL
 *                           account and never talks to aionui.com
 *   out/renderer/index.html hides Settings > Account (AionPro profile, balance, sign-out)
 *
 * WHY THE ACCOUNT KEEPS ITS OLD ID. The installed build is AionUi's AionPro edition. Its backend
 * (aioncore, --identity-mode aionpro) owns every conversation, team and setting by Core user,
 * and the Core user is found by the external account id. On the developer's machine that id is in
 * %APPDATA%\AionUi\auth.enc (plain JSON despite the name). Reusing it means the main process's
 * CoreUserBridge provisions the SAME Core user exactly as it does today, through the bootstrap
 * secret it already holds, so no data moves. A machine that never signed in gets a new id
 * ("aiondx-<uuid>"); the backend's one-shot adoption then gives it the default user's data.
 * "desktop-user-" ids are refused by CoreUserBridge, so they are never used.
 *
 * The id is saved to %APPDATA%\AionUi\aiondx-account.json on first run and read from there after,
 * so it survives auth.enc being deleted. auth.enc itself is never modified or deleted: reverting
 * to the stock asar resumes the aionui.com session until it expires.
 *
 * SAFETY. Every anchor must be found exactly once or nothing is written and the exit code is 1.
 * Re-running on an already patched tree replaces the marked helper block with this version and
 * leaves the rewritten method headers alone, so a rebuild from the live (patched) asar is safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MARK_BEGIN = '/* AIONDX-0003 BEGIN';
const MARK_END = '/* AIONDX-0003 END */';
const STYLE_ID = 'aiondx-0003';

// The helper lives at module scope, just above `class AuthManager`. It uses only `require`
// and two names the bundle declares earlier at module scope (checked below), so it does not
// depend on the bundler's renamed variables such as fs$2 or path$1.
const HELPER = `${MARK_BEGIN}: AionDX patch 0003-local-account. AionUi opens without an aionui.com sign-in. */
const __aiondx = (() => {
  const TAG = "[AionDX 0003]";
  const FILE = "aiondx-account.json";
  const nodeFs = require("fs");
  const nodePath = require("path");
  const nodeOs = require("os");
  const nodeCrypto = require("crypto");
  let cached = null;
  const accountFile = () => nodePath.join(require("electron").app.getPath("userData"), FILE);
  const usable = (u) => !!u && typeof u.id === "string" && u.id.trim() !== "" && !u.id.startsWith(FALLBACK_USER_ID_PREFIX);
  const readJson = (p) => { try { return JSON.parse(nodeFs.readFileSync(p, "utf8")); } catch { return null; } };
  function localUser() {
    if (cached) return cached;
    let file = null;
    try { file = accountFile(); } catch (e) { console.warn(TAG, "no userData path:", e); }
    const saved = file ? readJson(file) : null;
    if (saved && usable(saved.user)) { cached = saved.user; return cached; }
    // First run: keep the account this install already knows, so every conversation stays its own.
    let meta = null;
    try { meta = readPersistedMeta(); } catch { meta = null; }
    let user = meta && usable(meta.user) ? meta.user : null;
    let source = "auth.enc";
    if (!user) {
      let name = "";
      try { name = nodeOs.userInfo().username; } catch { name = ""; }
      user = { id: "aiondx-" + nodeCrypto.randomUUID(), name: name || "user", username: name || "user", avatarUrl: null, extras: {} };
      source = "new";
    }
    if (file) {
      try { nodeFs.writeFileSync(file, JSON.stringify({ user, source, createdAt: new Date().toISOString() }, null, 1)); }
      catch (e) { console.warn(TAG, "could not save the local account; it lasts until AionUi closes:", e); }
    }
    console.info(TAG, "local account from " + source + ", id " + user.id.slice(0, 6) + "...");
    cached = user;
    return cached;
  }
  function adopt(mgr) {
    mgr.session.refreshToken = null;
    mgr.session.refreshExpireAt = 0;
    mgr.session.accessToken = null;
    mgr.session.accessExpireAt = 0;
    mgr.session.inFlightRefresh = null;
    mgr.session.user = localUser();
  }
  return {
    snapshot(mgr) {
      if (!mgr.session.user) adopt(mgr);
      return { status: "authenticated", user: mgr.session.user };
    },
    async bootstrap(mgr) {
      adopt(mgr);
      mgr.hasBootstrapped = true;
      mgr.emitChange("bootstrap");
    },
    async login(mgr) {
      if (!mgr.session.user) adopt(mgr);
      mgr.emitChange("login");
      return { ok: true };
    },
    async logout(mgr) {
      console.info(TAG, "sign-out ignored: AionDX runs without an account");
    },
    async clearSession(mgr, reason) {
      mgr.session.refreshToken = null;
      mgr.session.accessToken = null;
      mgr.session.inFlightRefresh = null;
      console.info(TAG, "kept the local account (clearSession " + (reason || "") + ")");
    },
    _reset() { cached = null; }
  };
})();
${MARK_END}
`;

// Method headers inside `class AuthManager`, each rewritten to delegate to the helper. The stock
// method body stays in the file under a new name, unused, so the diff against stock is small.
const METHODS = [
  { head: '  getSnapshot() {', call: '  getSnapshot() { return __aiondx.snapshot(this); }', stock: '__aiondxStock_getSnapshot() {' },
  { head: '  async clearSession(reason) {', call: '  async clearSession(reason) { return __aiondx.clearSession(this, reason); }', stock: 'async __aiondxStock_clearSession(reason) {' },
  { head: '  async bootstrap() {', call: '  async bootstrap() { return __aiondx.bootstrap(this); }', stock: 'async __aiondxStock_bootstrap() {' },
  { head: '  async login({ lang, provider = "aionui" }) {', call: '  async login() { return __aiondx.login(this); }', stock: 'async __aiondxStock_login({ lang, provider = "aionui" }) {' },
  { head: '  async logout() {', call: '  async logout() { return __aiondx.logout(this); }', stock: 'async __aiondxStock_logout() {' },
];

const STYLE = `<style id="${STYLE_ID}">/* AionDX patch 0003: no account, so no Settings > Account */ [data-settings-id="account"]{display:none !important}</style>`;

function count(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function patchMain(src) {
  const notes = [];
  const begin = src.indexOf(MARK_BEGIN);
  if (begin !== -1) {
    const end = src.indexOf(MARK_END, begin);
    if (end === -1) throw new Error('found AIONDX-0003 BEGIN without END');
    const tail = src.slice(end + MARK_END.length).replace(/^\r?\n/, '');
    src = src.slice(0, begin) + HELPER + tail;
    notes.push('helper block replaced with this version');
    for (const m of METHODS) {
      if (count(src, m.call) !== 1) throw new Error('patched tree is missing the rewritten header: ' + m.call.trim());
    }
    return { src, notes };
  }
  for (const anchor of ['const readPersistedMeta = ', 'const FALLBACK_USER_ID_PREFIX = "desktop-user-";']) {
    if (count(src, anchor) !== 1) throw new Error('expected exactly one "' + anchor + '"');
  }
  if (count(src, 'class AuthManager {') !== 1) throw new Error('expected exactly one "class AuthManager {"');
  if (count(src, 'const authManager = new AuthManager();') !== 1) throw new Error('expected exactly one AuthManager instance');
  const classStart = src.indexOf('class AuthManager {');
  const classEnd = src.indexOf('const authManager = new AuthManager();');
  if (classEnd < classStart) throw new Error('AuthManager instance comes before the class');
  if (src.indexOf('const readPersistedMeta = ') > classStart || src.indexOf('const FALLBACK_USER_ID_PREFIX') > classStart) {
    throw new Error('readPersistedMeta or FALLBACK_USER_ID_PREFIX is declared after AuthManager');
  }
  let body = src.slice(classStart, classEnd);
  for (const m of METHODS) {
    const n = count(body, '\n' + m.head + '\n');
    if (n !== 1) throw new Error('expected exactly one "' + m.head.trim() + '" in AuthManager, found ' + n);
    body = body.replace('\n' + m.head + '\n', '\n' + m.call + '\n  ' + m.stock + '\n');
  }
  src = src.slice(0, classStart) + HELPER + body + src.slice(classEnd);
  notes.push('AuthManager: ' + METHODS.length + ' methods now use the local account');
  return { src, notes };
}

function patchHtml(html) {
  if (html.includes(`id="${STYLE_ID}"`)) {
    const re = new RegExp(`<style id="${STYLE_ID}">[\\s\\S]*?</style>`);
    return { html: html.replace(re, STYLE), note: 'Account style replaced' };
  }
  if (count(html, '</head>') !== 1) throw new Error('expected exactly one </head> in index.html');
  return { html: html.replace('</head>', '    ' + STYLE + '\n  </head>'), note: 'Account style added' };
}

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const mainJs = path.join(root, 'out', 'main', 'index.js');
  const indexHtml = path.join(root, 'out', 'renderer', 'index.html');
  try {
    const main0 = fs.readFileSync(mainJs, 'utf8');
    const html0 = fs.readFileSync(indexHtml, 'utf8');
    const m = patchMain(main0);
    const h = patchHtml(html0);
    fs.writeFileSync(mainJs, m.src);           // only after both patches succeeded
    fs.writeFileSync(indexHtml, h.html);
    for (const n of m.notes.concat([h.note])) console.log('0003: ' + n);
    return 0;
  } catch (e) {
    console.error('0003: NOT APPLIED, nothing written: ' + e.message);
    return 1;
  }
}

module.exports = { patchMain, patchHtml, HELPER, METHODS, MARK_BEGIN, MARK_END, STYLE_ID };
if (require.main === module) process.exit(main(process.argv.slice(2)));
