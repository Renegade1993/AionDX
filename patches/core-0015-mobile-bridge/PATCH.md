# core-0015: the mobile bridge (encrypted PC ↔ phone API)

Patch: `0001-mobile-bridge.patch` in this folder. Applies after core-0014, and needs its `AuthChannel`.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Contract: `docs/mobile-bridge/CONTRACT.md` (rev 4.2). Plan:
`docs/mobile-bridge/IMPLEMENTATION-PLAN.md`. Approved by Nathan on 2026-11-07. Built in phases. This file records what
each phase added; the patch file is always the whole bridge so far.

## What it adds

A new crate, `aionui-mobile`, wired into `aionui-app`:
- `AppServices.mobile_bridge` is built at startup. If it fails, AionCore still starts, just without the bridge.
- The desktop admin routes sit behind the normal auth middleware and CSRF.
- The LAN listener starts at boot if the user left it on, and stops with a bounded wait at shutdown.

**Off by default.** Nothing listens on the network until the user switches it on under Settings > Mobile.

**Its own database.** Bridge state lives in `aiondx-bridge.db` in the data dir, with its own migrations, never in
`aionui-backend.db`. AionCore refuses to open a database that has a migration it doesn't know
(`database.newer_than_app`). So a shared migration would lock every core without the bridge out of the user's chats.

## Phase 0, 2026-11-07: scaffold

| File | What |
|---|---|
| `settings.rs` | `MobileSettings`: enabled (off), port 47734, hostName, extraUrls (validated http(s) base URLs, at most 8), mdns (on), tasksWrite (on). Partial updates are applied all-or-nothing. |
| `store.rs`, `migrations/0001_init.sql` | `aiondx-bridge.db`: settings per Core user, paired devices, revocation tombstones. |
| `host_key.rs` | The PC's identity `host.key` (S_h, hostId, dataKey) in `<data dir>\aiondx-mobile\`, sealed with DPAPI for the current Windows user. Created on first use. A corrupt file is an error, never a silently new identity. |
| `peer_filter.rs` | Only loopback, RFC 1918, link-local, CGNAT `100.64/10`, IPv6 ULA and link-local peers may reach the listener. |
| `listener.rs` | The LAN listener on `0.0.0.0:<port>`. It serves only `/api/mobile/v1/*` (this phase: `hello`); every other path is a plaintext 404. Non-private peers get a 403 before routing. |
| `service.rs` | `MobileBridge`: status, settings updates, and starting/stopping the listener to match. A taken port is reported in the status, not as a crash. |
| `admin_routes.rs` | `GET /api/mobile/admin/status` and `PUT /api/mobile/admin/settings` on AionCore's 127.0.0.1 server. They **refuse the runtime-token channel** (core-0014's `AuthChannel`), so an agent can't switch the bridge on. |
| `crypto.rs`, `tests/vectors.*` | Phase 1's pure crypto: X25519, HKDF, XChaCha20-Poly1305, SAS, the handshake, RPC AAD, revocation, confirm and re-key proofs, RFC 8785 JCS. |

**Tests:** `cargo test -p aionui-mobile`, 33 pass.
- **28 unit tests:**
  - settings defaults and validation;
  - store round trips, and that only `mobile_*` tables exist in its own file;
  - host key create/reload, corrupt-file refusal, no secrets in `Debug`, and a **real DPAPI round trip** that
    checks no plaintext is on disk;
  - peer filter edge ranges;
  - listener `hello`, port release on stop, 404 for any other path, 403 for a public peer, a taken port reported;
  - service enable/disable, restore at boot, port conflict in status;
  - admin routes: a session reads; runtime-token and unmarked callers get 403; invalid settings are a 400 with the
    reason.
- **5 vector tests:** `tests/vectors.json`, copied from the shared `docs/mobile-bridge/vectors/`. Every block
  (pairing, handshake, rpc, revocation, confirm, rekey) matches **byte for byte** what the phone's TypeScript is
  tested against.
- `cargo check -p aionui-app --tests` is clean.

**Known limits, scheduled for phase 5:**
- The QR's LAN URL is only the PC's primary address (a route probe); full interface enumeration comes in phase 5.
- IPv4 only; the listener does not bind IPv6.
- Behind the WebUI "allow remote" proxy, every request reaches AionCore from 127.0.0.1. The admin routes therefore
  can't add a loopback-only check, so they rely on `AuthChannel` and the session.

## Phase 1, 2026-11-07: outer protocol, pairing, sessions, admin pairing and devices

