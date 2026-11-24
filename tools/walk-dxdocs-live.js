#!/usr/bin/env node
/**
 * walk-dxdocs-live.js - the DX Docs closing pass of 0.28.6 (item 13) on the built app: one doc with every kind of block an agent or the
 * user can put in (charts of each type, a diagram, the three drawings, an svg, a question with a write-in answer, an approval, a tracker
 * table with status, date and owner chips, callouts, formulas, tasks, code, links, two tabs), made by the engine as an agent would, then
 * drawn by the staged app in its hidden window (the look command), whole and block by block. The PNGs go to .tmp\dx-walk for a look by
 * eye. Throwaway profile and folder; nothing is sent to any agent.
 *   node tools\walk-dxdocs-live.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');
const D = require(path.join(__dirname, '..', 'patches', '0009-identity', 'dxdocs.js'));

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
function pngSize(f) { try { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }; } catch (e) { return null; } }
const fence = (lang, body) => '```' + lang + '\n' + (typeof body === 'string' ? body : JSON.stringify(body)) + '\n```';

const CHARTS = [
  { type: 'bar', title: 'Tickets closed per week', unit: 'tickets', columns: ['Week', 'Team A', 'Team B'], rows: [['W1', 12, 9], ['W2', 15, 11], ['W3', 18, 14], ['W4', 16, 19], ['W5', 21, 17]], target: { value: 18, label: 'Goal' }, accent: 'Team B' },
  { type: 'line', title: 'Sign-ups over time', columns: ['Month', 'Free', 'Paid'], rows: [['Jan', 120, 8], ['Feb', 140, 11], ['Mar', 180, 15], ['Apr', 210, 19], ['May', 260, 24]], notes: [{ x: 'Mar', text: 'Launch' }], projectedFrom: 'Apr' },
  { type: 'stacked', title: 'Hours by kind of work', columns: ['Week', 'Build', 'Test', 'Docs'], rows: [['W1', 20, 8, 4], ['W2', 18, 10, 5], ['W3', 22, 9, 3], ['W4', 15, 12, 6], ['W5', 19, 11, 4]] },
  { type: 'pie', title: 'Where the time went', columns: ['Kind', 'Hours'], rows: [['Build', 94], ['Test', 50], ['Docs', 22], ['Meetings', 18], ['Other', 9]] },
  { type: 'waterfall', title: 'Budget, start to end', columns: ['Step', 'Amount'], rows: [['Start', 100], ['Hiring', -30], ['Grant', 25], ['Tools', -12], ['End', 83]], totals: ['Start', 'End'] },
  { type: 'hbar', title: 'Longest-named projects by size', columns: ['Project', 'Files'], rows: [['A project with a very long name indeed', 412], ['Another long-named project', 220], ['Third project', 180], ['Fourth project here', 160], ['Fifth', 90]] },
  { type: 'combo', title: 'Revenue and margin', columns: ['Quarter', 'Revenue', 'Margin'], rows: [['Q1', 40, 12], ['Q2', 55, 15], ['Q3', 61, 18], ['Q4', 70, 21], ['Q5', 74, 22]], lines: ['Margin'] },
  { type: 'funnel', title: 'From visit to customer', columns: ['Stage', 'People'], rows: [['Visited', 5000], ['Signed up', 1200], ['Tried it', 600], ['Paid', 140], ['Stayed', 110]] },
  { type: 'range', title: 'Estimates with their spread', columns: ['Task', 'Days'], rows: [['Plan', [2, 3, 5]], ['Build', [8, 12, 18]], ['Test', [3, 4, 7]], ['Ship', [1, 1, 2]], ['Docs', [1, 2, 4]]] },
  { type: 'scatter', title: 'Size against time', columns: ['Size', 'Hours'], rows: [[1, 2], [2, 3], [3, 5], [5, 8], [8, 13], [13, 20]] },
];

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-dx-walk-'));
  const profile = path.join(root, 'profile');
  const docsDir = path.join(root, 'Walk', 'DX Docs');
  const outDir = path.join(__dirname, '..', '.tmp', 'dx-walk');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  let app = null;
  try {
    const sections = [
      { heading: 'Charts', body: CHARTS.map((c) => fence('chart', c)).join('\n\n') },
      { heading: 'Structure', body: [
        fence('mermaid', 'flowchart LR\n  A[Ask] --> B{Clear?}\n  B -- yes --> C[Build]\n  B -- no --> D[Ask again]\n  C --> E[Test] --> F[Release]'),
        fence('drawing', { type: 'quadrant', quadrants: ['Quick wins', 'Big bets', 'Fill-ins', 'Money pits'], x: { low: 'Low effort', high: 'High effort' }, y: { low: 'Low value', high: 'High value' }, items: [{ label: 'Tabs', x: 0.2, y: 0.9 }, { label: 'Sharing', x: 0.85, y: 0.6 }, { label: 'Emoji', x: 0.3, y: 0.15 }] }),
        fence('drawing', { type: 'pillars', roof: 'A build users trust', pillars: [{ title: 'Tests', points: ['Click suite', 'Live tests'] }, { title: 'Looks', points: ['Light and dark', 'Real window sizes'] }, { title: 'Words', points: ['Plain', 'Short'] }], base: 'The user’s own asks' }),
        fence('drawing', { type: 'timeline', events: [{ date: 'November 19th', title: '0.28.5', text: 'Lane colours' }, { date: 'November 24th', title: '0.28.6 built', text: 'Accounts, teams' }, { date: 'Next', title: 'Release', text: 'After the tests' }] }),
        fence('svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect x="5" y="5" width="190" height="50" rx="10" fill="#3b82f6"/><text x="100" y="37" font-size="18" text-anchor="middle" fill="#fff">An svg block</text></svg>'),
      ].join('\n\n') },
      { heading: 'Decisions', body: [
        fence('choice', { question: 'Which account should the team lead use?', options: ['Personal', 'Work'] }),
        fence('choice', { question: 'Which parts go in this build?', options: ['Accounts', 'Teams', 'Settings'], multi: true }),
        fence('approve', { label: 'Approve the plan' }),
      ].join('\n\n') },
      { heading: 'Tracker', body: '| Item | Status | Due | Owner |\n|---|---|---|---|\n| Accounts | [[pick:Done|Not started|In progress|Done]] | [[date:2026-11-24]] | [[@agent]] |\n| Teams | [[pick:In progress|Not started|In progress|Done]] | [[date:2026-11-25]] | [[@agent]] |\n| Settings | [[pick:Not started|Not started|In progress|Done]] | [[date:2026-11-26]] | [[@agent]] |' },
      { heading: 'Writing', body: [
        '> [!WARNING]\n> A heavy rule shows under the first group of the Settings list.',
        '> [!DECISION]\n> The lead keeps its own settings.',
        '> [!NOTE]\n> Nothing is deleted when a team goes back to chats.',
        '> [!TIP]\n> Agents can do all of this for you.',
        'Inline $x^2 + 1$ and a block:\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
        '- [x] A task that is done\n- [ ] A task that is not\n\n1. A numbered step\n2. Another\n\n**Bold**, *italic*, ~~struck~~, `code`, and [a link to the tracker](#tracker).',
        fence('js', 'function hello(name) {\n  return "hello " + name;\n}'),
      ].join('\n\n') },
    ];
    const made = D.create(docsDir, { title: 'Walk of every block', sections, tabs: [{ title: 'Overview' }, { title: 'Second tab' }] });
    check('the engine takes a doc with every kind of block', made && made.id, JSON.stringify(made).slice(0, 300));
    const id = made.id;
    app = await launch({ profile, deadlineMs: 300000 });
    await sleep(4000);
    const whole = await D.look(profile, docsDir, { doc: id }, 90000).catch((e) => ({ error: e.message }));
    const ws = whole.png ? pngSize(whole.png) : null;
    if (whole.png) fs.copyFileSync(whole.png, path.join(outDir, 'whole.png'));
    check('the built app draws the whole doc', ws && ws.w >= 600 && ws.h >= 2000, JSON.stringify([whole, ws]));
    for (let i = 0; i < CHARTS.length; i++) {
      const c = await D.look(profile, docsDir, { doc: id, what: 'chart', index: i }, 45000).catch((e) => ({ error: e.message }));
      const cs = c.png ? pngSize(c.png) : null;
      if (c.png) fs.copyFileSync(c.png, path.join(outDir, 'chart-' + i + '-' + CHARTS[i].type + '.png'));
      check('it draws the ' + CHARTS[i].type + ' chart', cs && cs.w >= 300 && cs.h >= 150 && cs.bytes > 2000, JSON.stringify([c, cs]));
    }
    for (let i = 0; i < 4; i++) {
      const d = await D.look(profile, docsDir, { doc: id, what: 'drawing', index: i }, 45000).catch((e) => ({ error: e.message }));
      const s = d.png ? pngSize(d.png) : null;
      if (d.png) fs.copyFileSync(d.png, path.join(outDir, 'drawing-' + i + '.png'));
      check('it draws drawing ' + i, s && s.w >= 150 && s.bytes > 800, JSON.stringify([d, s]));
    }
    const dg = await D.look(profile, docsDir, { doc: id, what: 'diagram', index: 0 }, 45000).catch((e) => ({ error: e.message }));
    const dgs = dg.png ? pngSize(dg.png) : null;
    if (dg.png) fs.copyFileSync(dg.png, path.join(outDir, 'diagram-0.png'));
    check('it draws the Mermaid diagram', dgs && dgs.w >= 300 && dgs.bytes > 1000, JSON.stringify([dg, dgs]));
  } catch (e) {
    check('the walk ran', false, e && e.stack || e);
  } finally {
    if (app) await app.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
