#!/usr/bin/env node
/**
 * test-barge.js - startBargeInListener against a fake microphone whose level is a function of time:
 * the reply's own sound leaking into the mic (which must never count as the user), and speech on
 * top of it (which must). Also the capture that follows, stopping, and the real-mic path through
 * createMicSource with fake getUserMedia/AudioContext/MediaRecorder. No real audio, no real
 * ElevenLabs. 60 s deadline.
 *
 *   node patches\0011-voice\test-barge.js
 */
'use strict';
const AionDxVoice = require('./aiondx-voice.js');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + detail + ']'}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small timings so the suite is quick, with margin for Windows' coarse timers.
const OPTS = { pollMs: 10, warmupMs: 60, minSpeechMs: 120, gapMs: 40, silenceMs: 80, threshold: 0.06, margin: 2.5 };

// The reply leaking into the microphone after echo cancellation: around 0.08 RMS, wavering, with a
// loud stretch at 0.18 (2.25 x its typical level) for 150 ms in every 600 ms - longer than
// minSpeechMs, so only the level margin keeps it out, not the duration. Its median is about 0.08, so
// the trigger sits near 0.2.
function leak(t) {
  const base = 0.08 + 0.025 * Math.sin(t / 35);
  return (t % 600) < 150 ? 0.18 : base;
}
// Two uncorrelated sounds add as root of the sum of squares.
const mix = (a, b) => Math.sqrt(a * a + b * b);

function timedLevel(fn) {
  const t0 = Date.now();
  return { getLevel: () => fn(Date.now() - t0) };
}

function recorders() {
  const made = [];
  return {
    made,
    createRecorder() {
      const r = { startedAt: 0, stopped: false };
      made.push(r);
      return { start() { r.startedAt = Date.now(); }, stop() { r.stopped = true; return Promise.resolve(new Blob(['clip' + made.indexOf(r)])); } };
    },
  };
}

