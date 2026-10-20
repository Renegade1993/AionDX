#!/usr/bin/env node
/**
 * probe-eval.js - load the harness headless, then run the lines of a script file one by one and print what each returns, with the page's console
 * messages and uncaught exceptions. For finding out why one click-suite check fails, without running the whole suite.
 *
 *   node tools\dx-harness\probe-eval.js <query> <file>     e.g. theme=light steps.txt
 *
 * Each line of the file is an expression run in the page; "sleep 500" waits; "load <query>" navigates again; blank lines and lines starting with # are skipped.
 * Hard 90 s deadline; Edge is killed on every exit path; it runs headless, so nothing appears on screen.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const BASE = 'file:///C:/AI%20Projects/AionDX/tools/dx-harness/harness.html';
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-edge-profile-probe-eval');
const query = process.argv[2] || 'theme=light';
const lines = fs.readFileSync(process.argv[3], 'utf8').split(/\r?\n/);

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--window-size=1100,640', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
function finish(code) { try { edge.kill(); } catch (e) { /* gone */ } process.exit(code); }
setTimeout(() => { console.log('DEADLINE'); finish(2); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page'); } catch (e) { /* not up */ }
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; console.log('EXCEPTION', d.text, d.exception && d.exception.description, 'line', d.lineNumber); }
    if (m.method === 'Runtime.consoleAPICalled') console.log('CONSOLE.' + m.params.type, m.params.args.map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ').slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${BASE}?${query}` });
  await sleep(1800);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = /^sleep (\d+)$/.exec(line))) { await sleep(Number(m[1])); continue; }
    if ((m = /^load (.*)$/.exec(line))) { await send('Page.navigate', { url: `${BASE}?${m[1]}` }); await sleep(1800); continue; }
    const r = await send('Runtime.evaluate', { expression: line, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) console.log('> ' + line.slice(0, 90), '=> EXCEPTION', r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    else console.log('> ' + line.slice(0, 90), '=>', JSON.stringify(r.result && r.result.result ? r.result.result.value : undefined));
  }
  finish(0);
})().catch((e) => { console.log('ERROR', e.message); finish(1); });
