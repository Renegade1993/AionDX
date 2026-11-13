'use strict';
// test-dxdocs.js - the DX Docs engine (dxdocs.js) on a made-up folder: where a chat's docs live, a doc made as a skeleton of pending sections
// and filled one by one, every update operation, all-or-nothing updates, history and restore, comments and replies, and the command line.
//   node patches\0009-identity\test-dxdocs.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const D = require(path.join(__dirname, 'dxdocs.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-dxdocs-'));
try {
  const data = path.join(root, 'data'), proj = path.join(root, 'Atlas'), ws = path.join(root, 'chat-ws');
  for (const d of [data, proj, ws]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, 'aiondx-projects.json'), JSON.stringify({ version: 1, projects: { atlas: { root: proj } }, bindings: { 'conv:c1': 'atlas', 'team:t1': 'atlas' } }));
  let w = D.resolveRoot({ dataDir: data, convId: 'c1', workspace: ws });
  check('a chat bound to a project keeps its docs in the project\'s Docs folder', w && w.project === 'atlas' && w.docsDir === path.join(proj, 'DX Docs'), JSON.stringify(w));
  check('a team member finds its team\'s project', D.resolveRoot({ dataDir: data, convId: 'm9', teamId: 't1', workspace: ws }).project === 'atlas');
  w = D.resolveRoot({ dataDir: data, convId: 'c2', workspace: ws });
  check('an unbound chat keeps them in its working folder', w && w.project === null && w.docsDir === path.join(ws, 'DX Docs'), JSON.stringify(w));
  const dir = path.join(proj, 'DX Docs');

  const c = D.create(dir, { title: 'Launch plan', sections: [{ heading: 'Goals', intent: 'the three outcomes this quarter commits to' }, { heading: 'Risks', intent: 'what could stop it' }] });
  let md = fs.readFileSync(c.path, 'utf8');
  check('create writes the skeleton: the title, a heading per section, each pending with what it will hold', c.id === 'launch-plan' &&
    md === '# Launch plan\n\n## Goals\n\n<!-- aiondx:pending the three outcomes this quarter commits to -->\n\n## Risks\n\n<!-- aiondx:pending what could stop it -->\n', JSON.stringify(md));
  check('a second doc with the same title gets its own id', D.create(dir, { title: 'Launch plan' }).id === 'launch-plan-2');
  let r = D.read(dir, 'launch-plan');
  check('read lists the sections and which are pending', r.title === 'Launch plan' && r.sections.length === 2 && r.sections[0].pending === 'the three outcomes this quarter commits to', JSON.stringify(r.sections));
  let u = D.update(dir, 'launch-plan', [{ op: 'replace_section', heading: 'goals', body: '1. Ship\n2. Sell' }]);
  md = fs.readFileSync(c.path, 'utf8');
  check('filling a section replaces its pending line (headings match without case), and says what is still pending', /## Goals\n\n1\. Ship\n2\. Sell\n/.test(md) && JSON.stringify(u.pending) === '["Risks"]', md);
  check('the version before is kept', D.history(dir, 'launch-plan').length === 1 && /aiondx:pending the three/.test(D.readVersion(dir, 'launch-plan', D.history(dir, 'launch-plan')[0].version)));
  u = D.update(dir, 'launch-plan', [
    { op: 'append_to_section', heading: 'Risks', body: 'Supplier delay.' },
    { op: 'append_to_section', heading: 'Risks', body: 'Price change.' },
    { op: 'insert_after', after: 'Goals', heading: 'Budget', body: '$10,000' },
    { op: 'append_section', heading: 'Next steps', body: '- Book the room' },
    { op: 'rename_section', heading: 'Budget', to: 'Money' },
    { op: 'set_title', title: 'Launch plan, Q1' },
    { op: 'set_lead', body: 'For the board.' },
  ]);
  md = fs.readFileSync(c.path, 'utf8');
  check('several operations in one update, in order: append to a pending section (the pending line goes), insert, append, rename, title, lead',
    md === '# Launch plan, Q1\n\nFor the board.\n\n## Goals\n\n1. Ship\n2. Sell\n\n## Money\n\n$10,000\n\n## Risks\n\nSupplier delay.\n\nPrice change.\n\n## Next steps\n\n- Book the room\n' && u.pending.length === 0, JSON.stringify(md));
  let threw = '';
  try { D.update(dir, 'launch-plan', [{ op: 'set_title', title: 'X' }, { op: 'replace_section', heading: 'Nowhere', body: 'y' }]); } catch (e) { threw = e.message; }
  check('an operation that cannot apply refuses the whole update, names the sections, and changes nothing', /No section "Nowhere"\. Sections: "Goals", "Money", "Risks", "Next steps"\./.test(threw) &&
    fs.readFileSync(c.path, 'utf8') === md, threw);
  threw = '';
  try { D.update(dir, 'launch-plan', [{ op: 'replace_text', find: 'e', replace: 'E' }]); } catch (e) { threw = e.message; }
  check('replace_text that matches more than once asks for more of it, or all', /occurs \d+ times/.test(threw), threw);
  D.update(dir, 'launch-plan', [{ op: 'replace_text', find: 'Supplier delay.', replace: 'Supplier delay (two weeks).' }]);
  check('replace_text with one match changes just that', /Supplier delay \(two weeks\)\./.test(fs.readFileSync(c.path, 'utf8')));
  D.update(dir, 'launch-plan', [{ op: 'delete_section', heading: 'Money' }]);
  check('delete_section takes the section out', !/## Money/.test(fs.readFileSync(c.path, 'utf8')));
  // headings inside a code block are text, not sections
  D.update(dir, 'launch-plan', [{ op: 'append_to_section', heading: 'Next steps', body: '```\n## not a heading\n```' }]);
  r = D.read(dir, 'launch-plan');
  check('a heading inside a code block is not a section', r.sections.map((s) => s.heading).join('|') === 'Goals|Risks|Next steps', r.sections.map((s) => s.heading).join('|'));
  // history and restore
  const hist = D.history(dir, 'launch-plan');
  const first = hist[hist.length - 1];
  D.restore(dir, 'launch-plan', first.version);
  check('restore brings an earlier version back, keeping the current one in the history', /aiondx:pending the three/.test(fs.readFileSync(c.path, 'utf8')) && D.history(dir, 'launch-plan').length === hist.length + 1);
  D.save(dir, 'launch-plan', '# Edited by hand\r\n\r\nText\r\n');
  check('the user\'s own save writes the Markdown (line ends made plain) and keeps the version before', fs.readFileSync(c.path, 'utf8') === '# Edited by hand\n\nText\n' && D.history(dir, 'launch-plan').length === hist.length + 2);
  // comments
  const cm = D.addComment(dir, 'launch-plan', { quote: 'Text', text: 'Say which text.', section: '' });
  check('a comment is kept with the doc, open', D.comments(dir, 'launch-plan').length === 1 && D.comments(dir, 'launch-plan')[0].text === 'Say which text.' && !cm.resolved && D.info(dir, 'launch-plan').openComments === 1);
  D.replyComment(dir, 'launch-plan', cm.id, { text: 'Done: it is the board summary.', resolve: true });
  const cc = D.comments(dir, 'launch-plan')[0];
  check('the agent replies and resolves it', cc.resolved && cc.replies.length === 1 && cc.replies[0].by === 'agent' && D.info(dir, 'launch-plan').openComments === 0, JSON.stringify(cc));
  // list
  const l = D.list(dir);
  check('list: each doc with its title, newest first; history and comments folders are not docs', l.length === 2 && l.every((x) => /^launch-plan/.test(x.id)), JSON.stringify(l.map((x) => x.id)));
  threw = '';
  try { D.read(dir, '../secrets'); } catch (e) { threw = e.message; }
  // a project with its own docs folder keeps it to itself (Windows folder names ignore case)
  fs.mkdirSync(path.join(proj, 'docs-own'), { recursive: true });
  check('DX Docs never uses a project\'s own "docs" folder', D.resolveRoot({ dataDir: data, convId: 'c1', workspace: ws }).docsDir.toLowerCase() !== path.join(proj, 'docs').toLowerCase());
  check('a doc id cannot reach outside the Docs folder', /A doc id is its file name/.test(threw), threw);
  // the command line, as the aiondx tool runs it
  const cli = (args) => { const r2 = spawnSync(process.execPath, [path.join(__dirname, 'dxdocs.js')].concat(args), { encoding: 'utf8', windowsHide: true, timeout: 30000 }); try { return JSON.parse(r2.stdout); } catch (e) { return { raw: r2.stdout + r2.stderr }; } };
  const base = ['--data-dir', data, '--conv', 'c2', '--workspace', ws];
  let o = cli(['create'].concat(base, ['--json', JSON.stringify({ title: 'Notes', sections: [{ heading: 'One', intent: 'first' }] })]));
  check('command line: create in the chat\'s folder', o.ok && o.id === 'notes' && o.docsDir === path.join(ws, 'DX Docs'), JSON.stringify(o));
  o = cli(['update'].concat(base, ['--json', JSON.stringify({ doc: 'notes', ops: [{ op: 'replace_section', heading: 'One', body: 'Filled.' }] })]));
  check('command line: update', o.ok && o.done[0] === 'replace_section' && o.pending.length === 0, JSON.stringify(o));
  o = cli(['read'].concat(base, ['--json', '{"doc":"nope"}']));
  check('command line: an error is a JSON answer with ok false', o.ok === false && /No doc "nope"/.test(o.error), JSON.stringify(o));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
