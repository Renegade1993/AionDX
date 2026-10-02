#!/usr/bin/env node
/**
 * test-live-update.js - self-update in the real app, against a stand-in for GitHub and a fake installer (nothing of the installed
 * AionDX is touched, and the real GitHub is not asked). The staged app runs in a throwaway profile (tools\live-app.js) with
 *   AIONDX_RELEASES_URL        a local server that answers like the releases API of github.com/Renegade1993/AionDX
 *   AIONDX_DOWNLOADS_DIR       a throwaway Downloads folder
 *   AIONDX_UPDATE_FIRST_MS     the first automatic check shortly after start, not 30
 *
 *   node tools\test-live-update.js [--stage DIR]
 *
 * Checks: the app finds the newest release by itself and opens the update card for it; About > Check for updates finds the
 * same one; the install bridge refuses a file that is not in the Downloads folder, a name that is not an AionDX installer, and an
 * installer whose SHA-256 is not the one the release publishes; and it runs a good one silently with /UPDATE=yes and closes the app.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { launch, sleep } = require('./live-app');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-update-test-'));
const downloads = path.join(work, 'Downloads');
fs.mkdirSync(downloads);
const argsFile = path.join(os.tmpdir(), 'aiondx-fake-installer-args.txt');
try { fs.unlinkSync(argsFile); } catch (e) { /* none yet */ }

// A fake installer: records its command line and exits.
const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
fs.writeFileSync(path.join(work, 'fake.cs'), 'using System; using System.IO;\nclass P { static int Main(string[] a) { File.WriteAllText(Path.Combine(Path.GetTempPath(), "aiondx-fake-installer-args.txt"), string.Join(" ", a)); return 0; } }\n');
const built = spawnSync(csc, ['/nologo', '/target:exe', '/out:' + path.join(work, 'AionDX-0.99.0-setup.exe'), path.join(work, 'fake.cs')], { encoding: 'utf8', windowsHide: true });
if (built.status !== 0) { console.log('could not build the fake installer: ' + built.stdout + built.stderr); process.exit(2); }
const goodBytes = fs.readFileSync(path.join(work, 'AionDX-0.99.0-setup.exe'));
const sha = crypto.createHash('sha256').update(goodBytes).digest('hex');

