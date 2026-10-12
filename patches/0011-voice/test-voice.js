#!/usr/bin/env node
/**
 * test-voice.js - aiondx-voice.js against a stand-in ElevenLabs API and a stand-in settings
 * store (one local HTTP server for both; the ElevenLabs provider is pointed at it through its
 * `fetch` option, the settings store through its `request` option, so no real network, no real
 * AionUi, no real key). 60 s deadline.
 *
 *   node patches\0011-voice\test-voice.js
 */
'use strict';
const http = require('http');
const AionDxVoice = require('./aiondx-voice.js');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + detail + ']'}`); };

// ------------------------------------------------------------------ the stand-in server
// behavior.* lets a test make the next matching call fail, or inspect what was sent.
const behavior = { ttsStatus: 200, ttsBody: '', sttStatus: 200, sttBody: '{"text":"hello world"}', voicesStatus: 200, voicesBody: '{"voices":[]}' };
const requests = []; // { method, url, headers, body (Buffer) }
const kv = {}; // the settings store, aiondx.* -> value

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  requests.push({ method: req.method, url: req.url, headers: req.headers, body });
  const [path] = req.url.split('?');

  if (path === '/api/settings/client' && req.method === 'GET') {
    const keys = new URL(req.url, 'http://x').searchParams.get('keys');
    const data = {};
    if (keys) for (const k of keys.split(',')) if (k in kv) data[k] = kv[k];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data }));
    return;
  }
  if (path === '/api/settings/client' && req.method === 'PUT') {
    if (behavior.settingsPutStatus) { res.writeHead(behavior.settingsPutStatus); res.end(); return; }
    const map = JSON.parse(body.toString('utf8') || '{}');
    for (const k of Object.keys(map)) { if (map[k] === null) delete kv[k]; else kv[k] = map[k]; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (/^\/v1\/text-to-speech\//.test(path) && req.method === 'POST') {
    if (behavior.ttsStatus !== 200) { res.writeHead(behavior.ttsStatus); res.end(behavior.ttsBody); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from([1, 2, 3, 4]));
    return;
  }
  if (path === '/v1/speech-to-text' && req.method === 'POST') {
    if (behavior.sttStatus !== 200) { res.writeHead(behavior.sttStatus); res.end(behavior.sttBody); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(behavior.sttBody);
    return;
  }
  if (path === '/v1/voices' && req.method === 'GET') {
    if (behavior.voicesStatus !== 200) { res.writeHead(behavior.voicesStatus); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(behavior.voicesBody);
    return;
  }
  res.writeHead(404);
  res.end();
});

// Every console line is captured too, so a leaked API key anywhere - error message, a stray log -
// is caught no matter which check would have found it.
const consoleLines = [];
const realLog = console.log;
console.log = (...a) => { consoleLines.push(a.join(' ')); realLog(...a); };

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const API_KEY = 'test-secret-key-should-never-be-logged-98765';

  function makeFetch() {
    return (url, init) => {
      const u = new URL(url);
      return fetch(base + u.pathname + (u.search || ''), init);
    };
  }

  try {
    // ---- interface shape ----
    const provider = AionDxVoice.createProvider({ provider: 'elevenlabs', apiKey: API_KEY }, { fetch: makeFetch() });
    check('provider has an id', provider.id === 'elevenlabs');
    check('provider has a name', provider.name === 'ElevenLabs');
    check('provider.synthesize is a function', typeof provider.synthesize === 'function');
    check('provider.transcribe is a function', typeof provider.transcribe === 'function');
    check('provider.listVoices is a function', typeof provider.listVoices === 'function');
    check('listProviders lists elevenlabs', AionDxVoice.listProviders().some((p) => p.id === 'elevenlabs' && p.name === 'ElevenLabs'));
    check('createProvider refuses an unknown provider', (() => { try { AionDxVoice.createProvider({ provider: 'nosuchprovider' }); return false; } catch (e) { return /unknown provider/.test(e.message); } })());

    // ---- synthesize ----
    const noKey = AionDxVoice.createElevenLabsProvider({ fetch: makeFetch() });
    let threw = null;
    try { await noKey.synthesize('hello'); } catch (e) { threw = e; }
    check('synthesize with no API key refuses before any call', threw && /no API key/.test(threw.message));

    threw = null;
    try { await provider.synthesize(''); } catch (e) { threw = e; }
    check('synthesize refuses empty text', threw && /no text/.test(threw.message));

    requests.length = 0;
    const audioBlob = await provider.synthesize('hello world');
    const ttsReq = requests[requests.length - 1];
    check('synthesize posts to the text-to-speech endpoint with the default voice', /\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM$/.test(ttsReq.url));
    check('synthesize sends the key only in xi-api-key', ttsReq.headers['xi-api-key'] === API_KEY && !('authorization' in ttsReq.headers));
    check('synthesize sends the text as JSON', JSON.parse(ttsReq.body.toString('utf8')).text === 'hello world');
    check('synthesize returns a Blob', audioBlob instanceof Blob && audioBlob.size === 4);
    check('the returned Blob carries the audio content type', audioBlob.type === 'audio/mpeg');

    requests.length = 0;
    await provider.synthesize('hi', { voiceId: 'custom-voice-id' });
    check('synthesize uses the voice id a call names', /\/v1\/text-to-speech\/custom-voice-id$/.test(requests[requests.length - 1].url));

    behavior.ttsStatus = 400; behavior.ttsBody = 'bad request: missing field';
    threw = null;
    try { await provider.synthesize('hello'); } catch (e) { threw = e; }
    check('a failed synthesize reports the status and the provider error', threw && /http 400/.test(threw.message) && /bad request/.test(threw.message));
    check('a failed synthesize never names the key', threw && !threw.message.includes(API_KEY));
    behavior.ttsStatus = 200;

    // ---- transcribe ----
    threw = null;
    try { await noKey.transcribe(new Blob([1])); } catch (e) { threw = e; }
    check('transcribe with no API key refuses before any call', threw && /no API key/.test(threw.message));

    threw = null;
    try { await provider.transcribe(null); } catch (e) { threw = e; }
    check('transcribe refuses with no audio', threw && /no audio/.test(threw.message));

    requests.length = 0;
    const fakeAudio = new Blob([new Uint8Array([9, 9, 9])], { type: 'audio/webm' });
    const text = await provider.transcribe(fakeAudio);
    const sttReq = requests[requests.length - 1];
    check('transcribe posts to the speech-to-text endpoint', sttReq.url === '/v1/speech-to-text');
    check('transcribe sends the key', sttReq.headers['xi-api-key'] === API_KEY);
    check('transcribe sends a multipart form with the audio', /multipart\/form-data/.test(sttReq.headers['content-type'] || '') && sttReq.body.includes('scribe_v1'));
    check('transcribe returns the text field', text === 'hello world');

    behavior.sttBody = '{"transcript":"from the transcript field"}';
    check('transcribe falls back to the transcript field', (await provider.transcribe(fakeAudio)) === 'from the transcript field');

    behavior.sttStatus = 500; behavior.sttBody = 'server error';
    threw = null;
    try { await provider.transcribe(fakeAudio); } catch (e) { threw = e; }
    check('a failed transcribe reports the status', threw && /http 500/.test(threw.message) && !threw.message.includes(API_KEY));
    behavior.sttStatus = 200; behavior.sttBody = '{"text":"hello world"}';

    // ---- listVoices ----
    threw = null;
    try { await noKey.listVoices(); } catch (e) { threw = e; }
    check('listVoices with no API key refuses before any call', threw && /no API key/.test(threw.message));

    behavior.voicesBody = JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Alpha' }, { voice_id: 'v2', name: 'Beta' }] });
    const voices = await provider.listVoices();
    check('listVoices maps id and name', voices.length === 2 && voices[0].id === 'v1' && voices[0].name === 'Alpha' && voices[1].id === 'v2');

    behavior.voicesStatus = 401;
    threw = null;
    try { await provider.listVoices(); } catch (e) { threw = e; }
    check('a failed listVoices reports the status', threw && /http 401/.test(threw.message));
    behavior.voicesStatus = 200;

    // ---- settings store, against the stand-in /api/settings/client ----
    const request = (method, path, b) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: b !== undefined ? JSON.stringify(b) : undefined });
    const store = AionDxVoice.createSettingsStore({ request });

    check('getConfig is null before anything is saved', (await store.getConfig()) === null);

    const saved = await store.setConfig({ provider: 'elevenlabs', apiKey: API_KEY, voiceId: 'v1' });
    check('setConfig returns the record it saved', saved.provider === 'elevenlabs' && saved.apiKey === API_KEY && saved.voiceId === 'v1' && typeof saved.at === 'number');
    check('getConfig reads the same record back', JSON.stringify(await store.getConfig()) === JSON.stringify(saved));

    const before = await store.getConfig();
    const merged = await store.setConfig({ voiceId: 'v2' });
    check('setConfig merges onto the existing record instead of replacing it', merged.apiKey === before.apiKey && merged.provider === before.provider && merged.voiceId === 'v2');

    await store.clearConfig();
    check('clearConfig removes the record', (await store.getConfig()) === null);

    behavior.settingsPutStatus = 500;
    threw = null;
    try { await store.setConfig({ provider: 'elevenlabs' }); } catch (e) { threw = e; }
    check('a failed save is reported, not swallowed', threw && /http 500/.test(threw.message));
    delete behavior.settingsPutStatus;

    // ---- the default requester (no override): credentials, content type, the csrf token ----
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = (url, init) => { captured = { url, init }; return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) }); };
    try {
      const defStore = AionDxVoice.createSettingsStore({ baseUrl: 'http://example.invalid', csrfToken: () => 'tok-abc' });
      await defStore.getConfig();
      check('the default requester builds baseUrl + path', captured.url === 'http://example.invalid/api/settings/client?keys=' + encodeURIComponent(AionDxVoice.VOICE_CONFIG_KEY));
      check('the default requester sends credentials and the csrf token', captured.init.credentials === 'include' && captured.init.headers['x-csrf-token'] === 'tok-abc');
    } finally { global.fetch = realFetch; }

    // ---- the convenience client (the UI's window.__aionDxVoice shape) ----
    await store.clearConfig();
    const client = AionDxVoice.createVoiceClient({ request, fetch: makeFetch() });

    threw = null;
    try { await client.transcribe(fakeAudio); } catch (e) { threw = e; }
    check('the client refuses to transcribe with no provider configured', threw && /no provider configured/.test(threw.message));

    await client.setSettings({ provider: 'elevenlabs', apiKey: API_KEY, voiceId: 'v1' });
    check('getSettings reads back what setSettings wrote', (await client.getSettings()).voiceId === 'v1');

    requests.length = 0;
    check('the client transcribes through the configured provider', (await client.transcribe(fakeAudio)) === 'hello world');
    check('the client synthesizes through the configured provider', (await client.synthesize('hi there')).size === 4);

    requests.length = 0;
    await client.synthesize('hi there', 'another-voice');
    check('the client\'s synthesize(text, voiceId) passes the voice id through', /\/v1\/text-to-speech\/another-voice$/.test(requests[requests.length - 1].url));

    behavior.voicesBody = JSON.stringify({ voices: [{ voice_id: 'v9', name: 'Nine' }] });
    check('the client lists voices through the configured provider', (await client.listVoices())[0].id === 'v9');
    check('listProviders resolves (a Promise, for the UI\'s stub shape)', (await client.listProviders()).some((p) => p.id === 'elevenlabs'));

    await client.setSettings({ voiceId: 'v2' });
    check('setSettings merges rather than replacing (the key survives a voice-only change)', (await client.getSettings()).apiKey === API_KEY);
    requests.length = 0;
    await client.synthesize('hi again');
    check('the client rebuilds its provider after setSettings changes the voice', /\/v1\/text-to-speech\/v2$/.test(requests[requests.length - 1].url));

    // ---- the key never appears in anything this test observed on the console ----
    check('the API key was never written to the console', !consoleLines.some((l) => l.includes(API_KEY)));
  } catch (e) {
    check('no exception escaped the test', false, e.stack || e.message);
  } finally {
    console.log = realLog;
    server.close();
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
