#!/usr/bin/env node
// cache-ttl-check.js: ground truth for "is the prompt cache 1 hour or 5 minutes?". For each Claude config folder, the newest transcripts' assistant replies: time, model, 1-hour and 5-minute cache writes, cache reads.
// Usage: node tools\cache-ttl-check.js [hours, default 6]. Written 2026-11-13 (R-114): it showed a reported move to 5 minutes was a side request.
// Only usage numbers are printed, never message text.
const fs = require('fs');
const path = require('path');
const home = process.env.USERPROFILE;
const since = Date.now() - (Number(process.argv[2]) || 6) * 3600000;
for (const dir of ['.claude', '.claude-work']) {
  const proj = path.join(home, dir, 'projects');
  if (!fs.existsSync(proj)) continue;
  const files = [];
  for (const d of fs.readdirSync(proj)) {
    const pd = path.join(proj, d);
    let st; try { st = fs.statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pd, f);
      const s = fs.statSync(fp);
      if (s.mtimeMs > since) files.push({ fp, slug: d, m: s.mtimeMs });
    }
  }
  files.sort((a, b) => b.m - a.m);
  console.log(`== ${dir}: ${files.length} transcripts written in the window`);
  const tally = { only1h: 0, only5m: 0, both: 0, none: 0 };
  const recent5m = [];
  for (const { fp, slug } of files.slice(0, 40)) {
    const lines = fs.readFileSync(fp, 'utf8').split('\n');
    for (const ln of lines) {
      if (!ln.includes('"usage"')) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      const t = Date.parse(o.timestamp || '');
      if (!(t > since)) continue;
      const u = o.message && o.message.usage; if (!u) continue;
      const cc = u.cache_creation || {};
      const h = cc.ephemeral_1h_input_tokens || 0, m = cc.ephemeral_5m_input_tokens || 0;
      const k = h && m ? 'both' : h ? 'only1h' : m ? 'only5m' : 'none';
      tally[k]++;
      if (m) recent5m.push({ at: new Date(t).toISOString().slice(11, 19), chat: slug.slice(-8), side: !!o.isSidechain, model: (o.message.model || '').replace('claude-', ''), w1h: h, w5m: m, read: u.cache_read_input_tokens || 0 });
    }
  }
  console.log('   replies by cache write: ' + JSON.stringify(tally));
  recent5m.sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const r of recent5m.slice(-12)) console.log('   5m write: ' + JSON.stringify(r));
}
