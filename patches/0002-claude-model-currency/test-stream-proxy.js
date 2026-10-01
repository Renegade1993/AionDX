#!/usr/bin/env node
/**
 * test-stream-proxy.js - the router's pass-through (claude-stream-proxy.js) against a stand-in
 * Claude, a scratch database and a stub AionUi API. No real Claude, no real store.
 *
 *   node patches\0002-claude-model-currency\test-stream-proxy.js
 *
 * Checks: lines split across chunks arrive whole; a 6 MB line passes byte for byte; another
 * program's control_response passes; an unsend request in the store reaches Claude as
 * cancel_async_message, its answer is kept from AionCore and saved to the API; requests for another
 * chat or older than two minutes are ignored; an injected line never lands inside a half-written
 * one; Claude's exit code comes back; closing input closes Claude. 90 s deadline.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { startProxy } = require('./claude-stream-proxy.js');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 150000);
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'aiondx-proxy-test-'));
const FAKE = path.join(scratch, 'fake-claude.js');
fs.writeFileSync(FAKE, `
// Stand-in Claude: one JSON frame per line in, one per line out.
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let j;
    try { j = JSON.parse(line); } catch (e) { out({ type: 'bad_frame', sample: line.slice(0, 80) }); continue; }
    if (j.type === 'user') out({ type: 'echo', uuid: j.uuid, len: line.length });
    else if (j.type === 'control_request' && j.request && j.request.subtype === 'cancel_async_message') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { cancelled: !String(j.request.message_uuid).startsWith('gone') } } });
      out({ type: 'command_lifecycle', command_uuid: j.request.message_uuid, state: 'cancelled' });
    } else if (j.type === 'big') process.stdout.write(JSON.stringify({ type: 'big', data: 'x'.repeat(j.n) }) + '\\n');
    else if (j.type === 'foreign') out({ type: 'control_response', response: { subtype: 'success', request_id: 'abc-1', response: {} } });
    else if (j.type === 'exit') process.exit(j.code);
    else if (j.type === 'turn') out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done' });
    else if (j.type === 'api') {
      fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', { method: 'POST', headers: { authorization: 'Bearer client-token', 'content-type': 'application/json', 'x-test': j.mode || '' }, body: JSON.stringify({ hello: 'world' }) })
        .then(async (r) => { const t = await r.text(); out({ type: 'api_result', id: j.id, status: r.status, ctype: r.headers.get('content-type'), body: t }); })
        .catch((e) => out({ type: 'api_result', id: j.id, error: String(e.message) }));
    }
    else if (j.type === 'ask') out({ type: 'control_request', request_id: j.id, request: { subtype: 'can_use_tool', tool_name: j.tool, input: j.input, decision_reason: j.reason } });
    else if (j.type === 'env') out({ type: 'env', base: process.env.ANTHROPIC_BASE_URL || '' });
    else if (j.type === 'cancel') out({ type: 'control_cancel_request', request_id: j.id });
    else if (j.type === 'control_response' && j.response) out({ type: 'asked_answer', id: j.response.request_id, behavior: j.response.response && j.response.response.behavior, input: j.response.response && j.response.response.updatedInput });
    else if (j.type === 'control_request' && j.request && j.request.subtype === 'set_permission_mode') {
      out({ type: 'mode_set', mode: j.request.mode, id: j.request_id });
      out({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: {} } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);

// Scratch AionUi database: a chat and the settings table.
const { DatabaseSync } = require('node:sqlite');
const DB = path.join(scratch, 'aionui-backend.db');
{
  const db = new DatabaseSync(DB);
  db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT, extra TEXT); CREATE TABLE client_preferences (user_id TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY (user_id, key));");
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run('c1', 'u1', '{}');
  db.close();
}
const putPref = (key, value) => {
  const db = new DatabaseSync(DB);
  db.prepare('INSERT OR REPLACE INTO client_preferences VALUES (?, ?, ?, ?)').run('u1', key, JSON.stringify(value), Date.now());
  db.close();
};
// Stub API: records every PUT to /api/settings/client. /v1/messages stands in for Anthropic's Messages API and
// answers with the unified rate-limit headers.
const puts = [];
const anthropic = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.split('?')[0] === '/v1/messages') {
      anthropic.push({ auth: req.headers.authorization, body: body ? JSON.parse(body) : null, url: req.url, test: req.headers['x-test'] || '' });
      const tm = req.headers['x-test'] || '';
      const H = { 'anthropic-ratelimit-unified-5h-utilization': tm === 'high' ? '0.55' : '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1790453400', 'anthropic-ratelimit-unified-5h-status': tm === 'limit' ? 'rejected' : 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.3', 'anthropic-ratelimit-unified-7d-reset': '1790852400',
        'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-status': tm === 'limit' ? 'rejected' : 'allowed' };
      if (tm === 'stream') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream' }, H)); res.write('data: one\n\n'); setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 120); return; }
      if (tm === 'limit') { res.writeHead(429, Object.assign({ 'Content-Type': 'application/json' }, H)); res.end('{"type":"error"}'); return; }
      if (tm === 'high' || tm === 'plain') { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, H)); res.end('{"type":"message","content":[],"echo":' + JSON.stringify(body) + '}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1790453400', 'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.3', 'anthropic-ratelimit-unified-7d-reset': '1790852400',
        'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-status': 'allowed' });
      res.end('{"type":"message","content":[]}');
      return;
    }
    puts.push({ method: req.method, url: req.url, token: req.headers['x-aionui-runtime-token'], body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true}');
  });
});

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']'}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(extra) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = Buffer.alloc(0);
  output.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) { lines.push(buf.subarray(0, i)); buf = buf.subarray(i + 1); }
  });
  const logs = [];
  const done = startProxy(Object.assign({ exe: process.execPath, args: [FAKE], env: process.env, convId: 'c1', database: DB,
    apiBase: 'http://127.0.0.1:' + server.address().port, apiHeaders: { 'x-aionui-runtime-token': 'tok' },
    log: (m) => logs.push(m), pollMs: 200, input, output }, extra || {}));
  const json = () => lines.map((l) => { try { return JSON.parse(l.toString('utf8')); } catch { return { unparsable: true }; } });
  return { input, output, lines, json, logs, done };
}
const frame = (o) => JSON.stringify(o) + '\n';

server.listen(0, '127.0.0.1', async () => {
  try {
    const p = run();
    // Two frames written in awkward pieces: split mid-frame and mid-UTF-8 character.
    const f1 = Buffer.from(frame({ type: 'user', uuid: 'u-1', message: { content: 'héllo wörld' } }), 'utf8');
    const f2 = Buffer.from(frame({ type: 'user', uuid: 'u-2', message: { content: 'second' } }), 'utf8');
    const all = Buffer.concat([f1, f2]);
    for (const cut of [3, 17, 18, 40, all.length]) { /* fixed cut points */ }
    p.input.write(all.subarray(0, 17)); await sleep(30);
    p.input.write(all.subarray(17, 18)); await sleep(30);
    p.input.write(all.subarray(18, f1.length + 5)); await sleep(30);
    p.input.write(all.subarray(f1.length + 5)); await sleep(300);
    let j = p.json();
    check('frames split across chunks reach Claude whole', j.filter((x) => x.type === 'echo').length === 2 && !j.some((x) => x.type === 'bad_frame'), JSON.stringify(j));

    // A 6 MB line comes back byte for byte.
    p.input.write(frame({ type: 'big', n: 6 * 1024 * 1024 }));
    for (let i = 0; i < 50 && !p.lines.some((l) => l.length > 6e6); i++) await sleep(100);
    const big = p.lines.find((l) => l.length > 6e6);
    const want = Buffer.from(JSON.stringify({ type: 'big', data: 'x'.repeat(6 * 1024 * 1024) }), 'utf8');
    check('a 6 MB line passes byte for byte', !!big && big.equals(want), big ? big.length : 'none');

    // Another program's control_response passes through.
    p.input.write(frame({ type: 'foreign' })); await sleep(300);
    j = p.json();
    check("another program's control_response passes through", j.some((x) => x.type === 'control_response' && x.response && x.response.request_id === 'abc-1'));

    // Unsend: a request in the store, for this chat, reaches Claude; the answer is kept from AionCore and saved.
    putPref('aiondx.unsend.req.11111111-aaaa', { conv: 'c1', messageId: 'm-9', at: Date.now() });
    for (let i = 0; i < 30 && !puts.length; i++) await sleep(100);
    j = p.json();
    const ours = j.filter((x) => x.type === 'control_response' && x.response && /^aiondx-/.test(x.response.request_id || ''));
    check('an unsend request reaches Claude as cancel_async_message', j.some((x) => x.type === 'command_lifecycle' && x.command_uuid === '11111111-aaaa' && x.state === 'cancelled'), JSON.stringify(j.slice(-3)));
    check("Claude's answer to it is not passed to AionCore", ours.length === 0, JSON.stringify(ours));
    const put = puts[0];
    check('the result goes to the store: cancelled, with the message id, and the request removed', put && put.method === 'PUT' && put.url === '/api/settings/client' &&
      put.token === 'tok' && put.body['aiondx.unsend.result.11111111-aaaa'] && put.body['aiondx.unsend.result.11111111-aaaa'].cancelled === true &&
      put.body['aiondx.unsend.result.11111111-aaaa'].messageId === 'm-9' && put.body['aiondx.unsend.req.11111111-aaaa'] === null, JSON.stringify(put));
    await sleep(600);
    check('each request is sent once', puts.length === 1, puts.length);

    // Not this chat, or too old: ignored.
    putPref('aiondx.unsend.req.22222222-bbbb', { conv: 'other', messageId: 'm-1', at: Date.now() });
    putPref('aiondx.unsend.req.33333333-cccc', { conv: 'c1', messageId: 'm-2', at: Date.now() - 5 * 60000 });
    await sleep(700);
    j = p.json();
    check('a request for another chat, or older than two minutes, is ignored', !j.some((x) => x.type === 'command_lifecycle' && x.command_uuid !== '11111111-aaaa') && puts.length === 1, JSON.stringify(j.slice(-2)));

    // A message Claude had already taken: cancelled false.
    putPref('aiondx.unsend.req.gone-0000-1111', { conv: 'c1', messageId: 'm-3', at: Date.now() });
    for (let i = 0; i < 30 && puts.length < 2; i++) await sleep(100);
    check('a message already taken is reported as not cancelled', puts[1] && puts[1].body['aiondx.unsend.result.gone-0000-1111'] && puts[1].body['aiondx.unsend.result.gone-0000-1111'].cancelled === false, JSON.stringify(puts[1]));

    // An injected line never lands inside a half-written AionCore frame.
    const half = Buffer.from(frame({ type: 'user', uuid: 'u-3', message: { content: 'written in two halves' } }), 'utf8');
    p.input.write(half.subarray(0, 20));
    putPref('aiondx.unsend.req.44444444-dddd', { conv: 'c1', messageId: 'm-4', at: Date.now() });
    await sleep(700);
    p.input.write(half.subarray(20));
    await sleep(500);
    j = p.json();
    check('an injected request waits for the half-written frame, and both arrive whole', !j.some((x) => x.type === 'bad_frame') &&
      j.some((x) => x.type === 'echo' && x.uuid === 'u-3') && j.some((x) => x.type === 'command_lifecycle' && x.command_uuid === '44444444-dddd'), JSON.stringify(j.slice(-4)));

    // Claude's exit code comes back.
    p.input.write(frame({ type: 'exit', code: 7 }));
    const code = await Promise.race([p.done, sleep(5000).then(() => 'timeout')]);
    check("Claude's exit code comes back", code === 7, code);

    // Closing the input closes Claude.
    const q = run();
    q.input.end();
    const code2 = await Promise.race([q.done, sleep(5000).then(() => 'timeout')]);
    check('closing the input ends Claude, exit 0', code2 === 0, code2);

    // The usage meter: a turn's end reads the account's windows once, into the store, keyed by the token's hash.
    puts.length = 0;
    const u = run({ usage: { token: 'tok-usage-secret', key: 'abc123def456', label: 'Main' }, usageUrl: 'http://127.0.0.1:' + server.address().port + '/v1/messages' });
    u.input.write(frame({ type: 'turn' }));
    for (let i = 0; i < 50 && !puts.some((x) => x.body && x.body['aiondx.usage.acct.abc123def456']); i++) await sleep(100);
    const up = puts.find((x) => x.body && x.body['aiondx.usage.acct.abc123def456']);
    const acct = up && up.body['aiondx.usage.acct.abc123def456'];
    check("a turn's end reads the account's 5-hour and weekly windows into the store", acct && acct.five_hour.u === 0.42 && acct.seven_day.u === 0.3 &&
      acct.five_hour.reset === 1790453400 && acct.label === 'Main' && up.body['aiondx.usage.conv.c1'].acct === 'abc123def456', JSON.stringify(up));
    check('the probe is one token of Haiku with the chat\'s own token, which never reaches the store', anthropic.length === 1 &&
      anthropic[0].auth === 'Bearer tok-usage-secret' && anthropic[0].body.max_tokens === 1 && !JSON.stringify(puts).includes('tok-usage-secret'), JSON.stringify(anthropic));
    u.input.write(frame({ type: 'turn' }));
    await sleep(800);
    check('a second turn inside 90 s reads nothing new', anthropic.length === 1, anthropic.length);
    u.input.end();
    await Promise.race([u.done, sleep(5000)]);

    // Signed in with `claude /login`: the access token is read from .credentials.json at each probe; an expired
    // one is not used, and neither the token nor the refresh token reaches the store.
    const cred = path.join(scratch, 'cred-ok.json');
    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-file-secret', refreshToken: 'ref-file-secret',
      expiresAt: Date.now() + 3600000, subscriptionType: 'pro' } }));
    puts.length = 0;
    const f = run({ usage: { tokenFile: cred, key: 'fff000fff000', label: 'Pro' }, usageUrl: 'http://127.0.0.1:' + server.address().port + '/v1/messages' });
    f.input.write(frame({ type: 'turn' }));
    for (let i = 0; i < 50 && !puts.some((x) => x.body && x.body['aiondx.usage.acct.fff000fff000']); i++) await sleep(100);
    const fput = puts.find((x) => x.body && x.body['aiondx.usage.acct.fff000fff000']);
    const fcall = anthropic.filter((a) => a.auth === 'Bearer tok-file-secret');
    check("a /login account's access token is read from .credentials.json for the probe", fcall.length === 1 && fput &&
      fput.body['aiondx.usage.acct.fff000fff000'].label === 'Pro' && !/tok-file-secret|ref-file-secret/.test(JSON.stringify(puts)), JSON.stringify([fcall, fput]));
    f.input.end();
    await Promise.race([f.done, sleep(5000)]);
    const stale = path.join(scratch, 'cred-old.json');
    fs.writeFileSync(stale, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-expired-secret', expiresAt: Date.now() - 1000 } }));
    puts.length = 0;
    const g = run({ usage: { tokenFile: stale, key: 'eee000eee000', label: '' }, usageUrl: 'http://127.0.0.1:' + server.address().port + '/v1/messages' });
    g.input.write(frame({ type: 'turn' }));
    for (let i = 0; i < 30 && !puts.some((x) => x.body && x.body['aiondx.usage.conv.c1']); i++) await sleep(100);
    check('an expired access token is not used, and the probe says so', !anthropic.some((a) => a.auth === 'Bearer tok-expired-secret') &&
      !puts.some((x) => x.body && x.body['aiondx.usage.acct.eee000eee000']) && g.logs.some((m) => /probe skipped/.test(m)), JSON.stringify(g.logs));
    g.input.end();
    await Promise.race([g.done, sleep(5000)]);


    // ---- The usage tap (2026-10-01): Claude's own API traffic goes through untouched, and its usage headers reach the store.
    // The stub API never removes the unsend requests it answered; a new proxy would replay them (a production store does remove them).
    { const db = new DatabaseSync(DB); db.exec("DELETE FROM client_preferences WHERE key LIKE 'aiondx.unsend.req.%'"); db.close(); }
    puts.length = 0; anthropic.length = 0;
    const base = 'http://127.0.0.1:' + server.address().port;
    const waitFor = async (pred, n = 60) => { for (let i = 0; i < n && !pred(); i++) await sleep(100); };
    const T = run({ usage: { key: 'tapkey000001', label: 'Tap', probe: false }, env: Object.assign({}, process.env, { ANTHROPIC_BASE_URL: base }) });
    T.input.write(frame({ type: 'env' }));
    await waitFor(() => T.json().some((x) => x.type === 'env'));
    const tapBase = (T.json().find((x) => x.type === 'env') || {}).base || '';
    check('Claude is started with ANTHROPIC_BASE_URL on a loopback port of the proxy', /^http:\/\/127\.0\.0\.1:\d+$/.test(tapBase) && tapBase !== base, tapBase);
    T.input.write(frame({ type: 'api', id: 'a1', mode: 'plain' }));
    await waitFor(() => T.json().some((x) => x.type === 'api_result' && x.id === 'a1'));
    let ar = T.json().find((x) => x.type === 'api_result' && x.id === 'a1');
    check('a call Claude makes reaches the real API and the answer comes back untouched', ar && ar.status === 200 && /^application\/json/.test(ar.ctype) && JSON.parse(ar.body).echo === '{"hello":"world"}', JSON.stringify(ar));
    check('the request arrives as Claude sent it (path, query, authorization, body), and AionDX makes no call of its own', anthropic.length === 1 &&
      anthropic[0].url === '/v1/messages?beta=true' && anthropic[0].auth === 'Bearer client-token' && JSON.stringify(anthropic[0].body) === '{"hello":"world"}', JSON.stringify(anthropic));
    await waitFor(() => puts.some((x) => x.body && x.body['aiondx.usage.acct.tapkey000001']));
    const rec = puts.find((x) => x.body && x.body['aiondx.usage.acct.tapkey000001']);
    const a1 = rec && rec.body['aiondx.usage.acct.tapkey000001'];
    check("the answer's usage headers go to the store: both windows with resets and status, the label, and the chat's account", a1 && a1.five_hour.u === 0.42 &&
      a1.seven_day.u === 0.3 && a1.five_hour.reset === 1790453400 && a1.status === 'allowed' && a1.label === 'Tap' && a1.via === 'tap' && rec.body['aiondx.usage.conv.c1'].acct === 'tapkey000001', JSON.stringify(rec));
    const n0 = puts.length;
    T.input.write(frame({ type: 'api', id: 'a2', mode: 'plain' }));
    await sleep(600);
    check('the same reading again inside a minute writes nothing', puts.length === n0, puts.length - n0);
    T.input.write(frame({ type: 'api', id: 'a3', mode: 'high' }));
    await waitFor(() => puts.length > n0);
    check('a window that moved a whole percent is written at once', puts.length === n0 + 1 && puts[n0].body['aiondx.usage.acct.tapkey000001'].five_hour.u === 0.55, JSON.stringify(puts.slice(n0)));
    T.input.write(frame({ type: 'api', id: 'a4', mode: 'limit' }));
    await waitFor(() => puts.length > n0 + 1);
    const lim = puts.length > n0 + 1 ? puts[puts.length - 1].body['aiondx.usage.acct.tapkey000001'] : null;
    check('a refused call (429) is read too: rejected, with the window and its reset', lim && lim.http === 429 && lim.status === 'rejected' && lim.five_hour.status === 'rejected' && lim.five_hour.reset === 1790453400, JSON.stringify(lim));
    await waitFor(() => T.json().some((x) => x.type === 'api_result' && x.id === 'a4'));
    check('and Claude still gets the 429 as it was', (T.json().find((x) => x.type === 'api_result' && x.id === 'a4') || {}).status === 429);
    T.input.write(frame({ type: 'api', id: 'a5', mode: 'stream' }));
    await waitFor(() => T.json().some((x) => x.type === 'api_result' && x.id === 'a5'));
    ar = T.json().find((x) => x.type === 'api_result' && x.id === 'a5');
    check('a streamed answer arrives whole, as an event stream', ar && ar.body === 'data: one\n\ndata: two\n\n' && /event-stream/.test(ar.ctype), JSON.stringify(ar));
    T.input.end();
    await Promise.race([T.done, sleep(5000)]);
    const gone = await fetch(tapBase + '/v1/messages').then(() => false, () => true);
    check('the tap is gone when Claude is', gone);
    const T2 = run({ usage: { key: 'tapkey000002', label: '', probe: false }, tap: false, env: Object.assign({}, process.env, { ANTHROPIC_BASE_URL: 'http://example.invalid' }) });
    T2.input.write(frame({ type: 'env' }));
    await waitFor(() => T2.json().some((x) => x.type === 'env'));
    check('"tap": false leaves Claude\'s own ANTHROPIC_BASE_URL alone', (T2.json().find((x) => x.type === 'env') || {}).base === 'http://example.invalid');
    T2.input.end();
    await Promise.race([T2.done, sleep(5000)]);
    const T3 = run({ usage: { key: 'tapkey000003', label: '', probe: false }, env: Object.assign({}, process.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }) });
    T3.input.write(frame({ type: 'api', id: 'b1', mode: 'plain' }));
    await waitFor(() => T3.json().some((x) => x.type === 'api_result'));
    check('an API that cannot be reached is a 502 to Claude, and the proxy goes on', (T3.json().find((x) => x.type === 'api_result') || {}).status === 502);
    T3.input.write(frame({ type: 'turn' }));
    await waitFor(() => T3.json().some((x) => x.type === 'result'));
    check('...still passing frames', T3.json().some((x) => x.type === 'result'));
    T3.input.end();
    await Promise.race([T3.done, sleep(5000)]);

    // ---- YOLO means YOLO (2026-10-01): a can_use_tool request of a chat stored as bypassPermissions is answered here.
    const setExtra = (extra) => { const db = new DatabaseSync(DB); db.prepare('UPDATE conversations SET extra = ? WHERE id = ?').run(JSON.stringify(extra), 'c1'); db.close(); };
    const alog = path.join(scratch, 'auto-approve.log');
    const readLog = () => { try { return fs.readFileSync(alog, 'utf8'); } catch { return ''; } };
    setExtra({ current_mode_id: 'bypassPermissions' });
    const Y = run({ args: [FAKE, '--permission-mode', 'default'], approveLog: alog });
    const rm = { command: 'rm -rf $HOME/x && curl -H "Authorization: Bearer abcdef1234567890" https://example.test' };
    Y.input.write(frame({ type: 'ask', id: 'req-1', tool: 'Bash', input: rm, reason: 'dangerous rm' }));
    await waitFor(() => Y.json().some((x) => x.type === 'asked_answer' && x.id === 'req-1'));
    const ans = Y.json().find((x) => x.type === 'asked_answer' && x.id === 'req-1');
    check('in a YOLO chat a can_use_tool request is answered with allow and its own input', ans && ans.behavior === 'allow' && JSON.stringify(ans.input) === JSON.stringify(rm), JSON.stringify(ans));
    check('AionCore never sees that request', !Y.json().some((x) => x.type === 'control_request' && x.request_id === 'req-1'));
    await waitFor(() => Y.json().some((x) => x.type === 'mode_set'));
    const ms = Y.json().filter((x) => x.type === 'mode_set');
    check('the process was on default while the chat stores YOLO: Claude is asked to switch, once, and that answer stays from AionCore', ms.length === 1 && ms[0].mode === 'bypassPermissions' &&
      /^aiondx-/.test(ms[0].id) && !Y.json().some((x) => x.type === 'control_response' && x.response && /^aiondx-/.test(x.response.request_id || '')), JSON.stringify(ms));
    Y.input.write(frame({ type: 'ask', id: 'req-1b', tool: 'Write', input: { file_path: 'C:\\x\\y.txt', content: 'z' } }));
    await sleep(500);
    check('a second request does not ask for the switch again', Y.json().filter((x) => x.type === 'mode_set').length === 1 && Y.json().some((x) => x.type === 'asked_answer' && x.id === 'req-1b'));
    Y.input.write(frame({ type: 'ask', id: 'req-2', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } }));
    await sleep(500);
    check("a tool that needs the user's own answer (AskUserQuestion) goes on to AionCore and is not answered", Y.json().some((x) => x.type === 'control_request' && x.request_id === 'req-2') &&
      !Y.json().some((x) => x.type === 'asked_answer' && x.id === 'req-2'));
    Y.input.write(frame({ type: 'ask', id: 'req-2b', tool: 'ExitPlanMode', input: { plan: 'p' } }));
    await sleep(400);
    check('so is ExitPlanMode', Y.json().some((x) => x.type === 'control_request' && x.request_id === 'req-2b') && !Y.json().some((x) => x.type === 'asked_answer' && x.id === 'req-2b'));
    Y.input.write(frame({ type: 'cancel', id: 'req-1' }));
    Y.input.write(frame({ type: 'cancel', id: 'req-2' }));
    await sleep(500);
    check('the retraction of a request answered here is kept from AionCore; another retraction passes', !Y.json().some((x) => x.type === 'control_cancel_request' && x.request_id === 'req-1') &&
      Y.json().some((x) => x.type === 'control_cancel_request' && x.request_id === 'req-2'));
    const long = { command: 'echo ' + 'x'.repeat(6000) };
    Y.input.write(frame({ type: 'ask', id: 'req-3', tool: 'Bash', input: long }));
    await waitFor(() => Y.json().some((x) => x.type === 'asked_answer' && x.id === 'req-3'));
    const a3 = Y.json().find((x) => x.type === 'asked_answer' && x.id === 'req-3');
    check('a request longer than the line-head window is collected whole and answered with its full input', a3 && a3.input && a3.input.command === long.command);
    Y.input.write(frame({ type: 'user', uuid: 'u-after', message: { content: 'still fine' } }));
    await sleep(300);
    check('frames around the answered ones are untouched', Y.json().some((x) => x.type === 'echo' && x.uuid === 'u-after') && !Y.json().some((x) => x.type === 'bad_frame'));
    const lg = readLog();
    check('every answer is logged: the tool, what it was, why Claude asked, and the modes', /conv=c1 allow Bash: rm -rf \$HOME\/x/.test(lg) && /asked because: dangerous rm/.test(lg) &&
      /process mode default, stored bypassPermissions/.test(lg) && /allow Write: C:\\x\\y\.txt/.test(lg), lg.slice(0, 400));
    check('a credential in the command is masked in the log', /Bearer <hidden>/.test(lg) && !/abcdef1234567890/.test(lg), lg.slice(0, 300));
    Y.input.write(JSON.stringify({ type: 'control_request', request_id: 'm1', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }) + '\n');
    await sleep(400);
    check('a mode AionCore sets is logged, with what the chat stores', /mode bypassPermissions -> acceptEdits \(set by AionCore; the chat stores bypassPermissions\)/.test(readLog()), readLog().slice(-300));
    Y.input.end();
    await Promise.race([Y.done, sleep(5000)]);

    setExtra({ current_mode_id: 'default' });
    const D = run({ args: [FAKE, '--permission-mode', 'bypassPermissions'], approveLog: alog });
    D.input.write(frame({ type: 'ask', id: 'req-4', tool: 'Bash', input: { command: 'ls' } }));
    await sleep(600);
    check('a chat the user switched to default in the pill is left alone, whatever the process runs', D.json().some((x) => x.type === 'control_request' && x.request_id === 'req-4') &&
      !D.json().some((x) => x.type === 'asked_answer'));
    D.input.end();
    await Promise.race([D.done, sleep(5000)]);

    setExtra({});
    const N = run({ args: [FAKE, '--permission-mode', 'bypassPermissions'], approveLog: alog });
    N.input.write(frame({ type: 'ask', id: 'req-5', tool: 'Bash', input: { command: 'ls' } }));
    await waitFor(() => N.json().some((x) => x.type === 'asked_answer'));
    check("nothing stored: the process's own mode decides (bypassPermissions answers)", N.json().some((x) => x.type === 'asked_answer' && x.id === 'req-5') && !N.json().some((x) => x.type === 'mode_set'));
    N.input.end();
    await Promise.race([N.done, sleep(5000)]);
    const N2 = run({ args: [FAKE, '--permission-mode', 'default'], approveLog: alog });
    N2.input.write(frame({ type: 'ask', id: 'req-6', tool: 'Bash', input: { command: 'ls' } }));
    await sleep(600);
    check('nothing stored and the process on default: asked as before', N2.json().some((x) => x.type === 'control_request' && x.request_id === 'req-6') && !N2.json().some((x) => x.type === 'asked_answer'));
    N2.input.end();
    await Promise.race([N2.done, sleep(5000)]);

    setExtra({ session_mode: 'bypassPermissions' });
    const S = run({ args: [FAKE, '--permission-mode', 'default'], approveLog: alog });
    S.input.write(frame({ type: 'ask', id: 'req-7', tool: 'Bash', input: { command: 'ls' } }));
    await waitFor(() => S.json().some((x) => x.type === 'asked_answer'));
    check('the mode stored as session_mode counts too', S.json().some((x) => x.type === 'asked_answer' && x.id === 'req-7'));
    S.input.end();
    await Promise.race([S.done, sleep(5000)]);
    setExtra({ current_mode_id: 'bypassPermissions' });
    const O = run({ args: [FAKE, '--permission-mode', 'default'], approveLog: alog, approve: false });
    O.input.write(frame({ type: 'ask', id: 'req-8', tool: 'Bash', input: { command: 'ls' } }));
    await sleep(600);
    check('"autoApprove": false switches it off', O.json().some((x) => x.type === 'control_request' && x.request_id === 'req-8') && !O.json().some((x) => x.type === 'asked_answer'));
    O.input.end();
    await Promise.race([O.done, sleep(5000)]);
    setExtra({});

    // A program that will not start: exit 1, no hang.
    const r = run({ exe: path.join(scratch, 'no-such-claude.exe') });
    const code3 = await Promise.race([r.done, sleep(5000).then(() => 'timeout')]);
    check('a Claude that will not start ends with exit 1', code3 === 1, code3);
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    server.close();
    clearTimeout(deadline);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
});
