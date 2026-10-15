// quick-lag.js - how much main-thread time AionDX's own script (aionui-dx.js) takes as a chat's message list grows (headless Edge, no window).
// A synthetic list of N message rows (a tenth of them with a markdown shadow root and a file chip, as AionUi draws them) is put in the solo chat, then a
// reply is streamed into it (a row added every 25 ms for 4 s) while the CPU profiler runs; the script's own functions are totalled. Throwaway.
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9355;
const BASE = 'file:///C:/AI%20Projects/AionDX/tools/dx-harness/harness.html';
const PROFILE = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'aiondx-edge-profile-lag');
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--window-size=1100,640', `${BASE}?theme=light`], { windowsHide: true, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (c) => { try { edge.kill(); } catch (e) { /* gone */ } process.exit(c); };
setTimeout(() => done(2), 280000);
(async () => {
  let t = null;
  for (let i = 0; i < 60 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('harness.html')); } catch (e) { /* not up */ } await sleep(250); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : (r.result && r.result.exceptionDetails ? 'EXC ' + r.result.exceptionDetails.text : undefined); };
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 250 });
  const rows = [];
  for (const V of ['no-voice', 'voice-original', 'voice-fixed']) { const N = 3000;
    await send('Page.navigate', { url: `${BASE}?theme=light` });
    await sleep(1800);
    if (V === 'aiondx-off') await js("localStorage.setItem('aionui.dx.disabled', '1'); 0"); else await js("localStorage.removeItem('aionui.dx.disabled'); 0");
    await send('Page.navigate', { url: BASE + '?theme=light' }); await sleep(1800);
    await js(`(() => {
      const host = document.querySelector('#solo') || document.body;
      const list = document.createElement('div'); list.id = 'synthetic-list'; list.setAttribute('data-testid', 'message-list-content');
      const mk = (i) => { const row = document.createElement('div'); row.className = 'message-item'; row.id = 'message-' + i; row.setAttribute('data-message-type', 'text'); row.setAttribute('data-message-position', i % 2 ? 'left' : 'right');
        row.innerHTML = '<div class="msg-body"><span>row ' + i + ' of tool output and some text that wraps a little</span><svg width="12" height="12"><circle cx="6" cy="6" r="5"></circle></svg></div><div data-testid="message-text-content">reply text</div>';
        if (i % 10 === 0) { const h = document.createElement('div'); h.className = 'markdown-shadow'; const sr = h.attachShadow({ mode: 'open' });
          sr.innerHTML = '<p>text</p><span data-local-file-path="C:/work/file' + i + '.txt">file' + i + '.txt</span>'; row.appendChild(h); }
        return row; };
      window.__mk = mk;
      for (let i = 0; i < ${N}; i++) list.appendChild(mk(i));
      host.appendChild(list); if ('${V}' === 'content-visibility') { const st = document.createElement('style'); st.textContent = '#synthetic-list > .message-item{content-visibility:auto;contain-intrinsic-size:auto 44px}'; document.head.appendChild(st); } return list.childElementCount; })()`);
    if (V.startsWith('voice')) {
      const core = fs.readFileSync('C:/AI Projects/AionDX/patches/0011-voice/aiondx-voice.js', 'utf8');
      const ui = V === 'voice-original' ? execSync('git show HEAD:patches/0011-voice/aiondx-voice-ui.js', { cwd: 'C:/AI Projects/AionDX', encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }) : fs.readFileSync('C:/AI Projects/AionDX/patches/0011-voice/aiondx-voice-ui.js', 'utf8');
      await js(core); await js(ui); await sleep(500);
    }
    await sleep(2500);   // the page's own timers settle on the bigger page
    // One repaint, timed, averaged.
    const repaintMs = await js(`(() => { const t0 = performance.now(); for (let i = 0; i < 20; i++) window.__aionDx.repaint(); return (performance.now() - t0) / 20; })()`);
    // A reply streaming in: a row added every 25 ms for 4 s, profiled.
    await send('Profiler.start');
    const wall0 = Date.now();
    await js(`new Promise((res) => { const list = document.getElementById('synthetic-list'); let n = ${N}; const id = setInterval(() => { list.appendChild(window.__mk(n++)); if (n > ${N} + 160) { clearInterval(id); res(1); } }, 25); })`);
    await sleep(1500);   // and the page's own 3-second timers
    const wall = Date.now() - wall0;
    const prof = (await send('Profiler.stop')).result.profile;
    const byNode = new Map(prof.nodes.map((n) => [n.id, n]));
    const self = new Map();
    let total = 0, idle = 0;
    prof.samples.forEach((id, i) => {
      const d = prof.timeDeltas[i] || 0;
      const n = byNode.get(id);
      const name = n.callFrame.functionName || '(anonymous)';
      if (name === '(idle)') { idle += d; return; }
      total += d;
      const mine = /aionui-dx/.test(n.callFrame.url);
      const key = (mine ? 'AionDX ' : '') + name + (mine ? ':' + n.callFrame.lineNumber : '');
      self.set(key, (self.get(key) || 0) + d);
    });
    const parent = new Map(); prof.nodes.forEach((n) => (n.children || []).forEach((c) => parent.set(c, n.id)));
    const callers = new Map(); const incl = new Map();
    prof.samples.forEach((id, i) => { const d = prof.timeDeltas[i] || 0; const n = byNode.get(id); const nm = n.callFrame.functionName;
      if (/^(getClientRects|querySelectorAll|querySelector)$/.test(nm)) { let p = parent.get(id), who = '(none)'; while (p) { const pn = byNode.get(p); if (pn.callFrame.functionName && pn.callFrame.functionName !== '(anonymous)') { who = pn.callFrame.functionName + ':' + pn.callFrame.lineNumber + ' ' + (pn.callFrame.url || '').split('/').pop(); break; } p = parent.get(p); } const k = nm + ' <- ' + who; callers.set(k, (callers.get(k) || 0) + d); }
      const seen = new Set(); let q = id; while (q) { const qn = byNode.get(q); if (/aionui-dx/.test(qn.callFrame.url)) { const k = qn.callFrame.functionName + ':' + qn.callFrame.lineNumber; if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + d); } } q = parent.get(q); } });
    console.log('natives by caller:', JSON.stringify([...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + (v / 1000).toFixed(0) + 'ms')));
    console.log('AionDX inclusive:', JSON.stringify([...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + (v / 1000).toFixed(0) + 'ms')));
    const mineTotal = [...self.entries()].filter(([k]) => k.startsWith('AionDX ')).reduce((a, [, v]) => a + v, 0);
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)}ms`);
    let voiceInfo = '';
    if (V.startsWith('voice')) {
      const before = await js(`document.querySelectorAll('.aiondx-voice-play').length`);
      await js(`document.getElementById('message-11').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
      const after = await js(`document.querySelectorAll('.aiondx-voice-play').length`);
      voiceInfo = ' speaker buttons: ' + before + ', after hovering an older reply: ' + after;
    }
    if (voiceInfo) console.log(V + voiceInfo);
    rows.push({ N, dom: await js('document.getElementsByTagName("*").length'), repaintMs: Math.round(repaintMs * 100) / 100, busyPct: Math.round((total / 1000) / wall * 100), aiondxMs: Math.round(mineTotal / 1000), top });
    console.log(V, JSON.stringify(rows[rows.length - 1]));
  }
  done(0);
})();
