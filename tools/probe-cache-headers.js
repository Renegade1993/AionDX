#!/usr/bin/env node
// probe-cache-headers.js [model] [configDir] [tokenFile] - runs one small Claude Code turn that starts a subagent, through a loopback
// forwarder like AionDX's usage tap, and prints for each /v1/messages call: Claude Code's x-claude-code-* request headers (never the
// token), and the usage of the answer's message_start event (cache read, 1-hour and 5-minute cache writes). Shows how the tap can tell
// the main conversation's calls from subagent and helper calls, and that the answer itself says how long its cache lasts.
// Deadline 4 minutes. Signs in as an AionDX chat does (config folder + token file).
'use strict';
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [model = 'haiku', dir = path.join(os.homedir(), '.claude'), tokenFile = path.join(os.homedir(), '.claude', 'personal-token.txt')] = process.argv.slice(2);
setTimeout(() => { console.log('deadline'); process.exit(4); }, 4 * 60000).unref();

const calls = [];
const server = http.createServer((req, res) => {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!['connection', 'keep-alive'].includes(k)) headers[k] = v;
  headers.host = 'api.anthropic.com';
  const row = { path: req.url.split('?')[0], at: new Date().toISOString(), hdr: {} };
  for (const [k, v] of Object.entries(req.headers)) if (/^x-claude-code-|^x-app$/i.test(k) && !/credential|signature/i.test(k)) row.hdr[k] = v;
  const pr = https.request({ host: 'api.anthropic.com', port: 443, method: req.method, path: req.url, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    let first = '';
    const enc = String(ur.headers['content-encoding'] || '');
    const dec = enc === 'gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress() : enc === 'deflate' ? zlib.createInflate() : null;
    if (dec) { dec.on('error', () => {}); ur.on('data', (c) => dec.write(c)); ur.on('end', () => dec.end()); }
    row.enc = enc;
    (dec || ur).on('data', (c) => {
      if (first.length < 8192) {
        first += c.toString('utf8');
        const m = /event: message_start\r?\ndata: (\{.*\})/.exec(first);
        if (m && !row.usage) { try { const u = JSON.parse(m[1]).message.usage; row.model = JSON.parse(m[1]).message.model; row.usage = u; } catch (e) { /* partial */ } }
      }
    });
    ur.on('data', (c) => res.write(c));
    ur.on('end', () => { res.end(); row.status = ur.statusCode; if (/\/v1\/messages/.test(row.path)) calls.push(row); });
  });
  pr.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  req.pipe(pr);
});
server.listen(0, '127.0.0.1', () => {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^AIONDX_|^CLAUDE_CODE_ENTRYPOINT$|^CLAUDECODE$|^ANTHROPIC_|^CLAUDE_CONFIG_DIR$|^CLAUDE_CODE_OAUTH_TOKEN$/i.test(k)) delete env[k];
  env.CLAUDE_CONFIG_DIR = dir;
  env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + server.address().port;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-probe-cache-'));
  const prompt = 'Use the Agent tool once to start a general-purpose subagent whose whole task is to reply with the word OK. Then reply with only the word DONE.';
  const child = spawn(path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    ['-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', '4', '--allowedTools', 'Agent,Task'],
    { env, cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.on('close', (code) => {
    server.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* in use */ }
    let cost = '?';
    try { cost = JSON.parse(out).total_cost_usd; } catch (e) { /* not json */ }
    console.log('claude exit ' + code + ', cost $' + cost + ', calls ' + calls.length);
    for (const c of calls) {
      const u = c.usage || {}, cc = u.cache_creation || {};
      console.log(c.at.slice(11, 19), c.status, c.enc || 'plain', c.model || '-', JSON.stringify(c.hdr),
        'read', u.cache_read_input_tokens, 'w1h', cc.ephemeral_1h_input_tokens, 'w5m', cc.ephemeral_5m_input_tokens, 'in', u.input_tokens);
    }
  });
});
