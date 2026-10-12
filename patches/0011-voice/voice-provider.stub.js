/* voice-provider.stub.js - a throwaway stand-in for window.__aionDxVoice, matching the
 * window.AionDxVoice.createVoiceClient(...) client the Voice Core Engineer built in
 * aiondx-voice.js (getSettings/setSettings are both Promise-returning there). For
 * dev-harness.html only: never wired into tools\build-release.ps1 and not part of the shipped
 * build. Delete once the UI switches over to the real module.
 */
(function () {
  if (window.__aionDxVoice) return;
  var settings = { provider: '', apiKey: '', voiceId: '' };
  window.__aionDxVoiceStubCalls = [];
  function log(name, args) { window.__aionDxVoiceStubCalls.push({ name: name, args: args }); }
  function wavBlob(seconds) {
    // A silent 8kHz mono 8-bit WAV, generated rather than hand-encoded so its length (and so how
    // long the playback button stays in "playing") is easy to pick for a test.
    var sampleRate = 8000;
    var dataSize = Math.round(sampleRate * (seconds || 1));
    var buf = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buf);
    var writeStr = function (offset, s) { for (var i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    writeStr(36, 'data'); view.setUint32(40, dataSize, true);
    var samples = new Uint8Array(buf, 44);
    for (var i = 0; i < dataSize; i++) samples[i] = 128;   // silence, 8-bit unsigned PCM midpoint
    return new Blob([buf], { type: 'audio/wav' });
  }
  window.__aionDxVoice = {
    listProviders: function () {
      log('listProviders', []);
      return Promise.resolve([{ id: 'elevenlabs', name: 'ElevenLabs' }, { id: 'openai', name: 'OpenAI' }]);
    },
    listVoices: function () {
      log('listVoices', []);
      return Promise.resolve([{ id: 'rachel', name: 'Rachel' }, { id: 'adam', name: 'Adam' }]);
    },
    getSettings: function () {
      log('getSettings', []);
      return Promise.resolve(Object.assign({}, settings));
    },
    setSettings: function (patch) {
      log('setSettings', [patch]);
      Object.keys(patch || {}).forEach(function (k) { settings[k] = patch[k]; });
      return Promise.resolve(Object.assign({}, settings));   // the real module resolves the merged record
    },
    transcribe: function (blob) {
      log('transcribe', [blob ? blob.size : -1]);
      return new Promise(function (resolve) { setTimeout(function () { resolve('stub transcript ' + (blob ? blob.size : 0) + 'b'); }, 150); });
    },
    synthesize: function (text, voiceId) {
      log('synthesize', [text, voiceId]);
      return new Promise(function (resolve) { setTimeout(function () { resolve(wavBlob(1.5)); }, 150); });
    }
  };
})();
