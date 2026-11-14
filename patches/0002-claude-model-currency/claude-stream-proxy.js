/**
 * claude-stream-proxy.js - the account router's pass-through between AionCore and Claude, so AionDX
 * can take back a message Claude has not read yet (AionDX, 2026-09-25).
 *
 * a request of September 25th. AionCore writes a message sent mid-turn straight into
 * Claude's stdin, stamped with the message's msg_id as its uuid; Claude keeps it in its own command
 * queue until its next step, and AionUi shows it "Unread". Claude drops a queued message on a
 * `cancel_async_message` control request naming that uuid (tested live 2026-09-25,
 * tools\cancel-queued-test.js). AionCore owns Claude's stdin, so the router, which launches Claude,
 * sits in between:
 *
 *   AionCore stdin  -> this proxy -> claude stdin     whole lines, byte for byte; AionDX's control
 *                                                      requests go in only between two lines
 *   claude stdout   -> this proxy -> AionCore stdout  byte for byte, except the answers to AionDX's
 *                                                      own requests (request_id "aiondx-..."), which
 *                                                      AionCore never asked for
 *
 * Unsend requests come from AionUi's settings store (aiondx.unsend.req.<uuid> = {conv, messageId,
 * at}, written by the renderer's Unsend button), read here from the database every second,
 * read-only. The answer goes back to the store through AionUi's API with the runtime token AionCore
 * gives every agent: aiondx.unsend.result.<uuid> = {cancelled, conv, messageId, at, error?}, and the
 * request key is removed.
 *
 * stderr is not touched (inherited). Any failure to start falls back to the router's plain launch.
 */
'use strict';
const { spawn } = require('child_process');

const OURS = Buffer.from('"request_id":"aiondx-');
const CONTROL = Buffer.from('"control_response"');
const RESULT = Buffer.from('"type":"result"');   // Claude's end-of-turn line
const COMPACT = Buffer.from('"subtype":"compact_boundary"');   // a compaction finished (R-103)
const PREFIX = 256;            // bytes of a line read before deciding whether it is AionDX's
const REQ = 'aiondx.unsend.req.';
const RES = 'aiondx.unsend.result.';
const MAX_REQ_AGE_MS = 120000; // an older request is from a chat's earlier process: ignored

/**
 * Start Claude behind the pass-through. Resolves with Claude's exit code.
 * opts: exe, args, env, cwd, convId, database, apiBase, apiHeaders, log, pollMs, input, output
 */
// ---------------------------------------------------------------------------
// The usage tap (2026-10-01)
// ---------------------------------------------------------------------------
/*
 * reads the account's usage windows from the traffic Claude Code already makes (AionDX,
 * 2026-10-01).
 *
 * A request of October 1st made usage information in the UI and in the agents the top priority, to be proven on real calls before it
 * is built in. Every response to a subscription Messages call carries the account's usage in
 * anthropic-ratelimit-unified-* headers (5-hour and 7-day utilization, resets, status). Claude Code reads them and
 * prints them only at a threshold or a hit limit, and a call of AionDX's own to read them is not something
 * Anthropic's terms allow with a subscription token (the September 26th probe, switched off). So the router starts
 * Claude with ANTHROPIC_BASE_URL pointing here: this listens on loopback, hands each request to the real API
 * untouched (same headers, same body, streamed both ways) and passes the answer back untouched. The only thing it
 * does is read the answer's headers on the way past. No extra request is made, and nothing here holds the token
 * except in the request it is forwarding.
 *
 *   startTap({ upstream, onResponse, log }) -> Promise<{ url, port, close() }>
 *     upstream    where requests really go (default https://api.anthropic.com, or the caller's own
 *                 ANTHROPIC_BASE_URL when it already set one)
 *     onResponse  (info) for each answer from a /v1/messages route: { status, path, headers (lower-case names),
 *                 usage: readUsage(headers) or null }
 *
 * readUsage(headers) -> { status, claim, five_hour: {u, reset, status}, seven_day: {u, reset, status} } or null.
 * u is the fraction of the window used (0..1, above 1 past the cap); reset is epoch seconds.
 */
const http = require('http');
const https = require('https');

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

function readUsage(h) {
  const num = (k) => { const v = Number(h[k]); return h[k] !== undefined && h[k] !== '' && isFinite(v) ? v : null; };
  const win = (w) => ({
    u: num(`anthropic-ratelimit-unified-${w}-utilization`),
    reset: num(`anthropic-ratelimit-unified-${w}-reset`),
    status: h[`anthropic-ratelimit-unified-${w}-status`] || null,
  });
  const five = win('5h'), week = win('7d');
  if (five.u === null && week.u === null) return null;
  return { status: h['anthropic-ratelimit-unified-status'] || null, claim: h['anthropic-ratelimit-unified-representative-claim'] || null,
    five_hour: five, seven_day: week };
}

// ---------------------------------------------------------------------------
// The prompt cache, measured (2026-11-11)
// ---------------------------------------------------------------------------
/*
 * The first event of every streamed Messages answer (message_start) carries the call's usage, and that says how long the cache it
 * wrote lasts: usage.cache_creation.ephemeral_1h_input_tokens or ephemeral_5m_input_tokens. Claude Code marks the requests that are
 * not the chat's main conversation with x-claude-code-agent-id (a subagent) or x-claude-code-agent-type (subagent, workflow, auxiliary,
 * side_reply); the main conversation's carry neither (tools\probe-cache-headers.js, measured November 11th: main calls wrote 1-hour
 * entries, the subagent's call 5-minute ones). On this PC every main-conversation write was 5-minute until October 12th, 2026 and
 * 1-hour from then on, with the same Claude Code build, so the length is decided on Anthropic's side and can change again: AionDX reads
 * it from each answer instead of assuming one.
 *
 *   watchStart(requestHeaders, upstreamResponse, onCall, log): looks at the answer's first bytes as they pass (decompressed when they are
 *   gzip, br or deflate) until message_start, then stops looking; the answer itself goes to Claude untouched. onCall gets
 *   { main, at, model, read, write, w1h, w5m, input }.
 */
