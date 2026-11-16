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
    env: Object.assign({}, process.env, { AIONDX_DATA_DIR: data, AIONDX_CONVERSATION_ID: 'c1', AIONDX_TEAM_ID: '' }, env || {}) });
  let j = null; try { j = r.stdout ? JSON.parse(r.stdout) : null; } catch (e) { j = { raw: r.stdout }; }
  return { code: r.status, j };
};
try {
  // prompt
  let r = run('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'Build the export dialog with a preview and a save button.' });
  check('a build request: a plan-first note as additional context', r.code === 0 && r.j && r.j.hookSpecificOutput.hookEventName === 'UserPromptSubmit' && /before you build, see the whole thing/.test(r.j.hookSpecificOutput.additionalContext), JSON.stringify(r));
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
