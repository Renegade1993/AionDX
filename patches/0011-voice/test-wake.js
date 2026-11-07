#!/usr/bin/env node
/**
 * test-wake.js - startWakeListener / stopWakeListener / captureUtterance against a fake mic:
 * a controllable level source and a fake recorder, no real microphone, no real ElevenLabs. Real
 * timers throughout, with small ms values (pollMs 5, minSpeechMs 15, silenceMs 20) so the whole
 * suite runs in well under a second of wall clock. 60 s deadline.
 *
 *   node patches\0011-voice\test-wake.js
 */
'use strict';
const AionDxVoice = require('./aiondx-voice.js');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + detail + ']'}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A level source the test drives directly: fake.level = 1 is "speaking", 0 is "silence".
function fakeLevelSource() {
  return { level: 0, getLevel() { return this.level; } };
}

// A recorder that just counts starts/stops and resolves stop() with a tiny marker Blob. calls[] lets
// a test see exactly which recorders were started and stopped, for leak checks.
function fakeRecorderFactory(calls) {
  return function createRecorder() {
    const rec = { started: false, stopped: false };
    calls.push(rec);
    return {
      start() { rec.started = true; },
      stop() { rec.stopped = true; return Promise.resolve(new Blob(['clip'])); },
    };
  };
}

// A transcribe() stub that returns queued answers in order, one per call, recording every blob it
// was given. A function instead of a fixed list lets a test delay a specific answer to test abort.
function queueTranscribe(answers, log) {
  let i = 0;
  return function transcribe(blob, opts) {
    if (log) log.push({ blob, opts });
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (typeof next === 'function') return next(opts);
    return Promise.resolve(next);
  };
}

// pollMs 10 with minSpeechMs/silenceMs several times that gives comfortable margin against Windows'
// coarser timer resolution; SPEAK_MS and SETTLE_MS below give a full segment room to complete before
// a test checks its result.
const COMMON = { pollMs: 10, minSpeechMs: 40, silenceMs: 60, maxSegmentMs: 1000, threshold: 0.5 };
const SPEAK_MS = 70;    // > minSpeechMs, so a recording is reliably started
const SETTLE_MS = 140;  // > silenceMs after speech stops, so the segment reliably finishes and transcribes

async function speak(level, ms) { level.level = 1; await sleep(ms); level.level = 0; }

