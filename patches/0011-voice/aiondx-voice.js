/**
 * aiondx-voice.js - a provider-agnostic voice (text-to-speech / speech-to-text) module, with
 * ElevenLabs as the first provider. Used by the composer's mic button and playback controls
 * (patches\0011-voice, the UI half) and by anyone adding another provider later.
 *
 * ENVIRONMENT. This file depends on nothing but fetch, Blob and FormData, which Node 18+ and every
 * browser both have, so it runs unchanged in the renderer (as window.AionDxVoice, a plain global
 * script like aionui-dx.js) and under plain Node for its own tests (as module.exports). It touches
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

      transcribe: function (audio) {
        if (!apiKey) return Promise.reject(new Error('elevenlabs: no API key configured'));
        if (!audio) return Promise.reject(new Error('elevenlabs: no audio to transcribe'));
        var form = new FormData();
        form.append('model_id', 'scribe_v1');
        form.append('file', audio, 'audio');
        return fetchImpl(ELEVEN_BASE + '/v1/speech-to-text', {
          method: 'POST',
          headers: authHeaders(),
          body: form,
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
      transcribe: function (audioBlob) { return currentProvider().then(function (p) { return p.transcribe(audioBlob); }); },
      synthesize: function (text, voiceId) { return currentProvider().then(function (p) { return p.synthesize(text, voiceId ? { voiceId: voiceId } : undefined); }); },
      listVoices: function () { return currentProvider().then(function (p) { return p.listVoices ? p.listVoices() : []; }); },
      listProviders: function () { return Promise.resolve(listProviders()); },
      getSettings: function () { return store.getConfig().then(function (c) { return c || {}; }); },
      setSettings: function (patch) { cached = null; return store.setConfig(patch); },
    };
  }

  return {
    VOICE_CONFIG_KEY: VOICE_CONFIG_KEY,
    createSettingsStore: createSettingsStore,
    createElevenLabsProvider: createElevenLabsProvider,
    listProviders: listProviders,
    createProvider: createProvider,
    createVoiceClient: createVoiceClient,
  };
});
