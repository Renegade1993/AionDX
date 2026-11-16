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

const BUILD_RE = /\b(build|implement|add|make|create|write|fix|change|redesign|refactor|rework|set up|wire|ship|update)\b/i;
const QUESTION_RE = /^\s*(what|why|how|when|where|who|which|is|are|does|do|can|could|should|would|will)\b[^.!]*\?\s*$/i;
function readsAsBuild(t) {
  t = String(t || '').trim();
  if (!t || t.length < 12 || /^\s*[/[]/.test(t) || QUESTION_RE.test(t)) return false;
  return BUILD_RE.test(t);
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
  if (readsAsBuild(p)) {
    return out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      'AionDX: before you build, see the whole thing. Put each ask of this request in the ledger in the user\'s words (aiondx asks add "..."), ' +
      'and for anything bigger than a small fix, the plan in a DX Doc the user can see (their asks quoted, a table of parts against what exists, how each is checked). ' +
      'Build when you could describe the finished thing part by part.' } });
  }
  return quiet();
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

module.exports = { readsAsBuild };
if (require.main === module) {
  try {
    const inp = readInput();
    if (MODE === 'prompt') prompt(inp);
    else if (MODE === 'stop') stop(inp);
    else if (MODE === 'pretool') pretool(inp);
    else quiet();
  } catch { quiet(); }
}
