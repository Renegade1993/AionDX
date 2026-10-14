/* aiondx-voice-ui.js - injected into the AionUi renderer via a <script> tag, the same way
 * patches\0001-renderer-dx\aionui-dx.js is (out\renderer\index.html inside app.asar).
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
  // aionui-dx.js's are private to its own closure: a same-origin path silently fails in the
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
  /** Which solo conversation is open, for hands-free mode's polling. Reimplemented rather than
   *  shared with aionui-dx.js's own route(), same reasoning as apiUrl()/csrf() above. Team pages
   *  are out of scope for hands-free (one mic, one composer, one "current conversation" - a team's
   *  per-member columns don't map onto that cleanly), so only #/conversation/<id> matches. */
  function route() {
    var m = location.hash.match(/^#\/conversation\/([^/?#]+)/);
    return m ? { kind: 'conv', id: m[1] } : null;
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
    '.aiondx-voice-hf-dot{width:7px;height:7px;border-radius:50%;background:var(--color-text-3);flex:0 0 auto}',
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
   *  to aionui-dx.js's own closure. */
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

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; render(); });
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
      setPlayState(wrap, 'error', (e && e.message) || 'synthesis failed');
    });
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

  function ensurePlayButtons() {
    var rows = document.querySelectorAll('[id^="message-"][data-message-type="text"]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!isAgentRow(row)) continue;
      var content = row.querySelector('[data-testid="message-text-content"]');
      // The button is inserted as content's sibling, not its child, so the dedupe check has to
      // look in the row (an earlier version checked inside content and never found its own button,
      // which piled up a fresh one on every render pass).
      if (!content || row.querySelector('.aiondx-voice-play')) continue;
      var wrap = buildPlayButton(content);
      content.parentNode.insertBefore(wrap, content.nextSibling);
    }
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
  var hf = { active: false, state: 'off', convId: null, wakeStop: null, abort: null, pollTimer: null, gen: 0, lastError: '' };
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
    hf.convId = null;
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

  function startWakeStage(ta, convId) {
    var myGen = hf.gen;
    var m = hfModule();
    if (!m || typeof m.startWakeListener !== 'function') { teardownHandsFree(); return; }
    setHfState('wake');
    var phrase = (settingsCache.data || {}).wakePhrase || DEFAULT_WAKE_PHRASE;
    var opts = Object.assign({
      phrase: phrase,
      transcribe: hfTranscribe,
      onWake: function () { if (myGen === hf.gen) startListenStage(ta, convId); },
      onError: function (e) {
        if (myGen !== hf.gen) return;
        console.log('[dx-voice] wake listener error', e);
        hf.lastError = (e && e.message) || 'could not start the microphone';
        stopHandsFreeForGood();
      }
    }, hfInjectedOpts);
    hf.wakeStop = m.startWakeListener(opts);
  }

  function startListenStage(ta, convId) {
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
      if (!clean) { startListenStage(ta, convId); return; }   // VAD cut a clip transcribe() read as empty: just listen again
      sendComposerText(ta, clean);
      waitForReplyThenPlay(ta, convId, myGen);
    }, function (e) {
      hf.abort = null;
      if (myGen !== hf.gen) return;
      console.log('[dx-voice] captureUtterance error', e);
      startListenStage(ta, convId);   // a timeout with nothing said, or a hiccup: keep listening, the conversation stays live
    });
  }

  /** Polls the conversation until the agent's turn finishes, then auto-plays its newest reply - the
   *  same play button a manual click would use, just triggered here instead of by the user. */
  function waitForReplyThenPlay(ta, convId, myGen) {
    setHfState('waiting-reply');
    function poll() {
      if (myGen !== hf.gen) return;
      fetch(apiUrl('/api/conversations/' + convId), { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (j) {
        if (myGen !== hf.gen) return;
        var data = j && (j.data || j);
        var status = data && data.status;
        if (status && status !== 'finished') { hf.pollTimer = setTimeout(poll, 1000); return; }
        var rows = Array.prototype.filter.call(document.querySelectorAll('[id^="message-"][data-message-type="text"]'), isAgentRow);
        var row = rows[rows.length - 1];
        var wrap = row && row.querySelector('.aiondx-voice-play');
        var content = row && row.querySelector('[data-testid="message-text-content"]');
        if (!wrap || !content) { hf.pollTimer = setTimeout(poll, 500); return; }   // the reply's row exists but ensurePlayButtons() has not reached it yet this frame
        setHfState('speaking');
        startPlayback(wrap, content);
        watchPlaybackThenListenAgain(wrap, ta, convId, myGen);
      });
    }
    poll();
  }

  /** Not back to the wake phrase - the user's own framing of this as a continuous conversation, so
   *  every turn after the first starts straight at captureUtterance(). */
  function watchPlaybackThenListenAgain(wrap, ta, convId, myGen) {
    var tick = setInterval(function () {
      if (myGen !== hf.gen) { clearInterval(tick); return; }
      var st = wrap.__st.state;
      if (st === 'idle' || st === 'error') {
        clearInterval(tick);
        if (myGen !== hf.gen) return;
        startListenStage(ta, convId);
      }
    }, 150);
  }

  /** The entry point from render(): starts, restarts (on a conversation switch) or tears down
   *  hands-free mode to match the setting and the page, without ever touching an already-running
   *  cycle for the conversation it is already running on. */
  function ensureHandsFree() {
    var settings = settingsCache.data || {};
    var enabled = !!settings.handsFree;
    var r = route();
    if (!enabled || !r) { if (hf.active) teardownHandsFree(); return; }
    if (hf.active && hf.convId === r.id) return;
    if (hf.active) teardownHandsFree();
    var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
    var ta = null;
    for (var i = 0; i < boxes.length; i++) {
      var cand = boxes[i].tagName === 'TEXTAREA' ? boxes[i] : boxes[i].querySelector('textarea');
      if (cand && cand.getClientRects().length && !cand.closest('[data-slot-id]')) { ta = cand; break; }   // the solo composer; team columns are out of scope
    }
    if (!ta) return;   // not rendered yet this frame; ensureHandsFree() runs again next render
    var m = hfModule();
    if (!m || typeof m.startWakeListener !== 'function' || typeof m.captureUtterance !== 'function') return;
    hf.active = true;
    hf.convId = r.id;
    hf.lastError = '';   // a fresh start (the checkbox just turned on, or a conversation switch): any previous error is stale now
    startWakeStage(ta, r.id);
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
  function hfStageLabel() {
    var phrase = (settingsCache.data || {}).wakePhrase || DEFAULT_WAKE_PHRASE;
    return hf.state === 'wake' ? 'Listening for “' + phrase + '”'
      : hf.state === 'listening' ? 'Listening for your message…'
      : hf.state === 'waiting-reply' ? 'Waiting for the reply…'
      : hf.state === 'speaking' ? 'Reading the reply aloud…'
      : '';
  }
  function paintHandsFreeBadge() {
    var show = hf.active && hf.state !== 'off';
    var label = hfStageLabel();
    var badges = document.querySelectorAll('.aiondx-voice-hf');
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      b.hidden = !show;
      if (b.getAttribute('data-state') !== hf.state) b.setAttribute('data-state', hf.state);
      var text = b.querySelector('.aiondx-voice-hf-text');
      if (text.textContent !== label) text.textContent = label;
      var aria = 'Hands-free conversation mode' + (label ? ': ' + label : ' is off');
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
    try { ensureMicButtons(); } catch (e) { console.log('[dx-voice] mic render failed', e); }
    try { ensureStopAllButtons(); } catch (e) { console.log('[dx-voice] stop-all render failed', e); }
    try { ensurePlayButtons(); } catch (e) { console.log('[dx-voice] play render failed', e); }
    try { ensureVoicePanel(); } catch (e) { console.log('[dx-voice] settings render failed', e); }
    // After the settings panel, so settingsCache (which ensureHandsFree reads) is as fresh as this
    // pass can make it; after the mic/stop-all/play buttons, so the composer/play-button lookups
    // inside it find what this same pass just ensured exists.
    try { ensureHandsFree(); } catch (e) { console.log('[dx-voice] hands-free render failed', e); }
    try { ensureHandsFreeBadges(); } catch (e) { console.log('[dx-voice] hands-free badge render failed', e); }
  }

  function start() {
    ensureStyle();
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
    hfState: function () { return { active: hf.active, state: hf.state, convId: hf.convId }; },
    setHfTestOpts: function (opts) { hfInjectedOpts = Object.assign({}, hfInjectedOpts, opts || {}); },
    clearHfTestOpts: function () { hfInjectedOpts = {}; }
  };
})();
