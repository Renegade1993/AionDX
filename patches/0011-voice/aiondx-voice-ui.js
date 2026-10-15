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
    '.aiondx-voice-mic,.aiondx-voice-play{display:inline-flex;align-items:center;justify-content:center}',
    '.aiondx-voice-mic-btn,.aiondx-voice-play-btn{display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1;position:relative}',
    '.aiondx-voice-mic-btn .aiondx-voice-icon,.aiondx-voice-play-btn .aiondx-voice-icon{width:14px;height:14px;display:inline-flex;color:var(--text-secondary)}',
    '.aiondx-voice-play-btn .aiondx-voice-icon{width:12px;height:12px}',
    '.aiondx-voice-mic-btn .aiondx-voice-icon svg,.aiondx-voice-play-btn .aiondx-voice-icon svg{width:100%;height:100%;display:block}',
    '.aiondx-voice-mic-btn[data-state="recording"]{color:#fff;background-color:rgb(var(--danger-6)) !important;border-color:rgb(var(--danger-6)) !important}',
    '.aiondx-voice-mic-btn[data-state="recording"] .aiondx-voice-icon{color:#fff}',
    '.aiondx-voice-mic-btn[data-state="recording"]{animation:aiondx-voice-pulse 1.4s ease-out infinite}',
    '.aiondx-voice-mic-btn[data-state="error"]{color:rgb(var(--danger-6)) !important}',
    '.aiondx-voice-mic-btn[data-state="transcribing"],.aiondx-voice-play-btn[data-state="loading"]{cursor:default}',
    '.aiondx-voice-mic-btn[data-state="transcribing"] .aiondx-voice-icon svg,.aiondx-voice-play-btn[data-state="loading"] .aiondx-voice-icon svg{animation:aiondx-voice-spin 0.9s linear infinite}',
    '.aiondx-voice-mic-btn[disabled],.aiondx-voice-play-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '.aiondx-voice-play-btn[data-state="playing"]{color:rgb(var(--primary-6)) !important}',
    '.aiondx-voice-play-btn[data-state="playing"] .aiondx-voice-icon{color:rgb(var(--primary-6))}',
    '.aiondx-voice-play-btn[data-state="playing"]{animation:aiondx-voice-pulse-soft 1.6s ease-out infinite}',
    '@keyframes aiondx-voice-pulse{0%{box-shadow:0 0 0 0 rgba(var(--danger-6),.45)}70%{box-shadow:0 0 0 7px rgba(var(--danger-6),0)}100%{box-shadow:0 0 0 0 rgba(var(--danger-6),0)}}',
    '@keyframes aiondx-voice-pulse-soft{0%{box-shadow:0 0 0 0 rgba(var(--primary-6),.35)}70%{box-shadow:0 0 0 6px rgba(var(--primary-6),0)}100%{box-shadow:0 0 0 0 rgba(var(--primary-6),0)}}',
    '@keyframes aiondx-voice-spin{to{transform:rotate(360deg)}}',
    '.aiondx-voice-playrow{margin-top:2px}',
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

  /** A reply's text sits in an open shadow root (ShadowView), not the host's own light DOM, so
   *  content.textContent alone is empty for a rendered agent message. */
  function messageText(content) {
    var sh = content.querySelector('.markdown-shadow');
    if (sh && sh.shadowRoot) return (sh.shadowRoot.textContent || '').trim();
    return (content.textContent || '').trim();
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
      if (!t.closest || !t.closest('.aiondx-voice-mic, .aiondx-voice-play, .aiondx-voice-panel')) return true;
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

  var currentPlayback = null;   // { wrap, audio, url }

  function stopPlayback() {
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
    btn.disabled = !canUse || st.state === 'loading';
    var label = !canUse ? 'Play this reply: the voice module is not loaded'
      : st.state === 'playing' ? 'Stop playback'
      : st.state === 'loading' ? 'Preparing audio...'
      : st.state === 'error' ? 'Could not play this reply: ' + (st.detail || 'synthesis failed') + '. Click to try again.'
      : 'Play this reply aloud';
    if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    if (btn.hasAttribute('title')) btn.removeAttribute('title');
  }

  function startPlayback(wrap, content) {
    stopPlayback();
    var text = messageText(content);
    if (!text) { setPlayState(wrap, 'error', 'nothing to read'); return; }
    setPlayState(wrap, 'loading');
    var p = call('synthesize', text, (settingsCache.data || {}).voiceId);
    (p || Promise.reject(new Error('no voice module'))).then(function (result) {
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
      if (st.state === 'playing') stopPlayback();
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
      '<div class="aiondx-voice-desc" data-testid="aiondx-voice-privacy">What you say, and each reply you play back, is sent to the provider you pick (ElevenLabs today), under your own account and key. Nothing is sent until you enter a key and press the microphone or a speaker button. The key is kept in AionDX\u2019s settings on this PC, as typed.</div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-provider">Provider</label>' +
        '<select id="aiondx-voice-provider" data-testid="aiondx-voice-provider"></select></div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-apikey">API key</label>' +
        '<input type="password" id="aiondx-voice-apikey" data-testid="aiondx-voice-apikey" autocomplete="off" placeholder="API key">' +
        '<button type="button" class="aiondx-voice-reveal arco-btn arco-btn-secondary arco-btn-size-small" data-testid="aiondx-voice-reveal">Show</button></div>' +
      '<div class="aiondx-voice-row"><label class="aiondx-voice-label" for="aiondx-voice-voice">Voice</label>' +
        '<select id="aiondx-voice-voice" data-testid="aiondx-voice-voice"></select></div>' +
      '<div class="aiondx-voice-note" data-testid="aiondx-voice-note" hidden></div>' +
      '<div class="aiondx-voice-status" data-testid="aiondx-voice-status"></div>';

    var providerSel = el.querySelector('#aiondx-voice-provider');
    var keyInput = el.querySelector('#aiondx-voice-apikey');
    var reveal = el.querySelector('.aiondx-voice-reveal');
    var voiceSel = el.querySelector('#aiondx-voice-voice');

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

    var disabled = !v;
    [providerSel, keyInput, voiceSel, pickerEl.querySelector('.aiondx-voice-reveal')].forEach(function (c) { c.disabled = disabled; });
    if (disabled) { setStatus('Voice module not loaded yet.', false); return; }

    ensureSettingsLoaded();
    var settings = settingsCache.data || {};
    if (document.activeElement !== keyInput && typeof settings.apiKey === 'string' && keyInput.value !== settings.apiKey) keyInput.value = settings.apiKey;

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
    if (due('mic', 400)) try { ensureMicButtons(); } catch (e) { console.log('[dx-voice] mic render failed', e); }
    if (due('play', 400)) try { ensurePlayButtons(); } catch (e) { console.log('[dx-voice] play render failed', e); }
    if (due('panel', 1000)) try { ensureVoicePanel(); } catch (e) { console.log('[dx-voice] settings render failed', e); }
  }

  function start() {
    ensureStyle();
    watchHover();
    render();
    new MutationObserver(function (records) { if (foreignChange(records)) schedule(); })
      .observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', function () { if (activeMic) stopRecording(activeMic, true); stopPlayback(); schedule(); });
    window.addEventListener('pagehide', function () { if (activeMic) stopRecording(activeMic, true); stopPlayback(); });
    setInterval(render, 2000);   // a fallback poll, same resiliency margin patch 0001 keeps against a missed mutation
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.__aionDxVoiceUI = {
    build: BUILD,
    repaint: function () { render(); },
    micState: function () { return activeMic ? activeMic.__st.state : 'idle'; },
    playing: function () { return !!currentPlayback; },
    stopAll: function () { if (activeMic) stopRecording(activeMic, true); stopPlayback(); }
  };
})();
