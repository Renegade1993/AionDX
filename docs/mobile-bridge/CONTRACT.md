# AionDX Mobile Bridge: API Contract v1 (DRAFT)

**Status:** revision 4.4, approved for implementation. Written 2026-11-06/07 by the AionDX Bridge/API Engineer.
- **Rev 1:** first draft.
- **Rev 2:** folds in the mobile team's review: the pairing rate-limit bug and questions 2-16. The answers are in
  §4.2-4.3 and A1/A8, §5.1-5.3, §6.1-6.8, and Appendix A (shared test vectors).
- **Rev 3:** answers the mobile team's rev-2 readiness questions (a)1-9:
  - **(a)1** deny with a message: §6.5 answer body and per-backend delivery.
  - **(a)2** exact HMAC byte layouts: §5.4.
  - **(a)3, (a)4** task-owner notices and unassigning: §6.7.
  - **(a)5** free-text question answers: §6.5.
  - **(a)6** starting a team session; sends auto-start it: §6.3, and `503 team_session_failed` in §6.0.
  - **(a)7** freshness window for the revocation notice: A1.
  - **(a)8** what message `pending` and `error` mean: §6.4.
  - **(a)9** vectors: sent alongside this rev.
  - **Also found while verifying:** AionCore's task board can't edit a task's subject or clear its owner. core-0015
    adds both (§6.7).
- **Rev 4 (2026-11-07):** Nathan approved all nine §11 items as recommended. §11 is now a record of those decisions.
  The `[PENDING SIGN-OFF]` markers are removed, and `tasks.write` is on by default (§6.1, §6.7). The Claude
  "Allow Always" relabel wording is fixed in §6.5. §8 adds Private Party Net (WireGuard) as a to-verify item.
- **Rev 4.4 (2026-11-08):**
  - §6.5 approvals of kind `permission` may carry an optional, display-only `questions` (non-Claude agents that ask
    questions through the permission channel). They're answered with `optionId` only, `freeText: false`.
  - §3.1: "single use" means bound to one phone (re-fetchable until expiry); the `host.key` path is corrected.
  - §6.1: `appVersion` is the AionDX app's version.
  - §7: the QR `u=` list may hold IPv6 ULA addresses, never link-local IPv6.
- **Rev 4.3 (from implementing phase 1):** §4.4a lists every outer error code in one table. Four were missing
  from §4.2–4.4: `pair` → `401 auth_failed` and `409 unknown_host`, `rpc` → `401 auth_failed` and `400 replayed`, and
  `403 forbidden_peer` on any route.