let hits = 0;
const server = http.createServer((req, res) => {
  const base = 'http://127.0.0.1:' + server.address().port;
  if (req.url === '/releases') {
    hits++;
    const rel = (tag, ver, name) => ({ tag_name: tag, name, draft: false, prerelease: true, body: 'Notes for ' + ver, html_url: base + '/rel/' + tag, published_at: '2026-10-02T12:00:00Z',
      assets: [{ name: 'AionDX-' + ver + '-setup.exe', browser_download_url: base + '/dl/AionDX-' + ver + '-setup.exe', size: goodBytes.length, content_type: 'application/octet-stream' },
        { name: 'SHA256SUMS.txt', browser_download_url: base + '/dl/SHA256SUMS.txt' }] });
    const draft = rel('v1.5.0-beta', '1.5.0', 'a draft'); draft.draft = true;
    const noInstaller = { tag_name: 'v2.0.0', name: 'notes only', draft: false, prerelease: false, body: '', html_url: base, published_at: '2026-10-03T12:00:00Z', assets: [{ name: 'source.zip', browser_download_url: base + '/x' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([noInstaller, draft, rel('v0.99.0-beta', '0.99.0', 'AionDX beta v.99'), rel('v0.1.0-beta', '0.1.0', 'old')]));
  } else if (req.url === '/dl/SHA256SUMS.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(sha + '  AionDX-0.99.0-setup.exe\r\n');
  } else { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const app = await launch({ port: 9559, deadlineMs: 300000, stage: arg('--stage') || undefined,
    env: { AIONDX_RELEASES_URL: base + '/releases', AIONDX_DOWNLOADS_DIR: downloads, AIONDX_NO_UPDATE_CHECK: '0', AIONDX_UPDATE_FIRST_MS: '15000' } });
  try {
    for (let i = 0; i < 90; i++) { const st = await app.js('({ dx: !!window.__aionDx, port: window.__backendPort || null })'); if (st && st.dx && st.port) break; await sleep(1000); }
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop{display:none !important}'; document.head.appendChild(s); return 0; })()`);
    const text = () => app.js('document.body.innerText');

    // 1. the automatic check
    let card = '';
    for (let i = 0; i < 40 && !/0\.99\.0/.test(card); i++) { await sleep(1000); card = String(await text()); }
    check('the app asked the release list by itself, shortly after start', hits >= 1, 'asked ' + hits + ' time(s)');
    check('it found the newest release that has an installer (0.99.0: not the draft 1.5.0, not the release with no installer 2.0.0)', /0\.99\.0/.test(card) && !/1\.5\.0|2\.0\.0/.test(card), card.slice(-300));
    check('and opened the update card for it, with the current version', /0\.\d+\.\d+/.test(card));

    // 2. About > Check for updates finds the same
    await app.js(`location.hash = '#/settings/about'; 0`);
    await sleep(2000);
    const before = hits;
    await app.js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /check for updates/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
    await sleep(4000);
    check('About > Check for updates asks the release list again', hits > before, hits + ' vs ' + before);

    // 3. the install bridge
    const install = (file) => app.js(`window.aiondxUpdate ? window.aiondxUpdate.install(${JSON.stringify(file)}) : { ok: false, error: 'no bridge' }`);
    check('the page has the install bridge', await app.js('!!(window.aiondxUpdate && window.aiondxUpdate.install)'));
    const elsewhere = path.join(work, 'AionDX-0.99.0-setup.exe');
    let r = await install(elsewhere);
    check('a file that is not in the Downloads folder is refused', r && r.ok === false && /Downloads folder/.test(r.error), JSON.stringify(r));
    fs.writeFileSync(path.join(downloads, 'notes.exe'), goodBytes);
    r = await install(path.join(downloads, 'notes.exe'));
    check('a file that is not named like an AionDX installer is refused', r && r.ok === false && /not an AionDX installer/.test(r.error), JSON.stringify(r));
    const tampered = Buffer.concat([goodBytes, Buffer.from('x')]);
    fs.writeFileSync(path.join(downloads, 'AionDX-0.99.0-setup.exe'), tampered);
    r = await install(path.join(downloads, 'AionDX-0.99.0-setup.exe'));
    check('an installer whose SHA-256 is not the published one is refused, and not run', r && r.ok === false && /does not match/.test(r.error) && !fs.existsSync(argsFile), JSON.stringify(r));
    fs.writeFileSync(path.join(downloads, 'AionDX-0.99.0-setup.exe'), goodBytes);
    r = await install(path.join(downloads, 'AionDX-0.99.0-setup.exe'));
    check('the published one is accepted', r && r.ok === true, JSON.stringify(r));
    let args = '';
    for (let i = 0; i < 20 && !args; i++) { await sleep(500); try { args = fs.readFileSync(argsFile, 'utf8'); } catch (e) { /* not yet */ } }
    check('and run silently, closing other copies, with /UPDATE=yes', /\/VERYSILENT/.test(args) && /\/SUPPRESSMSGBOXES/.test(args) && /\/NORESTART/.test(args) && /\/CLOSEAPPLICATIONS/.test(args) && /\/UPDATE=yes/.test(args), args);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) { await sleep(1000); gone = !(await fetch('http://127.0.0.1:9559/json').then((x) => x.ok, () => false)); }
    check('and the app closes itself so the installer can replace it', gone);
  } finally {
    await app.close();
    server.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    try { fs.unlinkSync(argsFile); } catch (e) { /* none */ }
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.stack || e); process.exit(2); });
