/**
 * claude-newest-exe.js - resolve the newest Claude Code binary on this machine.
 *
 * Installed at %USERPROFILE%\.agents\claude-newest-exe.js by AionDX patch 0002.
 *
 * WHY THIS EXISTS
 * The ACP bridge decides which CLI to run in claudeCliPath() (dist/acp-agent.js):
 *
 *   if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
 *   ... otherwise the binary bundled inside @anthropic-ai/claude-agent-sdk-win32-x64
 *
 * That bundled binary is pinned to the SDK release. On 2026-09-22 it was 2.1.257 while
 * the machine had 2.1.280, and Anthropic's API refuses a model the CLI predates
 * ("Claude Code 2.1.236 does not support this model; version 2.1.280 or newer is
 * required"). The bridge asks the CLI for the model list, so a pinned binary silently
 * freezes AionUi's model picker at whatever shipped with that SDK release.
 *
 * Exporting CLAUDE_CODE_EXECUTABLE from each account's acp-wrapper.js points the bridge
 * at the native build under ~\.local\bin instead, which updates itself. New models then
 * appear in AionUi on their own.
 *
 * The version probe is cached against file size and mtime, so a wrapper launch normally
 * costs one small JSON read and no extra process spawn.
 *
 * DELIBERATE DUPLICATION
 * claude-account-router.js carries its own copy of this logic rather than requiring this
 * file. The router must degrade to "stock claude" under every failure, and a missing or
 * broken shared module would be one more way to break it. Two copies, one job each.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The real user profile, which is NOT os.homedir() in every caller.
 *
 * The second account's acp-wrapper.js sets HOME and USERPROFILE to
 * C:\Users\<you>\.claude-second-home before requiring this module, because that is what
 * selects the second credential store on Windows. os.homedir() therefore returns the sandbox
 * profile, and the native build, which lives under the real profile, is invisible from there.
 *
 * Measured on 2026-09-22: the first version of this file used os.homedir(), so under the second
 * wrapper newestClaudeExe() returned null, CLAUDE_CODE_EXECUTABLE was never set, and the second
 * agent silently kept using the older CLI bundled in the Agent SDK. It looked like the second
 * account lacked entitlement to the newer models. It did not. This was the bug.
 *
 * APPDATA is not rewritten by the wrapper, so it is the stable way back:
 * C:\Users\<you>\AppData\Roaming -> C:\Users\<you>.
 */
function realProfileDir() {
  const appdata = process.env.APPDATA;
  if (appdata) {
    const derived = path.dirname(path.dirname(appdata));
    if (derived && derived !== '.') return derived;
  }
  return os.homedir();
}

const PROFILE = realProfileDir();
const NATIVE_EXE = path.join(PROFILE, '.local', 'bin', 'claude.exe');
const NATIVE_EXE_HOMEDIR = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const NPM_EXE = path.join(
  process.env.APPDATA || path.join(PROFILE, 'AppData', 'Roaming'),
  'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
);
const CACHE = path.join(PROFILE, '.agents', 'claude-newest-exe.cache.json');

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { raw: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const x = a.parts[i] || 0;
    const y = b.parts[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function versionOf(exe, cache) {
  let st;
  try {
    st = fs.statSync(exe);
  } catch {
    return null;
  }
  const key = exe.toLowerCase();
  const hit = cache[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.version) {
    return parseVersion(hit.version);
  }
  const probe = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const version = parseVersion(probe.stdout);
  if (!version) return null;
  cache[key] = { size: st.size, mtimeMs: st.mtimeMs, version: version.raw };
  return version;
}

/**
 * Newest Claude Code binary, or null when none can be found. Callers treat null as
 * "leave CLAUDE_CODE_EXECUTABLE unset", which restores the bridge's stock behaviour of
 * using its bundled binary.
 *
 * @param {string[]} [extraCandidates] checked before the defaults, highest priority first
 * @returns {{exe: string, version: string} | null}
 */
function newestClaudeExe(extraCandidates) {
  try {
    const candidates = [...(extraCandidates || []), NATIVE_EXE, NPM_EXE, NATIVE_EXE_HOMEDIR];

    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {};
    } catch { /* first run, or unreadable: probe fresh */ }
    const before = JSON.stringify(cache);

    let best = null;
    let bestVersion = null;
    for (const candidate of candidates) {
      const version = versionOf(candidate, cache);
      if (!version) continue;
      if (!bestVersion || isNewer(version, bestVersion)) {
        best = candidate;
        bestVersion = version;
      }
    }

    if (JSON.stringify(cache) !== before) {
      try { fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2)); } catch { /* cache is only an optimization */ }
    }

    return best ? { exe: best, version: bestVersion.raw } : null;
  } catch {
    return null;
  }
}

module.exports = { newestClaudeExe, NATIVE_EXE, NPM_EXE };
