#!/usr/bin/env node
/**
 * AionDX patch 0006-butler-to-antigravity: the interface stops offering the Butler and offers
 * Antigravity in its place.
 *
 *   node patches\0006-butler-to-antigravity\apply.js <extracted-asar-root>
 *
 * K, 2026-09-24: "at least remove it from the ui's presenting it everywhere for all things, use
 * antigravity in it's place".
 *
 * HOW. Every "via chat" button in AionUi (Ask the Butler on error messages, Let the butler set it
 * up in WebUI settings, the "... via chat" buttons in settings, scheduled tasks, skills and the
 * feedback form) goes through one hook, useTalkToButler. It looks the target up by one constant,
 * "aionui-assistant", then opens the home page with that assistant selected and the prompt filled
 * in. This patch points the constant at "bare:a9f3c21e", the plain Antigravity entry AionUi
 * generates for its builtin Antigravity agent, and relabels the English strings that name the
 * Butler. On a machine without agy that entry does not exist, and the hook's own fallback opens the
 * home page with the prompt filled in and no assistant pinned.
 *
 * Also: the first-run onboarding's featured assistant points at Antigravity and is named
 * "Antigravity". Other languages keep their own words for the Butler (K works in English).
 *
 * SAFETY. Every anchor must match its expected count across out/renderer/assets/*.js, or nothing is
 * written and the exit code is 1. Re-running on a patched tree finds the new text and changes
 * nothing. The edits only change the contents of string literals, so the bundle's syntax cannot
 * change.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = 'bare:a9f3c21e';

// [description, regex, replacement, expected matches on an unpatched tree, marker that proves it is done]
const EDITS = [
  ['hook target', /const (\w+)="aionui-assistant",(\w+)=(\w+)=>\{const (\w+)=new Set\(\[\1,`builtin-\$\{\1\}`\]\)/g,
    (m) => m.replace('"aionui-assistant"', '"' + TARGET + '"'), 1,
    new RegExp('const \\w+="' + TARGET + '",\\w+=\\w+=>\\{const \\w+=new Set\\(\\[\\w+,`builtin-')],
  ['onboarding featured assistant', /\{id:"aionui-assistant",nameKey:"onboarding\.cast\.butler"/g,
    () => '{id:"' + TARGET + '",nameKey:"onboarding.cast.butler"', 1,
    new RegExp('\\{id:"' + TARGET + '",nameKey:"onboarding\\.cast\\.butler"')],
  ['"Ask the Butler"', /solveWithButler:"Ask the Butler"/g, () => 'solveWithButler:"Ask Antigravity"', 1, /solveWithButler:"Ask Antigravity"/],
  ['enabled toast', /enabledToast:"Enabled the AionUi Butler for you"/g, () => 'enabledToast:"Enabled Antigravity for you"', 2, /enabledToast:"Enabled Antigravity for you"/],
  ['enabled toast default', /defaultValue:"Enabled the AionUi Butler for you"/g, () => 'defaultValue:"Enabled Antigravity for you"', 1, /defaultValue:"Enabled Antigravity for you"/],
  ['"Let the butler set it up"', /:"Let the butler set it up"/g, () => ':"Let Antigravity set it up"', 2, /:"Let Antigravity set it up"/],
  ['assistants empty-state hint', /defaultValue:"Create one by chatting with the butler, or duplicate an official assistant into your own\."/g,
    () => 'defaultValue:"Create one by chatting with Antigravity, or duplicate an official assistant into your own."', 1,
    /defaultValue:"Create one by chatting with Antigravity, or duplicate an official assistant into your own\."/],
  ['English onboarding name', /\{butler:"AionUi Butler"/g, () => '{butler:"Antigravity"', 2, /\{butler:"Antigravity"/],
];

function patchAssets(files) {
  // files: { name: text }. Returns { files, notes } or throws; never partially applies.
  const out = Object.assign({}, files);
  const notes = [];
  for (const [what, re, repl, expected, done] of EDITS) {
    let total = 0;
    const hits = [];
    for (const [name, text] of Object.entries(out)) {
      const n = (text.match(re) || []).length;
      if (n) { total += n; hits.push(name); }
    }
    if (total === 0) {
      const already = Object.values(out).some((t) => done.test(t));
      if (!already) throw new Error('anchor not found: ' + what);
      notes.push(what + ': already done');
      continue;
    }
    if (total !== expected) throw new Error(what + ': expected ' + expected + ' match(es), found ' + total + ' in ' + hits.join(', '));
    for (const name of hits) out[name] = out[name].replace(re, repl);
    notes.push(what + ': ' + total + ' in ' + hits.join(', '));
  }
  return { files: out, notes };
}

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const dir = path.join(root, 'out', 'renderer', 'assets');
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
    const files = {};
    for (const n of names) {
      const t = fs.readFileSync(path.join(dir, n), 'utf8');
      if (/aionui-assistant|[Bb]utler/.test(t)) files[n] = t;       // only files that can match
    }
    const { files: patched, notes } = patchAssets(files);
    for (const [n, t] of Object.entries(patched)) if (t !== files[n]) fs.writeFileSync(path.join(dir, n), t);
    for (const note of notes) console.log('0006: ' + note);
    return 0;
  } catch (e) {
    console.error('0006: NOT APPLIED, nothing written: ' + e.message);
    return 1;
  }
}

module.exports = { patchAssets, EDITS, TARGET };
if (require.main === module) process.exit(main(process.argv.slice(2)));
