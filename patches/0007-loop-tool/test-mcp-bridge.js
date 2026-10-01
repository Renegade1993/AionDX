#!/usr/bin/env node
/**
 * test-mcp-bridge.js - patch 0007's MCP servers used as needed (1.6.0): the AionDX MCP file, and aiondx mcp list, tools,
 * call, add, update, remove, test and secret, driven the way an agent drives them. The server is test-mcp-fixture.js,
 * over stdio (through a .cmd wrapper, the way npx runs), streamable HTTP (answered as JSON and as an event stream) and
 * the older SSE transport; a stand-in for AionUi's API covers the reach into AionUi's own list and the user's notices.
 *
 *   node patches\0007-loop-tool\test-mcp-bridge.js     exit 0 only if every check passes
 *
 * Everything happens in a temp folder (AIONDX_MCP_FILE points there): the real file is never touched. Hard 180 s
 * deadline; every child process is killed on every exit path, and the temp folder is deleted.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DIR = __dirname;
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-mcp-bridge-'));
const CLI = path.join(TMP, 'aiondx.exe');
const EXE = path.join(TMP, 'aiondx-loop.exe');
const FILE = path.join(TMP, 'mcp', 'servers.json');
const FIXTURE = path.join(DIR, 'test-mcp-fixture.js');
const BIN = path.join(TMP, 'bin');
const WRAP = path.join(BIN, 'fixture-server.cmd');
const PIDFILE = path.join(TMP, 'fixture.pid');

const children = [];
let api = null;
let web = null;
function finish(code, msg) {
  if (msg) console.log(msg);
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { api && api.close(); } catch { /* closed */ }
  setTimeout(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* a process may still hold a file */ }
    process.exit(code);
  }, 300);
}
setTimeout(() => finish(2, 'DEADLINE: suite did not finish within 180 s'), 180000).unref();

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the stand-in API (the routes the bridge uses)

const kv = {};
const listed = [
  { id: 'mcp-9', name: 'listed', enabled: false, builtin: false,
    transport: { type: 'stdio', command: process.execPath, args: [FIXTURE, 'stdio'], env: { FIXTURE_SECRET: 'from-aionui' } }, last_test_status: 'disconnected' },
];
let seq = 10;
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (req.headers['x-aionui-runtime-token'] !== 'tok') return reply(res, 401, { success: false, message: 'Invalid runtime token' });
    let m;
    if (req.method === 'GET' && url.pathname === '/api/teams') return reply(res, 200, { success: true, data: [] });
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/conversations\/([^/]+)$/))) return reply(res, 200, { success: true, data: { id: m[1], name: 'Project chat' } });
    if (url.pathname === '/api/mcp/servers' && req.method === 'GET') return reply(res, 200, { success: true, data: listed });
    if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
      const b = JSON.parse(raw);
      const s = { id: 'mcp-' + (seq++), name: b.name, enabled: false, builtin: false, transport: b.transport, last_test_status: 'disconnected' };
      listed.push(s);
      return reply(res, 200, { success: true, data: s });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/toggle$/))) {
      const s = listed.find((x) => x.id === m[1]);
      s.enabled = !s.enabled;
      return reply(res, 200, { success: true, data: s });
    }
    if (url.pathname === '/api/mcp/test-connection') return reply(res, 200, { success: true, data: { success: true, tools: [{ name: 't' }] } });
    if (url.pathname === '/api/settings/client') {
      if (req.method === 'GET') {
        const out = {};
        for (const k of (url.searchParams.get('keys') || '').split(',')) if (k in kv) out[k] = kv[k];
        return reply(res, 200, { success: true, data: out });
      }
      for (const [k, v] of Object.entries(JSON.parse(raw || '{}'))) { if (v === null) delete kv[k]; else kv[k] = v; }
      return reply(res, 200, { success: true });
    }
    return reply(res, 404, { success: false, message: 'no route' });
  });
});

// ---------------------------------------------------------------- running the program