const zlib = require('zlib');
const START_RE = /event: message_start\r?\ndata: (\{.*\})\r?\n/;
const START_MAX = 65536;   // a message_start is a few hundred bytes; give up after this much text
function watchStart(reqHeaders, ur, onCall, log) {
  const main = !reqHeaders['x-claude-code-agent-id'] && !reqHeaders['x-claude-code-agent-type'];
  if (!/event-stream/i.test(String(ur.headers['content-type'] || ''))) return;
  const enc = String(ur.headers['content-encoding'] || '').trim().toLowerCase();
  // The answer's first bytes are decompressed in one synchronous step each time a chunk arrives (a sync flush accepts a cut-off
  // stream), so no zlib stream is left working when the answer or the process ends.
  const unzip = enc === 'gzip' || enc === 'x-gzip' ? (b) => zlib.gunzipSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    : enc === 'deflate' ? (b) => zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    : enc === 'br' ? (b) => zlib.brotliDecompressSync(b, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
    : !enc || enc === 'identity' ? (b) => b : null;
  if (!unzip) return;
  const parts = [];
  let size = 0;
  let done = false;
  const stop = () => { done = true; ur.removeListener('data', onData); };
  function onData(c) {
    if (done) return;
    parts.push(c);
    size += c.length;
    let text;
    try { text = unzip(parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('utf8'); } catch { stop(); return; }
    const m = START_RE.exec(text);
    if (!m) { if (size > START_MAX || text.length > START_MAX) stop(); return; }
    stop();
    let msg;
    try { msg = JSON.parse(m[1]).message || {}; } catch { return; }
    const u = msg.usage || {};
    const cc = u.cache_creation || {};
    const n = (v) => (Number(v) > 0 ? Number(v) : 0);
    try {
      onCall({ main, at: Date.now(), model: String(msg.model || ''), read: n(u.cache_read_input_tokens), write: n(u.cache_creation_input_tokens),
        w1h: n(cc.ephemeral_1h_input_tokens), w5m: n(cc.ephemeral_5m_input_tokens), split: !!u.cache_creation, input: n(u.input_tokens) });
    } catch (e) { log('tap: onCall failed: ' + e.message); }
  }
  ur.on('data', onData);
  ur.on('end', () => { if (!done) stop(); });
}

/*
 * The chat's cache record, from the main conversation's calls:
 *   aiondx.cache.conv.<conversation> = { at, until, ttl, read, write, ctx, model, calls, rebuilt?, v: 1 }
 * at: the last main call. until: the latest moment any entry those calls wrote or refreshed can still live (each call: its time plus
 * the length its writes were given; a call that only read keeps the length the cache had). Past until the cache is gone for certain;
 * before it, Anthropic may still drop it early, which the next call shows. rebuilt: the last call that wrote most of its context
 * again (a cold cache, or a changed prefix): { at, tokens, afterMin, early } where early means it came before the newest part's end.
 * tailUntil: when the newest part runs out; longUntil: when a part written for an hour runs out (0 for none). They differ only after
 * Anthropic moved the chat from an hour to 5 minutes (2026-11-11.3): until stays the later one, the Loop keeps warm against tailUntil.
 * Written at the end of each turn, when the length changes or a rebuild happens, and otherwise at most once a minute.
 */
const CACHE_TTL_MS = { '1h': 3600000, '5m': 300000 };
const CACHE_KEY = 'aiondx.cache.conv.';
const CACHE_ACCT_KEY = 'aiondx.cache.acct.';
const CACHE_WRITE_GAP_MS = 60000;
const REBUILD_MIN_CTX = 20000;
/*
 * The fixed part of a request (2026-11-12, R-103: the context meter showed the pre-compaction size after a compaction finished). Claude
 * reports a compaction as compact_boundary { pre_tokens, post_tokens }: pre_tokens is the whole context before, post_tokens only the
 * compacted conversation, without the system prompt and tool definitions every request carries (AionCore's own notes measured 2,065 against
 * a next turn of 27,238). So the size after a compaction is post_tokens plus that fixed part. Its tokens are estimated from the last main
 * call: that call's context times the fixed part's share of its request body (system and tools against messages, by length). The next
 * real reply measures the size exactly and replaces the estimate.
 */
const SHARE_MAX_BYTES = 32 * 1024 * 1024;
function readShare(req, out, log) {
  const parts = [];
  let size = 0, over = false;
  req.on('data', (d) => { if (over) return; size += d.length; if (size > SHARE_MAX_BYTES) { over = true; parts.length = 0; return; } parts.push(d); });
  req.on('end', () => {
    if (over || !size) return;
    try {
      const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const fixed = JSON.stringify(j.system || '').length + JSON.stringify(j.tools || []).length;
      const conv = JSON.stringify(j.messages || []).length;
      if (fixed > 0 && fixed + conv > 0) out.v = fixed / (fixed + conv);
    } catch (e) { log('tap: request body not read: ' + e.message); }
  });
}

const CTX_KEY = 'aiondx.ctx.conv.';
/** A request with no agent header that is still not the conversation: one of Claude Code's own side requests (a quick Haiku check of a command,
 *  a title). It is far smaller than a conversation call, which carries the whole system prompt and tools, or it runs on Haiku while the chat
 *  does not. Such a request must not move the chat's cache record or the account's cache length (2026-11-13: one wrote a 5-minute cache and
 *  the work account was reported moved to 5 minutes, while every reply in the transcripts was cached for an hour). */
const SIDE_MAX_CTX = 4000;
function isSideCall(c, prev) {
  const ctx = (Number(c.read) || 0) + (Number(c.write) || 0) + (Number(c.input) || 0);
  if (ctx < SIDE_MAX_CTX) return true;
  return /haiku/i.test(String(c.model || '')) && !!(prev && prev.model) && !/haiku/i.test(String(prev.model));
}

function startCache(opts, log) {
  const noop = { record() {}, compacted() {}, flush() {}, stop() { return Promise.resolve(); } };
  if (!opts.convId || !opts.apiBase || !opts.apiHeaders) return noop;
  const key = CACHE_KEY + opts.convId;
  // Every request still out is kept, so the process can wait for them before it exits (an exit with a request in flight lost the last
  // record and, on Windows, could end the process on a libuv assertion instead of Claude's exit code).
  const inflight = new Set();
  const api = (method, route, body) => {
    const p = fetch(opts.apiBase + route, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, opts.apiHeaders),
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
    });
    const settled = p.then(() => {}, () => {});
    inflight.add(settled);
    settled.then(() => inflight.delete(settled));
    return p;
  };
  let rec = null;            // the record as this process knows it
  let dirty = false, lastPut = 0, timer = null, stopped = false;
  // The account's length (a request of 2026-11-11: if Anthropic moves the account back to 5 minutes, AionDX notices by itself):
  //   aiondx.cache.acct.<account> = { v: 1, label, ttl, at, from, changedAt }
  // written when this process's first measured call finds no record, and whenever a call's length differs from it. The page tells the
  // user once per change.
  const acctKey = opts.usage && opts.usage.key ? CACHE_ACCT_KEY + opts.usage.key : '';
  const acctLabel = (opts.usage && opts.usage.label) || '';
  let acct = null, acctRead = false, acctPending = null, shortRun = 0;
  function noteAccount(ttl, at) {
    if (!acctKey || !ttl || stopped) return;
    // Until the stored length is read, keep the newest call's length and judge it then.
    if (!acctRead) { acctPending = { ttl, at }; return; }
    if (acct && acct.ttl === ttl) { if (ttl === '1h') shortRun = 0; return; }
    // An account on an hour is reported as moved to 5 minutes only when two replies in a row say so; back to an hour at once.
    if (ttl === '5m' && acct && acct.ttl === '1h' && ++shortRun < 2) return;
    shortRun = 0;
    const from = acct ? acct.ttl : null;
    acct = { v: 1, label: acctLabel, ttl, at, from, changedAt: from ? at : 0 };
    if (from) log(`prompt cache length for the ${acctLabel || 'account'} account is now ${ttl === '1h' ? '1 hour' : '5 minutes'} (was ${from === '1h' ? '1 hour' : '5 minutes'})`);
    const body = {};
    body[acctKey] = acct;
    api('PUT', '/api/settings/client', body).then((r) => { if (!r.ok) log('account cache length not saved: ' + r.status); }, (e) => log('account cache length not saved: ' + e.message));
  }
  // The records an earlier process left: the chat's until still bounds the cache; the account's length is what a change is measured from.
  const keys = acctKey ? key + ',' + acctKey : key;
  api('GET', '/api/settings/client?keys=' + encodeURIComponent(keys)).then((r) => (r.ok ? r.json() : null)).then((j) => {
    const data = (j && (j.data || j)) || {};
    const a = data[acctKey];
    if (acctKey && !acct && a && typeof a === 'object' && (a.ttl === '1h' || a.ttl === '5m')) acct = Object.assign({}, a);
    const old = data[key];
    if (!old || typeof old !== 'object' || !(Number(old.until) > 0)) return;
    if (!rec) rec = Object.assign({}, old);
    else if (Number(old.until) > rec.until && Number(old.at) <= rec.at) rec.until = Number(old.until);
  }).catch(() => { /* no earlier record */ }).then(() => {
    acctRead = true;
    if (acctPending) { const p = acctPending; acctPending = null; noteAccount(p.ttl, p.at); }
  });
  function put() {
    if (!rec || stopped) return;
    dirty = false; lastPut = Date.now();
    if (timer) { clearTimeout(timer); timer = null; }
    const body = {};
    body[key] = rec;
    api('PUT', '/api/settings/client', body).then((r) => { if (!r.ok) log('cache record not saved: ' + r.status); }, (e) => log('cache record not saved: ' + e.message));
  }
  let fixedTokens = 0;       // the fixed part of the last main call, in tokens (estimated)
  function compacted(meta) {
    if (stopped || !meta) return;
    const post = Number(meta.post_tokens) || Number(meta.postTokens) || 0, pre = Number(meta.pre_tokens) || Number(meta.preTokens) || 0;
    if (!(post > 0)) { log('compaction: Claude gave no size after it (pre ' + pre + ')'); return; }
    const tokens = fixedTokens + post;
    const body = {};
    body[CTX_KEY + opts.convId] = { v: 1, at: Date.now(), pre, post, fixed: fixedTokens, tokens, estimated: true };
    log(`compaction: about ${tokens} tokens now (${post} compacted conversation + ${fixedTokens} system prompt and tools), ${pre} before`);
    api('PUT', '/api/settings/client', body).then((r) => { if (!r.ok) log('compaction estimate not saved: ' + r.status); }, (e) => log('compaction estimate not saved: ' + e.message));
  }
  function record(c) {
    if (stopped || !c || !c.main) return;
    const prev = rec;
    if (isSideCall(c, prev)) return;
    if (c.share > 0 && c.share < 1) fixedTokens = Math.round((c.read + c.write + c.input) * c.share);
    // ttl is the length of the newest part: a 1-hour part always comes before a 5-minute one, so a call that wrote both ends in 5 minutes.
    const bucket = c.w5m > 0 ? '5m' : c.w1h > 0 ? '1h' : c.write > 0 ? null : (prev && prev.ttl) || null;
    const ctx = c.read + c.write + c.input;
    const next = { v: 1, at: c.at, until: prev && prev.until > c.at ? prev.until : 0, ttl: bucket, read: c.read, write: c.write, ctx, model: c.model,
      calls: ((prev && prev.calls) || 0) + 1, rebuilt: (prev && prev.rebuilt) || null };
    // longUntil: when the part written for an hour runs out. A read restarts a part's lifetime at the length it was written with (Anthropic:
    // reading a 5-minute entry restarts its 5 minutes even when the request asks for an hour), so a call that read while an hour part was
    // alive keeps it another hour. A record from before 2026-11-11.3 has no longUntil: its until is the hour part's when its ttl was 1h.
    const prevLong = !prev ? 0 : Number(prev.longUntil) > 0 ? Number(prev.longUntil) : prev.ttl === '1h' ? Number(prev.until) || 0 : 0;
    next.longUntil = c.w1h > 0 || (c.read > 0 && prevLong > c.at) ? c.at + CACHE_TTL_MS['1h'] : prevLong > c.at ? prevLong : 0;
    // tailUntil: when the newest part (what this call wrote, or what it read at the length it had) runs out. Equal to until unless Anthropic
    // moved the chat from an hour to 5 minutes and an older hour part still lives; the Loop keeps the chat warm against this one.
    next.tailUntil = bucket ? c.at + CACHE_TTL_MS[bucket] : 0;
    next.until = Math.max(next.until, next.tailUntil, next.longUntil);
    // A call that wrote with no length given cannot be bounded: the record says so (until 0) and the page shows no cache state.
    if (!bucket && c.write > 0) { next.until = 0; next.tailUntil = 0; next.longUntil = 0; }
    let important = !prev || (prev.ttl !== bucket);
    if (bucket) noteAccount(bucket, c.at);
    if (ctx >= REBUILD_MIN_CTX && c.read < ctx / 2 && prev && prev.at) {
      const prevTail = Number(prev.tailUntil) > 0 ? Number(prev.tailUntil) : Number(prev.until) || 0;
      next.rebuilt = { at: c.at, tokens: c.write, afterMin: Math.round((c.at - prev.at) / 60000), early: !!(prevTail && prevTail > c.at) };
      important = true;
      log(`cache rebuilt: ${c.write} tokens written ${next.rebuilt.afterMin} min after the last call${next.rebuilt.early ? ', before its time was up' : ''}`);
    }
    rec = next;
    dirty = true;
    if (important || Date.now() - lastPut >= CACHE_WRITE_GAP_MS) put();
    else if (!timer) timer = setTimeout(() => { timer = null; if (dirty) put(); }, CACHE_WRITE_GAP_MS - (Date.now() - lastPut));
  }
  return {
    record,
    compacted,
    flush() { if (dirty) put(); },
    /** Writes what is left; resolves when every request is answered or after 2 s. */
    stop() {
      if (dirty) put();
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      return Promise.race([Promise.all([...inflight]), new Promise((r) => setTimeout(r, 2000).unref())]);
    },
  };
}

