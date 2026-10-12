# 0011-voice: provider-agnostic voice (TTS/STT), ElevenLabs first

**Target:** renderer only (two plain global scripts, like patch 0001's `aionui-dx.js`), plus one key
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
- Not yet done: the UI wiring (a wake-phrase toggle, a "listening..." indicator, folding this into
  the existing "stop all" button) - for the Voice UI Engineer, queued up behind the other two voice
  tasks. `createMicSource`'s real-mic path is untested against an actual microphone or a real
  `AudioContext`/`MediaRecorder` - only its constructor-injection path is exercised, by
  `test-wake.js`'s fakes.

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

Wired into the build the same way `aionui-dx.js` is: two more script tags in `index.html`
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
