#!/usr/bin/env node
/**
 * install.js - puts patch 0007's Loop tool in place.
 *
 *   node patches\0007-loop-tool\install.js                 build if needed, copy both programs, install the skill, register the MCP row
 *   node patches\0007-loop-tool\install.js --no-register   the same without the MCP row (no AionUi chat needed)
 *   node patches\0007-loop-tool\install.js --check         report; change nothing (exit 1 if anything is missing or stale)
 *   node patches\0007-loop-tool\install.js --remove        unregister, then delete the programs and the skill
 *   node patches\0007-loop-tool\install.js --remove-skill  take out the skill only (a revert to stock AionUi)
 *
 * THREE PIECES, ALL OUTSIDE THE ASAR:
 *   %LOCALAPPDATA%\AionDX\bin\aiondx-loop.exe   the MCP server (Windows program, no console)
 *   %LOCALAPPDATA%\AionDX\bin\aiondx.exe        the same code as a console program, for shells
 *   %APPDATA%\AionUi\aionui\builtin-skills\auto-inject\aiondx-loop\   the skill every chat is offered
 * plus the MCP row in AionUi's database (POST /api/mcp/servers, then the toggle that enables it,
 * the way AionUi's MCP settings page adds a server).
 *
 * An AionUi update leaves the programs and the MCP row alone. A new backend version rewrites
 * builtin-skills and drops the skill, so tools\aiondx-apply.ps1 runs this with --no-register
 * after every swap, as it does patch 0004's installer.
 *
 * Registration talks to AionUi's API with the runtime token of the AionUi chat it runs in
 * (AIONUI_BASE_URL, AIONUI_RUNTIME_TOKEN, AIONUI_USER_ID, AIONUI_CONVERSATION_ID), so run the full
 * install from an agent's shell inside AionUi. A running agent holds its MCP server open; the old
 * copy is renamed aside (Windows allows renaming a running program) and each agent picks up the
 * new one at its next start.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const SRC = path.join(DIR, 'aiondx-loop.cs');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const BIN = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'AionDX', 'bin');
const PROGRAMS = [
  { name: 'aiondx-loop.exe', target: 'winexe' },   // MCP server
  { name: 'aiondx.exe', target: 'exe' },           // shell
];
const DATA = process.env.AIONDX_AIONUI_DATA || path.join(process.env.APPDATA || '', 'AionUi', 'aionui');
const SKILL_SRC = path.join(DIR, 'skill', 'aiondx-loop', 'SKILL.md');
const SKILL_DST = path.join(DATA, 'builtin-skills', 'auto-inject', 'aiondx-loop');
const STAMP = '.aiondx';
const NAME = 'aiondx-loop';
const DESCRIPTION = 'AionDX Loop: agents see and change the Loop button in the message box (on or off, the continue message, a compaction). AionDX patch 0007.';

const args = new Set(process.argv.slice(2));
const say = (s) => console.log(s);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const shaFile = (file) => sha(fs.readFileSync(file));
const built = (p) => path.join(DIR, p.name);
const installed = (p) => path.join(BIN, p.name);

// ---------------------------------------------------------------- programs

function build() {
  for (const p of PROGRAMS) {
    const out = built(p);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(SRC).mtimeMs) continue;
    const r = spawnSync(CSC, ['/nologo', '/optimize+', `/target:${p.target}`, '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${out}`, SRC],
      { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`building ${p.name} failed:\n${r.stdout || ''}${r.stderr || ''}`);
    say(`built ${out}`);
  }
}

/** Move a file that may be running out of the way. */
function setAside(file) {
  if (!fs.existsSync(file)) return;
  try { fs.unlinkSync(file); return; } catch { /* running: rename instead */ }
  const aside = file.replace(/\.exe$/, `.old-${Date.now()}.exe`);
  fs.renameSync(file, aside);
  say(`the running ${path.basename(file)} was renamed ${path.basename(aside)}; agents move to the new one at their next start`);
}
function sweepAside() {
  if (!fs.existsSync(BIN)) return;
  for (const f of fs.readdirSync(BIN)) {
    if (/\.old-\d+\.exe$/.test(f)) { try { fs.unlinkSync(path.join(BIN, f)); } catch { /* still running */ } }
  }
}

function copyPrograms() {
  fs.mkdirSync(BIN, { recursive: true });
  for (const p of PROGRAMS) {
    const dst = installed(p);
    if (fs.existsSync(dst) && shaFile(dst) === shaFile(built(p))) { say(`${p.name} current (${shaFile(dst)})`); continue; }
    setAside(dst);
    fs.copyFileSync(built(p), dst);
    say(`${p.name} installed: ${dst} (${shaFile(dst)})`);
  }
  sweepAside();
}

// ---------------------------------------------------------------- the skill

/** The skill as installed: the source with this machine's path to aiondx.exe filled in. */
function skillText() {
  const exe = installed(PROGRAMS[1]).replace(/\\/g, '/');
  return fs.readFileSync(SKILL_SRC, 'utf8').replace(/\{\{AIONDX\}\}/g, exe);
}

function skillState() {
  const want = sha(Buffer.from(skillText(), 'utf8'));
  const file = path.join(SKILL_DST, 'SKILL.md');
  if (!fs.existsSync(file)) return { state: 'missing', want };
  return { state: sha(fs.readFileSync(file)) === want ? 'current' : 'stale', want };
}

