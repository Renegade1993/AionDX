# AionDX Mobile: Device Pairing and End-to-End Encryption (Proposal v1, DRAFT)

**Status:** Client-side proposal from the Mobile Engineer. It needs review and sign-off from the AionDX bridge/backend owners. Everything on the wire is versioned (`v: 1`), so the scheme can change before launch without breaking anything.

**Reference code:**
- `src/lib/crypto/protocol.ts`: the client side and the wire format.
- `src/lib/crypto/protocol.host.ts`: an executable host-side reference.
- `src/lib/crypto/__tests__/protocol.test.ts`: 17 tests that run the phone code against the host reference.

If the bridge team picks a different scheme (for example Noise via a library, or mTLS), only `protocol.ts` and `secureChannel.ts` change. The screens and data layer stay the same.

---

## 1. Goals and threat model

| Goal | How it's met |
|---|---|
| Only phones the PC owner approved can call the API | Each phone has a static X25519 key. The PC pins it at pairing time, and the user must approve a matching 6-digit code on the PC |
| The phone only talks to *its* PC | The PC's static public key is delivered out-of-band in the QR code and pinned. A successful handshake proves the PC holds the key |
| Confidentiality and integrity on an untrusted LAN, café Wi-Fi, or a future relay | All API traffic is sealed with XChaCha20-Poly1305. Paths and team/agent IDs are also hidden inside the envelope |
| Forward secrecy | A fresh ephemeral X25519 pair on both sides for every session. Leaking the static keys later doesn't decrypt past sessions |
| Replay protection | Sequence numbers are bound into the AEAD associated data (AAD), with a sliding replay window on the host. Handshakes carry timestamps (±2 min) |
| Works without a CA, TLS certs, or internet | Pure application-layer encryption over plain HTTP on the LAN. The same envelopes work unchanged through a relay later |

**Out of scope for v1:** a compromised phone OS or compromised PC, push notifications, and multiple users per PC.

## 2. Primitives

These are all audited, pure-JS `@noble/*` libraries, so they run in Expo Go and need no native module. Node and Electron bridges can use the same packages, or any standard implementation (libsodium, RustCrypto).

| Purpose | Algorithm |
|---|---|
| Key agreement | X25519 |
| KDF | HKDF-SHA256 |
| AEAD | XChaCha20-Poly1305 (random 24-byte nonces, safe to generate randomly) |
| Hash | SHA-256 |
| Encoding | base64url without padding (decoding rejects non-canonical input) |
| RNG | `crypto.getRandomValues`, backed by `expo-crypto` (the platform CSPRNG) on device |

## 3. Keys

| Key | Owner | Lifetime | Storage |
|---|---|---|---|
| `S_h` host static X25519 | PC bridge | Long-term (rotation means re-pairing) | Bridge's choice (OS keychain recommended) |
| `S_c` phone static X25519 + random `deviceId` | Phone | Until app reinstall or "reset" | `expo-secure-store` (Keychain / Android Keystore), `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, excluded from backups |
| `pairingSecret` (32 B) | PC → QR | Single use, about 5 min | PC memory only |
| `e_c`, `e_h` ephemerals | Both | One session | Memory only |
| Session keys `c2s`, `s2c`, `sid` | Both | Until `expiresAt` (host-chosen, suggest 12 h) | Memory only |

## 4. Pairing (one-time)

```
PC (bridge)                                             Phone
-----------                                             -----
user clicks "Pair a phone"
generate pairingSecret, expiry
show QR:  aiondx://pair?v=1&id=<hostId>&n=<hostName>
          &pk=<S_h pub>&s=<pairingSecret>&x=<expiry ms>
          &u=http://192.168.1.20:7777&u=http://10.0.0.5:7777
                                                        scan QR, parse, check expiry
                                                        k_pair = HKDF(DH(S_c, S_h),
                                                                 salt = pairingSecret,
                                                                 info = "aiondx/v1/pair" || S_h || S_c)
                     POST /api/mobile/v1/pair  <------- {v, hostId, deviceId, devicePk, nonce, ct}
                                                        ct = AEAD(k_pair, {deviceName, platform, appVersion, ts},
                                                                  aad = "aiondx/v1/pair-req|hostId|deviceId")
