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
// R-125: charts and diagrams are checked when an agent writes
{
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxd-ch-'));
  const c0 = D.create(dd, { title: 'Numbers', sections: [{ heading: 'Sales', intent: 'a chart' }] });
  let err = null;
  try { D.update(dd, c0.id, [{ op: 'replace_section', heading: 'Sales', body: '```chart\n{"type":"bar","x":["a","b"],"series":[{"name":"s","values":[1]}]}\n```' }]); } catch (e) { err = e.message; }
  check('a chart that does not read is refused, nothing written, with where, why and how it should look', err && /^Nothing was written: the chart at line \d+ \(section "Sales"\): "x" has 2 labels/.test(err) && /A chart block is JSON/.test(err) && /a chart/.test(fs.readFileSync(path.join(dd, c0.id + '.md'), 'utf8')), err);
  D.update(dd, c0.id, [{ op: 'replace_section', heading: 'Sales', body: '```chart\n{"type":"bar","x":["a","b"],"series":[{"name":"s","values":[1,2]}]}\n```' }]);
  check('a good one is written', /"values":\[1,2\]/.test(fs.readFileSync(path.join(dd, c0.id + '.md'), 'utf8')));
  err = null;
  try { D.update(dd, c0.id, [{ op: 'append_section', heading: 'Flow', body: '```mermaid\nflowchat LR\n  A-->B\n```' }]); } catch (e) { err = e.message; }
  check('a diagram of an unknown kind is refused, naming the kinds', err && /the diagram at line \d+ \(section "Flow"\) starts with "flowchat"; a mermaid block starts with its kind: flowchart, graph/.test(err), err);
  D.update(dd, c0.id, [{ op: 'append_section', heading: 'Flow', body: '```mermaid\n%% the steps\nflowchart LR\n  A-->B\n```' }]);
  check('a known one is written', /flowchart LR/.test(fs.readFileSync(path.join(dd, c0.id + '.md'), 'utf8')));
}

// attribution (DX Docs mirror, step 2): who wrote each version
{
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxd-by-'));
  const a0 = D.create(dd, { title: 'Who', sections: [{ heading: 'One', intent: 'x' }] });
  D.update(dd, a0.id, [{ op: 'replace_section', heading: 'One', body: 'agent words' }]);
  D.save(dd, a0.id, '# Who\n\n## One\n\nmy words\n', 'you');
  const h = D.history(dd, a0.id);
  check('each kept version says who wrote it: the agent twice, the newest version is yours', h.length === 2 && h[0].by === 'agent' && h[1].by === 'agent' && D.author(dd, a0.id).by === 'you', JSON.stringify([h, D.author(dd, a0.id)]));
  D.restore(dd, a0.id, h[0].version);
  check('a restore is yours, the version it replaced says you wrote it', D.author(dd, a0.id).by === 'you (restored an earlier version)' && D.history(dd, a0.id)[0].by === 'you', JSON.stringify(D.history(dd, a0.id)[0]));
}

