# Mobile review of the Bridge API Contract v1 draft

**Reviewer:** Mobile Engineer. **Reviewed:** `docs/bridge-api-contract-v1-draft.md` (405 lines) against `src/lib/crypto/protocol.ts`, `protocol.host.ts`, `src/lib/api/{secureChannel,pairing,http,remoteApi,hooks}.ts`, `src/lib/storage/keyStore.ts` and the built screens.
**Status:** review only. Nothing is implemented yet.

> **The copy in the repo is incomplete.** §10 ("mapping from remoteApi.ts") says it was "trimmed here for length", and several §6 shapes are only partly specified (tasks, activity items, change-feed entries). The bridge author says the full draft is about 578 lines. Please get the full version. Several questions below (marked **Q**) may already be answered there.

**Overall:** the crypto design is accepted with good amendments, and the facade is the right call. The surface the screens see (`AionDxApi` + hooks) can absorb most of the changes. However, the contract is **not** a drop-in for today's `remoteApi.ts`: most paths and shapes change, and several features are new client work (structured questions, the confirm-key proof, per-PC identities, the change feed). Estimate at the end.

---

## 1. Crypto and wire format vs `protocol.ts`

| Item | Current client | Needed | Size |
|---|---|---|---|
| **`rid` on every InnerRequest (A4)** | `RpcRequest = {method, path, body?}` | Add `rid` (UUID). It must stay the same across the 401 re-handshake retry: `SecureChannel.send()` already re-seals the same request object, so generating `rid` once in `request()` works. For chat sends, **reuse the optimistic `localId` as the `rid`**, so a user "Tap to retry" can't double-send within the 10-minute dedupe window. | S |
| **`confirm` proof (§5)** | none | See §4 below. The proof binds `sid ‖ seq`, so it must be computed **inside `SecureChannel` at seal time**, not by the caller, and recomputed if the 401 retry runs under a new session. | M |
| **A1 authenticated revocation notice** | `403 device_revoked` → `DeviceRevokedError` → "no longer trusts this phone" banner and polling stops. We never auto-wipe. | New `openRevocationNotice(state: HandshakeState, hostId, deviceId, notice)` in `protocol.ts` (k_rev = HKDF(DH(e_c,S_h), …)) and a host-side `hostSealRevocationNotice` in `protocol.host.ts` plus tests. The ephemeral is already kept in `HandshakeState`. Two error types: **`DeviceRevokedError` (verified)**, which may delete the pairing, and **`HostRefusedError` (unverified 403)**, which keeps the pairing and shows "PC refused the connection" with a manual Forget. The banner copy and health classification need splitting to match. | S |
| **A2 offer lock** | `PairStatus = 'pending'\|'approved'\|'rejected'` | Add `'aborted'`. Handle `409 pairing_locked` with "This code was used by another device. Generate a new one on your PC." Check that `reqTs` echoes the latest request's `ts` (track it in `pairWithHost`). | S |
| **`confirmKey` in the approved PairResponse (A7)** | n/a | `openPairResponse` returns it, and pairing stores it under `requireAuthentication` (§4). | S |
| **Pair errors** | Only `pairing_expired` is mapped; everything else is a generic `TransportError` | Map `clock_skew` (show "Your phone's clock is off by …" using `hostTime`), `rate_limited`, `malformed`, `unsupported_version`. | S |
| **Handshake `idleTimeoutMs`** | `HandshakeResponsePayload = {expiresAt}` | Store it. Re-handshake proactively once idle longer than this; the 401 retry already covers it, so this is optional. | XS |
| **A3 epk replay cache / 4-session cap** | Fresh `e_c` every time; concurrent handshakes are coalesced | No change. | — |
| **Duplicate-envelope cache (§4.5)** | `postJson` fails over to the next URL with the **same** envelope | Matches the design. No change. | — |
| **Long-poll timeout** | `postJson` default timeout is **8 s** | `SecureChannel.request()` needs a per-request timeout; `/v1/changes?wait=25` needs ≥35 s. | XS |
| **Reference host + test bridge** | `protocol.host.ts`, `e2e/bridge.ts` | Update both for A1/A2/rid/confirm so the e2e harness keeps exercising the real wire format. | S |

**Q1 (rate limit contradicts the pairing poll).** §4.2 says the phone re-sends `pair` every **2 s** (30/min), and our design spec says **1 s**. A8 caps `pair` at **10/min per IP**, so a normal pairing gets `429`. Proposal: client polls every 2 s, and the bridge allows ≥40/min on `pair` while an offer is active. Or the bridge long-polls `pair` (`wait`) so the phone sends about one request per 20 s.

**Q2.** Does the authenticated notice (A1) also come back for a `deviceId` the host never knew (e.g. host DB restored from backup)? The draft says "unknown or revoked". Confirm, because then a verified notice means "this pairing is gone" and the phone can delete it safely.

---

## 2. §6 facade vs `remoteApi.ts` and the screens

Everything below changes only `remoteApi.ts` (paths plus wire→`types.ts` mapping) **unless marked UI**.

### 2.1 Teams and run state
- **Paths:** `/api/teams` → `/v1/teams`; `…/run-state` → `/v1/teams/{t}/run-state`.
- **Field mapping:** `name` → `teamName`; `agents[]` → `slots[]`; `queue.foreground` → `queuedMessages`; `turn.startedAt` → `turnStartedAt`. Team `pendingApprovals` becomes the sum of the per-agent values. `serverTime` comes from `GET /v1/host`; there's no `teamName` in run-state, so join it from `/v1/teams`.
- **Status mapping:** `state` + `blockedReason` + `attention` → our `SlotStatus` + `BlockedReason`.
  - **Q3.** Please publish the full enums: `state` (we render working / idle / blocked / starting / stopping / error / offline), `runtime`, `blockedReason` (string values?) and `shutdown` (shape when requested / rejected + reason).
  - Today the "declined to shut down" card parses the `shutdown_rejected:` message text. Using `agent.shutdown` would be better.
