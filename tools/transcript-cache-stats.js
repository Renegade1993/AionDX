#!/usr/bin/env node
/**
 * transcript-cache-stats.js - what Claude Code transcripts say about prompt-cache use: per model call, the context size, how much was read
 * from the cache and how much written (1-hour or 5-minute writes), the gap since the previous call, and what started the turn (an AionDX Loop
 * nudge, a tool result, other input). Prints aggregates only; no message text is read beyond the first characters needed to tell a Loop nudge.
 *
 *   node tools/transcript-cache-stats.js --since 2026-10-20 [--until 2026-11-12] [--json OUT] FILE.jsonl...
 *
 * A call is one assistant message id (streamed entries repeat; the last usage wins). "rebuilt" = the call wrote more than half its context to
 * the cache (the cache had lapsed or changed); "read" = it read more than half from the cache.
 */
'use strict';
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const a = process.argv.slice(2);
const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const since = Date.parse(val('--since') || '1970-01-01');
const until = Date.parse(val('--until') || '2100-01-01');
const out = val('--json');
const files = a.filter((x, i) => !x.startsWith('--') && !['--since', '--until', '--json'].includes(a[i - 1]));
const hard = setTimeout(() => { console.error('deadline'); process.exit(4); }, 45 * 60000); hard.unref();

const BUCKETS = [[0, 5], [5, 10], [10, 30], [30, 55], [55, 65], [65, 120], [120, 1e9]];
const bucketOf = (min) => BUCKETS.findIndex(([lo, hi]) => min >= lo && min < hi);
const label = ([lo, hi]) => hi >= 1e9 ? lo + '+ min' : lo + '-' + hi + ' min';

async function one(file) {
  const calls = new Map();   // id -> call
  const order = [];
  let lastUser = 'other', lastUserTs = 0, turnStart = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 20) continue;
    const isUser = line.indexOf('"type":"user"') >= 0 && line.indexOf('"type":"user"') < 400;
    if (isUser) {
      const head = line.slice(0, 6000);
      if (head.indexOf('"tool_result"') >= 0) lastUser = 'tool';
      else if (head.indexOf('[AionDX Loop') >= 0) lastUser = 'loop';
      else if (/\[Loop\] Resuming you after a pause/.test(head)) lastUser = 'loop';
      else lastUser = 'input';
      if (lastUser !== 'tool') turnStart = { kind: lastUser, ts: 0, calls: 0, ctx: 0, tools: 0, gap: null };
      continue;
    }
    if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) continue;
    let j; try { j = JSON.parse(line); } catch (e) { continue; }
    const m = j.message; if (!m || !m.usage || !m.id) continue;
    const ts = Date.parse(j.timestamp || '') || 0;
    const u = m.usage;
    const cc = u.cache_creation || {};
    const c = {
      ts, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, input: u.input_tokens || 0, output: u.output_tokens || 0,
      w1h: cc.ephemeral_1h_input_tokens || 0, w5m: cc.ephemeral_5m_input_tokens || 0, trigger: lastUser, tool: line.indexOf('"tool_use"') >= 0, model: m.model || '',
      turn: turnStart,
    };
    if (!calls.has(m.id)) order.push(m.id);
    calls.set(m.id, Object.assign(calls.get(m.id) || {}, c));
  }
  const list = order.map((id) => calls.get(id)).filter((c) => c.ts).sort((x, y) => x.ts - y.ts);
  for (let i = 0; i < list.length; i++) list[i].gap = i ? (list[i].ts - list[i - 1].ts) / 60000 : null;
  return list;
}

(async () => {
  const report = {};
  for (const f of files) {
    const t0 = Date.now();
    const all = await one(f);
    const list = all.filter((c) => c.ts >= since && c.ts < until && !/synthetic/.test(c.model));
    const r = { file: path.basename(f), calls: list.length, secs: Math.round((Date.now() - t0) / 1000) };
    const sum = (k) => list.reduce((s, c) => s + c[k], 0);
    r.tokens = { read: sum('read'), write: sum('write'), w1h: sum('w1h'), w5m: sum('w5m'), input: sum('input'), output: sum('output') };
    const ctxs = list.map((c) => c.read + c.write + c.input).sort((x, y) => x - y);
    r.medianContext = ctxs.length ? ctxs[Math.floor(ctxs.length / 2)] : 0;
    // gap since the previous call, against whether the cache held
    r.byGap = BUCKETS.map((b) => ({ gap: label(b), calls: 0, read: 0, rebuilt: 0 }));
    for (const c of list) {
      if (c.gap == null) continue;
      const ctx = c.read + c.write + c.input;
      const g = r.byGap[bucketOf(c.gap)];
      g.calls++;
      if (ctx > 20000 && c.write > ctx / 2) g.rebuilt++;
      else if (ctx > 20000 && c.read > ctx / 2) g.read++;
    }
    // turns started by a Loop nudge
    const turns = new Map();
    for (const c of list) if (c.turn && c.turn.kind === 'loop') {
      const t = c.turn;
      if (!turns.has(t)) { t.first = c; turns.set(t, { gap: c.gap, calls: 0, ctx: 0, tools: 0 }); }
      const x = turns.get(t); x.calls++; x.ctx += c.read + c.write + c.input; if (c.tool) x.tools++;
    }
    const lt = [...turns.values()];
    r.loopTurns = {
      turns: lt.length,
      noToolTurns: lt.filter((x) => x.tools === 0).length,
      noToolContextTokens: lt.filter((x) => x.tools === 0).reduce((s, x) => s + x.ctx, 0),
      allContextTokens: lt.reduce((s, x) => s + x.ctx, 0),
      gapOfNudge: BUCKETS.map((b) => ({ gap: label(b), turns: lt.filter((x) => x.gap != null && bucketOf(x.gap) === BUCKETS.indexOf(b)).length, noTool: lt.filter((x) => x.gap != null && bucketOf(x.gap) === BUCKETS.indexOf(b) && x.tools === 0).length })),
    };
    // per day
    const days = {};
    const dayOf = (ts) => new Date(ts).toLocaleDateString('sv');   // this PC's local date, YYYY-MM-DD
    for (const c of list) {
      const d = dayOf(c.ts);
      const x = days[d] || (days[d] = { calls: 0, read: 0, write: 0, loopTurns: 0 });
      x.calls++; x.read += c.read; x.write += c.write;
    }
    for (const c of list) if (c.turn && c.turn.kind === 'loop' && c.turn.first === c) days[dayOf(c.ts)].loopTurns++;
    r.days = days;
    report[r.file] = r;
    console.log(JSON.stringify({ file: r.file, calls: r.calls, secs: r.secs, medianContext: r.medianContext, tokens: r.tokens, loopTurns: { turns: r.loopTurns.turns, noToolTurns: r.loopTurns.noToolTurns } }));
  }
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  process.exit(0);
})();