derive k_pair, decrypt (proves phone saw QR
and holds S_c), check ts ±2 min
SAS = 6 digits from HKDF(k_pair, "aiondx/v1/sas")       SAS shown on phone: "482 913"
show "Approve <deviceName>? Code 482 913"
                     200 {nonce, ct} ------------------> ct = AEAD(k_pair, {status, hostId, hostName, ts},
                                                                  aad = "aiondx/v1/pair-res|hostId|deviceId")
                                                        status = pending → re-send every 2 s (fresh nonce/ts)
user clicks Approve → store (deviceId, S_c pub, name)   status = approved → pin {hostId, S_h, urls}
invalidate pairingSecret                                 in SecureStore, go to dashboard
```

The SAS (short authentication string) check is what stops someone who photographs or relays the QR code from pairing their own phone. They would get a different code, and the PC user wouldn't approve it.

Plaintext error `{"error":"pairing_expired"}` (HTTP 410 suggested) tells the phone to ask the user for a new code.

## 5. Session handshake (every app launch / when the session expires)

The structure follows Noise **KK**: both static keys are already known, both sides contribute ephemerals, and the four DH outputs are mixed.

```
Phone                                                   PC
e_c = fresh X25519
k_init = HKDF(DH(e_c,S_h) || DH(S_c,S_h),
              salt = SHA256("aiondx/v1/hs-init|deviceId|" || S_c || S_h || e_c),
              info = "aiondx/v1/hs-init")
POST /api/mobile/v1/session
  {v, hostId, deviceId, epk: e_c, nonce, ct}  ------->  look up S_c by deviceId (else 403 device_revoked)
  ct = AEAD(k_init, {ts}, aad = label|hostId|deviceId|e_c)
                                                        decrypt (authenticates phone), check ts ±2 min
                                                        e_h = fresh X25519
                                                        T   = SHA256("aiondx/v1/session|deviceId|" || S_c || S_h || e_c || e_h)
                                                        ikm = DH(e_c,S_h) || DH(S_c,S_h) || DH(e_c,e_h) || DH(S_c,e_h)
                                                        c2s || s2c || sid = HKDF(ikm, salt=T, info="aiondx/v1/session-keys", 80)
                     <-------  200 {v, epk: e_h, nonce, ct}
                               ct = AEAD(s2c, {expiresAt}, aad = T)
same derivation; successful decrypt authenticates PC
```

## 6. Encrypted API calls (tunnel)

Every AionDX API call goes through one endpoint, so the bridge needs one middleware rather than a change per route:

```
POST /api/mobile/v1/rpc
  request:  {v, sid, seq, nonce, ct}
            ct  = AEAD(c2s, {method, path, body?}, aad = "aiondx/v1/rpc-req" || sid || u64be(seq))
  response: {v, sid, seq, nonce, ct}       (same seq as the request)
            ct  = AEAD(s2c, {status, body?}, aad = "aiondx/v1/rpc-res" || sid || u64be(seq))
