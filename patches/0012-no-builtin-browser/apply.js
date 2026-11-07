#!/usr/bin/env node
/**
 * AionDX patch 0012-no-builtin-browser: AionUi's built-in browser is gone, and a web link opens in the
 * system browser, whatever the click.
 *
 *   node patches\0012-no-builtin-browser\apply.js <extracted-asar-root> [--check]
 *
 * A request of 2026-10-22: remove the built-in browser, and open every web link in the system browser. AionUi 2.2.2 has a browser tab in its Preview panel, a CDP bridge that lets an agent drive it, and
 * an MCP server (aionui-browser) that is on in every new chat. A link click, the "Open in built-in browser" item
 * in the selection pop-up and an agent's browser tools all opened pages inside the app.
 *
 * What it does, all in the bundle (nothing in the unpacked builtin-mcp-browser.js, which AionDX does not touch):
 *   out/main/index.js                  the CDP bridge never starts (cdpStartupEnabled is false), so no agent can
 *                                      drive a page inside the app
 *   out/main/chunks/runBackendMigrations-*.js
 *                                      the start-up step that registers the built-in MCP servers no longer adds
 *                                      aionui-browser, and deletes the one an earlier start added
 *   out/renderer/assets/*.js           openBrowserTab (what every link, selection and button called) opens the
 *                                      address in the system browser (window.open; the main window's handler
 *                                      sends http and https to shell.openExternal) and does nothing for a blank
 *                                      tab; the "Open in built-in browser" items, the new-browser-tab "+" button
 *                                      and the workspace button's Browser entry are removed; browser tabs saved
 *                                      from an earlier session are no longer restored
 *
 * SAFETY. Same rule as 0003, 0006 and 0009: every edit must match its expected count, or (on a tree this patch
 * already changed) show its marker, or nothing is written and the exit code is 1. --check reports and writes
 * nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ext = process.argv[2];
const CHECK = process.argv.includes('--check');
if (!ext || !fs.existsSync(path.join(ext, 'out', 'main', 'index.js'))) {
  console.error('usage: node apply.js <extracted asar dir> [--check]');
  process.exit(2);
}

const W = '[\\w$]+';
const mark = (id) => '/*AIONDX-0012:' + id + '*/';