(async () => {
  try {
    // ---- startWakeListener: fires onWake only when the phrase is in the transcript ----
    {
      const level = fakeLevelSource();
      const calls = [];
      const log = [];
      const woken = [];
      const candidates = [];
      const stop = AionDxVoice.startWakeListener(Object.assign({}, COMMON, {
        phrase: 'hey aiondx',
        levelSource: level,
        createRecorder: fakeRecorderFactory(calls),
        transcribe: queueTranscribe(['just chatting', 'Hey AionDX, what is the weather'], log),
        onWake: (text) => woken.push(text),
        onCandidate: (text) => candidates.push(text),
      }));

      await speak(level, SPEAK_MS);     // segment 1: "just chatting" - no wake
      await sleep(SETTLE_MS);
      check('a non-matching clip does not fire onWake', woken.length === 0);
      check('a non-matching clip still reaches onCandidate', candidates.length === 1 && candidates[0] === 'just chatting');

      await speak(level, SPEAK_MS);     // segment 2: contains the phrase
      await sleep(SETTLE_MS);
      check('a clip containing the phrase fires onWake, case-insensitively', woken.length === 1 && woken[0] === 'Hey AionDX, what is the weather');
      check('two speech segments started and stopped two recorders', calls.length === 2 && calls.every((c) => c.started && c.stopped));
      check('each clip was handed to transcribe as a Blob', log.every((l) => l.blob instanceof Blob));

      stop();
      const callsBefore = calls.length;
      await speak(level, SPEAK_MS);
      await sleep(SETTLE_MS);
      check('stop() (the returned function) ends the loop: no more recorders after it', calls.length === callsBefore);
    }

    // ---- stopWakeListener(): the module-level stop, and starting a new one replaces the old ----
    {
      const level = fakeLevelSource();
      const calls = [];
      const wokenA = [], wokenB = [];
      AionDxVoice.startWakeListener(Object.assign({}, COMMON, {
        phrase: 'alpha', levelSource: level, createRecorder: fakeRecorderFactory(calls),
        transcribe: queueTranscribe(['alpha go']), onWake: () => wokenA.push(1),
      }));
      // Starting a second listener stops the first automatically (only one runs at a time).
      AionDxVoice.startWakeListener(Object.assign({}, COMMON, {
        phrase: 'beta', levelSource: level, createRecorder: fakeRecorderFactory(calls),
        transcribe: queueTranscribe(['beta go']), onWake: () => wokenB.push(1),
      }));
      await speak(level, SPEAK_MS);
      await sleep(SETTLE_MS);
      check('starting a second wake listener supersedes the first', wokenA.length === 0 && wokenB.length === 1);

      AionDxVoice.stopWakeListener();
      const callsBefore = calls.length;
      await speak(level, SPEAK_MS);
      await sleep(SETTLE_MS);
      check('the module-level stopWakeListener() stops the active one', calls.length === callsBefore);
      check('stopWakeListener() with nothing running is a no-op', (() => { AionDxVoice.stopWakeListener(); return true; })());
    }

    // ---- captureUtterance: resolves with the one segment's text ----
    {
      const level = fakeLevelSource();
      const calls = [];
      const resultP = AionDxVoice.captureUtterance(Object.assign({}, COMMON, {
        levelSource: level, createRecorder: fakeRecorderFactory(calls),
        transcribe: queueTranscribe(['turn the lights on']),
        maxMs: 2000,
      }));
      await speak(level, SPEAK_MS);
      const text = await resultP;
      check('captureUtterance resolves with the transcribed utterance', text === 'turn the lights on');
      check('exactly one recording was made for one utterance', calls.length === 1 && calls[0].started && calls[0].stopped);
    }

    // ---- captureUtterance: times out, rather than hanging, when nobody speaks ----
    {
      const level = fakeLevelSource();
      let threw = null;
      try {
        await AionDxVoice.captureUtterance(Object.assign({}, COMMON, {
          levelSource: level, createRecorder: fakeRecorderFactory([]),
          transcribe: queueTranscribe(['unused']),
          maxMs: 150,
        }));
      } catch (e) { threw = e; }
      check('captureUtterance times out instead of hanging forever on silence', threw && /timed out/.test(threw.message));
    }

    // ---- captureUtterance: an AbortSignal cancels it early ----
    {
      const level = fakeLevelSource();
      const controller = new AbortController();
      const p = AionDxVoice.captureUtterance(Object.assign({}, COMMON, {
        levelSource: level, createRecorder: fakeRecorderFactory([]),
        transcribe: queueTranscribe(['unused']),
        maxMs: 5000,
        signal: controller.signal,
      }));
      setTimeout(() => controller.abort(), 20);
      let threw = null;
      try { await p; } catch (e) { threw = e; }
      check('an aborted signal rejects captureUtterance instead of waiting out maxMs', threw && /aborted/.test(threw.message));

      const already = new AbortController();
      already.abort();
      threw = null;
      try {
        await AionDxVoice.captureUtterance(Object.assign({}, COMMON, {
          levelSource: fakeLevelSource(), createRecorder: fakeRecorderFactory([]),
          transcribe: queueTranscribe(['unused']), signal: already.signal,
        }));
      } catch (e) { threw = e; }
      check('a signal already aborted rejects immediately', threw && /aborted/.test(threw.message));
    }

    // ---- stopping while a transcribe call is in flight: the stale result is ignored ----
    {
      const level = fakeLevelSource();
      const calls = [];
      let resolveTranscribe = null;
      const inFlight = new Promise((r) => { resolveTranscribe = r; });
      const woken = [];
      const stop = AionDxVoice.startWakeListener(Object.assign({}, COMMON, {
        phrase: 'ghost', levelSource: level, createRecorder: fakeRecorderFactory(calls),
        transcribe: queueTranscribe([() => inFlight]),
        onWake: () => woken.push(1),
      }));
      await speak(level, SPEAK_MS);     // triggers the one transcribe call, which hangs on inFlight
      await sleep(SETTLE_MS);          // past silenceMs: the clip has been handed to transcribe(), not yet answered
      stop();                          // stop while that call is still pending
      resolveTranscribe('ghost says hello'); // answers only after stop()
      await sleep(30);
      check('a transcribe result that arrives after stop() never fires onWake', woken.length === 0);
    }

    // ---- captureUtterance: the same stale-result protection ----
    {
      const level = fakeLevelSource();
      let resolveTranscribe = null;
      const inFlight = new Promise((r) => { resolveTranscribe = r; });
      let settledValue = 'not yet';
      const p = AionDxVoice.captureUtterance(Object.assign({}, COMMON, {
        levelSource: level, createRecorder: fakeRecorderFactory([]),
        transcribe: queueTranscribe([() => inFlight], []),
        maxMs: 250, // longer than SPEAK_MS+silenceMs (the segment reaches transcribe() first), still fires before inFlight ever resolves
      }));
      p.then((v) => { settledValue = 'resolved:' + v; }, () => { settledValue = 'rejected'; });
      await speak(level, SPEAK_MS);
      await sleep(320); // past maxMs: captureUtterance has already rejected with a timeout
      check('a timeout beats a slow transcribe call, and the call settles only once', settledValue === 'rejected');
      resolveTranscribe('too late');
      await sleep(20);
      check('the late transcribe answer changes nothing after settling', settledValue === 'rejected');
    }

    // ---- a failed transcribe() is never swallowed silently (the live bug: every real clip was
    // failing and nothing - not onCandidate, not onError - ever said so, which looked exactly like
    // the mic not working at all) ----
    {
      const level = fakeLevelSource();
      const calls = [];
      const woken = [];
      const candidates = [];
      const errors = [];
      AionDxVoice.startWakeListener(Object.assign({}, COMMON, {
        phrase: 'hey aiondx', levelSource: level, createRecorder: fakeRecorderFactory(calls),
        transcribe: queueTranscribe([
          () => Promise.reject(new Error('elevenlabs transcribe failed: http 400 invalid_audio')),
          'Hey AionDX, are you there',
        ], []),
        onWake: (t) => woken.push(t),
        onCandidate: (t) => candidates.push(t),
        onTranscribeError: (e) => errors.push(e),
      }));

      await speak(level, SPEAK_MS);     // segment 1: transcribe() rejects
      await sleep(SETTLE_MS);
      check('a failed clip calls onTranscribeError with the real error', errors.length === 1 && /invalid_audio/.test(errors[0].message));
      check('a failed clip does not call onCandidate or onWake', candidates.length === 0 && woken.length === 0);

      await speak(level, SPEAK_MS);     // segment 2: transcribe() succeeds and matches - the loop kept going
      await sleep(SETTLE_MS);
      check('the listener keeps listening after a failed clip: a later good clip still wakes it', woken.length === 1 && woken[0] === 'Hey AionDX, are you there');
      check('two segments were recorded (the failure did not stop the VAD loop)', calls.length === 2);
    }

    // ---- captureUtterance: a failed transcribe() rejects the call itself, not a silent timeout ----
    {
      const level = fakeLevelSource();
      const theError = new Error('elevenlabs transcribe failed: http 400 invalid_audio');
      const p = AionDxVoice.captureUtterance(Object.assign({}, COMMON, {
        levelSource: level, createRecorder: fakeRecorderFactory([]),
        transcribe: queueTranscribe([() => Promise.reject(theError)], []),
        maxMs: 5000, // much longer than this should ever take - proves the rejection is immediate, not a timeout
      }));
      await speak(level, SPEAK_MS);
      let threw = null;
      try { await p; } catch (e) { threw = e; }
      check('captureUtterance rejects with the transcribe error itself, right away', threw === theError);
    }

    // ---- matchWakePhrase: how a transcriber actually spells "Hey AionDX" (the user's own dictation,
    // 2026-11-06: "Hey, AonDX", "Hey AMD X", "Hey Android X", "Hey, Aion DX") ----
    {
      const P = 'Hey AionDX';
      const heard = ['Hey, AonDX', 'Hey AMD X', 'Hey Android X', 'Hey, Aion DX', 'hey aiondx', 'Hey AionDX, what time is it?',
        'Okay so hey, Aion DX, can you check the build', 'Hey eon DX', 'Hey Ion DX.', 'Hey, AI on DX.', 'Hey Aeon decks', 'Hay AionDX', 'Hey Aion D.X.'];
      const missed = heard.filter((t) => !AionDxVoice.matchWakePhrase(t, P).matched);
      check('every transcription variant of the wake phrase matches', missed.length === 0, missed.join(' | '));

      // Ordinary speech, including "hey" + a near-miss word. None of these may wake it.
      const ordinary = ['hey can you run the tests again', 'hey there', "hey Andrew how's it going", 'hey Adam', 'hey android',
        'hey how are you doing today', 'hey Alexa', 'hey Siri', 'OK Google', 'hey Aiden', 'hey index', 'hey Anthony', 'hey AMD',
        'and the next one', 'the index is out of bounds', "let's add a new file called index.tsx", 'make sure the API key is never logged',
        'can you rebuild the app and stage it', 'push it to the branch but do not open a PR yet', 'hey quick question about the build',
        'Android Studio is installed', 'Aion is the name of the app', 'DX stands for developer experience', 'the AMD driver crashed again',
        'hey Ann', 'hey on deck', 'hey Redux', 'hey check the DX', 'hey I need DX', 'hey the DX build is broken', 'hey, so the dx stuff',
        'hey audio', 'hey Aion', 'hey eon', 'hey Hondo', 'they and I went to dinner', 'please check the onion dicing tutorial', 'stop listening'];
      const woke = ordinary.filter((t) => AionDxVoice.matchWakePhrase(t, P).matched);
      check('ordinary speech, near misses included, does not wake it (' + ordinary.length + ' sentences)', woke.length === 0, woke.join(' | '));

      check('a custom phrase works the same way', AionDxVoice.matchWakePhrase('OK, computer, open the build', 'OK Computer').matched &&
        AionDxVoice.matchWakePhrase('okay compooter', 'OK Computer').matched && !AionDxVoice.matchWakePhrase("okay, let's commit this", 'OK Computer').matched);
      check('a one-word phrase is found anywhere', AionDxVoice.matchWakePhrase('so, Jarvis, are you up', 'Jarvis').matched && !AionDxVoice.matchWakePhrase('so are you up', 'Jarvis').matched);
      check('tolerance 0 means an exact match after normalizing', AionDxVoice.matchWakePhrase('Hey, Aion DX!', P, { tolerance: 0 }).matched &&
        !AionDxVoice.matchWakePhrase('Hey AonDX', P, { tolerance: 0 }).matched);
    }

    // ---- the listener uses it, and onCandidate says what was heard and whether it matched ----
    {
      const level = fakeLevelSource();
      const woken = [];
      const candidates = [];
      const stop = AionDxVoice.startWakeListener(Object.assign({}, COMMON, {
        phrase: 'Hey AionDX', levelSource: level, createRecorder: fakeRecorderFactory([]),
        transcribe: queueTranscribe(['hey android', 'Hey AMD X']),
        onWake: (t) => woken.push(t),
        onCandidate: (t, info) => candidates.push([t, info]),
      }));
      await speak(level, SPEAK_MS);
      await sleep(SETTLE_MS);
      await speak(level, SPEAK_MS);
      await sleep(SETTLE_MS);
      stop();
      check('the listener wakes on a transcription variant ("Hey AMD X")', woken.length === 1 && woken[0] === 'Hey AMD X');
      check('onCandidate gets the heard text and whether it matched', candidates.length === 2 &&
        candidates[0][0] === 'hey android' && candidates[0][1].matched === false &&
        candidates[1][0] === 'Hey AMD X' && candidates[1][1].matched === true && candidates[1][1].distance === 3);
    }

    // ---- input validation: clear errors, no network/mic access attempted ----
    {
      let threw = null;
      try { AionDxVoice.startWakeListener({ transcribe: () => Promise.resolve(''), levelSource: fakeLevelSource(), createRecorder: fakeRecorderFactory([]) }); } catch (e) { threw = e; }
      check('startWakeListener refuses an empty phrase', threw && /phrase/.test(threw.message));

      threw = null;
      try { AionDxVoice.startWakeListener({ phrase: 'hi', levelSource: fakeLevelSource(), createRecorder: fakeRecorderFactory([]) }); } catch (e) { threw = e; }
      check('startWakeListener refuses with no transcribe function', threw && /transcribe/.test(threw.message));

      threw = null;
      try { await AionDxVoice.captureUtterance({ levelSource: fakeLevelSource(), createRecorder: fakeRecorderFactory([]) }); } catch (e) { threw = e; }
      check('captureUtterance refuses with no transcribe function', threw && /transcribe/.test(threw.message));

      threw = null;
      try { await AionDxVoice.captureUtterance({ transcribe: () => Promise.resolve(''), levelSource: fakeLevelSource() }); } catch (e) { threw = e; }
      check('captureUtterance refuses a levelSource with no matching createRecorder', threw && /createRecorder/.test(threw.message));
    }

    // ---- no real mic in this environment: createMicSource reports it cleanly instead of crashing ----
    {
      let threw = null;
      try { await AionDxVoice.createMicSource({}); } catch (e) { threw = e; }
      check('createMicSource fails clearly under plain Node (no getUserMedia here)', threw && /microphone|getUserMedia/i.test(threw.message));
    }
  } catch (e) {
    check('no exception escaped the test', false, e.stack || e.message);
  } finally {
    clearTimeout(deadline);
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
