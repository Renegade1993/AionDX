'use strict';
// test-plan-hooks.js - the planning hooks (aiondx-plan-hooks.js, R-127) run as Claude Code runs them: JSON on stdin, JSON or nothing on
// stdout. A made-up data folder (registry, asks ledger, approved plans). Nothing real is read or written.
//   node patches\0009-identity\test-plan-hooks.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, 'aiondx-plan-hooks.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-planhooks-'));
const run = (mode, input, env) => {
  const r = spawnSync(process.execPath, [SCRIPT, mode], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: Object.assign({}, process.env, { AIONDX_DATA_DIR: data, AIONDX_CONVERSATION_ID: 'c1', AIONDX_TEAM_ID: '', AIONDX_REQUEST_NOTES_DIR: path.join(data, 'request-notes') }, env || {}) });
  let j = null; try { j = r.stdout ? JSON.parse(r.stdout) : null; } catch (e) { j = { raw: r.stdout }; }
  return { code: r.status, j };
};
try {
  // prompt
  let r = run('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'Build the export dialog with a preview and a save button.' });
  const ctx = (x) => x.j && x.j.hookSpecificOutput && x.j.hookSpecificOutput.additionalContext;
  // request notes (P-012, November 16th, 2026): each points at a tool, worded as an offer; no orders
  check('a build request: the Build note, pointing at the asks ledger and DX Docs', r.code === 0 && r.j && r.j.hookSpecificOutput.hookEventName === 'UserPromptSubmit' &&
    /^AionDX: available here: the asks ledger/.test(ctx(r)) && /a DX Doc can show a plan, a table or a chart/.test(ctx(r)), JSON.stringify(r));
  check('no note gives an order', !/\b(stop|must|before you|build when|do not|don't)\b/i.test(ctx(r)) && ctx(r).length <= 220, ctx(r));
  r = run('prompt', { prompt: 'Plan the export dialog and how it saves.' });
  check('a plan request: the Plan note (a DX Doc with choice and Approve blocks)', /^AionDX: available here for a plan: a DX Doc/.test(ctx(r) || ''), JSON.stringify(r));
  r = run('prompt', { prompt: 'Plan and build the export dialog.' });
  check('plan and build: the Plan note wins', /for a plan/.test(ctx(r) || ''), JSON.stringify(r));
  r = run('prompt', { prompt: 'Plan the export dialog and how it saves.', permission_mode: 'plan' });
  check('a plan request in Plan Mode: no note (it would repeat Plan Mode)', r.code === 0 && r.j === null, JSON.stringify(r));
  r = run('prompt', { prompt: 'Fix the typo in the export dialog title.' });
  check('a small change: no note', r.code === 0 && r.j === null, JSON.stringify(r));
  r = run('prompt', { prompt: 'make sure the notes are saved before you close it' });
  check('"make sure" is not a build request', r.code === 0 && r.j === null, JSON.stringify(r));
  r = run('prompt', { prompt: 'Can you make it so the dialog remembers its size' });
  check('"make it so" is a build request', /^AionDX: available here: the asks ledger/.test(ctx(r) || ''), JSON.stringify(r));
  const logDir = path.join(data, 'request-notes');
  const log = fs.readFileSync(path.join(logDir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rev = fs.readFileSync(path.join(logDir, 'review.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('the log has one line per request: its group, its word, given or not, no words of the message', log.length === 6 && log[0].group === 'build' && log[0].word === 'build' && log[0].note === 'given' &&
    log.some((x) => x.group === 'small' && x.note === 'none') && log.every((x) => !('start' in x)) && !/export dialog/.test(JSON.stringify(log)), JSON.stringify(log).slice(0, 400));
  check('the review list has the first words of each, for the user on this PC', rev.length === 6 && rev[0].start === 'Build the export dialog with a preview and a save button.' && rev.every((x) => x.start.length <= 80), JSON.stringify(rev).slice(0, 300));
  r = run('prompt', { prompt: 'Build the export dialog with a preview and a save button.' });
  r = run('prompt', { prompt: 'What does the export dialog do?' });
  check('a question: nothing', r.code === 0 && r.j === null, JSON.stringify(r));
  r = run('prompt', { prompt: 'WHY IS THE EXPORT STILL MISSING' });
  check('a message in capitals or one that sounds like a correction: nothing added, nothing flagged (AionDX does not judge messages)', r.code === 0 && r.j === null && !fs.existsSync(path.join(data, 'aiondx-flags', 'c1.json')), JSON.stringify(r));
  r = run('prompt', { prompt: '/compact' });
  check('a command: nothing', r.j === null);
  // stop
  fs.mkdirSync(path.join(data, 'aiondx-asks'), { recursive: true });
  fs.writeFileSync(path.join(data, 'aiondx-asks', 'c-c1.json'), JSON.stringify({ asks: [{ id: 1, words: 'a preview', state: 'built' }, { id: 2, words: 'a save button', state: 'open' }] }));
  r = run('stop', { last_assistant_message: 'All done: the dialog is built.', stop_hook_active: false });
  check('"done" with an ask still open: sent back once, naming it', r.j && r.j.decision === 'block' && /#2 "a save button"/.test(r.j.reason) && !/#1/.test(r.j.reason), JSON.stringify(r));
  r = run('stop', { last_assistant_message: 'Done.', stop_hook_active: false });
  check('the same open asks are not sent back twice', r.j === null, JSON.stringify(r));
  r = run('stop', { last_assistant_message: 'Done.', stop_hook_active: true });
  check('never while a stop hook is already continuing the turn', r.j === null);
  r = run('stop', { last_assistant_message: 'Here is the first half; next I wire the button.' });
  check('an ending that does not say done: nothing', r.j === null);
  fs.writeFileSync(path.join(data, 'aiondx-asks', 'c-c1.json'), JSON.stringify({ asks: [{ id: 2, words: 'a save button', state: 'built' }] }));
  fs.rmSync(path.join(data, 'aiondx-flags', 'c1.stop.json'), { force: true });
  r = run('stop', { last_assistant_message: 'Done.' });
  check('every ask accounted for: nothing', r.j === null);
  // pretool
  fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ projects: { atlas: { root: 'C:/x/Atlas', planGate: 'on' }, free: { root: 'C:/x/Free' } }, bindings: { 'conv:c1': 'atlas', 'conv:c9': 'free' } }));
  r = run('pretool', { tool_name: 'Edit', tool_input: { file_path: 'C:/x/Atlas/src/game.gd' } });
  check('a project that builds from approved plans: a code edit waits for the plan', r.j && r.j.hookSpecificOutput.permissionDecision === 'deny' && /Atlas builds from an approved plan/.test(r.j.hookSpecificOutput.permissionDecisionReason), JSON.stringify(r));
  r = run('pretool', { tool_name: 'Write', tool_input: { file_path: 'C:/x/Atlas/DX Docs/plan.md' } });
  check('the plan itself, notes and docs can be written', r.j === null);
  r = run('pretool', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  check('other tools are not held', r.j === null);
  r = run('pretool', { tool_name: 'Edit', tool_input: { file_path: 'C:/x/Free/a.js' } }, { AIONDX_CONVERSATION_ID: 'c9' });
  check('a project without the gate: edits go ahead', r.j === null);
  fs.writeFileSync(path.join(data, 'aiondx-plans.json'), JSON.stringify({ 'c:c1': { doc: 'plan-export', at: Date.now() } }));
  r = run('pretool', { tool_name: 'Edit', tool_input: { file_path: 'C:/x/Atlas/src/game.gd' } });
  check('once the user approved the plan: edits go ahead', r.j === null, JSON.stringify(r));
  r = run('prompt', { prompt: 'x' }, { AIONDX_DATA_DIR: path.join(data, 'nope') });
  check('a missing data folder never fails the turn', r.code === 0);
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