function installSkill() {
  if (!fs.existsSync(path.join(DATA, 'builtin-skills'))) throw new Error(`no builtin-skills folder under ${DATA} (has AionUi run on this machine?)`);
  const st = skillState();
  if (st.state === 'current') { say(`skill current: ${SKILL_DST}`); return; }
  // Written beside the target, then swapped in, so aioncore never reads half a skill.
  const staging = SKILL_DST + '.staging-' + process.pid;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'SKILL.md'), skillText());
  fs.writeFileSync(path.join(staging, STAMP), JSON.stringify({ digest: st.want, source: SKILL_SRC, at: new Date().toISOString() }, null, 1));
  fs.rmSync(SKILL_DST, { recursive: true, force: true });
  fs.renameSync(staging, SKILL_DST);
  say(`skill ${st.state === 'missing' ? 'installed' : 'refreshed'}: ${SKILL_DST} (${st.want})`);
}

// ---------------------------------------------------------------- AionUi's API

function identity() {
  const need = ['AIONUI_BASE_URL', 'AIONUI_RUNTIME_TOKEN', 'AIONUI_USER_ID', 'AIONUI_CONVERSATION_ID'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`the MCP row needs AionUi's API: run this from an agent's shell inside AionUi (${missing.join(', ')} not set), or pass --no-register`);
  return { base: process.env.AIONUI_BASE_URL.replace(/\/$/, ''), headers: {
    'x-aionui-runtime-token': process.env.AIONUI_RUNTIME_TOKEN, 'x-aionui-user-id': process.env.AIONUI_USER_ID,
    'x-aionui-conversation-id': process.env.AIONUI_CONVERSATION_ID } };
}

async function api(method, p, body) {
  const id = identity();
  const r = await fetch(id.base + p, {
    method, headers: { ...id.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`${method} ${p} answered ${r.status}: ${text.slice(0, 300)}`);
  return j && j.data !== undefined ? j.data : j;
}

async function findRow() {
  const rows = await api('GET', '/api/mcp/servers');
  return (Array.isArray(rows) ? rows : []).find((r) => r && r.name === NAME) || null;
}

async function register() {
  const command = installed(PROGRAMS[0]);
  const transport = { type: 'stdio', command, args: [], env: {} };
  let row = await findRow();
  if (!row) {
    row = await api('POST', '/api/mcp/servers', { name: NAME, description: DESCRIPTION, transport, builtin: false });
    say(`registered MCP server ${row.id}`);
  } else if (!row.transport || row.transport.command !== command) {
    row = await api('PUT', `/api/mcp/servers/${row.id}`, { transport, description: DESCRIPTION });
    say(`updated MCP server ${row.id} to ${command}`);
  } else {
    say(`MCP server registered: ${row.id}`);
  }
  if (!row.enabled) {
    row = await api('POST', `/api/mcp/servers/${row.id}/toggle`);
    say(`enabled: ${row.enabled}`);
  }
  if (!row.enabled) throw new Error('the row is still disabled after the toggle');
}

// ---------------------------------------------------------------- commands

async function check() {
  let ok = true;
  for (const p of PROGRAMS) {
    const dst = installed(p);
    if (!fs.existsSync(dst)) { say(`${p.name}: missing (${dst})`); ok = false; continue; }
    const current = fs.existsSync(built(p)) && shaFile(dst) === shaFile(built(p));
    say(`${p.name}: ${dst} (${shaFile(dst)})${current ? ', matches the build' : ', differs from the build in this folder'}`);
    if (!current) ok = false;
  }
  const st = skillState();
  say(`skill: ${st.state} (${SKILL_DST})`);
  if (st.state !== 'current') ok = false;
  try {
    const row = await findRow();
    say(row ? `MCP row: ${row.id}, enabled ${row.enabled}, command ${row.transport && row.transport.command}` : 'MCP row: none');
    if (!row || !row.enabled || !row.transport || row.transport.command !== installed(PROGRAMS[0])) ok = false;
  } catch (e) { say(`MCP row: not checked (${e.message})`); }
  return ok;
}

async function remove() {
  try {
    const row = await findRow();
    if (row) { await api('DELETE', `/api/mcp/servers/${row.id}`); say(`unregistered ${row.id}`); }
    else say('no MCP row to remove');
  } catch (e) { say(`MCP row left in place (${e.message})`); }
  for (const p of PROGRAMS) setAside(installed(p));
  sweepAside();
  if (fs.existsSync(SKILL_DST)) { fs.rmSync(SKILL_DST, { recursive: true, force: true }); say(`removed ${SKILL_DST}`); }
  say('removed the programs from ' + BIN);
}

(async () => {
  if (args.has('--check')) process.exit((await check()) ? 0 : 1);
  if (args.has('--remove')) { await remove(); return; }
  if (args.has('--remove-skill')) {   // tools\aiondx-apply.ps1, reverting to stock
    fs.rmSync(SKILL_DST, { recursive: true, force: true });
    say(`skill removed: ${SKILL_DST}`);
    return;
  }
  build();
  copyPrograms();
  installSkill();
  if (!args.has('--no-register')) await register();
})().catch((e) => { console.error('install.js: ' + e.message); process.exit(1); });
