# 0011-voice: provider-agnostic voice (TTS/STT), ElevenLabs first

**Target:** renderer only (two plain global scripts, like patch 0001's `aiondx-ui.js`), plus one key
in AionUi's per-user settings store. **Status:** both halves done, wired into the build, and QA-verified
against a real AionUi 2.2.2 base (2026-10-11):
- `node patches\0011-voice\test-voice.js` - 46/46.
- `node patches\0011-voice\dev-smoke-test.js` - 34/34 (UI against a stub, real mouse + fake mic, headless Edge).
- `node patches\0011-voice\dev-smoke-test-real.js` - 18/18 (UI against the real module, only `fetch` stubbed).
- `tools\build-release.ps1 -StageOnly` against AionUi 2.2.2's real `app.asar`, full apply order
  (0001, 0011, 0003, 0006, 0009, 0010): every patch's anchors matched, including both of 0011's
  (the `index.html` script-tag insertion and the two `Copy-Item`s) - no anchor-match failures. The
  asar packed and verified clean (41726 entries, 36275 checked against sources). Staged app: 860 MB.
- `tools\privacy-check.js`, the three calls `build-release.ps1` itself runs on the staged output
  (renderer + README, the main-process block, the whole payload dir) - all clean, including
  `aiondx-voice.js` / `aiondx-voice-ui.js` in the renderer list.
- `tools\audit-literals.js` against the staged, extracted asar - 2 distinct contexts, both
  pre-existing and unrelated to voice (an MCP image-gen referer header, an installer failure-marker
  path); nothing from `aiondx-voice.js` / `aiondx-voice-ui.js`.

**Commit identity, fixed 2026-10-11:** the six commits this patch was originally built from carried identities `tools\privacy-check.js --commits` refuses before anything reaches GitHub - four of the Voice UI Engineer's commits used a local-only address instead of a GitHub no-reply one, and the Voice Core Engineer's two used this machine's own git identity, picked up from global git config rather than a committed-safe one. All six were rewritten (author and committer, each kept under their own name) with a scoped `git filter-branch --env-filter` to GitHub no-reply addresses. `node tools\privacy-check.js --commits` is clean on the rewritten chain; this branch is the canonical integration branch for the voice feature.

## Build 2026-10-11.2: markdown-to-speech, a global "stop all reading", and a loading-race bug

Live user testing on the staged build turned up three things, all in `aiondx-voice-ui.js` (the UI
half; `aiondx-voice.js` is unchanged and stays a dumb TTS/STT client):

- **Code blocks were read character-by-character.** The speaker button sent a reply's raw markdown
  straight to `synthesize()`, so a fenced code block came out as ElevenLabs sounding out punctuation
  and symbols. `spokenText(raw)` now runs before every `synthesize()` call: a fenced block becomes
  "a snippet of &lt;lang&gt; code." (or "a code block." with no language hint), an inline code span
  keeps its text with the backticks stripped, and heading `#`s, `**`/`*`/`__`/`_` emphasis, bullet
  and numbered list markers, and blockquote `>` are stripped; a markdown link reads its text, not
  the brackets or the URL. Plain text passes through unchanged apart from whitespace collapsing to
  single spaces (the reply isn't being displayed, so a line break doesn't need to survive).
- **A global "stop all reading" button**, the mic button's neighbour in the composer (same 28x28
  Arco circle, one per composer, all of them reflecting and controlling the same page-wide
  playback). Disabled with nothing playing; a click calls the same `stopPlayback()` a message's own
  speaker button does.
- **The bug behind the user's "had to shut down aiondx" report** (most likely cause, not confirmed
  against the real Electron app - see below): clicking a second message's speaker button while the
  first was still waiting on `synthesize()` never touched the first button - nothing reset it out of
  "loading" - and if that first request eventually resolved, it could go on to create a second
  `Audio` element fighting whatever was already playing. A stuck spinner with nothing to click, plus
  a dangling request, is exactly what "the app hung" looks like from outside. Fixed with a generation
  counter (`playGen`, bumped by every `startPlayback()`/`stopPlayback()`): a `synthesize()` result
  checks it before touching the DOM or creating an `Audio`, and a message's own button is now
  clickable while "loading" too (it cancels), not just while "playing" - there was no other way to
  unstick a single stuck request short of the new global button.
  **Not independently reproduced as a full application hang** - verified in headless Edge that the
  race existed and is fixed, not that it was the literal cause of the reported shutdown. Worth asking
  the user what else they were doing right before it hung (another tab/window, how many messages they
  clicked play on, whether AionDX was otherwise responsive) in case there is a second contributor.
