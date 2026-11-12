# core-0016: the mobile bridge (encrypted PC ↔ phone API)

Patch: `0001-mobile-bridge.patch` in this folder. Applies after core-0015, and needs its `AuthChannel`.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Contract: `docs/mobile-bridge/CONTRACT.md` (rev 4.5). Plan:
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
| `admin_routes.rs` | `GET /api/mobile/admin/status` and `PUT /api/mobile/admin/settings` on AionCore's 127.0.0.1 server. They **refuse the runtime-token channel** (core-0015's `AuthChannel`), so an agent can't switch the bridge on. |
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

## Phase 2, 2026-11-07: facade read routes

| File | What |
|---|---|
| `backend.rs` | The `MobileBackend` port: the facade's view of AionCore (teams, run-state, tasks, activity, conversations, messages, latest message, assistants). This crate depends on no domain crate. |
| `shape.rs` | Pure mapping from AionCore's serialized JSON to the contract's JSON: `Agent`, `RunState`, `TeamSummary` (§6.3); `Task` (§6.7); `Activity` (§6.8); `Conversation` and `Message` (§6.4), including the role/sender table, the task-assigned and context-reset notices, and `error` on send_failed and agent tips. |
| `facade.rs` | The `/v1` routes inside the tunnel (an allowlist; anything else is `no_such_route`): `GET /v1/teams`, `/v1/teams/{t}/run-state`, `/v1/teams/{t}/agents/{slot}`, `/v1/teams/{t}/tasks[/{id}]` (status/owner filters), `/v1/teams/{t}/activity` (slotId, kind, cursor, aroundTask), `/v1/conversations?kind=solo` (team chats filtered out, pages refilled), `/v1/conversations/{cid}`, `/v1/conversations/{cid}/messages` (latest page + `before`, `?before=` paging, `?since=` **sync cursor**), `/v1/workspaces`, `/v1/assistants`. |
| `aionui-app/src/router/mobile_backend.rs` | `AppMobileBackend` over `TeamSessionService`, `ConversationService` and `AssistantService`. Installed on the bridge when the router is built. |

**The sync cursor (§6.4):** `s1.` + b64u({"f": floor}). The floor is the oldest row still streaming or pending, else
the newest row, minus 5 s. A poll re-reads AionCore's `after (floor-1, "~")`, which means every row with
`created_at >= floor`, so in-place edits and late-start rows are caught. A garbage cursor gives `reset: true`.

**Tests:** 66 pass.
- **14 new shape unit tests:** run-state mapping and lead-first ordering; the no-session state; the message
  role/sender/notice/error table; task-assigned parsing; solo vs team conversations; activity parties.
- **6 facade route tests** (`tests/facade_routes.rs`), with a fake AionCore whose fixtures are AionCore's own JSON
  forms: teams and run-state with lastMessage; tasks filter and owner names; solo listing that skips team chats and
  refills the page; the sync cursor (the after-cursor sent is checked exactly) plus `before` paging and a garbage
  reset; workspaces dedupe; non-facade paths fall through.
- `cargo check -p aionui-app` is clean.

**Phase 2 limits, filled by phase 4 (the journal, the tracker, read markers):**
- `unread` is 0; `your_turn` is never set.
- `needs_answer` isn't told apart from `needs_approval`.
- `shutdown` is null.
- `sessionStatus` is only `none` or `ready`.
- `Task.assignment` is null.
- `error.messageId` on send_failed rows is null.
- `runtime` comes from GET team's `context_reset.availability`, the only per-agent runtime view there.

## Phase 3, 2026-11-08: write side, confirm proofs, re-key