// [id, files (directory, file-name pattern), regex, replacement function, expected matches]
const EDITS = [
  ['E1 bridge off', 'out/main', /^index\.js$/,
    /cdpStartupEnabled = shouldEnableCdp\(cdpConfig\);/g,
    () => 'cdpStartupEnabled = false; ' + mark('E1'), 1],
  ['E2 no default browser server', 'out/main/chunks', /^runBackendMigrations-.*\.js$/,
    /\},\s*\r?\n(\s*)buildBuiltinBrowserServer\(\)\r?\n(\s*)\];/g,
    (m, a, b) => '}' + mark('E2') + '\n' + b + '];', 1],
  ['E3 delete the registered one', 'out/main/chunks', /^runBackendMigrations-.*\.js$/,
    /if \(existingBrowserServer\) \{(\r?\n)(\s*)const desiredBrowserServer = buildBuiltinBrowserServer\(\);/g,
    (m, nl, ind) => 'if (existingBrowserServer) {' + nl + ind + mark('E3') + 'try {' + nl + ind + '  await index.mcpService.deleteServer.invoke({ id: existingBrowserServer.id });' + nl +
      ind + '  console.info("[AionDX] removed the built-in browser MCP server (patch 0012)");' + nl + ind + '} catch (error) {' + nl +
      ind + '  console.warn("[AionDX] could not remove the built-in browser MCP server", error);' + nl + ind + '}' + nl + ind.slice(2) + '}' + nl +
      ind.slice(2) + 'if (false) {' + nl + ind + 'const desiredBrowserServer = buildBuiltinBrowserServer();', 1],
  ['R1 openBrowserTab opens the system browser', 'out/renderer/assets', /\.js$/,
    new RegExp('(' + W + ')=(' + W + ')\\.useCallback\\((' + W + ')=>\\{' + W + '\\(\\3\\?\\.trim\\(\\)\\|\\|' + W + ',"browser"\\)\\},\\[' + W + '\\]\\)', 'g'),
    (m, v, r, a) => v + '=' + r + '.useCallback(' + a + '=>{const u=' + a + '?.trim();' + mark('R1') + 'u&&/^https?:\\/\\//i.test(u)&&window.open(u,"_blank")},[])', 1],
  ['R2 selection pop-up item', 'out/renderer/assets', /\.js$/,
    new RegExp(W + '&&' + W + '\\.createElement\\("span",\\{className:' + W + ',onMouseDown:' + W + '\\},' + W + '\\("common\\.openInBuiltinBrowser"\\)\\),', 'g'),
    () => mark('R2'), 1],
  ['R3 message selection item', 'out/renderer/assets', /\.js$/,
    new RegExp(W + '&&' + W + '&&' + W + '\\.createElement\\("div",\\{className:' + W + ',onMouseDown:' + W + '=>\\{' + W + '\\.preventDefault\\(\\),' + W + '\\.openBrowserTab\\(' + W + '\\),' + W + '\\(\\)\\}\\},' +
      W + '\\.createElement\\(' + W + ',\\{theme:"outline",size:"14",fill:"currentColor"\\}\\),' + W + '\\.createElement\\("span",\\{className:"text-12px font-medium"\\},' + W + '\\("common\\.openInBuiltinBrowser"\\)\\)\\),', 'g'),
    () => mark('R3'), 1],
  ['R4 no new-browser-tab button', 'out/renderer/assets', /\.js$/,
    new RegExp('onNewBrowserTab:' + W + '\\.length>0\\?' + W + ':void 0', 'g'),
    () => 'onNewBrowserTab:void 0' + mark('R4'), 1],
  ['R5 no Browser entry on the workspace button', 'out/renderer/assets', /\.js$/,
    new RegExp('(openWith\\.browser",\\{defaultValue:"Browser"\\}\\),icon:' + W + '\\.createElement\\(' + W + ',\\{size:16\\}\\),available:)!!' + W + '\\}', 'g'),
    (m, head) => head + '!1' + mark('R5') + '}', 1],
  ['R6 browser tabs are not kept', 'out/renderer/assets', /\.js$/,
    /new Set\(\["markdown","html","code","csv","diff","browser","image","pdf","word","excel","ppt","unsupported"\]\)/g,
    () => 'new Set(["markdown","html","code","csv","diff",' + mark('R6') + '"image","pdf","word","excel","ppt","unsupported"])', 1],
];

function filesFor(dir, pattern) {
  const d = path.join(ext, ...dir.split('/'));
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => pattern.test(n) && fs.statSync(path.join(d, n)).isFile()).map((n) => path.join(d, n));
}

const plan = [];     // { file, text, edits }
const texts = new Map();
let bad = 0;
for (const [id, dir, pattern, re, repl, expect] of EDITS) {
  const tag = id.split(' ')[0];
  let total = 0, done = 0;
  const hits = [];
  for (const f of filesFor(dir, pattern)) {
    if (!texts.has(f)) texts.set(f, fs.readFileSync(f, 'utf8'));
    const t = texts.get(f);
    const n = (t.match(new RegExp(re.source, 'g')) || []).length;
    if (n) { total += n; hits.push(f); }
    if (t.includes('AIONDX-0012:' + tag + '*/')) done++;
  }
  if (total === 0 && done > 0) { console.log('0012 ' + id + ': already applied'); continue; }
  if (total !== expect) { console.error('0012 ' + id + ': expected ' + expect + ' match(es), found ' + total + '; nothing written'); bad++; continue; }
  console.log('0012 ' + id + ': ' + total + ' match in ' + path.relative(ext, hits[0]).replace(/\\/g, '/'));
  plan.push({ f: hits[0], re, repl });
}
if (bad) process.exit(1);
if (CHECK) { console.log('0012: check only, nothing written'); process.exit(0); }
for (const { f, re, repl } of plan) {
  texts.set(f, texts.get(f).replace(new RegExp(re.source, 'g'), repl));
}
for (const f of new Set(plan.map((p) => p.f))) fs.writeFileSync(f, texts.get(f));
console.log('0012: wrote ' + new Set(plan.map((p) => p.f)).size + ' file(s)');