function startTap(opts) {
  const log = opts.log || function () {};
  const up = new URL(opts.upstream || 'https://api.anthropic.com');
  const secure = up.protocol === 'https:';
  const lib = secure ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 32 });
  const basePath = up.pathname.replace(/\/+$/, '');
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers.host = up.host;
    const pr = lib.request({
      host: up.hostname, port: up.port || (secure ? 443 : 80), method: req.method, path: basePath + req.url, headers, agent,
    }, (ur) => {
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(ur.statusCode || 502, ur.statusMessage, out);
      ur.pipe(res);
      // Headers arrive before the body: read them now, so a long stream does not delay the reading.
      try {
        if (/\/v1\/messages(?:[?/]|$)/.test(req.url) && opts.onResponse) {
          opts.onResponse({ status: ur.statusCode, path: req.url.split('?')[0], headers: ur.headers, usage: readUsage(ur.headers) });
        }
      } catch (e) { log('tap: onResponse failed: ' + e.message); }
      try {
        if (/^\/v1\/messages(?:\?|$)/.test(req.url) && ur.statusCode === 200 && opts.onCall) {
          watchStart(req.headers, ur, (c) => opts.onCall(Object.assign(c, { share: reqShare.v })), log);
        }
      } catch (e) { log('tap: cache reading failed: ' + e.message); }
    });
    pr.on('error', (e) => {
      log('tap: upstream error: ' + e.message);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'AionDX usage tap: ' + e.message } })); }
      else res.destroy();
    });
    // A request the client gives up on (a cancelled turn) ends the upstream one too.
    res.on('close', () => { if (!res.writableEnded) pr.destroy(); });
    const reqShare = { v: 0 };
    if (req.method === 'POST' && /^\/v1\/messages(?:\?|$)/.test(req.url) && !req.headers['content-encoding']) readShare(req, reqShare, log);
    req.pipe(pr);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.keepAliveTimeout = 120000;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, url: 'http://127.0.0.1:' + port,
        close() { try { server.close(); } catch { /* closed */ } for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } } try { agent.destroy(); } catch { /* gone */ } },
      });
    });
  });
}


