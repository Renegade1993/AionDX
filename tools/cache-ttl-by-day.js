#!/usr/bin/env node
/**
 * cache-ttl-by-day.js - per local day, how many prompt-cache write tokens Claude Code transcripts record at 1 hour and at 5 minutes,
 * with the Claude Code builds seen, over every transcript of both account folders (or the folders given). Counts only; no message
 * text is read. `--switches` prints instead each moment an account's main conversation changed between 5-minute and 1-hour writes.
 *
 *   node tools/cache-ttl-by-day.js [--switches] [projectsFolder...]
 *
 * Default folders: %USERPROFILE%\.claude\projects and %USERPROFILE%\.claude-work\projects. Measured with it on 2026-11-11: every
 * AionDX chat wrote 5-minute entries until October 12th and 1-hour entries from then on, with the same Claude Code build.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

setTimeout(() => { console.error('deadline'); process.exit(4); }, 20 * 60000).unref();
const args = process.argv.slice(2);
const switches = args.includes('--switches');
const roots = args.filter((a) => !a.startsWith('--'));
if (!roots.length) roots.push(path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.claude-work', 'projects'));

const files = [];
function walk(d) {
  let e;
  try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.name.endsWith('.jsonl')) files.push(p); }
}
roots.forEach(walk);

(async () => {
  const day = {};
  const rows = [];
  for (const f of files) {
    const acct = /[\\/]\.claude-work[\\/]/.test(f) ? 'work' : 'personal';
    const seen = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.indexOf('"cache_creation"') < 0) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (!m || !m.usage || !m.usage.cache_creation || !o.timestamp) continue;
      seen.set(m.id || o.uuid, { ts: o.timestamp, cc: m.usage.cache_creation, ver: o.version, side: !!o.isSidechain, acct });
    }
    for (const c of seen.values()) {
      const h = c.cc.ephemeral_1h_input_tokens || 0, q = c.cc.ephemeral_5m_input_tokens || 0;
      if (switches) { if (!c.side && (h || q)) rows.push([c.ts, h ? '1h' : '5m', c.acct, c.ver || '']); continue; }
      const d = new Date(c.ts).toLocaleDateString('sv');
      const r = day[d] || (day[d] = { h1: 0, m5: 0, calls: 0, ver: new Set() });
      r.h1 += h; r.m5 += q; r.calls++;
      if (c.ver) r.ver.add(c.ver);
    }
  }
  console.log('transcripts: ' + files.length);
  if (switches) {
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const prev = {};
    for (const r of rows) {
      if (prev[r[2]] !== r[1]) console.log(new Date(r[0]).toLocaleString('sv') + '  ' + r[2] + ' main conversation now writes ' + r[1] + ' (Claude Code ' + r[3] + ')');
      prev[r[2]] = r[1];
    }
    return;
  }
  for (const d of Object.keys(day).sort()) {
    const r = day[d], v = [...r.ver].sort();
    console.log(d + '  calls ' + r.calls + '  1h ' + r.h1 + '  5m ' + r.m5 + '  Claude Code ' + (v.length ? v[0] + '..' + v[v.length - 1] : '?'));
  }
})();
