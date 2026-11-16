#!/usr/bin/env node
'use strict';
/**
 * aiondx-plan-hooks.js - helping agents slow down and plan (R-127, November 15th, 2026). The user: "systemically, as in environmentally
 * (AionDX), how can we help agents slow down and think about what they are doing before they do it?", then "okay, so DX Docs is literally
 * the cure". Claude Code runs this as a hook in every Claude chat AionDX starts (the launcher passes them with --settings; hooks merge with
 * the user's own, filed research 2026-11-15_claude-code-hooks-contract-web.md):
 *
 *   prompt   (UserPromptSubmit) a build request gets a short plan-first note. Nothing here judges whether a message is a correction or
 *            tells an agent to change its skills (November 16th, 2026).
 *   stop     (Stop) an ending that says it is done, while asks in the chat's ledger are still open, is sent back once to account for each
 *   pretool  (PreToolUse on Edit, Write, MultiEdit, NotebookEdit) in a project that builds from approved plans (planGate "on" in the
 *            registry), edits wait for a plan the user approved in a DX Doc; notes and docs are always allowed
 *
 * The asks ledger: <data>\aiondx-asks\<key>.json = { asks: [{ id, at, words, state: open|built|deferred|rejected, note }] }, key c-<conv> or
 * t-<team> (aiondx asks). Approved plans: <data>\aiondx-plans.json = { "c:<conv>": {doc, at}, "t:<team>": {...} }.
 * Environment: AIONDX_DATA_DIR (the data folder), AIONDX_CONVERSATION_ID, AIONDX_TEAM_ID (set by the launcher). Never fails a turn:
 * any trouble, it exits 0 with nothing.
 */
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2];
const DATA = process.env.AIONDX_DATA_DIR || '';
const CONV = process.env.AIONDX_CONVERSATION_ID || '';
const TEAM = process.env.AIONDX_TEAM_ID || '';
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, v) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); } catch { /* never in the way */ } }
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const quiet = () => process.exit(0);

// Request notes (P-012, the user's decisions of November 16th, 2026): a note points at a tool the chat has, worded as an offer, never as
// an order; Plan, then Build, then Small change (which gets none); every note given is logged on this PC only (requestLog).
const GROUPS = [
  ['plan', /\b(plan|design|spec|outline|propose|think (it |this |that )?through)\b/i,
    'AionDX: available here for a plan: a DX Doc the user can read and comment on, with choice and Approve blocks (aiondx doc help).'],
  ['build', /\b(build|implement|create|redesign|refactor|rework|set up|wire)\b|\bmake (it|them|this|that|a|an|the)\b/i,
    'AionDX: available here: the asks ledger keeps the user\'s words (aiondx asks add); a DX Doc can show a plan, a table or a chart (aiondx doc help).'],
  ['small', /\b(fix|change|update|add|rename|remove)\b/i, null],
];
const QUESTION_RE = /^\s*(what|why|how|when|where|who|which|is|are|does|do|can|could|should|would|will)\b[^.!]*\?\s*$/i;
/** The request group a message falls in, and the word that put it there; null for a question, a command or a short message. */
function requestGroup(t) {
  t = String(t || '').trim();
  if (!t || t.length < 12 || /^\s*[/[]/.test(t) || QUESTION_RE.test(t)) return null;
  for (const [group, re, note] of GROUPS) { const m = re.exec(t); if (m) return { group, word: m[0].toLowerCase(), note }; }
  return null;
}
function readsAsBuild(t) { const g = requestGroup(t); return !!g && g.group !== 'small'; }
/** The log of notes given, on this PC only (%LOCALAPPDATA%\AionDX\request-notes: never in a package, an export or a profile copy):
 *  log.jsonl counts (no words of the message); review.jsonl the message's first words, for the user's own review list. */
function requestLog(entry, start) {
  try {
    const dir = process.env.AIONDX_REQUEST_NOTES_DIR || path.join(process.env.LOCALAPPDATA || '', 'AionDX', 'request-notes');
    if (!process.env.AIONDX_REQUEST_NOTES_DIR && !process.env.LOCALAPPDATA) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, row] of [['log.jsonl', entry], ['review.jsonl', Object.assign({}, entry, { start })]]) {
      const file = path.join(dir, f);
      try { if (fs.statSync(file).size > 2 * 1048576) { const keep = fs.readFileSync(file, 'utf8').split('\n').slice(-2000).join('\n'); fs.writeFileSync(file, keep); } } catch { /* new */ }
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    }
  } catch { /* never in the way */ }
}
function ledger() {
  const keys = [CONV && 'c-' + CONV, TEAM && 't-' + TEAM].filter(Boolean);
  let asks = [];
  for (const k of keys) { const l = readJson(path.join(DATA, 'aiondx-asks', k + '.json')); if (l && Array.isArray(l.asks)) asks = asks.concat(l.asks); }
  return asks;
}
function readInput() { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; } }

