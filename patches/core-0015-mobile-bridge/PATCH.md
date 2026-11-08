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

**Its own database.** Bridge state lives in `mobile-bridge.db` in the data dir, with its own migrations, never in
`aionui-backend.db`. AionCore refuses to open a database that has a migration it doesn't know
(`database.newer_than_app`). So a shared migration would lock every core without the bridge out of the user's chats.

## Phase 0, 2026-11-07: scaffold

| File | What |
|---|---|
| `settings.rs` | `MobileSettings`: enabled (off), port 47734, hostName, extraUrls (validated http(s) base URLs, at most 8), mdns (on), tasksWrite (on). Partial updates are applied all-or-nothing. |
| `store.rs`, `migrations/0001_init.sql` | `mobile-bridge.db`: settings per Core user, paired devices, revocation tombstones. |
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
