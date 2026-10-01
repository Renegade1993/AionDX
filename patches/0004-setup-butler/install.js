#!/usr/bin/env node
/**
 * Installs the aiondx-setup skill where AionUi gives it to every conversation.
 *
 *   node patches\0004-setup-butler\install.js           install or refresh it
 *   node patches\0004-setup-butler\install.js --check   report only, change nothing (exit 1 if missing or stale)
 *   node patches\0004-setup-butler\install.js --remove  take it out
 *
 * WHERE, AND WHY THERE. aioncore copies its builtin skills out of the binary into
 * <data dir>\builtin-skills once per backend version (gated by a .version file), and every skill
 * under builtin-skills\auto-inject is offered to every conversation, for every agent type, as a
 * one-line index entry the agent opens on demand (aionui-ai-agent first_message_injector: the
 * index, not the content). So a folder here reaches the Butler and every other agent without
 * touching the backend or the asar, which directive 1 asks for. The skill itself says to act only
 * when the user asks.
 *
 * A backend version change rewrites builtin-skills from scratch and drops this folder, so
 * tools\aiondx-apply.ps1 runs this after every swap. It is safe to run any time: it only copies
 * this one folder, and it writes an .aiondx stamp so --check can tell a stale copy from a current one.
 *
 * The data dir is AionUi's, %APPDATA%\AionUi\aionui, the --data-dir its launcher passes aioncore.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'skill', 'aiondx-setup');
const DATA = process.env.AIONDX_AIONUI_DATA || path.join(process.env.APPDATA || '', 'AionUi', 'aionui');
const AUTO = path.join(DATA, 'builtin-skills', 'auto-inject');
const DST = path.join(AUTO, 'aiondx-setup');
const STAMP = '.aiondx';

function files(dir, base = dir) {
  let out = [];
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) out = out.concat(files(p, base));
    else if (n !== STAMP) out.push(path.relative(base, p));
  }
  return out;
}

function digest(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of files(dir)) {
    h.update(rel.replace(/\\/g, '/') + '\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
  }
  return h.digest('hex').slice(0, 16);
}

function main(argv) {
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) { console.error('install: source skill missing at ' + SRC); return 2; }
  if (!fs.existsSync(path.join(DATA, 'builtin-skills'))) {
    console.error('install: no builtin-skills folder under ' + DATA + ' (has AionUi run on this machine?)');
    return 2;
  }
  const want = digest(SRC);
  const have = fs.existsSync(path.join(DST, 'SKILL.md')) ? digest(DST) : null;

  if (argv.includes('--remove')) {
    if (fs.existsSync(DST)) { fs.rmSync(DST, { recursive: true, force: true }); console.log('removed ' + DST); }
    else console.log('not installed; nothing to remove');
    return 0;
  }
  if (argv.includes('--check')) {
    const state = have === null ? 'missing' : have === want ? 'current' : 'stale';
    console.log('aiondx-setup skill: ' + state + ' (' + DST + ')');
    return state === 'current' ? 0 : 1;
  }
  if (have === want) { console.log('aiondx-setup skill already current at ' + DST); return 0; }

  // Copy into a staging folder beside the target, then swap, so aioncore never sees half a skill.
  const staging = DST + '.staging-' + process.pid;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(SRC, staging, { recursive: true });
  fs.writeFileSync(path.join(staging, STAMP), JSON.stringify({ digest: want, source: SRC, at: new Date().toISOString() }, null, 1));
  if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
  fs.mkdirSync(AUTO, { recursive: true });
  fs.renameSync(staging, DST);
  console.log((have === null ? 'installed' : 'refreshed') + ' aiondx-setup skill at ' + DST + ' (' + want + ')');
  return 0;
}

process.exit(main(process.argv.slice(2)));
