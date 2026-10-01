#!/usr/bin/env node
/**
 * test-mcp-fixture.js - a stand-in MCP server for test-mcp-bridge.js, over each transport `aiondx mcp call` speaks.
 *
 *   node test-mcp-fixture.js stdio    JSON-RPC, one message per line on stdin and stdout, with a banner line that is
 *                                     not JSON on stdout and chatter on stderr, as real servers have
 *   node test-mcp-fixture.js http     prints "PORT <n>", then serves on 127.0.0.1:
 *                                       POST /mcp          streamable HTTP, answered as JSON
 *                                       POST /mcp?sse=1    the same, answered as an event stream
 *                                       GET /sse, POST /messages   the older SSE transport (2024-11-05)
 *                                       /old               POST refused with 405, GET is the older SSE transport
 *                                       GET /stats         what it saw (no sign-in needed)
 *                                     Every MCP route wants "Authorization: Bearer good-token".
 *
 * Tools: echo, add, args, tags, env, image, fail, roots (stdio: asks the client roots/list first), slow, crash, headers.
 * tools/list comes in two pages. A stdio server exits when stdin closes; the HTTP one after 120 s at most.
 * FIXTURE_PIDFILE, if set, gets this process's id.
 */
'use strict';

const http = require('http');
const fs = require('fs');

const MODE = process.argv[2] || 'stdio';
if (process.env.FIXTURE_PIDFILE) fs.writeFileSync(process.env.FIXTURE_PIDFILE, String(process.pid));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TOOLS = [
  { name: 'echo', description: 'Says the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to say' } }, required: ['text'] } },
  { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'args', description: 'Returns its arguments as JSON.', inputSchema: { type: 'object', properties: {
    n: { type: 'integer' }, s: { type: 'string' }, f: { type: 'boolean' }, o: { type: 'object' }, x: { type: ['string', 'null'] } } } },
  { name: 'tags', description: 'Returns its labels as JSON.', inputSchema: { type: 'object', properties: { labels: { type: 'array', items: { type: 'string' } } } } },
  { name: 'env', description: 'Reads an environment variable of the server process.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'image', description: 'Returns a one-pixel picture.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always reports an error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'roots', description: 'Asks the client for its roots first.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Answers after ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } } },
  { name: 'crash', description: 'Exits without answering.', inputSchema: { type: 'object', properties: {} } },
  { name: 'headers', description: 'Returns the HTTP headers of this request.', inputSchema: { type: 'object', properties: {} } },
];

function text(t, extra) { return Object.assign({ content: [{ type: 'text', text: t }] }, extra || {}); }

/** One request in, the result (or a promise of it). ask(method) sends the client a request and waits for its answer. */
function handle(msg, ask, reqHeaders) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' }, instructions: 'fixture instructions' };
    case 'ping': return {};
    case 'tools/list':
      return p.cursor === 'p2' ? { tools: TOOLS.slice(4) } : { tools: TOOLS.slice(0, 4), nextCursor: 'p2' };
    case 'tools/call': {
      const a = p.arguments || {};
      switch (p.name) {
        case 'echo': return text(String(a.text));
        case 'add': return text(String(Number(a.a) + Number(a.b)), { structuredContent: { sum: Number(a.a) + Number(a.b) } });
        case 'args': return text(JSON.stringify(a));
        case 'tags': return text(JSON.stringify(a.labels));
        case 'env': return text(process.env[a.name] === undefined ? '(unset)' : process.env[a.name]);
        case 'image': return { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'text', text: 'one pixel' }] };
        case 'fail': return text('it broke', { isError: true });
        case 'roots': return ask ? ask('roots/list', {}).then((r) => text('roots: ' + JSON.stringify(r.result && r.result.roots))) : text('roots: n/a');
        case 'slow': return new Promise((res) => setTimeout(() => res(text('done')), Number(a.ms) || 0));
        case 'crash': process.stderr.write('fixture: crashing now\n'); process.exit(3); break;
        case 'headers': return text(JSON.stringify(reqHeaders || {}));
        default: throw Object.assign(new Error('Unknown tool: ' + p.name), { code: -32602 });
      }
    }
    default: throw Object.assign(new Error('Method not found: ' + msg.method), { code: -32601 });
  }
}

