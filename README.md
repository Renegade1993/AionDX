# AionDX Mobile

Cross-platform (iOS/Android) companion app for AionDX. Expo SDK 58, React Native 0.88, TypeScript.

## Stack

- **Navigation:** Expo Router (`src/app/`)
- **Server state:** TanStack Query, polling-driven (AionDX has no push)
- **Client state:** Zustand (`src/state/`)
- **Crypto:** `@noble/curves` / `@noble/ciphers` / `@noble/hashes` (pure JS, audited)
- **Secrets:** `expo-secure-store` (Keychain / Android Keystore)
- **App lock:** `expo-local-authentication`
- **QR pairing:** `expo-camera`

## Layout

```
src/app/(onboarding)/   welcome → name → scan → verify → app-lock → done (QR is the only pairing path in v1)
src/app/lock.tsx        app lock, shown on cold start and after the auto-lock timeout
src/app/(app)/(tabs)/   (home) Agents dashboard + agent detail · chat · tasks · settings
src/app/(app)/          modals: approvals, approval/[promptId] sheet, spawn, task-edit, team-picker
src/components/         UI built on src/theme (tokens copied from docs/design/tokens.ts)
src/lib/api/            AionDxApi interface (client.ts), remoteApi.ts, mockApi.ts, hooks.ts
src/lib/crypto/         secure-channel protocol (client + host reference) and tests
src/lib/storage/        keystore persistence + encrypted per-PC cache
src/state/              zustand stores: connection, prefs, lock, health, toasts
docs/                   design spec, pairing & encryption proposal
```

## Data layer

Screens only talk to the `AionDxApi` interface through the hooks in `src/lib/api/hooks.ts`.

- **Real bridge:** `remoteApi.ts` maps each call to an AionDX endpoint (paths are ASSUMED until the bridge schema is published), tunneled over the encrypted channel. Swapping in the real API means editing that file only.
- **Demo data:** dev builds (or `EXPO_PUBLIC_ENABLE_DEMO=1`) show *Explore with demo data* on the welcome screen. It adds a `DEMO-PC` host backed by `mockApi.ts`, an in-memory team that reacts to approvals, messages, task edits and spawns.

Last-known run-state, chats and tasks are cached per PC, encrypted with a per-host key held in the keystore (`src/lib/storage/encryptedCache.ts`). Unpairing deletes the key.

## Commands

```sh
npm start            # dev server (Face ID needs a development build, not Expo Go)
npm test             # jest: protocol + app logic
npm run typecheck
npm run lint
```

See `docs/pairing-encryption-proposal.md` for the security design and open questions for the bridge team.
