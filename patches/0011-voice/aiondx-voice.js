/**
 * aiondx-voice.js - a provider-agnostic voice (text-to-speech / speech-to-text) module, with
 * ElevenLabs as the first provider. Used by the composer's mic button and playback controls
 * (patches\0011-voice, the UI half) and by anyone adding another provider later.
 *
 * ENVIRONMENT. This file depends on nothing but fetch, Blob and FormData, which Node 18+ and every
 * browser both have, so it runs unchanged in the renderer (as window.AionDxVoice, a plain global
 * script like aiondx-ui.js) and under plain Node for its own tests (as module.exports). It touches
 * no DOM and no localStorage.
 *
 * THE INTERFACE. A VoiceProvider is { id, name, synthesize(text, opts) -> Promise<Blob>,
 * transcribe(audio) -> Promise<string>, listVoices()? -> Promise<{id,name}[]> }. createProvider(config)
 * builds one from a plain config object ({ provider: 'elevenlabs', apiKey, voiceId }); adding a second
 * provider is one more entry in PROVIDERS, nothing else about the shape changes.
 *
 * SETTINGS. The chosen provider, its API key and the chosen voice live in one record,
 * aiondx.voice.config, in AionUi's per-user settings store (GET/PUT /api/settings/client, aionui-system
 * client_pref.rs: a flat map, per-key upsert, null deletes, no side effects - the same store patch
 * 0007's Loop tool and patch 0001's renderer use for aiondx.loop.* and aiondx.usage.*). createSettingsStore
 * takes the caller's own request function (the renderer already has apiUrl/csrf; a Node caller passes
 * a plain fetch), so this file never reads window or a cookie itself.
 *
 * THE KEY IS NEVER LOGGED. Nothing in this file calls console.* with the config record or the apiKey
 * field; a failed call reports only the HTTP status and the provider's own error body, never what was
 * sent. tools\privacy-check.js and tools\audit-literals.js both run over this file at build time.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.AionDxVoice = mod;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  var VOICE_CONFIG_KEY = 'aiondx.voice.config';
  var ELEVEN_BASE = 'https://api.elevenlabs.io';
  // ElevenLabs' own default sample voice ("Rachel"), published in their API docs; used only when the
  // user has picked a provider but no voice yet.
  var ELEVEN_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

  // ---------------------------------------------------------------- settings store

  /** opts.request(method, path, bodyObjectOrUndefined) -> fetch Response. Defaults to fetch against
   *  opts.baseUrl + path, credentials included, opts.csrfToken (value or a function) as x-csrf-token -
   *  the same shape patch 0001's postJson/getJson use. */
  function defaultRequest(opts) {
    return function (method, path, body) {
      var base = (opts && opts.baseUrl) || '';
      var headers = { 'Content-Type': 'application/json' };
      var token = opts && opts.csrfToken;
      if (token) headers['x-csrf-token'] = typeof token === 'function' ? token() : token;
      return fetch(base + path, {
        method: method,
        credentials: 'include',
        headers: headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };
  }

  /** Reads and writes the single aiondx.voice.config record. setConfig merges onto whatever is
   *  already there (so setting the voice does not require re-sending the API key) and stamps `at`. */
  function createSettingsStore(opts) {
    opts = opts || {};
    var request = opts.request || defaultRequest(opts);

    function getConfig() {
      return request('GET', '/api/settings/client?keys=' + encodeURIComponent(VOICE_CONFIG_KEY)).then(function (r) {
        if (!r.ok) return null;
        return r.json().then(function (j) {
          var data = j && (j.data || j);
          return (data && data[VOICE_CONFIG_KEY]) || null;
        });
      });
    }

    function setConfig(patch) {
      return getConfig().then(function (current) {
        var next = Object.assign({}, current || {}, patch || {}, { at: Date.now() });
        var body = {};
        body[VOICE_CONFIG_KEY] = next;
        return request('PUT', '/api/settings/client', body).then(function (r) {
          if (!r.ok) throw new Error('voice settings not saved: http ' + r.status);
          return next;
        });
      });
    }

    function clearConfig() {
      var body = {};
      body[VOICE_CONFIG_KEY] = null;
      return request('PUT', '/api/settings/client', body).then(function (r) {
        if (!r.ok) throw new Error('voice settings not cleared: http ' + r.status);
      });
    }

    return { getConfig: getConfig, setConfig: setConfig, clearConfig: clearConfig };
  }

  // ---------------------------------------------------------------- ElevenLabs

  function errorText(r) {
    return r.text().then(
      function (t) { return t.slice(0, 200); },
      function () { return ''; }
    );
  }

  /** opts: { apiKey, voiceId? (default voice when a call does not name one), fetch? (for tests) }. */
  function createElevenLabsProvider(opts) {
    opts = opts || {};
    var apiKey = opts.apiKey || '';
    var defaultVoiceId = opts.voiceId || ELEVEN_DEFAULT_VOICE_ID;
    var fetchImpl = opts.fetch || fetch;

    function authHeaders(extra) {
      return Object.assign({ 'xi-api-key': apiKey }, extra || {});
    }

    return {
      id: 'elevenlabs',
      name: 'ElevenLabs',

      synthesize: function (text, synthOpts) {
        if (!apiKey) return Promise.reject(new Error('elevenlabs: no API key configured'));
        if (!text || !String(text).trim()) return Promise.reject(new Error('elevenlabs: no text to speak'));
        var voiceId = (synthOpts && synthOpts.voiceId) || defaultVoiceId;
        return fetchImpl(ELEVEN_BASE + '/v1/text-to-speech/' + encodeURIComponent(voiceId), {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
          body: JSON.stringify({
            text: String(text),
            model_id: (synthOpts && synthOpts.modelId) || 'eleven_multilingual_v2',
          }),
        }).then(function (r) {
          if (!r.ok) return errorText(r).then(function (t) { throw new Error('elevenlabs synthesize failed: http ' + r.status + (t ? ' ' + t : '')); });
          return r.blob();
        });
      },

      transcribe: function (audio, transcribeOpts) {
        if (!apiKey) return Promise.reject(new Error('elevenlabs: no API key configured'));
        if (!audio) return Promise.reject(new Error('elevenlabs: no audio to transcribe'));
        var form = new FormData();
        form.append('model_id', 'scribe_v1');
        form.append('file', audio, 'audio');
        return fetchImpl(ELEVEN_BASE + '/v1/speech-to-text', {
          method: 'POST',
          headers: authHeaders(),
          body: form,
          signal: transcribeOpts && transcribeOpts.signal,
        }).then(function (r) {
          if (!r.ok) return errorText(r).then(function (t) { throw new Error('elevenlabs transcribe failed: http ' + r.status + (t ? ' ' + t : '')); });
          return r.json().then(function (j) { return (j && (j.text || j.transcript)) || ''; });
        });
      },

      listVoices: function () {
        if (!apiKey) return Promise.reject(new Error('elevenlabs: no API key configured'));
        return fetchImpl(ELEVEN_BASE + '/v1/voices', { headers: authHeaders() }).then(function (r) {
          if (!r.ok) return errorText(r).then(function (t) { throw new Error('elevenlabs listVoices failed: http ' + r.status + (t ? ' ' + t : '')); });
          return r.json().then(function (j) {
            var list = (j && j.voices) || [];
            return list.map(function (v) { return { id: v.voice_id, name: v.name }; });
          });
        });
      },
    };
  }

  // ---------------------------------------------------------------- registry

  var PROVIDERS = {
    elevenlabs: { name: 'ElevenLabs', create: createElevenLabsProvider },
  };

  function listProviders() {
    return Object.keys(PROVIDERS).map(function (id) { return { id: id, name: PROVIDERS[id].name }; });
  }

  /** config: { provider, apiKey, voiceId }, the same shape the settings store keeps. opts.fetch, for
   *  tests, reaches the provider's constructor. */
  function createProvider(config, opts) {
    config = config || {};
    var entry = PROVIDERS[config.provider];
    if (!entry) throw new Error('voice: unknown provider "' + config.provider + '"');
    return entry.create(Object.assign({}, config, opts || {}));
  }

  // ---------------------------------------------------------------- convenience client

  /** A flat, "current provider" client over the two pieces above, for a caller (the composer's mic
   *  and playback controls) that just wants "transcribe this" / "say this" without juggling a
   *  provider and a settings store itself. opts are the same ones createSettingsStore and
   *  createProvider take (request or baseUrl/csrfToken; fetch, for tests). The provider is rebuilt
   *  from the stored config on first use and again whenever setSettings changes it; reading settings
   *  between calls is one extra store read, not a network round trip to the provider itself. */
  function createVoiceClient(opts) {
    opts = opts || {};
    var store = createSettingsStore(opts);
    var cached = null; // { config, provider }

    function sameConfig(a, b) {
      return !!a && !!b && a.provider === b.provider && a.apiKey === b.apiKey && a.voiceId === b.voiceId;
    }

    function currentProvider() {
      return store.getConfig().then(function (config) {
        if (!config || !config.provider) throw new Error('voice: no provider configured');
        if (cached && sameConfig(cached.config, config)) return cached.provider;
        var provider = createProvider(config, opts);
        cached = { config: config, provider: provider };
        return provider;
      });
    }

    return {
      transcribe: function (audioBlob, transcribeOpts) { return currentProvider().then(function (p) { return p.transcribe(audioBlob, transcribeOpts); }); },
      synthesize: function (text, voiceId) { return currentProvider().then(function (p) { return p.synthesize(text, voiceId ? { voiceId: voiceId } : undefined); }); },
      listVoices: function () { return currentProvider().then(function (p) { return p.listVoices ? p.listVoices() : []; }); },
      listProviders: function () { return Promise.resolve(listProviders()); },
      getSettings: function () { return store.getConfig().then(function (c) { return c || {}; }); },
      setSettings: function (patch) { cached = null; return store.setConfig(patch); },
    };
  }

  // ---------------------------------------------------------------- voice activity detection

  /** The real microphone: getUserMedia -> an AudioContext/AnalyserNode for a 0..1-ish RMS level,
   *  and a MediaRecorder-backed recorder. Every constructor is injectable (opts.getUserMedia,
   *  opts.AudioContext, opts.MediaRecorder) so startWakeListener/captureUtterance are fully
   *  testable under Node, where none of these exist, by passing opts.levelSource/opts.createRecorder
   *  instead and skipping this function entirely. Only used when a caller does not supply its own
   *  levelSource/createRecorder (e.g. the UI's existing mic-button plumbing, so two parts of the app
   *  are not fighting over one MediaStream). */
  function createMicSource(opts) {
    opts = opts || {};
    var getUserMedia = opts.getUserMedia || (typeof navigator !== 'undefined' && navigator.mediaDevices && function (c) { return navigator.mediaDevices.getUserMedia(c); });
    var AudioContextCtor = opts.AudioContext || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
    var MediaRecorderCtor = opts.MediaRecorder || (typeof window !== 'undefined' && window.MediaRecorder) || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined);
    if (!getUserMedia) return Promise.reject(new Error('voice: no microphone access (getUserMedia) available'));
    if (!AudioContextCtor) return Promise.reject(new Error('voice: no AudioContext available'));
    if (!MediaRecorderCtor) return Promise.reject(new Error('voice: no MediaRecorder available'));

    return Promise.resolve(getUserMedia({ audio: true })).then(function (stream) {
      var ctx = new AudioContextCtor();
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      var buf = new Float32Array(analyser.fftSize);

      function getLevel() {
        analyser.getFloatTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length); // RMS of one frame; silence is close to 0, speech well above it
      }

      function createRecorder() {
        var rec = new MediaRecorderCtor(stream);
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        return {
          start: function () { chunks = []; rec.start(); },
          stop: function () {
            return new Promise(function (resolve) {
              rec.onstop = function () { resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); };
              try { rec.stop(); } catch (e) { resolve(new Blob(chunks)); }
            });
          },
        };
      }

      function close() {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* already stopped */ }
        try { ctx.close(); } catch (e) { /* already closed */ }
      }

      return { levelSource: { getLevel: getLevel }, createRecorder: createRecorder, close: close };
    });
  }

  /** opts.levelSource + opts.createRecorder, both given together, or neither (real mic, via
   *  createMicSource). Resolves to { levelSource, createRecorder, close, owned }; `owned` is true
   *  only when this call opened the mic itself, so the caller knows whether it, not someone else's
   *  mic-button code, is responsible for closing it. */
  function resolveSource(opts) {
    if (opts.levelSource || opts.createRecorder) {
      if (!opts.levelSource || typeof opts.levelSource.getLevel !== 'function') return Promise.reject(new Error('voice: opts.levelSource.getLevel is required when opts.createRecorder is given'));
      if (typeof opts.createRecorder !== 'function') return Promise.reject(new Error('voice: opts.createRecorder is required when opts.levelSource is given'));
      return Promise.resolve({ levelSource: opts.levelSource, createRecorder: opts.createRecorder, close: null, owned: false });
    }
    return createMicSource(opts).then(function (s) { return { levelSource: s.levelSource, createRecorder: s.createRecorder, close: s.close, owned: true }; });
  }

  /** The shared state machine behind both startWakeListener and captureUtterance: poll
   *  levelSource.getLevel() every pollMs; once it has read >= threshold for minSpeechMs straight,
   *  start a recording (createRecorder().start()); once it then reads < threshold for silenceMs
   *  straight (or the segment runs past maxSegmentMs regardless), stop the recording and hand the
   *  clip to transcribe(). onSegment(text) fires for every clip that comes back with text, however
   *  short; it is on the caller (the wake-phrase check, or captureUtterance's single resolve) to
   *  decide what a result means. onSegmentError(err), if given, fires when transcribe() itself
   *  rejects for a clip (not when stop() aborted it on purpose - that is expected, not a failure);
   *  the loop keeps listening regardless, since one bad clip (or one ElevenLabs error) says nothing
   *  about the next one. Until 2026-10-14 a failed clip was dropped with no signal at all - neither
   *  onSegment nor any error - which is indistinguishable, from a caller with no way to inspect the
   *  VAD's internals, from the mic never having heard anything (found live: a wake listener
   *  configured with a real, working ElevenLabs key sat silent through real speech because every
   *  recorded clip's transcribe() call was failing and nothing ever said so). */
  function runVad(config) {
    config = config || {};
    var levelSource = config.levelSource;
    var createRecorder = config.createRecorder;
    var transcribe = config.transcribe;
    var onSegment = config.onSegment;
    var onSegmentError = typeof config.onSegmentError === 'function' ? config.onSegmentError : function () {};
    if (!levelSource || typeof levelSource.getLevel !== 'function') throw new Error('voice vad: levelSource is required');
    if (typeof createRecorder !== 'function') throw new Error('voice vad: createRecorder is required');
    if (typeof transcribe !== 'function') throw new Error('voice vad: transcribe is required');
    if (typeof onSegment !== 'function') throw new Error('voice vad: onSegment is required');

    var threshold = config.threshold != null ? config.threshold : 0.02;
    var pollMs = config.pollMs || 50;
    var silenceMs = config.silenceMs != null ? config.silenceMs : 800;
    var minSpeechMs = config.minSpeechMs != null ? config.minSpeechMs : 150;
    var maxSegmentMs = config.maxSegmentMs || 12000;

    var stopped = false;
    var timer = null;
    var recording = false;
    var activeRecorder = null;
    var speakingSince = 0;
    var silenceSince = 0;
    var segmentStartedAt = 0;
    var controller = null; // aborts a transcribe call still in flight when stop() is called

    function finishSegment(recorderToStop) {
      controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var signal = controller ? controller.signal : undefined;
      Promise.resolve(recorderToStop.stop()).then(function (blob) {
        if (stopped) return null;
        return transcribe(blob, { signal: signal });
      }).then(function (text) {
        controller = null;
        if (stopped || text == null) return;
        onSegment(text);
      }, function (err) {
        controller = null;
        if (stopped) return; // our own stop() aborted it on purpose - not a failure to report
        onSegmentError(err);
      });
    }

    function tick() {
      if (stopped) return;
      var level;
      try { level = levelSource.getLevel(); } catch (e) { level = 0; }
      var speaking = level >= threshold;
      var now = Date.now();
      if (!recording) {
        if (speaking) {
          if (!speakingSince) speakingSince = now;
          if (now - speakingSince >= minSpeechMs) {
            var rec;
            try { rec = createRecorder(); rec.start(); } catch (e) { speakingSince = 0; return; }
            activeRecorder = rec;
            recording = true;
            segmentStartedAt = now;
            silenceSince = 0;
          }
        } else {
          speakingSince = 0;
        }
        return;
      }
      if (speaking) silenceSince = 0;
      else if (!silenceSince) silenceSince = now;
      var tooLong = now - segmentStartedAt >= maxSegmentMs;
      var paused = silenceSince && now - silenceSince >= silenceMs;
      if (tooLong || paused) {
        var done = activeRecorder;
        activeRecorder = null;
        recording = false;
        speakingSince = 0;
        silenceSince = 0;
        finishSegment(done);
      }
    }

    timer = setInterval(tick, pollMs);

    return {
      stop: function () {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        if (controller) { try { controller.abort(); } catch (e) { /* best effort */ } }
        if (recording && activeRecorder) { try { activeRecorder.stop(); } catch (e) { /* best effort */ } }
        recording = false;
      },
    };
  }

  // ---------------------------------------------------------------- wake phrase + utterance capture

  var activeWakeListener = null; // the one wake listener this module runs at a time

  /** Listens on the mic in the background for opts.phrase, without streaming everything to the
   *  provider: runVad only sends a clip to transcribe() once the VAD has seen actual speech. A clip
   *  whose transcript contains opts.phrase (case-insensitive substring - deliberately simple, not a
   *  fuzzy matcher) calls opts.onWake(text); every other clip is dropped, optionally surfaced through
   *  opts.onCandidate(text) for a "didn't catch that" debug affordance. opts.onTranscribeError(err),
   *  if given, fires whenever a clip's transcribe() call itself fails (an ElevenLabs error, a
   *  network blip) - distinct from opts.onError below, which only ever fires once, for a listener
   *  that could not start at all (no microphone, no AudioContext). A caller that wires only
   *  onCandidate can otherwise not tell "listening fine, nothing matched yet" apart from "every
   *  clip is failing to transcribe," which looks identical to the user as the mic just not working.
   *  Returns a function that stops everything this call started (the VAD loop, and the
   *  mic/AudioContext if this call opened them - never a mic a caller supplied itself); starting a
   *  new listener stops any previous one first, so only one ever runs. opts.transcribe is required:
   *  typically a configured client's own transcribe, e.g. window.__aionDxVoice.transcribe.
   *  opts.levelSource + opts.createRecorder are optional - give both to reuse a mic stream the UI
   *  already owns, or neither to let this open the real mic itself. */
  function startWakeListener(opts) {
    opts = opts || {};
    var phrase = String(opts.phrase || '').trim().toLowerCase();
    if (!phrase) throw new Error('voice wake listener: opts.phrase is required');
    if (typeof opts.transcribe !== 'function') throw new Error('voice wake listener: opts.transcribe is required');
    var onWake = typeof opts.onWake === 'function' ? opts.onWake : function () {};
    var onCandidate = typeof opts.onCandidate === 'function' ? opts.onCandidate : null;
    var onTranscribeError = typeof opts.onTranscribeError === 'function' ? opts.onTranscribeError : function () {};

    if (activeWakeListener) activeWakeListener.stop();

    var stopped = false;
    var vad = null;
    var ownedClose = null;
    var handle = {
      stop: function () {
        if (stopped) return;
        stopped = true;
        if (vad) vad.stop();
        if (ownedClose) ownedClose();
        if (activeWakeListener === handle) activeWakeListener = null;
      },
    };
    activeWakeListener = handle;

    resolveSource(opts).then(function (src) {
      if (stopped) { if (src.owned && src.close) src.close(); return; }
      if (src.owned) ownedClose = src.close;
      vad = runVad({
        levelSource: src.levelSource,
        createRecorder: src.createRecorder,
        transcribe: opts.transcribe,
        threshold: opts.threshold,
        pollMs: opts.pollMs,
        silenceMs: opts.silenceMs,
        minSpeechMs: opts.minSpeechMs,
        maxSegmentMs: opts.maxSegmentMs,
        onSegment: function (text) {
          if (onCandidate) onCandidate(text);
          if (String(text || '').toLowerCase().indexOf(phrase) >= 0) onWake(text);
        },
        onSegmentError: onTranscribeError,
      });
    }, function (err) {
      handle.stop();
      if (typeof opts.onError === 'function') opts.onError(err);
    });

    return handle.stop;
  }

  /** Stops whichever wake listener is currently running (a no-op if none is). The same as calling
   *  the stop function startWakeListener returned, for a caller that did not keep it. */
  function stopWakeListener() {
    if (activeWakeListener) activeWakeListener.stop();
  }

  /** One hands-free turn: wait for speech, then a pause, then resolve with its transcript - the
   *  same VAD and the same clip-to-transcribe() path as the wake listener, just a single segment
   *  instead of a loop. opts.maxMs (default 15000) bounds the whole call, including opening the mic
   *  and waiting for the user to start talking; it rejects, never resolves with '', when nothing was
   *  said in time. opts.signal (a standard AbortSignal) cancels it early - stop-all wiring can pass
   *  the same signal it uses elsewhere. If the one segment this call records fails to transcribe
   *  (an ElevenLabs error, a network blip), the whole call rejects with that error right away -
   *  there is no "next segment" to retry, unlike the wake listener's onTranscribeError, which just
   *  reports and keeps listening. Same opts as startWakeListener otherwise (transcribe required;
   *  levelSource/createRecorder optional). */
  function captureUtterance(opts) {
    opts = opts || {};
    if (typeof opts.transcribe !== 'function') return Promise.reject(new Error('voice captureUtterance: opts.transcribe is required'));
    var maxMs = opts.maxMs != null ? opts.maxMs : 15000;

    return new Promise(function (resolve, reject) {
      var settled = false;
      var vad = null;
      var ownedClose = null;
      var overallTimer = null;

      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        if (overallTimer) clearTimeout(overallTimer);
        if (vad) vad.stop();
        if (ownedClose) ownedClose();
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        fn(arg);
      }

      function onAbort() { finish(reject, new Error('voice captureUtterance: aborted')); }

      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return; }
        opts.signal.addEventListener('abort', onAbort);
      }

      overallTimer = setTimeout(function () { finish(reject, new Error('voice captureUtterance: timed out waiting for speech')); }, maxMs);

      resolveSource(opts).then(function (src) {
        if (settled) { if (src.owned && src.close) src.close(); return; }
        if (src.owned) ownedClose = src.close;
        vad = runVad({
          levelSource: src.levelSource,
          createRecorder: src.createRecorder,
          transcribe: opts.transcribe,
          threshold: opts.threshold,
          pollMs: opts.pollMs,
          silenceMs: opts.silenceMs,
          minSpeechMs: opts.minSpeechMs,
          maxSegmentMs: opts.maxSegmentMs,
          onSegment: function (text) { finish(resolve, text); },
          // One-shot: unlike the wake listener, there is no "next segment" to keep trying, so a
          // failed transcribe() rejects captureUtterance right away instead of silently waiting
          // out maxMs for a segment that already happened and failed.
          onSegmentError: function (err) { finish(reject, err); },
        });
      }, function (err) { finish(reject, err); });
    });
  }

  return {
    VOICE_CONFIG_KEY: VOICE_CONFIG_KEY,
    createSettingsStore: createSettingsStore,
    createElevenLabsProvider: createElevenLabsProvider,
    listProviders: listProviders,
    createProvider: createProvider,
    createVoiceClient: createVoiceClient,
    createMicSource: createMicSource,
    startWakeListener: startWakeListener,
    stopWakeListener: stopWakeListener,
    captureUtterance: captureUtterance,
  };
});
