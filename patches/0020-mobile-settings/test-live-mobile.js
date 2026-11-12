#!/usr/bin/env node
/**
 * test-live-mobile.js - patch 0020 (Settings > Mobile) in a real app with a bridge-capable AionCore, through tools\live-app.js:
 * a throwaway profile, made-up APPDATA/LOCALAPPDATA/cache/work/log folders, AIONUI_E2E_TEST=1, AIONDX_NO_ACTIVATE=1.
 * The patch's two scripts are evaluated into the page (the stage need not be rebuilt). A phone is played by QA's phone client
 * (pair.js, CONTRACT §4 crypto): it scans the QR's URI, sends a pairing request, and the PC side is driven only through the UI.
 * The firewall route (phase 5) and the elevate runner are stubbed in the page: nothing here ever adds or removes a rule.
 *
 *   STAGE=<folder holding AionDX.exe> PAIR_JS=<qa-k1-bridge\pair.js> SHOTS=<folder> node test-live-mobile.js
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const HERE = __dirname;
const REPO = path.join(HERE, '..', '..');
const BASE = process.env.AIONDX_BASE || path.join(REPO, '..');
const STAGE = process.env.STAGE || path.join(BASE, 'qa-k1-bridge', 'stage-prod', 'AionDX');
const PAIR_JS = process.env.PAIR_JS || path.join(BASE, 'qa-k1-bridge', 'pair.js');
const SHOTS = process.env.SHOTS || path.join(BASE, 'mobile-ui-shots');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-mobile-ui-'));
const { launch, sleep } = require(path.join(BASE, 'AionDX', 'tools', 'live-app.js'));

// The phone side: QA's pair.js helpers, exported from a copy made for this run (their file is not changed).
const phoneLib = path.join(WORK, 'phone-lib.js');
fs.writeFileSync(phoneLib, fs.readFileSync(PAIR_JS, 'utf8').replace(/path\.join\(__dirname, '\.\.', 'AionDX-impl'/g, "path.join(" + JSON.stringify(path.dirname(PAIR_JS)) + ", '..', 'AionDX-impl'") +
  '\nmodule.exports.lib = { kPairOf, sasOf, xseal, xopen, x25519Key, b64u, unb64u, utf8 };\n');
const { kPairOf, sasOf, xseal, xopen, x25519Key, b64u, unb64u, utf8 } = require(phoneLib).lib;

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function phone(uri, bport, deviceName) {
  const q = new URLSearchParams(uri.split('?')[1]);
  const hostId = q.get('id'), ShPub = unb64u(q.get('pk')), secret = unb64u(q.get('s'));
  const Sc = x25519Key(crypto.randomBytes(32)), deviceId = b64u(crypto.randomBytes(16));
  const kPair = kPairOf(Sc, ShPub, secret);
  const send = async (wait) => {
    const nonce = crypto.randomBytes(24), ts = Date.now();
    const req = { deviceName, platform: 'android', appVersion: '0.0.0-ui-test', ts, confirmMode: 'biometric', wait };
    const ct = xseal(kPair, nonce, utf8(JSON.stringify(req)), utf8('aiondx/v1/pair-req|' + hostId + '|' + deviceId));
    const r = await fetch('http://127.0.0.1:' + bport + '/api/mobile/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(40000),
      body: JSON.stringify({ v: 1, hostId, deviceId, devicePk: b64u(Sc.pub), nonce: b64u(nonce), ct: b64u(ct) }) });
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || !j || !j.ct) return { status: r.status, res: null };
    return { status: 200, res: JSON.parse(xopen(kPair, unb64u(j.nonce), unb64u(j.ct), utf8('aiondx/v1/pair-res|' + hostId + '|' + deviceId)).toString('utf8')) };
  };
  return { deviceId, sas: sasOf(kPair), send };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const FAKE = path.join(WORK, 'fake');
  for (const d of ['Roaming', 'Local', 'cache', 'work', 'logs']) fs.mkdirSync(path.join(FAKE, d), { recursive: true });
  const env = { APPDATA: path.join(FAKE, 'Roaming'), LOCALAPPDATA: path.join(FAKE, 'Local'), AIONUI_E2E_TEST: '1', AIONDX_NO_ACTIVATE: '1',
    AIONDX_CACHE_DIR: path.join(FAKE, 'cache'), AIONDX_WORK_DIR: path.join(FAKE, 'work'), AIONDX_LOG_DIR: path.join(FAKE, 'logs'),
    AIONDX_MOBILE_BIND: '127.0.0.1' };   // the bridge listens on loopback only: nothing on the LAN during the test
  const app = await launch({ stage: STAGE, port: 9572, profile: path.join(WORK, 'profile'), env, deadlineMs: 600000 });
  const shot = async (name) => {
    const r = await app.send('Page.captureScreenshot', { format: 'png' });
    const data = (r.result || r).data;
    if (data) fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  const q = (sel, expr) => app.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? (${expr || 'true'}) : null; })()`);
  const click = (sel) => app.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const waitFor = async (expr, tries = 60, ms = 250) => { for (let i = 0; i < tries; i++) { if (await app.js(expr)) return true; await sleep(ms); } return false; };
  const admin = (m, p, b) => app.js(`fetch('http://127.0.0.1:' + window.__backendPort + ${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': window.__coreCsrfToken }, body: ${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))} })
    .then(async (r) => { const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, data: j && j.data !== undefined ? j.data : j }; })`);
  try {
    if (!(await waitFor('!!(window.__coreCsrfToken && window.__backendPort)', 240, 500))) throw new Error('the core session never became ready');
    await sleep(3000);
    await app.js(`(() => { const b = [...document.querySelectorAll('button,a,span')].find((e) => e.textContent.trim() === 'Not now'); if (b) b.click(); return 0; })()`);   // the welcome dialog
    // Stubs (installed again after a reload): the firewall route and the main-process handler. The real status route is wrapped
    // only to add a recovery notice for one step, the real re-key route only to force a "failed" for one step.
    const setup = async () => {
    await app.js(`(() => {
      window.__fw = { rule: 'absent', plan: { program: 'C:\\\\Windows\\\\System32\\\\netsh.exe', args: ['advfirewall', 'firewall', 'add', 'rule', 'name=AionDX mobile bridge', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=47734', 'profile=private', 'program=C:\\\\Program Files\\\\AionDX\\\\aioncore.exe', 'enable=yes'] } };
      window.__fakeRecovery = null; window.__elevateCalls = [];
      const of = window.fetch;
      window.fetch = function (u, o) {
        const s = String(u);
        if (window.__rekeyOverride && /\\/api\\/mobile\\/admin\\/rekey-offers\\/[^/]+$/.test(s)) return Promise.resolve(new Response(JSON.stringify({ success: true, data: { state: window.__rekeyOverride } }), { status: 200 }));
        if (/\\/api\\/mobile\\/admin\\/firewall$/.test(s)) return Promise.resolve(new Response(JSON.stringify({ success: true, data: window.__fw }), { status: 200 }));
        if ((window.__fakeRecovery || window.__fakeStatus) && /\\/api\\/mobile\\/admin\\/(status|settings)$/.test(s)) return of.apply(this, arguments).then(async (r) => { const j = await r.json();
          if (window.__fakeRecovery) j.data.lastRecovery = window.__fakeRecovery; if (window.__fakeStatus) Object.assign(j.data, window.__fakeStatus); return new Response(JSON.stringify(j), { status: 200 }); });
        if (window.__fakeRecovery && /\\/api\\/mobile\\/admin\\/recovery\\/dismiss$/.test(s)) window.__fakeRecovery = null;
        return of.apply(this, arguments);
      };
      // What patch 0020's preload exposes (main process handler stubbed: it never reaches elevate.exe or netsh here).
      window.__fwAnswer = { ok: true };
      // In a BUILT app this assignment fails silently (contextBridge's object cannot be replaced) and the real main handler would
      // be reached: __aiondxTestStub marks the stub, and every firewall click below is skipped unless it is really in place.
      window.aiondxMobile = {
        __aiondxTestStub: true,
        allowFirewall: function (port) { window.__elevateCalls.push({ action: 'allow', port, argc: arguments.length }); if (window.__fwAnswer.ok) window.__fw = { rule: 'present', plan: null }; return Promise.resolve(window.__fwAnswer); },
        removeFirewall: () => { window.__elevateCalls.push({ action: 'remove' }); window.__fw = { rule: 'absent', plan: window.__fwPlan }; return Promise.resolve({ ok: true }); },
      };
      window.__fwPlan = window.__fw.plan;
      return 0; })()`);
    for (const f of ['qrcodegen.js', 'aiondx-mobile-settings.js']) await app.js(fs.readFileSync(path.join(HERE, f), 'utf8') + '\n;0');
    };
    await setup();

    // ---- the sidebar entry and the card ----
    await app.js(`location.hash = '#/settings/agent'; 0`);
    check('Settings has a "Mobile" item in the sidebar, after Remote', await waitFor(`(() => { const m = document.querySelector('[data-settings-id="aiondx-mobile"]'); return !!m && m.previousElementSibling && m.previousElementSibling.getAttribute('data-settings-id') === 'webui' && /Mobile/.test(m.textContent); })()`, 40));
    await click('[data-settings-id="aiondx-mobile"]');
    check('it opens the Mobile card', await waitFor(`location.hash.indexOf('#/settings/webui') === 0 && !!document.getElementById('aiondx-mobile')`, 40));
    check('phone access starts off', await waitFor(`/Off\\./.test(document.querySelector('[data-testid="aiondx-mobile-status"]').textContent)`, 40) && (await q('[data-testid="aiondx-mobile-pair"]', 'e.disabled')) === true);
    await shot('1-off');

    // ---- advanced: a free loopback-chosen port, then turn it on ----
    const bport = await freePort();
    await app.js(`(() => { document.querySelector('.aiondx-mobile-adv').open = true; const p = document.querySelector('[data-testid="aiondx-mobile-port"]'); p.value = '${bport}';
      document.querySelector('[data-testid="aiondx-mobile-hostname"]').value = 'UI Test PC';
      document.querySelector('[data-testid="aiondx-mobile-extraurls"]').value = 'http://100.64.1.2:47734\\nhttp://my-pc.tail1234.ts.net:47734'; return 0; })()`);
    await click('[data-testid="aiondx-mobile-save"]');
    check('advanced settings save (port, PC name)', await waitFor(`(window.__aionDxMobile.state().status || {}).port === ${bport} && (window.__aionDxMobile.state().status || {}).hostName === 'UI Test PC'`, 40),
      JSON.stringify(await app.js('window.__aionDxMobile.state().status')));
    await click('[data-testid="aiondx-mobile-enable"]');
    check('the toggle turns it on, and it listens', await waitFor(`/Listening on port ${bport}/.test(document.querySelector('[data-testid="aiondx-mobile-status"]').textContent)`, 60),
      await q('[data-testid="aiondx-mobile-status"]', 'e.textContent'));
    check('"Pair a phone" is enabled once it listens', (await q('[data-testid="aiondx-mobile-pair"]', 'e.disabled')) === false);
    check('the subtitle says it is on', (await q('[data-testid="aiondx-mobile-enable-hint"]', 'e.textContent')) === "On. Phones you've paired can connect.",
      await q('[data-testid="aiondx-mobile-enable-hint"]', 'e.textContent'));
    await shot('2-on');

    // ---- pairing: QR, then the SAS, then "The codes match" ----
    await click('[data-testid="aiondx-mobile-pair"]');
    check('pairing shows a QR code for an aiondx://pair URI', await waitFor(`/^aiondx:\\/\\/pair\\?/.test((document.querySelector('.aiondx-mobile-qr') || {}).getAttribute && document.querySelector('.aiondx-mobile-qr').getAttribute('data-uri') || '')`, 40));
    check('with a countdown', /Expires in [45]:\d\d/.test(await q('.aiondx-mobile-countdown', 'e.textContent')), await q('.aiondx-mobile-countdown', 'e.textContent'));
    await shot('3-qr');
    const uri = await q('.aiondx-mobile-qr', `e.getAttribute('data-uri')`);
    const ph = phone(uri, bport, '<b>Test</b> Phone');
    const p1 = await ph.send(false);
    check('the phone sends its pairing request (pending)', p1.status === 200 && p1.res && p1.res.status === 'pending', JSON.stringify(p1));
    check('the dialog switches to the SAS step', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-pairing"]') && document.querySelector('[data-testid="aiondx-mobile-pairing"]').getAttribute('data-state') === 'request_received'`, 40));
    const shownSas = await q('[data-testid="aiondx-mobile-sas"]', 'e.textContent');
    check('the PC shows the same SAS the phone computed, large', shownSas === ph.sas && (await q('[data-testid="aiondx-mobile-sas"]', 'parseFloat(getComputedStyle(e).fontSize)')) >= 32, shownSas + ' vs ' + ph.sas);
    check("the phone's name is shown as text, not markup", (await app.js(`(() => { const p = document.querySelector('[data-testid="aiondx-mobile-pairing"]'); return /<b>Test<\\/b> Phone/.test(p.textContent) && !p.querySelector('b'); })()`)) === true);
    await shot('4-sas');
    const longPoll = ph.send(true);
    await sleep(800);
    await click('[data-testid="aiondx-mobile-sas-match"]');
    const p2 = await longPoll;
    check('"The codes match" approves: the phone gets approved and a confirm key', p2.status === 200 && p2.res && p2.res.status === 'approved' && !!p2.res.confirmKey, JSON.stringify(p2.res && { status: p2.res.status, hostName: p2.res.hostName }));
    check('the dialog closes and the phone appears in the list', await waitFor(`!document.querySelector('[data-testid="aiondx-mobile-pairing"]') && [...document.querySelectorAll('[data-testid="aiondx-mobile-device"]')].some((r) => r.getAttribute('data-device-id') === ${JSON.stringify(ph.deviceId)})`, 40));
    check('its row shows the name (as text), platform and app version', (await app.js(`(() => { const r = document.querySelector('[data-device-id=${JSON.stringify(ph.deviceId)}]'); return r.querySelector('input').value === '<b>Test</b> Phone' && /android/.test(r.textContent) && /0\\.0\\.0-ui-test/.test(r.textContent) && /Last seen/.test(r.textContent); })()`)) === true);
    await shot('5-devices');

    // ---- "They don't match" ----
    await click('[data-testid="aiondx-mobile-pair"]');
    await waitFor(`!!document.querySelector('.aiondx-mobile-qr')`, 40);
    const uri2 = await q('.aiondx-mobile-qr', `e.getAttribute('data-uri')`);
    const offer2 = await q('[data-testid="aiondx-mobile-pairing"]', `e.getAttribute('data-offer-id')`);
    const ph2 = phone(uri2, bport, 'Intruder');
    await ph2.send(false);
    await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-sas-mismatch"]')`, 40);
    await click('[data-testid="aiondx-mobile-sas-mismatch"]');
    check('"They don\'t match" rejects the offer and offers "Try again"', await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-pair-again"]')`, 40) &&
      ((await admin('GET', '/api/mobile/admin/pairing-offers/' + offer2)).data || {}).state === 'rejected');
    await shot('6-mismatch');
    const devs = (await admin('GET', '/api/mobile/admin/devices')).data || [];
    check('and nothing was paired', !devs.some((d) => d.deviceId === ph2.deviceId) && devs.length === 1, devs.length + ' devices');
    // "Try again", then close while waiting: the offer is rejected
    await click('[data-testid="aiondx-mobile-pair-again"]');
    await waitFor(`!!document.querySelector('.aiondx-mobile-qr') && !!document.querySelector('[data-testid="aiondx-mobile-pairing"]').getAttribute('data-offer-id')`, 40);
    const offer3 = await q('[data-testid="aiondx-mobile-pairing"]', `e.getAttribute('data-offer-id')`);
    await click('[data-testid="aiondx-mobile-pair-cancel"]');
    await sleep(800);
    check('closing the dialog while waiting rejects the offer', ((await admin('GET', '/api/mobile/admin/pairing-offers/' + offer3)).data || {}).state === 'rejected');

    // ---- rename, the confirm switch, re-key ----
    await app.js(`(() => { const i = document.querySelector('[data-device-id=${JSON.stringify(ph.deviceId)}] input'); i.focus(); i.value = 'Pixel test'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 0; })()`);
    check('renaming saves the new name', await waitFor(`(window.__aionDxMobile.state().devices || []).some((d) => d.deviceId === ${JSON.stringify(ph.deviceId)} && d.name === 'Pixel test')`, 40));
    const before = ((await admin('GET', '/api/mobile/admin/devices')).data || []).find((d) => d.deviceId === ph.deviceId).requireConfirm;
    await click(`[data-device-id=${JSON.stringify(ph.deviceId)}] [data-testid="aiondx-mobile-device-confirm"]`);
    check('the "confirm sensitive actions" switch saves', await waitFor(`(window.__aionDxMobile.state().devices || []).some((d) => d.deviceId === ${JSON.stringify(ph.deviceId)} && d.requireConfirm === ${!before})`, 40), 'was ' + before);
    await click(`[data-device-id=${JSON.stringify(ph.deviceId)}] [data-testid="aiondx-mobile-device-rekey"]`);
    check('"Reset confirmation key" shows a QR for an aiondx://rekey URI, with no SAS step', await waitFor(`/^aiondx:\\/\\/rekey\\?/.test((document.querySelector('[data-testid="aiondx-mobile-rekey"] .aiondx-mobile-qr') || { getAttribute: () => '' }).getAttribute('data-uri') || '') && !document.querySelector('[data-testid="aiondx-mobile-sas"]')`, 40));
    await shot('7-rekey');
    await app.js(`(() => { [...document.querySelectorAll('[data-testid="aiondx-mobile-rekey"] button')].find((b) => b.textContent === 'Done').click(); return 0; })()`);

    // ---- re-key end to end: a phone with a session (QA's pair.js, paired through the admin route), the dialog opened in the UI,
    // the phone sends confirm-key with the proof from the QR's secret (CONTRACT §5.3), and the dialog closes by itself ----
    const S = async (m, p, b) => { const r = await admin(m, p, b); return { status: r.status, text: JSON.stringify(r.data), json: r.data, data: r.data }; };
    const qa = require(PAIR_JS);
    const sp = await qa({ S, bport, rec: () => {}, sleep, hello: { text: '' } });
    check('(setup) a second phone with an open session, from QA\'s client', !!(sp && sp.rpc && sp.sk && sp.deviceId), sp && Object.keys(sp).join(','));
    await app.js('window.__aionDxMobile.refresh()');
    await waitFor(`!!document.querySelector('[data-device-id=${JSON.stringify(sp.deviceId)}]')`, 40);
    await click(`[data-device-id=${JSON.stringify(sp.deviceId)}] [data-testid="aiondx-mobile-device-rekey"]`);
    await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-rekey"] .aiondx-mobile-qr')`, 40);
    const rkUri = await q('[data-testid="aiondx-mobile-rekey"] .aiondx-mobile-qr', `e.getAttribute('data-uri')`);
    const rkSecret = Buffer.from(new URLSearchParams(rkUri.split('?')[1]).get('s') || '', 'base64url');
    await sleep(1500);
    check('the re-key dialog waits while the phone has not finished', (await q('[data-testid="aiondx-mobile-rekey"]', `e.getAttribute('data-state')`)) === 'pending');
    const ck = await sp.rpc('POST', '/v1/host/device/confirm-key', { proof: qa.rekeyProof(rkSecret, sp.sk.sid, sp.deviceId), confirmMode: 'biometric' });
    check('(the phone re-keys: a new confirm key)', ck.status === 200 && ck.body && ck.body.confirmKey, ck.status + ' ' + JSON.stringify(ck.body).slice(0, 120));
    check('the dialog closes by itself once the bridge says completed, with a short note', await waitFor(`!document.querySelector('[data-testid="aiondx-mobile-rekey"]') && /Confirmation key reset for "Test-Phone|Confirmation key reset for/.test((document.querySelector('[data-testid="aiondx-mobile-note"]') || {}).textContent || '') && !document.querySelector('[data-testid="aiondx-mobile-note"]').hidden`, 40),
      await q('[data-testid="aiondx-mobile-note"]', 'e.textContent'));
    await shot('7b-rekey-done');
    // A failed re-key (forced for this step: a real one needs a phone that gets the proof wrong at the right moment).
    await click(`[data-device-id=${JSON.stringify(sp.deviceId)}] [data-testid="aiondx-mobile-device-rekey"]`);
    await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-rekey"] .aiondx-mobile-qr')`, 40);
    await app.js(`window.__rekeyOverride = 'failed'; 0`);
    check('a failed re-key shows a clear message and keeps the dialog open', await waitFor(`(() => { const d = document.querySelector('[data-testid="aiondx-mobile-rekey"]'); const m = document.querySelector('[data-testid="aiondx-mobile-rekey-message"]'); return !!d && d.getAttribute('data-state') === 'failed' && !!m && !m.hidden && /could not reset its key/.test(m.textContent); })()`, 20));
    await shot('7c-rekey-failed');
    await app.js(`window.__rekeyOverride = null; [...document.querySelectorAll('[data-testid="aiondx-mobile-rekey"] button')].find((b) => b.textContent === 'Done').click(); 0`);
    check('"Done" still closes it by hand', await waitFor(`!document.querySelector('[data-testid="aiondx-mobile-rekey"]')`, 20));
    await admin('DELETE', '/api/mobile/admin/devices/' + encodeURIComponent(sp.deviceId));
    await app.js('window.__aionDxMobile.refresh()');

    // ---- firewall row (stubbed route and runner) ----
    await app.js('window.__aionDxMobile.refresh()');
    check('the firewall row shows the rule is absent, with the allow button', await waitFor(`(document.querySelector('[data-testid="aiondx-mobile-firewall-state"]') || {}).getAttribute && document.querySelector('[data-testid="aiondx-mobile-firewall-state"]').getAttribute('data-rule') === 'absent' && !!document.querySelector('[data-testid="aiondx-mobile-firewall-allow"]')`, 40));
    await shot('8-firewall');
    // Only with the stub really in place: on a built app window.aiondxMobile is contextBridge's, the stub assignment and the
    // delete below fail silently, and a click would reach the real main handler (which refuses in test mode, but never rely on that).
    const stubOk = (await app.js(`(() => { const m = window.aiondxMobile; const d = Object.getOwnPropertyDescriptor(window, 'aiondxMobile');
      return !!m && m.__aiondxTestStub === true && !!d && d.writable === true && d.configurable === true; })()`)) === true;
    if (!stubOk) {
      console.log('SKIP  firewall clicks: window.aiondxMobile is not this test\'s stub (a built app\'s contextBridge object?) - no Allow/Remove click is made');
    } else {
    // A refusal from main (e.g. the UAC prompt cancelled) is shown, and the rule stays absent.
    await app.js(`window.__fwAnswer = { ok: false, error: 'Windows did not add the rule (the permission prompt may have been cancelled)' }; 0`);
    await click('[data-testid="aiondx-mobile-firewall-allow"]');
    check('a not-ok answer from the main process is shown in plain words', await waitFor(`/The firewall rule was not added: Windows did not add the rule/.test(document.querySelector('[data-testid="aiondx-mobile-error"]').textContent)`, 20),
      await q('[data-testid="aiondx-mobile-error"]', 'e.textContent'));
    await app.js(`window.__fwAnswer = { ok: true }; 0`);
    await click('[data-testid="aiondx-mobile-firewall-allow"]');
    const calls = await app.js('window.__elevateCalls');
    check('the button asks the main process with the port and nothing else', calls.length === 2 && calls.every((c) => c.action === 'allow' && c.port === bport && c.argc === 1), JSON.stringify(calls));
    check('and the row then shows the rule present, with "Remove the rule"', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-firewall-state"]').getAttribute('data-rule') === 'present' && !!document.querySelector('[data-testid="aiondx-mobile-firewall-remove"]')`, 60));
    await click('[data-testid="aiondx-mobile-firewall-remove"]');
    check('"Remove the rule" asks the main process to remove it', await waitFor(`window.__elevateCalls.some((c) => c.action === 'remove') && document.querySelector('[data-testid="aiondx-mobile-firewall-state"]').getAttribute('data-rule') === 'absent'`, 60));
    await app.js(`delete window.aiondxMobile; window.__aionDxMobile.refresh(); 0`);
    if ((await app.js('typeof window.aiondxMobile')) !== 'undefined') {
      console.log('SKIP  the no-handler check: window.aiondxMobile could not be removed - no click is made');
    } else {
      await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-firewall-allow"]')`, 40);
      await click('[data-testid="aiondx-mobile-firewall-allow"]');
      check('without a runner it shows the command to run, and runs nothing', await waitFor(`/netsh\\.exe advfirewall firewall add rule name="AionDX mobile bridge"/.test((document.querySelector('[data-testid="aiondx-mobile-firewall-command"]') || {}).textContent || '')`, 20),
        await q('[data-testid="aiondx-mobile-firewall-command"]', 'e.textContent'));
      await shot('9-firewall-manual');
      await app.js(`(() => { const o = document.querySelector('.aiondx-mobile-overlay'); if (o) o.click(); return 0; })()`);
    }
    }

    // ---- recovery banner (the real route, with a recovery notice added for this step) ----
    await app.js(`window.__fakeRecovery = { kind: 'host_key', at: Date.now(), movedTo: 'C:\\\\fake\\\\mobile\\\\host-key.bad' }; 0`);
    check('a host-key recovery shows the yellow notice with its detail', await waitFor(`(() => { const b = document.querySelector('[data-testid="aiondx-mobile-recovery"]'); return !!b && !b.hidden && /Every phone must pair again/.test(b.textContent) && /host-key\\.bad/.test(b.textContent); })()`, 20));
    await shot('10-recovery');
    await app.js(`[...document.querySelectorAll('[data-testid="aiondx-mobile-recovery"] button')][0].click(); 0`);
    check('Dismiss hides it', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-recovery"]').hidden === true`, 20));

    // ---- mDNS: the switch shows the saved choice, and why it is off in effect (stubbed: the newer core's status fields) ----
    await app.js(`window.__fakeStatus = { mdns: false, mdnsSetting: true, mdnsOffReason: 'loopback_bind' }; window.__aionDxMobile.refresh(); 0`);
    check('the mDNS switch follows mdnsSetting, not the effective mdns, with the local-only note', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-mdns"]').getAttribute('aria-checked') === 'true' && !document.querySelector('[data-testid="aiondx-mobile-mdns-note"]').hidden && /local-only test mode/.test(document.querySelector('[data-testid="aiondx-mobile-mdns-note"]').textContent)`, 20));
    await app.js(`window.__fakeStatus = { mdns: false, mdnsSetting: false, mdnsOffReason: null }; window.__aionDxMobile.refresh(); 0`);
    check('saved off, no reason: switch off and no note', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-mdns"]').getAttribute('aria-checked') === 'false' && document.querySelector('[data-testid="aiondx-mobile-mdns-note"]').hidden`, 20));
    await app.js(`window.__fakeStatus = { mdnsSetting: undefined, mdnsOffReason: undefined, mdns: true }; window.__aionDxMobile.refresh(); 0`);
    check('an older core without mdnsSetting: the switch falls back to mdns', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-mdns"]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-testid="aiondx-mobile-mdns-note"]').hidden`, 20));
    await app.js(`window.__fakeStatus = null; 0`);

    // ---- the firewall is off on this PC (Nathan's case): plain text, no button ----
    await app.js(`window.__fw = { rule: 'absent', plan: window.__fwPlan, firewallEnabled: false }; window.__aionDxMobile.refresh(); 0`);
    check('with Windows Firewall off, the row says no rule is needed and offers no button', await waitFor(`(() => { const s = document.querySelector('[data-testid="aiondx-mobile-firewall-state"]'); return !!s && s.getAttribute('data-rule') === 'firewall-off' && /Windows Firewall is off on this PC .* no rule is needed\\./.test(s.textContent) && !document.querySelector('[data-testid="aiondx-mobile-firewall-allow"]'); })()`, 40),
      await q('[data-testid="aiondx-mobile-firewall"]', 'e.textContent'));
    await shot('8b-firewall-off');
    await app.js(`window.__fw = { rule: 'absent', plan: window.__fwPlan, firewallEnabled: null }; window.__aionDxMobile.refresh(); 0`);
    check('with firewallEnabled null the button comes back', await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-firewall-allow"]')`, 40));

    // ---- the saved extra addresses come back from status after a reload ----
    await app.js('location.reload(); 0');
    await sleep(2500);
    await waitFor('!!(window.__coreCsrfToken && window.__backendPort)', 120, 500);
    await setup();
    await app.js(`location.hash = '#/settings/webui'; 0`);
    await waitFor(`!!document.getElementById('aiondx-mobile') && (window.__aionDxMobile.state().status || {}).enabled === true`, 60);
    const extra = await app.js(`(window.__aionDxMobile.state().status || {}).extraUrls`);
    check('after a reload, status returns the saved extra addresses', JSON.stringify(extra) === JSON.stringify(['http://100.64.1.2:47734', 'http://my-pc.tail1234.ts.net:47734']), JSON.stringify(extra));
    check('and the Advanced field shows them again, one per line', await waitFor(`document.querySelector('[data-testid="aiondx-mobile-extraurls"]').value === 'http://100.64.1.2:47734\\nhttp://my-pc.tail1234.ts.net:47734'`, 20),
      JSON.stringify(await q('[data-testid="aiondx-mobile-extraurls"]', 'e.value')));

    // ---- revoke, then turn it off ----
    await click(`[data-device-id=${JSON.stringify(ph.deviceId)}] [data-testid="aiondx-mobile-device-revoke"]`);
    await waitFor(`!!document.querySelector('[data-testid="aiondx-mobile-revoke-confirm"]')`, 20);
    await shot('11-revoke-confirm');
    await click('[data-testid="aiondx-mobile-revoke-confirm"]');
    check('Revoke (after confirming) removes the phone', await waitFor(`!document.querySelector('[data-device-id=${JSON.stringify(ph.deviceId)}]') && /No phones paired yet/.test(document.querySelector('[data-testid="aiondx-mobile-devices"]').textContent)`, 40) &&
      !((await admin('GET', '/api/mobile/admin/devices')).data || []).length);
    await click('[data-testid="aiondx-mobile-enable"]');
    check('the toggle turns it off again', await waitFor(`/Off\\./.test(document.querySelector('[data-testid="aiondx-mobile-status"]').textContent) && (window.__aionDxMobile.state().status || {}).listening === false`, 40));
    check('and the subtitle says it is off', (await q('[data-testid="aiondx-mobile-enable-hint"]', 'e.textContent')) === 'Off until you turn it on.');
  } catch (e) {
    check('the test ran to the end', false, e && e.stack || e);
  } finally {
    await app.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* in use a moment longer */ }
  }
  console.log(`${pass}/${pass + fail} passed; screenshots in ${SHOTS}`);
  process.exit(fail ? 1 : 0);
})();