| File | What |
|---|---|
| `facade_write.rs` | The write routes (§6): `POST /v1/conversations` (new solo chat; the workspace must be one from `/v1/workspaces`; exactly one of `assistantId` or `backend`), `POST /v1/conversations/{cid}/messages` (team chats go to send-to-agent, or steer for `priority: "now"`; solo chats to the conversation send), `POST /v1/conversations/{cid}/read`, `POST`/`GET /v1/teams/{t}/broadcast[s]`, `POST /v1/teams/{t}/session`, `POST /v1/teams/{t}/agents` (spawn; the name defaults to the assistant's), `PATCH`/`DELETE /v1/teams/{t}/agents/{slot}`, `.../wake`, `.../stop`, `.../shutdown`, `.../clear-context`, `POST`/`PATCH /v1/teams/{t}/tasks[/{id}]`. The lead can't be removed, shut down, or stopped with a replacement (422). |
| `outer.rs` | `confirm_check`: verifies the §5.4 HMAC (JCS body) for devices with `requireConfirm`. A missing proof on a §5.1 action gives 428 `confirm_required`; a bad one gives 403 `confirm_invalid`. `POST /v1/host/device/confirm-key` is the re-key (§5.3): at most 5 attempts, a proof bound to `sid` and the device, the new key sealed under `dataKey`, and `mobile.deviceChanged` "rekeyed". `appVersion` is now the app's version (QA fix b). |
| `admin_routes.rs` | `POST /api/mobile/admin/devices/{id}/rekey-offers` → `aiondx://rekey?...` QR. |
| `migrations/0003_broadcasts.sql` | `mobile_broadcasts`: the broadcast record. |
| aionui-team `service/user_actions.rs` | User-originated task create/update (editable `subject`, `owner: null` unassigns, the owner gets a notice, completion unblocks downstream), spawn (model resolution as for the lead's spawn), and shutdown. |
| aionui-team `session.rs` | `shutdown_agent_from_user`: a `shutdown_request` from "user" through the mailbox. It's the same path as the lead's, and the lead itself is refused. |
| aionui-db `UpdateTaskParams` | `subject`, `clear_owner` (`owner = NULL`). |
| aionui-app `mobile_backend.rs`, `routes.rs` | The write methods; the facade gets the bridge store; `set_app_version(services.app_version)`. |

**Tests:** 111 in aionui-mobile (89 unit, 11 facade route, 6 protocol e2e, 5 vectors), plus the aionui-db test
`update_task_subject_and_clear_owner`.
- **New facade tests:** sends by conversation kind (team, steer, solo); a sensitive action with no proof (428), a
  bad proof (403), and a good one; agent controls, including lead refusals and stop with no active turn; task writes,
  owner unassign, and `capability_disabled`; broadcast and the new-solo-chat validation.
- **e2e `confirm_proofs_and_rekey_through_the_tunnel`:** a real tunnel with real proofs, a re-key, and the old key
  then rejected.
- **Clippy** at `-D warnings` is clean in every file this patch and core-0015 touch. The pre-existing hits were the
  `result_large_err` in outer.rs, `disallowed_types` in admin_routes, mobile_backend and lifecycle_guard (all HTTP
  boundaries, allowed per module the way upstream `routes.rs` does it), and a collapsible `if` in cmd_server. What's
  left is upstream baseline: aionui-team session.rs:142/613/1171 and aionui-app config.rs:95.
- **Not covered by a service-level test:** the user-originated owner notice and the user shutdown request in
  aionui-team. QA checks these live.

## Phase 4, 2026-11-08: the change feed, approvals, derived state

Voice Core's pure modules (`journal.rs`, `approvals.rs`, from `phase4-core` d0595057) are wired in.

| File | What |
|---|---|
| `facade_live.rs` | `Facade::on_event`: AionCore's bus events become change-journal entries and keep the approvals tracker current. `message.stream` (with permission/ask frames), `message.userCreated` / `statusChanged`, `confirmation.remove`, `turn.completed`, `conversation.*`, `team.*`. Routes: `GET /v1/changes` (long-poll, at most 25 s, 500 entries), `GET /v1/approvals` (the first listing per user sweeps live conversations, later ones reconcile tracked ones), `POST /v1/approvals/{id}/answer` (map_answer; allows are gated; 409 when AionCore no longer lists the call; refusal reasons go native or as a respond-now follow-up). A teammate's refusal of a phone-sent shutdown (the mailbox note to the lead) sets `Agent.shutdown` to rejected. `sessionStatus` follows `team.sessionStatusChanged`. send_failed rows are linked to their user message. |
| `read_state.rs` | `unread` and `your_turn` from the read marker pref and the newest 100 messages; `needs_answer` from the tracker; `Task.assignment` from the owner's newest 200 messages. |
| `migrations/0004_send_failures.sql` | The failure row → user message links (they survive restarts). |
| aionui-app `mobile_backend.rs` | `pump_events` (the bus → `on_event`; a lag means a re-sweep); `approval_source` (backend kind from the LIVE `AgentInstance`: Acp, Aionrs, Session+claude or codex); `live_conversations`, `confirmations`, `confirm` (with a deny message), `answer_ask`. |
| aionui-session / ai-agent / conversation | `Command::AnswerPermission.deny_message`: Claude puts it in the deny response's `message`; aionrs uses it as the `Denied` reason. `confirm_with_message` on AgentInstance, SessionAgentTask, AionrsAgentManager and ConversationService. The new-turn send's `message.userCreated` carries `turn_id`. |

**Tests:**
- aionui-mobile: 123 (94 unit, 18 facade-route, 6 e2e, 5 vectors). New:
  - the feed carries approvals (added, then removed as answered); an ACP refusal goes as a follow-up message;
  - an allow needs a proof (428 / 403); a message on an allow is 400; already_resolved; 404;
  - a Claude refusal is delivered natively; a turn end cancels; confirmation.remove;
  - the shutdown rejected → cleared on removal;
  - a per-user long-poll wakes on a task change; a stranger token resets;
  - unread / your_turn / needs_answer / sessionStatus;
  - send-failure links (new turn and mid-turn), which survive a new facade;
  - Task.assignment.
- aionui-session: the deny message replaces the fixed text only on a deny. aionui-ai-agent: the aionrs denial reason. aionui-conversation: `turn_id` on userCreated.
- **Hardening:** the bridge DB's corrupt-file move now retries (a Windows handle can linger after a failed open). The recovery test failed once in parallel runs and couldn't be reproduced in 8 more.

**Phase 4d:**
- QA SD2a: the aionui-team test `declined_shutdown_emits_mailbox_changed_for_the_bridge` drives the real MCP decline through a mailbox wired as `TeamSession::new` wires it, and pins the `team.mailboxChanged` the bridge parses.
- A `requested` shutdown becomes `expired` after 10 minutes (rev 4.5).
- `your_turn` for a lead on `GET /v1/conversations/{cid}`.
- aionui-mobile: 124 tests.

**Known limits:**
- `Agent.shutdown` "approved" can't be observed: AionCore broadcasts nothing when a teammate approves (`notify_shutdown_acknowledged` only logs); the agent is simply removed about 0.5 s later. The state goes requested → (removed).
- Team-chat send failures stay unlinked (`messageId: null`), as the contract says.

## Phase 5, 2026-11-08: network surface (core side)

The parallel modules are cherry-picked: `firewall.rs` (fe760633), and `netinfo.rs` + `mdns.rs` (bb94d097, 90f2dc35).
mdns-sd 0.21.7 bumps libc workspace-wide.

| File | What |
|---|---|
| `service_net.rs` | The QR `u=` list from netinfo (loopback only when bound there; the primary-address probe as a fallback). The mDNS advertiser while listening, when mDNS is on. `AIONDX_MOBILE_BIND` (loopback only; anything else is ignored with a warning). `firewall_status` (read-only show + the add plan for this exe and port). `rekey_offer_state`. |
| `listener.rs` | On `0.0.0.0`, also `[::]` on the same port; with no IPv6, IPv4 only. |
| `admin_routes.rs` | `GET /api/mobile/admin/firewall`, `GET /api/mobile/admin/rekey-offers/{id}`. |
| `core.rs`, `outer.rs` | A re-key offer keeps its end state (completed / failed) and can't be replayed. |
| `service.rs` | `status.extraUrls`; Running holds the advertiser (dropping it withdraws). |

**Tests:** aionui-mobile 156 (126 unit, 19 facade, 6 e2e, 5 vectors). New: the bind switch; the firewall view; a fake-netsh
firewall status that only ever runs the show plan; re-key pending → completed → no replay (e2e); loopback QR URLs and
`extraUrls`.

**Not covered by an automated test:**
- The `[::]` twin of a `0.0.0.0` listener. A unit test would listen on the LAN, and Windows could show a firewall prompt.
- A live mDNS advertisement.

Both need a LAN live check (an approval gate: it listens on the LAN).

**Phase 5b, QA phase 4 fixes:**
- AP6: a solo refusal follow-up goes through `ConversationService::respond_now`: into the running turn, a new turn,
  or held until the running turn ends (an ACP agent's turn keeps running after a refused tool). There's a
  conversation-service test with a turn held running.
- AP5: a repeat answer within 10 minutes is `409` with `details.resolution`.
- CONTRACT rev 4.5 notes both.

**Desktop:** Voice UI Engineer's app patch 0020-mobile-settings (it was 0018 on branch `mobile-desktop-ui`; upstream took
0018 and 0019). It runs the elevated
firewall add itself.

## 0.27.0, 2026-11-12: renumbered, audit log, M5b, bounded close

**Renumbered.** Upstream added core-0014-launch-skills, so this patch is core-0016 and the K1 patch core-0015 (they were
core-0015 and core-0014). The rebase onto launch-skills had no conflicts: it only touches
`ConversationService::build_task_options*`, and this patch's `service.rs` edits are elsewhere. The comments in the code
that cite patch numbers were renumbered on the lines this patch adds (launch-skills' own "core-0014" stays).

**Audit log** (`audit.rs`, CONTRACT §3.3):
- **What's logged:** every mutating phone request is one line in `%LOCALAPPDATA%\AionDX\logs\mobile-bridge.log`: UTC
  time, device id, method + route with its ids split into `targets`, and the outcome (status + error code). Pairing
  approvals and revocations are logged too.
- **What isn't:** bodies, proofs and keys never appear. Fields are sanitized so a value can't forge a second entry. A
  retried request id isn't logged twice, and reads aren't logged.
- **Size:** past 1 MiB the file is renamed to `.1` (replacing the old one), so at most about 2 MiB exists.
- **Tests:** unit tests for the format, sanitizing, rotation, and the disabled log; an e2e test through the tunnel
  that checks no content leaks. Tests never write the real file (`set_audit_log(AuditLog::disabled())`).

**M5b.**
- **The bug:** `reconcile` kept a running listener without looking at `mdns`, so `{mdns:false}` alone left the
  advertisement up.
- **The fix:** it now withdraws it (goodbye packets, off the async threads) or restarts it, and the listener stays the
  same socket. Switching the bridge off withdraws the advertisement before closing the listener.
- **Testing:** the advertiser is injectable (`set_advertiser`), so tests use a fake on loopback and nothing multicasts.

**Slow close on `{enabled:false}`.**
- **The cause:** `ListenerHandle::stop` waited for axum's graceful shutdown, which waits for every request in flight. A
  phone's `/v1/changes` long-poll holds a request for up to 25 s.
- **The fix:** the close now waits `STOP_GRACE` (2 s), then drops what is left.
- **Test:** a hanging request is cut off at about 2 s.

## Hand-off (final, 2026-11-08)

### State of every phase

| Phase | State | Where |
|---|---|---|
| core-0015 (K1: lifecycle routes lead-only for runtime tokens) | done; QA live A1–A7 pass | `patches/core-0015-auth-channel` |
| 0: the crate, its own DB, the DPAPI host key, the listener, admin status/settings | done | |
| 1: pair / session / rpc, devices; recovery, `lastRecovery` | done; QA B0–B11 pass | |
| 2: facade reads | done | |
| 3: writes, confirm proofs (§5.4), re-key (§5.3) | done; QA 68/69, the one gap fixed in 4 | |
| 4: the change feed, approvals, native/follow-up refusals, derived state, send-failure links, shutdown rejected/expired | done; QA 92/95, then AP5/AP6 fixed in 5b | |
| 5 core: netinfo QR, mDNS, IPv6 `[::]`, firewall status, re-key state, `extraUrls`, `AIONDX_MOBILE_BIND` | done | |
| 5b: AP6 (`respond_now` for solo refusals), AP5 (409 for a resolved id) | done | |
| 5c: AP1 (self-healing approvals), `firewallEnabled`, effective mDNS, netinfo ordering | done; QA's final pass on exe 85f2467c (the last pre-0.27.0 build) | |
| 0.27.0: rebased onto upstream core-0014-launch-skills (renumbered 0015/0016); audit log; M5b; bounded listener close | done | see "0.27.0" below |
| 5 desktop: Settings > Mobile | done by Voice UI Engineer, app patch 0020-mobile-settings (was 0018 on `mobile-desktop-ui`) | |
| LAN live check (mDNS, `[::]`) | approved by Nathan, part of QA's final pass | checklist sent to the lead |

**Commits (all local, never pushed).**
- Dev tree `work-core`, branch `aiondx-dev-027` (0.27.0):
  - `74bffa45`: baseline core-0001..0013 + core-0010/0002;
  - `e326bf74`: + upstream core-0014-launch-skills;
  - branch `auth-027` (`6af5f14c`): + core-0015-auth-channel, as exported;
  - HEAD: + core-0016-mobile-bridge.
  The old line (`aiondx-dev`, core-0014/0015 numbering, last build 85f2467c) is kept for reference.
- Exports:
  - core-0015 = `git diff e326bf74 auth-027`;
  - core-0016 = `git diff auth-027 aiondx-dev-027`;
  - core-0010/0002 = the `team_e2e.rs` test only (upstream's core-0010 still lacks it).
- Checked: applying every core patch in order to v0.2.2 (47e66d0d) gives exactly the dev tree (0 diff lines).

### Known gaps

- `Agent.shutdown` has no "approved" state: AionCore reports nothing, so the agent's removal stands for it
  (CONTRACT rev 4.5).
- Team-chat send failures have `messageId: null` (no exact link, as in the contract).
- `Task.assignment` is found only within the owner's newest 200 messages; `unread` looks at the newest 100.
- On a non-English Windows the firewall status reads `absent` (the `netsh` output is localized).
- `respond_now` holds a solo follow-up for at most 30 minutes, in memory: an AionCore restart drops it.
- The bridge's in-memory state (approvals, journal, shutdowns, held messages) restarts empty. The journal epoch changes,
  so phones get `reset: true` and reload, as the contract says.
- The wider workspace tests have 8 upstream failures (Windows/env). The 2 legacy-DB config tests fail only in the
  un-branded dev tree and pass in the branded build tree.

### How to rebuild

1. `cd work-core` and run the tests:
   - `CARGO_TARGET_DIR=%LOCALAPPDATA%\aiondx-build\dev-target`;
   - `~/.cargo/bin/cargo.exe test -p aionui-mobile` (157);
   - `-p aionui-team --test mcp_server_integration` (51).
   Cargo isn't on PATH on purpose.
2. Export the patches with the two `git diff` lines above.
3. `tools\build-aioncore.ps1 -Patched` (from the repo root). Don't tail its log; wait for its exit. The output is
   `vendor\aioncore\aioncore.exe` plus `aioncore.json`, which lists core-0001..0015.
4. Ship with `tools\build-release.ps1 -AionDxCore …`.
5. Live tests only through `tools\live-app.js` with a throwaway profile and a made-up APPDATA.
   `AIONDX_MOBILE_BIND=127.0.0.1` keeps the bridge off the LAN.
6. Merging with voice and the desktop UI: `docs/mobile-bridge/RELEASE-MERGE-NOTE.md`.