- **Rev 4.2 (implementation note, no wire change):** bridge state lives in its own `aiondx-bridge.db` in the data
  dir, not in a migration of AionCore's `aionui-backend.db`. AionCore refuses to open a database that has a
  migration it doesn't know, so a shared migration would lock every core without the bridge out of the user's
  chats (§0 #4, §3.1).
- **Rev 4.1:** three gaps closed:
  - the first `before` cursor for backward paging (§6.4);
  - `GET /v1/changes` with no `since` (§6.2);
  - the role and sender of a task-assigned notice when the user assigns the task (§6.4, §6.7).
- **Rev 4 note:** the bridge patch is renamed **core-0015-mobile-bridge**, since `core-0006` through `core-0013` are
  already taken by other AionDX core patches. The K1 fix is **core-0014-auth-channel** and comes first, because it
  introduces the `AuthChannel` marker that the admin routes (§3.4) rely on.
- **Rev 3.1:** `send_failed` rows gain `error.messageId`, the user message whose send failed (nullable; it is exact for
  solo sends and mid-turn failures, and `null` in team member chats). Retry re-sends that message instead of "the most
  recent" one. A user message can itself have status `error` after a failed mid-turn delivery (§6.4).
**Answers:** the mobile team's `docs/pairing-encryption-proposal.md` §8 (seven decisions) and the surface their
`remoteApi.ts` assumed.
**Backend:** AionDX on AionUi 2.2.2 (AionPro edition) + AionCore v0.2.2, with core patches 0001-0005.

All design decisions in this document were approved by Nathan on 2026-11-07; §11 records them. Everything on the
wire is versioned (`v: 1`).

---

## 0. The seven decisions at a glance

| # | Question | Answer |
|---|---|---|
| 1 | Crypto scheme | **Accept** the proposal (X25519, HKDF-SHA256, XChaCha20-Poly1305, QR + 6-digit SAS, KK-style handshake, single `rpc` tunnel), with nine amendments (§4.6). The most important ones: an authenticated revocation notice, per-PC phone keys, idempotent retries, and a QR offer that locks on first use. |
| 2 | Paths, port, discovery | `/api/mobile/v1/{hello,pair,session,rpc}` on a **separate LAN listener** (default port 47734, configurable; the QR carries the real URL). The main AionCore API stays on 127.0.0.1. mDNS `_aiondx._tcp` is used only to re-find a PC that is already paired. |
| 3 | Remote access | **LAN-only for v1.** Remote use works through the user's own Tailscale/WireGuard: extra URLs go into the QR. No hosted relay. Approved (§11 #2). |
| 4 | Host key, revocation, multi-PC | Host static key in a DPAPI-protected file. Paired devices are stored in the bridge's own SQLite file (`aiondx-bridge.db`), never in AionCore's database. **One phone keypair per PC.** Revoking on the PC deletes the device row and its sessions. "Forget PC" on the phone deletes that PC's keypair. |
| 5 | Session TTL | **12 h absolute, 30 min idle.** A handshake is one round trip, so short sessions cost little. |
| 6 | API schema | A **mobile facade** (`/v1/...` inner paths, §6). It is an allowlist by construction, not a passthrough of AionCore's routes. Approved (§11 #1). |
| 7 | Biometric / per-action confirmation | Enforced by the bridge, not just a client-side flag. A biometric-gated `confirmKey` HMACs each sensitive request. Required for approvals (allow), spawn, shutdown, force-remove and clear-context. Not required for chat send. Approved (§11 #3). |

---

## 1. Backend facts that shaped this design

All were verified against source: AionCore v0.2.2, the AionDX core patches, and the shipped `app.asar`. Some correct
earlier assumptions.

| Fact | Consequence |
|---|---|
| AionDX launches aioncore with `--identity-mode aionpro`, not `--local` (`out/main/index.js`, `CORE_IDENTITY_MODE = "aionpro"`). JWT auth and CSRF are on. The API binds to `127.0.0.1`. | The bridge is a new authenticated caller. It must not widen the main API's exposure. |
| AionCore **has a WebSocket** (`GET /ws`, `{name, data}` frames, per-user broadcast, no replay or sequence numbers). The app is not polling-only. | The bridge subscribes to the in-process event bus. It derives change feeds, approvals and unread state from it, so the phone does not have to. |
| `CurrentUser` has no caller kind. A browser session, the WebUI and an agent's `AIONUI_RUNTIME_TOKEN` all look identical to handlers. | The bridge adds a distinct `MobileDevice` principal (§3.3). Phone-as-user is a first-class caller, not a borrowed agent identity. |
| "Lead-only" (spawn, shutdown, interrupt, rename, clear-context) is enforced **only on the agent MCP-tool path**. The HTTP routes check only that the user owns the team. | The phone exercising user authority over HTTP-backed actions matches the existing model. See known issue K1 in §9. |
| There is no HTTP wake route: sending a message wakes an agent, and `POST .../attach` retries a dormant runtime. There is no HTTP shutdown: the MCP `team_shutdown_agent` sends a polite request the agent may refuse, and `DELETE /api/teams/{id}/agents/{slot}` is a hard remove. | The facade defines wake, a polite shutdown and a force-remove explicitly (§6.6). |
| Team task writes are MCP-only; the HTTP task routes are read-only. The `TaskBoard` service does have `create_task` and `update_task`. | Task writes from the phone are new, bridge-implemented capability. Approved and on by default (§11 #4). |
| Message ids are 8 random hex characters, not sortable. Rows are upserted in place while streaming (`work` → `finish`). `created_at` is a segment's *start* time. There is no `updated_at` or sequence column. | AionCore's `after` cursor would miss edits, so it can't be used for sync. The bridge provides its own sync cursor (§6.4). |
| Permission prompts can only be listed per conversation. There is no `confirmation.add` event; prompts arrive as `message.stream` frames of type `acp_permission`, `ask` or `permission`. The answer format differs by backend, and **aionrs reads a bare string as `cancel`, which means DENY**. | The bridge keeps a cross-conversation approvals tracker and normalizes answers (§6.5). |
| A Claude agent's "Allow Always" sends Claude the same response as allow-once (no permission rule is passed on). Any answer string the Claude session backend doesn't recognize is treated as an AskUserQuestion answer, which **approves**. The recovery listing of pending prompts deliberately omits a Claude tool call's input; the live stream frame carries it. | The bridge captures approval input live, says what "always" really does per backend (`alwaysScope`), and only forwards option ids taken from the approval itself (§6.5). |
| AionCore has no user broadcast (slot `*` fails), and a team member's chat also contains teammate messages and team-system notices, shown as `position: left`, the same side as the agent. | The bridge does broadcasts itself, records their history, and separates the `agent`, `teammate` and `system` roles (§6.4). |
| There is no unread tracking anywhere. A conversation's runtime `state` includes `waiting_confirmation`. Nothing can tell that an agent asked a question in plain text. | The bridge adds read markers and an explicit `attention` signal (§6.3). It says plainly what it cannot detect. |

---

## 2. Architecture

```
 phone ──HTTP (E2E-sealed envelopes)──▶ LAN listener :47734  ┐
                                       /api/mobile/v1/*      │  aioncore.exe (core patch core-0015-mobile-bridge,
                                                             │  new crate aionui-mobile)
 desktop renderer ──existing auth──▶ 127.0.0.1:<core port>   │   ├─ crypto: x25519-dalek, chacha20poly1305 (XChaCha),
                                     /api/mobile/admin/*     │   │          hkdf, sha2, hmac (RustCrypto)
                                     (pairing UI, devices)   ┘   ├─ facade handlers → domain services (team, conversation,
                                                                 │   task board, assistant) called in-process with user_id
                                                                 └─ event-bus subscriber → change journal, approvals
                                                                    tracker, unread/attention state
```

- **Delivery.** The bridge is a new AionCore patch, `patches/core-0015-mobile-bridge/`, built by the existing
  `tools/build-aioncore.ps1 -Patched` path. It is in-process because the bridge needs the event bus and the domain
  services directly, and because the main API must stay loopback-only.
- **The LAN listener serves only four routes:** `hello`, `pair`, `session` and `rpc`. Every other path gets a
  plaintext 404. The main API is never bound to the LAN by this feature.
- **Off by default.** The user enables it under Settings > Mobile, which starts the listener.
- **Who can connect.** The listener binds `0.0.0.0` but drops any peer address that is not private:
  - RFC 1918, link-local, CGNAT `100.64/10` (Tailscale) or loopback;
  - IPv6: ULA or link-local.
- **Firewall.** The Windows Firewall rule is scoped to the **Private** profile only, so the bridge can't be reached on
  networks Windows classes as Public (café Wi-Fi).

---

## 3. Identity, keys and storage

### 3.1 Keys

| Key | Owner | Storage |
|---|---|---|
| `S_h`, the host static X25519 key, plus `hostId` (16 random bytes, b64u) | PC | `<dataDir>\aionui\aiondx-mobile\host.key` (AionCore's data directory), DPAPI-protected (CurrentUser). The same blob holds `dataKey` (32 B), which encrypts per-device secrets in the DB. Rotating the key means a new `hostId`, and every phone must pair again. |
| `S_c`, the phone static X25519 key, plus `deviceId`, **one per paired PC** | Phone | `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, excluded from backups. Keyed by `hostId`. |
| `confirmKey` (32 B, per device per PC) | Both | Phone: secure store with `requireAuthentication: true` (biometric-gated). PC: a column in `aiondx-bridge.db`, sealed with `dataKey`. |
| `pairingSecret` (32 B) | PC → QR | Memory only. Expires after 5 min. **Single use means bound to one phone:** the first valid request locks the offer to that phone (A2). Until the offer expires, that phone (the holder of `k_pair`) can re-fetch the `approved` response with its `confirmKey`. This is deliberate: it recovers a lost response. |
| Session keys `c2s`, `s2c`, `sid` | Both | Memory only. |

**Bridge state on the PC.** Paired devices, revocation tombstones and settings live in `aiondx-bridge.db`, next to
AionCore's database in the data dir. Confirm keys in it are sealed with `dataKey`. The PC's static private key is
**never** in that file: it is only in the DPAPI-sealed `aiondx-mobile\host.key`.
- **Deleting `aiondx-bridge.db` unpairs every phone.** Their next handshake gets a verified `device_revoked` notice
  with `reason: unknown` (A1). The bridge also comes back switched off.
- **A missing or corrupt file never blocks AionCore from starting.** A file that won't open is moved aside
  (`.corrupt-<ms>`) and a fresh one created: the bridge is disabled, with no paired phones.
- **A `host.key` that is present but won't decrypt or decode** is replaced with a new identity, and the phones
  paired to the old one are forgotten. Phones see `unknown_host` and must pair again.
- **A `host.key` that can't be *read*** (locked by antivirus or a backup, permission denied) is left alone. The
  bridge stays off for that boot, with the reason in its status.
- **Every recovery is recorded** in the admin status as `lastRecovery: {kind: "database"|"host_key", at,
  movedTo}`, so the settings page can say "phones need re-pairing". `POST /api/mobile/admin/recovery/dismiss`
  clears it.

### 3.2 Multi-PC: independent trust per PC

The phone generates a **fresh `S_c` and `deviceId` for each PC it pairs with**, and each PC pins only its own device
key. Why:
- Revoking on one PC never affects another.
- "Forget this PC" on the phone deletes that keypair, which is cryptographically final even if that PC never learns
  of it.
- PCs can't correlate the phone across hosts.
- Losing one host DB exposes nothing used anywhere else.

The phone's host switcher is just a list of `{hostId, hostName, hostPublicKey, urls[], deviceIdentity}` records. The
client change is small: `SecureChannel` already takes `identity` and `host` together. Its identity lookup just needs
to be keyed by `hostId`.

### 3.3 Caller principal

The bridge dispatches every inner request as `Principal::MobileDevice { device_id, user_id }`.
- `user_id` is the Core user who approved the pairing on the PC. In AionDX that is the AionPro-mode Core user the
  renderer is signed in as.
- Facade handlers call domain services with that `user_id`. Every mutating action writes an audit line to
  `%LOCALAPPDATA%\AionDX\logs\mobile-bridge.log`: time, deviceId, action, target ids, outcome. It never logs message
  content or keys.

### 3.4 PC-side admin routes

These live on the main 127.0.0.1 API and are used by the desktop renderer only.

Admin routes **require a session-JWT caller from loopback, with CSRF**. They **refuse the runtime-token channel**:
otherwise any agent with `AIONUI_RUNTIME_TOKEN` could approve an attacker's phone. Today `CurrentUser` doesn't record
which channel authenticated the request, so the patch has the auth middleware insert an
`AuthChannel { Session | RuntimeToken }` request extension.

| Method & path | Body → response |
|---|---|
| `GET /api/mobile/admin/status` | → `{enabled, port, urls[], hostId, hostName, mdns, listening, error?}` |
| `PUT /api/mobile/admin/settings` | `{enabled?, port?, hostName?, extraUrls?[], mdns?}` → status |
| `POST /api/mobile/admin/pairing-offers` | → `{offerId, uri, expiresAt}`. The renderer draws `uri` as a QR code. |
| `GET /api/mobile/admin/pairing-offers/{offerId}` | → `{state: "waiting"\|"request_received"\|"approved"\|"rejected"\|"aborted"\|"expired", request?: {deviceName, platform, appVersion, sas}}` |
| `POST /api/mobile/admin/pairing-offers/{offerId}/approve` | `{sasConfirmed: true}` → `{deviceId}` |
| `POST /api/mobile/admin/pairing-offers/{offerId}/reject` | → `{}` |
| `GET /api/mobile/admin/devices` | → `[{deviceId, name, platform, appVersion, pairedAt, lastSeenAt, lastAddress, activeSessions, requireConfirm, confirmMode}]` |
| `PATCH /api/mobile/admin/devices/{deviceId}` | `{name?, requireConfirm?}` |
| `POST /api/mobile/admin/devices/{deviceId}/rekey-offers` | → `{uri, expiresAt}`. The renderer draws `uri` as a QR code for the confirm-key re-issue flow (§5.3). |
| `DELETE /api/mobile/admin/devices/{deviceId}` | Revoke: deletes the row and `confirmKey`, and kills the device's sessions. |
| WebSocket events | `mobile.pairingRequest {offerId, deviceName, sas}`, `mobile.deviceChanged {deviceId, change}` |

The PC UI (Settings > Mobile) is built by an AionDX renderer patch: QR, SAS compare with Approve/Reject, device list
with Revoke, and the enable switch.

---

## 4. Outer protocol (plaintext HTTP, sealed envelopes)

All bodies are JSON. Binary values are base64url without padding. Outer errors are plaintext `{"error": code, ...}`
and never contain secrets.

### 4.1 `GET /api/mobile/v1/hello`

→ `200 {"v":[1], "hostId":"…"}`. This is unauthenticated, and only for "is this the PC I think it is" after an IP
change. The handshake is still what proves identity.

### 4.2 `POST /api/mobile/v1/pair`

Accepted only while an offer is active. The proposal's §4 applies unchanged except for amendments A2, A7 and A8,
and the long-poll below:
- **Request:** `{v, hostId, deviceId, devicePk, nonce, ct}`.
  - `ct = AEAD(k_pair, PairRequest, aad = "aiondx/v1/pair-req|hostId|deviceId")`.
  - `PairRequest = {deviceName, platform, appVersion, ts, confirmMode: "biometric"|"device_passcode"|"none", wait: boolean}`.
    `confirmMode` is explained in §5.2.
  - `k_pair = HKDF(DH(S_c, S_h), salt = pairingSecret, info = "aiondx/v1/pair" ‖ S_h ‖ S_c)`.
- **Long-poll, replacing the proposal's 2-second re-send.**
  - The first request has `wait: false`. The host answers immediately with `pending`, which confirms the request was
    received; the phone already shows the SAS, computed locally.
  - Every later request has `wait: true`. The host holds it until the offer's state changes (approved, rejected,
    aborted or expired) or 20 s pass, then answers with the current status.
  - The phone re-sends immediately after each answer, **re-sealed with a fresh `ts`**.
  - That is about 3 requests a minute, well inside the A8 limit of 10/min. HTTP timeouts must be at least 25 s.
- **Response:** `200 {v, nonce, ct}`.
  - `ct = AEAD(k_pair, PairResponse, aad = "aiondx/v1/pair-res|hostId|deviceId")`.
  - `PairResponse = {status: "pending"|"approved"|"rejected"|"aborted", hostId, hostName, ts, reqTs, confirmKey?}`.
    - `reqTs` echoes the `ts` of the request being answered; the phone checks it matches its latest request.
    - `confirmKey` (b64u, 32 B) is present only when `approved`.
- **SAS:** `HKDF(k_pair, info = "aiondx/v1/sas", 4 bytes) mod 10^6`, shown as `123 456` on both devices.
- **Errors:**
  - `410 {"error":"pairing_expired"}`
  - `409 {"error":"pairing_locked"}`: the offer is bound to another device (A2)
  - `400 {"error":"clock_skew","hostTime":…}`
  - `429 {"error":"rate_limited"}`
  - `400 {"error":"malformed"|"unsupported_version"}`

### 4.3 `POST /api/mobile/v1/session` (handshake)

Unchanged from the proposal's §5. Summary:
- **Request:** `{v, hostId, deviceId, epk = e_c, nonce, ct}`.
  - `ct = AEAD(k_init, {ts}, aad = "aiondx/v1/hs-init|hostId|deviceId|" ‖ e_c)`.
  - `k_init = HKDF(DH(e_c, S_h) ‖ DH(S_c, S_h), salt = SHA256("aiondx/v1/hs-init|deviceId|" ‖ S_c ‖ S_h ‖ e_c), info = "aiondx/v1/hs-init")`.
- **Response:** `200 {v, epk = e_h, nonce, ct}`.
  - `ct = AEAD(s2c, {expiresAt, idleTimeoutMs}, aad = T)`.
  - `T = SHA256("aiondx/v1/session|deviceId|" ‖ S_c ‖ S_h ‖ e_c ‖ e_h)`.
  - `c2s ‖ s2c ‖ sid = HKDF(DH(e_c,S_h) ‖ DH(S_c,S_h) ‖ DH(e_c,e_h) ‖ DH(S_c,e_h), salt = T, info = "aiondx/v1/session-keys", 80)`.
  - `idleTimeoutMs` is new and informational.
- **Errors:**
  - `403 {"error":"device_revoked", "notice": {nonce, ct}}`: an authenticated notice (A1). It is sent for **any**
    `deviceId` the host does not currently trust: one revoked on the PC, or one it never knew (for example after the
    DB was restored from an older backup).
  - `409 {"error":"unknown_host", "hostId": "<current>"}`: plaintext and unauthenticated. The request's `hostId` is
    not this PC's, typically because the PC's host key was reset. The phone shows "this PC was reset; pair again"
    and **does not** delete the pairing automatically.
  - `401 {"error":"auth_failed"}`: covers a decrypt failure or a replayed `epk` (A3).
  - `400 {"error":"clock_skew","hostTime":…}`
  - `429 {"error":"rate_limited"}`

### 4.4 `POST /api/mobile/v1/rpc`

- **Request:** `{v, sid, seq, nonce, ct}`.
  - `ct = AEAD(c2s, InnerRequest, aad = "aiondx/v1/rpc-req" ‖ sid ‖ u64be(seq))`.
- **Response:** `200 {v, sid, seq, nonce, ct}`.
  - `ct = AEAD(s2c, InnerResponse, aad = "aiondx/v1/rpc-res" ‖ sid ‖ u64be(seq))`.
- **Errors:**
  - `401 {"error":"unknown_session"|"session_expired"}`: the phone re-handshakes and retries once, with the **same
    `rid`** (A4).
  - `rpc` never returns `device_revoked`. Revoking a device kills its sessions, so the next handshake delivers the
    authenticated notice.
- **Long-poll:** `rpc` requests may be held open for up to 30 s (`/v1/changes?wait=`). The phone's HTTP timeout must be
  at least 35 s for those requests.

```ts
interface InnerRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;            // facade path, e.g. "/v1/teams/abc/run-state?x=1"
  body?: unknown;
  rid: string;             // NEW: client UUID, the same across retries of one logical request (A4)
  confirm?: string;        // NEW: b64u HMAC proof for sensitive actions (§5)
}
interface InnerResponse { status: number; body?: unknown; }
```

### 4.4a Outer error codes, complete list (rev 4.3)

Each of these is a plaintext `{"error": code, ...}` body. This is the complete set the bridge returns; the phone
treats any other body as a transport error.

| Route | Status | `error` | Meaning; what the phone does |
|---|---|---|---|
| any | 403 | `forbidden_peer` | The request came from a public, non-private address (§2). Unreachable from a LAN or tunnel; show "PC refused the connection". |
| any | 404 | `not_found` | Not one of the four outer paths. |
| any | 429 | `rate_limited` | A8 limit for this peer IP and route. Back off for a minute. |
| any | 400 | `malformed` / `unsupported_version` | The body isn't valid JSON for this route, or `v` isn't 1. |
| `pair`, `session` | 409 | `unknown_host` (+ `hostId`) | The `hostId` isn't this PC's (the host key was reset). Show "this PC was reset; pair again". Don't auto-delete the pairing. |
| `pair`, `session` | 400 | `clock_skew` (+ `hostTime`) | `ts` is outside ±2 min. `hostTime` is unauthenticated, for the message only. |
| `pair` | 410 | `pairing_expired` | No offer is waiting (expired, replaced, or never created). |
| `pair` | 409 | `pairing_locked` | A2: the offer belongs to another phone. |
| `pair` | 401 | `auth_failed` | The sealed request didn't open with this offer's `k_pair`: the phone didn't scan this QR, or the offer was replaced. |
| `session` | 401 | `auth_failed` | The init didn't open, or its `epk` was already used (A3). |
| `session` | 403 | `device_revoked` (+ `notice`) | A1. Delete the pairing only after the notice verifies. |
| `rpc` | 401 | `unknown_session` / `session_expired` | Re-handshake and retry once with the same `rid` (§4.4). |
| `rpc` | 401 | `auth_failed` | The envelope didn't open with this session's key (tampered, or wrong `seq` in the AAD). Re-handshake once; if it repeats, report an error. |
| `rpc` | 400 | `replayed` | This `seq` was already used in this session with a different envelope. Phone-side bug or an attack: don't retry with that `seq`. |

### 4.5 Replay and idempotency

- The replay window (256) is checked *after* successful decryption, as in the reference.
- An exact duplicate envelope (same `sid`, `seq`, `nonce` and `ct`) inside the window gets the **cached sealed
  response**, not an error. This covers multi-URL failover after the PC has already processed the request.
- Mutating inner requests (anything other than GET) are de-duplicated per device by `rid` for 10 minutes. A repeat
  returns the first result.

### 4.6 Amendments to proposal v1

| # | Change | Why |
|---|---|---|
| A1 | **Authenticated revocation notice.** On `/session` for a `deviceId` the host does not trust, it returns `notice = AEAD(k_rev, {deviceId, ts, reason}, aad = "aiondx/v1/revoked|hostId|deviceId|" ‖ e_c)`, where `k_rev = HKDF(DH(S_h, e_c), salt = SHA256("aiondx/v1/revoked|hostId|deviceId|" ‖ e_c), info = "aiondx/v1/revoked")` and `reason` is `"revoked"` or `"unknown"`. The host keeps tombstones of revoked deviceIds to tell the two apart, but **both reasons mean the same thing: this PC (the holder of `S_h`) will not accept this device key, so deleting the pairing is safe.** The reason is only for the message shown to the user. The phone deletes the pairing **only** after verifying the notice (it computes `DH(e_c, S_h)`) and checking that `deviceId` is its own and `ts` is fresh. "Fresh" uses the same ±2 min window as the handshake (`MAX_CLOCK_SKEW_MS`). Replay is already prevented by binding to the phone's fresh `e_c`; the `ts` check only guards against a host whose clock is badly wrong. An unauthenticated 403 shows "PC refused the connection" and keeps the pairing, with a manual "Forget". | Outer status codes are plaintext. As proposed, anyone on the network could inject a 403 and wipe the phone's pairings. The host can compute `k_rev` without the deleted `S_c`, and the fresh `e_c` prevents replay. |
| A2 | **An offer locks on first use.** The first valid pair request binds the offer to that `devicePk`. A valid request from a different `devicePk` burns the offer (`aborted` to the first device, `409 pairing_locked` to the second), and the PC warns "this code was used by another device". Responses echo `reqTs`. | Someone who photographs or relays the QR gets one 10⁻⁶ SAS guess at most, and the user is told. |
| A3 | Handshake replay cache: the host remembers each `epk` for 5 min and rejects repeats. At most 4 live sessions per device; the oldest is evicted. | Without it, a replayed init within ±2 min makes the host build junk sessions (a memory DoS). |
| A4 | `rid` idempotency plus the duplicate-envelope cache (§4.5). | Failover and the 401 retry could otherwise double-send messages or double-approve. |
| A5 | One phone identity per PC (§3.2). | Multi-PC revocation and privacy. |
| A6 | `clock_skew` errors carry `hostTime`. It is unauthenticated and used only for an explanatory message. | Better errors for the user. |
| A7 | `confirmKey` is delivered in the approved `PairResponse` (§5). | Bridge-enforced biometric confirmation. |
| A8 | Rate limits per peer IP (taken from the socket, never from headers): `pair` 10/min, `session` 30/min, `rpc` 600/min. `pair` uses the long-poll in §4.2, so normal pairing makes about 3 requests a minute. (The first draft had the phone re-sending every 2 s, which would have hit this limit. That was a bug, found in review.) | Brute-force and DoS hygiene. |
| A9 | The facade allowlist (§6) replaces arbitrary `{method, path}` passthrough. | A stolen or compromised phone must not reach shell execution, MCP server configuration (= arbitrary commands), file operations or settings. Passthrough would make the phone a remote-code-execution path into the PC. |

Kept as proposed: X25519, HKDF-SHA256, XChaCha20-Poly1305 with random 24-byte nonces, base64url, the ±2 min skew
window, and **deferring manual-code pairing** (an 8-character code as the HKDF salt can be brute-forced offline). If
manual entry is needed later, use CPace via a vetted library rather than a longer code.

---

## 5. Sensitive actions and bridge-enforced confirmation

A client-side "biometric passed" flag can't be enforced, because a modified app just sets it. Instead:

- **At pairing:** the phone stores `confirmKey` with `expo-secure-store` `requireAuthentication: true`. Reading it
  requires Face ID, Touch ID or a fingerprint. No native module is needed beyond Expo. Phones without biometrics are
  covered in §5.2.
- **The proof.** A sensitive inner request carries:
  `confirm = b64u(HMAC-SHA256(confirmKey, "aiondx/v1/confirm" ‖ sid ‖ u64be(seq) ‖ method ‖ 0x00 ‖ path ‖ 0x00 ‖ SHA256(JCS(body ?? null)) ‖ rid))`.
  - The exact byte layout is in §5.4. `path` is exactly the inner request's `path`, including any query string.
  - JCS is RFC 8785 canonical JSON. Sensitive bodies use only strings, booleans, null, safe integers, arrays and
    objects, never floats, so JCS amounts to sorted keys and no whitespace.
  - Test vectors are in Appendix A.
  - The proof binds `sid` and `seq`. If a request is retried under a new session (the 401 re-handshake) or with a new
    `seq`, the phone recomputes the proof; `rid` stays the same.
- **Bridge checks:**
  - If the proof is missing: `428 {error:{code:"confirm_required"}}`.
  - If it is wrong: `403 {error:{code:"confirm_invalid"}}`.
  - A device with `requireConfirm = false`, set on the PC, skips the check. **The default is true.**
- **Key invalidation happens on iOS and on Android.** Changing enrolled biometrics (adding a fingerprint or face)
  makes a `requireAuthentication` item unreadable on both platforms. The phone detects this when reading the key
  throws, shows "re-confirm this phone on your PC", and runs the §5.3 re-issue flow. Until then, sensitive actions are
  unavailable and every other feature keeps working.

### 5.1 Which actions are gated

**Sensitive actions:**
- answering an approval with any *allow* decision (deny is never gated);
- spawn agent;
- polite shutdown;
- force-remove agent;
- clear agent context;
- deleting a task.

**Not gated:** reading anything, sending chat messages, stop turn, wake, rename, creating or editing tasks, read
markers.

Sending a chat message to an agent running in YOLO mode is as powerful as an approval. App-level lock (biometric on
open or resume after 5 min, done client-side) is the control for that. Gating every chat send would make chat
unusable. Nathan approved this tradeoff (§11 #3).

### 5.2 Phones without enrolled biometrics

`expo-secure-store`'s `requireAuthentication` needs enrolled biometrics. A passcode-only gate isn't available without a
native module. The phone reports which mode it can use, as `confirmMode` in the pair request (§4.2), based on
`expo-local-authentication`'s enrolled level:

| `confirmMode` | Phone has | How `confirmKey` is stored and unlocked | Who enforces it |
|---|---|---|---|
| `biometric` | biometrics enrolled | secure store, `requireAuthentication: true` | the phone's secure hardware |
| `device_passcode` | a passcode, no biometrics | secure store, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, no `requireAuthentication`. The app calls `LocalAuthentication.authenticateAsync()` (passcode allowed) before every read. | **the app only** |
| `none` | no passcode at all | the key is not issued | sensitive actions are unavailable |

The bridge verifies the same HMAC proof in every mode; it can't tell the modes apart and doesn't need to. The mode is
recorded per device and shown on the PC: when approving the pairing ("Confirmations on this phone use its passcode,
enforced by the app only") and as a badge in the device list.

**Intended behavior:**
- **Passcode-only phones *can* perform sensitive actions,** with the PC making the weaker mode visible.
- **Why the weaker mode is acceptable:** the main threat is a stolen phone. A thief still has to get past the device
  passcode prompt. Getting around the prompt means modifying the app, and a re-signed app can't read the original
  app's Keychain or Keystore items. A compromised phone OS is out of scope for v1, as in the proposal.
- **Phones with no passcode** get no `confirmKey`. Sensitive actions on them stay unavailable unless the user turns off
  `requireConfirm` for that device on the PC, which is a deliberate opt-out shown as such.
- **v2 upgrade path:** a small native module using iOS `kSecAccessControlUserPresence` and Android
  `setUserAuthenticationParameters(0, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)` would make the passcode check
  hardware-enforced too. The wire format would not change.

### 5.3 Re-issuing the confirm key

This is used after biometric invalidation, or to change `confirmMode`. It needs the existing, authenticated session
**and** being physically at the PC.

1. On the PC: Settings > Mobile > the device > "Re-issue confirm key". This calls
   `POST /api/mobile/admin/devices/{deviceId}/rekey-offers` and shows a QR code:
   `aiondx://rekey?v=1&id=<hostId>&d=<deviceId>&s=<rekeySecret, b64u of 32 random bytes>&x=<expiresAt ms>`.
   - The offer is single-use, lasts 5 min, and allows 5 attempts.
2. The phone scans it. It refuses locally unless it has a pairing whose `hostId` and `deviceId` match. Inside a normal
   session it sends `POST /v1/host/device/confirm-key` with
   `{proof, confirmMode}`, where `proof = b64u(HMAC-SHA256(rekeySecret, "aiondx/v1/rekey" ‖ sid ‖ deviceId))`.
3. The bridge checks the proof against the device's open offer. It then generates a new `confirmKey`, replaces the old
   one, and returns `{confirmKey}` in the sealed response. The phone stores it according to the new `confirmMode`.
   - Errors: `403 {error:{code:"rekey_invalid"}}`, `404 {error:{code:"no_rekey_offer"}}`.

No new outer endpoint is needed. Binding the proof to `sid` means a leaked QR code is useless without the device's live
session.

### 5.4 Exact byte layout of the HMAC inputs (rev 3)

Both MACs are HMAC-SHA256 over a plain concatenation (`‖`). There are no length prefixes, no terminators, and no
separators except the two explicit `0x00` bytes shown. The output is sent as b64u (base64url, no padding) of the
32-byte MAC.

**Confirm proof** (§5), key `confirmKey` (32 raw bytes):

| # | Field | Bytes |
|---|---|---|
| 1 | label | UTF-8 of `aiondx/v1/confirm` (17 bytes) |
| 2 | `sid` | the **raw 16 bytes** of the session id (the bytes the HKDF derived, not the b64u text in the envelope) |
| 3 | `seq` | 8 bytes, unsigned big-endian (`u64be`): the `seq` of the envelope this request is sealed in |
| 4 | `method` | UTF-8 of the uppercase method, e.g. `POST` |
| 5 | separator | one `0x00` byte |
| 6 | `path` | UTF-8 of the inner request's `path` string exactly as sent (the same string, including the query) |
| 7 | separator | one `0x00` byte |
| 8 | body hash | the **raw 32 bytes** of `SHA-256(UTF-8(JCS(body)))`. A missing or `undefined` body hashes the 4 bytes `null`. |
| 9 | `rid` | UTF-8 of the `rid` string exactly as sent. There is **no separator** before it; the hash is a fixed 32 bytes, so the boundary is unambiguous. |

**Re-key proof** (§5.3), key `rekeySecret` (the **raw 32 bytes** decoded from the QR's `s=` b64u):

| # | Field | Bytes |
|---|---|---|
| 1 | label | UTF-8 of `aiondx/v1/rekey` (15 bytes) |
| 2 | `sid` | the raw 16 bytes, as above |
| 3 | `deviceId` | UTF-8 of the `deviceId` **string** (its b64u text, exactly as sent in the handshake), not the decoded bytes |

Appendix A's `confirm[].macInput` and `rekey.macInput` give these concatenations as hex, so each field can be checked
by offset.

## 6. Inner API v1 (the facade)

### 6.0 Conventions

- **Paths** start with `/v1`. Any other path returns `404 {error:{code:"no_such_route"}}`. Ids are opaque strings.
  Timestamps are integer milliseconds since the epoch.
- **Success** returns the resource as the body; there is no `{success, data}` wrapper.
- **Errors:** `{error: {code, message, details?}}`, with these codes:
  - `400 invalid_request`
  - `403 confirm_invalid`, `rekey_invalid`
  - `404 not_found`, `no_rekey_offer`
  - `409 conflict`, `already_resolved`, `busy`
  - `422 ambiguous_decision`, `lead_not_allowed`
  - `428 confirm_required`
  - `429 rate_limited`
  - `503 team_session_failed` (`details: {error}`), `backend_unavailable`
- **Paging:** `?limit=` (default 50, max 200) and opaque cursors.

### 6.1 Host

`GET /v1/host` →
```json
{ "hostId": "…", "hostName": "Nathan-Desk", "appVersion": "0.26.0", "coreVersion": "0.2.2", "bridgeVersion": 1,
  "serverTime": 1794023000000,
  "device": { "deviceId": "…", "name": "Pixel 9", "pairedAt": 0, "requireConfirm": true, "confirmMode": "biometric" },
  "capabilities": ["changes.longpoll", "tasks.write", "approvals.questions"] }
```
`capabilities` lists optional features that are switched on. The phone hides UI for anything missing. `tasks.write`
is **on by default** (§11 #4); the only way it goes missing is if the user switches task writes off under
Settings > Mobile on the PC.

`POST /v1/host/device/confirm-key` `{proof, confirmMode}` → `{confirmKey}` is the confirm-key re-issue, described in
§5.3.
`DELETE /v1/host/device` unpairs this phone from the PC side, which is the same as revoking it on the PC. No
confirmation is needed.

### 6.2 Change feed (recommended poll target)

`GET /v1/changes?since=<token>&wait=<0..25>` (`wait` in seconds) → `ChangesResponse`:

```ts
interface ChangesResponse {
  token: string;            // pass back as `since` next time. Opaque; currently "<epoch>.<rev>".
  reset: boolean;           // true: `since` is from an older bridge epoch (the PC restarted) or too old for the journal.
                            //   `changes` is then empty; refetch everything you show.
  more: boolean;            // true: more than 500 entries were pending. Call again right away with the new token.
  changes: ChangeEntry[];   // coalesced: at most one entry per (kind, id) since `since`, newest state wins.
}
type ChangeEntry =
  | { kind: 'team'; teamId: string; what: ('roster' | 'run_state' | 'meta')[] }
      // roster: an agent was added, removed or renamed, or its model changed. run_state: slot work, turn, queue,
      //   runtime, shutdown or attention changed. meta: team name or workspace changed.
  | { kind: 'team_removed'; teamId: string }
  | { kind: 'conversation'; conversationId: string; teamId?: string; slotId?: string;
      what: ('messages' | 'state' | 'meta' | 'read')[] }
      // messages: rows were inserted or changed, so call messages?since=<your cursor for it>. state: runtime state or
      //   attention changed. meta: name changed. read: the read marker moved (from another device).
  | { kind: 'conversation_removed'; conversationId: string }
  | { kind: 'approval_added'; approval: Approval }                 // the full object (§6.5); no fetch needed
  | { kind: 'approval_removed'; approvalId: string; conversationId: string; teamId?: string;
      resolution: 'answered' | 'cancelled' }                       // cancelled: the turn ended or the agent stopped first
  | { kind: 'task'; teamId: string; task: Task; change: 'created' | 'updated' }   // the full Task (§6.7)
  | { kind: 'broadcast'; teamId: string; broadcastId: string };
```

- **No `since` (first call, rev 4.1):** returns immediately with the current `token`, `changes: []`, `reset: false`
  and `more: false`. It **never holds**, even if `wait` is given. The phone loads its screens normally, then
  long-polls from that token.
- **How the phone uses it:** apply the inline objects (approvals, tasks) directly. For `team` and `conversation`
  entries, fetch only the resource named.
- **Long-poll:** with `wait > 0` the request is held until there is at least one entry or the wait ends. Long-polling
  this one call while the app is in the foreground replaces the proposal's every-3-s run-state polling. Plain polling
  still works.
- **Where entries come from:** a per-user change journal in the bridge, fed by the in-process event bus
  (`message.*`, `turn.completed`, `confirmation.remove`, `team.*`, `conversation.*`) and by the approvals tracker. It
  covers 24 h or 50,000 entries, whichever is smaller. Older tokens get `reset: true`.

### 6.3 Teams, roster, run state

`GET /v1/teams` → `TeamSummary[]`:
```ts
interface TeamSummary {
  teamId: string; name: string; workspace: string; leadSlotId: string; agentCount: number;
  attention: Attention;      // the highest-priority attention across its agents (order in the table below)
  waitingOnUser: boolean;    // true if any agent is waitingOnUser
  unread: number;            // sum across agents, capped at 99
  updatedAt: number;
}
```

`GET /v1/teams/{teamId}/run-state` → `RunState`. This is the dashboard projection; one call per screen.
`GET /v1/teams/{teamId}/agents/{slotId}` → one `Agent`.

**Starting a team session (rev 3, readiness (a)6).**
- **`POST /v1/teams/{teamId}/session`** → `RunState`, once the start has been accepted. `sessionStatus` is then
  `starting` or `ready`, and progress arrives through the change feed (`team` / `run_state`). It is backed by
  AionCore's `POST /api/teams/{id}/session` (`ensure_session`). Starting a session that is already running is a no-op.
  The action isn't sensitive.
- **Sends start the session automatically.** AionCore's team send path calls `ensure_session_inner` first
  (`service.rs` `send_message_to_agent`), so sending a message to a team whose session is `none`, `stopped` or
  `failed` starts it, exactly as on desktop. The phone doesn't need "start it on your PC". A `stopped` / `failed`
  banner can offer **Start** (this route), and sending also works.
- **`503 team_session_failed`** means the start itself failed (`details.error` carries AionCore's reason, e.g. an agent
  CLI missing). The send or start was not done; the phone shows the error and offers a retry.
- **Stopping a team session** isn't offered to the phone in v1.

```ts
interface RunState {
  teamId: string;
  sessionStatus: 'none' | 'starting' | 'ready' | 'failed' | 'stopped';
      // none: no team session has been started since AionDX launched. The others come from team.sessionStatusChanged.
  activeRun: null | {
    runId: string;
    status: 'accepted' | 'running' | 'cancelling';   // AionCore reports a run as active only in these states
    targetSlotId: string;
    source: 'user_message' | 'system_lifecycle';
  };
  agents: Agent[];          // the lead first, then teammates in roster order
}

interface Agent {
  slotId: string; name: string;
  role: 'lead' | 'teammate';
  conversationId: string; backend: string; model: string; icon: string | null;

  state: 'idle' | 'queued' | 'starting' | 'running' | 'paused' | 'blocked';
      // AionCore slot work state, chosen in this priority order:
      //   paused: work on this slot is paused.  running: a turn is active.  starting: a batch is claimed, the turn
      //   has not begun.  blocked: the runtime isn't ready (see blockedReason).  queued: messages wait, nothing runs.
      //   idle: none of the above.
  blockedReason: null | 'runtime_starting' | 'runtime_failed' | 'removing' | 'session_stopped';
      // Comes from the runtime, so it can be non-null while state is something other than 'blocked' (e.g. 'paused').
  runtime: 'dormant' | 'pending' | 'ready' | 'failed';
      // dormant: no process yet (started lazily by the next message or wake). pending: starting up.
  turn: null | { turnId: string; startedAt: number; elapsedMs: number; slow: boolean; slowThresholdMs: number };
      // slow: elapsedMs >= slowThresholdMs (10 min today)
  queue: { foreground: number; background: number; foregroundMessageIds: string[] };
      // foreground: the user's queued messages, in the order the agent will read them. background: everything else.
  pendingApprovals: number;
  attention: Attention;
  waitingOnUser: boolean;
  unread: number;
  shutdown: null
    | { state: 'requested'; requestedAt: number; reason: string | null }          // reason: what the user gave
    | { state: 'approved'; requestedAt: number; respondedAt: number }             // removal follows within ~1 s
    | { state: 'rejected'; requestedAt: number; respondedAt: number; rejectReason: string };
      // Cleared when the user sends a new shutdown or the agent is removed. A 'rejected' agent can be force-removed.
  currentTask: null | { taskId: string; subject: string };
      // The most recently updated in_progress task owned by this slot. Derived from the task board; agents don't
      //   declare it.
  openTaskCount: number;     // tasks owned by this slot with status pending or in_progress
  lastMessage: LastMessage | null;
  lastActivityAt: number;
}

type Attention = 'needs_answer' | 'needs_approval' | 'error' | 'your_turn' | 'none';

interface LastMessage {      // for list previews; no message fetch needed
  messageId: string;
  role: 'user' | 'agent' | 'teammate' | 'system';
  senderName: string | null; // teammate or agent display name; null for the user
  text: string;              // plain text, first 200 characters; tool rows read "Used <tool>"
  createdAt: number;
}
```

**`attention`, the explicit "waiting on you" signal (ask #5).** Values, highest priority first:

| Value | Meaning | `waitingOnUser` |
|---|---|---|
| `needs_answer` | The agent asked a structured question (an approval of kind `question`). | true |
| `needs_approval` | A permission prompt is pending (an approval of kind `permission`; runtime `waiting_confirmation`). | true |
| `error` | `runtime` is `failed`, or `blockedReason` is `runtime_failed`. | false |
| `your_turn` | **Solo conversations and the team lead only:** the turn completed, the agent is idle, and the newest `role: 'agent'` message is newer than both the user's last message and the read marker. | false |
| `none` | Nothing above applies. | false |

`waitingOnUser` is true only for the two hard signals. **Limit:** an agent that asks a question in ordinary prose
looks the same as an agent that finished. The best available signal for that is `your_turn`. Teammates don't get
`your_turn`, because they report to the lead, not to the user.

**`unread`:** the count of messages with `role: 'agent'`, type `text`, not hidden, status `done`, newer than the read
marker, capped at 99. Teammate messages and system notices in a member's chat are not counted.

### 6.4 Conversations and messages

There is one id space. A team member's chat is that slot's `conversationId` (from the roster). Solo chats use their own
id. The bridge decides how to route a send.

| Method & path | Body / query → response |
|---|---|
| `GET /v1/conversations?kind=solo&cursor=&limit=` | → `{items: Conversation[], nextCursor: string \| null}`, most recently updated first |
| `GET /v1/conversations/{cid}` | → `Conversation` |
| `POST /v1/conversations` | Creates a solo chat. `{assistantId?, backend?, name?, workspace?, model?}` (exactly one of `assistantId`/`backend`) → `Conversation`. `workspace` must come from `GET /v1/workspaces`, or be omitted, which creates a temp folder. The phone cannot choose an arbitrary PC path. |
| `GET /v1/workspaces` | → `[{path, label, lastUsedAt}]`: workspaces of the user's existing conversations and teams |
| `GET /v1/conversations/{cid}/messages?since=&limit=` | Sync, described below → `{items: Message[], cursor, reset, hasMore, before?}` |
| `GET /v1/conversations/{cid}/messages?before=<cursor>&limit=` | Older history (backward paging) → `{items: Message[], before: string \| null}`, ascending. `before: null` means the start of the conversation. |
| `POST /v1/conversations/{cid}/messages` | `{content, priority?: "normal"\|"now"}` → `{messageId, delivery}`, where `delivery` is `"started"\|"midturn"\|"queued"\|"queued_first"` |
| `POST /v1/conversations/{cid}/read` | `{upToMessageId}` → `{}` |
| `POST /v1/teams/{teamId}/broadcast` | `{content}` → `Broadcast` |
| `GET /v1/teams/{teamId}/broadcasts?cursor=&limit=` | → `{items: Broadcast[], nextCursor: string \| null}`, newest first |

```ts
interface Conversation {
  conversationId: string; name: string; kind: 'solo' | 'team_member';
  teamId?: string; slotId?: string; backend: string; model?: string; workspace?: string;
  state: 'idle' | 'starting' | 'running' | 'cancelling' | 'restarting' | 'waiting_confirmation';
  attention: Attention; waitingOnUser: boolean; unread: number;
  lastMessage: LastMessage | null;
  updatedAt: number;
}

interface Message {
  messageId: string; conversationId: string; turnId?: string;
  role: 'user' | 'agent' | 'teammate' | 'system';
  sender: { kind: 'user' }
        | { kind: 'agent'; name: string }
        | { kind: 'teammate'; name: string; slotId: string | null; conversationId: string | null }
        | { kind: 'team_system' }
        | { kind: 'app' };                        // AionCore tips and status rows
  type: 'text' | 'thinking' | 'tool_call' | 'plan' | 'tips' | 'agent_status' | 'other';
  status: 'streaming' | 'done' | 'error' | 'pending';   // AionCore work | finish | error | pending
  text?: string;                                 // for text, thinking and tips
  error?: { source: 'send_failed' | 'agent'; code: string | null; message: string;
            messageId?: string | null };   // status 'error' only. messageId: send_failed only, see §6.4 (rev 3.1)
  tool?: { name: string; title?: string; status?: string; summary?: string };   // compacted
  notice?: { kind: 'task_assigned'; taskId: string }
         | { kind: 'context_reset' };            // recognized system notices, see below
  raw?: unknown;                                 // AionCore content, compacted (big tool payloads cut to 4 KB)
  createdAt: number;
}

interface Broadcast {
  broadcastId: string; teamId: string; content: string; createdAt: number;
  sentFrom: { kind: 'mobile'; deviceId: string; deviceName: string };
  deliveries: { slotId: string; messageId: string | null;
                delivery: 'started' | 'midturn' | 'queued' | 'queued_first' | 'failed'; error?: string }[];
}
```

**How AionCore rows become `role` and `sender`.** This is verified from `aionui-team/src/message_projection.rs`. A team
member's chat holds more than the agent's own output:

| AionCore row | `role` | `sender` |
|---|---|---|
| `position: right` | `user` | `{kind:'user'}` |
| `position: left`, `content.teammate_message: true`, `sender_name: "team_system"` | `system` | `{kind:'team_system'}` |
| `position: left`, `content.teammate_message: true`, any other `sender_name` | `teammate` | `{kind:'teammate', name, slotId, conversationId}`. `slotId` is resolved from `sender_conversation_id`. |
| `position: left`, otherwise | `agent` | `{kind:'agent', name}` |
| `position: center` (tips) or `pop` | `system` | `{kind:'app'}` |

**System notices.**
- A task assignment (`📋 Task assigned to you (#<taskId>): <subject>`) is a mailbox message from whoever assigned the
  task. When an **agent** assigns it (the MCP tool), it appears in the owner's chat as `role: 'teammate'`, with the
  assigner as sender. When the **user** assigns it (the phone, §6.7), the bridge sends the notice through AionCore's
  user-message path. That produces a `position: right` row with plain `{content}`; only `[SYSTEM NOTE: …]` text is
  stripped, the `📋` prefix is kept (`message_projection.rs` `user_visible`, `visibility.rs` `user_message`). So it
  appears as **`role: 'user'`, `sender: {kind:'user'}`**, with the same `notice`. In both cases the bridge recognizes the
  prefix and adds `notice: {kind:'task_assigned', taskId}`. `text` keeps AionCore's exact wording.
- A context reset is a `team_system` row whose content is JSON (`{"kind":"context_reset", ...}`). It becomes
  `role: 'system'`, `notice: {kind:'context_reset'}`, `text: "Context cleared"`.

**Broadcast.** AionCore has no user broadcast: sending to slot `*` fails, because there is no agent with that id. The
bridge sends one message to each agent itself, and records each broadcast in its own table. That is what
`GET /v1/teams/{t}/broadcasts` returns, so the history survives a phone reinstall. Only broadcasts sent through the
bridge are listed.

**Sync semantics.** These answer ask #2 ("since a given message id"), but the sync is cursor-based, because AionCore
message ids are not ordered.
- With no `since`: returns the latest page and `cursor`, **plus `before: string | null`**, where backward paging
  (`?before=`) starts. `null` means the page already reaches the conversation's start. It is backed by AionCore's
  `oldest_cursor` / `has_more_before`. `before` is also present when `reset: true`, and absent on ordinary `since`
  polls (rev 4.1).
- With `since`: returns every message inserted **or changed** since that cursor, as full rows. The phone **upserts by
  `messageId`**; rows that didn't change may repeat, which is harmless.
- `reset: true` means drop local state for this conversation and reload. `hasMore: true` means call again right away
  with the new `cursor`.
- **How the bridge does it:** each cursor carries a floor timestamp, the `createdAt` of the oldest message that was
  still streaming when the cursor was issued, minus 5 s. A poll re-lists from that floor. That catches in-place edits,
  and rows whose `createdAt` is earlier than the time they were written.
- A streaming reply shows up as one message whose `text` grows and whose `status` goes `streaming` → `done`.

**What `pending` and `error` mean (rev 3, readiness (a)8), verified against `aionui-conversation`:**

| `status` | Row | Meaning | Phone shows |
|---|---|---|---|
| `pending` | Only the **user's own** message (`role: 'user'`) that was delivered **into a running turn** (`delivery: "midturn"`, or `priority: "now"` steering). | The agent has the message but hasn't read it yet (Claude reads it at its next step). It becomes `done` when consumed, which arrives as a `conversation` `messages` change. AionDX's "Unread" marker and Unsend are built on this state. | "Delivered, not read yet" (a subtle marker), not a failure. |
| `error` + `error.source: 'send_failed'` | A `role: 'system'`, `type: 'tips'` row (AionCore `message_persistence.rs`, centered). | The user's send failed: the agent CLI failed to start, the provider rejected the request, or a mid-turn delivery failed. `error.code` and `error.message` come from AionCore (`content.code`, `content.content`). `error.messageId` is the user message whose send failed, or `null` when the bridge can't tell (see below). | A failed row with the text and a **Retry** action. **Retry re-sends the failed message (`error.messageId`)**, as a new send with a new `rid`. If `messageId` is `null`, the client falls back to the nearest user message *before* the failed row, and hides Retry if there isn't one. |
| `error` on a **user** message (`role: 'user'`) | The user's own message, after a **mid-turn** delivery into a running turn failed. AionCore sets that row's status from `pending` to `error` (`service.rs` `apply_message_receipt`) and then writes the `send_failed` row. | That exact message didn't reach the agent. | Mark that bubble as failed. Its `send_failed` row's Retry points at it. |
| `error` + `error.source: 'agent'` | A `role: 'agent'`, `type: 'tips'` row (`stream_persistence.rs` `persist_error_tip`). | The agent's turn ended with an error, e.g. a provider error or a crash mid-turn. `error.message` is the error text. | Shown as-is, as an error bubble in the thread. No automatic retry; the user simply sends again. |
| `streaming` | An agent row while it is being written. | In progress. | A growing bubble. |
| `done` | Everything else. | | Normal. |

The phone's own "sending…" / "failed to send" state for messages the bridge hasn't accepted yet is local
(`localState`). It is separate from these server statuses: the server never returns a `pending` row for a send it
refused.

**How the bridge knows `error.messageId` (rev 3.1), verified in `aionui-conversation`.** AionCore's stored `send_failed`
row has no link to the user message: `msg_id` and `backend_turn_id` are both empty (`message_persistence.rs`). The
`message.stream` frame that announces the row does carry the failed send's `turn_id`
(`service.rs` `persist_and_broadcast_send_failure_tip`, called from every failure path). The bridge links the two as
they happen and stores the link in its own table, so it survives restarts:

| Case | Link | `messageId` |
|---|---|---|
| A new-turn send in a **solo** chat, from the phone or the desktop | The send mints the user message and the `turn_id` together (`service.rs`, the send path). core-0015 adds that `turn_id` to the `message.userCreated` event, an additive field. The failure row's `turn_id` then names exactly one user message. | exact |
| A failed **mid-turn** delivery | The failure row carries the *running* turn's id, which would point at the wrong message. That message's own status is set to `error` just before the failure row is written (above), so the bridge links to that message. This link is also in AionCore's DB. | exact |
| A **team member** chat | A team turn can take several queued messages in one batch, and they are projected into the chat under ids that differ from the mailbox ids. There is no reliable one-to-one link in v1. | `null` |
| A failure row written while the bridge wasn't running (before it was installed or enabled) | Nothing was recorded. | `null` |

When `messageId` is `null`, the client uses the fallback described in the table above.

**Sending:**
- Solo chats use the conversation send.
- Team members use the team agent-message route. A team-owned conversation refuses the plain send route.
- `priority: "now"` uses the respond-now/steer route from core patch 0002: delivered into the running turn, or put at
  the front of the queue. It never stops the agent.

### 6.5 Approvals

**`GET /v1/approvals?teamId=`** → `{items: Approval[]}`.
- **Without `teamId`:** every pending approval, solo and team. A solo chat's approvals have no `teamId` and no
  `slotId`, and this is the only route to them; there is no solo-specific endpoint.
- **With `teamId`:** only that team's approvals.

```ts
interface Approval {
  approvalId: string;              // opaque; encodes conversationId + callId
  kind: 'permission' | 'question';
  conversationId: string; teamId?: string; slotId?: string; agentName: string;
  title: string | null;            // e.g. "Bash", or an ACP tool title
  description: string;             // may be ""
  commandType: 'read' | 'edit' | 'execute' | string | null;
  toolName: string | null;
  input: unknown | null;           // the FULL tool input exactly as the agent sent it, e.g. {"command":"npx expo install x",
                                   //   "description":"..."} for Bash. null only for approvals the bridge first saw through
                                   //   a recovery listing (see below).
  inputSummary: string | null;     // the single most important field, untruncated, for display: Bash/execute: `command`;
                                   //   Edit/Write/Read: `file_path`; WebFetch: `url`; otherwise null.
  options: ApprovalOption[];       // in the agent's order; empty for kind 'question'
  questions?: { question: string; header: string | null; multiSelect: boolean;
                options: { label: string; description: string | null }[] }[];
      // kind 'question': the questions to answer. Rev 4.4: an approval of kind 'permission' may also carry it, as
      //   DISPLAY-ONLY context (a non-Claude agent asking through the permission channel; answer with optionId,
      //   freeText false); omitted when absent. Normalized from AionCore's untyped `questions` JSON (Claude's AskUserQuestion shape:
      //   question, header, multiSelect, options[{label, description}]). Unknown fields are dropped.
  freeText: boolean;               // kind 'question' only (false otherwise): whether answers may carry text that is not
                                   //   one of the offered labels. See "Free-text answers" below.
  firstSeenAt: number;
}

interface ApprovalOption {
  optionId: string;
  label: string;                   // display text; AionCore i18n keys (messages.confirmation.*) are replaced with English
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other';
  rule: string | null;             // the exact permanent rule this creates, when the backend states one; null otherwise
  alwaysScope?: 'rule' | 'backend_defined' | 'same_as_once';   // allow_always only, see below
}
```

**Where the command text is (Q8).** It is in `input`, with `inputSummary` as a display shortcut. `description` is often
empty: AionCore stopped stuffing the raw input into it, and for Claude agents it is always `""`.
- **Source:** the bridge copies `input` from the live `message.stream` frame (`tool_call.raw_input`). That frame carries
  the full input for every backend.
- **When `input` is null:** AionCore's recovery listing (`GET .../confirmations`) deliberately omits the input of
  Claude agents' tool calls. So an approval the bridge only learns about from that listing has `input: null`. That can
  only happen if the bridge missed the live frame, which is rare, since the bridge runs inside aioncore. The phone
  should then show "open on PC to see the full command" and should not offer Allow.

**`allow_always` and rule text (Q9).** No backend in AionCore v0.2.2 gives a rule string, so `rule` is always null today.
The field is in the contract so a backend that states one can be shown later without a schema change. What "always"
means differs by backend, and `alwaysScope` says which case applies:

| Backend | `alwaysScope` | What actually happens (verified in source) |
|---|---|---|
| Claude (session backend) | `same_as_once` | AionCore answers Claude with the same `allow` response it sends for allow-once. No permission rule or suggestion is passed on (`claude_conn.rs` `build_control_response`). Claude will ask again next time. |
| ACP agents | `backend_defined` | The agent's own `allow_always` option. Its scope is whatever that agent implements; the label is the agent's own wording. |
| aionrs | `backend_defined` | `ApprovalScope::Always` in aionrs's approval manager. |

The phone should show `rule` when present. Otherwise it should show "Always allow (scope decided by <agent>)", or for
`same_as_once` **relabel it "Allow (this agent will ask again)"**. Don't hide it. That wording was decided in §11 #9
and stays until a core change gives Claude agents a real "always".

**`POST /v1/approvals/{approvalId}/answer`.** The body depends on the kind:
- **Permission:** exactly one of these:
  - `{optionId, message?}`: picks an exact option. This is how `reject_always` or an `other` option is chosen.
  - `{decision: "allow_once"|"allow_always"|"deny", message?}`: a shortcut that the bridge maps to an option.
- **Question:** `{answers: [{question, labels: string[]}]}` or `{decline: true, message?}`.
- `message` (rev 3) is accepted **only on a refusal**: `decision: "deny"`, an `optionId` whose kind is `reject_*`, or
  `decline`. It must be non-blank text of at most 2,000 characters. On an allow it returns `400 invalid_request`.
- **Sensitive** (§5): any answer that allows. These are an `optionId` whose kind is `allow_*` or `other`, a `decision`
  other than `deny`, or `answers`. Deny, `reject_*` and `decline` are never gated.

Responses:
- `200 {resolved: true, messageDelivery: "native" | "followup" | null}`. `null` when no `message` was sent.
- `409 already_resolved`: answered on the PC or by another device
- `404 not_found`
- `422 ambiguous_decision {details: {options: ApprovalOption[]}}`: the `decision` doesn't map to exactly one option

**Deny with a message (rev 3, readiness (a)1).** How the reason reaches the agent depends on the backend (verified in
source):

| Backend | v0.2.2 today | Delivery in core-0015 | `messageDelivery` |
|---|---|---|---|
| Claude (session) | The deny response to Claude carries a fixed `"message": "User rejected the request."` (`claude_conn.rs` `build_control_response`). | core-0015 adds an optional deny message to `Command::AnswerPermission` and puts the user's text in that `message` field, so Claude reads it as the reason for the refusal. | `native` |
| aionrs | `ToolApprovalResult::Denied { reason: "User denied the tool request" }`, a fixed string (`manager/aionrs/agent.rs`). | The user's text becomes `reason`. | `native` |
| Codex (session) | The decision goes over the wire as `"decline"`, with no text field (`codex_conn.rs`). | Follow-up message, below. | `followup` |
| ACP agents | The ACP permission response selects an option id; the protocol has no message field. | Follow-up message, below. | `followup` |
| Question decline (Claude) | `answers: None` dismisses the card. | Follow-up message. | `followup` |

**Follow-up message:** right after the refusal, the bridge sends the text to the same conversation as a user message,
using the respond-now path (delivered into the running turn if possible, otherwise first in the queue). It reads
`Denied <title or toolName>: <message>`. That message appears in the chat like any other. If the follow-up fails, the
refusal still stands, and the response is `200` with `messageDelivery: null` and `details.messageError`.

**Free-text answers (rev 3, readiness (a)5).**
- **Claude (`freeText: true`):** only Claude agents' AskUserQuestion has an answer channel
  (`agent_task.rs` `answer_ask`: ACP and aionrs return "not supported"). AionCore passes `labels` to Claude verbatim,
  with no check against the offered options (`claude_conn.rs` `build_ask_user_question_answers`). Claude reads any
  string as the answer, the same way its own "Other" input works.
  - So any string is accepted for a `freeText` question: trimmed, non-empty, at most 2,000 characters, and no more
    than one free-text string per question. For `multiSelect` questions it may be combined with offered labels.
- **Other agents (`freeText: false`):** questions that ACP agents send through the permission channel are answered by
  picking an option, so only offered labels are allowed. Anything else is `400 invalid_request`.

**UI guidance (Q10).** Render `options` as the list of choices: one button per option, using `label` and `kind`, and
answer with `optionId`. `decision` is a convenience for quick actions such as a notification-style
"Approve / Deny". The `422` response carries the same `options` list, so it opens the same picker. Fixed three-button
UIs will hit `422` on agents that offer, for example, two allow-once variants.

**How the bridge does it.** The tracker:
- adds entries on `message.stream` frames of type `acp_permission`, `ask` or `permission`;
- removes them on `confirmation.remove` and when a turn ends;
- reconciles each tracked conversation against `GET /api/conversations/{id}/confirmations`, plus a sweep on start.

It maps answers per backend, sending only exact option values:

| Backend | allow_once | allow_always | deny |
|---|---|---|---|
| ACP | option id whose kind is `allow_once` | `allow_always` | `reject_once` |
| Claude/Codex session | `"allow"` | `"allow_always"` | `"reject"` |
| aionrs | `{"value":"proceed_once"}` | `{"value":"proceed_always"}` + `always_allow: true` | `{"value":"cancel"}` |

Two backend hazards the bridge guards against:
- **aionrs reads a bare string as deny.** The bridge never sends one.
- **The Claude session backend treats any string it doesn't recognize as an AskUserQuestion answer, which means
  APPROVE** (`session_agent.rs` `confirm`). The bridge only ever forwards an `optionId` that appears in the approval's
  own `options`. Anything else is `400 invalid_request`, never passed through.

### 6.6 Agent controls (ask #4)

| Method & path | Body → response | Backed by | Sensitive |
|---|---|---|---|
| `POST /v1/teams/{t}/agents/{slot}/wake` | `{nudge?: string}` → `{runtime}` | `attach` (retries a dormant or failed runtime), plus a message if `nudge` is set | no |
| `POST /v1/teams/{t}/agents/{slot}/stop` | `{replacementMessage?}` → `{outcome: "cancelled"\|"interrupted"\|"no_active_turn"}` | No replacement: cancel the slot's child turn of the active run. With a replacement: `interrupt` (teammates only; on the lead it returns `422 lead_not_allowed`). | no |
| `POST /v1/teams/{t}/agents/{slot}/shutdown` | `{reason?}` → `{outcome: "requested"}` | **New in core-0015:** a user-originated `shutdown_request` to the agent's mailbox, the same protocol the lead's tool uses. Progress shows in `Agent.shutdown`. Refuses the lead (`422 lead_not_allowed`). | yes |
| `DELETE /v1/teams/{t}/agents/{slot}` | → `{removed: true}` | **Force-remove**, which kills the agent's process (`DELETE /api/teams/{id}/agents/{slot}`). Refuses the lead. This is the "it refused shutdown" path. | yes |
| `POST /v1/teams/{t}/agents` | `{assistantId, name?, model?}` → `Agent` | Spawn (`POST /api/teams/{id}/agents`, role `teammate`) | yes |
| `PATCH /v1/teams/{t}/agents/{slot}` | `{name}` → `Agent` | Rename | no |
| `POST /v1/teams/{t}/agents/{slot}/clear-context` | → `{preservedUnread: number}` | `context/reset` | yes |
| `GET /v1/assistants` | → `[{assistantId, name, backend, icon: string \| null, description: string \| null}]` | `GET /api/assistants` | no |

### 6.7 Tasks

| Method & path | Body → response | |
|---|---|---|
| `GET /v1/teams/{t}/tasks?status=&owner=` | → `Task[]`, most recently updated first. `status` and `owner` are optional filters; `status` may be comma-separated. | read |
| `GET /v1/teams/{t}/tasks/{taskId}` | → `Task` | read |
| `POST /v1/teams/{t}/tasks` | `{subject, description?, owner?, blockedBy?}` → `Task` | write |
| `PATCH /v1/teams/{t}/tasks/{taskId}` | `{subject?, description?, status?, owner?, blockedBy?}` → `Task` | write. `status: "deleted"` is sensitive. |

```ts
interface Task {
  taskId: string;
  teamId: string;
  subject: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner: string | null;            // a slotId; "user" when assigned to the user; null when unassigned
  ownerName: string | null;        // resolved display name; "You" for "user"; null if the slot was removed
  blockedBy: string[];             // taskIds
  blocks: string[];                // taskIds (the reverse links)
  assignment: null | { conversationId: string; messageId: string; createdAt: number };
      // The "📋 Task assigned to you (#id)" notice in the owner's chat (§6.4). It is the closest link from a task
      //   back to a message. null if the task was never assigned to a teammate, or the notice can't be found.
  createdAt: number;
  updatedAt: number;
}
```

Writes go through AionCore's `TaskBoard::create_task` and `update_task`, so `team.taskChanged` fires and the desktop
board updates live. Task writes are approved and **enabled by default** (§11 #4). The PC keeps a switch to turn them
off, and `capabilities` then omits `tasks.write`.

**Write semantics (rev 3, readiness (a)3 and (a)4), verified against `aionui-team`:**
- **Owner notices are automatic, the same as the MCP tools.** AionCore's notify-and-wake logic lives in the MCP tool
  layer (`mcp/server.rs` `maybe_notify_task_owner`), not in `TaskBoard`. So the bridge runs the same rule after its own
  writes, with the notice sent from `"user"`:
  - **When it fires:**
    - on create with an `owner`;
    - on a PATCH that changes `owner`;
    - for each downstream task's owner, when a PATCH sets `status: "completed"` and that unblocks a downstream task.
  - **Who gets one:** only if the owner is a live teammate, not the lead, not `"user"`, and not `"*"`; the task is not
    completed or deleted; and it has no unfinished `blockedBy`.
  - **What it does:** sends the standard `📋 Task assigned to you (#<taskId>): <subject>` mailbox notice (plus the
    description), then wakes the owner.
  - There is **no `notifyOwner` flag**, which matches desktop and MCP behavior. The phone's "Notify owner" checkbox can
    go.
- **`owner: null` unassigns.** `owner: "user"` assigns to the user. Omitting `owner` leaves it unchanged.
  - AionCore v0.2.2 can't clear an owner: `TaskUpdate.owner` is `Option<String>`, and the SQL only sets the column
    when it is present. **core-0015 adds clearing**, so this works when the bridge ships.
- **`subject` is editable.** AionCore v0.2.2's `TaskUpdate` has no `subject` field, so **core-0015 adds it**. Until
  then the field would be refused; it ships together with the bridge.
- **`blockedBy`** replaces the whole list. Unknown task ids are `400 invalid_request`.

**Task → originating message (requested gap):** `Task.assignment` links a task to the notice that assigned it. AionCore
doesn't record which *conversation message* led someone to create a task. In v1,
`GET /v1/teams/{t}/activity?aroundTask={taskId}` returns the mailbox messages around the task's creation time, which is
best-effort. A real link needs a core change and is a v2 candidate.

### 6.8 Activity

`GET /v1/teams/{t}/activity?slotId=&kind=message|task&aroundTask=&cursor=&limit=` →
`{items: Activity[], nextCursor: string | null, hasMore: boolean}`, newest first.
- `slotId` keeps entries sent from or to that agent.
- `aroundTask` returns the 20 entries closest to that task's `createdAt`, and ignores `cursor`.
- This is backed by `GET /api/teams/{id}/activity`.

```ts
type Activity =
  | { kind: 'message'; activityId: string; createdAt: number;
      message: {
        messageId: string;                       // the mailbox id
        from: { slotId: string | null; name: string; isUser: boolean };   // isUser: sent by the user
        to:   { slotId: string | null; name: string; isUser: boolean };   // slotId null + name "everyone" for "*"
        msgType: string;                         // AionCore mailbox type, e.g. "message", "shutdown_request",
                                                 //   "shutdown_approved", "shutdown_rejected"
        content: string;                         // full text
        summary: string | null;
        read: boolean;                           // whether the receiving agent has consumed it
        notice?: { kind: 'task_assigned'; taskId: string };
      } }
  | { kind: 'task'; activityId: string; createdAt: number; task: Task };
```

---

## 7. Discovery, ports and platform notes

- **Port:** default **47734**, configurable in Settings > Mobile. It is fixed rather than dynamic, so URLs stored on
  the phone stay valid. If the port is taken, the PC UI says so. (Before freezing: check it is IANA-unassigned and
  not on browser bad-port lists.)
- **QR `u=` parameters:** every private address the PC has, plus any `extraUrls` (for example the PC's Tailscale
  `100.x` address or MagicDNS name). Adapters with a default gateway come first, so a virtual switch (WSL, Hyper-V)
  doesn't outrank the real LAN. Rev 4.4: IPv6 ULA addresses may appear (as `http://[fd..]:port`); **link-local IPv6 never
  does**, because its zone id means nothing to the phone. Public addresses never appear.
- **mDNS:** `_aiondx._tcp.local`, instance `AionDX-<4 hex>`, TXT `v=1`, `hid=<first 8 b64u chars of
  SHA256(hostId)>`. It is advertised only while the bridge is enabled. The phone uses it only when every stored URL
  for a paired PC fails, matching on `hid`. Spoofing at worst causes a failed handshake.
  - **iOS:** add `NSBonjourServices = ["_aiondx._tcp"]` next to the existing `NSLocalNetworkUsageDescription`.
- **Cleartext:**
  - **iOS:** `NSAllowsLocalNetworking` covers `.local` names and LAN IPs. Tailscale `100.x` and MagicDNS names have
    not been verified against ATS; test them before relying on that path.
  - **Android:** a network security config with `cleartextTrafficPermitted="true"` is needed, since arbitrary LAN IPs
    can't be domain-scoped. This is acceptable because all payloads are sealed end to end.

## 8. Remote access

LAN-only for v1. The envelopes are relay-safe, so a relay could be added later without protocol changes.

A hosted AionDX relay is not recommended, because AionDX's README promises "no telemetry; AionDX contacts GitHub
only". A relay would be the first AionDX-operated service, with uptime, cost and abuse handling to own.

Bring-your-own Tailscale/WireGuard works today with no bridge changes: add the tunnel address to `extraUrls`. Still to verify:
which Windows firewall profile the Tailscale adapter gets, because the Private-only rule must match it.

**To verify: Private Party Net.** Nathan is building a WireGuard-based network called Private Party Net. If it is used
as a bring-your-own tunnel, two things must be checked against the bridge:
- **Address range:** its peer addresses must be in a range the listener's private-peer filter accepts (§2): RFC 1918,
  CGNAT `100.64/10`, link-local, or IPv6 ULA / link-local. If it uses anything else, the filter needs that range
  added deliberately.
- **Firewall profile:** the Windows firewall profile its WireGuard adapter is assigned. The bridge rule is
  Private-only, so an adapter classed as Public would block the bridge.

Nothing is decided here yet.

## 9. Known issues and out of scope

- **K1 (existing gap, not caused by mobile):** any agent's `AIONUI_RUNTIME_TOKEN` authenticates as the full user on
  every HTTP route. A non-lead teammate can therefore hard-remove or spawn agents over HTTP, bypassing the MCP
  lead-only rule. **Approved for a separate core patch (§11 #5)**: record `AuthChannel` and refuse runtime-token callers on team
  lifecycle routes. This document's admin routes already refuse them (§3.4). Not in this contract's scope.
- **K2:** the WebUI "allow remote" proxy forwards all `/api/*` routes to the LAN over plain HTTP. They are still
  JWT-gated in aionpro mode. It is unrelated to this bridge, and the bridge doesn't use it. The existing public AionUi
  Expo app (`aionui/mobile`) uses that path and is not a model for this work.
- **K3:** the JWT secret is stored in plain text in `aionui-backend.db`. The bridge keeps its own secrets out of AionCore's DB
  (sealed with a DPAPI-protected `dataKey`).
- **Out of scope for v1:** push notifications (they would need a relay or APNs/FCM, which is the same sign-off as §8),
  attachments from the phone, multiple Core users per PC, and manual-code pairing.

## 10. Mapping from `remoteApi.ts` to this contract

| remoteApi.ts (assumed) | Contract |
|---|---|
| `listTeams` `GET /api/teams` | `GET /v1/teams` |
| `getRunState` | `GET /v1/teams/{t}/run-state` (or `GET /v1/changes` plus targeted fetches) |
| `listPrompts` `…/permission-prompts` | `GET /v1/approvals?teamId=` (also covers solo chats) |
| `resolvePrompt {decision}` | `POST /v1/approvals/{id}/answer {optionId}` (preferred) or `{decision}` (sensitive for allow) |
| `listConversations(team)` | Roster `agents[].conversationId` in run-state; solo chats via `GET /v1/conversations?kind=solo` |
| `getMessages(…, since)` | `GET /v1/conversations/{cid}/messages?since=<cursor>`; the cursor is opaque, not a message id |
| older messages (gap) | `?before=<cursor>` |
| `sendMessage {message}` | `POST /v1/conversations/{cid}/messages {content, priority?}`; broadcast is `POST /v1/teams/{t}/broadcast` |
| new solo chat (gap) | `POST /v1/conversations` |
| `listTasks` / `createTask` / `updateTask` | `GET`/`POST`/`PATCH /v1/teams/{t}/tasks…` |
| task → message link (gap) | `Task.assignment` (the assignment notice) plus `activity?aroundTask=` (best-effort) |
| broadcast history (review Q6) | `GET /v1/teams/{t}/broadcasts` |
| list previews (review Q5) | `lastMessage` on `Agent`, `Conversation` |
| current task per agent (review Q4) | `Agent.currentTask`, `Agent.openTaskCount` |
| confirm-key re-issue (review Q14) | `aiondx://rekey` QR plus `POST /v1/host/device/confirm-key` (§5.3) |
| "Deny with message…" (readiness (a)1) | `POST /v1/approvals/{id}/answer {decision:"deny" \| optionId, message}` → `messageDelivery` (§6.5) |
| "Other" free-text answer (readiness (a)5) | `answers[].labels` may include free text when `Approval.freeText` (§6.5) |
| start a stopped team (readiness (a)6) | `POST /v1/teams/{t}/session`; sends also auto-start it (§6.3) |
| task "Notify owner" checkbox (readiness (a)3) | Removed; the notice is automatic (§6.7) |
| `listAssistants` | `GET /v1/assistants` |
| `spawnAgent {assistantId, name}` | `POST /v1/teams/{t}/agents` (sensitive) |
| `stopTurn` | `POST /v1/teams/{t}/agents/{slot}/stop` |
| `wakeAgent` | `POST …/wake` |
| `shutdownAgent` | `POST …/shutdown` (polite) and `DELETE …/agents/{slot}` (force, the "refused" gap) |
| rename / clear-context (gap) | `PATCH …/agents/{slot}`, `POST …/clear-context` |
| `getActivity(team, slot)` | `GET /v1/teams/{t}/activity?slotId=` |

## 11. Decisions record

All nine items were **approved by Nathan on 2026-11-07, as recommended**. The mobile lead relayed the list and Nathan
confirmed it directly to the AionDX lead.

| # | Decision | Where |
|---|---|---|
| 1 | A mobile facade with an allowlist by construction, not a passthrough of AionCore routes. | §6, A9 |
| 2 | LAN-only v1. Remote access through the user's own tunnel (Tailscale / WireGuard); no hosted relay. | §8 |
| 3 | Bridge-enforced confirmation proof for the §5.1 action list. On by default, can be relaxed per device on the PC. Chat send is not gated. | §5 |
| 4 | Task writes from the phone. **Ships with `tasks.write` enabled**; the PC can switch it off. | §6.7, §6.1 |
| 5 | The K1 runtime-token lead-only bypass is fixed in a **separate core patch**, outside this contract. | §9 |
| 6 | Port 47734, with mDNS advertised by default while the bridge is enabled. | §7 |
| 7 | Session TTL 12 h absolute, 30 min idle. | §0, §4.3 |
| 8 | Passcode-only phones may do sensitive actions behind an app-enforced passcode check, shown as such on the PC. Phones with no passcode get no `confirmKey`. | §5.2 |
| 9 | Claude "Allow Always" (`alwaysScope: same_as_once`): the phone **relabels** it "Allow (this agent will ask again)" rather than hiding it, until a core change adds a real "always". No bridge change. | §6.5 |

---

## Appendix A. Shared test vectors

Files: `docs/mobile-bridge/vectors/vectors.json` and its generator `vectors/gen-vectors.js` (Node 20+, no packages).
`node gen-vectors.js --check` confirms the JSON matches the generator.

**Generator self-checks.** Before emitting anything, the generator:
- checks HChaCha20 and XChaCha20-Poly1305 against the published draft-irtf-cfrg-xchacha-03 vectors (§2.2.1 and
  §A.3.1);
- round-trips every sealed box it writes.

Inputs are fixed: `SHA-256("aiondx-test-vector/<label>")`. Every intermediate value is included, so a mismatch shows
exactly which step differs.

| Block | Covers |
|---|---|
| `inputs` | `S_h`, `S_c`, `e_c`, `e_h` (private and public keys), `hostId`, `deviceId`, `pairingSecret`, `ts` |
| `pairing` | `DH(S_c,S_h)`, `k_pair`, SAS bytes and the formatted SAS, the sealed pair request and the approved response with `confirmKey` (plaintext, AAD, nonce, ct) |
| `handshake` | all four DH outputs, init salt, `k_init`, the sealed init, transcript `T`, 80-byte OKM, `c2s`, `s2c`, `sid`, the sealed response |
| `rpc` | the sealed request and response at `seq = 1` |
| `revocation` | `DH(S_h,e_c)`, salt, `k_rev`, the sealed notice (A1) |
| `confirm` | three requests (simple body, a nested body with key ordering and non-ASCII text, no body): JCS string and hex, body hash, HMAC input, proof |
| `rekey` | `rekeySecret`, HMAC input, proof (§5.3) |

**Conventions the vectors pin down.** The mobile team should confirm their `primitives.ts` does the same:
- `ct = b64u(ciphertext ‖ 16-byte tag)`.
- HKDF with an empty salt means a zero-length salt.
- The sealed plaintext is the exact UTF-8 of the `plaintext` string shown.
- The SAS is the first 4 HKDF bytes read as a big-endian uint32, mod 10^6, zero-padded, formatted `ddd ddd`.
