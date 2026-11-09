# Phase 2 handoff (task #01a1b970): rev 2/3/4 screens per SPEC §14 + §15

**Status (2026-11-07): phase 2 finished**: tsc, lint, jest 97/97, both bundles pass. Screenshots: docs/design/screenshots/phase2/{light,dark} (36 each). Living checklist kept for history. `[x]` done, `[~]` partial, `[ ]` not started.

## Plan / status

### Data layer for the UI
- [x] Confirm state model: off | biometric | device_passcode | none | needs_reconfirm (per PC, `PairedHost.keyInvalid`)
- [x] Demo follows the real model (simulated biometric key); remove `approvalBiometric` / `confirmLocalAuth`
- [x] `classifyScannedCode` (lib/crypto/confirm.ts) + demo facade re-key offer

### §15 confirmations
- [x] Glyph on sensitive buttons + disabled/explained when unavailable (approval sheet, question sheet, inbox quick Allow, Spawn, D1/D2 actions, task delete)
- [x] Inline notice in approval / question sheets (above the sheet, also fixes web toast-behind-sheet)
- [x] Settings tab dot, one-time toast with Fix, per-action prompt copy
- [x] §15.2.3 explainer sheet, P1b name caption, P4 Confirmations card, LockMethodPicker follows enrolled level
- [x] §15.3 re-key flow R1–R4 + errors, entry points: footer line, ConfirmNotice, toast Fix, Settings PC detail, upgrade hint; demo code button
- [x] §15.5 Settings (S1 row, S2 rows → new settings/pc/[hostId] detail, S3 pointer; 15→5 min migration): per-PC Confirmations rows, S3 pointer row, auto-lock cap (15 → 5 migration), No lock caption

### §14
- [x] 14.1 (removal fade animation skipped: toast only)
- [x] 14.3 chat rows (ThreadRows.tsx) + Retry + older history + New divider + New reply pill + broadcast delivery sheet
- [x] 14.4/14.5 sheet (option list, chip, full input, deny/decline message + counter, Other…, drafts, 409, toasts, inline errors)
- [x] Agent ⋯: Rename, Clear context (promptText host in TextPromptModal.tsx)
- [x] 14.6: D1 tasks chip, owner param

### Done criteria
- [x] tsc, lint, jest (97/97), both bundles
- [x] Light + dark screenshots → docs/design/screenshots/phase2/ (capture script: $TEMP/aiondx-e2e/v2-shots.json)

## Notes
- New modules: src/lib/confirmState.ts (pure), src/components/confirm.tsx (useSensitive, ConfirmUnavailableLine, ConfirmNotice, attention toast), src/components/QrScanner.tsx (P2 + R2).
- Demo PC: confirmMode biometric (simulated by the OS prompt), requireConfirm on, built-in re-key offer ("Use the demo PC's code").
- Edit scripts live in $TEMP/aiondx-e2e (q2-*.cjs), helper edit-lib.cjs.
- Done: richer demo seed (paused Release Bot, lead your_turn, tool run, plan, teammate message, context reset, solo send_failed); rev 4.3 outer error codes mapped (pair 401/409, rpc 401 auth_failed, rpc 400 replayed, 403 forbidden_peer).

---

# §16 visual fixes (task #01a1b99c): finished (tsc, lint, jest 99/99, both bundles; shots in docs/design/screenshots/phase2-fixes/, 26 per theme)

Order: must-fix 1–6 → nice-to-have 7–19 → verify 20–21 → D4 (a)(b). Status below; screenshots go to docs/design/screenshots/phase2-fixes/{light,dark}/.

- [x] 1 avatar color (MessageBubble avatarId) · [x] 2 approvalHeading (mappers.ts) · [x] 3 stacked dialog buttons (TextPromptModal) · [x] 4 inbox question card · [x] 5 Stop only with turn / Wake when queued · [x] 6 face-id / finger-print / lock glyph (MCI face-recognition), lock-off when unavailable
- [x] 7 one Re-confirm link in sheets · [x] 8 PC detail link hidden · [x] 9 focus ring (ui/TextField, all form fields) · [x] 10 hourglass · [x] 11 broadcast summary · [x] 12 Retry outline button · [x] 13 No queued messages · [x] 14 paused CURRENT dropped · [x] 15 S2 subtitle · [x] 16 Confirmations · <PC> · [x] 17 Auto-lock disabled · [x] 18 flat roster · [x] 19 soft-disabled secondary
- [x] 20 deep links: unstable_settings.anchor in the 4 tab stacks (real bug for deep links; normal navigation already showed Back) · [x] 21 toast recaptured (capture artifact: old shot waited 6 s, past the toast)
- [x] D5 toast copy (toastConfirmUnavailable in confirm.tsx) "Confirmations unavailable on <PC>" + Re-confirm everywhere
- [x] D4a passcode lockout/failed copy · [x] D4b neutral hint after 2 cancels in 30 s (errors.ts cancelNotice). tsc, lint, jest 99/99 green.
- §16.3 polish N1–N4 (task #01a1bc41): done. N1 Keep running = outline button; N2 neutral D4b hint, kept until a successful confirmation (clearCancelNotices); N3 only "⊗ N failed" red; N4 "Wants to run Write" without "…". Shots overwritten in phase2-fixes/.