- **`needs_approval`:** run-state has no prompt id, tool or args preview. The dashboard's "Waiting for approval: Bash / `npx …`" line and its Review button need them, so the client joins against `/v1/approvals?teamId=` by `slotId`. Fine, just confirm that's the intended join.
- **Gap: `currentTaskId`** is missing. The dashboard card shows the agent's current task subject. We can derive it (the owner's `in_progress` task) unless the bridge adds the field. **Q4:** add it?
- **UI — new attention states:**
  - `needs_answer` currently maps to "Asked you a question → Reply (opens chat)". With structured questions it should open a **question answer sheet** (§2.3).
  - `your_turn` (lead and solo only) is new. It needs a design decision; suggested: a quiet "Your turn" badge, not a Needs-you card.

### 2.2 Conversations and messages
- **Ids:** our ids are `t.<slot>` / `all` / `s.<id>`. Contract: each team member's `conversationId` comes from the roster, and solo chats use their own ids. The parse/route layer in `client.ts` changes; routes can keep our ids and resolve to a `conversationId`.
- **Gap: list previews.** The chat list shows each teammate's last message and time. `Conversation` has no `lastMessage`.
  - **Q5:** add `lastMessage {text, role, createdAt}` to `Conversation` and to the roster agent. Otherwise the phone has to fetch messages for every agent, which defeats the facade.
