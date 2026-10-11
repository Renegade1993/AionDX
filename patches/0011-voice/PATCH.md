# 0011-voice: provider-agnostic voice (TTS/STT), ElevenLabs first

**Target:** renderer only (a plain global script, like patch 0001's `aionui-dx.js`), plus one key in
AionUi's per-user settings store. **Status:** core module and tests written and passing
(`node patches\0011-voice\test-voice.js`, 37/37); not yet wired into `index.html` or
`tools\build-release.ps1`, and not yet installed. The composer's mic button and playback controls
are the other half of this folder, built in parallel against this same interface.

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
| `aiondx-voice.js` | the interface, `createElevenLabsProvider`, the provider registry (`createProvider`, `listProviders`), `createSettingsStore` |
| `test-voice.js` | 37 checks against a stand-in HTTP server standing in for both ElevenLabs and the settings store - no real network, no real AionUi, no real key |

## Installing, checking, removing

Not yet wired into the build. What is still needed, for whoever wires the UI half in:

1. A script tag in `index.html`, built the same way patch 0001's is
   (`tools\build-release.ps1` line ~98: `<script src="./aionui-dx.js" defer></script>`) - one more
   line for `<script src="./aiondx-voice.js" defer></script>`, and a `Copy-Item` of this file to
   `out\renderer\aiondx-voice.js`, alongside the existing `Copy-Item` for `aionui-dx.js`.
2. `tools\privacy-check.js`'s `--files` list (around line 300) should gain
   `$ext\out\renderer\aiondx-voice.js` next to `aionui-dx.js` and `aiondx-themes.js`.
3. Whatever calls `AionDxVoice.createSettingsStore` and `AionDxVoice.createProvider` from the
   composer needs to pass `baseUrl`/`csrfToken` (or a `request` function) built the same way patch
   0001's `apiUrl()` and `csrf()` are, so requests reach the backend in the desktop app and not a
   same-origin path that resolves against the renderer's own address (patch 0001's "Bug that
   shipped" section has the full story of why that distinction matters).

Until then: `node patches\0011-voice\test-voice.js` runs the module's own tests without installing
anything.

## Not yet done

- The composer's mic button (record, call `transcribe`, drop the text in) and a play button for an
  agent's reply (call `synthesize`, play the `Blob`) - the UI half of this folder, built in parallel
  against the `VoiceProvider` interface above.
- A Settings panel row to pick the provider, paste the API key and pick a voice (`listVoices`) -
  calls `createSettingsStore` the same way.
- The build wiring above (the script tag, the privacy-check file list).
- A second provider, if ever wanted: one more `PROVIDERS` entry in `aiondx-voice.js`; everything
  else in this file and in the UI stays the same.
