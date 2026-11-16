'use strict';
// test-live-look.js - a look (dxdoc_look, aiondx doc look) against the built app: the staged AionDX draws a doc's chart, its diagram and the
// whole doc in its hidden window and hands back PNGs, the way an agent asks (the engine's look command, a request file in the app's data
// folder). Proves the main side's offscreen window, the app's own Mermaid and KaTeX beside it, and the answer files. Hidden (live-app.js).
//   node tools\test-live-look.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./live-app');
const D = require(path.join(__dirname, '..', 'patches', '0009-identity', 'dxdocs.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };
const pngSize = (f) => { const b = fs.readFileSync(f); return b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length } : null; };
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-live-look-'));
  const profile = path.join(root, 'profile');
  const docsDir = path.join(root, 'Atlas', 'DX Docs');
  fs.mkdirSync(docsDir, { recursive: true });
  D.create(docsDir, { title: 'Look test', sections: [
    { heading: 'Numbers', body: '```chart\n{"type":"bar","title":"Sales","x":["Q1","Q2","Q3"],"series":[{"name":"2026","values":[3,5,4]}],"target":4.5}\n```' },
    { heading: 'Steps', body: '```mermaid\nflowchart LR\n  A[Plan] --> B[Build] --> C[Release]\n```\n\nA formula: $x^2 + 1$.' }] });
  let app = null;
  try {
    app = await launch({ profile, deadlineMs: 240000 });
    await sleep(4000);
    const chart = await D.look(profile, docsDir, { doc: 'look-test', what: 'chart', index: 0 }, 45000).catch((e) => ({ error: e.message }));
    const cs = chart.png ? pngSize(chart.png) : null;
    check('the built app draws one chart as a PNG an agent can open', cs && cs.w >= 600 && cs.h >= 200 && cs.bytes > 3000, JSON.stringify([chart, cs]));
    const diagram = await D.look(profile, docsDir, { doc: 'look-test', what: 'diagram', index: 0 }, 45000).catch((e) => ({ error: e.message }));
    const ds = diagram.png ? pngSize(diagram.png) : null;
    check('and a diagram, drawn by the app\'s own Mermaid', ds && ds.w >= 300 && ds.h >= 40 && ds.bytes > 2000, JSON.stringify([diagram, ds]));
    const whole = await D.look(profile, docsDir, { doc: 'look-test' }, 45000).catch((e) => ({ error: e.message }));
    const ws = whole.png ? pngSize(whole.png) : null;
    check('and the whole doc, taller than its chart', ws && cs && ws.h > cs.h && ws.bytes > cs.bytes, JSON.stringify([whole, ws]));
    const outside = await D.look(profile, path.join(root, 'Atlas'), { doc: 'look-test' }, 8000).catch((e) => e.message);
    check('a folder that is not a DX Docs folder is refused', /No doc|DX Docs/.test(String(outside)), outside);
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    if (app) await app.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
    console.log('\n' + pass + '/' + (pass + fail) + ' passed');
    process.exit(fail ? 1 : 0);
  }
})();
