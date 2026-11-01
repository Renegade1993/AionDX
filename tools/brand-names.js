#!/usr/bin/env node
/**
 * brand-names.js - renames AionUi to AionDX across a source tree, except where the name must stay.
 *
 *   node tools/brand-names.js <dir> --mode core|asar [--dry] [--report FILE]
 *
 * a request of 2026-11-01: AionDX should not read as AionUi pasted over. Everything is renamed that can be, and what stays is listed:
 *   - the copyright and licence notices (Apache-2.0 requires them, and they carry the fork citation);
 *   - web addresses (http and https links name the upstream project and its repositories);
 *   - an exact string "aionui" (no more, no less): it is a stored or agreed value (the conversation source in the database and its
 *     CHECK list, an extension's engine key) or the name of the data folder, which moves in its own step with a migration;
 *   - names an earlier version stored in the user's data (MCP server rows such as aionui-image-generation, entries in an agent's config, folders):
 *     a duplicate would appear next to the old one on every upgrade, so they are renamed in a later step with a migration;
 *   - key-derivation prefixes (`aionui-encryption-key:`, `aionui-secret-fingerprint:`): changing them makes stored secrets unreadable;
 *   - lines marked `legacy-name`: code that reads something an earlier version wrote;
 *   - SQL migrations (their checksum is stored in every database, so one character changed refuses to start);
 *   - enum variants spelled exactly `Aionui` (serde writes them as the stored value above); variants that only start with it
 *     (`AionuiStreamBroken`, whose wire code is AIONUI_STREAM_BROKEN) are renamed, and the page's error catalog is renamed with them.
 * core mode: the AionCore checkout (crates, Cargo files, assets); it also renames crate folders and files whose name has aionui in it.
 * asar mode: an extracted app.asar (main, preload, renderer, locales).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const dir = argv[0];
const mode = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'core';
const dry = argv.includes('--dry');
const reportFile = argv.includes('--report') ? argv[argv.indexOf('--report') + 1] : null;
const skipList = (argv.includes('--skip') ? argv[argv.indexOf('--skip') + 1] : '').split(',').filter(Boolean);   // paths (forward slashes, from the root) that stay as they are
if (!dir || !fs.existsSync(dir)) { console.error('usage: brand-names.js <dir> --mode core|asar [--dry] [--report FILE]'); process.exit(2); }

const SKIP_DIRS = /^(target|\.git|node_modules\/\.cache|migrations|vendor-cache)$/;
const EXT = mode === 'core' ? /\.(rs|toml|json|lock|md|txt|yml|yaml|ps1|sh)$/i : /\.(js|mjs|cjs|json|html|css|md|txt|yml|yaml|svg|webmanifest)$/i;
const SKIP_CORE_PATH = /^(\.github\/|CHANGELOG|ARCHITECTURE|AGENTS|CLAUDE|README|LICENSE|NOTICE|docs\/)/i;
const KEEP_LINE = /legacy-name|Copyright|SPDX|@license/;           // the whole line stays
const ENUM_VARIANT = /\bAionui\b/;                                  // an enum variant: serde derives the stored value from it

const stats = { files: 0, changed: 0, replaced: 0, kept: {} };
const keptSamples = {};
const keep = (why, sample) => { stats.kept[why] = (stats.kept[why] || 0) + 1; (keptSamples[why] = keptSamples[why] || []).length < 6 && keptSamples[why].push(sample); };

/** Rename one text. Masks what stays, replaces the rest, restores the mask. */
function brand(text, rel) {
  const masks = [];
  const mask = (re, why) => { text = text.replace(re, (m) => { keep(why, m.slice(0, 70)); masks.push(m); return '\u0001' + (masks.length - 1) + '\u0002'; }); };
  // block comments with a copyright or licence notice (asar bundles keep them on one line with code)
  mask(/\/\*[\s\S]{0,400}?(?:Copyright|SPDX|@license)[\s\S]{0,400}?\*\//g, 'licence');
  // web addresses
  mask(/https?:\/\/[^\s"'`)\]<>\\]*/gi, 'url');
  // exact "aionui" strings
  mask(/(["'`])aionui\1/g, 'exact-aionui');
  // names an earlier version stored in the user's data (MCP server rows, agent config entries, folders): renamed later, with a migration
  // (not in Cargo files: there the same words are crate names, which are renamed)
  if (!/\.(toml|lock)$/i.test(rel)) mask(/(["'`])aionui-(?:browser|image-generation|team|team-mcp|team-guide|skills|chat-history|assistant|permission-bridge|title|session-title)\1/g, 'stored-name');
  // keys the page keeps in the browser's own storage (drafts, switches): renamed later, with a migration
  mask(/aionui\.dx\.[A-Za-z0-9_.-]*/g, 'stored-key');
  // key-derivation prefixes
  mask(/aionui-(?:encryption-key|secret-fingerprint):/g, 'key-prefix');
  // lines that stay whole (core: plain lines; asar bundles are minified, so only the line markers matter)
  if (mode === 'core') {
    text = text.split(/\r?\n/).map((line) => {
      if (line.includes('\u0001') && !/aionui/i.test(line.replace(/\u0001\d+\u0002/g, ''))) return line;
      if (KEEP_LINE.test(line) && /aionui/i.test(line)) { keep('marked-line', line.trim().slice(0, 70)); masks.push(line); return '\u0001' + (masks.length - 1) + '\u0002'; }
      if (ENUM_VARIANT.test(line)) { keep('enum-variant', line.trim().slice(0, 70)); masks.push(line); return '\u0001' + (masks.length - 1) + '\u0002'; }
      return line;
    }).join(text.includes('\r\n') ? '\r\n' : '\n');
  }
  let n = 0;
  text = text.replace(/AIONUI/g, () => (n++, 'AIONDX')).replace(/Aion(?:UI|Ui)/g, () => (n++, 'AionDX')).replace(/Aionui(?=[A-Z0-9_])/g, () => (n++, 'Aiondx')).replace(/aionui/g, () => (n++, 'aiondx'));
  // restore (a masked line may sit inside another mask: restore until none is left)
  for (let i = 0; i < 4 && /\u0001\d+\u0002/.test(text); i++) text = text.replace(/\u0001(\d+)\u0002/g, (m, k) => masks[+k]);
  return { text, n };
}

function walk(d, rel0) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.test(e.name)) continue;
    const p = path.join(d, e.name);
    const rel = (rel0 ? rel0 + '/' : '') + e.name;
    if (e.isDirectory()) { walk(p, rel); continue; }
    if (skipList.includes(rel)) continue;
    if (!EXT.test(e.name) && e.name !== 'Cargo.lock') continue;
    if (mode === 'core' && SKIP_CORE_PATH.test(rel) && !/assets\//.test(rel)) continue;
    if (/^LICENSE|^NOTICE|migrations\//i.test(e.name) || /\/migrations\//.test('/' + rel)) continue;
    let s;
    try { s = fs.readFileSync(p, 'utf8'); } catch (x) { continue; }
    stats.files++;
    if (!/aionui/i.test(s)) continue;
    const r = brand(s, rel);
    if (r.text !== s) { stats.changed++; stats.replaced += r.n; if (!dry) fs.writeFileSync(p, r.text); }
  }
}
if (fs.statSync(dir).isFile()) {   // one file
  const s = fs.readFileSync(dir, 'utf8');
  stats.files = 1;
  if (/aionui/i.test(s)) { const r = brand(s, path.basename(dir)); if (r.text !== s) { stats.changed = 1; stats.replaced = r.n; if (!dry) fs.writeFileSync(dir, r.text); } }
} else walk(dir, '');

// files and folders named aionui (core: crate folders; asar: the page script and @aionui)
let renamed = 0;
if (!dry) {
  const renameIn = (d) => {
    if (!fs.statSync(d).isDirectory()) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) renameIn(p);
    }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.test(e.name) || /^LICENSE|^NOTICE/i.test(e.name)) continue;
      if (/aionui/i.test(e.name)) {
        const nn = e.name.replace(/AIONUI/g, 'AIONDX').replace(/Aion(?:UI|Ui)/g, 'AionDX').replace(/aionui/g, 'aiondx');
        fs.renameSync(path.join(d, e.name), path.join(d, nn));
        renamed++;
      }
    }
  };
  renameIn(dir);
}
console.log(`${dry ? 'would change' : 'changed'} ${stats.changed} of ${stats.files} files, ${stats.replaced} replacements${', ' + renamed + ' files or folders renamed'}`);
console.log('kept as they are: ' + JSON.stringify(stats.kept));
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ stats, keptSamples }, null, 2));