// ---------------------------------------------------------------------------
// The account's usage windows, for AionDX's meter (2026-09-26)
// ---------------------------------------------------------------------------
// a request. /api/oauth/usage needs a user:profile token, and AionUi's Claude
// agents run on setup-token (user:inference) tokens (P-003). The Messages API, though, answers subscription
// traffic with anthropic-ratelimit-unified-* headers (5-hour and 7-day utilization, resets, status), measured
// with both accounts on September 26th (tools\probe-claude-usage.js); the free count_tokens route does not
// carry them, and a refused (429) call carries them at no cost. So while a Claude chat runs, a one-token Haiku
// call reads its account's windows: 10 s after the session starts, then every 5 minutes, and after a turn ends
// if the last reading is over 90 s old. The reading goes to AionUi's settings store,
//   aiondx.usage.acct.<key> = { label, at, status, five_hour: {u, reset, status}, seven_day: {...} }
//   aiondx.usage.conv.<conversation> = { acct: <key>, at }
// where <key> is the first 12 hex characters of the token's SHA-256 (never the token). Every chat of the same
// account shares one reading and one schedule: a probe runs only when the stored one is older than it should
// be. The token is the one in this process's environment (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN, which
// the router sets from the account's token file), or else the access token in the config folder's
// .credentials.json, read again at every probe because Claude Code refreshes it there. `claude /login` writes
// that file only when the system's secure store fails (Claude Code 2.1.283 keeps it in Windows Credential
// Manager through Bun.secrets, which AionDX does not read), so most /login accounts get no meter. AionDX never
// reads the refresh token, and skips a probe while the token has expired. "usageMeter": false in the router
// config switches it off.
const USAGE_EVERY_MS = 5 * 60000;
const USAGE_AFTER_TURN_MS = 90000;
// Always the newest Haiku the account is offered (a request of 2026-10-12): the build Claude Code itself resolves `haiku` to, as the model
// catalog (claude-model-catalog.js) last saved it in the account's config folder; this constant only when there is no catalog yet.
const USAGE_MODEL = 'claude-haiku-5-5';
function usageModel(configDir) {
  try {
    const st = JSON.parse(require('fs').readFileSync(require('path').join(configDir, 'aiondx-models.json'), 'utf8'));
    const h = (st.models || []).find((m) => m && m.value === 'haiku');
    const id = h && String(h.resolvedModel || '');
    if (/^claude-haiku-[0-9a-z-]+$/.test(id)) return id;
  } catch { /* no catalog yet */ }
  return USAGE_MODEL;
}

