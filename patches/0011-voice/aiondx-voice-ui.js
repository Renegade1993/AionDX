/* aiondx-voice-ui.js - injected into the AionUi renderer via a <script> tag, the same way
 * patches\0001-renderer-dx\aiondx-ui.js is (out\renderer\index.html inside app.asar).
 * AionDX patch 0011-voice, UI half (mic button, playback control, settings panel).
 *
 * This file owns the UI only. Speech-to-text, text-to-speech and where the provider's settings
 * are stored are a separate module (aiondx-voice.js, window.AionDxVoice, the Voice Core
 * Engineer's). This file only ever talks to the one client object it builds from that module,
 * kept at window.__aionDxVoice:
 *
 *   window.__aionDxVoice = AionDxVoice.createVoiceClient({ baseUrl: apiUrl(''), csrfToken: csrf })
 *
 *   transcribe(audioBlob: Blob): Promise<string>                recorded audio -> text
 *   synthesize(text: string, voiceId?: string): Promise<Blob>   text -> playable audio
 *   listVoices(): Promise<Array<{id, name}>>                    never rejects for "no voice list";
 *                                                                resolves [] instead
 *   listProviders(): Promise<Array<{id, name}>>
 *   getSettings(): Promise<{provider, apiKey, voiceId, at} | {}>
 *   setSettings(patch): Promise<the merged record>              setSettings({voiceId}) alone does
 *                                                                not drop the saved apiKey
 *
 * Until that module is wired in, window.__aionDxVoice is absent and every control here shows
 * disabled with "Voice module not loaded" rather than throwing: same "quietly stops appearing"
 * rule patch 0001 follows when its own anchors are missing.
 *
 * UI conventions copied from patch 0001 (read closely so the two don't drift apart):
 *   - composer buttons are Arco's own circle button classes, not invented ones:
 *     arco-btn arco-btn-secondary arco-btn-size-small arco-btn-shape-circle (28 x 28), so they
 *     inherit the app's font, hover and theme instead of imitating them.
 *   - colours come only from theme tokens (rgb(var(--primary-6)), rgb(var(--danger-6)),
 *     var(--color-text-3), ...), never hardcoded hex, so light and dark need no separate rules.
 *   - a settings section is added next to AionDX's existing ones on Settings > Appearance
 *     (anchored off patch 0001's own accent picker, or the theme gallery if 0001 is absent),
 *     not a one-off dialog.
 *   - the composer's textarea is React-controlled: a value set through the native setter, then
 *     an 'input' event, the same way patch 0001's setComposerValue does.
 *   - the DOM is rebuilt by React on layout changes, so a MutationObserver re-applies this
 *     script's nodes, throttled to one pass per animation frame, ignoring mutations inside its
 *     own elements.
 */
