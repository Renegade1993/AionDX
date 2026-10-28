#!/usr/bin/env node
/**
 * AionDX patch 0012-mcp-oauth-ui-state: an MCP server the renderer has not yet confirmed
 * authenticated never shows as authenticated, even for one render.
 *
 *   node patches\0012-mcp-oauth-ui-state\apply.js <extracted-asar-root>
 *
 * a follow-on to core-0007/0008/0009 (the MCP OAuth backend fixes), 2026-10-27.
 *
 * HOW. useMcpOAuth's markLoginRequired (upstream\packages\desktop\src\renderer\hooks\mcp\
 * useMcpOAuth.ts) sets needsLogin:true for a server but carried forward whatever
 * isAuthenticated value that server already had: `isAuthenticated: prev[id]?.isAuthenticated ??
 * false`. McpServerHeader's status icon checks needsLogin before isAuthenticated, so in the
 * current UI the two never visibly disagree. But any future read of isAuthenticated alone -
 * another component, a derived value, a later refactor - would see "authenticated" and
 * "needs login" true at once for a server IPC has just said requires a fresh login. This patch
 * makes markLoginRequired force isAuthenticated to false, so the two flags are never both true for
 * the same server.
 *
 * SAFETY. The anchor is matched by a regex that survives the bundler renaming variables (the
 * same approach as 0006), and must match exactly once in out/renderer/assets/*.js, or nothing is
 * written and the exit code is 1. Re-running on a patched tree finds the new text and changes
 * nothing. The edit only changes an object literal's value, so the bundle's syntax cannot change.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// markLoginRequired:M.useCallback(S=>{T(L=>({...L,[S]:{isAuthenticated:L[S]?.isAuthenticated??!1,needsLogin:!0,isChecking:!1}}))},[])
const ANCHOR = /markLoginRequired:(\w+)\.useCallback\((\w+)=>\{(\w+)\((\w+)=>\(\{\.\.\.\4,\[\2\]:\{isAuthenticated:\4\[\2\]\?\.isAuthenticated\?\?!1,needsLogin:!0,isChecking:!1\}\}\)\)\},\[\]\)/g;
const REPLACEMENT = (m, p1, p2, p3, p4) => 'markLoginRequired:' + p1 + '.useCallback(' + p2 + '=>{' + p3 + '(' + p4 + '=>({...' + p4 + ',[' + p2 + ']:{isAuthenticated:!1,needsLogin:!0,isChecking:!1}}))},[])';
const DONE = /markLoginRequired:\w+\.useCallback\(\w+=>\{\w+\(\w+=>\(\{\.\.\.\w+,\[\w+\]:\{isAuthenticated:!1,needsLogin:!0,isChecking:!1\}\}\)\)\},\[\]\)/;
const EXPECTED = 1;

function patchAssets(files) {
  // files: { name: text }. Returns { files, notes } or throws; never partially applies.
  const out = Object.assign({}, files);
  let total = 0;
  const hits = [];
  for (const [name, text] of Object.entries(out)) {
    const n = (text.match(ANCHOR) || []).length;
    if (n) { total += n; hits.push(name); }
  }
  if (total === 0) {
    const already = Object.values(out).some((t) => DONE.test(t));
    if (already) return { files: out, notes: ['markLoginRequired: already done'] };
    throw new Error('anchor not found: markLoginRequired');
  }
  if (total !== EXPECTED) throw new Error('markLoginRequired: expected ' + EXPECTED + ' match(es), found ' + total + ' in ' + hits.join(', '));
  for (const name of hits) out[name] = out[name].replace(ANCHOR, REPLACEMENT);
  return { files: out, notes: ['markLoginRequired: ' + total + ' in ' + hits.join(', ')] };
}

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const dir = path.join(root, 'out', 'renderer', 'assets');
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
    const files = {};
    for (const n of names) {
      const t = fs.readFileSync(path.join(dir, n), 'utf8');
      if (/markLoginRequired/.test(t)) files[n] = t; // only files that can match
    }
    const { files: patched, notes } = patchAssets(files);
    for (const [n, t] of Object.entries(patched)) if (t !== files[n]) fs.writeFileSync(path.join(dir, n), t);
    for (const note of notes) console.log('0012: ' + note);
    return 0;
  } catch (e) {
    console.error('0012: NOT APPLIED, nothing written: ' + e.message);
    return 1;
  }
}

module.exports = { patchAssets, ANCHOR, DONE };
if (require.main === module) process.exit(main(process.argv.slice(2)));