function headerMap(headers) {
  const g = (k) => headers.get(k);
  const num = (k) => { const v = Number(g(k)); return isFinite(v) ? v : null; };
  const win = (w) => ({ u: num(`anthropic-ratelimit-unified-${w}-utilization`), reset: num(`anthropic-ratelimit-unified-${w}-reset`),
    status: g(`anthropic-ratelimit-unified-${w}-status`) || null });
  const five = win('5h'), week = win('7d');
  if (five.u === null && week.u === null) return null;
  return { status: g('anthropic-ratelimit-unified-status') || null, claim: g('anthropic-ratelimit-unified-representative-claim') || null,
    five_hour: five, seven_day: week };
}

/** The token for one probe: the environment's, or the current access token in the account's .credentials.json
 *  (null while it has expired or cannot be read). */
function probeToken(u) {
  if (u.token) return u.token;
  try {
    const o = JSON.parse(require('fs').readFileSync(u.tokenFile, 'utf8')).claudeAiOauth || {};
    const exp = Number(o.expiresAt) || 0;
    if (!o.accessToken || (exp && exp < Date.now() + 60000)) return null;
    return String(o.accessToken);
  } catch { return null; }
}

// October 1st, 2026: the numbers now come from Claude's own traffic (claude-usage-tap.js: this process starts Claude
// with ANTHROPIC_BASE_URL on a loopback forwarder that reads the unified headers of the answers going past), so
// no call of AionDX's own is made and nothing presents itself as Claude Code. The probe below stays for a router
// config that asks for it ("usageProbe": true) and is off otherwise. usage.record() writes a tap reading to the store.
function startUsage(opts, log) {
  const u = opts.usage;
  const noop = { stop() {}, turnEnded() {}, record() {} };
  if (!u || !u.key || !opts.apiBase || !opts.apiHeaders) return noop;
  const probing = u.probe !== false && !!(u.token || u.tokenFile);
  const accKey = 'aiondx.usage.acct.' + u.key;
  const convKey = 'aiondx.usage.conv.' + opts.convId;
  let timer = null, running = false, stopped = false, lastAt = 0;
  const api = (method, route, body) => fetch(opts.apiBase + route, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, opts.apiHeaders),
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  // A reading from the tap: written when a window moved a whole percent or a status changed, else at most once a
  // minute (the store logs every write, and a busy team has several Claude processes on one account).
  let lastSig = '', lastPut = 0;
  // How often a reading that has not moved is written again: the owner's setting (the usage meter's panel, aiondx.usage.config.writeSec;
  // 60 s by default). Read at most every 30 s, and any trouble keeps the last value.
  let gapMs = 60000, gapAt = 0;
  function refreshGap(now) {
    if (now - gapAt < 30000) return;
    gapAt = now;
    api('GET', '/api/settings/client?keys=aiondx.usage.config').then((r) => (r.ok ? r.json() : null)).then((j) => {
      const c = j && (j.data || j)['aiondx.usage.config'];
      const sec = c && Number(c.writeSec);
      if (sec >= 5 && sec <= 600) gapMs = sec * 1000;
    }).catch(() => {});
  }
  function record(usage, info) {
    if (stopped || !usage) return;
    const now = Date.now();
    refreshGap(now);
    const pct = (w) => (w && w.u !== null ? Math.round(w.u * 100) : -1);
    const sig = [usage.status, usage.five_hour.status, usage.seven_day.status, pct(usage.five_hour), pct(usage.seven_day), info && info.status >= 400 ? 'err' : 'ok'].join('|');
    if (sig === lastSig && now - lastPut < gapMs) return;
    lastSig = sig; lastPut = now; lastAt = now;
    const body = {};
    body[accKey] = Object.assign({ label: u.label || '', plan: u.plan || '', at: now, http: info ? info.status : 0, via: 'tap' }, usage);
    body[convKey] = { acct: u.key, at: now };
    api('PUT', '/api/settings/client', body).then((r) => { if (!r.ok) log('usage not saved: ' + r.status); }, (e) => log('usage not saved: ' + e.message));
    log(`usage: 5h ${usage.five_hour.u} week ${usage.seven_day.u} (${usage.status || '?'}), http ${info ? info.status : '?'}, from claude's own traffic`);
  }
  if (!probing) return { stop() { stopped = true; }, turnEnded() {}, record };
  async function probe(minAge) {
    if (running || stopped) return;
    running = true;
    try {
      // The account's last reading, whichever chat took it.
      try {
        const r = await api('GET', '/api/settings/client?keys=' + encodeURIComponent(accKey));
        const j = r.ok ? await r.json() : null;
        const rec = j && (j.data || j)[accKey];
        if (rec && rec.at) lastAt = Math.max(lastAt, Number(rec.at) || 0);
      } catch { /* the store is optional here */ }
      const body = {};
      body[convKey] = { acct: u.key, at: Date.now() };
      const due = Date.now() - lastAt >= minAge;
      const token = due ? probeToken(u) : null;
      if (due && !token) log('usage: no current token in .credentials.json; probe skipped');
      if (token) {
        const r = await fetch(opts.usageUrl || 'https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
          body: JSON.stringify({ model: u.configDir ? usageModel(u.configDir) : USAGE_MODEL, max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: '.' }] }),
          signal: AbortSignal.timeout(15000),
        });
        try { await r.arrayBuffer(); } catch { /* body not needed */ }
        const m = headerMap(r.headers);
        if (m) {
          lastAt = Date.now();
          body[accKey] = Object.assign({ label: u.label || '', at: lastAt, http: r.status }, m);
          log(`usage: 5h ${m.five_hour.u} week ${m.seven_day.u} (${m.status || '?'}), http ${r.status}`);
        } else log(`usage: no rate-limit headers (http ${r.status})`);
      }
      const w = await api('PUT', '/api/settings/client', body);
      if (!w.ok) log('usage not saved: ' + w.status);
    } catch (e) {
      log('usage probe failed: ' + e.message);
    } finally { running = false; }
  }
  const first = setTimeout(() => { probe(USAGE_EVERY_MS - 30000); timer = setInterval(() => probe(USAGE_EVERY_MS - 30000), USAGE_EVERY_MS); }, 10000);
  return {
    stop() { stopped = true; clearTimeout(first); if (timer) clearInterval(timer); },
    turnEnded() { probe(USAGE_AFTER_TURN_MS); },
    record,
  };
}

