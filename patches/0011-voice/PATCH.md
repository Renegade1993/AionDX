# 0011-voice: provider-agnostic voice (TTS/STT), ElevenLabs first

**Target:** renderer only (two plain global scripts, like patch 0001's `aionui-dx.js`), plus one key
in AionUi's per-user settings store. **Status:** both halves done, wired into the build, and QA-verified
against a real AionUi 2.2.2 base (2026-10-11):
- `node patches\0011-voice\test-voice.js` - 46/46.
- `node patches\0011-voice\dev-smoke-test.js` - 16/16 (UI against a stub, real mouse + fake mic, headless Edge).
- `node patches\0011-voice\dev-smoke-test-real.js` - 14/14 (UI against the real module, only `fetch` stubbed).
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
| `aiondx-voice.js` | the interface, `createElevenLabsProvider`, the provider registry (`createProvider`, `listProviders`), `createSettingsStore`, and `createVoiceClient` (the flat convenience wrapper) |
| `test-voice.js` | 46 checks against a stand-in HTTP server standing in for both ElevenLabs and the settings store - no real network, no real AionUi, no real key |
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
- Still unresolved: the commit-identity finding above.