| File | What |
|---|---|
| `wire.rs` | Outer and inner wire types (§4). |
| `pairing.rs` | Pairing offers, in memory: one active at a time, 5 min. It covers all of §4.2 and A2: decrypt with `k_pair`, ±2 min `ts`, **lock on first request** (a second device's valid request aborts the offer and gets `pairing_locked`), the SAS, desktop approve/reject, a confirm key unless `confirmMode` is `none`, and the `aiondx://pair` URI. |
| `session.rs` | The KK-style handshake (§4.3); **authenticated revocation notices** for revoked and never-seen devices (A1); the `epk` replay cache (A3); 12 h / 30 min sessions, at most 4 per device; RPC open/seal with the 256-wide replay window checked **after** decryption; the exact-duplicate response cache; `rid` dedupe per device for 10 min (A4). |
| `core.rs` | Shared state, the per-IP rate limiter (A8: pair 10, session 30, rpc 600 per minute; the IP comes from the socket), the `BridgeEvents` port (desktop WebSocket notices) and the `InnerApi` port (the `/v1` facade, phase 2). |
| `outer.rs` | `POST /api/mobile/v1/{pair,session,rpc}`. Pair long-polls up to 20 s on `wait: true`. RPC dispatches to `/v1/host` and `DELETE /v1/host/device` (built in), then the facade, otherwise `404 no_such_route`. |
| `service.rs`, `admin_routes.rs` | Desktop: `POST/GET /api/mobile/admin/pairing-offers[/{id}]`, `.../approve` (needs `{"sasConfirmed": true}`), `.../reject`, `GET /api/mobile/admin/devices`, `PATCH/DELETE /api/mobile/admin/devices/{id}`. All refuse the runtime-token channel. Confirm keys are stored sealed with the host's `dataKey`. Revoking deletes the row, leaves a tombstone and ends the device's sessions. |
| `aionui-app` | The bridge's `mobile.pairingRequest` / `mobile.deviceChanged` notices go to the user's WebSocket. |

**Tests:** `cargo test -p aionui-mobile`, 45 pass.
- **35 unit tests.** New in this phase:
  - the replay window (out of order, repeats, stale, pruning);
  - the 4-session cap;
  - `rid` and `epk` memory;
  - device store, revocation and tombstones;
  - confirm keys sealed at rest;
  - the admin routes: every route refuses runtime-token and unmarked callers; an offer can't be approved before a
    request or without `sasConfirmed`; 404 for unknown offers and devices.
- **5 end-to-end tests** (`tests/protocol_e2e.rs`): a phone written from the contract alone runs against the real
  outer router.
  - Pair: the SAS matches the desktop's, the long-poll is held then approved, `reqTs` is echoed, the confirm key is
    delivered.
  - Handshake: the PC authenticates; a replay is refused.
  - `/v1/host`.
  - An exact duplicate gets the cached response byte for byte; a re-sealed replay gets `replayed`; a tampered
    envelope gets `auth_failed`.
  - `no_such_route` for any non-facade path.
  - Revoke: the session dies, and the next handshake gets a notice the phone verifies (`reason: revoked`); a stranger
    gets `reason: unknown`.
  - A second phone on the same QR gets `pairing_locked` and the first sees `aborted`; reject; plaintext errors.
- **5 vector tests**, unchanged.

Contract rev 4.3 adds the complete outer error table (§4.4a).

## Phase 1 addendum, 2026-11-07: file name and recovery (lead's requirements)

- **Name:** the bridge database is `aiondx-bridge.db`, next to AionCore's own database (never `aionui-backend.db`).
- **A database that won't open** is moved aside as `.corrupt-<ms>` and a fresh one created. The bridge starts
  disabled, with no phones, and AionCore always boots.
- **The host key:**
  - present but not decryptable or decodable → moved aside, a new identity is created, and the old identity's
    phones are forgotten;
  - an **I/O error** reading it (antivirus or backup lock, permission) → no rotation, the file is kept, and the
    bridge is "faulted" for that boot: status says why, there's no listener, and pairing is refused.
- **`lastRecovery`:** every recovery is recorded in the admin status as `{kind, at, movedTo}`.
  `POST /api/mobile/admin/recovery/dismiss` clears it. Stored in the bridge DB's new `mobile_meta` table
  (`migrations/0002_meta.sql`).
- **Tests:** 50 pass. New ones: garbage DB; garbage key (new identity, phones forgotten, recovery recorded); missing
  DB; recovery shown until dismissed; **an unreadable key** (a directory in its place) gives no listener, no
  pairing, an error in status, no rotation, and the file untouched.