const baseEnv = (more) => ({
  SYSTEMROOT: process.env.SYSTEMROOT, SystemDrive: process.env.SystemDrive, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT,
  ComSpec: process.env.ComSpec, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
  TEMP: TMP, TMP: TMP, AIONDX_MCP_FILE: FILE, AIONDX_LOOP_LOG_DIR: TMP, AIONDX_LOOP_NO_ANCESTORS: '1', ...(more || {}),
});
const inChat = (more) => baseEnv({
  AIONUI_BASE_URL: `http://127.0.0.1:${api.address().port}`, AIONUI_RUNTIME_TOKEN: 'tok', AIONUI_USER_ID: 'u1', AIONUI_CONVERSATION_ID: 'convH',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-claude-secret', ...(more || {}),
});
// Async on purpose: spawnSync would block this process, and with it the stand-in API and the HTTP server.
const run = (argv, env, input) => new Promise((resolve) => {
  const t0 = Date.now();
  const ch = spawn(CLI, argv, { env: env || baseEnv(), windowsHide: true });
  children.push(ch);
  let out = '', err = '';
  ch.stdout.on('data', (d) => { out += d; });
  ch.stderr.on('data', (d) => { err += d; });
  ch.stdin.end(input === undefined ? '' : input);
  const t = setTimeout(() => ch.kill(), 60000);
  ch.on('exit', (code) => { clearTimeout(t); resolve({ status: code, out, err, ms: Date.now() - t0 }); });
});
const mcp = (...argv) => run(['mcp', ...argv]);
const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const writeFile = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  // ---- build: one source, two programs ----
  for (const [target, out] of [['exe', CLI], ['winexe', EXE]]) {
    const b = spawnSync(CSC, ['/nologo', '/optimize+', `/target:${target}`, '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${out}`, path.join(DIR, 'aiondx-loop.cs')],
      { encoding: 'utf8', windowsHide: true });
    const text = (b.stdout || '') + (b.stderr || '');
    check(`compiles as ${target}, no warnings`, b.status === 0 && !/warning|error/i.test(text), text.trim());
    if (b.status !== 0) return finish(1, text);
  }
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(WRAP, `@"${process.execPath}" "${FIXTURE}" %*\r\n`);
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  web = spawn(process.execPath, [FIXTURE, 'http'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  children.push(web);
  const port = await new Promise((res) => web.stdout.on('data', (d) => { const m = String(d).match(/PORT (\d+)/); if (m) res(Number(m[1])); }));
  const base = `http://127.0.0.1:${port}`;
  const stats = async () => (await fetch(base + '/stats')).json();

  // ---- the file ----
  let r = await mcp('path');
  check('mcp path prints the file', r.status === 0 && r.out.trim() === FILE, r.out);
  r = await mcp('list');
  check('mcp list with no file yet, outside AionUi: says so, and that AionUi is out of reach', r.status === 0 && /\(not made yet\): 0 servers/.test(r.out) &&
    /AionUi's MCP list: out of reach from here/.test(r.out), r.out);
  r = await mcp('init');
  let f = fs.existsSync(FILE) ? readFile() : {};
  check('mcp init makes the file: an explanation, mcpServers and secrets, laid out for a person', r.status === 0 && /^Made /.test(r.out) &&
    Array.isArray(f._about) && f.mcpServers && f.secrets && /\n  "mcpServers": \{\}/.test(fs.readFileSync(FILE, 'utf8')) &&
    !/[\u2013\u2014]/.test(fs.readFileSync(FILE, 'utf8')), r.out + fs.readFileSync(FILE, 'utf8'));
  r = await mcp('init');
  check('mcp init again leaves it alone', r.status === 0 && /is there, with 0 server/.test(r.out), r.out);

  // ---- add, over stdio through a .cmd wrapper ----
  r = await mcp('add', '--name', 'fix', '--command', WRAP, '--arg', 'stdio', '--env', 'FIXTURE_SECRET=abc123', '--description', 'The test server', '--note', 'testing');
  f = readFile();
  check('add puts the server in the file, checks it, and never prints the secret', r.status === 0 &&
    /^Added fix to the AionDX MCP file, .*\. No chat loads it: use it when the user asks\. The check connected to fixture 1\.0\.0 and found 11 tools: echo, add, args, tags, env, image, fail, roots, slow, crash, headers\./.test(r.out) &&
    !/abc123/.test(r.out) && f.mcpServers.fix && f.mcpServers.fix.description === 'The test server' && f.mcpServers.fix.command === WRAP &&
    JSON.stringify(f.mcpServers.fix.args) === '["stdio"]' && /^dpapi:v1:[A-Za-z0-9+/=]{40,}$/.test(f.mcpServers.fix.env.FIXTURE_SECRET) &&
    !fs.readFileSync(FILE, 'utf8').includes('abc123'), r.out + JSON.stringify(f.mcpServers));
  check('outside AionUi it does not claim the user saw a notice', !/The user sees this change/.test(r.out), r.out);
  r = await mcp('add', '--name', 'FIX', '--command', WRAP);
  check('a name already there is refused, whatever its case', r.status === 1 && /already has fix; use update/.test(r.out), r.out);
  r = await mcp('add', '--name', 'bad name!', '--command', 'x');
  check('a name with spaces or signs is refused', r.status === 1 && /A server name is letters, digits/.test(r.out), r.out);
  r = await mcp('list');
  check('list shows how it runs and what it is for, with env names but not values', r.status === 0 &&
    r.out.includes(`fix: stdio ${WRAP} stdio (env: FIXTURE_SECRET). The test server`) && !/abc123/.test(r.out), r.out);

  // ---- tools ----
  r = await mcp('tools', 'fix');
  check('tools lists every tool across both pages, with its parameters and * for required', r.status === 0 &&
    /^fix \(fixture 1\.0\.0\), from the AionDX MCP file: 11 tools\./.test(r.out) && /- echo: Says the text back\.\n    text\*: string\n/.test(r.out) &&
    /labels: string\[\]/.test(r.out) && /x: string\|null/.test(r.out) && /- headers:/.test(r.out), r.out);
  r = await mcp('tools', 'fix', 'echo');
  check('tools SERVER TOOL gives one tool in full, with its schema', r.status === 0 && /Parameters \(\* = required\):\n  text\*: string\. What to say/.test(r.out) &&
    /Input schema:\n\{/.test(r.out), r.out);

  // ---- call ----
  r = await mcp('call', 'fix', 'echo', '--param', 'text=hello world');
  check('call: a text answer, exit 0', r.status === 0 && r.out === 'hello world\n', JSON.stringify(r));
  r = await mcp('call', 'fix', 'echo', '--param', 'text=h\u00e9llo \u2713 \u4f60\u597d');
  check('text outside ASCII goes there and back as UTF-8', r.out === 'h\u00e9llo \u2713 \u4f60\u597d\n', JSON.stringify(r.out));
  r = await mcp('call', 'fix', 'add', '--param', 'a=2', '--param', 'b=3.5');
  check('numbers are sent as numbers', r.status === 0 && r.out.trim() === '5.5', r.out);
  r = await mcp('call', 'fix', 'args', '--param', 'n=007', '--param', 's=007', '--param', 'f=yes', '--param', 'o={"k":1}', '--param', 'x=null');
  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch { /* reported */ }
  check('each value follows the schema: integer, string, boolean, object, null', parsed && parsed.n === 7 && parsed.s === '007' && parsed.f === true &&
    parsed.o && parsed.o.k === 1 && parsed.x === null, r.out);
  r = await mcp('call', 'fix', 'tags', '--param', 'labels=bug, ui');
  check('a list from a,b', r.out.trim() === '["bug","ui"]', r.out);
  r = await mcp('call', 'fix', 'tags', '--param', 'labels=["x y","z"]');
  check('or as JSON', r.out.trim() === '["x y","z"]', r.out);
  r = await mcp('call', 'fix', 'echo', '{"text":"from json"}');
  check('JSON arguments as the third value', r.out === 'from json\n', r.out);
  const jf = path.join(TMP, 'args.json');
  fs.writeFileSync(jf, '\ufeff{"text": "from a file"}');
  r = await mcp('call', 'fix', 'echo', '--json-file', jf);
  check('--json-file (a byte order mark is fine)', r.out === 'from a file\n', r.out);
  r = await run(['mcp', 'call', 'fix', 'echo', '--json', '-'], baseEnv(), '{"text":"from stdin"}');
  check('--json - reads standard input', r.out === 'from stdin\n', r.out);
  r = await mcp('call', 'fix', 'echo', '{text:lost quotes}');
  check('JSON that lost its quotes is refused, naming PowerShell 5.1 and the ways round it', r.status === 1 && /Windows PowerShell 5\.1/.test(r.out) &&
    /--param name=value/.test(r.out) && /--json-file/.test(r.out), r.out);
  r = await mcp('call', 'fix', 'env', '--param', 'name=FIXTURE_SECRET');
  check('the server gets its credential from the file', r.out.trim() === 'abc123', r.out);
  r = await run(['mcp', 'call', 'fix', 'env', '--param', 'name=AIONUI_RUNTIME_TOKEN'], inChat());
  const r2 = await run(['mcp', 'call', 'fix', 'env', '--param', 'name=CLAUDE_CODE_OAUTH_TOKEN'], inChat());
  check("the server never gets the agent's AionUi token or Claude sign-in", r.out.trim() === '(unset)' && r2.out.trim() === '(unset)', r.out + r2.out);
  r = await mcp('call', 'fix', 'image');
  const img = (r.out.match(/\[image saved to (.+?\.png) \(image\/png, (\d+) bytes\)\]/) || [])[1];
  check('a picture is saved and named by its path, with the text beside it', r.status === 0 && img && fs.existsSync(img) &&
    fs.readFileSync(img).slice(1, 4).toString() === 'PNG' && /one pixel/.test(r.out), r.out);
  r = await mcp('call', 'fix', 'fail');
  check("the tool's own error: its text, exit 1", r.status === 1 && r.out.trim() === 'it broke', JSON.stringify(r));
  r = await mcp('call', 'fix', 'roots');
  check("the server's roots/list request is answered (none)", r.status === 0 && r.out.trim() === 'roots: []', r.out);
  r = await mcp('call', 'fix', 'nosuch');
  check('an unknown tool is refused with the list', r.status === 1 && /has no tool named "nosuch"\. Its tools: echo, add, args/.test(r.out), r.out);
  r = await mcp('call', 'fix', 'crash');
  check('a server that dies is reported with its error output', r.status === 1 && /fix stopped/.test(r.out) && /fixture: crashing now/.test(r.out), r.out);
  r = await mcp('call', 'fix', 'echo', '--raw', '--param', 'text=x');
  check('--raw prints the whole result as JSON', r.status === 0 && JSON.parse(r.out).content[0].text === 'x', r.out);
  const outFile = path.join(TMP, 'answer.txt');
  r = await mcp('call', 'fix', 'echo', '--param', 'text=to a file', '--out', outFile);
  check('--out writes the answer to a file and says so', r.status === 0 && /^Wrote \d+ characters to /.test(r.out) && fs.readFileSync(outFile, 'utf8') === 'to a file\n', r.out);
  r = await mcp('call', 'nosuchserver', 'x');
  check('an unknown server is refused with the ones there are', r.status === 1 && /No MCP server named "nosuchserver"\. There are: fix/.test(r.out), r.out);
  r = await mcp('call', 'fix');
  check('call without a tool says what it needs', r.status === 1 && /Name the server and the tool/.test(r.out), r.out);

  // ---- a timeout ends the call and takes the server's processes with it ----
  try { fs.unlinkSync(PIDFILE); } catch { /* none */ }
  r = await run(['mcp', 'call', 'fix', 'slow', '--param', 'ms=20000', '--timeout', '2'], baseEnv({ FIXTURE_PIDFILE: PIDFILE }));
  const fixturePid = fs.existsSync(PIDFILE) ? Number(fs.readFileSync(PIDFILE, 'utf8')) : 0;
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { await sleep(100); gone = fixturePid > 0 && !alive(fixturePid); }
  check('--timeout: it gives up in time, and the node process under cmd.exe is gone too', r.status === 1 && /did not answer tools\/call within 2 s/.test(r.out) &&
    r.ms < 8000 && gone, `${r.ms} ms, pid ${fixturePid}, gone ${gone}: ${r.out}`);

  // ---- a bare name, found on the PATH with PATHEXT ----
  r = await mcp('add', '--name', 'fix2', '--command', 'fixture-server', '--arg', 'stdio', '--no-test');
  r = await run(['mcp', 'call', 'fix2', 'echo', '--param', 'text=on the path'], baseEnv({ PATH: BIN + ';' + process.env.PATH }));
  check('a command named without its folder is found on the PATH (fixture-server -> fixture-server.cmd)', r.out === 'on the path\n', r.out);
  r = await mcp('add', '--name', 'gone', '--command', 'no-such-program-xyz');
  check('a server whose program is missing is kept, with the failed check saying why', r.status === 0 && /Added gone/.test(r.out) &&
    /The check failed: Cannot find no-such-program-xyz, which starts gone, on the PATH/.test(r.out), r.out);

  // ---- secrets ----
  f = readFile();
  f.mcpServers.ph = { command: WRAP, args: ['stdio'], env: { FIXTURE_SECRET: '${FIX_TOKEN}', OTHER: '${NOPE:-fallback}' } };
  f.secrets.FIX_TOKEN = 'from-secrets';
  writeFile(f);
  r = await mcp('call', 'ph', 'env', '--param', 'name=FIXTURE_SECRET');
  check('${NAME} comes from the file\'s secrets', r.out.trim() === 'from-secrets', r.out);
  r = await mcp('call', 'ph', 'env', '--param', 'name=OTHER');
  check('${NAME:-default} falls back to its default', r.out.trim() === 'fallback', r.out);
  r = await mcp('secret', 'FIX_TOKEN');
  check('mcp secret prints the value alone, with no newline, for a shell variable', r.status === 0 && r.out === 'from-secrets', JSON.stringify(r.out));
  r = await mcp('secret', 'NOPE');
  check('an unknown secret is refused with the names there are', r.status === 1 && /no secret named NOPE; it has FIX_TOKEN/.test(r.out), r.out);
  r = await mcp('list');
  check('list names the secrets but never their values', /Secrets it holds, named here without their values: FIX_TOKEN\./.test(r.out) && !/from-secrets/.test(r.out), r.out);
  check('list says a credential is still plain text, and how to encrypt it', /1 credential is still plain text: aiondx mcp protect encrypts them/.test(r.out), r.out);
  // Encrypted for this Windows account (K: "security by tomorrow").
  f = readFile();
  f.mcpServers.ph.headers = { 'X-Api-Key': 'plain-header-key', 'X-Trace': 'visible', Authorization: 'Bearer ${FIX_TOKEN}' };
  writeFile(f);
  r = await mcp('protect');
  f = readFile();
  const raw = fs.readFileSync(FILE, 'utf8');
  check('protect encrypts the secrets and the credential values, and leaves the rest readable', r.status === 0 &&
    /^Encrypted 1 secret and 1 credential in server entries, for this Windows account/.test(r.out) && /dpapi:v1:/.test(f.secrets.FIX_TOKEN) &&
    /dpapi:v1:/.test(f.mcpServers.ph.headers['X-Api-Key']) && f.mcpServers.ph.headers['X-Trace'] === 'visible' && f.mcpServers.ph.env.FIXTURE_SECRET === '${FIX_TOKEN}' &&
    !raw.includes('from-secrets') && !raw.includes('plain-header-key'), r.out + raw.slice(0, 400));
  check('a value that names a secret ("Bearer ${NAME}") stays as written: the secret is sealed where it lives',
    f.mcpServers.ph.headers.Authorization === 'Bearer ${FIX_TOKEN}', JSON.stringify(f.mcpServers.ph.headers));
  r = await mcp('call', 'ph', 'env', '--param', 'name=FIXTURE_SECRET');
  check('an encrypted secret still reaches the server', r.out.trim() === 'from-secrets', r.out);
  r = await mcp('secret', 'FIX_TOKEN');
  check('and mcp secret gives it back decrypted', r.status === 0 && r.out === 'from-secrets', JSON.stringify(r.out));
  r = await mcp('protect');
  check('protect again: nothing left in plain text', r.status === 0 && /^Nothing was left in plain text\./.test(r.out), r.out);
  const acl = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$a = Get-Acl -LiteralPath '${path.dirname(FILE)}'; "protected=" + $a.AreAccessRulesProtected; $a.Access | ForEach-Object { $_.IdentityReference.Value + '|' + $_.IsInherited }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const aclLines = String(acl.stdout || '').trim().split(/\r?\n/);
  const me = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`.toLowerCase();
  check('the folder is closed to other accounts: no inherited access, only this user and SYSTEM', aclLines[0] === 'protected=True' &&
    aclLines.slice(1).every((l) => /\|False$/.test(l) && (l.toLowerCase().startsWith(me + '|') || /^NT AUTHORITY\\SYSTEM\|/i.test(l))) && aclLines.length === 3, aclLines.join(' ; '));
  r = await run(['mcp', 'secret', 'NEW_KEY', '--set'], baseEnv(), 'typed-value\r\n');
  f = readFile();
  check('secret NAME --set stores a value from standard input, encrypted, and never prints it', r.status === 0 && /^Stored NEW_KEY in the AionDX MCP file, encrypted/.test(r.out) &&
    /^dpapi:v1:/.test(f.secrets.NEW_KEY) && !r.out.includes('typed-value') && !fs.readFileSync(FILE, 'utf8').includes('typed-value'), r.out);
  r = await mcp('secret', 'NEW_KEY');
  check('and gives it back', r.out === 'typed-value', JSON.stringify(r.out));
  f.secrets.BROKEN = 'dpapi:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  f.mcpServers.ph.env.FIXTURE_SECRET = '${BROKEN}';
  writeFile(f);
  r = await mcp('call', 'ph', 'env', '--param', 'name=FIXTURE_SECRET');
  check('a value encrypted elsewhere is refused plainly, with how to store it again', r.status === 1 &&
    /The secret BROKEN in the AionDX MCP file was encrypted by another Windows account or on another PC/.test(r.out) && /secret NAME --set/.test(r.out), r.out);
  f.mcpServers.ph.env.FIXTURE_SECRET = '${FIX_TOKEN}';
  delete f.secrets.BROKEN;
  delete f.mcpServers.ph.headers;
  delete f.secrets.FIX_TOKEN;
  writeFile(f);
  r = await mcp('call', 'ph', 'env', '--param', 'name=FIXTURE_SECRET');
  check('a missing secret is named, with where to put it', r.status === 1 && /ph needs the secret FIX_TOKEN/.test(r.out), r.out);

  // ---- remote servers ----
  r = await mcp('add', '--name', 'web', '--url', `${base}/mcp`, '--header', 'Authorization=Bearer good-token');
  check('streamable HTTP: added and checked', r.status === 0 && /The check connected to fixture 1\.0\.0 and found 11 tools/.test(r.out) && !/good-token/.test(r.out), r.out);
  r = await mcp('call', 'web', 'echo', '--param', 'text=over http');
  let st = await stats();
  check('a call over streamable HTTP, with its session id, protocol version header, and the session closed after', r.out === 'over http\n' &&
    st.sessionErrors === 0 && st.protocolHeaders.includes('2025-06-18') && st.deletes >= 2, JSON.stringify(st) + r.out);
  r = await mcp('call', 'web', 'headers');
  let hd = {};
  try { hd = JSON.parse(r.out); } catch { /* reported */ }
  check('the header from the file reaches the server, and the client names itself', hd.authorization === 'Bearer good-token' && /^aiondx\/1\.\d+\.\d+$/.test(hd['user-agent'] || ''), r.out);
  r = await mcp('add', '--name', 'websse', '--url', `${base}/mcp?sse=1`, '--header', 'Authorization=Bearer good-token', '--no-test');
  r = await mcp('call', 'websse', 'echo', '--param', 'text=as events');
  check('streamable HTTP answered as an event stream, a notification before the answer', r.out === 'as events\n', r.out);
  r = await mcp('list');
  check('a URL query is not shown', r.out.includes(`websse: http ${base}/mcp?...`) && !/sse=1/.test(r.out), r.out);
  r = await mcp('add', '--name', 'bad', '--url', `${base}/mcp`, '--header', 'Authorization=Bearer nope');
  check('credentials refused: the check says so, and where to fix them', r.status === 0 &&
    /The check failed: bad answered HTTP 401: it did not accept the credentials\. Check them in the AionDX MCP file/.test(r.out) && !/nope/.test(r.out), r.out);
  r = await mcp('add', '--name', 'legacy', '--url', `${base}/sse`, '--type', 'sse', '--header', 'Authorization=Bearer good-token');
  const r3 = await mcp('call', 'legacy', 'echo', '--param', 'text=the old way');
  check('the older SSE transport: checked and called', /The check connected/.test(r.out) && r3.out === 'the old way\n', r.out + r3.out);
  r = await mcp('add', '--name', 'old', '--url', `${base}/old`, '--header', 'Authorization=Bearer good-token', '--no-test');
  r = await mcp('call', 'old', 'echo', '--param', 'text=fell back');
  check('an http server that refuses the POST is tried as the older SSE transport', r.out === 'fell back\n', r.out);

  // ---- update and remove ----
  r = await mcp('update', '--name', 'fix', '--description', 'Changed', '--no-test');
  f = readFile();
  check('update changes the description and keeps how it runs', r.status === 0 && f.mcpServers.fix.description === 'Changed' && f.mcpServers.fix.command === WRAP &&
    /^dpapi:v1:/.test(f.mcpServers.fix.env.FIXTURE_SECRET), JSON.stringify(f.mcpServers.fix));
  r = await mcp('remove', '--name', 'bad');
  check('remove takes it out of the file', r.status === 0 && !readFile().mcpServers.bad && /Removed bad from the AionDX MCP file/.test(r.out), r.out);
  r = await mcp('test', '--name', 'fix');
  check('test on a file server connects with the bridge', r.status === 0 && /^fix: The check connected to fixture 1\.0\.0/.test(r.out), r.out);
  r = await mcp('enable', '--name', 'fix');
  check('enable is for AionUi\'s list; outside AionUi it says the list is out of reach', r.status === 1, r.out);

  // ---- a broken file ----
  const good = fs.readFileSync(FILE, 'utf8');
  fs.writeFileSync(FILE, '{ "mcpServers": { "a": 1, }');
  r = await mcp('call', 'fix', 'echo', '--param', 'text=x');
  const rl = await mcp('list');
  check('a file that is not JSON: the call is refused with how to fix it, and list still runs', r.status === 1 && /is not valid JSON/.test(r.out) &&
    /no trailing|none after the last/.test(r.out) && rl.status === 0 && /is not valid JSON/.test(rl.out), r.out + rl.out);
  fs.writeFileSync(FILE, good);

  // ---- inside an AionUi chat ----
  r = await run(['mcp', 'add', '--name', 'chatfix', '--command', WRAP, '--arg', 'stdio', '--no-test', '--note', 'for the project repo'], inChat());
  const last = (kv['aiondx.mcp.log'] || []).slice(-1)[0] || {};
  check('in a chat the change is logged for the user\'s notice, with the chat\'s name and note', r.status === 0 && /The user sees this change with your name and note\./.test(r.out) &&
    last.who === 'Project chat' && last.action === 'add' && last.name === 'chatfix to the AionDX MCP file' && last.note === 'for the project repo' && last.conv === 'convH', JSON.stringify(last));
  r = await run(['mcp', 'call', 'listed', 'env', '--param', 'name=FIXTURE_SECRET'], inChat());
  check("a server only in AionUi's list, switched OFF, is used with its own credentials", r.out.trim() === 'from-aionui', r.out);
  r = await run(['mcp', 'list'], inChat());
  check("list shows AionUi's list too, ON and OFF", /AionUi's MCP list \(Settings > Tools\); a new chat gets the ones switched ON:/.test(r.out) && /listed: OFF/.test(r.out), r.out);
  r = await run(['mcp', 'add', '--aionui', '--name', 'uionly', '--command', 'x', '--no-test'], inChat());
  const uionly = listed.find((s) => s.name === 'uionly');
  check("--aionui adds to AionUi's list, switched OFF, since every new chat gets the ON ones", r.status === 0 && uionly && uionly.enabled === false &&
    /switched OFF: no chat gets it/.test(r.out), r.out);
  r = await run(['mcp', 'add', '--aionui', '--on', '--name', 'uion', '--command', 'x', '--no-test'], inChat());
  check('--aionui --on switches it on', r.status === 0 && listed.find((s) => s.name === 'uion').enabled === true && /switched it on: new chats get it/.test(r.out), r.out);
  r = await run(['mcp', 'status'], inChat());
  check('status has the file, this chat, and AionUi\'s list', r.status === 0 && /This chat's MCP servers/.test(r.out) && /The AionDX MCP file, /.test(r.out) &&
    /chatfix: stdio/.test(r.out) && /mcp_call calls one/.test(r.out) && !/abc123/.test(r.out), r.out);

  // ---- the MCP tools (aiondx-loop.exe) ----
  const tool = spawn(EXE, [], { env: inChat(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(tool);
  let buf = '';
  const waiting = new Map();
  tool.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let rid = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++rid;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('no reply to ' + method)); }, 30000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    tool.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const tl = await rpc('tools/list', {});
  const names = ((tl.result && tl.result.tools) || []).map((t) => t.name).join(',');
  check('the MCP server offers mcp_tools and mcp_call (and the GitHub and usage tools after them)', names === 'loop_status,loop_set,priority_send,mcp_status,mcp_set,mcp_tools,mcp_call,github_status,github_create_repo,usage_status', names);
  let m = await rpc('tools/call', { name: 'mcp_call', arguments: { server: 'fix', tool: 'image' } });
  const content = (m.result && m.result.content) || [];
  check('mcp_call hands the picture back as a picture the agent can see, and the text beside it', !m.result.isError && content[0] && content[0].type === 'image' &&
    content[0].mimeType === 'image/png' && content[0].data.length > 20 && content[1] && content[1].text === 'one pixel', JSON.stringify(m.result).slice(0, 300));
  m = await rpc('tools/call', { name: 'mcp_call', arguments: { server: 'fix', tool: 'add', arguments: { a: 1, b: 2 } } });
  check('mcp_call with arguments', m.result.content[0].text === '3' && m.result.isError === false, JSON.stringify(m.result));
  m = await rpc('tools/call', { name: 'mcp_call', arguments: { server: 'fix', tool: 'fail' } });
  check("mcp_call passes on the tool's own error", m.result.isError === true && m.result.content[0].text === 'it broke', JSON.stringify(m.result));
  m = await rpc('tools/call', { name: 'mcp_tools', arguments: { server: 'web' } });
  check('mcp_tools lists a remote server\'s tools', !m.result.isError && /web \(fixture 1\.0\.0\), from the AionDX MCP file: 11 tools/.test(m.result.content[0].text), m.result.content[0].text);
  m = await rpc('tools/call', { name: 'mcp_set', arguments: { action: 'add', name: 'viatool', transport: { type: 'stdio', command: WRAP, args: ['stdio'] }, test: false, note: 'n' } });
  check('mcp_set add goes to the file by default', !m.result.isError && readFile().mcpServers.viatool && /Added viatool to the AionDX MCP file/.test(m.result.content[0].text), m.result.content[0].text);
  m = await rpc('tools/call', { name: 'mcp_status', arguments: {} });
  check('mcp_status shows the file', /The AionDX MCP file, /.test(m.result.content[0].text) && /viatool: stdio/.test(m.result.content[0].text), m.result.content[0].text);
  tool.stdin.end();

  // ---- what is left behind ----
  const log = fs.readFileSync(path.join(TMP, 'mcp', 'use.log'), 'utf8');
  check('use.log has a line per use, and no secret, token or argument', /outside AionUi call fix echo ok/.test(log) && /conv=convH call listed env ok/.test(log) &&
    /tools fix ok, 11 tools/.test(log) && /secret FIX_TOKEN/.test(log) &&
    !/abc123|good-token|from-secrets|hello world|sk-claude-secret|from-aionui/.test(log), log.split('\n').slice(-4).join(' | '));
  await sleep(1500);
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*test-mcp-fixture.js*stdio*' }).Count"],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  check('no stdio server is left running', (ps.stdout || '').trim() === '0', ps.stdout + ps.stderr);

  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n      ${x.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  finish(failed.length ? 1 : 0);
})().catch((e) => finish(1, 'SUITE ERROR: ' + (e && e.stack || e)));
