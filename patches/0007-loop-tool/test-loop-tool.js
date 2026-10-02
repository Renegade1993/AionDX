#!/usr/bin/env node
/**
 * test-loop-tool.js - patch 0007's MCP server, driven the way an agent drives it.
 *
 * Compiles aiondx-loop.cs, starts a stand-in for AionUi's API on 127.0.0.1 (the routes the tool
 * uses, with the response shapes of AionCore v0.2.2 checked live on 2026-09-24), and talks MCP to
 * the exe over its stdin and stdout, one JSON message per line.
 *
 *   node patches\0007-loop-tool\test-loop-tool.js     exit 0 only if every check passes
 *
 * Hard 90 s deadline; every child process is killed on every exit path.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DIR = __dirname;
const EXE = path.join(DIR, 'aiondx-loop.exe');   // the MCP server (winexe)
const CLI = path.join(DIR, 'aiondx.exe');         // the same code as a console program, for shells
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-loop-test-'));
const MCPFILE = path.join(LOGDIR, 'mcp', 'servers.json');   // never the real AionDX MCP file
const DEFAULT_MSG = 'CONTINUE WORKING. Re-check the project plan and queue files, take the next unfinished item, and keep going until the user interrupts.';

const children = [];
let server = null;
function finish(code, msg) {
  if (msg) console.log(msg);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { server && server.close(); } catch { /* closed */ }
  process.exit(code);
}
setTimeout(() => finish(2, 'DEADLINE: suite did not finish within 90 s'), 90000).unref();

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 400) });

// ---------------------------------------------------------------- the stand-in API

const kv = {};                 // /api/settings/client
const requests = [];
const TOKEN = 'tok-good';
const teams = [{
  id: 'team1', name: 'Team One', assistants: [
    { slot_id: 'slotL', name: 'Lead', role: 'lead', conversation_id: 'convL', backend: 'claude' },
    { slot_id: 'slotW', name: 'Worker', role: 'teammate', conversation_id: 'convW', backend: 'claude' },
    { slot_id: 'slotV', name: 'Viewer', role: 'teammate', conversation_id: 'convV', backend: 'devin' },
  ],
}];
const conversations = { convS: 'Solo chat', convL: 'Lead chat', convW: 'Worker chat', convV: 'Viewer chat', convG: 'Gemini chat', convN: 'No-compact chat' };
const slash = {
  convS: ['compact', 'clear', 'context'], convL: ['compact'], convW: ['compact'], convV: [],
  convG: ['compress', 'memory'], convN: ['init'],
};
let down = false;
const stub = { pause: 'ok', restart: 'ok' };   // what the pause and restart routes answer
// Each member's queue, as GET /api/teams/{id}/run-state reports it (aionui-api-types team.rs TeamSlotWorkPayload).
const work = { slotL: { state: 'running', fg: 0, bg: 0 }, slotW: { state: 'running', fg: 0, bg: 3 }, slotV: { state: 'idle', fg: 0, bg: 0 } };

// AionUi's MCP list as GET /api/mcp/servers returns it (aionui-api-types mcp.rs McpServerResponse). Create leaves a
// server switched off and toggle flips it, as AionCore 0.2.2 does (research 2026-09-26_mcp-configurable-and-transparent.md).
const mcp = [
  { id: 'mcp-1', name: 'aiondx-loop', enabled: true, builtin: false, transport: { type: 'stdio', command: 'C:\\bin\\aiondx-loop.exe', env: { SECRET_TOKEN: 'shh-value' } },
    last_test_status: 'connected', tools: [{ name: 'loop_status' }, { name: 'loop_set' }] },
  { id: 'mcp-2', name: 'image-gen', enabled: false, builtin: true, transport: { type: 'stdio', command: 'imagegen' }, last_test_status: 'disconnected' },
];
let mcpSeq = 3;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// A stand-in for GitHub's REST API (AIONDX_GITHUB_API points here), signed in as "tester" with GH_TOKEN. "flaky" is made
// public whatever was asked, as GitHub did on September 27th, 2026.
const GH_TOKEN = 'tok-gh-123';
const ghRepos = {
  alpha: { name: 'alpha', private: true, pushed_at: '2026-09-20T10:00:00Z' },
  beta: { name: 'beta', private: false, pushed_at: '2026-09-10T10:00:00Z' },
};
const ghRequests = [];
function gitHub(req, res, url, entry) {
  ghRequests.push(entry);
  if (req.headers.authorization !== 'Bearer ' + GH_TOKEN) return reply(res, 401, { message: 'Bad credentials' });
  const view = (r) => ({ ...r, html_url: 'https://github.com/tester/' + r.name, owner: { login: 'tester' } });
  let m;
  if (req.method === 'GET' && url.pathname === '/gh/user') return reply(res, 200, { login: 'tester' });
  if (req.method === 'GET' && url.pathname === '/gh/user/repos') return reply(res, 200, Object.values(ghRepos).map(view));
  if (req.method === 'POST' && url.pathname === '/gh/user/repos') {
    const b = entry.body || {};
    if (ghRepos[b.name]) return reply(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', message: 'name already exists on this account' }] });
    ghRepos[b.name] = { name: b.name, private: b.name === 'flaky' ? false : !!b.private, description: b.description, pushed_at: '2026-09-27T08:00:00Z' };
    return reply(res, 201, { ...view(ghRepos[b.name]), private: !!b.private });
  }
  if ((m = /^\/gh\/repos\/tester\/([^/]+)$/.exec(url.pathname)) && ghRepos[m[1]]) {
    if (req.method === 'PATCH') ghRepos[m[1]].private = !!(entry.body || {}).private;
    return reply(res, 200, view(ghRepos[m[1]]));
  }
  return reply(res, 404, { message: 'Not Found' });
}

server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(entry);
    if (url.pathname.startsWith('/gh/')) return gitHub(req, res, url, entry);
    if (req.headers['x-aionui-runtime-token'] !== TOKEN || req.headers['x-aionui-user-id'] !== 'u1' || !req.headers['x-aionui-conversation-id']) {
      return reply(res, 401, { success: false, message: 'Invalid runtime token' });
    }
    let m;
    if (req.method === 'GET' && url.pathname === '/api/teams') return reply(res, 200, { success: true, data: teams });
    if (req.method === 'GET' && url.pathname === '/api/teams/team1/run-state') {
      return reply(res, 200, { success: true, data: { session_generation: 'g1', active_run: null, slot_work: Object.entries(work).map(([slot, w]) => ({
        slot_id: slot, role: slot === 'slotL' ? 'lead' : 'teammate', state: w.state, queued_foreground_count: w.fg, queued_background_count: w.bg,
        active_turn_id: w.state === 'running' ? 't-' + slot : null, blocked_reason: null, team_run_id: w.state === 'running' ? 'run1' : null })) } });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/teams\/team1\/runs\/run1\/agents\/([^/]+)\/pause$/))) {
      if (stub.pause === 'refuse') return reply(res, 409, { success: false, message: 'slot is not pausable' });
      if (work[m[1]]) work[m[1]].state = 'paused';
      return reply(res, 200, { success: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/teams\/team1\/agents\/([^/]+)\/runtime\/restart$/))) {
      if (stub.restart === 'busy') return reply(res, 409, { success: false, message: 'Team member is busy' });
      return reply(res, 200, { success: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/teams\/team1\/agents\/([^/]+)\/messages$/))) {
      if (work[m[1]]) work[m[1]].fg++;
      return reply(res, 200, { success: true, data: { enqueue_status: 'queued', target: { slot_id: m[1] } } });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/conversations\/([^/]+)$/))) {
      // The solo chat was started with aiondx-loop, and (as AionDX's AionCore build keeps it) its agent reported it connected.
      const more = m[1] === 'convS' ? { extra: { mcp_server_ids: ['mcp-1'], mcp_servers: [{ id: 'mcp-1', name: 'aiondx-loop' }] },
        runtime: { mcp_servers: [{ name: 'aiondx-loop', status: 'connected' }] } } : {};
      return conversations[m[1]] ? reply(res, 200, { success: true, data: { id: m[1], name: conversations[m[1]], status: 'finished', ...more } })
                                 : reply(res, 404, { success: false, message: 'not found' });
    }
    if (url.pathname === '/api/mcp/servers' && req.method === 'GET') return reply(res, 200, { success: true, data: mcp });
    if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
      const b = entry.body || {};
      const s = { id: 'mcp-' + (mcpSeq++), name: b.name, description: b.description, enabled: false, builtin: false, transport: b.transport, last_test_status: 'disconnected' };
      mcp.push(s);
      return reply(res, 200, { success: true, data: s });
    }
    if ((m = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)(\/toggle)?$/))) {
      const s = mcp.find((x) => x.id === m[1]);
      if (!s) return reply(res, 404, { success: false, message: 'MCP server not found' });
      if (req.method === 'POST' && m[2]) { s.enabled = !s.enabled; return reply(res, 200, { success: true, data: s }); }
      if (req.method === 'PUT') { Object.assign(s, entry.body.transport ? { transport: entry.body.transport } : {}, 'description' in entry.body ? { description: entry.body.description } : {}); return reply(res, 200, { success: true, data: s }); }
      if (req.method === 'DELETE') { mcp.splice(mcp.indexOf(s), 1); return reply(res, 200, { success: true }); }
    }
    if (url.pathname === '/api/mcp/test-connection' && req.method === 'POST') {
      const t = (entry.body && entry.body.transport) || {};
      if (/broken/.test(t.command || '')) return reply(res, 200, { success: true, data: { success: false, error: 'spawn failed', code: 'COMMAND_NOT_FOUND' } });
      return reply(res, 200, { success: true, data: { success: true, tools: [{ name: 'a' }, { name: 'b' }] } });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/conversations\/([^/]+)\/slash-commands$/))) {
      return reply(res, 200, { success: true, data: (slash[m[1]] || []).map((c) => ({ command: c, description: c })) });
    }
    if (url.pathname === '/api/settings/client') {
      if (req.method === 'GET') {
        const keys = url.searchParams.get('keys');
        const out = {};
        for (const k of keys ? keys.split(',') : Object.keys(kv)) if (k in kv) out[k] = kv[k];
        return reply(res, 200, { success: true, data: out });
      }
      if (req.method === 'PUT') {
        for (const [k, v] of Object.entries(entry.body || {})) { if (v === null) delete kv[k]; else kv[k] = v; }
        return reply(res, 200, { success: true });
      }
    }
    return reply(res, 404, { success: false, message: 'no route' });
  });
});

