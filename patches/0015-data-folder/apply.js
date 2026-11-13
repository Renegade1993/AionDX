#!/usr/bin/env node
/**
 * 0015-data-folder: AionDX keeps its data in %APPDATA%\AionDX; an earlier version's %APPDATA%\AionUi is used in place.
 *
 *   node patches/0015-data-folder/apply.js <extracted app dir> [--check]
 *
 * a request of 2026-11-01. Run by tools\build-release.ps1 AFTER tools\brand-names.js, so the old folder's name below stays as written.
 * package.json's name is AionDX by then (the rename), so Electron's default data folder is %APPDATA%\AionDX: a new install has no AionUi
 * folder at all. A PC whose chats are only in %APPDATA%\AionUi keeps using that folder where it is. Nothing is moved by the app (Chromium
 * has already made the new folder, empty, and holds files in it, before any of this code runs) or by the installer: a move needs a link at
 * the old name, because conversations store their working folders as absolute paths under it and Claude Code keeps each chat's history
 * under a folder named after that path, and links (junctions) were measured not to work on K's PC (a read through one fails with UNKNOWN).
 * The move for an existing install is a later step that rewrites those paths, on a copy first.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const check = process.argv.includes('--check');
if (!dir) { console.error('usage: apply.js <extracted app dir> [--check]'); process.exit(2); }
const file = path.join(dir, 'out', 'main', 'index.js');
const MARK = '/* AIONDX-0015: data folder */';

const BLOCK = MARK + `
(function aiondxPortableDrive() {
  // AionDX on a drive (R-102, 2026-11-12). A data folder moved to a drive (aiondx-data-move.js --portable) holds aiondx-portable.json; this PC's
  // pointer, %APPDATA%\\AionDX-location.json, names the one it uses. At start, before anything opens the data folder, only the pointer is
  // checked: its folder is used when it is there. No drive is searched here, because this runs before the window exists and a disconnected
  // network drive can take seconds to answer; the search for a drive this PC has not used yet (or one plugged in under another letter) runs
  // after the start, in the background (main process aiondx:portable scan), and the page asks before anything is taken up.
  // global.__aiondxPortable tells the page: "using", "missing" (the pointer's drive is not plugged in: this PC's own chats open) or "none".
  global.__aiondxPortable = { state: "none" };
  try {
    var electron = require("electron"), fs = require("fs"), path = require("path");
    var app = electron.app;
    if (!app || !app.getPath) return;
    var appData = process.env.AIONDX_PORTABLE_APPDATA || app.getPath("appData");   // tests: a made-up folder for the pointer
    var readJson = function (f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
    var ptr = readJson(path.join(appData, "AionDX-location.json"));
    if (!ptr || !ptr.path) return;
    var m = readJson(path.join(ptr.path, "aiondx-portable.json"));
    var hasDb = fs.existsSync(path.join(ptr.path, "aionui", "aiondx-backend.db")) || fs.existsSync(path.join(ptr.path, "aionui", "aionui-backend.db"));
    if (m && m.id && (!ptr.id || m.id === ptr.id) && hasDb) {
      app.setPath("userData", ptr.path);
      global.__aiondxPortable = { state: "using", path: ptr.path, id: m.id };
    } else {
      global.__aiondxPortable = { state: "missing", path: ptr.path, id: ptr.id || "" };
    }
    try { fs.appendFileSync(path.join(appData, "AionDX-data-move.log"), new Date().toISOString() + " drive: " + JSON.stringify(global.__aiondxPortable) + "\\n"); } catch (e) { /* nothing to write to */ }
  } catch (e) { /* the app starts with its own data folder */ }
})();
(function aiondxDataFolder() {
  try {
    var electron = require("electron"), fs = require("fs"), path = require("path");
    var app = electron.app;
    if (!app || !app.getPath) return;
    var appData = app.getPath("appData");
    var oldDir = path.join(appData, "AionUi");
    var newDir = path.join(appData, "AionDX");
    // Only when Electron's own default is the folder (a --user-data-dir or the test override points somewhere else).
    if (path.resolve(app.getPath("userData")).toLowerCase() !== path.resolve(newDir).toLowerCase()) return;
    var hasChats = function (d) {
      try { return fs.existsSync(path.join(d, "aionui", "aionui-backend.db")) || fs.existsSync(path.join(d, "aionui", "aiondx-backend.db")); }
      catch (e) { return false; }
    };
    if (hasChats(newDir) || !hasChats(oldDir)) return;
    // The chats are only in the old folder (a link at its name means the installer already moved them, and then newDir has them).
    app.setPath("userData", oldDir);
    try { fs.appendFileSync(path.join(appData, "AionDX-data-move.log"), new Date().toISOString() + " using " + oldDir + " in place; the installer moves it\\n"); } catch (e) { /* nothing to write to */ }
  } catch (e) { /* the app starts with Electron's default */ }
})();
`;

let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) { console.log('0015: already applied'); process.exit(0); }
const head = '"use strict";';
if (!src.startsWith(head)) { console.error('0015: NOT APPLIED, out/main/index.js does not start with "use strict";'); process.exit(1); }
const out = head + '\n' + BLOCK + src.slice(head.length);
if (!check) fs.writeFileSync(file, out);
console.log('0015: ' + (check ? 'would add' : 'added') + ' the data folder fallback to out/main/index.js');