- **Gap: broadcast history.** `POST /v1/teams/{t}/broadcast` exists, but nothing lists past broadcasts, and our "Everyone" thread shows them.
  - **Q6:** add `GET` for broadcast history, or we keep only locally-sent broadcasts (they're lost on reinstall).
- **Sync:**
  - `useThread` passes the last message id as `since`. It must store the opaque `cursor` from each response instead.
  - On `reset`, replace the local list.
  - While `hasMore`, keep fetching.
  - `mergeMessages` already upserts by `messageId`, which fits rows that update in place.
- **Older history:** `before=` paging makes the deferred "load older messages" possible. **UI:** add it to the thread.
- **Message shape (UI):**
  - `role` + `type` replaces `fromSlot` / `type` / `content`.
  - `thinking`, `tool_call`, `plan`, `tips` and `agent_status` need a rendering decision. Suggested: hide `thinking`; show `tool_call` as a compact system row.
  - `status: streaming` means a bubble whose text grows.
  - There's no `files[]`, so file chips disappear; acceptable for v1.
  - **Q7:** how are system notices like "📋 Task assigned (#id)" represented? `role: 'system'`, `type: 'text'`?
- **Send:** the response is `{messageId, delivery}`, not a full message. The hook builds the confirmed row from the optimistic one plus the returned `messageId`. `priority: "now"` is a new option; it fits the agent screen's "Stop & send instruction" better than stop+send.
- **Read markers:** `POST /v1/conversations/{cid}/read` is new. Call it when a thread is visible (debounced). Today the mock marks messages read implicitly.

### 2.3 Approvals
- **Paths:** per-team `…/permission-prompts` → `GET /v1/approvals?teamId=` and `POST /v1/approvals/{id}/answer`.
- **Decision enum:** `{decision: allow_once|allow_always|deny, optionId?}` **matches what we already send** (`promptDecisionBody()`, which never sends a bare string; covered by a test).
- **Field mapping:** `approvalId` → `promptId`; `agentName` / `slotId` stay; `description` / `action` / `commandType` replace `tool` / `args` / `cwd` / `reason`.
  - **Q8:** which field holds the exact command or args to show in full before Allow? (Our sheet shows the whole command, wrapped, on purpose.)
- **Gap: the "Always allow" rule text.** The sheet shows "Creates rule: Bash(npx expo install:*)" because users must see exactly what they're allowing permanently.
  - **Q9:** does the `allow_always` option's `label` carry the exact rule or scope? If not, please add `rule` to that option.
- **`reject_always` and `other` options vs the 3-value `decision` enum.**
  - **Q10:** is `optionId` the way to pick `reject_always` or `other`? If so, the sheet should render the options list rather than our fixed buttons. `422 ambiguous_decision` with `options` also implies an option picker.
- **UI — new: `kind: 'question'`** (structured AskUserQuestion: questions, options, multiSelect, decline).
  - We have no UI for this. It needs a design (App Designer) plus a sheet. This is the largest new screen in the contract.
- **Answer errors:** `409 already_resolved` should show "Already handled on PC". Today that's inferred from the item disappearing from the list.
- **Solo-conversation approvals** come back from the same endpoint (no `teamId`). The app currently surfaces approvals per team.
  - **Q11 / design:** where do solo approvals appear (a global count in the Approvals inbox)?

### 2.4 Agent controls
- **Changed paths:**
  - `…/interrupt {message}` → `/v1/teams/{t}/agents/{slot}/stop {replacementMessage}`.
  - `wake` is unchanged.
  - Shutdown is now `/shutdown {reason?}` and is **sensitive**.
  - Spawn → `POST …/agents {assistantId, name?, model?}`, also **sensitive**.
- **UI:** for the lead, `stop` with a replacement message returns `422 lead_not_allowed`. Hide "Stop & send instruction…" for the lead.
- **UI — now possible (previously hidden per SPEC §12):** rename (`PATCH`), clear context, and force-remove (`DELETE`, refuses the lead). Each needs a design decision to re-enable.
- **Assistants:** `GET /v1/assistants` has no `skills` or `exampleTasks`. The spawn detail screen hides those sections when they're empty (small UI change).

### 2.5 Tasks, activity, host
- **Q12: the Task shape isn't specified** (`id`, `subject`, `description`, `status`, `owner`, `blockedBy`, `blocks`?), and neither are the `activity` item shape or the `changes` entries (ids? objects?).
- **Task writes ship behind the `tasks.write` capability.**
  - **UI:** read `capabilities` from `GET /v1/host` and, when it's absent, hide: New task, the create/edit modal, swipe actions, status/owner/blocker edits, "Start task" / "Mark done", and "Create task from message".
  - Task detail becomes read-only. This gating doesn't exist yet.
  - Deleting a task is **sensitive**.
- **`GET /v1/host`** (new call per session): `serverTime`, `capabilities`, `device.requireConfirm`. Settings shows `requireConfirm` (§4).
- **`DELETE /v1/host/device`:** "Unpair" on the phone should call this first (best effort), then delete the local keys.
- **Task → originating message:** `activity?aroundTask=` is a best-effort proxy. Fine for v2. Our task notices already carry `(#taskId)`, which covers chat → task.

---

## 3. Change feed (`GET /v1/changes?since=&wait=`)

**Recommendation: switch, as a small-to-medium rework** (about a day). Screens and query keys stay as they are; only the cadence changes.
- **A single `useChangeFeed()` loop** at the app root, while foregrounded and paired:
  - It long-polls `/v1/changes?wait=25` with a 35 s timeout.
  - On each response it **invalidates only the listed resources**: `teams` → teams + that team's run-state; `conversations` → those threads + list previews; `approvals: true` → approvals; `tasks` → task lists; `roster` → run-state.
  - `reset: true` → invalidate everything.
- **Per-screen `refetchInterval`** drops to a slow safety net (e.g. 60 s), or to 0 while the feed is healthy. Backoff and health tracking move to the feed loop.
- **Freshness indicator semantics change.** With a feed, `dataUpdatedAt` only moves when something changes, so "Updated 40s ago" would look stale while the line is actually live. Show "Live" or "Updated just now" based on the **last successful feed round-trip** (`health.lastSuccessAt`), not query data age.
- **Backgrounding:** abort the in-flight long-poll on `AppState` background and resume with the last token in foreground. Store the token per host in memory.
- **Q13:** what does each entry in the changes response contain? Ids only? Per-conversation `cursor` hints? Without ids, the phone has to refetch every team, conversation and task list on any change.
- **Fallback:** if `changes.longpoll` is missing from `capabilities`, keep today's polling.

---

## 4. `confirmKey` biometric HMAC (§5) **[PENDING SIGN-OFF]**: what's new

- **Key storage.** `expo-secure-store` with `requireAuthentication: true` for `confirmKey`, one per PC.
  - iOS: every **read** prompts for Face ID or Touch ID.
  - Not supported in Expo Go when biometrics are available, so this needs a **development build**.
- **Canonical JSON (RFC 8785).** We have no JCS. Because sensitive bodies are restricted to strings, booleans and small integers, a recursive sorted-keys `JSON.stringify` is exactly JCS (ES string escaping matches). It's about 30 lines. **Ask the bridge for shared test vectors** (body → JCS bytes → proof) so both sides are checked against the same data.
- **HMAC-SHA256.** `@noble/hashes/hmac` is already installed. No new dependency.
- **`SecureChannel` API change.**
  - Callers pass `sensitive: true`.
  - The channel reads `confirmKey` (biometric prompt) **once per logical request** and keeps it in memory only for that request, including a possible 401 re-handshake retry, which needs a new proof for the new `sid`/`seq`. It's never cached beyond that.
  - New errors: `428 confirm_required` and `403 confirm_invalid`.
- **UI.**
  - Biometrics prompt for: Allow / Always allow, spawn, polite shutdown, force-remove, clear context, delete task. **Remove today's separate client-side `confirmApprovalAuth`** so approvals don't prompt twice.
  - Our local "Require Face ID to approve" toggle becomes misleading, because the bridge decides. It should reflect the PC's `device.requireConfirm` (read-only on the phone, changed on the PC).
  - "No lock" no longer disables it.
- **Invalidation (iOS too, not just Android).** The draft only mentions Android's enrollment invalidation. iOS `requireAuthentication` maps to `biometryCurrentSet`, which is **also** invalidated when Face ID or Touch ID enrollment changes.
  - Both platforms need the "re-confirm this phone on your PC" flow: a new screen, plus scanning a re-confirm QR (**Q14:** QR format / endpoint for "Issue new confirm key").
- **Phones with only a passcode** (no biometrics enrolled).
  - `biometryCurrentSet` can't be created without enrolled biometrics, so these phones **couldn't perform any sensitive action**.
  - **Q15:** is that intended? The alternative is a device-passcode access control, which `expo-secure-store` doesn't expose; it would mean a native module.
- **Branch if not signed off:** keep the current client-side biometric check. The `confirm` field is simply omitted, and the device on the PC uses `requireConfirm = false`.

---

## 5. Multi-PC: one identity per PC (A5, §3.2)

**Doesn't match today; needs a small rework (about half a day).**

What we do now:
- `keyStore.ts` stores **one** identity (`aiondx.device.v1`) shared by all PCs.
- `connectionStore.identity` holds it, and pairing and `getApi()` use it.

What's needed:
- `keyStore`: `loadDeviceIdentity(hostId)` / `createDeviceIdentity(hostId)`, keyed by a slug of `hostId`. That's the same pattern as the encrypted-cache keys, and fits well under SecureStore's ~2 KB value limit.
- Pairing: create a **fresh identity per offer** (keyed by `offer.hostId`). Discard it if pairing is aborted or rejected; re-pairing the same PC creates a new one.
- `getApi(hostId)` builds `SecureChannel` with that host's identity. `forgetHost` deletes it, which is the cryptographic "forget".
- The Security screen fingerprint becomes per PC. Show the active PC's fingerprint.
- No migration is needed: there are no production installs. Demo mode has no identity.

---

## 6. Platform and config items (client side)

- **Android cleartext:** needs a network security config. Use `expo-build-properties` (`usesCleartextTraffic`) or a small config plugin. Not done yet.
- **iOS ATS:** `NSAllowsLocalNetworking` should cover LAN IPs. **Tailscale MagicDNS hostnames (`*.ts.net`) and possibly 100.64/10 IPs** are less clear; they may need an ATS exception domain. Verify on a device before relying on `extraUrls`.
- **mDNS re-discovery:** needs a native zeroconf module, which means a dev build. Until then the phone relies on the stored URLs plus `GET /hello`.
- **Default port 47734:** no client impact; the QR carries the URLs.

---

## 7. Questions for the bridge team (consolidated)

1. **Q1:** `pair` rate limit (10/min) vs the 2 s re-send. Raise the limit during an active offer, or long-poll `pair`.
2. **Q2:** a verified revocation notice for unknown device ids, so the phone can safely delete the pairing.
3. **Q3:** full enums for `state`, `runtime`, `blockedReason`, `shutdown`.
4. **Q4:** add `currentTaskId` to agents?
5. **Q5:** `lastMessage` on `Conversation` / roster agents for list previews.
6. **Q6:** broadcast history `GET`.
7. **Q7:** how system notices (task assignments) appear in `Message`.
8. **Q8:** the field that carries the full command / args for an approval.
9. **Q9:** exact rule / scope text on the `allow_always` option.
10. **Q10:** picking `reject_always` / `other` via `optionId`; option-list semantics.
11. **Q11:** solo-conversation approvals: confirm they're in `/v1/approvals` without `teamId`.
12. **Q12:** Task, activity-item and changes-entry shapes.
13. **Q13:** change-feed entry contents (ids, cursor hints).
14. **Q14:** re-confirm-key flow: QR format and endpoint.
15. **Q15:** passcode-only phones under `requireAuthentication`.
16. Shared **test vectors** for k_pair / SAS, the session keys, k_rev and the confirm proof (including JCS bytes), so both implementations are checked against identical data.
17. The full ~578-line draft, including §10.

---

## 8. Rough client rework once the contract is final

| Area | Work | Estimate |
|---|---|---|
| Protocol / transport | `rid`, A1 notice + split revoked errors, A2 aborted / locked / `reqTs`, pair error mapping, per-request timeout, `idleTimeoutMs`. Update the reference host + e2e bridge and add tests. | 1–1.5 d |
| Per-PC identity | keyStore / connectionStore / pairing / security screen | 0.5 d |
| Facade mapping | `remoteApi.ts` + `types.ts` mappers: run-state, approvals, conversations / sync cursor / send / read, tasks, assistants, host, capabilities | 1.5–2 d |
| UI additions | question-approval sheet (**needs design**), option-based approval picker, thinking/tool_call rendering, streaming bubbles, load older, `tasks.write` gating, lead "Stop & send" hidden, solo-approval surfacing; re-enable rename / clear-context / force-remove once designed | 2–3 d |
| Change feed | Root long-poll loop + targeted invalidation + freshness semantics + background handling | ~1 d |
| Confirm proof (if signed off) | JCS + HMAC + `SecureChannel` sensitive path + key storage + re-confirm flow + error UX | 1.5–2 d (+ device testing) |
| Config | Android cleartext, iOS ATS check, optional mDNS (dev build) | 0.25–1 d |
| **Total** | | **≈ 8–11 dev days**, plus a development build for the biometric and device checks |

The app logic (stores, cache, lock, navigation, most screens) stays as is. As intended, the churn is concentrated in the API layer, but the contract also adds real product surface (structured questions, option-based approvals, streaming / tool rows, capability gating) that needs a little design input.

### Where the code branches on pending sign-offs
- **Facade vs passthrough:** the client tunnels `{method, path}` either way. Facade → this review applies. Passthrough → we'd map to raw AionCore routes instead. We strongly prefer the facade, for the security reasons in A9.
- **Bridge-enforced confirm:** yes → §4 work. No → keep the client-side biometric gate; omit `confirm`.
- **Task writes:** off → capability gating (needed regardless). On → today's task UI works as built.
- **LAN-only:** no client change. Tailscale `extraUrls` needs the ATS check (§6).

---

## Addendum: §10 mapping table (received later)

Checked against this review. No surprises. Every row matches what §2 already assumed:
- `listTeams` → `/v1/teams`
- `resolvePrompt` → `/v1/approvals/{id}/answer`
- conversations come from the roster `conversationId`s plus solo chats
- opaque `since` cursor and `before=` paging
- agent controls map one-to-one
- force-remove covers the "refused" gap

Small notes:
- **Request body keys change as well as paths:** `sendMessage {message}` becomes `{content}`, and `stopTurn {message}` becomes `{replacementMessage}`. Both are mapped in `remoteApi.ts`.
- **Some rows don't exist in the table, so they're new calls, not renames:** `GET /v1/host` (capabilities, `requireConfirm`, `serverTime`), `POST …/read`, and `GET /v1/changes`.
- The table confirms there is still no team-conversation list with previews (**Q5**) and no broadcast history `GET` (**Q6**).
- **Q12/Q13** (shapes for tasks, activity items and change-feed entries) are still open.


---

# Rev 2 readiness (contract rev 2, 760 lines, reviewed 2026-11-07)

**Verdict.** Rev 2 answers almost everything rev 1 left open. We can implement against it as written. The few items still missing are small; the main one is deny-with-message, listed in (a). Nothing is implemented yet: 9 items in §11 still need Nathan's sign-off (see (c)).

## 1. Status of the rev-1 questions

| Q | Topic | Status | Where in rev 2 |
|---|---|---|---|
| Q1 | `pair` rate limit vs re-send | **Resolved.** Pairing now long-polls (`wait`), about 3 requests a minute, under the 10/min limit. | §4.2, A8 |
| Q2 | Verified notice for unknown devices | **Resolved.** The notice is sent for any untrusted `deviceId`, with `reason: revoked\|unknown`. Both mean it's safe to delete the pairing. | §4.3, A1 |
| Q3 | Status enums | **Resolved.** Full lists for `state`, `blockedReason`, `runtime` and `shutdown`, plus `sessionStatus` and `activeRun`. | §6.3 |
| Q4 | Current task | **Resolved.** `Agent.currentTask {taskId, subject}` and `openTaskCount`. | §6.3 |
| Q5 | List previews | **Resolved.** `LastMessage` on `Agent` and `Conversation`. | §6.3, §6.4 |
| Q6 | Broadcast history | **Resolved.** `GET /v1/teams/{t}/broadcasts` (only broadcasts sent through the bridge). | §6.4 |
| Q7 | System notices | **Resolved.** `role` / `sender` mapping, plus `notice: task_assigned \| context_reset`. | §6.4 |
| Q8 | Full command field | **Resolved.** `input` (full) and `inputSummary`. With `input: null` the phone must not offer Allow. | §6.5 |
| Q9 | Always-allow rule text | **Answered as "not available".** `rule` is always null today; `alwaysScope` says what "always" means. UI impact, see §5 below. | §6.5 |
| Q10 | `reject_always` / `other` | **Resolved.** Answer with `{optionId}`, render an option list, and `422` returns the options. | §6.5 |
| Q11 | Solo approvals | **Resolved.** `GET /v1/approvals` without `teamId` is the only route to them. | §6.5 |
| Q12 | Task / activity / change shapes | **Resolved.** | §6.7, §6.8, §6.2 |
| Q13 | Change-feed entries | **Resolved.** Typed entries; approvals and tasks inline; `more` / `reset` flags. | §6.2 |
| Q14 | Re-key flow | **Resolved.** `aiondx://rekey` QR plus `POST /v1/host/device/confirm-key`, proof bound to `sid`. | §5.3, §6.1 |
| Q15 | Passcode-only phones | **Resolved, pending sign-off #8.** `confirmMode` is `biometric`, `device_passcode` (enforced by the app) or `none`. | §5.2 |
| Q16 | Shared test vectors | **Partial.** Appendix A describes `vectors.json`, but the file **isn't in our repo**. Request it before starting. | App. A |
| Q17 | Full draft | **Resolved.** Rev 2 is the complete document. | — |

## 2. Schemas vs our client types

`types.ts` stays the UI model. Everything below is a wire→UI mapper in `remoteApi.ts` unless it says **types** (our UI types change) or **UI** (screens change).

**ChangesResponse / ChangeEntry (§6.2).** These are new; we have nothing like them today. Every variant fits the client. Gaps:
- **types:** the entries are keyed by the real `conversationId`, but our routes and query keys use `t.<slotId>` / `all` / `s.<id>`. Switch routes to `conversationId`, with `all` kept for the broadcast thread. Otherwise the client has to maintain a slot→conversation map from the roster to apply entries.
- **hooks:** a `broadcast` entry carries only an id, so we refetch the broadcast list. `approval_added` and `task` entries carry the full object, so they go straight into the cache.

**RunState / Agent / Attention / LastMessage (§6.3).**
- **types `RunState`:**
  - Add `sessionStatus` and `activeRun`.
  - `teamName` comes from `TeamSummary.name`; `serverTime` comes from `GET /v1/host`.
  - Team `pendingApprovals` becomes the sum across agents.
- **types `Slot` ← `Agent`:**
  - Add `conversationId`, `backend`, `icon`, `unread`, `attention`, `waitingOnUser`, `lastMessage`, `lastActivityAt`, `openTaskCount`, `turn.slow`, and `shutdown` (replaces our text parsing of `shutdown_rejected:`).
  - Change `currentTaskId` to `currentTask {taskId, subject}`, so the dashboard no longer has to join tasks for the subject line.
  - `queuedMessages` comes from `queue.foreground`.
  - Drop `assistantId`: it isn't on the wire, and only spawn uses assistant ids, which come from `/v1/assistants`.
- **Status derivation**, from `state`, `blockedReason`, `runtime`, `attention` and `shutdown` → our display status. Proposed:

  | Wire signal | Our display status |
  |---|---|
  | `needs_approval` | blocked / permission_prompt. The tool and args come from joining `/v1/approvals` by `slotId`. |
  | `needs_answer` | blocked / question |
  | `error` | error |
  | `running` | working |
  | `starting`, or `runtime_starting` | starting |
  | `shutdown.requested` or `removing` | stopping |
  | `session_stopped` | offline |
  | `idle` / `queued` / `dormant` | idle |

- **Unrepresentable today (UI, needs design):**
  - `state: 'paused'` has no display status.
  - `queued` (messages waiting, nothing running) maps onto "idle with queue", which already shows "Wake agent".
  - `your_turn` is a new attention value (lead and solo only).
  - `sessionStatus: stopped/failed` needs a team-level banner.
- **No longer produced:** our `blocked_by_task` and `waiting_for_teammate` reasons. The **"Waiting" dashboard section would never fill.** We could derive "waiting on task" on the client from `currentTask` plus unfinished `blockedBy`, or drop the section. Design decision.
- **types `TeamSummary`:** add `attention`, `waitingOnUser`, `unread`, `leadSlotId`, `agentCount`, `workspace` and `updatedAt`. The team picker could then show badges.

**Conversation / Message / Broadcast (§6.4).**
- **types `ConversationSummary`:**
  - Rebuild it: team rows come from the run-state `agents[]` (`lastMessage`, `unread`, `attention`); solo rows come from `GET /v1/conversations?kind=solo` (paged).
  - `lastMessage` becomes `{text, role, senderName, createdAt}`, replacing `{content, fromSlot}`.
  - Add `state`, `attention`, `waitingOnUser`, `workspace` and `backend`.
- **types `TeamMessage` → `Message`:**
  - Add `role`, `sender`, `type` (7 values), `status` (streaming / done / error / pending), `tool`, `notice`, `turnId` and `conversationId`. `text` becomes optional (tool rows have none).
  - Drop `toSlot` and `files`. The file chips go; attachments are out of scope.
  - Keep the local `localState` for unsent messages separate from the server `status`.
- **UI, messages:**
  - `thinking` hidden (or collapsed).
  - `tool_call` shown as a compact system row ("Used Bash").
  - `streaming` rendered as a bubble whose text grows.
  - `teammate` rows get the sender's name and avatar.
  - The task card's link uses `notice.taskId`; the regex we use today stays only as a fallback.
- **types `Broadcast`:** new. The "Everyone" thread renders broadcasts as our own bubbles, with per-agent delivery state. A `failed` delivery needs a visible marker (**UI**).
- **Send:** returns `{messageId, delivery}`, so the hook confirms the optimistic row using `messageId`. **UI:** a `delivery` of `queued` or `queued_first` could show "Queued", and `priority: "now"` could back "Stop & send instruction" without stopping the agent.

**Approval / ApprovalOption (§6.5).**
- **types `PermissionPrompt` → `Approval`:**
  - `approvalId` replaces `promptId`.
  - Add `kind`, `conversationId`, `teamId?`, `agentName`, `title`, `commandType`, `toolName`, `inputSummary`, `options[]` and `questions[]`.
  - `input` replaces `args` and may be null.
  - `firstSeenAt` replaces `createdAt`.
  - `slotId` becomes optional (solo approvals have none).
- **Drop:**
  - `cwd`: not on the wire, so the sheet loses its "Working dir" line.
  - `alwaysAllowRule`: replaced by `options[].rule` (always null today) and `alwaysScope`.
  - `reason`: comes from `input.description` when the tool sends one; `description` is often `""`.
- **types `PromptDecision`:** becomes `{optionId} | {decision}` for permissions, and `{answers} | {decline: true}` for questions.
- **Unrepresentable:** our "Deny with message…" has **no field in the answer body**. See question (a)1.

**Task (§6.7).**
- **types:**
  - `id` becomes `taskId`.
  - Add `teamId`, `ownerName`, `assignment`, `createdAt` and `updatedAt`. `description` may be null.
  - `owner` may be `"user"`. Today our task-list owner filter "Me" means "unassigned"; it should mean `owner === "user"`, with a separate "Unassigned" filter.
- **`TaskInput.notifyOwner`** isn't in the `POST` body; see (a)3.

**Activity (§6.8).** **types `ActivityItem {at, text}`:** the mapper builds the text from the union. Message entries become, for example, "Sent message to Claude Code" or "Shutdown rejected"; task entries become "Task updated: …". No gaps.

**Host / assistants / controls.**
- New `HostInfo` type: `capabilities`, `device.requireConfirm` and `device.confirmMode`.
- `Assistant` loses `skills` and `exampleTasks` and gains `backend` and `icon`. The spawn detail screen already hides the empty sections.
- Spawn returns an `Agent`. `stop` returns an `outcome`: show a toast for `no_active_turn`.

## 3. Protocol deltas vs `protocol.ts` / `secureChannel.ts` / `pairing.ts`

| Delta | Today | Change needed |
|---|---|---|
| **Pair long-poll** | Re-send every 1 s with an 8 s timeout | `PairRequestPayload` gains `wait` (first request false, then true) and `confirmMode`. Re-send immediately after each answer with a fresh `ts`. Per-request timeout ≥ 25 s. Keep the 2-min UI deadline from SPEC P3. |
| **`reqTs` echo** | not checked | Track the last request's `ts`; ignore or retry a response whose `reqTs` doesn't match. |
| **`aborted` / `409 pairing_locked`** | `PairStatus` lacks `aborted` | Add it. Copy: "This code was used by another device. Generate a new one on your PC." Map `clock_skew` (`hostTime`), `rate_limited`, `malformed` and `unsupported_version`. |
| **`confirmMode` / `confirmKey`** | none | Choose `confirmMode` from `getEnrolledLevelAsync()`: biometric → `biometric`, passcode → `device_passcode`, none → `none`. Store `confirmKey` per PC as §5.2 describes. `openPairResponse` returns it. |
| **`idleTimeoutMs`** | `HandshakeResponsePayload = {expiresAt}` | Add the field. Optionally re-handshake proactively after idling; the 401 retry already covers it. |
| **`rid`** | none | Add it to `RpcRequest`. Generate once per logical request in `SecureChannel.request()`; the 401 retry re-seals the same object, so `rid` survives. For chat sends use the optimistic `localId`, so a manual retry also dedupes. |
| **35 s `/v1/changes`** | fixed 8 s in `postJson` | Add a per-request `timeoutMs` to `SecureChannel.request()`. |
| **A1 revocation notice** | Plain-text 403 → `DeviceRevokedError` | New `openRevocationNotice(state: HandshakeState, hostId, deviceId, notice)`: k_rev from `DH(e_c, S_h)`; check `deviceId` and that `ts` is fresh. Verified → `DeviceRevokedError` (reason revoked or unknown), and deleting the pairing is allowed. Unverified 403 → new `HostRefusedError`: "PC refused the connection", keep the pairing, offer a manual Forget. Add the host-side seal to `protocol.host.ts`, plus tests. |
| **`409 unknown_host`** | → generic `TransportError` | New `HostResetError`: "This PC was reset; pair again". Don't delete the pairing. Add a new health state and banner copy; stop polling as we do for revoked. |
| **Per-PC identity (A5)** | One identity, `aiondx.device.v1` | Unchanged from the rev-1 review §5: identities keyed by `hostId`, a fresh one per pairing attempt, deleted on Forget. |
| **Confirm HMAC + JCS (§5)** | none | `jcs()` (sorted keys, no whitespace; no floats on the wire) and `confirmProof(key, sid, seq, method, path, body, rid)` using `@noble/hashes/hmac`. The proof binds `sid`/`seq`, so `SecureChannel` needs a "sensitive" mode: read the key once per logical request and recompute the proof if the 401 retry runs under a new session. Handle `428 confirm_required` and `403 confirm_invalid`. |
| **Re-key (§5.3)** | none | Parse `aiondx://rekey` in the scanner, with a local check that `hostId` and `deviceId` match one of our pairings. `rekeyProof = HMAC(rekeySecret, "aiondx/v1/rekey" ‖ sid ‖ deviceId)` also binds `sid`, so it goes through the same seal-time hook. Store the new key under the new `confirmMode`. |

## 4. Appendix A conventions vs `primitives.ts`

| Convention | Ours | OK? |
|---|---|---|
| `ct = ciphertext ‖ 16-byte tag` | `xchacha20poly1305.encrypt` output (noble appends the tag) | ✅ |
| Empty HKDF salt is zero-length | `shortAuthString` passes `new Uint8Array(0)`. Under HMAC, a zero-length key and an all-zero key give the same result, so this matches either reading. | ✅ |
| Sealed plaintext is the exact UTF-8 of the vector string | `sealJson` uses `JSON.stringify`. Fine on the wire, since the receiver parses JSON. **For vector tests** we need a test-only `sealWithNonce(key, nonce, bytes, aad)`, because `seal()` picks a random nonce. Opening vector ciphertexts works today. | ⚠️ test helper |
| SAS = first 4 HKDF bytes, big-endian uint32 mod 10^6, zero-padded, `ddd ddd` | `DataView.getUint32` (big-endian by default) `% 1_000_000`, `padStart(6)`, then the space | ✅ |
| Byte encoding of `deviceId`, `method`, `path` and `rid` inside the HMAC inputs | Assumed UTF-8 strings; `sid` as its raw 16 bytes | ⚠️ the vectors will settle it |

**Do we need `vectors.json`? Yes.** One jest suite should run every block (`pairing`, `handshake`, `rpc`, `revocation`, `confirm`, `rekey`) against it before any of this ships. It's the only way to show the Rust bridge and our TypeScript agree byte for byte.

## 5. UI impact

- **Option-list approval picker (§6.5, Q10).** Replace the fixed Allow once / Always / Deny buttons with one button per `options[]` entry (label + kind styling: allow = primary, reject = danger outline), and answer with `optionId`. The inbox's quick actions can keep `decision` and open the same picker on `422`. Footer pinning (SPEC §13.2) still applies. About 0.5 d.
- **"Allow Always" on Claude agents (`alwaysScope: same_as_once`, sign-off #9).** Hide it or relabel it "Allow (this agent will ask again)". `backend_defined` → "Always allow (scope decided by <agent>)". The "Creates rule:" caption appears only when `rule` is non-null, which is never, today.
- **`input: null`.** Show "Open on your PC to see the full command". Hide every allow-type option and keep Deny.
- **Attention badges.**
  - `needs_answer` opens the new **question sheet**, not chat. It needs design: questions with single or multi-select options, plus Decline.
  - `your_turn` gets a quiet badge on the lead or solo row.
  - Team rows in the picker get `attention` / `unread` badges.
  - Also: `paused`, `sessionStatus` banners, and the Waiting section decision (§2).
- **`tasks.write` gating.** When the capability is missing, hide: New task, the edit modal, swipe actions, status/owner/blocker edits, Start / Mark done, and "Create task from message". Task detail becomes read-only. Deleting stays behind the ⋯ menu and is a sensitive action.
- **Re-key QR flow.** New paths:
  - **Scanner:** recognizes `aiondx://rekey`.
  - **Agent detail / Settings:** "Re-confirm this phone" state when reading the key throws (enrollment changed).
  - **Sensitive actions:** stay disabled until re-keyed.
- **Controls:**
  - Hide **Shut down** for the lead. We offer it today in the agent menu and the long-press sheet, and rev 2 returns `422 lead_not_allowed`.
  - Hide "Stop & send instruction" for the lead.
  - Rename, clear context and force-remove can come back once design approves. Force-remove fits the "declined to shut down" card as the only alternative to "Keep running".
- **Solo chats:** "New" can return, using `POST /v1/conversations` with an assistant/backend picker and a workspace picker from `GET /v1/workspaces`. Needs design.

## (a) Remaining questions for the bridge team

1. **Deny with a message.** The answer body has no `message` / `reason` field, but our sheet has "Deny with message…", and SPEC §4.7 relies on it. Add `message?` to the deny/reject forms (`{decision:"deny", message}` and `{optionId, message}`)? Otherwise we drop the feature, or send the reason as a separate chat message after the deny.
2. **Byte encoding inside the HMAC inputs** for `deviceId` (rekey), `method`, `path` and `rid`: confirm they're UTF-8 strings and `sid` is the raw 16 bytes. `vectors.json` would settle this.
3. **Task create and the owner's notice.** Does `POST /v1/teams/{t}/tasks` with `owner` post the "📋 Task assigned" notice automatically? Our create form has a "Notify owner" checkbox that would then go away.
4. **Clearing a task's owner.** Does `PATCH … {owner: null}` unassign it? (Our client already sends `null`, not `undefined`.)
5. **Question approvals with free text.** Claude's AskUserQuestion allows an "Other" free-text answer. Can `answers[].labels` carry text that isn't one of the option labels, or are only option labels accepted?
6. **`sessionStatus: stopped/none`.** Can the phone start or resume a team session (is there a route?), or is the right UI "start the team on your PC"? What does `503 team_session_stopped` mean for a chat send?
7. **Freshness of the revocation notice `ts`.** Same ±2 min window as the handshake?
8. **`Message.status: 'pending'` and `'error'`.** What should the phone show (send not yet accepted vs a failed agent turn)? Is the `error` text included anywhere?
9. **`vectors.json` and `gen-vectors.js`.** Please send both. Both blocks need them: protocol and confirm.

## (b) Client work items (rough sizing, after sign-off)

| # | Item | Size |
|---|---|---|
| B1 | Pairing: long-poll + `wait` / `confirmMode` / `reqTs`; `aborted` / locked; pair error mapping | 0.5 d |
| B2 | Handshake and errors: A1 notice verify + `HostRefusedError`; `409 unknown_host` → `HostResetError` + health states; `idleTimeoutMs` | 0.5 d |
| B3 | Transport: `rid`, per-request timeout, seal-time hook for sid-bound proofs | 0.25 d |
| B4 | Reference host + e2e bridge updated to rev 2; `vectors.json` jest suite + `sealWithNonce` helper | 0.75 d |
| B5 | Per-PC identity (keyStore / connectionStore / pairing / Security screen) | 0.5 d |
| B6 | Types + `remoteApi.ts` mappers: run-state/Agent status derivation, teams, conversations, `Message`, `Broadcast`, `Approval`, `Task`, `Activity`, host, assistants | 2 d |
| B7 | Hooks: per-conversation sync cursor, reset / hasMore, `before` paging, read markers, routes on `conversationId` | 1 d |
| B8 | Change-feed loop (`/v1/changes`, inline apply + targeted invalidation, freshness from the last round trip, background abort) | 1 d |
| B9 | Approvals UI: option picker + 422, `alwaysScope` labels, `input:null`, solo approvals in the inbox | 0.75 d |
| B10 | Question-approval sheet | 1 d + design |
| B11 | Thread UI: message types, streaming, teammate senders, notices, broadcasts with delivery state, load older | 1.25 d |
| B12 | Status UI: paused / queued / session banners, `your_turn`, team badges, Waiting-section decision | 0.5 d + design |
| B13 | Controls: hide shutdown and "Stop & send" for the lead; `stop` outcome toast; rename / clear context / force-remove when designed | 0.5 d |
| B14 | `tasks.write` capability gating; owner `"user"` semantics | 0.5 d |
| B15 | Solo "New chat" (assistant + workspace pickers) | 0.5 d + design |
| B16 | Config: Android cleartext network config, iOS `NSBonjourServices`, ATS check for Tailscale / MagicDNS | 0.25 d |
| B17 | Confirm scheme: JCS + HMAC proof, `confirmKey` storage per `confirmMode`, device-passcode gate, re-key QR flow, 428 / 403 / invalidation UX; remove the client-side approval gate | 2 d + device testing |
| B18 | mDNS re-discovery (native zeroconf, dev build) | 1 d (optional) |

**Total ≈ 13–15 dev days** (B18 adds 1 d) plus a development build. That's up from the rev-1 estimate of 8–11 d. The extra is surface rev 2 now defines precisely: question approvals, broadcasts, the message types, the re-key flow and the new statuses. The stores, cache, lock, navigation and most screens are unchanged.

## (c) Work blocked on each sign-off item (§11)

| # | Sign-off | Blocks | If not approved |
|---|---|---|---|
| 1 | Facade instead of passthrough | B6–B9, B11–B15 (every path and shape above) | Re-map to raw AionCore routes. We'd lose `changes`, approvals tracking, read markers, broadcasts and `attention`, and the phone becomes an RCE path (A9). Not recommended. |
| 2 | LAN-only, bring-your-own tunnel | Nothing. B16's ATS check matters only if Tailscale URLs are used. | Relay work is out of scope either way. |
| 3 | Bridge-enforced confirm | B17 | Keep the current client-side biometric gate; omit `confirm`; the PC sets `requireConfirm = false`. |
| 4 | Task writes | Enabling task writes. B14's gating is needed regardless. | Tasks ship read-only. |
| 5 | K1 runtime-token bypass | Nothing on the client | — |
| 6 | Port 47734 + mDNS default | B18 | Stored URLs plus `GET /hello` only. |
| 7 | Session TTL 12 h / 30 min | Nothing (B2's `idleTimeoutMs` is informational) | — |
| 8 | Passcode-only phones may confirm | The `device_passcode` path in B17 | Passcode-only phones get no `confirmKey`, and sensitive actions are disabled with an explanation. |
| 9 | Claude `allow_always` | Which `alwaysScope: same_as_once` label B9 uses (hide vs relabel) | — |

**Can start before any sign-off:** B1–B5 (protocol, identity, vectors), B16. B14's gating and B13's lead fixes are correct under every outcome. Per the task, none of it starts until you give the go-ahead.