// ---------------------------------------------------------------- an MCP client over stdio

function startTool(convId, extraEnv) {
  const env = {
    SYSTEMROOT: process.env.SYSTEMROOT, AIONDX_LOOP_LOG_DIR: LOGDIR, AIONDX_MCP_FILE: MCPFILE,
    AIONUI_BASE_URL: `http://127.0.0.1:${server.address().port}`, AIONUI_RUNTIME_TOKEN: TOKEN,
    AIONUI_USER_ID: 'u1', AIONUI_CONVERSATION_ID: convId, ...(extraEnv || {}),
  };
  const child = spawn(EXE, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  let buf = '';
  const waiting = new Map();
  const lines = [];
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let seq = 0;
  const rpc = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`no reply to ${method} in ${timeoutMs} ms`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const raw = (text) => child.stdin.write(text + '\n');
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} });
    const text = r.result && r.result.content && r.result.content[0] ? r.result.content[0].text : JSON.stringify(r);
    return { text, isError: !!(r.result && r.result.isError), raw: r };
  };
  return { child, rpc, notify, raw, call, lines };
}

const puts = () => requests.filter((r) => r.method === 'PUT' && r.path === '/api/settings/client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- build: one source, two programs ----
  for (const [target, out] of [['winexe', EXE], ['exe', CLI]]) {
    const b = spawnSync(CSC, ['/nologo', '/optimize+', `/target:${target}`, '/platform:x64', '/r:System.Web.Extensions.dll',
      `/out:${out}`, path.join(DIR, 'aiondx-loop.cs')], { encoding: 'utf8', windowsHide: true });
    const buildOut = (b.stdout || '') + (b.stderr || '');
    check(`compiles as ${target} with the in-box C# compiler, no warnings`, b.status === 0 && !/warning|error/i.test(buildOut), buildOut.trim());
    if (b.status !== 0) return finish(1, buildOut);
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ---- protocol ----
  const solo = startTool('convS');
  const init = await solo.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const ir = init.result || {};
  check('initialize answers in the client\'s protocol version', ir.protocolVersion === '2025-03-26', JSON.stringify(ir.protocolVersion));
  check('initialize names the server and offers tools', ir.serverInfo && ir.serverInfo.name === 'aiondx-loop' && ir.capabilities && ir.capabilities.tools, JSON.stringify(ir.serverInfo));
  check('initialize carries usage instructions', typeof ir.instructions === 'string' && /loop_set/.test(ir.instructions) && /switch your Loop off/i.test(ir.instructions), ir.instructions);
  solo.notify('notifications/initialized', {});
  const pong = await solo.rpc('ping', {});
  check('a notification gets no reply; ping does', pong.result && Object.keys(pong.result).length === 0 && solo.lines.length === 2, solo.lines.length);

  const tl = await solo.rpc('tools/list', {});
  const tools = (tl.result && tl.result.tools) || [];
  check('tools/list offers loop_status, loop_set, priority_send, agent_stop, mcp_status, mcp_set, mcp_tools, mcp_call, github_status, github_create_repo and usage_status', tools.map((t) => t.name).join(',') === 'loop_status,loop_set,priority_send,agent_stop,mcp_status,mcp_set,mcp_tools,mcp_call,github_status,github_create_repo,usage_status', tools.map((t) => t.name));
  const schemaText = JSON.stringify(tools.map((t) => t.inputSchema));
  check('schemas use only type, properties and description (every backend takes them)', !/additionalProperties|\$schema|"required"|"title"/.test(schemaText), schemaText);
  const set = tools.find((t) => t.name === 'loop_set') || { inputSchema: { properties: {} } };
  check('loop_set takes on, until_stopped, message, compact, hold, resume_at, resume_message, note, member', Object.keys(set.inputSchema.properties).join(',') === 'on,until_stopped,message,compact,hold,resume_at,resume_message,note,member', Object.keys(set.inputSchema.properties));
  check('the descriptions describe the cache window, not the old 30-minute backoff',
    /2, then 4 minutes/.test(JSON.stringify(tools)) && !/20, then 30 minutes/.test(JSON.stringify(tools)) && /never wakes an agent whose cache/.test(ir.instructions));
  check('descriptions contain no em or en dash', !/[\u2013\u2014]/.test(JSON.stringify(tools) + ir.instructions));

  const unknown = await solo.rpc('bogus/method', {});
  check('an unknown method is refused with -32601', unknown.error && unknown.error.code === -32601, JSON.stringify(unknown.error));
  const rl = await solo.rpc('resources/list', {});
  check('resources/list gets an empty list', rl.result && Array.isArray(rl.result.resources) && rl.result.resources.length === 0);
  solo.raw('{not json');
  await sleep(300);
  const parseErr = solo.lines.map((l) => JSON.parse(l)).find((m) => m.error && m.error.code === -32700);
  check('a line that is not JSON gets a parse error, and the server keeps going', !!parseErr && (await solo.rpc('ping', {})).result);

  // ---- solo chat ----
  let r = await solo.call('loop_status');
  check('status of a Loop never switched on', !r.isError && /^Loop for you \(chat "Solo chat"\): OFF \(never switched on\)/.test(r.text), r.text);
  check('status says when AionUi is not running the Loop', /has not reported in the last 5 minutes/.test(r.text) && /AionDX Apply Update/.test(r.text), r.text);
  check('it authenticates with the runtime token headers', requests.every((q) => q.headers['x-aionui-runtime-token'] === TOKEN && q.headers['x-aionui-conversation-id'] === 'convS'));

  r = await solo.call('loop_set', { on: true, note: 'long list ahead' });
  let rec = kv['aiondx.loop.conv.convS'];
  check('loop_set on: writes the shared record', !r.isError && rec && rec.on === true && rec.by === 'agent' && rec.who === 'Solo chat' && rec.rev === 1 && rec.note === 'long list ahead' && rec.msg === DEFAULT_MSG, JSON.stringify(rec));
  check('and says the user sees it, with the note', /^Saved\. The user sees this on the Loop button, marked with your name and note\./.test(r.text) && /: ON/.test(r.text), r.text);
  check('the record has a timestamp from now', rec && Math.abs(Date.now() - rec.at) < 5000, rec && rec.at);

  r = await solo.call('loop_set', { message: 'Keep going on the map.' });
  rec = kv['aiondx.loop.conv.convS'];
  check('a new message keeps it on and bumps the revision', rec.on === true && rec.msg === 'Keep going on the map.' && rec.rev === 2, JSON.stringify(rec));
  r = await solo.call('loop_set', { message: '   ' });
  check('an empty message restores the default', kv['aiondx.loop.conv.convS'].msg === DEFAULT_MSG);

  const before = puts().length;
  r = await solo.call('loop_set', {});
  check('nothing to change is an error, and nothing is written', r.isError && /Nothing to change/.test(r.text) && puts().length === before, r.text);
  r = await solo.call('loop_set', { message: 'x'.repeat(4001) });
  check('a message over 4000 characters is refused', r.isError && /4000/.test(r.text) && puts().length === before, r.text);

  r = await solo.call('loop_set', { compact: true });
  rec = kv['aiondx.loop.conv.convS'];
  check('compact: true records the request and keeps the Loop as it was', !r.isError && rec.compactAt > 0 && rec.on === true, JSON.stringify(rec));
  check('and says /compact goes out when the agent next stops', /AionUi sends \/compact when you next stop/.test(r.text), r.text);

  kv['aiondx.engine'] = { at: Date.now() - 30000, build: 'test-build' };
  kv['aiondx.loopstatus.conv.convS'] = { why: 'Not sending: it is working.', fires: 3, lastFired: Date.now() - 600000, compactSentAt: 0 };
  r = await solo.call('loop_status');
  check('status shows the engine running, with its build', /AionUi is running the Loop \(last seen 3\d s ago, build test-build\)/.test(r.text), r.text);
  check('status shows what the Loop last decided and its nudge count', /Now: Not sending: it is working\./.test(r.text) && /Nudges since it was last switched on: 3, the last at \d\d:\d\d/.test(r.text), r.text);
  check('status shows the pending compaction', /Compaction: requested at \d\d:\d\d, goes out when you stop/.test(r.text), r.text);
  check('status shows who changed it last', /Last change: by Solo chat at \d\d:\d\d/.test(r.text), r.text);
  kv['aiondx.loop.conv.convS'].by = 'user';
  r = await solo.call('loop_status');
  check('a change the user made reads as the user\'s', /Last change: by the user at/.test(r.text), r.text);

  r = await solo.call('loop_set', { on: false, member: 'Lead' });
  check('member on a solo chat is refused', r.isError && /not on a team/.test(r.text), r.text);
  r = await solo.call('loop_nope', {});
  check('an unknown tool is an error result', r.isError && /Unknown tool/.test(r.text), r.text);

  // ---- resume at a set time (1.4.0; a team lead's 12:10) ----
  const pad = (n) => ('0' + n).slice(-2);
  const clock = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  r = await solo.call('loop_set', { resume_at: '+30', resume_message: 'Back to the map.' });
  rec = kv['aiondx.loop.conv.convS'];
  check('resume_at "+30": 30 min out, with its message, set by this agent for itself', !r.isError && rec.on === true &&
    Math.abs(rec.wakeAt - (Date.now() + 30 * 60000)) < 10000 && rec.wakeMsg === 'Back to the map.' && rec.wakeBy === 'Solo chat' && rec.wakeSelf === true, JSON.stringify(rec));
  check('the reply says when it resumes and that the cache is kept warm', /Resumes at \d\d:\d\d \(in (29|30) min\), set by you: one nudge saying the time has come, with "Back to the map\."/.test(r.text) &&
    /the cache is kept warm, past the hold if need be/.test(r.text), r.text);
  r = await solo.call('loop_set', { hold: 90 });
  rec = kv['aiondx.loop.conv.convS'];
  check('another change keeps the resume time', rec.wakeAt > Date.now() && rec.wakeMsg === 'Back to the map.' && rec.holdMin === 90, JSON.stringify(rec));
  r = await solo.call('loop_set', { resume_at: '+120' });
  check('two hours off: the cache is left to run out', !r.isError && /the cache is left to run out/.test(r.text) && kv['aiondx.loop.conv.convS'].wakeMsg === '', r.text);
  const soon = new Date(Date.now() + 3 * 60000);
  r = await solo.call('loop_set', { resume_at: clock(soon) });
  check('a clock time a few minutes ahead is today', !r.isError && kv['aiondx.loop.conv.convS'].wakeAt === new Date(soon).setSeconds(0, 0), JSON.stringify([kv['aiondx.loop.conv.convS'].wakeAt, clock(soon)]));
  const past = new Date(Date.now() - 5 * 60000);
  r = await solo.call('loop_set', { resume_at: clock(past) });
  const tomorrow = new Date(past); tomorrow.setSeconds(0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
  check('a clock time already past is tomorrow', !r.isError && kv['aiondx.loop.conv.convS'].wakeAt === tomorrow.getTime(), JSON.stringify([kv['aiondx.loop.conv.convS'].wakeAt, tomorrow.getTime()]));
  r = await solo.call('loop_set', { resume_at: '3:30 pm' });
  const d330 = new Date(); d330.setHours(15, 30, 0, 0); if (d330.getTime() <= Date.now() + 30000) d330.setDate(d330.getDate() + 1);
  check('"3:30 pm" reads as 15:30', !r.isError && kv['aiondx.loop.conv.convS'].wakeAt === d330.getTime(), r.text);
  const beforeR = puts().length;
  r = await solo.call('loop_set', { resume_at: 'soonish' });
  check('a time it cannot read is refused, and nothing is written', r.isError && /resume_at takes a clock time/.test(r.text) && puts().length === beforeR, r.text);
  r = await solo.call('loop_set', { resume_message: 'no time given' });
  check('resume_message without resume_at is refused', r.isError && /resume_message goes with resume_at/.test(r.text), r.text);
  r = await solo.call('loop_set', { resume_at: '+10', on: false });
  check('a resume time with on: false is refused', r.isError && /needs the Loop on/.test(r.text), r.text);
  r = await solo.call('loop_set', { resume_at: 'off' });
  check('"off" clears it and leaves the Loop on', !r.isError && kv['aiondx.loop.conv.convS'].wakeAt === 0 && kv['aiondx.loop.conv.convS'].on === true, JSON.stringify(kv['aiondx.loop.conv.convS']));
  r = await solo.call('loop_set', { resume_at: '+10' });
  r = await solo.call('loop_set', { on: false });
  check('switching the Loop off clears the resume time', kv['aiondx.loop.conv.convS'].wakeAt === 0 && kv['aiondx.loop.conv.convS'].on === false, JSON.stringify(kv['aiondx.loop.conv.convS']));
  kv['aiondx.engine'] = { at: Date.now() - 30000, build: '2026-09-26.1' };
  r = await solo.call('loop_set', { resume_at: '+10' });
  check('an engine build from before resume times is named, with what to do meanwhile', !r.isError && /Loop engine \(build 2026-09-26\.1\) predates resume times/.test(r.text) &&
    /check the time yourself/.test(r.text), r.text);
  kv['aiondx.engine'] = { at: Date.now() - 30000, build: '2026-09-26.10' };
  r = await solo.call('loop_set', { resume_at: '+10' });
  check('a newer engine gets no such note (builds compared by number)', !r.isError && !/predates resume times/.test(r.text), r.text);
  kv['aiondx.engine'] = { at: Date.now() - 30000, build: 'test-build' };
  kv['aiondx.loop.conv.convS'].on = true;
  kv['aiondx.loopstatus.conv.convS'].wokeAt = Date.now() - 60000;
  r = await solo.call('loop_status');
  check('status says when the Loop last resumed it', /Resumed you at \d\d:\d\d, the resume time set\./.test(r.text), r.text);

  // ---- MCP (1.5.0): see and change AionUi's MCP list the way Settings > Tools does ----
  r = await solo.call('mcp_status');
  check("mcp_status names this chat's servers and how its agent reported them", !r.isError && /This chat's MCP servers, set when it was created: aiondx-loop\./.test(r.text) &&
    /As this chat's agent reported them: aiondx-loop connected\./.test(r.text), r.text);
  check('and the whole list: on or off, how each runs, the last check; env names but never their values',
    /aiondx-loop: ON, stdio C:\\bin\\aiondx-loop\.exe \(env: SECRET_TOKEN\); last check: connected, 2 tools/.test(r.text) && /image-gen: OFF \(built in\)/.test(r.text) &&
    !/shh-value/.test(r.text), r.text);
  const toggles = () => requests.filter((q) => /\/toggle$/.test(q.path)).length;
  let t0 = toggles();
  r = await solo.call('mcp_set', { action: 'add', name: 'github', where: 'aionui', on: true, transport: { type: 'stdio', command: 'npx', args: ['-y', '@x/github'], env: { GITHUB_TOKEN: 'ghp_secret' } }, note: 'for the PR work' });
  let gh = mcp.find((s) => s.name === 'github');
  const mlog = (kv['aiondx.mcp.log'] || []).slice(-1)[0] || {};
  check('add with where aionui and on: creates the server, switches it on (create leaves it off) and checks it', !r.isError && gh && gh.enabled === true && toggles() === t0 + 1 &&
    /^Added github to AionUi's MCP list and switched it on: new chats get it\. The check connected and found 2 tools: a, b\./.test(r.text), r.text);
  check('the change is logged with the agent and its note, for the user\'s notice, and no secret is echoed', mlog.who === 'Solo chat' && mlog.action === 'add' &&
    mlog.name === 'github' && mlog.note === 'for the PR work' && !/ghp_secret/.test(r.text) && !/ghp_secret/.test(JSON.stringify(kv['aiondx.mcp.log'])), JSON.stringify(mlog));
  r = await solo.call('mcp_set', { action: 'add', name: 'GitHub', where: 'aionui', transport: { type: 'http', url: 'https://x' } });
  check('adding a name already in the list is refused (AionUi would take over that row and switch it off)', r.isError && /already in the list; use update/.test(r.text), r.text);
  t0 = toggles();
  r = await solo.call('mcp_set', { action: 'enable', name: 'github' });
  check('enable on a server already on sends nothing (toggle flips, so it is only sent when needed)', !r.isError && toggles() === t0 && /github is ON/.test(r.text), r.text);
  r = await solo.call('mcp_set', { action: 'disable', name: 'github', note: 'not needed now' });
  check('disable switches it off', !r.isError && mcp.find((s) => s.name === 'github').enabled === false && toggles() === t0 + 1, r.text);
  r = await solo.call('mcp_set', { action: 'update', name: 'image-gen', transport: { type: 'stdio', command: 'x' } });
  check('a server built into AionUi is left alone', r.isError && /built into AionUi/.test(r.text), r.text);
  r = await solo.call('mcp_set', { action: 'update', name: 'github', transport: { type: 'stdio', command: 'broken-cmd' } });
  check('update changes the transport and reports a failed check with its code', !r.isError && mcp.find((s) => s.name === 'github').transport.command === 'broken-cmd' &&
    /The check failed \(COMMAND_NOT_FOUND\): spawn failed/.test(r.text), r.text);
  r = await solo.call('mcp_set', { action: 'remove', name: 'github', note: 'done with it' });
  check('remove takes it out of the list', !r.isError && !mcp.find((s) => s.name === 'github') && /Removed github/.test(r.text), r.text);
  r = await solo.call('mcp_set', { action: 'frob', name: 'x' });
  check('an unknown action is refused', r.isError && /action is one of add, update, remove, test, enable, disable/.test(r.text), r.text);
  t0 = toggles();
  r = await solo.call('mcp_set', { action: 'add', name: 'quiet', where: 'aionui', transport: { type: 'stdio', command: 'q' }, test: false });
  check("add to AionUi's list without on leaves it OFF, since every new chat gets the ON ones", !r.isError && mcp.find((s) => s.name === 'quiet').enabled === false &&
    toggles() === t0 && /switched OFF: no chat gets it/.test(r.text), r.text);
  r = await solo.call('mcp_set', { action: 'remove', name: 'quiet' });
  r = await solo.call('mcp_set', { action: 'add', name: 'filed', transport: { type: 'http', url: 'https://filed.example/mcp', headers: { Authorization: 'Bearer f' } }, test: false });
  const filed = fs.existsSync(MCPFILE) ? JSON.parse(fs.readFileSync(MCPFILE, 'utf8')).mcpServers.filed : null;
  check("add with no where goes to the AionDX MCP file, not AionUi's list", !r.isError && filed && filed.url === 'https://filed.example/mcp' &&
    !mcp.find((s) => s.name === 'filed') && /Added filed to the AionDX MCP file/.test(r.text), r.text);

  // ---- compaction commands per backend ----
  const gem = startTool('convG');
  await gem.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await gem.call('loop_set', { compact: true });
  check('an agent that offers /compress gets /compress', !r.isError && /AionUi sends \/compress/.test(r.text), r.text);
  const none = startTool('convN');
  await none.rpc('initialize', { protocolVersion: '2025-06-18' });
  const beforeNone = puts().length;
  r = await none.call('loop_set', { compact: true, on: true });
  check('an agent with no compact command is refused, and nothing is written', r.isError && /offers no compact command/.test(r.text) && puts().length === beforeNone && !kv['aiondx.loop.conv.convN'], r.text);

  // ---- a team ----
  const worker = startTool('convW');
  await worker.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await worker.call('loop_status');
  check('a teammate sees its own Loop, named, on its team', /^Loop for you \(Worker, teammate on team "Team One"\): OFF/.test(r.text), r.text);
  r = await worker.call('loop_set', { on: true });
  check('a teammate\'s own Loop is keyed by team and slot', kv['aiondx.loop.team.team1.slotW'] && kv['aiondx.loop.team.team1.slotW'].on === true && kv['aiondx.loop.team.team1.slotW'].who === 'Worker', JSON.stringify(kv['aiondx.loop.team.team1.slotW']));
  r = await worker.call('loop_status', { member: 'lead' });
  check('a teammate can read the lead\'s Loop', !r.isError && /^Loop for Lead \(lead on team "Team One"\): OFF/.test(r.text), r.text);
  const beforeW = puts().length;
  r = await worker.call('loop_set', { on: false, member: 'Lead' });
  check('a teammate cannot change the lead\'s Loop', r.isError && /Only the team lead can change a teammate's Loop/.test(r.text) && puts().length === beforeW, r.text);
  r = await worker.call('loop_set', { on: false, member: 'Worker', note: 'done for now' });
  check('naming itself as member is allowed', !r.isError && kv['aiondx.loop.team.team1.slotW'].on === false, r.text);

  const lead = startTool('convL');
  await lead.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await lead.call('loop_set', { member: 'worker', on: true, note: 'tournament is done, carry on' });
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('the lead switches a teammate on by name, case-insensitive', !r.isError && rec.on === true && rec.who === 'Lead' && rec.for === 'Worker' && rec.note === 'tournament is done, carry on', JSON.stringify(rec));
  check('and the revision keeps counting from the teammate\'s own changes', rec.rev === 3, rec.rev);
  r = await lead.call('loop_set', { member: 'Worker', resume_at: '+15', note: 'hold for the new usage window' });
  rec = kv['aiondx.loop.team.team1.slotW'];
  check("the lead sets a teammate's resume time, marked as the lead's", !r.isError && rec.wakeAt > Date.now() + 14 * 60000 && rec.wakeBy === 'Lead' &&
    rec.wakeSelf === false && /Resumes at \d\d:\d\d \(in 1[45] min\), set by Lead/.test(r.text), JSON.stringify(rec) + ' ' + r.text);
  r = await lead.call('loop_set', { member: 'slotV', on: true });
  check('the lead can name a teammate by slot id', !r.isError && kv['aiondx.loop.team.team1.slotV'] && kv['aiondx.loop.team.team1.slotV'].on === true, r.text);
  r = await lead.call('loop_set', { member: 'Viewer', compact: true });
  check('compact on a teammate with no compact command is refused', r.isError && /Viewer offers no compact command/.test(r.text), r.text);
  r = await lead.call('loop_set', { member: 'nobody', on: true });
  check('an unknown member is an error that lists the team', r.isError && /No teammate matches "nobody"\. The team: Lead \(lead\), Worker \(teammate\), Viewer \(teammate\)\./.test(r.text), r.text);
  r = await lead.call('loop_set', { member: 'e', on: true });
  check('an ambiguous member is an error that names the matches', r.isError && /matches more than one teammate/.test(r.text), r.text);
  r = await lead.call('loop_set', { member: 'all', on: false, note: 'stand down' });
  const allOff = ['slotL', 'slotW', 'slotV'].every((s) => kv[`aiondx.loop.team.team1.${s}`] && kv[`aiondx.loop.team.team1.${s}`].on === false);
  check('member "all" switches the whole team in one write', !r.isError && allOff && puts()[puts().length - 1].body && Object.keys(puts()[puts().length - 1].body).length === 3, r.text);
  r = await lead.call('loop_status', { member: 'all' });
  check('status for "all" lists every member', (r.text.match(/^Loop for /gm) || []).length === 3, r.text);

  // ---- until the user stops it (1.8.0; a request) ----
  r = await lead.call('loop_set', { member: 'Worker', until_stopped: true, note: 'a request: run until I stop it' });
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('until_stopped: true switches it on until the user stops it', !r.isError && rec.on === true && rec.forever === true && rec.foreverAt > 0 &&
    /: ON until the user stops it/.test(r.text) && /Runs until the user stops it \(since \d\d:\d\d\): no hold and no rest/.test(r.text) &&
    !/Keeps the cache warm through/.test(r.text), r.text);
  const fAt = rec.foreverAt;
  r = await lead.call('loop_set', { member: 'Worker', message: 'Next: the siege AI.' });
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('another change keeps the mode and when it began', !r.isError && rec.forever === true && rec.foreverAt === fAt && rec.msg === 'Next: the siege AI.', JSON.stringify(rec));
  const beforeF = puts().length;
  r = await lead.call('loop_set', { member: 'Worker', on: false, note: 'work is done' });
  check('no agent can switch it off on its own, and nothing is written', r.isError && /^Worker's Loop runs until the user stops it/.test(r.text) &&
    /Nothing was changed/.test(r.text) && puts().length === beforeF && kv['aiondx.loop.team.team1.slotW'].on === true, r.text);
  r = await lead.call('loop_set', { member: 'Worker', until_stopped: false });
  check('nor end the mode', r.isError && puts().length === beforeF && kv['aiondx.loop.team.team1.slotW'].forever === true, r.text);
  r = await lead.call('loop_set', { member: 'all', on: false });
  check('"all" is refused whole while one of them runs until stopped', r.isError && puts().length === beforeF, r.text);
  r = await lead.call('loop_set', { member: 'Worker', until_stopped: true, on: false });
  check('until_stopped with on: false is refused', r.isError && /keeps the Loop on/.test(r.text), r.text);
  kv['aiondx.loopask.team.team1.slotW'] = { v: 1, at: Date.now(), text: 'turn off your loop' };
  kv['aiondx.loopask.team.team1.slotL'] = { v: 1, at: fAt - 1000, text: 'turn off the loops' };
  r = await lead.call('loop_set', { member: 'Worker', on: false });
  check("a request from before the mode was set, or typed in another member's chat, does not count", r.isError && puts().length === beforeF, r.text);
  kv['aiondx.loop.team.team1.slotW'].foreverAt = Date.now() - 3600000;
  kv['aiondx.loopask.team.team1.slotL'] = { v: 1, at: Date.now() - 31 * 60000, text: "turn off Worker's loop" };
  r = await lead.call('loop_set', { member: 'Worker', on: false });
  check('a request more than 30 minutes old does not count', r.isError && puts().length === beforeF, r.text);
  kv['aiondx.loopask.team.team1.slotL'] = { v: 1, at: Date.now() - 60000, text: "turn off Worker's loop" };
  r = await lead.call('loop_set', { member: 'Worker', on: false });
  rec = kv['aiondx.loop.team.team1.slotW'];
  check("once the user asks in the lead's own chat, the lead can, and the record carries the request", !r.isError && rec.on === false && rec.forever === false &&
    rec.foreverAt === 0 && rec.askedAt === kv['aiondx.loopask.team.team1.slotL'].at && rec.note === 'the user asked: "turn off Worker\'s loop"', JSON.stringify(rec));
  kv['aiondx.engine'] = { at: Date.now() - 30000, build: '2026-09-26.5' };
  r = await lead.call('loop_set', { member: 'Worker', until_stopped: true });
  check('an engine from before the mode is named', !r.isError && /predates "until the user stops it"/.test(r.text), r.text);
  kv['aiondx.engine'] = { at: Date.now() - 30000, build: 'test-build' };
  kv['aiondx.loop.team.team1.slotW'].forever = false;
  delete kv['aiondx.loopask.team.team1.slotW'];
  delete kv['aiondx.loopask.team.team1.slotL'];

  // ---- no identity, a refused token, AionUi gone ----
  // The parent walk is switched off here: run inside an AionUi chat, it would reach that chat's real
  // agent and the real API (it did, read-only, the first time this suite ran).
  const orphan = startTool('convS', { AIONUI_CONVERSATION_ID: '', AIONUI_RUNTIME_TOKEN: '', AIONDX_LOOP_NO_ANCESTORS: '1' });
  await orphan.rpc('initialize', { protocolVersion: '2025-06-18' });
  const tlOrphan = await orphan.rpc('tools/list', {});
  check('without an identity it still starts and lists its tools', tlOrphan.result && tlOrphan.result.tools.length === 11, tlOrphan.result && tlOrphan.result.tools.length);
  r = await orphan.call('loop_status');
  check('with no identity the tool says so, and does not crash', r.isError && /cannot tell which AionUi chat/.test(r.text), r.text);

  // An agent that passes its MCP servers no environment: the tool finds its chat in the parent.
  // The stand-in parent carries the identity; the tool itself gets none.
  const fakeId = { AIONUI_BASE_URL: `http://127.0.0.1:${server.address().port}`, AIONUI_RUNTIME_TOKEN: TOKEN, AIONUI_USER_ID: 'u1', AIONUI_CONVERSATION_ID: 'convW' };
  const viaParent = spawnSync(process.execPath, ['-e', `
    const r = require('child_process').spawnSync(${JSON.stringify(EXE)}, ['--identity'],
      { env: { SYSTEMROOT: process.env.SYSTEMROOT }, encoding: 'utf8', windowsHide: true });
    process.stdout.write(r.stdout || '');`], { env: { ...process.env, ...fakeId }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  let vp = {};
  try { vp = JSON.parse(viaParent.stdout); } catch { /* reported below */ }
  check('with no environment of its own it finds the chat in its parent process', vp.conversation_id === 'convW' && /^process node\.exe \d+$/.test(vp.source || '') && vp.has_token, viaParent.stdout);

  const badTok = startTool('convS', { AIONUI_RUNTIME_TOKEN: 'tok-stale' });
  await badTok.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await badTok.call('loop_status');
  check('a refused token is reported plainly', r.isError && /AionUi's API answered 401 to GET \/api\/teams: Invalid runtime token/.test(r.text), r.text);

  // ---- priority messages (1.3.0, a team lead's request of September 26th) ----
  const leadTool = startTool('convL');
  await leadTool.rpc('initialize', { protocolVersion: '2025-06-18' });
  requests.length = 0;
  r = await leadTool.call('priority_send', { member: 'Worker', message: 'Stop the spread; the map seed is wrong.' });
  const sent = requests.filter((q) => q.method === 'POST' && q.path === '/api/teams/team1/agents/slotW/messages');
  check('priority_send from the lead goes through the user\'s route to the member, marked as the lead\'s', !r.isError && sent.length === 1 &&
    sent[0].body.content === '[Priority message from Lead, the team lead, sent with AionDX ahead of your queued work] Stop the spread; the map seed is wrong.', JSON.stringify([r.text, sent.map((q) => q.body)]));
  check('it says the message goes first without stopping the turn, and how long the queue is', /^Sent to Worker as a priority message\. It goes ahead of everything queued for it/.test(r.text) &&
    /to stop that turn now, use team_interrupt_agent/.test(r.text) && /Queue: Worker has 4 messages waiting: 1 from the user and priority messages, 3 from agents and team notices\./.test(r.text), r.text);
  check('nothing interrupts or cancels a turn', !requests.some((q) => /interrupt|cancel/.test(q.path)), requests.map((q) => q.path).join(' '));
  work.slotW.bg = 25;
  r = await leadTool.call('priority_send', { member: 'slotW', message: 'Also: skip the tournament.' });
  check('a queue of 20 or more is called out', !r.isError && /That is a long queue/.test(r.text), r.text);
  r = await leadTool.call('priority_send', { member: 'all', message: 'x' });
  check('"all" is refused: one teammate at a time', r.isError && /one teammate at a time/.test(r.text), r.text);
  r = await leadTool.call('priority_send', { member: 'Lead', message: 'x' });
  check('the lead cannot send one to itself', r.isError && /That is you/.test(r.text), r.text);
  r = await leadTool.call('priority_send', { member: 'Worker', message: '   ' });
  check('an empty message is refused', r.isError && /message is required/.test(r.text), r.text);
  r = await leadTool.call('priority_send', { member: 'Nobody', message: 'x' });
  check('an unknown teammate is named in the refusal, with the team', r.isError && /No teammate matches "Nobody"/.test(r.text), r.text);
  const workerTool = startTool('convW');
  await workerTool.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await workerTool.call('priority_send', { member: 'Viewer', message: 'x' });
  check('a teammate cannot send priority messages', r.isError && /Only the team lead can send a priority message/.test(r.text), r.text);
  // ---- a real stop (1.11.0, the owner's "lost control" of October 1st) ----
  work.slotW.state = 'running'; work.slotW.bg = 3;
  kv['aiondx.loop.team.team1.slotW'] = { v: 1, on: true, msg: 'x', rev: 1, by: 'user', at: Date.now() - 1000 };
  requests.length = 0;
  r = await leadTool.call('agent_stop', { member: 'Worker', reason: 'it is looping on a closed task' });
  const stopCalls = requests.filter((q) => q.method !== 'GET').map((q) => q.method + ' ' + q.path);
  check('agent_stop switches the Loop off, pauses the member through its run, then restarts its process, in that order',
    !r.isError && stopCalls.join(' | ') === 'PUT /api/settings/client | POST /api/teams/team1/runs/run1/agents/slotW/pause | POST /api/teams/team1/agents/slotW/runtime/restart', stopCalls.join(' | ') + ' :: ' + r.text);
  check('the Loop record says who stopped it and why', kv['aiondx.loop.team.team1.slotW'].on === false && /stopped by Lead: it is looping on a closed task/.test(kv['aiondx.loop.team.team1.slotW'].note), JSON.stringify(kv['aiondx.loop.team.team1.slotW']));
  check('the pause carries the reason', requests.some((q) => /\/pause$/.test(q.path) && q.body && q.body.reason === 'it is looping on a closed task'));
  check('nothing is interrupted, cancelled or messaged', !requests.some((q) => /interrupt|cancel|\/messages$/.test(q.path)), requests.map((q) => q.path).join(' '));
  check('it says what was done, step by step, and what the member is now', /^Stopping Worker: done\./.test(r.text) && /Paused: its turn was cancelled/.test(r.text) && /Its Loop is off\./.test(r.text) &&
    /agent process was restarted/.test(r.text) && /Now: paused/.test(r.text), r.text);
  work.slotW.state = 'running';
  requests.length = 0;
  r = await leadTool.call('agent_stop', { member: 'Worker', keep_process: true });
  check('keep_process pauses without restarting the process', !r.isError && !requests.some((q) => /runtime\/restart/.test(q.path)) && /left running \(keep_process\)/.test(r.text), r.text);
  work.slotW.state = 'running'; stub.restart = 'busy';
  r = await leadTool.call('agent_stop', { member: 'Worker' });
  check('a refused restart is reported, and the member is still paused', !r.isError && /process restart was refused/.test(r.text) && /is paused but its process is still running/.test(r.text), r.text);
  stub.restart = 'ok'; work.slotW.state = 'running'; stub.pause = 'refuse';
  r = await leadTool.call('agent_stop', { member: 'Worker' });
  check('a refused pause is reported, not claimed as done', /Stopping Worker: not complete\./.test(r.text) && /The pause was refused/.test(r.text), r.text);
  stub.pause = 'ok'; work.slotW.state = 'running';
  kv['aiondx.loop.team.team1.slotW'] = { v: 1, on: true, forever: true, foreverAt: Date.now() - 5000, msg: 'x', rev: 2, by: 'user', at: Date.now() - 1000 };
  r = await leadTool.call('agent_stop', { member: 'Worker' });
  check('a Loop that runs until the user stops it is left on, and the reply says it will wake the member again',
    kv['aiondx.loop.team.team1.slotW'].on === true && /Its Loop runs until the user stops it, so no agent can switch it off/.test(r.text) && /Paused:/.test(r.text), r.text);
  r = await leadTool.call('agent_stop', { member: 'Lead' });
  check('the lead cannot stop itself', r.isError && /That is you/.test(r.text), r.text);
  r = await leadTool.call('agent_stop', { member: 'all' });
  check('agent_stop takes one teammate at a time', r.isError && /one teammate at a time/.test(r.text), r.text);
  r = await workerTool.call('agent_stop', { member: 'Viewer' });
  check('a teammate cannot stop another', r.isError && /Only the team lead can stop a teammate/.test(r.text), r.text);
  r = await leadTool.call('agent_stop', { member: 'Nobody' });
  check('an unknown teammate is named in the refusal', r.isError && /No teammate matches "Nobody"/.test(r.text), r.text);
  work.slotW.state = 'running'; work.slotW.bg = 3;
  delete kv['aiondx.loop.team.team1.slotW'];

  r = await leadTool.call('loop_status', { member: 'Worker' });
  check('loop_status shows the teammate\'s queue', /Queue: Worker has \d+ messages waiting/.test(r.text), r.text);

  // ---- the shell program (aiondx.exe), for chats whose MCP servers were fixed before the tool existed ----
  const cliEnv = (convId) => ({ SYSTEMROOT: process.env.SYSTEMROOT, AIONDX_LOOP_LOG_DIR: LOGDIR, AIONDX_MCP_FILE: MCPFILE,
    AIONUI_BASE_URL: `http://127.0.0.1:${server.address().port}`, AIONUI_RUNTIME_TOKEN: TOKEN, AIONUI_USER_ID: 'u1', AIONUI_CONVERSATION_ID: convId });
  // Async on purpose: spawnSync would block this process, and with it the stand-in API the program calls.
  const run = (cmd, argv, env) => new Promise((resolve) => {
    const ch = spawn(cmd, argv, { env, windowsHide: true });
    children.push(ch);
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => ch.kill(), 30000);
    ch.on('exit', (code) => { clearTimeout(t); resolve({ status: code, stdout: out, stderr: err }); });
  });
  const cli = (argv, convId = 'convW') => run(CLI, argv, cliEnv(convId));
  requests.length = 0;
  let pc = await cli(['priority', '--member', 'Worker', '--message', 'Check the logs first.'], 'convL');
  check('aiondx priority --member --message sends it from a shell, exit 0', pc.status === 0 && /^Sent to Worker as a priority message\./.test(pc.stdout) &&
    requests.some((q) => q.method === 'POST' && q.path === '/api/teams/team1/agents/slotW/messages'), pc.stdout + pc.stderr);
  pc = await cli(['priority', '--member', 'Viewer', '--message', 'x'], 'convW');
  check('aiondx priority from a teammate is refused, exit 1', pc.status === 1 && /Only the team lead/.test(pc.stdout), pc.stdout);
  work.slotW.state = 'running';
  requests.length = 0;
  let sc = await cli(['stop', '--member', 'Worker', '--reason', 'enough'], 'convL');
  check('aiondx stop --member --reason stops a teammate from a shell, exit 0', sc.status === 0 && /^Stopping Worker: done\./.test(sc.stdout) &&
    requests.some((q) => /\/pause$/.test(q.path)) && requests.some((q) => /runtime\/restart$/.test(q.path)), sc.stdout + sc.stderr);
  sc = await cli(['stop', '--member', 'Viewer'], 'convW');
  check('and a teammate gets the refusal, exit 1', sc.status === 1 && /Only the team lead can stop a teammate/.test(sc.stdout), sc.stdout + sc.stderr);
  work.slotW.state = 'running';
  let c = await cli(['loop', 'status']);
  check('aiondx loop status prints the same report, exit 0', c.status === 0 && /^Loop for you \(Worker, teammate on team "Team One"\): /.test(c.stdout), c.stdout + c.stderr);
  c = await cli(['loop', 'set', '--off', '--note', 'map tests pass']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('aiondx loop set --off --note writes the record', c.status === 0 && rec.on === false && rec.note === 'map tests pass' && rec.by === 'agent' && /^Saved\./.test(c.stdout), c.stdout);
  c = await cli(['loop', 'set', '--on=true', '--message=Pick up at item 7 of queue.md.']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('--flag=value forms work', c.status === 0 && rec.on === true && rec.msg === 'Pick up at item 7 of queue.md.', c.stdout);
  c = await cli(['loop', 'set', '--on', 'false']);
  check('--on false switches it off', c.status === 0 && kv['aiondx.loop.team.team1.slotW'].on === false, c.stdout);
  c = await cli(['loop', 'set', '--hold', '90', '--note', 'waiting on the spread']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('--hold sets how long it keeps the cache warm, and needs nothing else', c.status === 0 && rec.holdMin === 90 && rec.on === false, c.stdout);
  c = await cli(['loop', 'set', '--hold', '999']);
  check('--hold past 240 is refused, exit 1', c.status === 1 && /0 to 240/.test(c.stdout), c.stdout);
  c = await cli(['loop', 'set', '--hold', 'lots']);
  check('--hold that is not a number is refused, exit 1', c.status === 1 && /--hold takes a number of minutes/.test(c.stdout), c.stdout);
  c = await cli(['loop', 'set', '--on']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('a later change keeps the hold, and status reports it', c.status === 0 && rec.holdMin === 90 &&
    /Keeps the cache warm through 90 min of short replies, then rests/.test(c.stdout), c.stdout);
  c = await cli(['loop', 'set', '--resume-at', '+20', '--resume-message', 'The usage window is open; back to the queue.']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('--resume-at and --resume-message on the command line', c.status === 0 && rec.wakeAt > Date.now() + 19 * 60000 &&
    rec.wakeMsg === 'The usage window is open; back to the queue.' && rec.wakeSelf === true && /Resumes at \d\d:\d\d/.test(c.stdout), c.stdout);
  c = await cli(['loop', 'set', '--resume-at', 'off']);
  check('--resume-at off clears it', c.status === 0 && kv['aiondx.loop.team.team1.slotW'].wakeAt === 0, c.stdout);
  const nowMs = Date.now();
  kv['aiondx.loopstatus.team.team1.slotW'] = { on: true, fires: 2, lastFired: nowMs - 90000, lastAt: nowMs - 60000,
    warmUntil: nowMs + 240000, nextNudgeAt: nowMs + 60000, restingSince: 0, why: 'Nothing to do after the last nudge.' };
  c = await cli(['loop', 'status']);
  check('status shows how long the cache stays warm and the next nudge', c.status === 0 &&
    /Cache: warm until \d\d:\d\d \(\d+ (s|min) left\), your last message at \d\d:\d\d\. Next nudge at \d\d:\d\d\./.test(c.stdout), c.stdout);
  kv['aiondx.loopstatus.team.team1.slotW'] = { on: true, lastAt: nowMs - 600000, warmUntil: nowMs - 300000,
    restingSince: nowMs - 290000, restKind: 'cold' };
  c = await cli(['loop', 'status']);
  check('status says when the Loop rests and why', /Cache: ran out at \d\d:\d\d/.test(c.stdout) &&
    /Resting since \d\d:\d\d: the cache had run out, and the Loop does not wake a cold agent/.test(c.stdout), c.stdout);
  delete kv['aiondx.loopstatus.team.team1.slotW'];
  c = await cli(['loop', 'set', '--until-stopped', '--note', 'a request: until I stop it']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('--until-stopped on the command line', c.status === 0 && rec.on === true && rec.forever === true && /ON until the user stops it/.test(c.stdout), c.stdout);
  c = await cli(['loop', 'set', '--off']);
  check('--off is refused while it runs until the user stops it, exit 1', c.status === 1 && /^Your Loop runs until the user stops it/.test(c.stdout) &&
    kv['aiondx.loop.team.team1.slotW'].on === true, c.stdout);
  kv['aiondx.loopask.team.team1.slotW'] = { v: 1, at: Date.now(), text: 'you can turn your loop off now' };
  c = await cli(['loop', 'set', '--until-stopped=false']);
  rec = kv['aiondx.loop.team.team1.slotW'];
  check('--until-stopped=false once the user asked in its own chat: the mode ends, the Loop stays on', c.status === 0 && rec.on === true && rec.forever === false && rec.askedAt > 0, c.stdout);
  delete kv['aiondx.loopask.team.team1.slotW'];
  c = await cli(['loop', 'set', '--off']);
  c = await cli(['loop', 'set', '--member', 'Lead', '--off']);
  check('a teammate is refused the lead\'s Loop on the command line too, exit 1', c.status === 1 && /Only the team lead/.test(c.stdout), c.stdout);
  const tests0 = requests.filter((q) => q.path === '/api/mcp/test-connection').length;
  c = await cli(['mcp', 'add', '--aionui', '--on', '--name', 'notes', '--url', 'https://notes.example/mcp', '--header', 'Authorization=Bearer abc', '--no-test', '--note', 'shared notes']);
  const notes = mcp.find((s) => s.name === 'notes');
  check('aiondx mcp add --aionui --on from the shell: http transport with its header, switched on, --no-test skips the check', c.status === 0 && notes && notes.enabled === true &&
    notes.transport.type === 'http' && notes.transport.headers.Authorization === 'Bearer abc' &&
    requests.filter((q) => q.path === '/api/mcp/test-connection').length === tests0 && !/Bearer abc/.test(c.stdout), c.stdout);
  c = await cli(['mcp', 'status']);
  check('aiondx mcp status lists it, header name only', c.status === 0 && /notes: ON, http https:\/\/notes\.example\/mcp \(headers: Authorization\)/.test(c.stdout) && !/Bearer abc/.test(c.stdout), c.stdout);
  c = await cli(['mcp', 'remove', '--name', 'notes']);
  check('aiondx mcp remove', c.status === 0 && !mcp.find((s) => s.name === 'notes'), c.stdout);
  c = await cli(['loop', 'set', '--frobnicate']);
  check('an unknown option is refused with the usage, exit 1', c.status === 1 && /Unknown option --frobnicate/.test(c.stdout) && /Usage:/.test(c.stdout), c.stdout);
  c = await cli(['loop', 'help']);
  check('loop help prints the usage, exit 0', c.status === 0 && /aiondx loop set \[--on\|--off\]/.test(c.stdout), c.stdout);
  c = await cli(['frobnicate']);
  check('an unknown command prints the usage, exit 2', c.status === 2 && /Usage:/.test(c.stdout), c.stdout);
  const ps = await run('powershell.exe', ['-NoProfile', '-Command', `& '${CLI}' loop status; 'exit=' + $LASTEXITCODE`],
    { ...process.env, ...cliEnv('convS') });
  check('PowerShell waits for it and captures its output', /^Loop for you \(chat "Solo chat"\)/m.test(ps.stdout) && /exit=0/.test(ps.stdout), ps.stdout + ps.stderr);

  // ---- GitHub through git's own sign-in (1.9.0; a request) ----
  // A stand-in git: signed in as "tester", with a placeholder commit identity. And one with no sign-in.
  fs.mkdirSync(path.join(LOGDIR, 'bin'), { recursive: true });   // not beside the logs, which the last check reads
  const FAKEGIT = path.join(LOGDIR, 'bin', 'git.cmd');
  fs.writeFileSync(FAKEGIT, [
    '@echo off',
    'if "%1"=="credential" goto cred',
    'if "%1"=="config" goto conf',
    'exit /b 1',
    ':cred',
    'echo protocol=https',
    'echo host=github.com',
    'echo username=tester',
    `echo password=${GH_TOKEN}`,
    'exit /b 0',
    ':conf',
    'if "%3"=="credential.helper" (echo manager& exit /b 0)',
    'if "%3"=="user.name" (echo Build Bot& exit /b 0)',
    'if "%3"=="user.email" (echo unconfigured@null.invalid& exit /b 0)',
    'exit /b 1', ''].join('\r\n'));
  const NOGIT = path.join(LOGDIR, 'bin', 'git-nocred.cmd');
  fs.writeFileSync(NOGIT, '@echo off\r\nif "%1"=="config" (echo manager& exit /b 0)\r\necho fatal: could not read Username for \'https://github.com\': terminal prompts disabled 1>&2\r\nexit /b 128\r\n');
  const ghEnv = (git) => ({ ...cliEnv('convS'), AIONDX_GIT: git || FAKEGIT, AIONDX_GITHUB_API: `http://127.0.0.1:${server.address().port}/gh` });
  const ghc = (argv, git) => run(CLI, ["github", ...argv], ghEnv(git));
  let g = await ghc([]);
  check('aiondx github: the account git is signed in as, that pushing needs nothing more, and how to push', g.status === 0 &&
    /^GitHub: git on this PC is signed in as tester \(Git Credential Manager\), so git push to tester's repositories works with nothing else: no token, no MCP server\./.test(g.stdout) &&
    /git remote add origin https:\/\/github\.com\/tester\/NAME\.git; git push -u origin main/.test(g.stdout), g.stdout + g.stderr);
  check("it says when commits would carry a placeholder name and email instead of the user's", /Commits are signed Build Bot <unconfigured@null\.invalid>, which looks like a placeholder, not the user's/.test(g.stdout), g.stdout);
  check('the token goes to GitHub as the sign-in and nowhere else: not printed', ghRequests.some((q) => q.path === '/gh/user' && q.headers.authorization === 'Bearer ' + GH_TOKEN) &&
    !g.stdout.includes(GH_TOKEN) && !g.stderr.includes(GH_TOKEN), g.stdout);
  g = await ghc(['repos']);
  check('aiondx github repos lists them, private or public', g.status === 0 && /tester's repositories, the latest changed first \(2\):/.test(g.stdout) &&
    /- alpha \(private\) https:\/\/github\.com\/tester\/alpha, last push 2026-09-20/.test(g.stdout) && /- beta \(public\)/.test(g.stdout), g.stdout);
  ghRequests.length = 0;
  g = await ghc(['create', 'gamma', '--description', 'The game']);
  let post = ghRequests.find((q) => q.method === 'POST');
  check('aiondx github create NAME: private unless asked, as JSON, with the description', g.status === 0 && post && post.body.name === 'gamma' && post.body.private === true &&
    post.body.description === 'The game' && /^application\/json/.test(post.headers['content-type'] || '') &&
    /^Made https:\/\/github\.com\/tester\/gamma \(private\)\. To push a folder:/.test(g.stdout), g.stdout + JSON.stringify(post && post.body));
  g = await ghc(['create', 'gamma2', '--public']);
  check('--public makes it public', g.status === 0 && /Made https:\/\/github\.com\/tester\/gamma2 \(public\)/.test(g.stdout) && ghRepos.gamma2.private === false, g.stdout);
  g = await ghc(['create', 'alpha']);
  check('a name the account has makes nothing and says where it is', g.status === 0 && /^tester already has a repository named alpha: https:\/\/github\.com\/tester\/alpha\. Nothing was made\./.test(g.stdout), g.stdout);
  ghRequests.length = 0;
  g = await ghc(['create', 'flaky']);
  check('GitHub making it public when private was asked (September 27th): read back and set right', g.status === 0 && ghRepos.flaky.private === true &&
    ghRequests.some((q) => q.method === 'PATCH' && q.body && q.body.private === true) && /\(private\)\. GitHub made it public at first; it is set right now\./.test(g.stdout), g.stdout);
  g = await ghc(['create', 'bad name!']);
  check('a name GitHub would refuse is refused first', g.status === 1 && /A repository name is letters, digits, dot, dash and underscore/.test(g.stdout), g.stdout);
  g = await ghc([], NOGIT);
  check('with no stored sign-in it says so, what git said, and how the user signs in', g.status === 1 &&
    /no stored GitHub sign-in \(credential helper: manager; git said: fatal: could not read Username/.test(g.stdout) && /git credential-manager github login/.test(g.stdout), g.stdout);
  g = await run(CLI, ['mcp', 'list'], ghEnv());
  check('aiondx mcp list sends anyone looking for "the GitHub MCP" to git and aiondx github', /GitHub: no MCP server is needed\. git on this PC signs in to GitHub by itself \(credential helper: manager\)/.test(g.stdout), g.stdout);
  const ghTool = startTool('convS', { AIONDX_GIT: FAKEGIT, AIONDX_GITHUB_API: `http://127.0.0.1:${server.address().port}/gh` });
  await ghTool.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await ghTool.call('github_status', { repos: true });
  check('the github_status tool: the account, how to push, and with repos: true the repositories', !r.isError && /signed in as tester/.test(r.text) && /- alpha \(private\)/.test(r.text), r.text);
  r = await ghTool.call('github_create_repo', { name: 'delta', description: 'D' });
  check('the github_create_repo tool makes a private repository', !r.isError && /^Made https:\/\/github\.com\/tester\/delta \(private\)/.test(r.text) && ghRepos.delta.private === true, r.text);


  // ---- Claude usage for the agents (1.10.0; a request) ----
  const nowS = Math.floor(Date.now() / 1000);
  kv['aiondx.usage.conv.convS'] = { acct: 'acctA', at: Date.now() };
  kv['aiondx.usage.acct.acctA'] = { label: 'main (Plan A)', at: Date.now() - 180000, http: 200, status: 'allowed', claim: 'five_hour',
    five_hour: { u: 0.63, reset: nowS + 8040, status: 'allowed' }, seven_day: { u: 0.41, reset: nowS + 3 * 86400, status: 'allowed' } };
  kv['aiondx.usage.acct.acctB'] = { label: 'second account', at: Date.now() - 60000, status: 'allowed',
    five_hour: { u: 0.12, reset: nowS + 9000, status: 'allowed' }, seven_day: { u: 0.29, reset: nowS + 4 * 86400, status: 'allowed' } };
  let uc = await cli(['usage'], 'convS');
  check('aiondx usage: the 5-hour and weekly windows of this chat\'s own account, how much is used, when each resets, how old the reading is', uc.status === 0 &&
    /^Claude usage for you \(main \(Plan A\)\), read 3 min ago, from Claude's own traffic:/.test(uc.stdout) && /5-hour window: 63% used, resets \d\d:\d\d, in 2 h 14 min\./.test(uc.stdout) &&
    /Weekly window: 41% used, resets \w{3} \d\d:\d\d, in \d+ h/.test(uc.stdout) && !/second account/.test(uc.stdout), uc.stdout);
  uc = await cli(['usage'], 'convL');
  check('a chat with no reading is told when one appears, and that nothing is called to get it', uc.status === 0 && /^No usage reading for this chat yet\./.test(uc.stdout) && /nothing is called to get it/.test(uc.stdout), uc.stdout);
  uc = await cli(['usage', '--all'], 'convS');
  check('--all adds the other accounts', /another account \(second account\)/.test(uc.stdout) && /5-hour window: 12% used/.test(uc.stdout) && /main \(Plan A\)/.test(uc.stdout), uc.stdout);
  uc = await cli(['usage', '--bogus'], 'convS');
  check('an unknown option is refused with the usage, exit 1', uc.status === 1 && /Unknown option --bogus/.test(uc.stdout) && /Usage:/.test(uc.stdout), uc.stdout);
  kv['aiondx.usage.acct.acctA'] = Object.assign({}, kv['aiondx.usage.acct.acctA'], { status: 'rejected', five_hour: { u: 1.02, reset: nowS + 3900, status: 'rejected' } });
  uc = await cli(['usage'], 'convS');
  check('a reached limit says so, until when, and not to retry before then', /5-hour window: 102% used, resets \d\d:\d\d, in 1 h 5 min\. LIMIT REACHED\./.test(uc.stdout) &&
    /This account cannot make requests until \d\d:\d\d \(resets \d\d:\d\d, in 1 h 5 min\)\. Do not retry before then; tell the user\./.test(uc.stdout), uc.stdout);
  kv['aiondx.usage.acct.acctA'] = Object.assign({}, kv['aiondx.usage.acct.acctA'], { status: 'allowed', five_hour: { u: 0.9, reset: nowS - 600, status: 'allowed' } });
  uc = await cli(['usage'], 'convS');
  check('a window whose reset time has passed is not reported as used', /5-hour window: reset since the last reading/.test(uc.stdout) && !/LIMIT REACHED/.test(uc.stdout), uc.stdout);
  kv['aiondx.usage.acct.acctA'] = Object.assign({}, kv['aiondx.usage.acct.acctA'], { status: 'allowed', five_hour: { u: 0.63, reset: nowS + 8040, status: 'allowed' } });
  const usageTool = startTool('convS');
  await usageTool.rpc('initialize', { protocolVersion: '2025-06-18' });
  r = await usageTool.call('usage_status', {});
  check('the usage_status tool says the same', !r.isError && /^Claude usage for you \(main \(Plan A\)\)/.test(r.text) && /5-hour window: 63% used/.test(r.text), r.text);
  r = await usageTool.call('loop_status', {});
  check('loop_status ends with one line of usage, for this chat\'s own account', /\nUsage: 5-hour 63% \(resets \d\d:\d\d\), week 41% \(usage_status has the detail\)\.\n$/.test(r.text), r.text.slice(-200));
  delete kv['aiondx.usage.conv.convS'];
  r = await usageTool.call('loop_status', {});
  check('and none when there is no reading', !/Usage:/.test(r.text), r.text.slice(-160));
  delete kv['aiondx.usage.acct.acctA']; delete kv['aiondx.usage.acct.acctB'];

  const logText = fs.readdirSync(LOGDIR).filter((f) => fs.statSync(path.join(LOGDIR, f)).isFile()).map((f) => fs.readFileSync(path.join(LOGDIR, f), 'utf8')).join('');
  check('the log has a line per call and never a token', /loop_set ok/.test(logText) && /loop_status error/.test(logText) && !logText.includes(TOKEN) && !logText.includes('tok-stale') &&
    !logText.includes(GH_TOKEN) && /cli github create ok/.test(logText), logText.split('\n').slice(-3).join(' | '));

  down = true;
  server.close();
  await sleep(200);
  r = await solo.call('loop_status');
  check('with AionUi closed it says the API did not answer', r.isError && /did not answer/.test(r.text), r.text);

  // ---- lifetime ----
  solo.child.stdin.end();
  const exited = await Promise.race([new Promise((res) => solo.child.on('exit', () => res(true))), sleep(3000).then(() => false)]);
  check('it exits when stdin closes', exited);

  // The parent dies but stdin stays open (the pipe belongs to this test): it must still exit.
  const mid = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const c = spawn(${JSON.stringify(EXE)}, [], { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true });
    console.log(c.pid); setInterval(() => {}, 1000);`], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  children.push(mid);
  const grandPid = await new Promise((res) => mid.stdout.once('data', (d) => res(parseInt(String(d), 10))));
  await sleep(800);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const wasAlive = alive(grandPid);
  mid.kill();
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { await sleep(100); gone = !alive(grandPid); }
  check('it exits when the process that started it dies, even with stdin still open', wasAlive && gone, `alive before: ${wasAlive}, gone after: ${gone}`);
  if (!gone) { try { process.kill(grandPid); } catch { /* gone */ } }

  // ---- report ----
  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n      ${x.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  try { fs.rmSync(LOGDIR, { recursive: true, force: true }); } catch { /* leave it */ }
  finish(failed.length ? 1 : 0);
})().catch((e) => finish(1, 'SUITE ERROR: ' + (e && e.stack || e)));
