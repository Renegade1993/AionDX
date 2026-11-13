#!/usr/bin/env node
// run-sections.js - runs only the named sections of click-test.js: its set-up, the sections whose `const sc = '<name>'` you list, and its
// ending (the PASS/FAIL list and the count). A quick check of new work before the full suite (about 15 minutes) runs.
//   node tools\dx-harness\run-sections.js bell docs whatsnew tips
//   node tools\dx-harness\run-sections.js --list          the section names, in order
// A section is the block `    {\n      const sc = '<name>';` ... up to the next such block or a `    // ----` heading. Writes the runner to
// %TEMP%\aiondx-click-sections.js and runs it with node (headless Edge, as the suite; its own 900 s deadline). Exit code: the suite's.
// Do not edit patches\0001-renderer-dx\aiondx-ui.js while it runs: every page load reads the file again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SUITE = path.join(__dirname, 'click-test.js');
const s = fs.readFileSync(SUITE, 'utf8').replace(/\r\n/g, '\n');
const lines = s.split('\n');
const first = lines.findIndex((l) => /^ {4}\/\/ ---- /.test(l));
const tail = lines.findIndex((l) => l === '    clearTimeout(deadline);');
if (first < 0 || tail < 0) { console.error('run-sections: click-test.js does not have the expected shape (a "    // ---- " heading, "    clearTimeout(deadline);")'); process.exit(2); }
// split the body into blocks, each starting at a "    {" line that is followed by "      const sc = '...'"
const body = lines.slice(first, tail);
const blocks = [];
let cur = null;
for (let i = 0; i < body.length; i++) {
  const m = body[i] === '    {' && /^ {6}const sc = '([^']+)';/.exec(body[i + 1] || '');
  if (m) { cur = { name: m[1], lines: [] }; blocks.push(cur); }
  if (cur) cur.lines.push(body[i]);
}
const names = [...new Set(blocks.map((b) => b.name))];
const want = process.argv.slice(2);
if (!want.length || want[0] === '--list') { console.log(names.join('\n')); process.exit(want.length ? 0 : 2); }
const unknown = want.filter((w) => !names.includes(w));
if (unknown.length) { console.error('run-sections: no section named ' + unknown.join(', ') + '. Sections: ' + names.join(' ')); process.exit(2); }
const picked = blocks.filter((b) => want.includes(b.name)).map((b) => b.lines.join('\n')).join('\n');
let out = lines.slice(0, first).join('\n') + '\n' + picked + '\n' + lines.slice(tail).join('\n');
// the runner lives in %TEMP%: point its own folder references back at the harness
out = out.split('__dirname').join(JSON.stringify(__dirname));
const runner = path.join(os.tmpdir(), 'aiondx-click-sections.js');
fs.writeFileSync(runner, out);
const r = spawnSync(process.execPath, [runner], { stdio: 'inherit', windowsHide: true, cwd: __dirname, timeout: 960000 });
process.exit(r.status === null ? 2 : r.status);