// suggestions (DX Docs mirror, step 3)
{
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxd-sg-'));
  const g0 = D.create(dd, { title: 'Plan', sections: [{ heading: 'Goals', intent: 'x' }] });
  D.update(dd, g0.id, [{ op: 'replace_section', heading: 'Goals', body: 'Ship in Q3. Ship well.' }]);
  const before = fs.readFileSync(path.join(dd, g0.id + '.md'), 'utf8');
  const s1 = D.suggest(dd, g0.id, { find: 'Q3', replace: 'Q4', note: 'legal needs a month' }).suggestion;
  check('a suggestion leaves the doc as it was and is listed open', fs.readFileSync(path.join(dd, g0.id + '.md'), 'utf8') === before && s1.id === 's1' && D.suggestions(dd, g0.id).length === 1 && D.suggestions(dd, g0.id)[0].note === 'legal needs a month');
  let er = null; try { D.suggest(dd, g0.id, { find: 'Ship', replace: 'Send' }); } catch (e) { er = e.message; }
  check('words that occur twice are refused with how to fix it', /occur 2 times; quote more of them/.test(er || ''), er);
  er = null; try { D.suggest(dd, g0.id, { find: 'nowhere', replace: 'x' }); } catch (e) { er = e.message; }
  check('words not in the doc are refused', /were not found in the doc/.test(er || ''), er);
  const s2 = D.suggest(dd, g0.id, { find: ' Ship well.', replace: '' }).suggestion;
  D.decide(dd, g0.id, s1.id, 'accept', 'you');
  const after = fs.readFileSync(path.join(dd, g0.id + '.md'), 'utf8');
  check('accept applies it, keeps the version before and says whose it was', /Ship in Q4\. Ship well\./.test(after) && D.author(dd, g0.id).by === 'the agent, accepted by you' && D.suggestions(dd, g0.id).map((s) => s.id).join() === 's2', JSON.stringify([after, D.author(dd, g0.id)]));
  D.decide(dd, g0.id, s2.id, 'reject', 'you');
  check('reject leaves the doc alone and closes it', fs.readFileSync(path.join(dd, g0.id + '.md'), 'utf8') === after && D.suggestions(dd, g0.id).length === 0);
  const s3 = D.suggest(dd, g0.id, { find: 'Q4', replace: 'Q1' }).suggestion;
  D.save(dd, g0.id, after.replace('Q4', 'Q2'), 'you');
  check('a suggestion whose words changed since is marked stale, and cannot be accepted', D.suggestions(dd, g0.id)[0].stale === true && (() => { try { D.decide(dd, g0.id, s3.id, 'accept', 'you'); return false; } catch (e) { return /no longer in the doc/.test(e.message); } })());
}