function prompt(inp) {
  const p = String(inp.prompt || '').replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' ');
  const g = requestGroup(p);
  if (!g) return quiet();
  // a chat already in Plan Mode has its plan step; the Plan note would repeat it
  const note = g.group === 'plan' && inp.permission_mode === 'plan' ? null : g.note;
  requestLog({ at: Date.now(), conv: CONV, team: TEAM || null, group: g.group, word: g.word, chars: p.length, note: note ? 'given' : 'none', noteChars: note ? note.length : 0 },
    p.replace(/\s+/g, ' ').trim().slice(0, 80));
  if (!note) return quiet();
  return out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } });
}

function stop(inp) {
  if (inp.stop_hook_active) return quiet();
  const msg = String(inp.last_assistant_message || '');
  if (!/\b(done|finished|complete[d]?|all set|ready for you|shipped|released|that's everything|wrapped up)\b/i.test(msg)) return quiet();
  const open = ledger().filter((a) => a.state === 'open');
  if (!open.length || !DATA || !CONV) return quiet();
  // once per set of open asks: the same set is not sent back twice
  const sig = open.map((a) => a.id).sort().join(',');
  const f = path.join(DATA, 'aiondx-flags', CONV + '.stop.json');
  const last = readJson(f);
  if (last && last.sig === sig) return quiet();
  writeJson(f, { sig, at: Date.now() });
  return out({ decision: 'block', reason: 'AionDX: before you say done, account for every ask. Still open in this chat\'s ledger: ' +
    open.slice(0, 12).map((a) => '#' + a.id + ' "' + String(a.words).slice(0, 120) + '"').join('; ') + (open.length > 12 ? ' and ' + (open.length - 12) + ' more' : '') +
    '. Mark each built, deferred (with the reason) or rejected: aiondx asks mark ID built|deferred|rejected --note "...", then say where each stands.' });
}

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
function pretool(inp) {
  if (!EDIT_TOOLS.test(String(inp.tool_name || '')) || !DATA) return quiet();
  const reg = readJson(path.join(DATA, 'aiondx-projects.json')) || {};
  const b = reg.bindings || {};
  const key = (CONV && b['conv:' + CONV]) || (TEAM && b['team:' + TEAM]) || null;
  const proj = key && reg.projects ? reg.projects[key] : null;
  if (!proj || proj.planGate !== 'on') return quiet();
  const file = String((inp.tool_input && (inp.tool_input.file_path || inp.tool_input.notebook_path)) || '');
  // notes, docs and plans are always allowed: that is where the plan is written
  if (/[\\/](DX Docs|! LLM Files|\.claude)[\\/]/i.test(file) || /\.(md|txt)$/i.test(file)) return quiet();
  const plans = readJson(path.join(DATA, 'aiondx-plans.json')) || {};
  if ((CONV && plans['c:' + CONV]) || (TEAM && plans['t:' + TEAM])) return quiet();
  return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'AionDX: ' + path.basename(proj.root || key) + ' builds from an approved plan. Write the plan in a DX Doc (the user\'s asks quoted, the parts against what exists, ' +
    'how each is checked) with an Approve block, and wait for the user to approve it; edits open up then. Notes and docs can be written meanwhile.' } });
}

module.exports = { readsAsBuild, requestGroup };
if (require.main === module) {
  try {
    const inp = readInput();
    if (MODE === 'prompt') prompt(inp);
    else if (MODE === 'stop') stop(inp);
    else if (MODE === 'pretool') pretool(inp);
    else quiet();
  } catch { quiet(); }
}