function transcriber(answers) {
  const calls = [];
  let i = 0;
  const fn = (blob, opts) => {
    const a = answers[Math.min(i++, answers.length - 1)];
    calls.push({ blob, opts });
    if (typeof a === 'function') return a(opts);
    return Promise.resolve(a);
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  try {
    // ---- the reply alone, for two seconds: never a barge-in ----
    {
      const rec = recorders();
      const tr = transcriber(['should never be asked']);
      const events = [];
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        levelSource: timedLevel(leak), createRecorder: rec.createRecorder, transcribe: tr, onBargeIn: (e) => events.push(e),
      }));
      await sleep(2000);
      stop();
      check('two seconds of the reply leaking into the mic, loud 150 ms stretches included, never fire', events.length === 0);
      check('the reply alone never even starts a recording, and nothing is transcribed', rec.made.length === 0 && tr.calls.length === 0, 'recordings ' + rec.made.length);
    }

    // ---- the user talking over the reply: fires, with the recording from the first word ----
    {
      const rec = recorders();
      const events = [];
      let speechFrom = 0;
      const t0 = Date.now();
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        levelSource: timedLevel((t) => (t >= 700 ? mix(leak(t), 0.3) : leak(t))),
        createRecorder: rec.createRecorder, transcribe: transcriber(['x']),
        onBargeIn: (e) => events.push(Object.assign({ wall: Date.now() - t0 }, e)),
      }));
      speechFrom = 700;
      await sleep(1300);
      stop();
      const e = events[0];
      check('speech on top of the reply (0.3 against its ~0.08 typical level) fires once', events.length === 1, events.length);
      check('it fires about minSpeechMs after the user starts, not before', e && e.wall >= speechFrom + OPTS.minSpeechMs - 15 && e.wall <= speechFrom + OPTS.minSpeechMs + 150, e && e.wall);
      const kept = rec.made.find((r) => !r.stopped) || rec.made[rec.made.length - 1];
      check('the recording it keeps started with the first word', kept && kept.startedAt - t0 >= speechFrom - 15 && kept.startedAt - t0 <= speechFrom + 40, kept && kept.startedAt - t0);
      check('the floor it measured is the reply\'s level, not the user\'s', e && e.floor > 0.05 && e.floor < 0.12, e && e.floor);
    }

    // ---- a quiet room, and a cough ----
    {
      const events = [];
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        levelSource: timedLevel((t) => (t >= 300 && t < 700 ? 0.12 : 0.005)),
        createRecorder: recorders().createRecorder, transcribe: transcriber(['x']), onBargeIn: (e) => events.push(e),
      }));
      await sleep(800);
      stop();
      check('in a quiet room ordinary speech (0.12) fires', events.length === 1);
    }
    {
      const events = [];
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        levelSource: timedLevel((t) => (t >= 300 && t < 380 ? 0.5 : leak(t))),
        createRecorder: recorders().createRecorder, transcribe: transcriber(['x']), onBargeIn: (e) => events.push(e),
      }));
      await sleep(800);
      stop();
      check('a cough or a tap (0.5 for 80 ms) does not fire', events.length === 0);
    }

    // ---- after it fires: capture the utterance, which is what gets sent ----
    {
      const rec = recorders();
      let phase = 'reply';
      const tr = transcriber(['Actually, use the staging branch.']);
      let event = null;
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        levelSource: { getLevel: () => (phase === 'reply' ? 0.08 : phase === 'talk' ? mix(0.08, 0.3) : phase === 'own' ? 0.25 : 0.004) },
        createRecorder: rec.createRecorder, transcribe: tr, languageCode: 'en', onBargeIn: (e) => { event = e; },
      }));
      await sleep(150);
      phase = 'talk';
      await sleep(250);
      check('(setup) it fired', !!event);
      phase = 'own';                    // the UI stopped playback; the user is still talking
      const p = event.capture();
      await sleep(100);
      phase = 'quiet';                  // the user pauses
      const text = await p;
      stop();
      check('capture() resolves with what the user said', text === 'Actually, use the staging branch.');
      check('one recording, from the first word to the pause, transcribed once', rec.made.length === 1 && rec.made[0].stopped && tr.calls.length === 1 && String(tr.calls[0].blob.size) > 0);
      check('the locked language went with it', tr.calls[0].opts.languageCode === 'en');
      check('a second capture() is refused', await event.capture().then(() => false, (e) => /nothing to capture|stopped/.test(e.message)));
    }
    {
      let phase = 'talk';
      const seen = [];
      let event = null;
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        warmupMs: 0, levelSource: { getLevel: () => (phase === 'talk' ? 0.3 : 0.004) },
        createRecorder: recorders().createRecorder, transcribe: transcriber(['[laughter]']),
        onCandidate: (t, meta) => seen.push(meta.dropped), onBargeIn: (e) => { event = e; },
      }));
      await sleep(200);
      phase = 'quiet';
      const text = await event.capture();
      stop();
      check('a capture that was only a sound tag resolves "" and says why', text === '' && seen[0] === 'sound-tag');
    }
    {
      let event = null;
      let phase = 'talk';
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        warmupMs: 0, levelSource: { getLevel: () => (phase === 'talk' ? 0.3 : 0.004) },
        createRecorder: recorders().createRecorder, transcribe: transcriber(['Stop.']), onBargeIn: (e) => { event = e; },
      }));
      await sleep(200);
      phase = 'quiet';
      const text = await event.capture();
      stop();
      check('"Stop." comes back as text and isStopCommand says it is one (stop, do not send)', text === 'Stop.' && AionDxVoice.isStopCommand(text));
    }

    // ---- stopping: before it fires, and in the middle of a capture ----
    {
      const rec = recorders();
      const events = [];
      let loud = false;
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        warmupMs: 0, levelSource: { getLevel: () => (loud ? 0.3 : 0.004) }, createRecorder: rec.createRecorder,
        transcribe: transcriber(['x']), onBargeIn: (e) => events.push(e),
      }));
      await sleep(40);
      loud = true;
      await sleep(50);                  // speech has started, not yet minSpeechMs
      stop();
      await sleep(200);
      check('stop() while the user is starting to talk: no event, the recording stopped', events.length === 0 && rec.made.length === 1 && rec.made[0].stopped);
    }
    {
      const rec = recorders();
      let event = null;
      let aborted = false;
      const tr = transcriber([(o) => new Promise((resolve, reject) => { o.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); })]);
      let phase = 'talk';
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        warmupMs: 0, levelSource: { getLevel: () => (phase === 'talk' ? 0.3 : 0.004) }, createRecorder: rec.createRecorder,
        transcribe: tr, onBargeIn: (e) => { event = e; },
      }));
      await sleep(200);
      phase = 'quiet';
      const p = event.capture();
      await sleep(150);                 // past the pause: transcribe() is in flight
      stop();
      const outcome = await p.then(() => 'resolved', (e) => e.message);
      check('stop() during a capture rejects it ("stopped") and aborts the transcribe request', /stopped/.test(outcome) && aborted, outcome);
      check('the recording was stopped', rec.made.every((r) => r.stopped));
    }
    {
      let firstFired = false, secondFired = false;
      let loud = false;
      const src = { getLevel: () => (loud ? 0.3 : 0.004) };
      AionDxVoice.startBargeInListener(Object.assign({}, OPTS, { warmupMs: 0, levelSource: src, createRecorder: recorders().createRecorder, onBargeIn: () => { firstFired = true; } }));
      AionDxVoice.startBargeInListener(Object.assign({}, OPTS, { warmupMs: 0, levelSource: src, createRecorder: recorders().createRecorder, onBargeIn: () => { secondFired = true; } }));
      await sleep(30);
      loud = true;
      await sleep(250);
      AionDxVoice.stopBargeInListener();
      check('starting a second listener stops the first; stopBargeInListener() stops the active one', !firstFired && secondFired);
    }

    // ---- the real-microphone path, with fakes: constraints asked for, settings read back ----
    {
      const asked = [];
      const world = { trackStopped: false, ctxClosed: false };
      const applied = { echoCancellation: false, noiseSuppression: true, autoGainControl: true, deviceId: 'x' };
      const track = { stop() { world.trackStopped = true; }, getSettings: () => applied };
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      let level = 0.004;
      class FakeAudioContext {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buf) { buf.fill(level); } }; }
        close() { world.ctxClosed = true; }
      }
      class FakeMediaRecorder {
        constructor() { this.mimeType = 'audio/webm'; }
        start() {}
        stop() { setTimeout(() => this.onstop && this.onstop(), 0); }
      }
      let ready = null;
      let event = null;
      const stop = AionDxVoice.startBargeInListener(Object.assign({}, OPTS, {
        warmupMs: 0,
        getUserMedia: (c) => { asked.push(c); return Promise.resolve(stream); },
        AudioContext: FakeAudioContext, MediaRecorder: FakeMediaRecorder,
        onReady: (s) => { ready = s; }, onBargeIn: (e) => { event = e; },
      }));
      await sleep(40);
      check('the microphone is asked for echo cancellation, noise suppression and auto gain', asked.length === 1 &&
        asked[0].audio.echoCancellation === true && asked[0].audio.noiseSuppression === true && asked[0].audio.autoGainControl === true);
      check('what the device applied is read back and reported (echo cancellation off here)', ready && ready.echoCancellation === false && ready.noiseSuppression === true);
      check('without echo cancellation the margin and minimum speech time are raised by half', ready && ready.margin === 3.75 && ready.minSpeechMs === 180);
      level = 0.3;
      await sleep(300);
      check('(setup) it fired on the real-mic path', !!event);
      event.cancel();
      check('cancel() releases the microphone it opened', world.trackStopped && world.ctxClosed);
      stop();
    }
  } catch (e) {
    check('no exception escaped the test', false, e.stack || e.message);
  } finally {
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
