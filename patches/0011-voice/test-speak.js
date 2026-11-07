#!/usr/bin/env node
/**
 * test-speak.js - splitForSpeech and playChunked against a fake Audio element and a synthesize()
 * whose answers the test releases one at a time. No real ElevenLabs, no real audio. 30 s deadline.
 *
 *   node patches\0011-voice\test-speak.js
 */
'use strict';
const AionDxVoice = require('./aiondx-voice.js');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 30000);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + detail + ']'}`); };
const tick = () => new Promise((r) => setTimeout(r, 5));

// One fake audio element per piece: the test fires 'ended' itself.
function fakeAudioWorld(opts) {
  const made = [];
  const revoked = [];
  let n = 0;
  class FakeAudio {
    constructor(url) { this.url = url; this.paused = true; this.listeners = {}; made.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    emit(type) { (this.listeners[type] || []).forEach((fn) => fn()); }
    play() { if (opts && opts.rejectPlay) return Promise.reject(new Error('blocked')); this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  return {
    made, revoked,
    Audio: FakeAudio,
    createObjectURL: () => 'blob:' + (++n),
    revokeObjectURL: (u) => revoked.push(u),
  };
}

// synthesize() whose answer for each call waits until the test releases it; honours the abort signal.
function heldSynth() {
  const calls = [];
  function synthesize(text, o) {
    return new Promise((resolve, reject) => {
      const call = { text, opts: o, resolve: () => resolve(new Blob([text])), reject, aborted: false };
      calls.push(call);
      if (o && o.signal) o.signal.addEventListener('abort', () => { call.aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
  }
  return { calls, synthesize };
}

const REPLY = 'Sure. I looked at the build log and the anchor for patch 0011 did not match, because the index.html script tag moved. ' +
  'I will fix the anchor, rerun the stage build, and tell you when it is ready. Version 3.5 of the tool is fine. ' +
  'After that I will rebase onto main, resolve the conflicts in the voice file, rerun all four test suites, and only then ask you about opening the new pull request, since you asked to approve every push yourself.';

(async () => {
  try {
    // ---- splitForSpeech ----
    {
      const pieces = AionDxVoice.splitForSpeech(REPLY);
      check('a reply is split into more than one piece', pieces.length >= 2, pieces.length);
      check('the first piece is short (at most 160 characters)', pieces[0].length <= 160, pieces[0].length);
      check('the first piece is not a lone word ("Sure." joins the next sentence)', pieces[0].length >= 40, pieces[0]);
      check('no piece is longer than 400 characters', pieces.every((p) => p.length <= 400));
      check('nothing is lost or reordered', pieces.join(' ') === REPLY.replace(/\s+/g, ' ').trim());
      check('"index.html" and "3.5" are not taken for sentence ends', !pieces.some((p) => /index\.$|3\.$/.test(p)));
      const long = 'word, '.repeat(120) + 'end.';
      const cut = AionDxVoice.splitForSpeech(long);
      check('one very long sentence is cut at a comma, within the limits', cut.length > 1 && cut[0].length <= 160 && cut.every((p) => p.length <= 400) && cut[0].endsWith(','));
      check('empty text gives no pieces', AionDxVoice.splitForSpeech('   ').length === 0);
    }

    // ---- playChunked: first sound after the first piece only, the next one fetched meanwhile ----
    {
      const w = fakeAudioWorld();
      const s = heldSynth();
      let started = 0, ended = 0, errors = [];
      const player = AionDxVoice.playChunked({
        text: REPLY, synthesize: s.synthesize, Audio: w.Audio, createObjectURL: w.createObjectURL, revokeObjectURL: w.revokeObjectURL,
        onStart: () => started++, onEnd: () => ended++, onError: (e) => errors.push(e),
      });
      const n = player.pieces.length;
      await tick();
      check('only the first piece is requested at first', s.calls.length === 1 && s.calls[0].text === player.pieces[0]);
      check('it carries the next piece as continuity text, and no previous text', s.calls[0].opts.nextText === player.pieces[1] && s.calls[0].opts.previousText === undefined);

      s.calls[0].resolve();
      await tick();
      check('playback starts as soon as the first piece arrives', started === 1 && w.made.length === 1 && !w.made[0].paused);
      check('the second piece is requested while the first one plays', s.calls.length === 2 && s.calls[1].text === player.pieces[1] && s.calls[1].opts.previousText === player.pieces[0]);

      w.made[0].emit('ended');
      await tick();
      check('a piece that has not arrived yet is waited for, not skipped', w.made.length === 1);
      s.calls[1].resolve();
      await tick();
      check('the second piece plays once it arrives', w.made.length === 2 && !w.made[1].paused);
      check('the first piece\'s URL is released when the second one starts', w.revoked.includes(w.made[0].url));

      for (let i = 2; i < n; i++) {
        s.calls[i].resolve();
        await tick();
        w.made[i - 1].emit('ended');
        await tick();
      }
      w.made[n - 1].emit('ended');
      await tick();
      check('every piece played, in order', w.made.length === n);
      check('onEnd fires once after the last piece, onStart only once, no error', ended === 1 && started === 1 && errors.length === 0);
      check('done resolves with "end"', (await player.done) === 'end');
      check('every URL was released', w.made.every((a) => w.revoked.includes(a.url)));
      check('never more than one request in flight', s.calls.length === n);
    }

    // ---- stop while the first piece is still being made: nothing plays, the request is aborted ----
    {
      const w = fakeAudioWorld();
      const s = heldSynth();
      const fired = [];
      const player = AionDxVoice.playChunked({
        text: REPLY, synthesize: s.synthesize, Audio: w.Audio, createObjectURL: w.createObjectURL, revokeObjectURL: w.revokeObjectURL,
        onStart: () => fired.push('start'), onEnd: () => fired.push('end'), onError: () => fired.push('error'),
      });
      await tick();
      player.pause();
      check('stopping aborts the request in flight', s.calls[0].aborted === true);
      s.calls[0].resolve();
      await tick();
      check('a piece that arrives after the stop is never played', w.made.length === 0);
      check('no callback fires after a stop', fired.length === 0, fired.join(','));
      check('done resolves with "stopped"', (await player.done) === 'stopped');
      player.pause();
      check('a second stop is harmless', true);
    }

    // ---- stop while playing, with the next piece already requested ----
    {
      const w = fakeAudioWorld();
      const s = heldSynth();
      const fired = [];
      const player = AionDxVoice.playChunked({
        text: REPLY, synthesize: s.synthesize, Audio: w.Audio, createObjectURL: w.createObjectURL, revokeObjectURL: w.revokeObjectURL,
        onEnd: () => fired.push('end'), onError: () => fired.push('error'),
      });
      await tick();
      s.calls[0].resolve();
      await tick();
      player.pause();
      check('stopping pauses the audio that is playing', w.made[0].paused === true);
      check('and aborts the prefetch of the next piece', s.calls[1].aborted === true);
      check('and releases the playing piece\'s URL', w.revoked.includes(w.made[0].url));
      w.made[0].emit('ended');
      await tick();
      check('a late "ended" from the stopped audio starts nothing', w.made.length === 1 && s.calls.length === 2 && fired.length === 0);
    }

    // ---- failures are reported once, and stop the rest ----
    {
      const w = fakeAudioWorld();
      const s = heldSynth();
      const errors = [];
      const player = AionDxVoice.playChunked({
        text: REPLY, synthesize: s.synthesize, Audio: w.Audio, createObjectURL: w.createObjectURL, revokeObjectURL: w.revokeObjectURL,
        onError: (e) => errors.push(e),
      });
      await tick();
      s.calls[0].resolve();
      await tick();
      s.calls[1].reject(new Error('elevenlabs synthesize failed: http 429 quota'));
      w.made[0].emit('ended');
      await tick();
      check('a failed later piece is reported through onError with its message', errors.length === 1 && /429/.test(errors[0].message));
      check('done resolves with "error"', (await player.done) === 'error');
      check('nothing more is requested after the failure', s.calls.length === 2);
    }
    {
      const w = fakeAudioWorld({ rejectPlay: true });
      const errors = [];
      const player = AionDxVoice.playChunked({
        text: 'Hello there, this is a short reply.', synthesize: () => Promise.resolve(new Blob(['x'])),
        Audio: w.Audio, createObjectURL: w.createObjectURL, revokeObjectURL: w.revokeObjectURL, onError: (e) => errors.push(e),
      });
      check('a blocked play() is reported', (await player.done) === 'error' && errors.length === 1 && /blocked/.test(errors[0].message));
    }
    {
      const errors = [];
      const player = AionDxVoice.playChunked({ text: '  ', synthesize: () => Promise.resolve(new Blob(['x'])), Audio: fakeAudioWorld().Audio, onError: (e) => errors.push(e) });
      check('nothing to read is reported, not silently ignored', (await player.done) === 'error' && /nothing to read/.test(errors[0].message));
    }

    // ---- with the real client: each piece reaches ElevenLabs (stubbed) with the stored voice ----
    {
      const sent = [];
      const kv = { 'aiondx.voice.config': { provider: 'elevenlabs', apiKey: 'test-key-not-real', voiceId: 'v7' } };
      const request = (method, path) => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: method === 'GET' ? kv : {} }) });
      const fetchStub = (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return Promise.resolve(new Response(new Blob([new Uint8Array([1, 2])]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })); };
      const client = AionDxVoice.createVoiceClient({ request, fetch: fetchStub });
      const w = fakeAudioWorld();
      const player = AionDxVoice.playChunked({
        text: REPLY, synthesize: (t, o) => client.synthesize(t, null, o),
        Audio: w.Audio, createObjectURL: w.createObjectURL, revokeObjectURL: w.revokeObjectURL,
      });
      for (let i = 0; i < 20 && w.made.length < player.pieces.length; i++) {
        await tick();
        if (w.made.length) w.made[w.made.length - 1].emit('ended');
      }
      await tick();
      check('with the real client every piece is sent, to the stored voice, on Flash v2.5', sent.length === player.pieces.length &&
        sent.every((r) => /\/v1\/text-to-speech\/v7$/.test(r.url) && r.body.model_id === 'eleven_flash_v2_5'),
        JSON.stringify(sent.map((r) => r.url)));
      check('and with continuity text between pieces', sent.length > 1 && sent[1].body.previous_text === player.pieces[0] && sent[0].body.next_text === player.pieces[1]);
      player.pause();
    }
  } catch (e) {
    check('no exception escaped the test', false, e.stack || e.message);
  } finally {
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