function answer(msg, result) { return { jsonrpc: '2.0', id: msg.id, result }; }
function failure(msg, e) { return { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }; }
const logNote = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working on it' } };

if (MODE === 'stdio') {
  process.stdout.write('fixture MCP server running on stdio\n');   // not JSON: a client must skip it
  process.stderr.write('fixture: started\n');
  const pending = new Map();
  let seq = 0;
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const ask = (method, params) => new Promise((res) => { const id = 'srv-' + (++seq); pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (!msg.method) { const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); } continue; }
      if (msg.id === undefined) continue;   // a notification
      Promise.resolve().then(() => handle(msg, ask)).then((result) => {
        if (msg.method === 'tools/call') send(logNote);
        send(answer(msg, result));
      }, (e) => send(failure(msg, e)));
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  const stats = { posts: 0, deletes: 0, sessionErrors: 0, protocolHeaders: [] };
  const legacy = new Map();   // session id -> the open event stream
  const authed = (req, res) => {
    if (req.headers.authorization === 'Bearer good-token') return true;
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="fixture"' });
    res.end(JSON.stringify({ error: 'bad token' }));
    return false;
  };
  const openStream = (res, sid) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': hello\n\nevent: endpoint\ndata: /messages?sessionId=' + sid + '\n\n');
    legacy.set(sid, res);
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(stats)); }
      if (!authed(req, res)) return;
      if (url.pathname === '/mcp' && req.method === 'DELETE') { stats.deletes++; res.writeHead(200); return res.end(); }
      if (url.pathname === '/mcp' && req.method === 'POST') {
        stats.posts++;
        const msg = JSON.parse(raw);
        if (msg.method !== 'initialize') {
          if (req.headers['mcp-session-id'] !== 'sess-1') { stats.sessionErrors++; res.writeHead(400); return res.end('missing session'); }
          stats.protocolHeaders.push(req.headers['mcp-protocol-version'] || '');
        }
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        const head = msg.method === 'initialize' ? { 'Mcp-Session-Id': 'sess-1' } : {};
        return Promise.resolve().then(() => handle(msg, null, req.headers)).then((r) => answer(msg, r), (e) => failure(msg, e)).then((out) => {
          if (url.searchParams.get('sse') === '1') {
            res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream' }, head));
            if (msg.method === 'tools/call') res.write('event: message\ndata: ' + JSON.stringify(logNote) + '\n\n');
            res.write('id: 1\nevent: message\ndata: ' + JSON.stringify(out) + '\n\n');
            return res.end();
          }
          res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, head));
          res.end(JSON.stringify(out));
        });
      }
      if (url.pathname === '/old' && req.method === 'POST') { res.writeHead(405); return res.end(); }
      if ((url.pathname === '/sse' || url.pathname === '/old') && req.method === 'GET') return openStream(res, url.pathname === '/sse' ? 'L1' : 'L2');
      if (url.pathname === '/messages' && req.method === 'POST') {
        const stream = legacy.get(url.searchParams.get('sessionId'));
        if (!stream) { res.writeHead(404); return res.end('no session'); }
        res.writeHead(202); res.end('Accepted');
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return undefined;
        return Promise.resolve().then(() => handle(msg, null, req.headers)).then((r) => answer(msg, r), (e) => failure(msg, e))
          .then((out) => stream.write('event: message\ndata: ' + JSON.stringify(out) + '\n\n'));
      }
      res.writeHead(404); return res.end();
    });
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\n'));
  setTimeout(() => process.exit(0), 120000).unref();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
