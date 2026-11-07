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
  // ElevenLabs' models page (checked 2026-11-07): Flash v2.5 is the low-latency model for the plain
  // text-to-speech endpoint, ~100 ms median, where Multilingual v2 (also the API's own default when
  // model_id is left out) starts noticeably slower; 32 languages, half the price per character. Turbo
  // v2.5 is deprecated in its favour. A settings record's modelId overrides it.
  var ELEVEN_DEFAULT_TTS_MODEL = 'eleven_flash_v2_5';

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

  /** The language to transcribe in when the settings name none: the UI's own language ("en-US" ->
   *  "en"), else English. */
  function defaultLanguageCode() {
    var tag = (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages && navigator.languages[0]))) || '';
    var m = /^([a-z]{2,3})(?![a-z])/i.exec(String(tag));
    return m ? m[1].toLowerCase() : 'en';
  }

  /** opts: { apiKey, voiceId? (default voice when a call does not name one), modelId? (default TTS
   *  model), languageCode? (speech to text: ISO-639-1 or -3, 'auto' to let ElevenLabs detect it;
   *  default the UI's language), fetch? (for tests) }. */
  function createElevenLabsProvider(opts) {
    opts = opts || {};
    var apiKey = opts.apiKey || '';
    var defaultVoiceId = opts.voiceId || ELEVEN_DEFAULT_VOICE_ID;
    var defaultModelId = opts.modelId || ELEVEN_DEFAULT_TTS_MODEL;
    var defaultLanguage = opts.languageCode || defaultLanguageCode();
    var fetchImpl = opts.fetch || fetch;

    function authHeaders(extra) {
      return Object.assign({ 'xi-api-key': apiKey }, extra || {});
    }

    return {
      id: 'elevenlabs',
      name: 'ElevenLabs',

      /** synthOpts: { voiceId?, modelId?, previousText?, nextText?, signal? }. previousText/nextText
       *  are ElevenLabs' own continuity fields, so a reply spoken in pieces keeps its intonation
       *  across the joins; signal aborts the request (stop-all). */
      synthesize: function (text, synthOpts) {
        synthOpts = synthOpts || {};
        if (!apiKey) return Promise.reject(new Error('elevenlabs: no API key configured'));
        if (!text || !String(text).trim()) return Promise.reject(new Error('elevenlabs: no text to speak'));
        var voiceId = synthOpts.voiceId || defaultVoiceId;
        var body = { text: String(text), model_id: synthOpts.modelId || defaultModelId };
        if (synthOpts.previousText) body.previous_text = String(synthOpts.previousText);
        if (synthOpts.nextText) body.next_text = String(synthOpts.nextText);
        return fetchImpl(ELEVEN_BASE + '/v1/text-to-speech/' + encodeURIComponent(voiceId), {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
          body: JSON.stringify(body),
          signal: synthOpts.signal,
        }).then(function (r) {
          if (!r.ok) return errorText(r).then(function (t) { throw new Error('elevenlabs synthesize failed: http ' + r.status + (t ? ' ' + t : '')); });
          return r.blob();
        });
      },

      /** transcribeOpts: { signal?, languageCode? }. The language is always sent (unless it is
       *  'auto'): left to detect, ElevenLabs heard a short "eh?" as Japanese and a tap as Chinese
       *  (test report, 2026-11-07). Sound tags ("[laughter]", "[drumming]") are switched off, since
       *  a message made of one is never what the user said. */
      transcribe: function (audio, transcribeOpts) {
        if (!apiKey) return Promise.reject(new Error('elevenlabs: no API key configured'));
        if (!audio) return Promise.reject(new Error('elevenlabs: no audio to transcribe'));
        var lang = (transcribeOpts && transcribeOpts.languageCode) || defaultLanguage;
        var form = new FormData();
        form.append('model_id', 'scribe_v1');
        form.append('file', audio, 'audio');
        if (lang && lang !== 'auto') form.append('language_code', String(lang));
        form.append('tag_audio_events', 'false');
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
      return !!a && !!b && a.provider === b.provider && a.apiKey === b.apiKey && a.voiceId === b.voiceId && a.modelId === b.modelId && a.languageCode === b.languageCode;
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
      // extra: { previousText, nextText, signal, modelId }, what playChunked passes for each piece.
      synthesize: function (text, voiceId, extra) {
        var o = Object.assign({}, extra || {});
        if (voiceId) o.voiceId = voiceId;
        return currentProvider().then(function (p) { return p.synthesize(text, o); });
      },
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

    // Echo cancellation keeps a reply read aloud out of the microphone, which barge-in depends on.
    // Asked for explicitly and read back: getSettings() says what the device actually applied.
    var constraints = opts.audioConstraints || { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    return Promise.resolve(getUserMedia({ audio: constraints })).then(function (stream) {
      var applied = { echoCancellation: null, noiseSuppression: null, autoGainControl: null };
      try {
        var track = stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
        var got = (track && track.getSettings && track.getSettings()) || {};
        Object.keys(applied).forEach(function (k) { if (typeof got[k] === 'boolean') applied[k] = got[k]; });
      } catch (e) { /* settings unknown: left null */ }
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

      return { levelSource: { getLevel: getLevel }, createRecorder: createRecorder, close: close, settings: applied };
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
      return Promise.resolve({ levelSource: opts.levelSource, createRecorder: opts.createRecorder, close: null, owned: false, settings: opts.micSettings || null });
    }
    return createMicSource(opts).then(function (s) { return { levelSource: s.levelSource, createRecorder: s.createRecorder, close: s.close, owned: true, settings: s.settings }; });
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
        return transcribe(blob, config.languageCode ? { signal: signal, languageCode: config.languageCode } : { signal: signal });
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
        // The recording starts with the first loud frame and is thrown away if the sound does not
        // last minSpeechMs: until 2026-11-07 it started only after minSpeechMs, so every clip lost
        // its first syllable or two (the test report's fragment "it and" is the kind of result).
        if (speaking) {
          if (!speakingSince) {
            speakingSince = now;
            try { activeRecorder = createRecorder(); activeRecorder.start(); } catch (e) { activeRecorder = null; speakingSince = 0; return; }
          }
          if (now - speakingSince >= minSpeechMs) {
            recording = true;
            segmentStartedAt = speakingSince;
            silenceSince = 0;
          }
        } else if (speakingSince) {
          speakingSince = 0;
          var tooShort = activeRecorder;
          activeRecorder = null;
          if (tooShort) { try { Promise.resolve(tooShort.stop()).catch(function () {}); } catch (e) { /* discarded anyway */ } }
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
        if (activeRecorder) { try { Promise.resolve(activeRecorder.stop()).catch(function () {}); } catch (e) { /* best effort */ } }
        activeRecorder = null;
        recording = false;
      },
    };
  }

  // ---------------------------------------------------------------- wake phrase matching

  /** Lowercase, accents and punctuation gone, "decks"/"ecks" read as the letter x (how a
   *  transcriber spells a spoken "DX"), "okay" as "ok" (transcribers write either), single spaces. */
  function normalizeSpoken(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/(?:ecks|eks|cks)\b/g, 'x')
      .replace(/\bokay\b/g, 'ok')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function editDistance(a, b) {
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }

  var VOWELS = 'aeiouy';

  /** Whether a transcript contains the wake phrase as a speech transcriber is likely to write it.
   *  A made-up name like "AionDX" comes back as "AonDX", "AMD X", "Android X" or "Aion DX" (heard
   *  live, 2026-11-06), so an exact substring almost never matched. The rule, for a phrase of two or
   *  more words, "<greeting> <name>":
   *  1. some word of the transcript is within one edit of the greeting ("hey", "hay", "hei");
   *  2. right after it, the name with spaces removed ("aiondx") is matched against the start of the
   *     rest of the transcript, also with spaces removed, by edit distance, allowing up to
   *     round(length x tolerance) edits (6 letters at the default 0.6: 4 edits);
   *  3. the matched stretch must end with the name's last two letters exactly ("dx") and start with
   *     the same kind of sound (vowel or consonant) as the name.
   *  Rule 3 is what keeps ordinary speech out: "hey Android", "hey index", "hey Aiden" and "hey the
   *  DX build" all fail it. A one-word phrase skips rule 1 and is looked for at any word.
   *  Returns { matched, distance, maxEdits }; distance is Infinity when nothing was close. */
  function matchWakePhrase(text, phrase, opts) {
    var tolerance = opts && opts.tolerance != null ? opts.tolerance : 0.6;
    var words = normalizeSpoken(phrase).split(' ').filter(Boolean);
    if (!words.length) return { matched: false, distance: Infinity, maxEdits: 0 };
    var greeting = words.length > 1 ? words[0] : '';
    var name = words.slice(greeting ? 1 : 0).join('');
    var ending = name.slice(-2);
    var nameVowel = VOWELS.indexOf(name[0]) >= 0;
    var maxEdits = Math.round(name.length * tolerance);
    var heard = normalizeSpoken(text).split(' ').filter(Boolean);
    var best = Infinity;
    for (var i = 0; i < heard.length; i++) {
      if (greeting && editDistance(heard[i], greeting) > (greeting.length >= 3 ? 1 : 0)) continue;
      var rest = heard.slice(greeting ? i + 1 : i).join('');
      if (!rest || (VOWELS.indexOf(rest[0]) >= 0) !== nameVowel) continue;
      var longest = Math.min(rest.length, name.length + maxEdits);
      for (var len = ending.length; len <= longest; len++) {
        var stretch = rest.slice(0, len);
        if (stretch.slice(-ending.length) !== ending) continue;
        best = Math.min(best, editDistance(name, stretch));
      }
    }
    return { matched: best <= maxEdits, distance: best, maxEdits: maxEdits };
  }

  // ---------------------------------------------------------------- which transcripts are worth sending

  // A sound tag in brackets, parentheses or asterisks, ASCII or full-width: "[laughter]", "(music)",
  // a Chinese "[drumming]" from the test report, "*coughs*".
  var SOUND_TAG = /\[[^\]]*\]|\([^)]*\)|\uFF08[^\uFF09]*\uFF09|\u3010[^\u3011]*\u3011|\*[^*\s][^*]*\*/g;
  // Words a sentence cannot end on, so a clip of three words or fewer ending on one was cut off or
  // overheard ("it and", from the test report). "on", "in", "it" and the like are left out on purpose:
  // "turn it on", "check it in", "do it" are whole requests.
  var DANGLING = ['and', 'or', 'but', 'nor', 'the', 'a', 'an', 'of', 'because', 'than'];
  // Languages written in Latin script: when one of these is locked, a clip with no Latin letter in
  // it was not said in that language (the report's Japanese "eh?").
  var LATIN_LANGS = ['en', 'eng', 'fr', 'fra', 'de', 'deu', 'es', 'spa', 'it', 'ita', 'pt', 'por', 'nl', 'nld', 'sv', 'swe',
    'da', 'dan', 'no', 'nor', 'nb', 'fi', 'fin', 'pl', 'pol', 'cs', 'ces', 'sk', 'slk', 'ro', 'ron', 'hu', 'hun', 'tr', 'tur',
    'id', 'ind', 'ms', 'msa', 'vi', 'vie', 'hr', 'hrv', 'sl', 'slv', 'et', 'est', 'lv', 'lav', 'lt', 'lit', 'ca', 'cat', 'tl', 'fil'];

  /** Decides whether a transcript is something the user said, before anything is sent anywhere.
   *  opts: { minWords (default 1), minChars (letters and digits, default 2), languageCode }.
   *  Returns { keep, text, reason }: text has its sound tags removed and spaces tidied; reason, when
   *  keep is false, is one of 'empty', 'sound-tag' (nothing but tags), 'wrong-language' (no Latin
   *  letter while a Latin-script language is locked), 'too-short', 'fragment'. */
  function cleanTranscript(text, opts) {
    opts = opts || {};
    var minWords = opts.minWords != null ? opts.minWords : 1;
    var minChars = opts.minChars != null ? opts.minChars : 2;
    var raw = String(text == null ? '' : text).trim();
    var hadTags = raw.replace(SOUND_TAG, '') !== raw;
    var kept = raw.replace(SOUND_TAG, ' ').replace(/\s+/g, ' ').trim();
    var words = kept.split(' ').filter(function (w) { return /[\p{L}\p{N}]/u.test(w); });
    var letters = kept.replace(/[^\p{L}\p{N}]/gu, '');
    var result = function (keep, reason) { return { keep: keep, text: keep ? kept : '', reason: reason || null }; };
    if (!words.length) return result(false, hadTags ? 'sound-tag' : 'empty');
    var lang = String(opts.languageCode || '').toLowerCase();
    if (LATIN_LANGS.indexOf(lang) >= 0 && !/[A-Za-z\u00C0-\u024F]/.test(kept)) return result(false, 'wrong-language');
    if (words.length < minWords || letters.length < minChars) return result(false, 'too-short');
    var last = words[words.length - 1].toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
    if (words.length <= 3 && DANGLING.indexOf(last) >= 0 && !/[?!]$/.test(kept)) return result(false, 'fragment');
    return result(true);
  }

  var STOP_WORDS = ['stop', 'wait', 'hold on', 'hang on', 'pause', 'stop talking', 'be quiet', 'quiet', 'enough', 'thats enough', 'shush', 'shh'];

  /** Whether a whole transcript is just a request to stop or wait ("Stop.", "wait a second",
   *  "okay, hold on"), as opposed to something to send. Barge-in uses it: a reply interrupted with
   *  "stop" should stop, not send the agent the word "stop". */
  function isStopCommand(text) {
    var t = normalizeSpoken(text)
      .replace(/^(?:(?:ok|hey|oh|no|please|uh|um)\s+)+/, '')
      .replace(/(?:\s+(?:please|now|a (?:second|sec|minute|moment)|for a (?:second|sec|minute|moment)|there|it))+$/, '');
    return STOP_WORDS.indexOf(t) >= 0;
  }

  // ---------------------------------------------------------------- wake phrase + utterance capture

  var activeWakeListener = null; // the one wake listener this module runs at a time

  /** Listens on the mic in the background for opts.phrase, without streaming everything to the
   *  provider: runVad only sends a clip to transcribe() once the VAD has seen actual speech. A clip
   *  whose transcript matches opts.phrase (matchWakePhrase: tolerant of how a transcriber spells a
   *  made-up name; opts.tolerance tunes it) calls opts.onWake(text); every clip, matched or not, is
   *  first passed to opts.onCandidate(text, { matched, distance, dropped }) so the UI can show what was
   *  heard (dropped: why cleanTranscript would not send it, or null; a dropped clip never wakes).
   *  opts.languageCode, when given, goes to every transcribe() call and to the filter. opts.onTranscribeError(err),
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
    var phrase = String(opts.phrase || '').trim();
    if (!normalizeSpoken(phrase)) throw new Error('voice wake listener: opts.phrase is required');
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
        languageCode: opts.languageCode,
        onSegment: function (text) {
          var c = cleanTranscript(text, { languageCode: opts.languageCode });
          var m = c.keep ? matchWakePhrase(c.text, phrase, { tolerance: opts.tolerance }) : { matched: false, distance: Infinity };
          if (onCandidate) onCandidate(text, { matched: m.matched, distance: m.distance, dropped: c.keep ? null : c.reason });
          if (m.matched) onWake(c.text);
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
   *  reports and keeps listening. A clip cleanTranscript would not send (opts.minWords, opts.minChars,
   *  opts.languageCode) does not end the call: it goes to opts.onCandidate(text, { dropped: reason })
   *  and listening goes on; a kept one is reported with dropped: null and resolves, sound tags
   *  removed. Same opts as startWakeListener otherwise (transcribe required; levelSource/
   *  createRecorder optional). */
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
          languageCode: opts.languageCode,
          // A clip that is not worth sending (a sound tag, a fragment, the wrong language) is
          // reported and the call keeps listening for the real utterance, until maxMs.
          onSegment: function (text) {
            var c = cleanTranscript(text, { minWords: opts.minWords, minChars: opts.minChars, languageCode: opts.languageCode });
            if (typeof opts.onCandidate === 'function') opts.onCandidate(text, { dropped: c.keep ? null : c.reason });
            if (c.keep) finish(resolve, c.text);
          },
          // One-shot: unlike the wake listener, there is no "next segment" to keep trying, so a
          // failed transcribe() rejects captureUtterance right away instead of silently waiting
          // out maxMs for a segment that already happened and failed.
          onSegmentError: function (err) { finish(reject, err); },
        });
      }, function (err) { finish(reject, err); });
    });
  }

  // ---------------------------------------------------------------- barge-in: talking over a reply

  var activeBargeIn = null; // the one barge-in listener this module runs at a time

  /** Listens while a reply is read aloud and fires once when the user starts talking over it.
   *  The hazard is the reply itself: what leaks from the speakers into the microphone must never
   *  count as the user. Three guards:
   *  - the microphone is opened with echoCancellation, noiseSuppression and autoGainControl, and what
   *    the device really applied is read back and passed to opts.onReady(settings); without echo
   *    cancellation the margin and the minimum speech time below are raised by half;
   *  - a floor follows the level the reply itself produces: the median (floorPercentile 0.5) of the last
   *    floorWindowMs (1500) of frames below the trigger, collected from the start (nothing fires in
   *    the first warmupMs). A percentile, not an average: an average rose with every loud stretch of
   *    the reply and left the trigger too high for the user right after one. The trigger is
   *    max(threshold, floor x margin): the reply can swing up to margin x its median, for any length
   *    of time, without firing it; speech on top of the reply has to clear that;
   *  - the sound has to stay above the trigger for minSpeechMs, allowing dips of up to gapMs between
   *    syllables.
   *  The recording starts at the first frame above the trigger, so nothing the user said is lost,
   *  and is thrown away (never transcribed) if the sound does not last.
   *  opts: { onBargeIn(event), transcribe (for event.capture), onReady(settings), onError(err),
   *  onCandidate(text, { dropped }), languageCode, minWords, minChars, threshold (0.06),
   *  margin (2.5), minSpeechMs (300), gapMs (120), warmupMs (250), pollMs (30), floorWindowMs (1500),
   *  floorPercentile (0.5),
   *  captureThreshold (0.02), silenceMs (800), maxSegmentMs (15000), levelSource + createRecorder
   *  (a mic the caller owns; micSettings to describe it), the createMicSource options otherwise }.
   *  event: { at, level, floor, capture(captureOpts) -> Promise<string>, cancel() }.
   *  The UI stops playback on onBargeIn, then calls event.capture(): it goes on recording the same
   *  clip until the user pauses (captureThreshold, silenceMs; playback is expected to be stopped by
   *  then), transcribes it, and resolves with the cleaned text, or '' when cleanTranscript dropped it
   *  (reported to onCandidate with the reason). isStopCommand(text) tells "stop"/"wait" apart from
   *  something to send. event.cancel() discards the clip. Either way the microphone is released
   *  afterwards when this call opened it. Fires at most once; start a new listener for the next reply.
   *  Returns stop(): ends everything this call started at once, including a capture in progress,
   *  whose promise rejects ("stopped") and whose transcribe() request is aborted. Starting a new
   *  listener stops the previous one. */
  function startBargeInListener(opts) {
    opts = opts || {};
    var onBargeIn = typeof opts.onBargeIn === 'function' ? opts.onBargeIn : function () {};
    var threshold = opts.threshold != null ? opts.threshold : 0.06;
    var margin = opts.margin || 2.5;
    var minSpeechMs = opts.minSpeechMs != null ? opts.minSpeechMs : 300;
    var gapMs = opts.gapMs != null ? opts.gapMs : 120;
    var warmupMs = opts.warmupMs != null ? opts.warmupMs : 250;
    var pollMs = opts.pollMs || 30;
    var floorWindowMs = opts.floorWindowMs || 1500;
    var floorPercentile = opts.floorPercentile != null ? opts.floorPercentile : 0.5;

    if (activeBargeIn) activeBargeIn.stop();

    var stopped = false;
    var fired = false;
    var timer = null;
    var src = null;
    var ownedClose = null;
    var startedAt = 0;
    var recent = []; // [time, level] of frames below the trigger, for the floor
    var floor = 0;
    var candidateSince = 0;
    var lastAbove = 0;
    var rec = null;
    var capturing = null;

    function level() { try { return src.levelSource.getLevel(); } catch (e) { return 0; } }
    function releaseMic() { if (ownedClose) { var c = ownedClose; ownedClose = null; try { c(); } catch (e) { /* already closed */ } } }
    function discard() {
      if (rec) { var r = rec; rec = null; try { Promise.resolve(r.stop()).catch(function () {}); } catch (e) { /* discarded anyway */ } }
      candidateSince = 0;
    }

    var handle = {
      stop: function () {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        if (capturing) capturing.abort();
        discard();
        releaseMic();
        if (activeBargeIn === handle) activeBargeIn = null;
      },
    };
    activeBargeIn = handle;

    function capture(captureOpts) {
      captureOpts = captureOpts || {};
      var transcribe = captureOpts.transcribe || opts.transcribe;
      if (stopped) return Promise.reject(new Error('voice barge-in: stopped'));
      if (capturing || !rec) return Promise.reject(new Error('voice barge-in: nothing to capture'));
      if (typeof transcribe !== 'function') return Promise.reject(new Error('voice barge-in: opts.transcribe is required to capture'));
      var silence = captureOpts.threshold != null ? captureOpts.threshold : (opts.captureThreshold != null ? opts.captureThreshold : 0.02);
      var silenceMs = captureOpts.silenceMs != null ? captureOpts.silenceMs : (opts.silenceMs != null ? opts.silenceMs : 800);
      var maxSegmentMs = captureOpts.maxSegmentMs || opts.maxSegmentMs || 15000;
      var lang = captureOpts.languageCode || opts.languageCode;
      var clip = rec;
      rec = null;
      var began = candidateSince || Date.now();
      return new Promise(function (resolve, reject) {
        var done = false;
        var ending = false;
        var silentSince = 0;
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var poll = null;
        function end(fn, arg) {
          if (done) return;
          done = true;
          clearInterval(poll);
          capturing = null;
          releaseMic();
          fn(arg);
        }
        capturing = {
          abort: function () {
            if (controller) { try { controller.abort(); } catch (e) { /* best effort */ } }
            if (!ending) { try { Promise.resolve(clip.stop()).catch(function () {}); } catch (e) { /* best effort */ } }
            end(reject, new Error('voice barge-in: stopped'));
          },
        };
        function finishClip() {
          if (ending) return;
          ending = true;
          clearInterval(poll);
          Promise.resolve(clip.stop()).then(function (blob) {
            if (done) return null;
            var t = { signal: controller ? controller.signal : undefined };
            if (lang) t.languageCode = lang;
            return transcribe(blob, t);
          }).then(function (text) {
            if (done) return;
            var c = cleanTranscript(text, { minWords: opts.minWords, minChars: opts.minChars, languageCode: lang });
            if (typeof opts.onCandidate === 'function') opts.onCandidate(text, { dropped: c.keep ? null : c.reason });
            end(resolve, c.text);
          }, function (err) { end(reject, err); });
        }
        poll = setInterval(function () {
          if (done || ending) return;
          var now = Date.now();
          if (level() >= silence) silentSince = 0;
          else if (!silentSince) silentSince = now;
          if ((silentSince && now - silentSince >= silenceMs) || now - began >= maxSegmentMs) finishClip();
        }, pollMs);
      });
    }

    function cancel() {
      if (capturing) return;
      discard();
      if (!stopped) { stopped = true; clearInterval(timer); if (activeBargeIn === handle) activeBargeIn = null; }
      releaseMic();
    }

    function tick() {
      if (stopped || fired) return;
      var lvl = level();
      var now = Date.now();
      while (recent.length && now - recent[0][0] > floorWindowMs) recent.shift();
      if (recent.length) {
        var sorted = recent.map(function (x) { return x[1]; }).sort(function (a, b) { return a - b; });
        floor = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * floorPercentile))];
      }
      if (now - startedAt < warmupMs) { recent.push([now, lvl]); return; }
      var trigger = Math.max(threshold, floor * margin);
      if (lvl >= trigger) {
        lastAbove = now;
        if (!candidateSince) {
          candidateSince = now;
          try { rec = src.createRecorder(); rec.start(); } catch (e) { rec = null; }
        }
        if (now - candidateSince >= minSpeechMs) {
          fired = true;
          clearInterval(timer);
          onBargeIn({ at: now, level: lvl, floor: floor, capture: capture, cancel: cancel });
        }
      } else {
        recent.push([now, lvl]);
        if (candidateSince && now - lastAbove > gapMs) discard();
      }
    }

    resolveSource(opts).then(function (s) {
      if (stopped) { if (s.owned && s.close) s.close(); return; }
      src = s;
      if (s.owned) ownedClose = s.close;
      var settings = s.settings || { echoCancellation: null, noiseSuppression: null, autoGainControl: null };
      if (settings.echoCancellation === false) { margin *= 1.5; minSpeechMs *= 1.5; }
      if (typeof opts.onReady === 'function') opts.onReady(Object.assign({}, settings, { margin: margin, minSpeechMs: minSpeechMs }));
      startedAt = Date.now();
      timer = setInterval(tick, pollMs);
    }, function (err) {
      handle.stop();
      if (typeof opts.onError === 'function') opts.onError(err);
    });

    return handle.stop;
  }

  /** Stops whichever barge-in listener is running, capture included; a no-op if none is. */
  function stopBargeInListener() {
    if (activeBargeIn) activeBargeIn.stop();
  }

  // ---------------------------------------------------------------- reading a reply in pieces

  /** Splits a reply into pieces for playChunked: a short first piece (whole sentences, at least
   *  opts.firstMin characters where the sentences allow, at most opts.firstMax), then pieces of
   *  whole sentences up to opts.chunkMax. A sentence longer than the limit is cut at its last comma,
   *  or else its last space, before the limit. */
  function splitForSpeech(text, opts) {
    opts = opts || {};
    var firstMin = opts.firstMin != null ? opts.firstMin : 40;
    var firstMax = opts.firstMax || 160;
    var chunkMax = opts.chunkMax || 400;
    var flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return [];
    // A sentence ends at . ! or ? (and any closing quote or bracket) followed by a space, so
    // "index.html" or "3.5" stays whole.
    var sentences = flat.split(/(?<=[.!?]["')\]]*)\s+/).filter(Boolean);

    function cut(s, max) {
      var out = [];
      while (s.length > max) {
        var at = s.lastIndexOf(', ', max - 1);   // the comma stays with the first half, so it must fit too
        if (at > max / 3) at += 1;
        else at = s.lastIndexOf(' ', max);
        if (at <= 0) at = max;
        out.push(s.slice(0, at).trim());
        s = s.slice(at).trim();
      }
      if (s) out.push(s);
      return out;
    }

    var pieces = [];
    var cur = '';
    var limit = firstMax;
    for (var i = 0; i < sentences.length; i++) {
      var parts = cut(sentences[i], limit);
      for (var j = 0; j < parts.length; j++) {
        var next = cur ? cur + ' ' + parts[j] : parts[j];
        var firstFull = !pieces.length && cur.length >= firstMin;
        if (cur && (next.length > limit || firstFull)) {
          pieces.push(cur);
          cur = parts[j];
          limit = chunkMax;
        } else {
          cur = next;
        }
      }
    }
    if (cur) pieces.push(cur);
    return pieces;
  }

  /** Reads text aloud piece by piece, so the first sound comes after one short piece is
   *  synthesized instead of the whole reply. The next piece is requested as soon as the current
   *  one has arrived, so it is normally ready by the time the current one ends; only one request is
   *  in flight at a time.
   *  opts: { text, synthesize(pieceText, { previousText, nextText, signal }) -> Promise<Blob>
   *  (a configured client's synthesize, wrapped to pass voiceId), onStart(), onEnd(), onError(err),
   *  splitForSpeech's firstMin/firstMax/chunkMax, and for tests Audio, createObjectURL,
   *  revokeObjectURL }. Returns { pause(), done, pieces }: pause() stops at once, aborting the
   *  request in flight, stopping the audio and releasing its URL, and after it no callback fires;
   *  done resolves with 'end', 'error' or 'stopped'. pause() lets the result stand in for an Audio
   *  element wherever a caller only ever pauses one. */
  function playChunked(opts) {
    opts = opts || {};
    var pieces = splitForSpeech(opts.text, opts);
    var AudioCtor = opts.Audio || (typeof Audio !== 'undefined' ? Audio : null);
    var makeUrl = opts.createObjectURL || function (b) { return URL.createObjectURL(b); };
    var dropUrl = opts.revokeObjectURL || function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* already gone */ } };
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var stopped = false;
    var started = false;
    var audio = null;
    var url = null;
    var requests = [];
    var settle;
    var done = new Promise(function (r) { settle = r; });

    function release() {
      if (controller) { try { controller.abort(); } catch (e) { /* best effort */ } }
      if (audio) { try { audio.pause(); } catch (e) { /* best effort */ } audio = null; }
      if (url) { dropUrl(url); url = null; }
    }

    function finish(kind, err) {
      if (stopped) return;
      stopped = true;
      release();
      if (kind === 'end' && typeof opts.onEnd === 'function') opts.onEnd();
      if (kind === 'error' && typeof opts.onError === 'function') opts.onError(err);
      settle(kind);
    }

    function request(i) {
      if (!requests[i]) {
        requests[i] = Promise.resolve().then(function () {
          return opts.synthesize(pieces[i], {
            previousText: i > 0 ? pieces[i - 1] : undefined,
            nextText: i + 1 < pieces.length ? pieces[i + 1] : undefined,
            signal: controller ? controller.signal : undefined,
          });
        });
        requests[i].catch(function () { /* reported when this piece's turn comes */ });
      }
      return requests[i];
    }

    function playAt(i) {
      if (stopped) return;
      if (i >= pieces.length) { finish('end'); return; }
      request(i).then(function (blob) {
        if (stopped) return;
        if (i + 1 < pieces.length) request(i + 1);
        if (url) dropUrl(url);
        url = makeUrl(blob);
        var a = new AudioCtor(url);
        audio = a;
        a.addEventListener('ended', function () { if (!stopped && audio === a) playAt(i + 1); });
        a.addEventListener('error', function () { if (!stopped && audio === a) finish('error', new Error('could not play the audio')); });
        return Promise.resolve(a.play()).then(function () {
          if (stopped || started) return;
          started = true;
          if (typeof opts.onStart === 'function') opts.onStart();
        });
      }).catch(function (e) { finish('error', e); });
    }

    if (typeof opts.synthesize !== 'function') Promise.resolve().then(function () { finish('error', new Error('voice playChunked: opts.synthesize is required')); });
    else if (!AudioCtor) Promise.resolve().then(function () { finish('error', new Error('voice playChunked: no Audio available')); });
    else if (!pieces.length) Promise.resolve().then(function () { finish('error', new Error('nothing to read')); });
    else playAt(0);

    return {
      pause: function () {
        if (stopped) return;
        stopped = true;
        release();
        settle('stopped');
      },
      done: done,
      pieces: pieces,
    };
  }

  return {
    VOICE_CONFIG_KEY: VOICE_CONFIG_KEY,
    createSettingsStore: createSettingsStore,
    createElevenLabsProvider: createElevenLabsProvider,
    listProviders: listProviders,
    createProvider: createProvider,
    createVoiceClient: createVoiceClient,
    createMicSource: createMicSource,
    matchWakePhrase: matchWakePhrase,
    startWakeListener: startWakeListener,
    stopWakeListener: stopWakeListener,
    captureUtterance: captureUtterance,
    cleanTranscript: cleanTranscript,
    isStopCommand: isStopCommand,
    startBargeInListener: startBargeInListener,
    stopBargeInListener: stopBargeInListener,
    defaultLanguageCode: defaultLanguageCode,
    splitForSpeech: splitForSpeech,
    playChunked: playChunked,
  };
});