// ---------------------------------------------------------------------------
// YOLO means YOLO (2026-10-01)
// ---------------------------------------------------------------------------
// a request of October 1st, and a team's developer agent "got switched off yolo mode without my having done so". AionCore starts Claude with
// --permission-mode default and applies the chat's stored mode afterwards with a set_permission_mode request
// (aiondx-session claude.rs); when that step is missed the process stays on default while AionUi still shows YOLO,
// and even in bypassPermissions Claude asks (can_use_tool) for what its own safety checks flag, a dangerous rm for
// one. Each of those stops the agent until the owner clicks. So a can_use_tool request on a chat whose STORED mode is
// bypassPermissions is answered here, at once, with allow, and AionCore never sees it. The stored mode, read from the
// AionUi database, is the authority, not the process's: a chat the owner switched to another mode in the pill is left alone.
// A tool that needs the owner's own answer (AskUserQuestion, ExitPlanMode) is never answered here. Every answer is logged
// (what, which chat, why Claude asked) to %LOCALAPPDATA%\AionDX\logs\auto-approve.log, and so is every mode
// change AionCore makes, which is how the next unexplained switch gets explained.
const CANUSE = Buffer.from('"subtype":"can_use_tool"');
const NEEDS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);
const YOLO = 'bypassPermissions';

function maskSecrets(s) {
  return String(s).replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<hidden>').replace(/\b(sk-ant-|ghp_|github_pat_|xox[bp]-|AKIA)[A-Za-z0-9_-]{6,}/g, '$1<hidden>')
    .replace(/((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)\S{6,}/gi, '$1<hidden>');
}

function makeApprover(opts, log) {
  const args = opts.args || [];
  let runMode = null;
  const pi = args.indexOf('--permission-mode');
  if (pi >= 0) runMode = String(args[pi + 1] || '');
  if (args.indexOf('--dangerously-skip-permissions') >= 0) runMode = YOLO;
  let cache = { at: 0, v: null };
  const logFile = opts.approveLog === undefined
    ? require('path').join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'AionDX', 'logs', 'auto-approve.log') : opts.approveLog;
  const tag = String(opts.convId || '?').slice(0, 8);
  function note(line) {
    if (!logFile) return;
    try {
      const fs = require('fs');
      fs.mkdirSync(require('path').dirname(logFile), { recursive: true });
      try { if (fs.statSync(logFile).size > 256 * 1024) fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8').split('\n').slice(-800).join('\n')); } catch { /* none yet */ }
      fs.appendFileSync(logFile, new Date().toISOString() + ' conv=' + tag + ' ' + line + '\n');
    } catch { /* logging never stops an agent */ }
  }
  /** The mode AionUi stores for this chat (what the owner chose in the pill), cached for 1.5 s. */
  function stored() {
    if (!opts.database || !opts.convId) return null;
    const now = Date.now();
    if (now - cache.at < 1500) return cache.v;
    let v = cache.v;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(opts.database, { readOnly: true });
      try {
        const r = db.prepare("SELECT json_extract(extra,'$.current_mode_id') AS m, json_extract(extra,'$.session_mode') AS s FROM conversations WHERE id = ?").get(opts.convId);
        v = r ? (r.m || r.s || null) : null;
      } finally { db.close(); }
    } catch { /* keep the last answer */ }
    cache = { at: now, v };
    return v;
  }
  let repaired = false;
  return {
    /** True when this chat is in YOLO mode as AionUi stores it (the process's own mode only when nothing is stored). */
    yolo() { const s = stored(); return (s || runMode) === YOLO; },
    /** AionCore's lines to Claude: remember the process's mode, and log every change. */
    noteStdin(buf) {
      if (buf.indexOf('set_permission_mode') < 0) return;
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.indexOf('set_permission_mode') < 0) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const r = j && j.request;
        if (!r || r.subtype !== 'set_permission_mode') continue;
        const m = String(r.mode || '');
        note(`mode ${runMode || '?'} -> ${m} (set by ${/^aiondx-/.test(String(j.request_id || '')) ? 'AionDX' : 'AionCore'}; the chat stores ${stored() || 'nothing'})`);
        runMode = m;
      }
    },
    /** One can_use_tool line from Claude: the control_response to write back, or null when it is not ours to answer. */
    decide(buf) {
      let j; try { j = JSON.parse(buf.toString('utf8')); } catch { return null; }
      const req = j && j.request;
      if (!j || j.type !== 'control_request' || !req || req.subtype !== 'can_use_tool' || !j.request_id) return null;
      const tool = String(req.tool_name || '');
      if (NEEDS_USER.has(tool) || !this.yolo()) return null;
      const input = req.input && typeof req.input === 'object' ? req.input : {};
      const what = input.command || input.file_path || input.path || input.url || input.pattern || JSON.stringify(input).slice(0, 80);
      const why = req.decision_reason || req.blocked_path || req.description || '';
      note(`allow ${tool}: ${maskSecrets(String(what).replace(/\s+/g, ' ')).slice(0, 110)}${why ? ' [asked because: ' + maskSecrets(String(why).replace(/\s+/g, ' ')).slice(0, 90) + ']' : ''} (process mode ${runMode || '?'}, stored ${stored() || '-'})`);
      return { id: String(j.request_id), reply: { type: 'control_response', response: { subtype: 'success', request_id: j.request_id,
        response: { behavior: 'allow', updatedInput: input } } } };
    },
    /** Once per process, when Claude is on another mode than the chat stores: set it right, so it stops asking. */
    repairRequest() {
      if (repaired || runMode === YOLO || stored() !== YOLO) return null;
      repaired = true;
      note(`the process runs ${runMode || '?'} but the chat stores ${YOLO}: asking Claude to switch`);
      runMode = YOLO;
      return JSON.stringify({ type: 'control_request', request_id: 'aiondx-mode-1', request: { subtype: 'set_permission_mode', mode: YOLO } });
    },
  };
}