(function () {
  'use strict';
  if (window.__aionDxVoiceUiLoaded) return;
  window.__aionDxVoiceUiLoaded = true;

  var BUILD = '2026-10-11.1';
  var ERROR_HOLD_MS = 2600;   // how long a mic/playback button shows its error state before resetting
  var DEFAULT_WAKE_PHRASE = 'Hey AionDX';
  // Checked against a whole captured utterance, the same simple case-insensitive-substring rule
  // AionDxVoice.startWakeListener uses for its own wake phrase - not a fuzzy matcher.
  var HF_STOP_PHRASES = ['stop listening', 'stop conversation', 'exit voice mode', 'stop hands-free'];

  // ---------------------------------------------------------------- the provider module

  // Same backend-address and CSRF logic as patch 0001's apiUrl()/csrf(), reimplemented here since
  // aiondx-ui.js's are private to its own closure: a same-origin path silently fails in the
  // desktop app (see patch 0001's "Bug that shipped" section), so the voice client needs the
  // absolute http://127.0.0.1:<port> address too.
  function csrf() {
    if (window.__coreCsrfToken) return window.__coreCsrfToken;
    var m = document.cookie.match(/(?:^|;\s*)aionui-csrf-token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function apiUrl(path) {
    var port = window.__backendPort;
    return (port ? 'http://127.0.0.1:' + port : '') + path;
  }
  /** Which conversation or team is open, for hands-free mode's polling. Reimplemented rather than
   *  shared with aiondx-ui.js's own route(), same reasoning as apiUrl()/csrf() above. A team page
   *  (#/team/<id>) targets the lead's own column specifically - a user testing hands-free "on the
   *  lead agent" is on this route, not #/conversation/<id>, which is what the first version of
   *  this feature matched exclusively; a teammate's column is still out of scope. */
  function route() {
    var m = location.hash.match(/^#\/conversation\/([^/?#]+)/);
    if (m) return { kind: 'conv', id: m[1] };
    m = location.hash.match(/^#\/team\/([^/?#]+)/);
    if (m) return { kind: 'team', id: m[1] };
    return null;
  }
  /** window.AionDxVoice is aiondx-voice.js's module (its own script tag, loaded alongside this
   *  one). Building window.__aionDxVoice from it is deferred to here, rather than done inside
   *  aiondx-voice.js itself, since only this file knows the app's own request plumbing. A page
   *  that already set window.__aionDxVoice itself (dev-harness.html's stub) is left alone. */
  function ensureVoiceClient() {
    if (window.__aionDxVoice || !window.AionDxVoice || typeof window.AionDxVoice.createVoiceClient !== 'function') return;
    window.__aionDxVoice = window.AionDxVoice.createVoiceClient({ baseUrl: apiUrl(''), csrfToken: csrf });
  }

  function voice() { return window.__aionDxVoice || null; }
  function call(method) {
    var v = voice();
    if (!v || typeof v[method] !== 'function') return null;
    var args = Array.prototype.slice.call(arguments, 1);
    try { return v[method].apply(v, args); } catch (e) { console.log('[dx-voice] ' + method + ' threw', e); return null; }
  }

  // ---------------------------------------------------------------- style

  var CSS = [
    '.aiondx-voice-mic,.aiondx-voice-play,.aiondx-voice-stopall{display:inline-flex;align-items:center;justify-content:center}',
    '.aiondx-voice-mic-btn,.aiondx-voice-play-btn,.aiondx-voice-stopall-btn{display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1;position:relative}',
    '.aiondx-voice-mic-btn .aiondx-voice-icon,.aiondx-voice-play-btn .aiondx-voice-icon,.aiondx-voice-stopall-btn .aiondx-voice-icon{width:14px;height:14px;display:inline-flex;color:var(--text-secondary)}',
    '.aiondx-voice-play-btn .aiondx-voice-icon{width:12px;height:12px}',
    '.aiondx-voice-mic-btn .aiondx-voice-icon svg,.aiondx-voice-play-btn .aiondx-voice-icon svg,.aiondx-voice-stopall-btn .aiondx-voice-icon svg{width:100%;height:100%;display:block}',
    '.aiondx-voice-mic-btn[data-state="recording"]{color:#fff;background-color:rgb(var(--danger-6)) !important;border-color:rgb(var(--danger-6)) !important}',
    '.aiondx-voice-mic-btn[data-state="recording"] .aiondx-voice-icon{color:#fff}',
    '.aiondx-voice-mic-btn[data-state="recording"]{animation:aiondx-voice-pulse 1.4s ease-out infinite}',
    '.aiondx-voice-mic-btn[data-state="error"]{color:rgb(var(--danger-6)) !important}',
    '.aiondx-voice-mic-btn[data-state="transcribing"],.aiondx-voice-play-btn[data-state="loading"]{cursor:default}',
    '.aiondx-voice-mic-btn[data-state="transcribing"] .aiondx-voice-icon svg,.aiondx-voice-play-btn[data-state="loading"] .aiondx-voice-icon svg{animation:aiondx-voice-spin 0.9s linear infinite}',
    '.aiondx-voice-mic-btn[disabled],.aiondx-voice-play-btn[disabled],.aiondx-voice-stopall-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '.aiondx-voice-play-btn[data-state="playing"]{color:rgb(var(--primary-6)) !important}',
    '.aiondx-voice-play-btn[data-state="playing"] .aiondx-voice-icon{color:rgb(var(--primary-6))}',
    '.aiondx-voice-play-btn[data-state="playing"]{animation:aiondx-voice-pulse-soft 1.6s ease-out infinite}',
    '.aiondx-voice-stopall-btn[data-state="active"]{color:rgb(var(--primary-6)) !important}',
    '.aiondx-voice-stopall-btn[data-state="active"] .aiondx-voice-icon{color:rgb(var(--primary-6))}',
    '.aiondx-voice-stopall-btn[data-state="active"]{animation:aiondx-voice-pulse-soft 1.6s ease-out infinite}',
    '@keyframes aiondx-voice-pulse{0%{box-shadow:0 0 0 0 rgba(var(--danger-6),.45)}70%{box-shadow:0 0 0 7px rgba(var(--danger-6),0)}100%{box-shadow:0 0 0 0 rgba(var(--danger-6),0)}}',
    '@keyframes aiondx-voice-pulse-soft{0%{box-shadow:0 0 0 0 rgba(var(--primary-6),.35)}70%{box-shadow:0 0 0 6px rgba(var(--primary-6),0)}100%{box-shadow:0 0 0 0 rgba(var(--primary-6),0)}}',
    '@keyframes aiondx-voice-spin{to{transform:rotate(360deg)}}',
    '.aiondx-voice-playrow{margin-top:2px}',
    // The hands-free badge: a small status pill, never a button - it only ever reflects state.
    '.aiondx-voice-hf{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--color-text-3);white-space:nowrap;padding:0 4px;max-width:180px;overflow:hidden;text-overflow:ellipsis}',
    '.aiondx-voice-hf-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--color-text-3);flex:0 0 auto}',
    '.aiondx-voice-hf[data-state="wake"] .aiondx-voice-hf-dot{background:rgb(var(--primary-6));animation:aiondx-voice-pulse-soft 2.2s ease-out infinite}',
    '.aiondx-voice-hf[data-state="listening"] .aiondx-voice-hf-dot{background:rgb(var(--danger-6));animation:aiondx-voice-pulse 1.4s ease-out infinite}',
    '.aiondx-voice-hf[data-state="waiting-reply"] .aiondx-voice-hf-dot{background:rgb(var(--warning-6))}',
    '.aiondx-voice-hf[data-state="speaking"] .aiondx-voice-hf-dot{background:rgb(var(--primary-6))}',
    '.aiondx-voice-toggle{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--color-text-1);flex:1 1 auto}',
    // The settings panel, styled like patch 0001's accent picker (.aiondx-accent) so it reads as
    // the same product: a titled block under the AionDX colours card.
    '.aiondx-voice-panel{margin-top:16px;padding-top:16px;border-top:1px solid var(--color-fill-3)}',
    '.aiondx-voice-title{font-size:13px;font-weight:600;color:var(--color-text-1);margin-bottom:4px}',
    '.aiondx-voice-desc{font-size:12px;line-height:18px;color:var(--color-text-3);margin-bottom:10px}',
    '.aiondx-voice-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
    '.aiondx-voice-row label.aiondx-voice-label{flex:0 0 96px;font-size:12px;color:var(--color-text-2)}',
    '.aiondx-voice-row select,.aiondx-voice-row input[type="password"],.aiondx-voice-row input[type="text"]{',
    '  flex:1 1 auto;min-width:0;box-sizing:border-box;padding:4px 8px;border:1px solid var(--color-border-2,transparent);',
    '  border-radius:var(--border-radius-small,4px);background:var(--color-fill-2);color:var(--color-text-1);font:inherit;font-size:13px;outline:none}',
    '.aiondx-voice-row select:hover,.aiondx-voice-row input:hover{background:var(--color-fill-3)}',
    '.aiondx-voice-row select:focus,.aiondx-voice-row input:focus{border-color:rgb(var(--primary-6));background:var(--color-bg-2)}',
    '.aiondx-voice-note{font-size:12px;line-height:18px;color:var(--color-text-3);margin:-2px 0 10px}',
    '.aiondx-voice-status{font-size:12px;line-height:18px;color:var(--color-text-2);min-height:16px}',
    '.aiondx-voice-status[data-ok="0"]{color:rgb(var(--danger-6))}'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById('aiondx-voice-style')) return;
    var st = document.createElement('style');
    st.id = 'aiondx-voice-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- icons

  var ICON_MIC = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<rect x="17" y="4" width="14" height="24" rx="7" stroke="currentColor" stroke-width="4"/>' +
    '<path d="M10 22v2a14 14 0 0 0 28 0v-2" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M24 38v6M16 44h16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="13" y="13" width="22" height="22" rx="3" fill="currentColor"/></svg>';
  var ICON_SPINNER = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-dasharray="70 40"/></svg>';
  var ICON_SPEAKER = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<path d="M6 18v12h8l12 10V8L14 18H6Z" fill="currentColor"/>' +
    '<path d="M34 16a12 12 0 0 1 0 16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M39 10a20 20 0 0 1 0 28" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  var ICON_SPEAKER_MUTE = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<path d="M6 18v12h8l12 10V8L14 18H6Z" fill="currentColor"/>' +
    '<path d="M30 16l12 16M42 16L30 32" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';

  // ---------------------------------------------------------------- shared helpers

  /** Set a React-controlled text box: the prototype's setter, then an input event React hears.
   *  Same technique as patch 0001's setComposerValue, reimplemented here since that one is private
   *  to aiondx-ui.js's own closure. */
  function setComposerValue(ta, value) {
    var proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(ta, value); else ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertTranscript(ta, text) {
    text = String(text || '').trim();
    if (!text) return;
    var cur = ta.value || '';
    setComposerValue(ta, cur && cur.trim() ? cur.replace(/\s+$/, '') + ' ' + text : text);
    try { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (e) {}
  }

  /** Hands-free mode's turn: the mic button's own insertion path, then a click on the send button -
   *  "reuse that path, don't duplicate it" for the text landing in the box, plus the one extra step
   *  (send button, not just a click button) that only auto-send needs. */
  function sendComposerText(ta, text) {
    insertTranscript(ta, text);
    var panel = ta.closest('.sendbox-panel') || ta.parentElement;
    var actions = panel && panel.querySelector('.sendbox-actions');
    var sendBtn = actions && actions.querySelector('[data-testid="sendbox-send-btn"]');
    if (sendBtn && !sendBtn.disabled) sendBtn.click();
  }

  /** A reply's text sits in an open shadow root (ShadowView), not the host's own light DOM, so
   *  content.textContent alone is empty for a rendered agent message. */
  function messageText(content) {
    var sh = content.querySelector('.markdown-shadow');
    if (sh && sh.shadowRoot) return (sh.shadowRoot.textContent || '').trim();
    return (content.textContent || '').trim();
  }

  /** Markdown read character-by-character sounds broken (a user's report: a fenced code block came
   *  out as ElevenLabs sounding out punctuation and symbols). This turns a reply's raw markdown into
   *  something that reads naturally, before it ever reaches synthesize() - the TTS module stays a
   *  dumb client and knows nothing about markdown.
   *  Order matters: fenced blocks first (their own backticks would otherwise look like inline code
   *  spans), then inline code, then the line-level markers, then links, then whitespace. */
  function spokenText(raw) {
    var text = String(raw || '');
    text = text.replace(/```(\w+)?[^\n]*\n?[\s\S]*?```/g, function (m, lang) {
      return lang ? ' a snippet of ' + lang + ' code. ' : ' a code block. ';
    });
    text = text.replace(/`([^`\n]+)`/g, '$1');            // inline code: usually a short identifier, read plainly
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');        // headings
    text = text.replace(/(\*\*\*|___)(.+?)\1/g, '$2');     // bold+italic, longest marker first
    text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');        // bold
    text = text.replace(/(\*|_)(.+?)\1/g, '$2');           // italic
    text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');         // bullet lists
    text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '');       // numbered lists
    text = text.replace(/^\s{0,3}>\s?/gm, '');             // blockquotes
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // links: read the text, not the brackets or URL
    text = text.replace(/\s+/g, ' ').trim();               // collapse structural newlines into natural pauses
    return text;
  }

  function audioBlobFrom(result) {
    if (result instanceof Blob) return result;
    if (result && result.blob instanceof Blob) return result.blob;
    if (result instanceof ArrayBuffer) return new Blob([result], { type: 'audio/mpeg' });
    return null;
  }
  function audioUrlFrom(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result.url === 'string') return result.url;
    return null;
  }

  // ---------------------------------------------------------------- re-render scheduling

  // Pacing for long chats (2026-10-14, after the lag in chats of thousands of messages: AionUi draws every loaded message, and this file
  // walked every reply row on every change of the page). On a page with over 400 messages, the composer and reply scans run at most every
  // 400 ms, and a repaint that has just taken over 8 ms is followed by one only after eight times as long (at most 0.75 s). A small page
  // is painted on the next frame as before. A scan that was skipped books a repaint for when its interval is up.
  var BIG_PAGE_ROWS = 400;
  var bigAt = 0, bigVal = false;
  function bigPage() {
    var now = Date.now();
    if (now - bigAt < 1000) return bigVal;   // asked for many times a second; a sweep of a big page is not free
    bigAt = now;
    var ls = document.querySelectorAll('[data-testid="message-list-content"]');
    var n = 0;
    for (var i = 0; i < ls.length; i++) n += ls[i].childElementCount;
    bigVal = n > BIG_PAGE_ROWS;
    return bigVal;
  }
  var dueAt = {}, dueWait = {};
  function due(name, ms) {
    if (!bigPage()) return true;
    var now = Date.now();
    if (dueAt[name] && now - dueAt[name] < ms) {
      if (!dueWait[name]) dueWait[name] = setTimeout(function () { dueWait[name] = 0; schedule(); }, ms - (now - dueAt[name]) + 20);
      return false;
    }
    dueAt[name] = now;
    return true;
  }
  var scheduled = false, lastRenderMs = 0, lastRenderAt = 0;
  function timedRender() {
    var t0 = performance.now();
    render();
    lastRenderMs = performance.now() - t0;
    lastRenderAt = Date.now();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var wait = lastRenderMs > 8 && bigPage() ? Math.min(750, lastRenderMs * 8) - (Date.now() - lastRenderAt) : 0;
    if (wait > 0) setTimeout(function () { scheduled = false; timedRender(); }, wait);
    else requestAnimationFrame(function () { scheduled = false; timedRender(); });
  }
  /** True when at least one mutation touched something outside this script's own elements, so a
   *  change this script itself made (painting a button) does not re-trigger itself. */
  function foreignChange(records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (!t.closest || !t.closest('.aiondx-voice-mic, .aiondx-voice-play, .aiondx-voice-stopall, .aiondx-voice-hf, .aiondx-voice-panel')) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- mic button (composer)

  var activeMic = null;   // the one wrap currently recording or transcribing, across every composer

  function actionsInsertAnchor(actions) {
    return actions.querySelector('.sendbox-draft-tooltip-anchor') || actions.querySelector('.sendbox-send-tooltip-anchor') || null;
  }

  function setMicState(wrap, state, detail) {
    var st = wrap.__st;
    st.state = state;
    st.detail = detail || '';
    paintMic(wrap);
    if (state === 'error') {
      if (st.errTimer) clearTimeout(st.errTimer);
      st.errTimer = setTimeout(function () { if (wrap.__st === st && st.state === 'error') setMicState(wrap, 'idle'); }, ERROR_HOLD_MS);
    }
  }

  function paintMic(wrap) {
    var st = wrap.__st;
    var btn = wrap.firstChild;
    if (btn.getAttribute('data-state') !== st.state) btn.setAttribute('data-state', st.state);
    var icon = btn.querySelector('.aiondx-voice-icon');
    var html = ICON_MIC;
    if (st.state === 'recording') html = ICON_STOP;
    else if (st.state === 'transcribing') html = ICON_SPINNER;
    if (icon.__shown !== html) { icon.innerHTML = html; icon.__shown = html; }
    var canUse = !!(voice() && typeof voice().transcribe === 'function') && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    btn.disabled = !canUse || st.state === 'transcribing';
    var label = !canUse ? 'Voice input: the voice module is not loaded'
      : st.state === 'recording' ? 'Stop recording'
      : st.state === 'transcribing' ? 'Transcribing...'
      : st.state === 'error' ? 'Voice input failed: ' + (st.detail || 'could not record') + '. Click to try again.'
      : 'Record a voice message';
    if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    if (btn.hasAttribute('title')) btn.removeAttribute('title');   // the aria-label is the only tooltip, like patch 0001's pills
  }

  function stopMicStream(st) {
    if (st.stream) { st.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); st.stream = null; }
    st.recorder = null;
    st.chunks = null;
  }

  function startRecording(wrap, ta) {
    if (activeMic && activeMic !== wrap) stopRecording(activeMic, true);
    var st = wrap.__st;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (wrap.__st !== st) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }   // the button moved under us
      st.stream = stream;
      st.chunks = [];
      var rec;
      try { rec = new MediaRecorder(stream); } catch (e) { stopMicStream(st); setMicState(wrap, 'error', 'this browser cannot record audio'); return; }
      st.recorder = rec;
      rec.addEventListener('dataavailable', function (ev) { if (ev.data && ev.data.size) st.chunks.push(ev.data); });
      rec.addEventListener('stop', function () {
        var blob = new Blob(st.chunks || [], { type: rec.mimeType || 'audio/webm' });
        stopMicStream(st);
        if (!blob.size) { setMicState(wrap, 'idle'); activeMic = null; return; }
        setMicState(wrap, 'transcribing');
        var p = call('transcribe', blob);
        (p || Promise.reject(new Error('no voice module'))).then(function (text) {
          activeMic = null;
          insertTranscript(ta, text);
          setMicState(wrap, 'idle');
        }, function (e) {
          activeMic = null;
          console.log('[dx-voice] transcribe error', e);
          setMicState(wrap, 'error', (e && e.message) || 'transcription failed');
        });
      });
      activeMic = wrap;
      rec.start();
      setMicState(wrap, 'recording');
    }, function (e) {
      console.log('[dx-voice] getUserMedia error', e);
      setMicState(wrap, 'error', e && e.name === 'NotAllowedError' ? 'microphone permission denied' : 'could not reach the microphone');
    });
  }
  function stopRecording(wrap, discard) {
    var st = wrap.__st;
    if (!st.recorder) return;
    if (discard) { try { st.recorder.ondataavailable = null; } catch (e) {} stopMicStream(st); setMicState(wrap, 'idle'); if (activeMic === wrap) activeMic = null; return; }
    try { st.recorder.stop(); } catch (e) { stopMicStream(st); setMicState(wrap, 'idle'); }
  }

  function buildMicButton(ta) {
    var wrap = document.createElement('span');
    wrap.className = 'aiondx-voice-mic sendbox-draft-tooltip-anchor';   // AionUi's own anchor class sizes the slot the same as its neighbours
    wrap.setAttribute('data-testid', 'aiondx-voice-mic');
    wrap.__st = { state: 'idle', detail: '', recorder: null, chunks: null, stream: null, errTimer: null };
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'arco-btn arco-btn-secondary arco-btn-size-small arco-btn-shape-circle aiondx-voice-mic-btn';
    btn.setAttribute('data-testid', 'aiondx-voice-mic-btn');
    btn.innerHTML = '<span class="aiondx-voice-icon"></span>';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var st = wrap.__st;
      if (st.state === 'idle' || st.state === 'error') startRecording(wrap, ta);
      else if (st.state === 'recording') stopRecording(wrap, false);
    });
    wrap.appendChild(btn);
    paintMic(wrap);
    return wrap;
  }

  function ensureMicButtons() {
    var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
    for (var i = 0; i < boxes.length; i++) {
      var ta = boxes[i].tagName === 'TEXTAREA' ? boxes[i] : boxes[i].querySelector('textarea');
      if (!ta || !ta.getClientRects().length) continue;
      var panel = ta.closest('.sendbox-panel') || ta.parentElement;
      var actions = panel && panel.querySelector('.sendbox-actions');
      if (!actions) continue;
      var wrap = actions.querySelector('.aiondx-voice-mic');
      if (!wrap) {
        wrap = buildMicButton(ta);
        var anchor = actionsInsertAnchor(actions);
        actions.insertBefore(wrap, anchor);
      } else {
        paintMic(wrap);
      }
    }
  }

  // ---------------------------------------------------------------- playback button (agent messages)

  var currentPlayback = null;   // { wrap, audio, url }, once audio exists (the "playing" phase)
  var loadingWrap = null;       // the wrap waiting on synthesize(), before audio exists
  // Bumped by every startPlayback() and stopPlayback(): a synthesize() call started before the bump
  // checks this before touching the DOM or creating an Audio element, so a reply superseded by a
  // second click (or a stop) while still "loading" cannot clobber whatever plays next. Before this,
  // clicking a second message's speaker while the first was still loading left the first stuck in
  // "loading" forever (nothing ever reset it) and, once its request eventually resolved, could start
  // a second Audio element fighting the one already playing - a real bug, not just a UI nit: a
  // dangling fetch plus a button with no way to escape "loading" looks exactly like the app hanging.
  var playGen = 0;

  function stopPlayback() {
    playGen++;
    if (loadingWrap) { setPlayState(loadingWrap, 'idle'); loadingWrap = null; }
    if (!currentPlayback) return;
    var cp = currentPlayback;
    currentPlayback = null;
    try { cp.audio.pause(); } catch (e) {}
    if (cp.url) try { URL.revokeObjectURL(cp.url); } catch (e) {}
    setPlayState(cp.wrap, 'idle');
  }

  function setPlayState(wrap, state, detail) {
    var st = wrap.__st;
    st.state = state;
    st.detail = detail || '';
    paintPlay(wrap);
    paintStopAllButtons();   // every message's play state feeds the one global "stop all reading" control
    if (state === 'error') {
      if (st.errTimer) clearTimeout(st.errTimer);
      st.errTimer = setTimeout(function () { if (wrap.__st === st && st.state === 'error') setPlayState(wrap, 'idle'); }, ERROR_HOLD_MS);
    }
  }
  function paintPlay(wrap) {
    var st = wrap.__st;
    var btn = wrap.firstChild;
    if (btn.getAttribute('data-state') !== st.state) btn.setAttribute('data-state', st.state);
    var icon = btn.querySelector('.aiondx-voice-icon');
    var html = ICON_SPEAKER;
    if (st.state === 'playing') html = ICON_STOP;
    else if (st.state === 'loading') html = ICON_SPINNER;
    if (icon.__shown !== html) { icon.innerHTML = html; icon.__shown = html; }
    var canUse = !!(voice() && typeof voice().synthesize === 'function');
    // "loading" is clickable too (it cancels), unlike the mic's "transcribing": there is no way to
    // retry a stuck play from anywhere else, so the same button has to be its own escape hatch.
    btn.disabled = !canUse;
    var label = !canUse ? 'Play this reply: the voice module is not loaded'
      : st.state === 'playing' ? 'Stop playback'
      : st.state === 'loading' ? 'Preparing audio... click to cancel'
      : st.state === 'error' ? 'Could not play this reply: ' + (st.detail || 'synthesis failed') + '. Click to try again.'
      : 'Play this reply aloud';
    if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    if (btn.hasAttribute('title')) btn.removeAttribute('title');
  }

  function startPlayback(wrap, content) {
    stopPlayback();
    var text = spokenText(messageText(content));
    if (!text) { setPlayState(wrap, 'error', 'nothing to read'); return; }
    var myGen = ++playGen;
    loadingWrap = wrap;
    setPlayState(wrap, 'loading');
    var p = call('synthesize', text, (settingsCache.data || {}).voiceId);
    (p || Promise.reject(new Error('no voice module'))).then(function (result) {
      if (myGen !== playGen) return;   // superseded by a newer play, or stopped, while this was in flight
      loadingWrap = null;
      var url = audioUrlFrom(result);
      var ownUrl = false;
      if (!url) {
        var blob = audioBlobFrom(result);
        if (!blob) throw new Error('unexpected synthesize() result');
        url = URL.createObjectURL(blob);
        ownUrl = true;
      }
      var audio = new Audio(url);
      var cp = { wrap: wrap, audio: audio, url: ownUrl ? url : null };
      currentPlayback = cp;
      audio.addEventListener('ended', function () { if (currentPlayback === cp) stopPlayback(); });
      audio.addEventListener('error', function () { if (currentPlayback === cp) { console.log('[dx-voice] playback error'); setPlayState(wrap, 'error', 'could not play the audio'); currentPlayback = null; } });
      audio.play().then(function () { if (currentPlayback === cp) setPlayState(wrap, 'playing'); }, function (e) {
        console.log('[dx-voice] audio.play() rejected', e);
        if (currentPlayback === cp) { currentPlayback = null; setPlayState(wrap, 'error', 'playback was blocked'); }
      });
    }, function (e) {
      if (myGen !== playGen) return;   // superseded; do not paint a stale error over whatever is current now
      loadingWrap = null;
      console.log('[dx-voice] synthesize error', e);
      // No provider or no key: read it with the voice the PC already has (free, offline), so the button does something on a fresh install.
      if (canSpeakSystem() && /no provider configured|no API key|no voice module/i.test((e && e.message) || '')) {
        try { systemSpeak(wrap, text); return; } catch (x) { console.log('[dx-voice] system voice failed', x); }
      }
      setPlayState(wrap, 'error', (e && e.message) || 'synthesis failed');
    });
  }

  // The system voice (Windows' own, through the browser's speechSynthesis): no account, no key, nothing leaves the PC. A long reply is read in
  // pieces of a sentence or two, because the engine can stop partway through one very long utterance.
  function canSpeakSystem() {
    var dx = window.__aionDx;
    if (dx && typeof dx.option === 'function' && dx.option('voice.system') === false) return false;   // the option voice.system (patch 0001's list)
    return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
  }
  function speechPieces(text) {
    var pieces = [], cur = '';
    String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?:;])\s+/).forEach(function (s) {
      if (cur && (cur + ' ' + s).length > 240) { pieces.push(cur); cur = s; }
      else cur = cur ? cur + ' ' + s : s;
    });
    if (cur) pieces.push(cur);
    return pieces;
  }
  function systemSpeak(wrap, text) {
    var pieces = speechPieces(text);
    if (!pieces.length) throw new Error('nothing to read');
    var cp = { wrap: wrap, url: null, audio: { pause: function () { try { window.speechSynthesis.cancel(); } catch (e) {} } } };
    currentPlayback = cp;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    pieces.forEach(function (piece, i) {
      var u = new window.SpeechSynthesisUtterance(piece);
      u.onend = function () { if (i === pieces.length - 1 && currentPlayback === cp) stopPlayback(); };
      u.onerror = function (ev) {
        if (ev && (ev.error === 'canceled' || ev.error === 'interrupted')) return;
        if (currentPlayback === cp) { currentPlayback = null; setPlayState(wrap, 'error', 'the system voice could not read this'); }
      };
      window.speechSynthesis.speak(u);
    });
    setPlayState(wrap, 'playing');
  }

  function buildPlayButton(content) {
    var wrap = document.createElement('span');
    wrap.className = 'aiondx-voice-play aiondx-voice-playrow';
    wrap.setAttribute('data-testid', 'aiondx-voice-play');
    wrap.__st = { state: 'idle', detail: '', errTimer: null };
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'arco-btn arco-btn-secondary arco-btn-size-mini arco-btn-shape-circle aiondx-voice-play-btn';
    btn.setAttribute('data-testid', 'aiondx-voice-play-btn');
    btn.innerHTML = '<span class="aiondx-voice-icon"></span>';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var st = wrap.__st;
      if (st.state === 'playing' || st.state === 'loading') stopPlayback();
      else if (st.state === 'idle' || st.state === 'error') startPlayback(wrap, content);
    });
    wrap.appendChild(btn);
    paintPlay(wrap);
    return wrap;
  }

  /** An agent's own reply: the same rule patch 0001's rowKind uses for 'agent' (a left-side row that
   *  is not a teammate-to-teammate forward, .bg-3), reimplemented here so this file does not depend
   *  on 0001's private per-row attribute or its tagging having already run this frame. */
  function isAgentRow(row) {
    return row.getAttribute('data-message-position') === 'left' && !row.querySelector('.bg-3');
  }

  var lastFullScan = 0;
  function ensurePlayButtons() {
    // Rows already looked at carry data-aiondx-voice ("1" has its button, "0" is not an agent reply), so a chat of thousands of rows is not walked
    // row by row on every change of the page. Every 10 seconds all rows are looked at again, in case React dropped a button.
    var full = Date.now() - lastFullScan > 10000;
    if (full) lastFullScan = Date.now();
    var rows = document.querySelectorAll('[id^="message-"][data-message-type="text"]' + (full ? '' : ':not([data-aiondx-voice])'));
    // On a page with a long message list (see bigPage) only the newest replies get their speaker button here; an older reply gets its button when
    // the pointer reaches it (watchHover). A speaker button on every one of thousands of replies roughly doubled the page's layout cost in the test.
    var from = bigPage() ? Math.max(0, rows.length - BIG_PAGE_BUTTONS) : 0;
    // The rows left out are marked "2" (button on hover), so they do not come back into the next scan and get their buttons ten at a time.
    for (var j = 0; j < from; j++) if (!rows[j].hasAttribute('data-aiondx-voice')) rows[j].setAttribute('data-aiondx-voice', '2');
    for (var i = from; i < rows.length; i++) playButtonFor(rows[i]);
  }
  /** Gives one reply its speaker button, if it is an agent's and drawn. Marks the row so it is not looked at again. */
  function playButtonFor(row) {
    if (!isAgentRow(row)) { row.setAttribute('data-aiondx-voice', '0'); return; }
    var content = row.querySelector('[data-testid="message-text-content"]');
    // The button is inserted as content's sibling, not its child, so the dedupe check has to
    // look in the row (an earlier version checked inside content and never found its own button,
    // which piled up a fresh one on every render pass).
    if (!content) return;   // not drawn yet: looked at again next time
    if (row.querySelector('.aiondx-voice-play')) { row.setAttribute('data-aiondx-voice', '1'); return; }
    var wrap = buildPlayButton(content);
    content.parentNode.insertBefore(wrap, content.nextSibling);
    row.setAttribute('data-aiondx-voice', '1');
  }
  var BIG_PAGE_BUTTONS = 40;
  var hoverWatched = false;
  /** On a big page, the speaker button of an older reply appears when the pointer reaches the reply. */
  function watchHover() {
    if (hoverWatched) return;
    hoverWatched = true;
    document.addEventListener('mouseover', function (ev) {
      if (!bigPage()) return;
      var row = ev.target && ev.target.closest ? ev.target.closest('[id^="message-"][data-message-type="text"]') : null;
      if (!row || (row.hasAttribute('data-aiondx-voice') && row.getAttribute('data-aiondx-voice') !== '2')) return;
      try { playButtonFor(row); } catch (e) { console.log('[dx-voice] hover button failed', e); }
    }, true);
  }

  // ------------------------------------------------- global "stop all reading" button (composer)

  /** One button per composer (the mic button's neighbour), all of them reflecting and controlling
   *  the same page-wide playback state: only one reply ever plays at a time (startPlayback() always
   *  calls stopPlayback() first), so stopping "all" is just stopping that one - but a single
   *  discoverable control beats hunting down whichever message's speaker button is lit. */
  function buildStopAllButton() {
    var wrap = document.createElement('span');
    wrap.className = 'aiondx-voice-stopall';
    wrap.setAttribute('data-testid', 'aiondx-voice-stopall');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'arco-btn arco-btn-secondary arco-btn-size-small arco-btn-shape-circle aiondx-voice-stopall-btn';
    btn.setAttribute('data-testid', 'aiondx-voice-stopall-btn');
    btn.innerHTML = '<span class="aiondx-voice-icon">' + ICON_SPEAKER_MUTE + '</span>';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      stopPlayback();
      hf.lastError = '';   // a deliberate stop, not a failure: nothing to explain
      stopHandsFreeForGood();   // the exit control for hands-free mode too: stop reading AND stop listening, for good
    });
    wrap.appendChild(btn);
    return wrap;
  }

  /** active covers hands-free mode too, not just an in-flight synthesize()/playback: it is the
   *  button's one exit control for a conversation that is only listening right now, nothing
   *  playing yet, so it has to be clickable (and so enabled) through every stage of that, not just
   *  while something is actually reading aloud. A disabled button never receives a real click at
   *  all, so this was a genuine bug, not just a label: hands-free had no way to stop by this
   *  button except during the "speaking" stage. */
  function paintStopAllButtons() {
    var active = !!(loadingWrap || currentPlayback || hf.active);
    var btns = document.querySelectorAll('.aiondx-voice-stopall-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.disabled = !active;
      var want = active ? 'active' : 'idle';
      if (b.getAttribute('data-state') !== want) b.setAttribute('data-state', want);
      var label = active ? 'Stop all reading' : 'Nothing is being read aloud';
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
      if (b.hasAttribute('title')) b.removeAttribute('title');
    }
  }

  function ensureStopAllButtons() {
    var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
    for (var i = 0; i < boxes.length; i++) {
      var ta = boxes[i].tagName === 'TEXTAREA' ? boxes[i] : boxes[i].querySelector('textarea');
      if (!ta || !ta.getClientRects().length) continue;
      var panel = ta.closest('.sendbox-panel') || ta.parentElement;
      var actions = panel && panel.querySelector('.sendbox-actions');
      if (!actions || actions.querySelector('.aiondx-voice-stopall')) continue;
      var mic = actions.querySelector('.aiondx-voice-mic');
      actions.insertBefore(buildStopAllButton(), mic ? mic.nextSibling : actionsInsertAnchor(actions));
    }
    paintStopAllButtons();
  }

  // ---------------------------------------------------------------- hands-free conversation mode
  //
  // Say a wake phrase, then talk back and forth with an agent without touching a button each turn.
  // Built entirely on top of AionDxVoice's wake-phrase listener and utterance capture
  // (startWakeListener/stopWakeListener/captureUtterance) - this file only sequences those calls
  // and reuses its own existing pieces: insertTranscript/sendComposerText for landing a turn in the
  // composer, startPlayback/spokenText for reading a reply back, stopPlayback (via the stop-all
  // button) for stopping it. One cycle: wake phrase -> captureUtterance() -> send -> poll the
  // conversation until the turn finishes -> auto-play the newest reply -> once that playback ends,
  // captureUtterance() again - never back to the wake phrase, per the user's own framing of it as a
  // continuous conversation, not a wake-once-per-turn assistant. A spoken stop phrase (checked the
  // same simple substring way the wake phrase is) or the stop-all button ends it.
  //
  // hf.gen is bumped by every teardown and every stage transition's own start; every async step
  // (a captureUtterance() resolve/reject, a status poll, the playback watcher) checks it against
  // the value it captured before beginning, the same stale-result guard startPlayback's playGen
  // uses - so a stop (or a conversation switch) mid-flight can never have a late callback restart
  // a stage, land a message, or kick off a playback that the user already asked to stop.

  // lastError: set only when a real failure stopped hands-free mode (a mic permission denial, the
  // module missing, ...), and surfaced in the settings panel (see handsFreeStatusText) since the
  // badge that would otherwise show it lives in a conversation's composer - easy for the user to
  // never be looking at when hands-free stops itself. Cleared on a fresh, deliberate start or stop
  // so a stale error does not linger and read as still-current.
  // key: a string identifying what hf is currently running for ('conv:<id>' or 'team:<id>'), so
  // ensureHandsFree() can tell "already running for this exact target, leave it alone" apart from
  // "switched to a different one, restart" without caring about conv vs team itself.
  var hf = { active: false, state: 'off', key: null, target: null, wakeStop: null, abort: null, pollTimer: null, gen: 0, lastError: '', sawActivity: false, wakeStartedAt: 0, transcribeErrorMsg: '', transcribeErrorAt: 0 };
  // Test-only: {levelSource, createRecorder} to hand startWakeListener/captureUtterance a fake mic
  // instead of the real one, the same injection test-wake.js uses for aiondx-voice.js itself. Set
  // through window.__aionDxVoiceUI.setHfTestSource, never touched in production.
  var hfInjectedOpts = {};

  function hfModule() { return window.AionDxVoice || null; }
  function hfTranscribe(blob, opts) { return call('transcribe', blob, opts); }
  function saysStopHF(text) {
    var t = String(text || '').toLowerCase();
    return HF_STOP_PHRASES.some(function (p) { return t.indexOf(p) >= 0; });
  }
  function setHfState(state) { hf.state = state; paintHandsFreeBadge(); paintStopAllButtons(); paintHandsFreeNote(); }

  /** A solo conversation's lone composer (r.kind === 'conv'), or a team page's lead column
   *  specifically (r.kind === 'team') - a user talking hands-free "to the lead agent" is on this
   *  route, not #/conversation/<id>, which the first version of this feature matched exclusively.
   *  A teammate's own column is still out of scope: picking which of several members a wake phrase
   *  should address is a bigger design question than this build takes on.
   *  Returns { kind, id, ta, scope } (scope is where a reply's message rows are looked for - the
   *  whole document for a solo chat, just the lead's column on a team page) or null when the
   *  composer is not in the DOM yet this frame (ensureHandsFree() tries again next render). */
  function findHfTarget(r) {
    if (r.kind === 'conv') {
      var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
      for (var i = 0; i < boxes.length; i++) {
        var cand = boxes[i].tagName === 'TEXTAREA' ? boxes[i] : boxes[i].querySelector('textarea');
        if (cand && cand.getClientRects().length && !cand.closest('[data-slot-id]')) {
          return { kind: 'conv', id: r.id, ta: cand, scope: document };
        }
      }
      return null;
    }
    if (r.kind === 'team') {
      var col = document.querySelector('[data-slot-id][data-role="leader"]');   // TeamPage.tsx's own attribute for the lead's column
      if (!col) return null;
      var box = col.querySelector('[data-testid="sendbox-input"]');
      var ta = box ? (box.tagName === 'TEXTAREA' ? box : box.querySelector('textarea')) : null;
      if (!ta || !ta.getClientRects().length) return null;
      return { kind: 'team', id: r.id, ta: ta, scope: col };
    }
    return null;
  }

  /** Stops the running listeners only, leaving the "hands-free enabled" setting untouched: used
   *  for a conversation switch or a page unload, where the feature should pick back up on
   *  whichever conversation is open next, not be switched off outright. ensureHandsFree() calls
   *  this itself before restarting fresh, so it must never flip the setting - that would be
   *  indistinguishable from the user turning the whole feature off. */
  function teardownHandsFree() {
    hf.gen++;
    if (hf.wakeStop) { try { hf.wakeStop(); } catch (e) {} hf.wakeStop = null; }
    if (hf.abort) { try { hf.abort.abort(); } catch (e) {} hf.abort = null; }
    if (hf.pollTimer) { clearTimeout(hf.pollTimer); hf.pollTimer = null; }
    var m = hfModule();
    if (m && typeof m.stopWakeListener === 'function') { try { m.stopWakeListener(); } catch (e) {} }
    hf.active = false;
    hf.key = null;
    hf.target = null;
    setHfState('off');
  }

  /** The user's own "stop" - the stop-all button or a spoken stop phrase. Unlike teardownHandsFree
   *  alone, this also switches the setting off, so ensureHandsFree() does not just start the wake
   *  listener right back up on its next pass (which runs within the same render tick, since
   *  nothing else changed). The settings panel's checkbox updates on its own next refresh. */
  function stopHandsFreeForGood() {
    teardownHandsFree();
    saveSettings({ handsFree: false });
  }

  // startWakeStage/startListenStage/waitForReplyThenPlay/watchPlaybackThenListenAgain all read
  // hf.target fresh at the point they actually touch the DOM (a composer's textarea, its send
  // button, its message rows), rather than taking it as a parameter closed over once when the
  // stage started. They used to take `target` as an argument; a long wake/listen cycle easily
  // outlives one render pass, and React can replace the composer's own DOM nodes (a busy page
  // re-rendering) without hf.key ever changing, which ensureHandsFree() already re-detects and
  // refreshes hf.target for - but a captured parameter from several stages back would still point
  // at whatever was live when that stage first began. Concretely: sendComposerText(target.ta, ...)
  // against a since-detached textarea dispatches its 'input' event to nothing, and the click on a
  // detached send button reaches no listener - the call "succeeds" (nothing throws) and nothing
  // happens, which is indistinguishable from the wake phrase doing nothing at all.

  function startWakeStage() {
    var myGen = hf.gen;
    var m = hfModule();
    if (!m || typeof m.startWakeListener !== 'function') { teardownHandsFree(); return; }
    hf.sawActivity = false;
    hf.wakeStartedAt = Date.now();
    hf.transcribeErrorMsg = '';
    hf.transcribeErrorAt = 0;
    setHfState('wake');
    var phrase = (settingsCache.data || {}).wakePhrase || DEFAULT_WAKE_PHRASE;
    var opts = Object.assign({
      phrase: phrase,
      transcribe: hfTranscribe,
      onWake: function () { if (myGen === hf.gen) startListenStage(); },
      // Any candidate, matched or not, is proof the mic + VAD pipeline is actually alive - see
      // hfStageLabel's stall hint, which is otherwise the only way to tell "it's listening and
      // just hasn't heard the phrase" apart from "it isn't really listening at all."
      onCandidate: function () { if (myGen === hf.gen && !hf.sawActivity) { hf.sawActivity = true; paintHandsFreeBadge(); paintHandsFreeNote(); } },
      // A failed transcribe() still proves the mic/VAD recorded and sent a real clip - that is
      // "activity" too, and a sharper signal than the stall hint: this is the exact bug a user
      // report traced to "every clip was failing to transcribe, with nothing ever saying so."
      // The wake listener keeps running regardless (Core Engineer's own design, symmetric with
      // onCandidate) - one bad clip says nothing about the next one.
      onTranscribeError: function (e) {
        if (myGen !== hf.gen) return;
        console.log('[dx-voice] wake transcribe error', e);
        hf.sawActivity = true;
        hf.transcribeErrorMsg = (e && e.message) || 'transcription failed';
        hf.transcribeErrorAt = Date.now();
        paintHandsFreeBadge();
        paintHandsFreeNote();
      },
      onError: function (e) {
        if (myGen !== hf.gen) return;
        console.log('[dx-voice] wake listener error', e);
        hf.lastError = (e && e.message) || 'could not start the microphone';
        stopHandsFreeForGood();
      }
    }, hfInjectedOpts);
    hf.wakeStop = m.startWakeListener(opts);
  }

  function startListenStage() {
    var myGen = hf.gen;
    if (hf.wakeStop) { try { hf.wakeStop(); } catch (e) {} hf.wakeStop = null; }   // release the wake mic before opening a fresh one
    var m = hfModule();
    if (!m || typeof m.captureUtterance !== 'function') { teardownHandsFree(); return; }
    setHfState('listening');
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    hf.abort = controller;
    var opts = Object.assign({ transcribe: hfTranscribe, signal: controller ? controller.signal : undefined }, hfInjectedOpts);
    m.captureUtterance(opts).then(function (text) {
      hf.abort = null;
      if (myGen !== hf.gen) return;
      if (saysStopHF(text)) { hf.lastError = ''; stopHandsFreeForGood(); return; }   // a deliberate stop, not a failure
      var clean = String(text || '').trim();
      if (!clean) { startListenStage(); return; }   // VAD cut a clip transcribe() read as empty: just listen again
      sendComposerText(hf.target.ta, clean);   // hf.target read now, not whatever was current when this stage started
      waitForReplyThenPlay(myGen);
    }, function (e) {
      hf.abort = null;
      if (myGen !== hf.gen) return;
      console.log('[dx-voice] captureUtterance error', e);
      startListenStage();   // a timeout with nothing said, or a hiccup: keep listening, the conversation stays live
    });
  }

  /** Has the turn finished? A solo chat's own status; a team's lead checked through run-state,
   *  the same source and the same "idle means done" rule patch 0001's Loop uses for a team member -
   *  a solo conversation's GET has no equivalent slot_work to read, so the two need their own call. */
  function hfTurnFinished(target) {
    if (target.kind === 'team') {
      return fetch(apiUrl('/api/teams/' + target.id + '/run-state'), { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
        .then(function (j) {
          var data = j && (j.data || j);
          var slots = data && Array.isArray(data.slot_work) ? data.slot_work : null;
          if (!slots) return false;   // no answer yet: do not guess it is done
          var lead = slots.filter(function (s) { return s.role === 'lead'; })[0];
          return !lead || lead.state === 'idle';
        });
    }
    return fetch(apiUrl('/api/conversations/' + target.id), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
      .then(function (j) {
        var data = j && (j.data || j);
        var status = data && data.status;
        return !status || status === 'finished';
      });
  }

  /** Polls until the agent's turn finishes, then auto-plays the newest reply - the same play
   *  button a manual click would use, just triggered here instead of by the user. Re-reads
   *  hf.target on every poll tick (both for hfTurnFinished's id and for where to look for the
   *  reply), not just once at the start - this can run for a while. */
  function waitForReplyThenPlay(myGen) {
    setHfState('waiting-reply');
    function poll() {
      if (myGen !== hf.gen) return;
      var target = hf.target;
      hfTurnFinished(target).then(function (done) {
        if (myGen !== hf.gen) return;
        if (!done) { hf.pollTimer = setTimeout(poll, 1000); return; }
        var scope = hf.target ? hf.target.scope : target.scope;
        var rows = Array.prototype.filter.call(scope.querySelectorAll('[id^="message-"][data-message-type="text"]'), isAgentRow);
        var row = rows[rows.length - 1];
        var wrap = row && row.querySelector('.aiondx-voice-play');
        var content = row && row.querySelector('[data-testid="message-text-content"]');
        if (!wrap || !content) { hf.pollTimer = setTimeout(poll, 500); return; }   // the reply's row exists but ensurePlayButtons() has not reached it yet this frame
        setHfState('speaking');
        startPlayback(wrap, content);
        watchPlaybackThenListenAgain(wrap, myGen);
      });
    }
    poll();
  }

  /** Not back to the wake phrase - the user's own framing of this as a continuous conversation, so
   *  every turn after the first starts straight at captureUtterance(). */
  function watchPlaybackThenListenAgain(wrap, myGen) {
    var tick = setInterval(function () {
      if (myGen !== hf.gen) { clearInterval(tick); return; }
      var st = wrap.__st.state;
      if (st === 'idle' || st === 'error') {
        clearInterval(tick);
        if (myGen !== hf.gen) return;
        startListenStage();
      }
    }, 150);
  }

  /** The entry point from render(): starts, restarts (on a conversation/team switch) or tears down
   *  hands-free mode to match the setting and the page, without ever touching an already-running
   *  cycle for the target it is already running on. */
  function ensureHandsFree() {
    var settings = settingsCache.data || {};
    var enabled = !!settings.handsFree;
    var r = route();
    if (!enabled || !r) { if (hf.active) teardownHandsFree(); return; }
    var target = findHfTarget(r);
    if (!target) return;   // the composer is not rendered yet this frame; ensureHandsFree() runs again next render
    var key = target.kind + ':' + target.id;
    if (hf.active && hf.key === key) {
      // Same target by id, but React can replace the composer's own DOM nodes (a team page in
      // particular re-renders often) without the route ever changing - findHfTarget() above
      // already re-searched the live DOM and found this frame's real nodes; keep them, not
      // whatever was live when startWakeStage first captured hf.target. Skipping this update (an
      // earlier version did) left hf.target.ta pointing at a node React could since have detached,
      // which silently breaks every badge repaint and the send button sendComposerText() clicks -
      // the listener itself keeps running underneath (it owns no DOM), so nothing here looked
      // wrong from inside aiondx-voice.js, but the whole UI side goes stale and inert.
      if (hf.target !== target) { hf.target = target; paintHandsFreeBadge(); }
      return;
    }
    if (hf.active) teardownHandsFree();
    var m = hfModule();
    if (!m || typeof m.startWakeListener !== 'function' || typeof m.captureUtterance !== 'function') return;
    hf.active = true;
    hf.key = key;
    hf.target = target;   // which composer the badge belongs to - a team page has more than one on screen at once
    hf.lastError = '';   // a fresh start (the checkbox just turned on, or a target switch): any previous error is stale now
    startWakeStage();
  }

  function buildHandsFreeBadge() {
    var el = document.createElement('span');
    el.className = 'aiondx-voice-hf';
    el.setAttribute('data-testid', 'aiondx-voice-hf-badge');
    el.innerHTML = '<span class="aiondx-voice-hf-dot" aria-hidden="true"></span><span class="aiondx-voice-hf-text"></span>';
    return el;
  }
  /** The one state->words mapping, shared by the composer badge and the settings panel's status
   *  line - so the two can never drift apart on what "waiting-reply" or "speaking" is called. */
  var HF_STALL_MS = 8000;   // long enough to not false-positive on a quiet room, short enough to be useful
  function hfStageLabel() {
    var phrase = (settingsCache.data || {}).wakePhrase || DEFAULT_WAKE_PHRASE;
    if (hf.state === 'wake') {
      // A failed transcribe() takes priority over the plain stall hint below: it is strictly more
      // informative (proof the mic/VAD recorded and sent a real clip, plus the actual reason it
      // did not turn into a wake) and, bug-for-bug, is exactly the case the stall hint alone would
      // have gotten backwards - every clip failing to transcribe still counts as real activity
      // (onTranscribeError sets sawActivity too), so without this check the badge would have kept
      // saying "no microphone activity detected" while the mic was demonstrably working.
      if (hf.transcribeErrorMsg && hf.transcribeErrorAt >= hf.wakeStartedAt) {
        return 'Listening for “' + phrase + '” — transcription failed: ' + hf.transcribeErrorMsg;
      }
      // sawActivity is set by onCandidate or onTranscribeError - proof the VAD actually heard
      // *something* and sent it to transcribe(), matched or not, successful or not. Silent since
      // this stage started points at the mic/VAD pipeline itself, not "the phrase wasn't
      // understood" - worth telling apart, since the badge otherwise looks identical
      // ("Listening...") whether the mic is live or not. ensureHandsFreeBadges() repaints this
      // every ~2s regardless of a state change, so the hint appears without extra wiring.
      var stalled = !hf.sawActivity && hf.wakeStartedAt && (Date.now() - hf.wakeStartedAt > HF_STALL_MS);
      return 'Listening for “' + phrase + '”' + (stalled ? ' — no microphone activity detected yet' : '');
    }
    return hf.state === 'listening' ? 'Listening for your message…'
      : hf.state === 'waiting-reply' ? 'Waiting for the reply…'
      : hf.state === 'speaking' ? 'Reading the reply aloud…'
      : '';
  }
  /** The .sendbox-actions row a composer's textarea lives in - shared by the badge scoping below
   *  and ensureMicButtons/ensureStopAllButtons/ensureHandsFreeBadges' own insertion logic. */
  function actionsFor(ta) {
    var panel = ta.closest('.sendbox-panel') || ta.parentElement;
    return panel && panel.querySelector('.sendbox-actions');
  }
  function paintHandsFreeBadge() {
    var show = hf.active && hf.state !== 'off';
    var label = hfStageLabel();
    // On a team page every column gets its own badge element (ensureHandsFreeBadges inserts one
    // per composer, not knowing yet which one hf will end up targeting), but hf only ever runs for
    // one of them: show it there and nowhere else, or every other member's column would flash the
    // lead's "listening" state too.
    var mineActions = show && hf.target && hf.target.ta ? actionsFor(hf.target.ta) : null;
    var badges = document.querySelectorAll('.aiondx-voice-hf');
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      var mine = !!mineActions && b.closest('.sendbox-actions') === mineActions;
      b.hidden = !mine;
      if (b.getAttribute('data-state') !== hf.state) b.setAttribute('data-state', hf.state);
      var text = b.querySelector('.aiondx-voice-hf-text');
      if (text.textContent !== label) text.textContent = label;
      var aria = 'Hands-free conversation mode' + (mine && label ? ': ' + label : ' is off');
      if (b.getAttribute('aria-label') !== aria) b.setAttribute('aria-label', aria);
    }
  }
  /** For the settings panel's own status line - the composer badge is easy to never be looking at
   *  (it is not even on screen while the user is on the Settings page itself), so this is the one
   *  place that always says what hands-free mode is actually doing, including why it stopped if a
   *  real failure is what stopped it, instead of a checkbox that just quietly reverted. */
  function handsFreeStatusText(settings) {
    // lastError checked first, ahead of the setting itself: a real failure (stopHandsFreeForGood)
    // also switches handsFree off, so checking the setting first would blank this note in the same
    // instant it has something to say - the user would never get to read why it stopped, which was
    // the whole point of adding it. It only goes quiet once something deliberately clears
    // lastError (a fresh start, or the user unchecking the box themselves).
    if (hf.lastError) return 'Hands-free mode stopped: ' + hf.lastError + '. Turn it back on to try again.';
    if (!settings.handsFree) return '';
    if (!hf.active) return 'Hands-free mode is on, but it only runs inside a conversation — open one to start it.';
    return 'Hands-free mode is running: ' + hfStageLabel();
  }
  /** Called from refreshVoicePanel() (the settings panel's own render pass) and directly from
   *  setHfState() (so a user sitting on the Settings page watching sees it change the instant a
   *  stage transition happens, not up to 2 s later on the next poll). A no-op off the Settings
   *  page, since pickerEl only exists while that page is open. */
  function paintHandsFreeNote() {
    if (!pickerEl) return;
    var hfNote = pickerEl.querySelector('[data-testid="aiondx-voice-hf-status"]');
    if (!hfNote) return;
    var settings = settingsCache.data || {};
    var hfText = handsFreeStatusText(settings);
    hfNote.hidden = !hfText;
    if (hfNote.textContent !== hfText) hfNote.textContent = hfText;
    var hfOk = !hf.lastError ? '1' : '0';
    if (hfNote.getAttribute('data-ok') !== hfOk) hfNote.setAttribute('data-ok', hfOk);
  }
  function ensureHandsFreeBadges() {
    var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
    for (var i = 0; i < boxes.length; i++) {
      var ta = boxes[i].tagName === 'TEXTAREA' ? boxes[i] : boxes[i].querySelector('textarea');
      if (!ta || !ta.getClientRects().length) continue;
      var panel = ta.closest('.sendbox-panel') || ta.parentElement;
      var actions = panel && panel.querySelector('.sendbox-actions');
      if (!actions || actions.querySelector('.aiondx-voice-hf')) continue;
      var stopall = actions.querySelector('.aiondx-voice-stopall');
      actions.insertBefore(buildHandsFreeBadge(), stopall ? stopall.nextSibling : actionsInsertAnchor(actions));
    }
    paintHandsFreeBadge();
  }

  // ---------------------------------------------------------------- settings panel (Settings > Appearance)

  var pickerEl = null;
  var providerCache = { at: 0, list: null };
  var voiceCache = { at: 0, key: null, list: null, unsupported: false };
  // getSettings()/setSettings() are both Promise-returning (the settings store is one PUT/GET
  // record behind /api/settings/client), so the panel reads from this cache instead of blocking
  // a render pass on a network round trip. A save updates it optimistically, then again from the
  // module's own merged record once the request resolves.
  var SETTINGS_TTL_MS = 5000;
  var settingsCache = { data: {}, loading: false, at: 0 };
  function ensureSettingsLoaded() {
    if (settingsCache.loading || (settingsCache.at && Date.now() - settingsCache.at < SETTINGS_TTL_MS)) return;
    settingsCache.loading = true;
    Promise.resolve(call('getSettings') || {}).then(function (s) {
      settingsCache.loading = false;
      settingsCache.data = s || {};
      settingsCache.at = Date.now();
      schedule();
    }, function (e) {
      console.log('[dx-voice] getSettings error', e);
      settingsCache.loading = false;
      settingsCache.at = Date.now();
    });
  }

  function voiceAnchor() {
    var acc = document.querySelector('.aiondx-accent');          // patch 0001's own panel, when present
    if (acc) return acc;
    var card = document.querySelector('[data-testid^="theme-card-"]');
    return card ? card.parentElement : null;                     // the theme gallery itself, otherwise
  }

  function ensureVoicePanel() {
    var anchor = voiceAnchor();
    if (!anchor) { if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl); return; }
    if (!pickerEl) pickerEl = buildVoicePanel();
    if (pickerEl.parentNode !== anchor.parentNode || pickerEl.previousElementSibling !== anchor) {
      anchor.parentNode.insertBefore(pickerEl, anchor.nextSibling);
    }
    refreshVoicePanel();
  }

  function buildVoicePanel() {
    var el = document.createElement('div');
    el.className = 'aiondx-voice-panel';
    el.setAttribute('data-testid', 'aiondx-voice-panel');
    el.innerHTML =
      '<div class="aiondx-voice-title">AionDX voice</div>' +
      '<div class="aiondx-voice-desc">Speak into the microphone button on the composer, and have an agent\u2019s reply read back with the speaker button on its message.</div>' +
      '<div class="aiondx-voice-desc" data-testid="aiondx-voice-privacy">What you say, and each reply you play back, is sent to the provider you pick (ElevenLabs today), under your own account and key. Nothing is sent until you enter a key and press the microphone or a speaker button. The key is kept in AionDX\u2019s settings on this PC, as typed. With no key, the speaker button reads the reply with the voice Windows already has: nothing leaves this PC.</div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-provider">Provider</label>' +
        '<select id="aiondx-voice-provider" data-testid="aiondx-voice-provider"></select></div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-apikey">API key</label>' +
        '<input type="password" id="aiondx-voice-apikey" data-testid="aiondx-voice-apikey" autocomplete="off" placeholder="API key">' +
        '<button type="button" class="aiondx-voice-reveal arco-btn arco-btn-secondary arco-btn-size-small" data-testid="aiondx-voice-reveal">Show</button></div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-voice">Voice</label>' +
        '<select id="aiondx-voice-voice" data-testid="aiondx-voice-voice"></select></div>' +
      '<div class="aiondx-voice-note" data-testid="aiondx-voice-note" hidden></div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-handsfree">Hands-free</label>' +
        '<label class="aiondx-voice-toggle"><input type="checkbox" id="aiondx-voice-handsfree" data-testid="aiondx-voice-handsfree"> Hands-free conversation mode</label></div>' +
      '<div class="aiondx-voice-note">Say the wake phrase, then talk back and forth without touching the mic or speaker buttons. Off by default; the stop-all button (or saying a stop phrase) ends it.</div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-wakephrase">Wake phrase</label>' +
        '<input type="text" id="aiondx-voice-wakephrase" data-testid="aiondx-voice-wakephrase" placeholder="' + DEFAULT_WAKE_PHRASE + '"></div>' +
      '<div class="aiondx-voice-status" data-testid="aiondx-voice-hf-status" data-ok="1" hidden></div>' +
      '<div class="aiondx-voice-status" data-testid="aiondx-voice-status"></div>';

    var providerSel = el.querySelector('#aiondx-voice-provider');
    var keyInput = el.querySelector('#aiondx-voice-apikey');
    var reveal = el.querySelector('.aiondx-voice-reveal');
    var voiceSel = el.querySelector('#aiondx-voice-voice');
    var handsFreeBox = el.querySelector('#aiondx-voice-handsfree');
    var wakeInput = el.querySelector('#aiondx-voice-wakephrase');

    providerSel.addEventListener('change', function () {
      saveSettings({ provider: providerSel.value });
      voiceCache = { at: 0, key: null, list: null, unsupported: false };   // the new provider's voices have not been fetched yet
      refreshVoicePanel();
    });
    var keyTimer = null;
    keyInput.addEventListener('input', function () {
      if (keyTimer) clearTimeout(keyTimer);
      keyTimer = setTimeout(function () { keyTimer = null; saveSettings({ apiKey: keyInput.value }); }, 400);
    });
    reveal.addEventListener('click', function (ev) {
      ev.preventDefault();
      var show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      reveal.textContent = show ? 'Hide' : 'Show';
    });
    voiceSel.addEventListener('change', function () { saveSettings({ voiceId: voiceSel.value }); });
    handsFreeBox.addEventListener('change', function () {
      if (!handsFreeBox.checked) hf.lastError = '';   // the user's own deliberate off: any earlier error is no longer the reason
      saveSettings({ handsFree: handsFreeBox.checked });
    });
    var wakeTimer = null;
    wakeInput.addEventListener('input', function () {
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = setTimeout(function () { wakeTimer = null; saveSettings({ wakePhrase: wakeInput.value.trim() || DEFAULT_WAKE_PHRASE }); }, 400);
    });
    return el;
  }

  // render() reaches refreshVoicePanel every 2 s and on nearly every DOM mutation, so a status set
  // once ("Saved.") would be wiped by the very next pass if that pass cleared it unconditionally.
  // setStatus stamps a token; flashStatus clears itself after its hold, but only if nothing newer
  // has been set meanwhile (a second save, or the panel going disabled).
  var statusToken = 0;
  function setStatus(text, ok) {
    statusToken++;
    if (!pickerEl) return;
    var box = pickerEl.querySelector('[data-testid="aiondx-voice-status"]');
    box.textContent = text || '';
    box.setAttribute('data-ok', ok === false ? '0' : '1');
  }
  function flashStatus(text, ok, holdMs) {
    setStatus(text, ok);
    var token = statusToken;
    setTimeout(function () { if (statusToken === token) setStatus(''); }, holdMs || 2500);
  }

  function saveSettings(patch) {
    if (!voice() || typeof voice().setSettings !== 'function') { setStatus('Voice module not loaded: nothing was saved.', false); return; }
    settingsCache.data = Object.assign({}, settingsCache.data, patch);   // optimistic, so the panel does not flicker back while the request is in flight
    // Also bumped here, not only after the save resolves: ensureSettingsLoaded() runs on every
    // render pass the settings panel is visible for, and if settingsCache.at was already more than
    // SETTINGS_TTL_MS old (easy - the user can sit on the page for a while before touching
    // anything), a render in between this optimistic write and the save resolving would fire its
    // own getSettings() and could land after the save's own resolve, overwriting the just-saved
    // value with whatever the server still had queued to answer. A real bug this surfaced: the
    // hands-free checkbox could revert itself to unchecked moments after being checked, with
    // nothing in the UI explaining why - indistinguishable from "the toggle did nothing."
    settingsCache.at = Date.now();
    setStatus('Saving...');
    Promise.resolve(call('setSettings', patch)).then(function (merged) {
      if (merged && typeof merged === 'object') settingsCache.data = merged;
      settingsCache.at = Date.now();
      flashStatus('Saved.', true);
      schedule();
    }, function (e) {
      console.log('[dx-voice] setSettings error', e);
      flashStatus('Could not save: ' + ((e && e.message) || e), false, 4000);
    });
  }

  function fillSelect(sel, items, current, placeholder) {
    var want = JSON.stringify(items) + '|' + current;
    if (sel.__filled === want) return;
    sel.__filled = want;
    sel.innerHTML = '';
    if (!items.length && placeholder) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = placeholder;
      sel.appendChild(opt);
    }
    items.forEach(function (it) {
      var opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = it.name || it.id;
      sel.appendChild(opt);
    });
    if (current && sel.querySelector('option[value="' + CSS_ESCAPE(current) + '"]')) sel.value = current;
  }
  function CSS_ESCAPE(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function refreshVoicePanel() {
    if (!pickerEl) return;
    var v = voice();
    var providerSel = pickerEl.querySelector('#aiondx-voice-provider');
    var keyInput = pickerEl.querySelector('#aiondx-voice-apikey');
    var voiceSel = pickerEl.querySelector('#aiondx-voice-voice');
    var note = pickerEl.querySelector('[data-testid="aiondx-voice-note"]');
    var handsFreeBox = pickerEl.querySelector('#aiondx-voice-handsfree');
    var wakeInput = pickerEl.querySelector('#aiondx-voice-wakephrase');

    var disabled = !v;
    [providerSel, keyInput, voiceSel, pickerEl.querySelector('.aiondx-voice-reveal'), handsFreeBox, wakeInput].forEach(function (c) { c.disabled = disabled; });
    if (disabled) { setStatus('Voice module not loaded yet.', false); return; }

    ensureSettingsLoaded();
    var settings = settingsCache.data || {};
    if (document.activeElement !== keyInput && typeof settings.apiKey === 'string' && keyInput.value !== settings.apiKey) keyInput.value = settings.apiKey;
    if (handsFreeBox.checked !== !!settings.handsFree) handsFreeBox.checked = !!settings.handsFree;
    if (document.activeElement !== wakeInput) {
      var wantWake = settings.wakePhrase || DEFAULT_WAKE_PHRASE;
      if (wakeInput.value !== wantWake) wakeInput.value = wantWake;
    }
    paintHandsFreeNote();

    // Providers: cached 30 s, since listProviders() is likely a plain in-memory list, not a network call.
    if (!providerCache.list && !providerCache.loading) {
      providerCache.loading = true;
      var pp = call('listProviders');
      Promise.resolve(pp).then(function (list) {
        providerCache.loading = false;
        providerCache.list = Array.isArray(list) && list.length ? list : [{ id: 'elevenlabs', name: 'ElevenLabs' }];
        providerCache.at = Date.now();
        schedule();
      }, function () {
        providerCache.loading = false;
        providerCache.list = [{ id: 'elevenlabs', name: 'ElevenLabs' }];
        schedule();
      });
    }
    var providers = providerCache.list || [{ id: 'elevenlabs', name: 'ElevenLabs' }];
    fillSelect(providerSel, providers, settings.provider, null);
    if (!settings.provider && providers.length) providerSel.value = providers[0].id;

    // Voices: refetched whenever the chosen provider changes, or an API key arrives after it (a
    // provider with no key rejects, which looked identical to "no voice list" until the key
    // landed and the cache, keyed on providerId alone, never asked again). Also an optional
    // network call: a provider with no voice list rejects or is absent, not a hard failure.
    var providerId = providerSel.value;
    var voiceKey = providerId + '|' + (settings.apiKey ? 'k' : '');
    if (voiceCache.key !== voiceKey && !voiceCache.loading) {
      voiceCache.loading = true;
      var vp = call('listVoices');
      Promise.resolve(vp).then(function (list) {
        voiceCache = { at: Date.now(), key: voiceKey, list: Array.isArray(list) ? list : [], unsupported: false };
        schedule();
      }, function () {
        voiceCache = { at: Date.now(), key: voiceKey, list: [], unsupported: true };
        schedule();
      });
    }
    if (voiceCache.unsupported || (voiceCache.key === voiceKey && !voiceCache.list.length)) {
      note.hidden = false;
      note.textContent = 'This provider has no voice list; it uses its own default voice.';
      voiceSel.hidden = true;
    } else {
      note.hidden = true;
      voiceSel.hidden = false;
      fillSelect(voiceSel, voiceCache.list || [], settings.voiceId, 'Loading voices...');
    }
  }

  // ---------------------------------------------------------------- render loop

  function render() {
    try { ensureVoiceClient(); } catch (e) { console.log('[dx-voice] voice client init failed', e); }
    // due() is keyed by name and stamps "last ran" the instant it returns true, so calling it
    // twice for two different checks in the same pass would make the second call see its own
    // first call as "already ran a moment ago" and skip - each distinct gate gets its own due()
    // call, stored once, then reused for every ensure*() that should share that cadence.
    var micDue = due('mic', 400);
    if (micDue) {
      try { ensureMicButtons(); } catch (e) { console.log('[dx-voice] mic render failed', e); }
      try { ensureStopAllButtons(); } catch (e) { console.log('[dx-voice] stop-all render failed', e); }
    }
    if (due('play', 400)) try { ensurePlayButtons(); } catch (e) { console.log('[dx-voice] play render failed', e); }
    if (due('panel', 1000)) try { ensureVoicePanel(); } catch (e) { console.log('[dx-voice] settings render failed', e); }
    // Its own due() key, not mic's: hands-free's stale-DOM-reference recovery (ensureHandsFree)
    // and badge repaint matter enough to keep on the composer buttons' own 400 ms cadence rather
    // than the settings panel's slower one, but gating it at all (on a big page only - due()
    // returns true unconditionally off one) keeps a long, busy hands-free conversation from
    // adding back the per-render cost the pacing above exists to avoid. After the settings panel,
    // so settingsCache (which ensureHandsFree reads) is as fresh as this pass can make it; after
    // the mic/stop-all/play buttons, so the composer/play-button lookups inside it find what this
    // same pass just ensured exists.
    if (due('handsfree', 400)) {
      try { ensureHandsFree(); } catch (e) { console.log('[dx-voice] hands-free render failed', e); }
      try { ensureHandsFreeBadges(); } catch (e) { console.log('[dx-voice] hands-free badge render failed', e); }
    }
  }

  function start() {
    ensureStyle();
    watchHover();
    render();
    new MutationObserver(function (records) { if (foreignChange(records)) schedule(); })
      .observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    // Leaving the conversation: ensureHandsFree() would tear down and restart on the next render
    // pass anyway (it checks hf.convId against the new route()), but a stop here is immediate
    // rather than waiting a frame, and pagehide has no "next frame" to rely on at all.
    window.addEventListener('hashchange', function () { if (activeMic) stopRecording(activeMic, true); stopPlayback(); teardownHandsFree(); schedule(); });
    window.addEventListener('pagehide', function () { if (activeMic) stopRecording(activeMic, true); stopPlayback(); teardownHandsFree(); });
    setInterval(render, 2000);   // a fallback poll, same resiliency margin patch 0001 keeps against a missed mutation
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.__aionDxVoiceUI = {
    build: BUILD,
    repaint: function () { render(); },
    micState: function () { return activeMic ? activeMic.__st.state : 'idle'; },
    playing: function () { return !!currentPlayback; },
    playbackActive: function () { return !!(loadingWrap || currentPlayback); },
    stopAll: function () { if (activeMic) stopRecording(activeMic, true); stopPlayback(); hf.lastError = ''; stopHandsFreeForGood(); },
    spokenText: spokenText,
    // Hands-free: hf.state for a test to assert against, and a way to hand startWakeListener/
    // captureUtterance a fake mic plus faster VAD timing (the same injection test-wake.js uses
    // for aiondx-voice.js itself: levelSource, createRecorder, pollMs, minSpeechMs, silenceMs,
    // threshold, maxSegmentMs) - test-only, never touched outside dev-smoke-test-handsfree.js.
    hfState: function () { return { active: hf.active, state: hf.state, key: hf.key }; },
    setHfTestOpts: function (opts) { hfInjectedOpts = Object.assign({}, hfInjectedOpts, opts || {}); },
    clearHfTestOpts: function () { hfInjectedOpts = {}; }
  };
})();