// ---- tabs, rename, delete and restore (DX Docs mirror, November 15th) ----
{
  const td = path.join(root, 'tabs', 'DX Docs');
  fs.mkdirSync(td, { recursive: true });
  const err = (f) => { try { f(); return ''; } catch (e) { return e.message; } };
  // a plain doc gets its first tab: what it had becomes "Overview", the new tab follows
  const p = D.create(td, { title: 'Roadmap', sections: [{ heading: 'Now', body: 'Ship the editor.' }] });
  let r = D.update(td, p.id, [{ op: 'add_tab', title: 'Decisions', sections: [{ heading: 'Open', intent: 'what is undecided' }] }]);
  let md = fs.readFileSync(p.path, 'utf8');
  check('add_tab on a plain doc: its text becomes the first tab, the new tab comes after it, each as an invisible marker line',
    /^# Roadmap\n\n<!-- dx:tab id="t1" title="Overview" -->\n\n## Now\n\nShip the editor\.\n\n<!-- dx:tab id="t2" title="Decisions" -->\n\n## Open\n\n<!-- aiondx:pending what is undecided -->\n$/.test(md) &&
    JSON.stringify(r.tabs_added) === '["t2"]', md);
  check('a section operation on a doc with tabs must name its tab, and the error lists them',
    /This doc has tabs; say which one with "tab".*"Overview" \(t1\), "Decisions" \(t2\)/.test(err(() => D.update(td, p.id, [{ op: 'replace_section', heading: 'Open', body: 'x' }]))));
  D.update(td, p.id, [{ op: 'replace_section', tab: 'Decisions', heading: 'Open', body: 'Pricing.' }, { op: 'append_section', tab: 't1', heading: 'Next', body: 'Tabs.' }]);
  md = fs.readFileSync(p.path, 'utf8');
  check('"tab" by title or id: each operation lands in its own tab', /## Now\n\nShip the editor\.\n\n## Next\n\nTabs\.\n\n<!-- dx:tab id="t2"/.test(md) && /## Open\n\nPricing\.\n$/.test(md), md);
  D.update(td, p.id, [{ op: 'add_tab', title: 'Pricing detail', parent: 'Decisions' }, { op: 'add_tab', title: 'Notes', after: 't1' }]);
  let rd = D.read(td, p.id, { tab: 't3' });
  check('sub-tabs and placement: a sub-tab under its parent, a tab after another; read lists each tab with its sections',
    JSON.stringify(rd.tabs.map((t) => [t.id, t.title, t.parent])) === JSON.stringify([['t1', 'Overview', ''], ['t4', 'Notes', ''], ['t2', 'Decisions', ''], ['t3', 'Pricing detail', 't2']]) &&
    rd.tabs[2].sections[0].heading === 'Open' && rd.tab.id === 't3' && rd.tab.markdown === '# Roadmap\n\n', JSON.stringify(rd.tabs) + JSON.stringify(rd.tab));
  D.update(td, p.id, [{ op: 'move_tab', tab: 'Decisions', before: 't1' }, { op: 'rename_tab', tab: 't4', to: 'Meeting notes' }]);
  rd = D.read(td, p.id);
  check('move_tab takes its sub-tabs with it; rename_tab', JSON.stringify(rd.tabs.map((t) => t.id + ':' + t.title)) === JSON.stringify(['t2:Decisions', 't3:Pricing detail', 't1:Overview', 't4:Meeting notes']), JSON.stringify(rd.tabs));
  check('moving a tab under itself is refused', /No tab "t3" to move it under/.test(err(() => D.update(td, p.id, [{ op: 'move_tab', tab: 't2', parent: 't3' }]))));
  D.update(td, p.id, [{ op: 'delete_tab', tab: 'Decisions' }]);
  rd = D.read(td, p.id);
  check('delete_tab takes its sub-tabs; the last tab cannot go', JSON.stringify(rd.tabs.map((t) => t.id)) === '["t1","t4"]' &&
    /a doc keeps at least one/.test(err(() => D.update(td, p.id, [{ op: 'delete_tab', tab: 't1' }, { op: 'delete_tab', tab: 't4' }]))));
  check('an unknown operation lists the tab operations, so an agent finds them by trying', /add_tab, rename_tab, move_tab, delete_tab/.test(err(() => D.update(td, p.id, [{ op: 'make_tab', title: 'x' }]))));
  check('a tab body can be written whole, and replace_text works across tabs or within one',
    !err(() => D.update(td, p.id, [{ op: 'write', tab: 't4', markdown: '## Monday\n\nAll hands.' }, { op: 'replace_text', find: 'All hands', replace: 'Standup' }, { op: 'replace_text', tab: 't1', find: 'Tabs.', replace: 'Tabs, done.' }])) &&
    /title="Meeting notes" -->\n\n## Monday\n\nStandup\.\n$/.test(fs.readFileSync(p.path, 'utf8')) && /Tabs, done\./.test(fs.readFileSync(p.path, 'utf8')), fs.readFileSync(p.path, 'utf8'));
  const info = D.list(td).find((d) => d.id === p.id);
  check('the list counts tabs and sections across them', info.tabs === 2 && info.sections === 3, JSON.stringify(info));
  // the shared helpers: a tab's view and back
  const MD = D.MD;
  const whole = fs.readFileSync(p.path, 'utf8');
  check('a tab view is the title and that tab; writing a view back changes only that tab (and the title)',
    MD.tabView(whole, 't4') === '# Roadmap\n\n## Monday\n\nStandup.\n' &&
    MD.withTabView(whole, 't4', '# Road map\n\n## Monday\n\nStandup at 9.\n') === whole.replace('# Roadmap', '# Road map').replace('Standup.', 'Standup at 9.'), MD.tabView(whole, 't4'));
  check('a marker inside a code block is text, not a tab', MD.splitTabs('# X\n\n```\n<!-- dx:tab id="z" title="no" -->\n```\n').tabs[0].implicit === true);
  check('a title with quotes survives the marker', MD.splitTabs(MD.joinTabs({ title: 'T', tabs: [{ id: 'a', title: 'Say "hi" --> now', parent: '', body: '' }] })).tabs[0].title === 'Say "hi" - -> now');
  // a doc made with tabs
  const mt = D.create(td, { title: 'Question doc', tabs: [{ title: 'Ask', sections: [{ heading: 'Q1', intent: 'the first question' }] }, { title: 'Detail', parent: 'Ask', lead: 'More.' }] });
  rd = D.read(td, mt.id);
  check('create with tabs: each tab its own skeleton, a sub-tab by its parent\'s title', JSON.stringify(rd.tabs.map((t) => [t.id, t.title, t.parent, t.sections.length])) === JSON.stringify([['t1', 'Ask', '', 1], ['t2', 'Detail', 't1', 0]]) && rd.sections[0].pending === 'the first question', JSON.stringify(rd.tabs));
  // rename, delete, restore
  D.rename(td, p.id, 'Product roadmap');
  check('rename changes the title, keeps the file, and the version before', D.read(td, p.id).title === 'Product roadmap' && fs.existsSync(p.path) && D.history(td, p.id)[0].by === 'agent');
  D.addComment(td, p.id, { quote: 'Standup', text: 'When?', tab: 't4' });
  const del = D.remove(td, p.id);
  check('delete moves the doc, its comments and versions to the recycle folder; the list no longer has it',
    !fs.existsSync(p.path) && !D.list(td).some((d) => d.id === p.id) && fs.existsSync(path.join(td, '.recycle', del.deleted, '.comments', p.id + '.json')) && D.recycled(td)[0].title === 'Product roadmap', JSON.stringify(D.recycled(td)));
  D.create(td, { title: 'Roadmap' });   // its old id is taken again
  const back = D.undelete(td, del.deleted);
  check('restore brings it back with its comments and versions, under a free id when its own is taken',
    back.id === 'roadmap-2' && D.read(td, back.id).title === 'Product roadmap' && D.comments(td, back.id)[0].tab === 't4' && D.history(td, back.id).length > 3 && !D.recycled(td).length, JSON.stringify(back));
  check('restore refuses a name that is not one of its own', /Which deleted doc/.test(err(() => D.undelete(td, '../x'))));
  // comments from the agent's side (row 33), on a chart (row 32); a broken question block is refused with its line
  const cq = D.create(td, { title: 'Ask doc', sections: [{ heading: 'Plan', body: 'Ship the **beta** first.\n\n```chart\n{"type":"bar","x":["a"],"series":[{"name":"s","values":[1]}]}\n```' }] });
  const ac = D.addComment(td, cq.id, { quote: 'Ship the beta first', text: 'Which beta?', by: 'agent' });
  const ch = D.addComment(td, cq.id, { on: 'chart', index: 0, section: 'the chart', text: 'Too small?', by: 'user' });
  check('an agent comments on words as they read (Markdown marks ignored), a person on a chart', ac.by === 'agent' && ch.on === 'chart' && ch.index === 0 && D.comments(td, cq.id).length === 2);
  check('an agent\'s comment on words that are not in the doc is refused', /were not found in the doc/.test(err(() => D.addComment(td, cq.id, { quote: 'Ship the gamma', text: 'x', by: 'agent' }))));
  // the user's own suggestion; talk on it; the decision closes the talk
  const us = D.suggest(td, cq.id, { find: 'Ship the **beta** first.', replace: 'Ship the beta in March.', by: 'you' }).suggestion;
  const talk = D.addComment(td, cq.id, { sg: us.id, text: 'Why March?', by: 'agent' });
  check('talk on a suggestion is a thread of its own', talk.on === 'suggestion' && talk.sg === us.id && /No suggestion "s99"/.test(err(() => D.addComment(td, cq.id, { sg: 's99', text: 'x' }))));
  D.decide(td, cq.id, us.id, 'accept', 'the agent');
  check('accepting it applies it and closes its talk', /Ship the beta in March\./.test(fs.readFileSync(path.join(td, cq.id + '.md'), 'utf8')) && D.comments(td, cq.id).find((c) => c.id === talk.id).resolved === true);
  check('a question block that does not read is refused, with the line and the shape it needs',
    /the question block at line \d+ \(section "Plan"\): it needs "options": two or more strings \(a choice block is/.test(err(() => D.update(td, cq.id, [{ op: 'append_to_section', heading: 'Plan', body: '```choice\n{"question":"When?","options":["now"]}\n```' }]))));
}

} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
