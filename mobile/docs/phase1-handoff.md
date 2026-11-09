# Phase 1 handoff (task #01a1b83d): /v1 facade, rev 3.1 schemas, confirm proof

> **Status (2026-11-07): phase 1 finished.** Every next step below was done: typed routes regenerated, logic.test.ts rewritten, §15.2 no-key behavior in transport.ts, e2e bridge on the /v1 facade with confirm checks. tsc, lint, jest (90/90) and both bundles pass. Kept for history.

Stopped mid-task, with usage at 99%. The working tree is left as it was. Nothing here has been run since the screen pass
started except `tsc`.

## Done

- **Confirm proof (§5 / §5.4).**
  - `src/lib/crypto/confirm.ts`: `jcs`, `confirmMacInput`, `confirmProof`, `rekeyMacInput`, `rekeyProof`.
  - Host reference: `hostCheckConfirm` in `protocol.host.ts`.
  - The confirm and rekey vector tests in `vectors.test.ts` are now real. The crypto suite passes 30/30.
- **SecureChannel.** Computes the proof at seal time from the session's sid and the envelope seq (`RequestOptions.confirmKey`). The 401 retry recomputes it with the same rid. Inner non-2xx responses become `ApiError` from `errors.ts`, which covers the §6.0 codes and adds `describeActionError`.
- **Transport (`src/lib/api/transport.ts`).**
  - The `Transport` interface and `createSecureTransport`.
  - `unlockConfirmKey`: biometric reads through the secure-store prompt; a null read raises `ConfirmKeyInvalidatedError`. device_passcode calls `LocalAuthentication.authenticateAsync` before the read.
  - A 428 when the phone has no key becomes `ConfirmUnavailableError`.
  - `keyStore.readConfirmKey` was added for this.
- **Types and mappers.** `types.ts` holds the rev 3.1 shapes. `mappers.ts` normalizes defensively (unknown enums fall back to defaults, rows without an id are dropped).
- **Client (`client.ts` + `api.ts`).** `createApi(transport)` covers every /v1 route in §6.1–6.8. Sensitive requests are marked through the `confirm` prompt text. `remoteApi.ts` and `mockApi.ts` are deleted.
- **Demo host.** `src/lib/api/mock/{facade,seed,transport}.ts` is an in-memory /v1 facade with a change journal, streaming replies, approvals (options and questions), shutdown requested / rejected / approved, spawn, task owner notices and the §6.0 errors. `facade.isSensitive()` is there for the e2e bridge.
- **Change feed.** `changeFeed.ts`: a long-poll `useChangeFeed`, mounted in `(app)/_layout.tsx`. `hooks.ts` is rewritten with no timer polling, cursor sync and upsert by messageId, `useMarkRead`, broadcasts, `useAnswerApproval`, agent actions (including force remove, rename and clear context) and task CRUD.
- **Theme and status logic.** `src/theme/tokens.ts` now uses the designer tokens (`dashboardSections`). `format.ts` has `agentStatusKey` (§14.1.1), `agentReasonCopy`, `waitingOn` (§14.2), `taskOwnerLabel`, `orderedOptions`, `optionLabel` (sign-off #9 relabel), `quickOptions` and `retryTargetFor`.
- **Screens and components adapted to the new types:**
  - SlotCard, agentActions, Banners, TaskCard, SwipeableTaskRow and MessageBubble;
  - dashboard, agent detail, chat list, thread, approval sheet (option list, questions, deny with message), inbox, task board (§14.6 owner filter), task detail, task editor (Notify checkbox removed), spawn, team picker and settings.
- The approval route was renamed from `approval/[promptId]` to `approval/[approvalId]`.

## Still not compiling

- **Approval route links.** Every remaining `tsc` error under `src/app` and `src/components` is TS2820 on `'/approval/[approvalId]'`. The typed-routes file in `.expo/types` is stale. Run `npx expo start` once to regenerate it; no code change should be needed. The files involved are:
  - `src/app/(app)/(tabs)/(home)/index.tsx`
  - `src/app/(app)/(tabs)/(home)/agent/[slot].tsx`
  - `src/app/(app)/(tabs)/chat/[conversationId].tsx`
  - `src/app/(app)/approvals.tsx`
  - `src/components/Banners.tsx`
- **Old logic tests.** `src/lib/__tests__/logic.test.ts` is written against the deleted types (Slot, mockApi, slotStatusKey). It needs rewriting.
- **Not checked yet:** `e2e/bridge.ts` (excluded from tsc), lint, jest, and the bundles.

## Next steps

1. Regenerate the typed routes and re-run `tsc`.
2. Replace the no-key fallback per SPEC §15.2 (lead's rev 4 note). `createSecureTransport` currently falls back to `confirmLocalAuth` (the "Face ID before approving" pref, which §15 removes).
   - Real pairings without a key should send without a proof, and proceed only if there is no 428.
   - Otherwise show the "Why some actions are unavailable" explanation.
   - Demo mode can keep the simple gate.
   - Also clamp the auto-lock setting to Immediately / 1 / 5 min if touched (§15/S3).
3. Rewrite `logic.test.ts`. Add tests for:
   - mappers;
   - `agentStatusKey`, `waitingOn` and `retryTargetFor`;
   - `isSensitiveAnswer`;
   - mock facade flows (approval answer and 422, shutdown rejected, task notices, changes coalescing / reset), using fake timers;
   - `applyChanges`;
   - transport 428 → `ConfirmUnavailableError`.
4. Update `e2e/bridge.ts` so rpc dispatches to `createMockFacade().handle()`. On `facade.isSensitive()`, check the proof with `hostCheckConfirm` using the confirm key issued at pairing, returning 428 or 403 as `{error:{code}}` inner responses. Keep A2 offer lock, A1 notices and rid dedupe.
5. Run lint, jest and both bundles (`CI=1 npx expo export --platform android --platform ios`), then a web smoke test in demo mode and against the e2e bridge.
6. Report to the lead, including these deferrals:
   - no UI yet for Rename / Clear context or older-history paging (`useLoadOlder` exists);
   - no TeamSessionBanner (`useStartTeamSession` exists);
   - no send_failed Retry button;
   - all of the above belong to phase 2.

## Contract rev 4.1 confirmations (from the lead)

All three of my questions were confirmed as implemented:

1. **`before` cursor.** A messages response without `since` includes `before: string | null`, also when `reset` is true. It is absent on ordinary `since` polls. The mapper (`toMessageSync`) already reads `before` whenever it's present, including on reset responses. `useThread` takes `before` on fresh and reset loads.
2. **`/v1/changes` without `since`.** It returns immediately with the current token, `changes: []`, `reset: false` and `more: false`, and never holds, even with `wait`. The mock does the same, and the client sends `wait=0` without a token anyway.
3. **Task notices from the user.** A notice for a task the user assigned has `role: 'user'`, `sender {kind:'user'}` and `notice: task_assigned`. A notice for a task an agent assigned stays `role: 'teammate'`. The mock follows this.

Also from the lead: the contract is now rev 4 (approved, no wire changes), then rev 4.1.
