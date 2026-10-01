#!/usr/bin/env node
/**
 * update-claude-toolchain.js - keep AionUi's Claude model list current without anyone
 * remembering to do it.
 *
 * WHAT IT DOES, in order
 *   1. `claude install latest`, which updates the native build under ~\.local\bin.
 *   2. Repairs the PATH shims, because step 1 deletes them (see below).
 *   3. Rebuilds each account's model catalog from that account's live entitlement.
 *   4. Optionally (--verify) asks each account over ACP what its picker will show.
 *
 * WHY STEP 2 EXISTS, and why it is not optional
 * `claude install latest` deletes the npm package it supersedes. On 2026-09-22 it removed
 * %APPDATA%\npm\node_modules\@anthropic-ai\claude-code and took claude.cmd with it. The
 * failure is silent and expensive: `claude` on PATH then resolves straight to the native
 * binary, claude-account-router.js stops being consulted, and every AionUi conversation
 * bills whichever account owns the default credentials. An updater that ran step 1 without
 * step 2 would reintroduce that on its own schedule, which is worse than not updating.
 *
 * SAFETY
 *   - Hard deadline. Every child gets a timeout and the script exits non-zero rather than
 *     hanging. Nothing here waits on input.
 *   - A stop file at ~\.agents\claude-toolchain-update.stop makes it exit immediately,
 *     which is the kill switch for the scheduled task.
 *   - windowsHide on every spawn. No console windows.
 *   - Read-only where it can be: it never edits settings beyond `availableModels`, and
 *     sync-claude-model-catalog.js backs that up before writing.
 *
 * USAGE
 *   node tools\update-claude-toolchain.js              update and re-sync
 *   node tools\update-claude-toolchain.js --verify     also probe both accounts
 *   node tools\update-claude-toolchain.js --check-only report drift, change nothing
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = 'C:\\AI Projects\\AionDX';
const PATCH_DIR = path.join(PROJECT, 'patches', '0002-claude-model-currency');
const TOOLS = path.join(PROJECT, 'tools');
const NPM_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
const AGENTS_DIR = path.join(os.homedir(), '.agents');
const LOG = path.join(AGENTS_DIR, 'claude-toolchain-update.log');
const STOP = path.join(AGENTS_DIR, 'claude-toolchain-update.stop');
const DEADLINE_MS = 15 * 60 * 1000;

const SHIMS = ['claude.cmd', 'claude', 'claude.ps1'];
const startedAt = Date.now();
const lines = [];

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  lines.push(line);
  console.log(msg);
}

function finish(code) {
  try {
    fs.appendFileSync(LOG, `${lines.join('\n')}\n`);
    const st = fs.statSync(LOG);
    if (st.size > 512 * 1024) {
      const keep = fs.readFileSync(LOG, 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(LOG, keep);
    }
  } catch { /* logging must never change the outcome */ }
  process.exit(code);
}

function guard() {
  if (fs.existsSync(STOP)) {
    log('STOP file present, exiting without changes');
    finish(0);
  }
  if (Date.now() - startedAt > DEADLINE_MS) {
    log(`deadline of ${DEADLINE_MS / 60000} minutes exceeded, exiting`);
    finish(1);
  }
}

function run(exe, args, timeout) {
  guard();
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

function resolveExe() {
  try {
    return require(path.join(AGENTS_DIR, 'claude-newest-exe.js')).newestClaudeExe();
  } catch {
    return null;
  }
}

/** Reinstate any shim `claude install` removed. Returns the names it had to restore. */
function repairShims() {
  const restored = [];
  for (const name of [...SHIMS, 'claude-account-router.js']) {
    const target = path.join(NPM_DIR, name);
    const source = path.join(PATCH_DIR, name);
    if (fs.existsSync(target)) continue;
    if (!fs.existsSync(source)) {
      log(`  WARNING: ${name} is missing from PATH and from ${PATCH_DIR}`);
      continue;
    }
    try {
      fs.copyFileSync(source, target);
      restored.push(name);
    } catch (e) {
      log(`  WARNING: could not restore ${name}: ${e.message}`);
    }
  }
  return restored;
}

(function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check-only');
  const verify = args.includes('--verify');

  guard();
  log(`=== claude toolchain update${checkOnly ? ' (check only)' : ''} ===`);

  const before = resolveExe();
  log(`before: ${before ? `${before.version} at ${before.exe}` : 'no binary resolved'}`);

  if (checkOnly) {
    const missing = [...SHIMS, 'claude-account-router.js'].filter((n) => !fs.existsSync(path.join(NPM_DIR, n)));
    log(missing.length ? `shims missing: ${missing.join(', ')}` : 'shims present');
    finish(missing.length ? 1 : 0);
  }

  // 1. update the native build
  if (before) {
    const install = run(before.exe, ['install', 'latest'], 10 * 60 * 1000);
    const summary = install.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
    log(`install latest: ${install.ok ? 'ok' : 'FAILED'} ${summary}`);
  } else {
    log('install latest: skipped, no binary to run it with');
  }

  // 2. repair what the installer removed
  const restored = repairShims();
  log(restored.length ? `shims restored: ${restored.join(', ')}` : 'shims intact');

  const after = resolveExe();
  log(`after: ${after ? `${after.version} at ${after.exe}` : 'no binary resolved'}`);
  if (before && after && before.version !== after.version) log(`CLI moved ${before.version} -> ${after.version}`);

  // 3. rebuild both catalogs from live entitlement
  const sync = run(process.execPath, [path.join(TOOLS, 'sync-claude-model-catalog.js'), 'both'], 3 * 60 * 1000);
  for (const l of sync.out.split('\n')) {
    if (/entries|wrote|already current|SKIPPED|binary:/.test(l)) log(`  ${l.trim()}`);
  }
  log(`catalog sync: ${sync.ok ? 'ok' : 'FAILED'}`);

  // 4. optional end to end check
  if (verify) {
    const probe = run(process.execPath, [path.join(TOOLS, 'probe-acp-models.js'), 'both'], 8 * 60 * 1000);
    for (const l of probe.out.split('\n')) {
      if (/^===|current:|ERROR/.test(l.trim())) log(`  ${l.trim()}`);
    }
    log(`probe: ${probe.ok ? 'ok' : 'FAILED'}`);
  }

  log(`done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  finish(sync.ok ? 0 : 1);
})();
