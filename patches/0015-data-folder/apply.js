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