function startProxy(opts) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const log = opts.log || function () {};
  return new Promise((resolve) => {
    const usage = startUsage(opts, log);
    const cache = startCache(opts, log);
    // The usage tap first: Claude needs its port at launch. Any trouble starting it: Claude runs without it.
    if (opts.tap === false || !opts.usage || !opts.usage.key) { launch(null); return; }
    const upstream = (opts.env && opts.env.ANTHROPIC_BASE_URL) || undefined;
    startTap({ upstream, onResponse: (i) => usage.record(i.usage, i), onCall: (c) => cache.record(c), log }).then(launch, (e) => { log('usage tap not started: ' + e.message); launch(null); });

    function launch(tap) {
    const env = tap ? Object.assign({}, opts.env, { ANTHROPIC_BASE_URL: tap.url }) : opts.env;
    let child;
    try {
      child = spawn(opts.exe, opts.args, { env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    } catch (e) {
      log('could not start claude: ' + e.message);
      if (tap) tap.close();
      usage.stop();
      resolve(1);
      return;
    }
    let finished = false;
    let timer = null;
    const approver = opts.approve === false ? null : makeApprover(opts, log);

    // ---- AionCore -> Claude: whole lines only, so an injected line never lands inside one of AionCore's
    let rest = [];
    let restLen = 0;
    const inject = [];
    const toChild = (buf) => {
      if (!child.stdin.writable) return;
      if (!child.stdin.write(buf)) { input.pause(); child.stdin.once('drain', () => input.resume()); }
    };
    const flushInject = () => { while (inject.length && restLen === 0) toChild(Buffer.from(inject.shift() + '\n', 'utf8')); };
    input.on('data', (chunk) => {
      const nl = chunk.lastIndexOf(10);
      if (nl < 0) { rest.push(chunk); restLen += chunk.length; return; }
      let whole;
      if (restLen) { rest.push(chunk.subarray(0, nl + 1)); whole = Buffer.concat(rest); }
      else whole = chunk.subarray(0, nl + 1);
      if (approver) { try { approver.noteStdin(whole); } catch { /* the pass-through never depends on the log */ } }
      toChild(whole);
      rest = []; restLen = 0;
      if (nl + 1 < chunk.length) { rest.push(chunk.subarray(nl + 1)); restLen = chunk.length - nl - 1; }
      flushInject();
    });
    input.on('end', () => {
      if (restLen) toChild(Buffer.concat(rest));
      rest = []; restLen = 0;
      flushInject();
      try { child.stdin.end(); } catch { /* already closed */ }
    });
    child.stdin.on('error', () => { /* Claude has gone; its exit ends this */ });

    // ---- Claude -> AionCore: streamed; the first PREFIX bytes of each line decide whether it is ours
    let mode = 'start';        // 'start' reading a line's head, 'pass' forwarding its tail, 'swallow' collecting ours, 'tee' forwarding and collecting
    let tee = [], teeLen = 0;  // a compaction line longer than the head: forwarded as it comes, and kept to be read at its end
    let head = [];
    let headLen = 0;
    let swallow = [];
    const toOut = (buf) => {
      if (!output.write(buf)) { child.stdout.pause(); output.once('drain', () => child.stdout.resume()); }
    };
    const pending = new Map();  // request id -> { uuid, v }
    function answer(buf) {
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { return; }
      const resp = (j && j.response) || {};
      const p = pending.get(resp.request_id);
      if (!p) return;
      pending.delete(resp.request_id);
      const cancelled = resp.subtype === 'success' && !!(resp.response && resp.response.cancelled);
      const result = { cancelled: cancelled, conv: opts.convId, messageId: String(p.v.messageId || ''), at: Date.now() };
      if (resp.subtype !== 'success') result.error = String(resp.error || 'error').slice(0, 200);
      log(`unsend ${p.uuid}: ${cancelled ? 'cancelled' : 'not in the queue (already taken)'}${result.error ? ' (' + result.error + ')' : ''}`);
      if (!opts.apiBase || !opts.apiHeaders) { log('unsend result not saved: no AionUi API in this process'); return; }
      const body = {};
      body[RES + p.uuid] = result;
      body[REQ + p.uuid] = null;
      fetch(opts.apiBase + '/api/settings/client', {
        method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, opts.apiHeaders), body: JSON.stringify(body),
      }).then((r) => { if (!r.ok) log('unsend result not saved: ' + r.status); }, (e) => log('unsend result not saved: ' + e.message));
    }
    // A can_use_tool line of a YOLO chat is collected whole ('perm'), answered here and kept from AionCore; any
    // other line of that kind goes on to AionCore unchanged. autoIds: requests answered here, whose later
    // retraction (control_cancel_request) AionCore must not see either.
    let swallowKind = 'ours';
    const autoIds = new Set();
    function permLine(buf, out) {
      let d = null;
      try { d = approver ? approver.decide(buf) : null; } catch { d = null; }
      if (!d) { out.push(buf); return; }
      autoIds.add(d.id);
      inject.push(JSON.stringify(d.reply));
      const fix = approver.repairRequest();
      if (fix) inject.push(fix);
      flushInject();
    }
    child.stdout.on('data', (chunk) => {
      let i = 0;
      const out = [];
      while (i < chunk.length) {
        if (mode === 'tee') {
          const nl = chunk.indexOf(10, i);
          const end = nl < 0 ? chunk.length : nl + 1;
          const part = chunk.subarray(i, end);
          out.push(part);
          if (teeLen < 1048576) { tee.push(part); teeLen += part.length; }
          i = end;
          if (nl >= 0) {
            const whole = Buffer.concat(tee);
            tee = []; teeLen = 0;
            mode = 'start';
            try { const j = JSON.parse(whole.toString('utf8')); if (j && j.type === 'system' && j.subtype === 'compact_boundary') cache.compacted(j.compact_metadata || j.compactMetadata); } catch { /* cut short, or not that line */ }
          }
          continue;
        }
        if (mode === 'pass' || mode === 'swallow') {
          const nl = chunk.indexOf(10, i);
          const end = nl < 0 ? chunk.length : nl + 1;
          if (mode === 'pass') out.push(chunk.subarray(i, end)); else swallow.push(chunk.subarray(i, end));
          i = end;
          if (nl >= 0) {
            if (mode === 'swallow') {
              const whole = Buffer.concat(swallow);
              swallow = [];
              if (swallowKind === 'perm') permLine(whole, out); else answer(whole);
            }
            mode = 'start';
          }
          continue;
        }
        const nl = chunk.indexOf(10, i);
        const room = PREFIX - headLen;
        const end = nl >= 0 && nl + 1 - i <= room ? nl + 1 : Math.min(chunk.length, i + room);
        head.push(chunk.subarray(i, end));
        headLen += end - i;
        i = end;
        const complete = nl >= 0 && end === nl + 1;
        if (!complete && headLen < PREFIX) break;   // the chunk ended inside a short head: wait for more
        const h = head.length === 1 ? head[0] : Buffer.concat(head);
        head = []; headLen = 0;
        if (h.indexOf(RESULT) >= 0) { usage.turnEnded(); cache.flush(); }
        let teeing = false;
        if (h.indexOf(COMPACT) >= 0) {
          if (complete) {
            try { const j = JSON.parse(h.toString('utf8')); if (j && j.type === 'system' && j.subtype === 'compact_boundary') cache.compacted(j.compact_metadata || j.compactMetadata); } catch { /* not that line */ }
          } else teeing = true;
        }
        if (h.indexOf(CONTROL) >= 0 && h.indexOf(OURS) >= 0) {
          swallowKind = 'ours';
          if (complete) answer(h); else { swallow = [h]; mode = 'swallow'; }
        } else if (approver && h.indexOf(CANUSE) >= 0 && approver.yolo()) {
          swallowKind = 'perm';
          if (complete) permLine(h, out); else { swallow = [h]; mode = 'swallow'; }
        } else if (autoIds.size && h.indexOf('control_cancel_request') >= 0 && complete && [...autoIds].some((id) => h.indexOf(id) >= 0)) {
          /* a retraction of a request answered here: AionCore never saw the request */
        } else if (teeing) {
          out.push(h);
          tee = [h]; teeLen = h.length;
          mode = 'tee';
        } else {
          out.push(h);
          mode = complete ? 'start' : 'pass';
        }
      }
      if (out.length) toOut(out.length === 1 ? out[0] : Buffer.concat(out));
    });

    // ---- Unsend requests, from AionUi's settings store
    const seen = new Set();
    let seq = 0;
    if (opts.database && opts.convId) {
      timer = setInterval(() => {
        if (finished) return;
        let rows = [];
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(opts.database, { readOnly: true });
          try {
            rows = db.prepare("SELECT key, value FROM client_preferences WHERE key LIKE 'aiondx.unsend.req.%' " +
              'AND user_id = (SELECT user_id FROM conversations WHERE id = ?)').all(opts.convId);
          } finally { db.close(); }
        } catch { return; }
        for (const r of rows) {
          const uuid = String(r.key).slice(REQ.length);
          if (seen.has(uuid) || !/^[0-9A-Za-z-]{8,64}$/.test(uuid)) continue;
          let v;
          try { v = JSON.parse(r.value); } catch { continue; }
          if (!v || v.conv !== opts.convId) continue;
          seen.add(uuid);
          if (Date.now() - (Number(v.at) || 0) > MAX_REQ_AGE_MS) continue;
          const rid = 'aiondx-unsend-' + (++seq);
          pending.set(rid, { uuid: uuid, v: v });
          inject.push(JSON.stringify({ type: 'control_request', request_id: rid, request: { subtype: 'cancel_async_message', message_uuid: uuid } }));
          flushInject();
          log(`unsend ${uuid} sent to claude`);
        }
      }, opts.pollMs || 1000);
    }

    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      usage.stop();
      if (tap) tap.close();
      if (headLen) { toOut(Buffer.concat(head)); head = []; headLen = 0; }
      const done = () => resolve(code);
      // The cache record's last write goes out before the exit (bounded at 2 s by stop()).
      cache.stop().then(() => { if (output.writableLength) output.once('drain', done); else done(); }, done);
    };
    child.on('error', (e) => { log('claude failed to run: ' + e.message); finish(1); });
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    child.on('exit', (code) => setTimeout(() => finish(typeof code === 'number' ? code : 1), 2000));
    }
  });
}

/** True when this launch is AionCore's direct session: stream-json in and out. */
function isStreamSession(args) {
  const i = args.indexOf('--input-format');
  return i >= 0 && args[i + 1] === 'stream-json';
}

module.exports = { isSideCall, usageModel, startProxy, isStreamSession, startTap, readUsage, watchStart, startCache };