```

- **Bridge:** finds the session by `sid`, decrypts, checks `seq` against a sliding replay window (size 256; polling requests arrive out of order), dispatches `{method, path, body}` to the existing API handlers in-process, and seals the result.
- **Phone:** checks that the response's `sid` and `seq` match the request before decrypting. Each `seq` is used once per session, and the counter resets on each new session.
- **Outer status codes:** these are plaintext and carry no secrets.
  - `200`: an envelope (inner `status` holds the real API status).
  - `401 {"error":"unknown_session"|"session_expired"}`: the phone re-handshakes and retries once.
  - `403 {"error":"device_revoked"}`: the phone drops the pairing.
- Polling (`GET /api/teams/{id}/run-state` every 3 s while foregrounded, paused in the background) runs over this channel unchanged.

## 7. Client implementation summary

| Concern | Where |
|---|---|
| Primitives (X25519, HKDF, AEAD) | `src/lib/crypto/primitives.ts` |
| Wire format, pairing, handshake, envelopes | `src/lib/crypto/protocol.ts` |
| Keychain/Keystore persistence | `src/lib/storage/keyStore.ts` |
| Session lifecycle, coalesced handshakes, re-key on 401, multi-URL failover | `src/lib/api/secureChannel.ts` |
| Pairing request/poll loop | `src/lib/api/pairing.ts` |
| React Query hooks (polling) | `src/lib/api/queries.ts` |
| Pairing UI (functional, unstyled) | `src/app/pair/{index,scan,confirm}.tsx` |

## 8. Decisions needed from the bridge/backend team

1. **Accept this scheme, or name the one you want** (Noise_KK via a library, mTLS with pinned self-signed certs, etc.). The client is structured so the swap stays contained.
2. **Endpoint paths and port:** `/api/mobile/v1/{pair,session,rpc}`. Does the bridge listen on the LAN interface, and on which port? Should it be advertised via mDNS (`_aiondx._tcp`) as well as the QR URLs?
3. **Remote access:** will there be a relay or tunnel for off-LAN use? The envelopes are relay-safe as designed. The relay only needs to forward opaque JSON.
4. **Host key storage and rotation:** where `S_h` lives on the PC, and the UX for revoking a phone (it should produce `device_revoked`).
5. **Session TTL:** 12 h is suggested.
6. **API schema:** a published schema for run-state, messages, tasks, agent control, and permission prompts. `src/lib/api/aiondx.ts` currently uses provisional types modeled on today's run-state fields.
7. **Permission-prompt approvals:** should approving a sensitive action also need a biometric check on the phone? `expo-local-authentication` can gate it client-side, and the bridge could require a per-action confirmation flag.

## 9. Alignment with the design spec (`docs/design/SPEC.md`)

| Spec item | Status |
|---|---|
| QR carries the PC address, one-time code, public key, and expiry | ✅ `aiondx://pair?...` (§4) |
| 6-digit code shown on both devices (P3) | ✅ SAS from `k_pair`. The phone can show it immediately after scanning |
| Phone polls pairing status until the PC confirms | ✅ The pairing request is re-sent until `approved`/`rejected`. The interval is easy to change (spec says 1 s / 2 min timeout; the code currently uses 2 s / QR expiry) |
| "Auth rejected" → Re-pair (F6) | ✅ `403 device_revoked` → `DeviceRevokedError` (React Query stops retrying) |
| **P2b manual entry (host + 8-char code)** | ⚠️ **Conflict.** Without the QR, the phone doesn't get the PC's public key out-of-band. An 8-char code (~40 bits) used as the HKDF salt can be brute-forced offline by a LAN attacker who intercepts the first message, and the 6-digit SAS can be ground. Options: (a) defer manual entry, (b) use a PAKE (CPace/SPAKE2) for manual pairing, or (c) make the manual code long enough to carry a key commitment (~26 base32 chars). **Recommendation: (a) for v1.** |
| P4 device name entered *after* pairing | ⚠️ Minor. The pairing request currently sends the OS device name. Either move naming before P3, or add an encrypted `rename device` RPC after pairing. Both work |
| Encrypted local cache of run-state/chats/tasks per PC | Planned. SecureStore holds a random 256-bit data key per host. Cached data is sealed with XChaCha20-Poly1305 and written to app files. Unpairing deletes the key, which crypto-shreds the cache |
| App lock + Face ID before approvals | Planned. `expo-local-authentication` for the lock screen and per-approval checks. Keys stay at `WHEN_UNLOCKED_THIS_DEVICE_ONLY` |
| Route map `(onboarding)` / `(app)` with 4 tabs | The scaffold uses provisional `pair/` + 5 tabs. It will be renamed to the spec's map when the screens are built |

## 10. Platform notes

- **iOS:** plain-HTTP LAN calls need App Transport Security (ATS) local-networking allowances and the local-network prompt. `NSLocalNetworkUsageDescription` is already set in `app.json`. An ATS exception (`NSAllowsLocalNetworking`) will be added through config once the transport is final.
- **Android:** cleartext traffic to the LAN needs a network security config, through `expo-build-properties` or a small config plugin. It isn't added yet, pending decision 2.
- **Web build:** `expo-secure-store` isn't available on web, so the web target is for layout previews only.
