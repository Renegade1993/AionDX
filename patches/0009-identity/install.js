#!/usr/bin/env node
/**
 * install.js - patch 0009's settings and shortcuts: the AionDX themes and the AionDX icon.
 *
 *   node patches\0009-identity\install.js              themes into AionUi's theme list, icon onto the shortcuts
 *   node patches\0009-identity\install.js --activate   the same, and make AionDX Dark the active theme
 *   node patches\0009-identity\install.js --check      report; change nothing
 *   node patches\0009-identity\install.js --remove     take the themes out, give the shortcuts AionUi's icon back
 *
 * Themes: `theme.userThemes` and `theme.activeId` in AionUi's settings store (GET/PUT
 * /api/settings/client), where Settings > Appearance keeps user themes; AionDX's are upserted by id
 * and every other theme is left alone. AionUi reads the store once at startup, so a change shows
 * after its next start. Needs the runtime token of an AionUi chat's shell (AIONUI_* variables).
 *
 * Shortcuts: every AionUi.lnk on the desktop, in the Start menu and pinned to the taskbar gets
 * %LOCALAPPDATA%\AionDX\icons\aiondx.ico as its icon (the window itself gets the mark from the
 * build, apply.js). Written through WScript.Shell, hidden.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { THEMES } = require('./themes');

const args = new Set(process.argv.slice(2));
const say = (s) => console.log(s);
const ICON_SRC = path.join(__dirname, 'icon', 'aiondx.ico');
const ICON_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AionDX', 'icons');
const ICON = path.join(ICON_DIR, 'aiondx.ico');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
// Every AionUi*.lnk ("AionUi (2).lnk" exists on this machine) in these folders, plus AionDX's own
// updater shortcut.
const SHORTCUT_DIRS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'OneDrive', 'Desktop'),
  path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
];
const SHORTCUTS = SHORTCUT_DIRS.filter((d) => fs.existsSync(d)).flatMap((d) =>
  fs.readdirSync(d).filter((f) => /^AionUi.*\.lnk$/i.test(f) || /^AionDX Apply Update\.lnk$/i.test(f)).map((f) => path.join(d, f)));

// ---------------------------------------------------------------- AionUi's settings store

function identity() {
  const need = ['AIONUI_BASE_URL', 'AIONUI_RUNTIME_TOKEN', 'AIONUI_USER_ID', 'AIONUI_CONVERSATION_ID'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`the themes need AionUi's API: run this from an agent's shell inside AionUi (${missing.join(', ')} not set)`);
  return { base: process.env.AIONUI_BASE_URL.replace(/\/$/, ''), headers: {
    'x-aionui-runtime-token': process.env.AIONUI_RUNTIME_TOKEN, 'x-aionui-user-id': process.env.AIONUI_USER_ID,
    'x-aionui-conversation-id': process.env.AIONUI_CONVERSATION_ID } };
}
async function api(method, p, body) {
  const id = identity();
  const r = await fetch(id.base + p, { method, headers: { ...id.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} answered ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text || '{}');
  return j.data !== undefined ? j.data : j;
}
async function readThemes() {
  const d = await api('GET', '/api/settings/client?keys=theme.userThemes,theme.activeId');
  return { list: Array.isArray(d['theme.userThemes']) ? d['theme.userThemes'] : [], active: d['theme.activeId'] || null };
}

async function installThemes(activate) {
  const { list, active } = await readThemes();
  const now = Date.now();
  const ours = THEMES.map((t) => {
    const prior = list.find((x) => x && x.id === t.id);
    return { ...t, created_at: prior ? prior.created_at : now, updated_at: now };
  });
  const merged = list.filter((x) => x && !THEMES.some((t) => t.id === x.id)).concat(ours);
  const body = { 'theme.userThemes': merged };
  if (activate) body['theme.activeId'] = 'aiondx-dark';
  await api('PUT', '/api/settings/client', body);
  say(`themes: ${ours.map((t) => t.name).join(', ')} installed (${merged.length} user theme(s) in all)` +
      (activate ? `; active theme ${active || '(none)'} -> aiondx-dark` : `; active theme left as ${active || '(none)'}`));
}

async function removeThemes() {
  const { list, active } = await readThemes();
  const body = { 'theme.userThemes': list.filter((x) => x && !THEMES.some((t) => t.id === x.id)) };
  if (active && THEMES.some((t) => t.id === active)) body['theme.activeId'] = 'system';
  await api('PUT', '/api/settings/client', body);
  say('themes: removed' + (body['theme.activeId'] ? '; active theme set back to system' : ''));
}

// ---------------------------------------------------------------- shortcuts

function powershell(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}
function psq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function setShortcutIcons(icon) {
  const found = SHORTCUTS.filter((f) => fs.existsSync(f));
  if (!found.length) { say('shortcuts: no AionUi.lnk found'); return; }
  for (const f of found) {
    // An empty icon means "the target's own icon": the lnk's IconLocation is cleared.
    const loc = icon ? `${icon},0` : ',0';
    const out = powershell(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psq(f)}); $s.IconLocation = ${psq(loc)}; $s.Save(); $s.IconLocation`);
    say(`shortcut: ${f} -> ${out || '(saved)'}`);
  }
  // Explorer caches icons per shortcut; this asks it to refresh them.
  powershell('ie4uinit.exe -show');
}

function checkShortcuts() {
  for (const f of SHORTCUTS.filter((x) => fs.existsSync(x))) {
    say(`shortcut: ${f} icon ${powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(f)}).IconLocation`)}`);
  }
}

(async () => {
  if (args.has('--check')) {
    const { list, active } = await readThemes().catch((e) => { say('themes: not checked (' + e.message + ')'); return { list: [], active: null }; });
    say('themes installed: ' + (THEMES.filter((t) => list.some((x) => x && x.id === t.id)).map((t) => t.name).join(', ') || 'none') + '; active ' + active);
    say('icon: ' + (fs.existsSync(ICON) ? ICON : 'not installed'));
    checkShortcuts();
    return;
  }
  if (args.has('--remove')) {
    await removeThemes().catch((e) => say('themes: left in place (' + e.message + ')'));
    setShortcutIcons('');
    return;
  }
  fs.mkdirSync(ICON_DIR, { recursive: true });
  fs.copyFileSync(ICON_SRC, ICON);
  say('icon: ' + ICON);
  setShortcutIcons(ICON);
  await installThemes(args.has('--activate'));
})().catch((e) => { console.error('install.js: ' + e.message); process.exit(1); });