- Regression coverage: `dev-smoke-test.js` gained 18 checks (6 for `spokenText`, 5 for the stop-all
  button, 7 reproducing the loading-race and proving it is fixed - two messages' play buttons raced
  with scripted clicks close enough together to land inside the stub's synthesize delay); `dev-smoke-test-real.js`
  gained 4 (markdown stripping, the stop-all button, all against the real module).

## Build 2026-10-11.3: wake-phrase listener and utterance capture (hands-free conversations)

New in `aiondx-voice.js` only (still a dumb, UI-agnostic client; no DOM/window touched) toward
hands-free back-and-forth: say a wake phrase to start talking, no mic-button click per turn.

- `AionDxVoice.startWakeListener({ phrase, onWake, transcribe, onCandidate?, onError?, levelSource?,
  createRecorder?, threshold?, pollMs?, silenceMs?, minSpeechMs?, maxSegmentMs? }) -> stopFn`.
  Polls a VAD-style level reading (RMS over the mic, via Web Audio's `AnalyserNode` by default)
  rather than streaming everything to ElevenLabs: a clip is only cut and sent to `transcribe()` once
  the level has read above `threshold` for `minSpeechMs` straight, and only once silence then holds
  for `silenceMs` (or the clip hits `maxSegmentMs` regardless). A clip whose transcript contains
  `phrase` (case-insensitive substring - deliberately simple, not a fuzzy matcher) calls
  `onWake(text)`; every other clip is dropped, optionally surfaced through `onCandidate(text)` for a
  "didn't catch that" debug affordance. Starting a new listener stops any previous one first - only
  one runs at a time. `transcribe` is required (typically `window.__aionDxVoice.transcribe`);
  `levelSource` + `createRecorder`, given together, let a caller reuse a mic stream it already owns
  (the composer's existing mic-button plumbing) instead of this module opening its own via
  `getUserMedia`.
- `AionDxVoice.stopWakeListener()` - stops whichever listener is active, a no-op if none is; the same
  as calling the function `startWakeListener` returned, for a caller that did not keep it (the "stop
  all" button's use case).
- `AionDxVoice.captureUtterance({ transcribe, levelSource?, createRecorder?, maxMs?, signal?, ... })
  -> Promise<string>` - one hands-free turn: the same VAD, a single segment instead of a loop,
  resolving with its transcript. `maxMs` (default 15000) bounds the whole call, including opening the
  mic; it rejects, never resolves `''`, if nothing was said in time. `opts.signal` (a standard
  `AbortSignal`) cancels it early, for the same "stop all" wiring.
- **No lingering mic, audio context or request after a stop.** The wake listener's `stop()` and
  cancelling `captureUtterance` (its timeout, an aborted signal, or settling normally) always: clear
  the poll timer, abort an in-flight `transcribe()` call where `AbortController` exists (an
  `AbortSignal` is now threaded through to `createElevenLabsProvider`'s and `createVoiceClient`'s
  `transcribe(audio, { signal })`, new in this build), stop an active recording, and close the mic
  stream/`AudioContext` - but only the ones this call opened itself; a caller-supplied
  `levelSource`/`createRecorder` is never touched, since the caller owns that lifecycle. A transcribe
  result that arrives after a stop is dropped rather than firing a stale `onWake` or resolving an
  already-settled promise.
- `AionDxVoice.createMicSource(opts)` - the default mic (real `getUserMedia` + `AudioContext` +
  `AnalyserNode` for the level, `MediaRecorder` for the clip), exported for a caller that wants its
  `{levelSource, createRecorder, close}` directly without going through the wake/utterance functions.
  Every constructor is injectable (`opts.getUserMedia`/`opts.AudioContext`/`opts.MediaRecorder`),
  which is how `test-wake.js` runs this file's whole state machine under plain Node with no
  microphone at all - a controllable fake level and a fake recorder, never this function in anger
  (one check just confirms it fails cleanly, instead of throwing something unhelpful, when there is
  no `getUserMedia` to call).
- Tests: `node patches\0011-voice\test-wake.js`, 22 checks, real timers (small ms values - `pollMs`
  10, `minSpeechMs` 40, `silenceMs` 60 - chosen with margin for Windows' coarser timer resolution
  rather than a fake clock): wake-phrase match and non-match, two listeners in a row (the second
  replacing the first), the module-level stop, `captureUtterance` resolving / timing out / aborting
  (both an already-aborted signal and one aborted mid-call), and the stale-result protection for both
  functions.
- `createMicSource`'s real-mic path is untested against an actual microphone or a real
  `AudioContext`/`MediaRecorder` - only its constructor-injection path is exercised, by
  `test-wake.js`'s fakes.

## Build 2026-10-11.4: hands-free conversation mode (the UI wiring for build .3's wake listener)

Say the wake phrase, then talk back and forth with an agent without touching the mic or speaker
button each turn. All in `aiondx-voice-ui.js`; it only sequences `aiondx-voice.js`'s
`startWakeListener`/`stopWakeListener`/`captureUtterance` and reuses its own existing pieces
(`insertTranscript`/`sendComposerText` for landing a turn in the composer, `startPlayback`/
`spokenText` for reading a reply back, the stop-all button for stopping it) - `aiondx-voice.js`
stays untouched, still a dumb client with no DOM.

- **Settings:** a checkbox ("Hands-free conversation mode", off by default) and a wake-phrase text
  field (default "Hey AionDX") on the same voice settings panel, saved onto the same
  `aiondx.voice.config` record (`setSettings({handsFree, wakePhrase})` - the store's merge means
  this never touches `provider`/`apiKey`/`voiceId`).
- **The cycle, once enabled on a solo conversation page:** `startWakeListener` in the background
  ("wake" stage, a small badge next to the mic button: `Listening for "Hey AionDX"`) -> the wake
  phrase heard -> `captureUtterance()` ("listening" stage: `Listening for your message...`) -> the
  turn's text goes through `sendComposerText` (the mic button's own text-insertion path, then a
  click on the real send button - "reuse that path" plus the one extra step auto-send needs) ->
  polls `GET /api/conversations/{id}` ("waiting-reply" stage) until the turn finishes -> the newest
  reply auto-plays through the existing `startPlayback`/`spokenText` pipeline ("speaking" stage, no
  click) -> once that playback ends, straight back to `captureUtterance()` - **not** back to the
  wake phrase, per the user's own framing of this as one continuous conversation, not a
  wake-once-per-turn assistant.
- **Stopping:** the stop-all button doubles as the exit control (it already stopped playback; now
  it also tears down the wake/utterance listeners and switches the setting off) - which meant that
  button had to become *enabled* through the "wake"/"listening"/"waiting-reply" stages too, not
  only while something is actually playing, since a disabled button never receives a real click at
  all (a genuine bug the first version of this build had, not just a label one: there was no way to
  stop a listening-but-not-yet-playing cycle from that button). A spoken stop phrase
  ("stop listening", "stop conversation", "exit voice mode", "stop hands-free" - checked the same
  simple case-insensitive-substring way the wake phrase itself is, against whatever
  `captureUtterance()` resolves with) does the same. Toggling the setting off, a hashchange
  (leaving the conversation) or `pagehide` (closing the tab) also tear it down - cleanly, since
  `stopWakeListener`/an aborted `captureUtterance` always release the mic and `AudioContext` on
  `aiondx-voice.js`'s side.
- **Soft vs. hard teardown, and why both exist:** `teardownHandsFree()` stops the running listeners
  without touching the `handsFree` setting (for a conversation switch or a page unload, where the
  feature should resume on whatever page is open next); `stopHandsFreeForGood()` additionally saves
  `handsFree: false` (for the user's own stop - the stop-all button or a spoken stop phrase).
  Conflating them was the first version's actual bug here: a spoken "stop listening" tore the
  listeners down but left the setting on, and the very next render pass (`ensureHandsFree()`,
  which the setting alone still told to run) started the wake listener right back up inside the
  same tick - an immediate, silent resurrection the user would have had no way to explain.
- **Stale-result guard:** `hf.gen`, bumped by every teardown and every stage's own start; every
  async step (a `captureUtterance()` resolve/reject, a status poll, the playback-ended watcher)
  checks it against the value it captured before beginning - the same pattern `startPlayback`'s
  `playGen` already uses for the loading-race bug, applied here so a stop or a conversation switch
  mid-flight can never have a late callback restart a stage, land a message, or start a playback
  the user already asked to stop.
- **Out of scope for this build:** team pages (`ensureHandsFree` only matches `#/conversation/<id>`
  - a team's per-member columns don't map onto "the current conversation" cleanly); a persistent
  `captureUtterance` failure (a revoked mic permission, say) just keeps retrying rather than backing
  off or giving up, since the conversation is meant to "stay live" - acceptable for now, worth
  revisiting if that turns out to spin uselessly in practice.
- Tests: `node patches\0011-voice\dev-smoke-test-handsfree.js`, 22 checks (16 the day this build
  landed, 6 more the next day for the fixes below), real mouse input, against the real
  `aiondx-voice.js` (its wake listener and utterance capture, unmodified) and the real
  `aiondx-voice-ui.js`, with only `window.fetch` stubbed and the VAD's mic swapped for a fake
  level source + fake recorder through `aiondx-voice-ui.js`'s own test-only
  `window.__aionDxVoiceUI.setHfTestOpts` hook (the same injection technique `test-wake.js` uses for
  `aiondx-voice.js` directly): the wake phrase is heard, the turn is captured and auto-sent, the
  reply auto-plays once the turn finishes, playback ending leads straight back to listening (not
  the wake phrase), a spoken stop phrase tears everything down, the stop-all button does too, and so
  does unchecking the setting. `dev-smoke-test.js` (34/34) and `dev-smoke-test-real.js` (18/18) are
  unaffected regressions-checked, since neither harness sets `window.AionDxVoice`'s wake/utterance
  functions into motion (the setting defaults off, and neither harness's page sets a conversation
  hash `ensureHandsFree()` would match) - `dev-harness-handsfree.html` is its own page, built for
  this feature specifically.

### 2026-10-13 fixes: "the toggle shows no badge at all"

A user report: enabling the setting on the staged build showed no "Listening for ..." badge
anywhere, nothing visibly changed. Three things, found by code review (a live-app repro attempt
hit tooling trouble and was not pursued further):

- **The badge is easy to never see.** It only ever renders inside a conversation's own composer
  (`.sendbox-actions`) - never on the Settings page the toggle itself lives on. Toggling it and
  staying on Settings, without opening a conversation, correctly shows nothing - not a bug, but
  indistinguishable from one. Fixed by adding a second, persistent status line inside the settings
  panel itself (`handsFreeStatusText`/`paintHandsFreeNote`, next to the wake-phrase field): "running:
  &lt;stage&gt;", "on, but only runs inside a conversation - open one to start it", or the stopped
  reason - visible from the one screen the toggle is on, independent of whether a conversation
  composer is anywhere in view.
- **A real failure to start (mic permission denied, say) said nothing anywhere but the console,**
  and silently switched the setting back off - from the user's side, indistinguishable from the
  toggle simply not working. `hf.lastError` is now set by the wake listener's `onError` and surfaced
  by that same settings-panel line ("Hands-free mode stopped: &lt;reason&gt;. Turn it back on to try
  again."), styled as a problem (the same `data-ok="0"` red the save-status line already uses).
  Cleared on a fresh, deliberate start (`ensureHandsFree`'s own restart) or a deliberate stop (the
  user unchecking the box, the stop-all button, a spoken stop phrase) so a stale error never lingers
  past the point where it stopped being true. Getting the order right mattered: checking it had to
  come *before* checking whether the setting itself is still on, since the failure path also
  switches that off in the same breath - checking the setting first would blank the very note that
  explains why in the same tick it had something to say.
- **A real race in `saveSettings`:** its optimistic write didn't bump `settingsCache.at`, so a
  `getSettings()` refetch already in flight (every render pass the panel is visible can start one,
  on a ~5 s cache) could land after it and silently revert whatever was just saved, with nothing
  surfacing the revert - plausible as a quieter, intermittent version of the same "toggle did
  nothing" symptom. Fixed by bumping `settingsCache.at` at the optimistic write too, not only once
  the save resolves.

### The actual root cause: team pages were not matched at all

Follow-up from the user: they were testing the wake word in an actual conversation with the lead
agent specifically - not sitting on the Settings screen. That conversation is `#/team/<id>`, not
`#/conversation/<id>` - the only route `ensureHandsFree()` matched. On a team page it did exactly
nothing, every time, by design (`route()` returned `null`), which is the real, fully reproducible
explanation the three fixes above do not cover by themselves.

Extended `route()`/`ensureHandsFree()` to also match a team page, targeting the lead's own column
specifically (`div[data-slot-id][data-role="leader"]`, `TeamPage.tsx`'s own attribute - the same
one patch 0001 reads for its Loop pills). A teammate's own column is still out of scope: picking
which of several members a wake phrase should address is a bigger design question than this fix
takes on. `ta`/`convId` threaded through the engine as separate parameters became a single
`target = { kind, id, ta, scope }` so the rest of the cycle (sending, polling, auto-play) does not
need to know which kind of page it is running on:

- **Sending** needs no special handling at all: `sendComposerText` already just clicks whichever
  composer's own real send button it is given, and that button already does the right thing for
  its own context (solo, team lead, or - untouched by this feature - a teammate) because it is
  AionUi's own button, not a path this file reimplements.
- **"Has the turn finished"** does differ: a solo chat's own `GET /api/conversations/{id}` status
  has no team equivalent, so a team target polls `GET /api/teams/{id}/run-state`'s `slot_work`
  instead, the same source and the same "state is idle" rule patch 0001's Loop already uses for a
  team member's turn.
- **Finding the newest reply** is now scoped to `target.scope` (the lead's own column element on a
  team page, the whole document for a solo chat) rather than the whole page - a team page can have
  several composers and several messages on screen in different columns at once.
- **The badge was showing in every composer on the page, not just the one hands-free is actually
  running for** - a side effect only visible once team pages have more than one composer in view
  at a time; a solo chat only ever has one, so this went unnoticed in build .4. `hf.target` is kept
  so `paintHandsFreeBadge` can tell a composer that happens to share the page from the one it is
  actually bound to, and show only in the latter.
- Tests: `node patches\0011-voice\dev-smoke-test-handsfree-team.js`, 12 checks, a two-column team
  page (lead + a teammate) with its own `run-state` stub: enabling targets the lead's column, the
  badge shows there and nowhere else, the wake phrase and the turn both flow through the lead's
  composer, the teammate's composer is never touched, "waiting" correctly does not resolve while
  `run-state` still says the lead is running, the reply (inside the lead's column) auto-plays once
  it goes idle, and the lead column's own stop-all button ends it. Also fixed a weak assertion in
  `dev-smoke-test-handsfree.js` found while writing the team version of it: its "badge is hidden"
  check tested `.aiondx-voice-hf-badge`, which is a `data-testid` value, not a class - the check
  always took its vacuously-true fallback branch and never actually looked at the badge. Still
  22/22, now checking something. `dev-smoke-test.js` (34/34), `dev-smoke-test-real.js` (18/18),
  `test-voice.js` (46/46) and `test-wake.js` (22/22) regression-checked clean.

## 2026-10-17: a failed transcribe() was never swallowed in silence, it was swallowed in the dark

The live reports ("the wake phrase does nothing") traced back to `aiondx-voice.js` itself, found by
the lead through live CDP debugging against the running staged app: the mic, `getUserMedia`,
`createMicSource`'s level computation, and the real ElevenLabs key/endpoint all worked - a real RMS
level crossed the VAD threshold while the user spoke, and a deliberately garbage blob sent through
the real `transcribe()` got back a genuine `400 invalid_audio` from ElevenLabs (proof the wiring and
the key are both fine, not an auth failure). What was never checked: whether a *real recorded clip*
reaching that same `transcribe()` succeeds. `runVad`'s `finishSegment()` had, since build 2026-10-11.3:

```js
}, function () {
  controller = null; // a failed or aborted clip: say nothing, keep listening
});
```

Every rejection - an ElevenLabs error, a network blip, anything - was dropped with no signal of any
kind: not `onSegment`, not `onCandidate`, not an exception, nothing. From outside `aiondx-voice.js`
there was no way to tell "the mic never heard anything" apart from "it heard plenty, and every clip
is failing to transcribe" - both looked exactly like silence. The UI's own stall diagnostic
(`e47dfda`, `onCandidate`-based) could not catch this either: `onCandidate` only ever fires from
`onSegment`, which a failed clip never reaches.

**Fix:** `runVad` takes a new optional `onSegmentError(err)`, called from `finishSegment`'s rejection
branch for a real failure (not for `stopped` - our own `stop()` aborting an in-flight call on purpose
is not a failure to report). Wired through as two distinct callbacks, since they mean different
things to a caller:
- `startWakeListener({ ..., onTranscribeError })` - fires per failed clip; the listener keeps running
  (one bad clip, or one ElevenLabs error, says nothing about the next one), the same way `onCandidate`
  already does not stop the loop.
- `captureUtterance({ ... })` - a failed clip now rejects the whole call immediately with that same
  error, instead of silently waiting out `maxMs` for a segment that already happened and already
  failed (a much slower, much less diagnosable way to fail).

**On the "is it a format/duration problem" half of the ask:** checked against ElevenLabs' own current
API docs rather than guessing - `audio/webm` is an explicitly accepted format for `/v1/speech-to-text`,
the minimum audio length is 100 ms (this VAD's shortest possible clip, `minSpeechMs` worth of speech
plus `silenceMs` of trailing silence, is already several times that by construction), and the
endpoint/field names/`model_id: scribe_v1` this file already sends match the documented request shape
exactly. Nothing here pointed at a format or duration bug specifically - the more useful next step is
reading the *actual* error `onTranscribeError` surfaces on the next live retest, now that there is
one to read, rather than continuing to guess blind.

Tests: `node patches\0011-voice\test-wake.js`, 27/27 (5 new: a failed clip calls
`onTranscribeError` with the real error and neither `onCandidate` nor `onWake`; the listener keeps
running afterward and a later good clip still wakes it; `captureUtterance` rejects with the
transcribe error itself, immediately, not after `maxMs`). `test-voice.js` unaffected, still 46/46.
`tools\privacy-check.js --files patches\0011-voice\aiondx-voice.js patches\0011-voice\test-wake.js`
clean.

**Not yet done:** the UI side (`aiondx-voice-ui.js`'s `onError` handler) does not yet wire the new
`onTranscribeError` - for the Voice UI Engineer, who already has `onCandidate`/`onError` wired at the
same call site (`startWakeStage`) and can likely surface it the same way (`hf.lastError`, the badge
text) rather than treating it as fatal like the real `onError` is. Live retest still pending to see
the actual error message now that one will finally show up.

### The UI wiring (`onTranscribeError`), and what it displaces

`startWakeStage` passes `onTranscribeError` alongside `onCandidate`/`onError`: unlike the fatal
`onError` (the listener could not start at all), it does not stop anything - the wake listener keeps
running, same as Core Engineer's own design (one bad clip says nothing about the next one). It sets
`hf.transcribeErrorMsg` and marks `hf.sawActivity` too, since a failed transcribe still proves the
mic/VAD recorded and sent a real clip - that distinction mattered: without it, the stall hint
(`hfStageLabel`, build .4) would have kept saying "no microphone activity detected" while every clip
was in fact reaching ElevenLabs and failing there, which is backwards. The transcribe-error text now
takes priority over the stall hint whenever both could apply, surfaced in the composer badge and the
settings panel's status line alike: `Listening for "<phrase>" — transcription failed: <reason>`.

`captureUtterance`'s side of the same fix (the "listening for your message" stage, not just "wake")
needed no new UI wiring - it already rejects the whole call with the real error now instead of
silently waiting out `maxMs`, and `startListenStage`'s existing catch-all retry (`console.log`, try
again) already handles that correctly; a future pass could surface *that* error too, the same way,
if a live retest shows it mattering there as well.

Tests: `dev-smoke-test-handsfree.js` gained 3 (a forced `429` from the speech-to-text stub during
the wake stage: the badge and the settings-panel status line both show "transcription failed:
elevenlabs transcribe failed: http 429 quota exceeded" instead of the generic stall hint, and
hands-free stays active afterward rather than tearing down) - now 26/26. `dev-smoke-test-handsfree-team.js`
(12/12), `dev-smoke-test.js` (34/34) and `dev-smoke-test-real.js` (18/18) regression-checked clean.

### The other half: stale DOM references across a long wake/listen cycle

A live retest afterward showed the symptom unchanged - the badge and the dot still never moved,
not even the stall hint after 8+ real seconds. Checked from the render-loop side, not the audio
side, per the lead's steer: `setInterval(render, 2000)` and `HF_STALL_MS` both proved correct over
real unaccelerated time in an isolated check, which pointed at something specific to a live page,
not a timing bug in general.

Found it: `ensureHandsFree()` already re-searches the live DOM for the current composer on every
render pass (`findHfTarget`), but on the "already running for this target" path it threw that
fresh result away and kept whatever `hf.target` was set to when the cycle first began. Every stage
after that - `startWakeStage`, `startListenStage`, `waitForReplyThenPlay`,
`watchPlaybackThenListenAgain` - took `target` as a parameter closed over at that same moment and
never revisited it. A real page re-rendering the composer (a team page especially, streaming
output, a new message, anything) replaces those DOM nodes without the route ever changing, so
`hf.key` stays the same and nothing above ever reran - but `target.ta`/`target.scope` now point at
detached nodes. `sendComposerText(target.ta, ...)` against a detached textarea dispatches its
`'input'` event to nothing; a click on a detached send button reaches no listener. Nothing throws;
nothing errors; the call "succeeds" and does nothing - which is "the wake phrase does nothing,"
exactly the report, independent of whether the badge itself is visible.

Fixed both ends: `ensureHandsFree()` now updates `hf.target` (and repaints) when its fresh search
finds different nodes for the same key, instead of discarding them; the four stage functions above
all read `hf.target` at the point they actually touch the DOM instead of taking it as a parameter,
so a long cycle always acts against whatever is live right now, not whatever was live when it
started.

Test: `dev-smoke-test-handsfree.js`'s harness gained `window.__replaceComposer()` (rebuilds the
composer from a template captured before this script ever touched it - bare markup only, the way
React replacing its own render output would not carry this script's injected nodes along) and a
delegated send-button listener (so it survives the swap the same way React's own handler would).
New checks: mid-"wake," the composer is replaced; the badge in the *new* composer stays visible and
`data-state="wake"` (not stuck on the detached one); the wake phrase, the turn, and the send button
all still work correctly afterward, against the fresh nodes - the existing listening/sending checks
run unmodified post-replacement, since there is only one composer left in the DOM once the swap
happens. 28/28.

## What it adds

`aiondx-voice.js`: a small interface any text-to-speech / speech-to-text provider can implement,
one implementation of it for ElevenLabs, and a tiny settings store so the user's chosen provider,
API key and voice survive a restart.

```ts
interface VoiceProvider {
  id: string;
  name: string;
  synthesize(text: string, opts?: { voiceId?: string; modelId?: string }): Promise<Blob>;
  transcribe(audio: Blob): Promise<string>;
  listVoices?(): Promise<{ id: string; name: string }[]>;
}
```

`AionDxVoice.createProvider({ provider: 'elevenlabs', apiKey, voiceId })` builds one from the same
plain object the settings store keeps. Adding a second provider later is one more entry in the
file's `PROVIDERS` map and a `create` function with this shape; nothing that calls `createProvider`
or uses the `VoiceProvider` it returns needs to change.

**The convenience client.** `AionDxVoice.createVoiceClient(opts)` wraps the two pieces above into a
flat "current provider" object for a caller that just wants "transcribe this" / "say this" without
juggling a provider and a settings store itself - the shape the composer UI's `window.__aionDxVoice`
stub already uses:

```js
client.transcribe(audioBlob)          // -> Promise<string>
client.synthesize(text, voiceId?)     // -> Promise<Blob>
client.listVoices()                   // -> Promise<{id,name}[]>, [] if the provider has none
client.listProviders()                // -> Promise<{id,name}[]>
client.getSettings()                  // -> Promise<{provider, apiKey, voiceId, at} | {}>
client.setSettings(patch)             // -> Promise<the merged record>
```

It reads the stored config on first use, builds the matching provider, and rebuilds it only when
`setSettings` actually changes `provider`/`apiKey`/`voiceId`; a plain `transcribe`/`synthesize` call
costs one settings-store read plus the provider call, no extra round trip. `apiKey` comes back from
`getSettings` as the user typed it (not masked) - masking it for display, if wanted, is on whoever
renders the settings panel.

**ElevenLabs.** `synthesize` posts to `POST /v1/text-to-speech/{voiceId}` (JSON body `{text,
model_id}`, `model_id` defaults to `eleven_multilingual_v2`) and returns the response body as a
`Blob` (`audio/mpeg`) - enough to hand straight to an `<audio>` element or `URL.createObjectURL`.
`transcribe` posts a `multipart/form-data` body (`model_id: scribe_v1`, the audio as `file`) to
`POST /v1/speech-to-text` and returns its `text` field (`transcript` as a fallback, in case an
older or newer response shape uses that name instead). `listVoices` reads `GET /v1/voices` and maps
`{voice_id, name}` to `{id, name}`. The key goes only in the `xi-api-key` header, on every call;
with no key configured, every method rejects before it would make a network call, so a bad config
never reaches ElevenLabs as an anonymous request. A failed call's error names the HTTP status and
ElevenLabs' own error body (helpful for "voice not found" or "quota exceeded"), never the key.

## How the pieces fit

**The settings record.** `aiondx.voice.config`, one record, in AionUi's per-user key-value store
(`GET/PUT /api/settings/client`; aionui-system `client_pref.rs`: a flat map, per-key upsert, null
deletes, no side effects on any conversation - the same store patch 0007's Loop tool and patch
0001's renderer use for `aiondx.loop.*` and `aiondx.usage.*`, and patch 0002 for `aiondx.usage.config`):

| field | holds |
|---|---|
| `provider` | the provider id (`elevenlabs`) |
| `apiKey` | the provider's API key, as the user typed it |
| `voiceId` | the chosen voice, or unset for the provider's own default |
| `at` | when this record was last written (the store's usual convention) |

`AionDxVoice.createSettingsStore(opts).setConfig(patch)` reads the current record first and merges
`patch` onto it (so picking a voice does not require resending the key), then writes the merged
record with a fresh `at`. `getConfig()` returns the record or `null`; `clearConfig()` deletes it.

**No window, no DOM, no bundler.** This file depends on nothing but `fetch`, `Blob` and
`FormData`, which Node 18+ and every browser both have, so the same file runs as `window.AionDxVoice`
in the renderer and as `module.exports` under plain Node for its own tests - the same UMD shape
`require('./aiondx-voice.js')` in `test-voice.js` and a `<script>` tag both load. It never reads
`window`, `localStorage` or a cookie itself: a caller passes in how to reach the store (`opts.request`,
or `opts.baseUrl` / `opts.csrfToken` for the default fetch-based one, the same shape patch 0001's
`apiUrl`/`csrf`/`postJson` already builds) and, for tests only, how to reach "ElevenLabs"
(`opts.fetch`). The real renderer wiring (the script tag, and what `baseUrl`/`csrfToken`/`fetch` the
composer passes) is the other half of this folder - see "Not yet done" below.

**The key is never logged.** No call in this file passes the settings record or the `apiKey` field
to `console.*`; a failed network call reports only the HTTP status and the remote error text, never
what was sent. `tools\privacy-check.js --files patches\0011-voice\aiondx-voice.js` is clean (its key
pattern list would also catch an ElevenLabs-shaped key if one were ever hardcoded here, which none
is - the key always comes from the settings record at call time).

## Files

| file | what |
|---|---|
| `aiondx-voice.js` | the interface, `createElevenLabsProvider`, the provider registry (`createProvider`, `listProviders`), `createSettingsStore`, `createVoiceClient` (the flat convenience wrapper), and the wake-phrase/utterance-capture VAD engine (`startWakeListener`, `stopWakeListener`, `captureUtterance`, `createMicSource`) |
| `test-voice.js` | 46 checks against a stand-in HTTP server standing in for both ElevenLabs and the settings store - no real network, no real AionUi, no real key |
| `test-wake.js` | 22 checks for the wake-phrase listener and utterance capture, against a fake level source and a fake recorder - no real microphone |
| `aiondx-voice-ui.js` | the composer's mic button (idle/recording/transcribing, matching patch 0001's 28x28 Arco circle pills), a speaker button on each agent reply (idle/loading/playing, stops on a second click or the clip ending), and a settings panel section on Settings > Appearance (provider, API key, voice, from `listVoices()` when the provider offers one) |
| `dev-harness.html`, `voice-provider.stub.js`, `dev-smoke-test.js` | a UI-only dev loop: a minimal composer/message/settings DOM plus a stand-in `window.__aionDxVoice` (not shipped), driven with real mouse and a fake microphone in headless Edge, 16/16 |
| `dev-harness-real.html`, `dev-smoke-test-real.js` | the same real-mouse check against the actual `aiondx-voice.js`, with only `window.fetch` stubbed (the settings store and ElevenLabs' three endpoints) - no real network or key, 14/14 |

## Installing, checking, removing

Wired into the build the same way `aiondx-ui.js` is: two more script tags in `index.html`
(`<script src="./aiondx-voice.js" defer></script>` then `<script src="./aiondx-voice-ui.js" defer></script>`,
module before the UI that builds a client from it), a `Copy-Item` of each file to
`out\renderer\`, both added to `tools\privacy-check.js`'s `--files` list, and `0011-voice` added to
the release manifest's `patches` list - all in `tools\build-release.ps1`. `aiondx-voice-ui.js` builds
`window.__aionDxVoice = window.AionDxVoice.createVoiceClient({ baseUrl: apiUrl(''), csrfToken: csrf })`
with its own `apiUrl()`/`csrf()`, matching patch 0001's (same-origin paths silently fail in the
desktop app - patch 0001's "Bug that shipped" section has the full story).

Checks, none of them touching a real AionUi install:
- `node patches\0011-voice\test-voice.js` - the module's own 46 checks.
- `node patches\0011-voice\dev-smoke-test.js` - the UI against a stand-in client (real mouse + fake mic, headless Edge).
- `node patches\0011-voice\dev-smoke-test-real.js` - the UI against the real module, only `fetch` stubbed.

Removing: delete the two script tags and the two `Copy-Item` lines above, and the two files from
`out\renderer\`; nothing else in the app references them. The settings record
(`aiondx.voice.config`) is left in the store, the same as any other `aiondx.*` setting a removed
patch leaves behind.

## Not yet done

- A second provider, if ever wanted: one more `PROVIDERS` entry in `aiondx-voice.js`; everything
  else in this file and in the UI stays the same.
- `dev-smoke-test.js` / `dev-smoke-test-real.js` already use `click-test.js`'s own technique (real
  mouse via the DevTools protocol, one headless Edge, the same hold-and-release timing) against a
  purpose-built mic/playback/settings DOM; QA judged that sufficient dx-harness-style coverage for
  all three surfaces rather than duplicating it inside `click-test.js` itself, which is specific to
  patch 0001's app-shaped harness. Not yet run: against a real ElevenLabs account (both dev-smoke
  suites stub the network), or inside `click-test.js`'s own `harness.html` alongside patch 0001's
  checks.
- The wake-phrase listener and utterance capture (build 2026-10-11.3 above) are core-module-only so
  far; the UI wiring and a real-microphone check are listed in that section.
- Still unresolved: the commit-identity finding above.

## October 14th, 2026: changes made while merging into main (the AionDX owner's review)

The patch was merged as it came (commit 0091a9b; its own tests pass: `test-voice.js` 46, `dev-smoke-test.js` 16, `dev-smoke-test-real.js` 14). Three changes on top, in `aiondx-voice-ui.js`:

- **Pacing on long chats.** The owner reported lag in chats of thousands of messages. AionUi draws every loaded message with no virtualization, and this file's render ran on every change of the page,
  with a `querySelector` per reply row and a forced layout (`getClientRects`) for each composer. In the harness (`tools\dx-harness\quick-lag.js`, 3,000 rows, a reply streaming in) the original added about
  70% to the browser's own time and 8 seconds of page queries; with these changes it costs about what no voice UI costs. On a page with over 400 messages the composer, reply and panel scans run at most every
  400 ms and a repaint after a slow render waits (at most 0.75 s); a small page is painted on the next frame as before.
- **Reply scan.** Rows already looked at carry `data-aiondx-voice` (1 has its button, 0 is not an agent reply, 2 was left for hover), so only new rows are walked; every 10 seconds all rows are looked at again in
  case React dropped a button. On a big page only the newest 40 replies get their speaker button; an older reply gets its button when the pointer reaches it (a speaker button on every one of thousands of
  replies doubled the page's layout cost). A small page has a speaker button on every reply, as designed.
- **What leaves the PC.** The settings panel now says that what is said, and each reply played back, goes to the chosen provider under the user's own account and key, that nothing is sent until a key is entered
  and a button pressed, and that the key is kept in AionDX's settings on this PC as typed. (The key sits in the same settings store the agents' own API can read; storing it with the operating system's
  protection instead is a possible next step.)

## October 20th, 2026: the speaker button works with no key

K: "clicking the agent message narration button does nothing for me". With no ElevenLabs key the provider refused before anything was spoken and the button showed only an error state with a label nobody
reads. The speaker button now falls back to the voice Windows already has (the browser's `speechSynthesis`: free, offline, nothing leaves the PC) when there is no provider, no key or no voice module; the
reply is read in pieces of a sentence or two (the engine can stop partway through one long utterance); Stop works. The option `voice.system` (patch 0001's list, default on) turns the fall-back off. The
panel's privacy text says so. An ElevenLabs key still wins when there is one. Speech to text has no free fall-back (the browser's recogniser needs Google's service), so the microphone still needs a key.

## November 6th, 2026: merged onto current `origin/main` (render pacing + the system voice)

`voice-core-elevenlabs` merged forward past the two sections above (62c4088, 49d2cc4, 87e39da) plus
20 unrelated upstream commits, onto `origin/main`'s tip. Two real conflicts, both in content both
sides had touched:

- **`render()`.** The owner's `due()`-gated calls (`ensureMicButtons`/`ensurePlayButtons` every
  400 ms, `ensureVoicePanel` every 1000 ms on a big page) merged alongside this side's
  `ensureStopAllButtons()`/`ensureHandsFree()`/`ensureHandsFreeBadges()`, which `due()` did not know
  about yet. Resolved by giving stop-all the same 400 ms gate as the mic button next to it (one
  `due('mic', 400)` call, reused - `due()` stamps its own "last ran" the instant it returns true, so
  calling it twice with the same name in one pass would make the second call see the first's stamp
  and wrongly skip) and hands-free its own `due('handsfree', 400)` gate, kept separate so its cadence
  can be tuned on its own later. All of this only matters on a big page; `due()` returns true
  unconditionally otherwise, so no small-page behaviour changed.
- **This file.** Both sides had appended to "Not yet done" / kept writing new sections past it;
  resolved by keeping both bullets and both of the owner's sections (October 14th and 20th, above)
  after this side's own build .2/.3/.4 and the October 17th transcribe-error section, in the order
  each was actually written.

Also renamed a stale `aionui-dx.js` comment reference (one spot, `aiondx-voice-ui.js`'s
`findHfTarget` doc comment) to `aiondx-ui.js`, matching patch 0001's upstream rename. The `$root`
build-tooling fix (2a002e6) needed no changes - `origin/main`'s `tools\build-release.ps1` still had
only the hardcoded junction path this fix already replaces, and it merged in untouched.

Full suite re-run after the merge, all green: `test-voice.js` 46/46, `test-wake.js` 27/27,
`dev-smoke-test.js` 34/34, `dev-smoke-test-real.js` 18/18, `dev-smoke-test-handsfree-team.js` 12/12,
and `dev-smoke-test-handsfree.js` - extended from 28 to 35 checks for the two interactions the merge
raised and neither side's existing suite covered:

- **Does hands-free's auto-play fall back to the system voice with no key?** Yes, by construction -
  `waitForReplyThenPlay()` calls the same `startPlayback()` the manual speaker button does, so it
  gets the same fallback for free. Worth noting for what it is, though: speech to text has no free
  fall-back in this module (the October 20th section above says so), so hands-free's own wake-phrase
  and utterance capture need a working provider regardless - clearing the key before enabling
  hands-free just breaks the microphone, confirmed the hard way (the first version of this test did
  exactly that and the wake phrase was never heard; `onTranscribeError` correctly reported "no
  provider configured" on every failed clip, exactly as 1bb6fe4 was built to do, which is what
  pointed at the real ordering problem). The realistic shape of "falls back to system voice" is a key
  revoked mid-conversation, between a turn being sent and its reply coming back - the test now clears
  the key in that window, after the utterance already sent with a working key.
- **Does stop-all still stop a system-voice utterance, not just an Audio element?** Yes -
  `systemSpeak()`'s `currentPlayback.audio` is a shim object whose `.pause()` calls
  `speechSynthesis.cancel()`; `stopPlayback()` (which the stop-all button calls) only ever calls
  `.pause()` on whatever `currentPlayback.audio` is, real `Audio` element or this shim, so no change
  was needed on either side for this to already work - confirmed against a fake `speechSynthesis`
  injected into the handsfree harness (real browser speech synthesis has no voices and nothing
  reliable to wait on inside a headless, user-data-dir-less profile).

Not re-tested: the `due()` gate on a page actually past the 400-message `bigPage()` threshold -
none of the five harnesses build a page that large, and hands-free's own timers (VAD polling, the
listen/speak state machine) run on their own `setInterval`/`setTimeout`, not inside `render()`, so
the only big-page risk is `ensureHandsFree()`'s DOM re-attach noticing a swapped composer up to
400 ms later than before. Judged low enough risk not to need a dedicated large-page harness for this
merge; flagged here rather than silently skipped.
