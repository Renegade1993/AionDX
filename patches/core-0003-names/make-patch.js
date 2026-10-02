#!/usr/bin/env node
/**
 * make-patch.js - writes 0001-names.patch for AionCore v0.2.2: the built-in assistants say AionDX where they said AionUi
 * (crates/aionui-app/assets/builtin-assistants: assistants.json, and the rule files the agents read, except Moltbook's, whose
 * "AionUi-" prefix is a name registered on another service). Reads the original files from the reference clone with `git show`
 * (never edits it), edits copies in a throwaway repository and takes the diff from there.
 *
 *   node patches\core-0003-names\make-patch.js [tag]       default v0.2.2
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const ref = path.join(root, 'upstream-aioncore');
const tag = process.argv[2] || 'v0.2.2';
const base = 'crates/aionui-app/assets/builtin-assistants';
const git = (cwd, args, opts) => spawnSync('git', args, Object.assign({ cwd, encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, opts || {}));

const listed = git(ref, ['ls-tree', '-r', '--name-only', tag, base]);
if (listed.status !== 0) { console.error('git ls-tree failed: ' + listed.stderr.toString()); process.exit(1); }
const names = listed.stdout.toString().split(/\r?\n/).filter((f) => /assistants\.json$|rules\/.*\.md$/.test(f) && !/rules\/moltbook\./.test(f));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-core0003-'));
try {
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.name', 'AionDX']);
  git(tmp, ['config', 'user.email', 'noreply@users.noreply.github.com']);
  git(tmp, ['config', 'core.autocrlf', 'false']);
  const edited = [];
  for (const f of names) {
    const shown = git(ref, ['show', tag + ':' + f]);
    if (shown.status !== 0) { console.error('git show ' + f + ' failed'); process.exit(1); }
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, shown.stdout);
    edited.push([f, shown.stdout]);
  }
  git(tmp, ['add', '-A']);
  const c = git(tmp, ['commit', '-q', '-m', 'original']);
  if (c.status !== 0) { console.error('commit failed: ' + c.stderr.toString()); process.exit(1); }
  let changedFiles = 0, places = 0;
  for (const [f, buf] of edited) {
    const text = buf.toString('utf8');
    const n = (text.match(/AionUi|AionUI/g) || []).length;
    if (!n) continue;
    fs.writeFileSync(path.join(tmp, f), Buffer.from(text.replace(/AionUi|AionUI/g, 'AionDX'), 'utf8'));
    changedFiles++; places += n;
  }
  const d = git(tmp, ['diff', '--no-color', '--no-ext-diff', '--binary']);
  if (!d.stdout.length) { console.error('no change'); process.exit(1); }
  const out = path.join(__dirname, '0001-names.patch');
  fs.writeFileSync(out, d.stdout);
  console.log('wrote ' + out + ': ' + changedFiles + ' file(s), ' + places + ' place(s), ' + d.stdout.length + ' bytes');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
