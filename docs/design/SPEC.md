# AionDX Companion App — Screen Specs & Interaction Flows

Status: v1 draft · Owner: App Designer · Audience: Mobile Engineer (build target), Lead
Platform: Expo SDK 58 / React Native 0.88 / Expo Router (iOS + Android, portrait, phone-first)

The app is a **remote control for AionDX running on the user's PC**: see what every agent is
doing, unblock it (approve permission prompts, answer messages), and steer the task board.
It is not a full desktop replacement — no file editing, no workspace browsing in v1.

---

## 0. Assumptions & open questions (please confirm / correct)

The API surface below is inferred from the team tool contract (`team_members`, `team_task_*`,
`team_send_message`, mailbox) plus the two endpoints named in the brief. Anything marked
**[ASSUMED]** needs confirmation from the AionDX backend/bridge team before build.

| # | Topic | Assumption used in this design |
|---|---|---|
| A1 | Live updates | Polling only. No push / WebSocket. (§5) |
| A2 | Run-state | `GET /api/teams/{id}/run-state` returns slots + status + blocked reason + queue counts in one call. Shape in §10. **[ASSUMED shape]** |
| A3 | Messages | `POST /api/teams/{id}/agents/{slot}/messages`; reading history via `GET …/messages?since={message_id}` **[ASSUMED]** |
| A4 | Tasks | Mirrors the team task contract: `id, subject, description, status (pending\|in_progress\|completed\|deleted), owner, blocked_by[], blocks[]` |
| A5 | Permission prompts | There is an endpoint listing pending tool-permission prompts per slot and one to resolve them (`allow_once \| allow_always \| deny`). **[ASSUMED — no endpoint named yet]** |
| A6 | Agent lifecycle | Spawn = `assistant_id` + `name` (catalog from `team_list_assistants`). Stop = interrupt active turn. Shutdown = `shutdown_request` the agent can reject. Spawn/shutdown are **lead-only** in Team governance — the phone acts *as the human user*, who outranks the lead, so the API must expose these to the paired device. **[ASSUMED]** |
| A7 | Solo conversations | Non-team conversations exist and are listable/sendable via a similar API. **[ASSUMED]** |
| A8 | Transport security | Crypto details live in `docs/pairing-encryption-proposal.md` (Mobile Engineer). This doc only specifies the **user-facing** pairing flow. Agreed with that proposal (§9): QR carries PC address + one-time code + PC public key + expiry; both sides show a 6-digit verification code; phone polls pairing status (1 s, 2 min timeout); `device_revoked` → Re-pair. **QR is the only pairing path in v1** — manual code entry is dropped because a short typed code can't safely deliver the PC's public key (needs PAKE or a ~26-char code; revisit post-v1). |
| A9 | Remote access | v1 assumes phone and PC are reachable (same LAN or user-provided tunnel). A relay is out of scope but the UI reserves space for a "route" indicator (LAN / Relay). |

Open question for Lead: do we need **multi-PC** support in v1? The IA supports it (host switcher)
at low cost, but if not needed the switcher collapses to a single row in Settings.

---

## 1. Design principles

1. **Unblock first.** The #1 reason to open the app is "something is waiting on me". Pending
   approvals and agents blocked on the user are always one tap away and never hidden behind a tab.
2. **Honest freshness.** Polling means data is always slightly old. Every live surface shows how
   old (`Updated 3s ago`) and degrades visibly when stale — never silently show wrong state.
3. **Glanceable status.** Agent status is encoded with color **+ icon + label** (never color alone).
4. **Safe destructive actions.** Stop / shutdown / deny / delete always confirm; approvals can be
   gated by biometrics (setting).
5. **Thumb zone.** Primary actions sit in the bottom third; destructive actions are never the
   default-focused button.

---

## 2. Information architecture & route map

```
Root (_layout.tsx)  — gate: paired? unlocked?
├── (onboarding)/                       Stack, no tabs — shown when no paired host
│   ├── welcome.tsx                     P1
│   ├── name.tsx                        P1b name this phone (sent in pairing request)
│   ├── scan.tsx                        P2  QR scanner (expo-camera) — QR is the only pairing path in v1
│   ├── verify.tsx                      P3  compare 6-digit code
│   ├── app-lock.tsx                    P4  app lock (local only)
│   └── done.tsx                        P5
├── lock.tsx                            Biometric/PIN unlock (modal, full-screen)
└── (app)/                              Tabs
    ├── (home)/                         Tab 1 "Agents"  (icon: grid)
    │   ├── index.tsx                   D1 Team dashboard (run-state)
    │   ├── agent/[slot].tsx            D2 Agent detail
    │   └── spawn.tsx                   D3 Spawn agent (modal sheet)
    ├── (chat)/                         Tab 2 "Chat"    (icon: speech bubble)
    │   ├── index.tsx                   C1 Conversation list
    │   └── [conversationId].tsx        C2 Thread (team agent or solo)
    ├── (tasks)/                        Tab 3 "Tasks"   (icon: checklist)
    │   ├── index.tsx                   T1 Task board
    │   ├── [taskId].tsx                T2 Task detail
    │   └── edit.tsx                    T3 Create / edit task (modal; ?taskId= for edit)
    ├── approvals.tsx                   A1 Approvals inbox (modal; opened from banner/badge)
    └── (settings)/                     Tab 4 "Settings" (icon: gear)
        ├── index.tsx                   S1 Settings
        ├── hosts.tsx                   S2 Paired PCs (host switcher, re-pair, unpair)
        └── security.tsx                S3 App lock, poll interval (confirmations: §15.5)
```

Global chrome (rendered in `(app)/_layout.tsx`, above tabs):
- **Team switcher** in the header of Agents/Chat/Tasks: `AionDX App Team ▾` → sheet listing teams on the current host.
- **ApprovalBanner** (§4.7) pinned under the header on every tab when ≥1 approval is pending.
- **ConnectionBanner** (§4.8) when the host is unreachable or data is stale.
- **Tab badges**: Agents = count of slots `blocked_on_user`; Chat = unread; Tasks = none.

---

## 3. Design tokens

Support **light and dark** (`app.json` `userInterfaceStyle: "automatic"`).

### 3.1 Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#F7F8FA` | `#0E1116` | Screen background |
| `surface` | `#FFFFFF` | `#171B22` | Cards, sheets |
| `surfaceAlt` | `#EEF1F5` | `#1F252E` | Inputs, inactive chips |
| `border` | `#DDE2E8` | `#2A313C` | Hairlines |
| `text` | `#11151B` | `#E8ECF1` | Primary text |
| `textMuted` | `#5B6573` | `#98A2B1` | Secondary text, timestamps |
| `primary` | `#3B5BDB` | `#7C93FF` | Primary buttons, links, own message bubble |
| `onPrimary` | `#FFFFFF` | `#0E1116` | Text on primary |
| `danger` | `#D6336C` | `#FF6B9A` | Destructive |

**Status palette** (always paired with icon + label):

| Status | Token | Light | Dark | Icon | Label |
|---|---|---|---|---|---|
| working | `stWorking` | `#2F9E44` | `#51CF66` | animated pulse dot | Working |
| idle | `stIdle` | `#868E96` | `#7D8794` | hollow circle | Idle |
| blocked on user | `stNeedsYou` | `#E8590C` | `#FF922B` | hand / alert | Needs you |
| blocked on dependency | `stWaiting` | `#B08900` | `#FCC419` | hourglass | Waiting |
| error / failed | `stError` | `#C92A2A` | `#FF6B6B` | x-octagon | Error |
| starting / stopping | `stTransition` | `#3B5BDB` | `#7C93FF` | spinner | Starting… / Stopping… |
| offline / unknown | `stUnknown` | `#ADB5BD` | `#495057` | question / dash | Unknown |

**Status text vs. status marks.** In light mode the status colors above only reach ~3.3:1. That
passes for dots, edge strips and icons (≥3:1) but **fails for text**. Any status-colored *text*
(pill labels, blocked-reason lines, "blocked by N") uses the `st*Text` tokens in `tokens.ts`
(light: Working `#237A35`, Idle `#5F6B76`, Needs you `#B4470A`, Waiting `#7A5E00`, Error `#B02525`;
all ≥4.5:1 on surface, page background and the 12% tint pill). Dark mode already passes;
only Idle text moves to `#98A2B1`.

Task status: `pending` = idle grey, `in_progress` = primary blue, `completed` = working green,
`deleted` = muted + strikethrough (only visible with "Show deleted").

### 3.2 Type (system font: SF Pro / Roboto; respect Dynamic Type / font scale up to 200%)

| Token | Size/Line | Weight | Use |
|---|---|---|---|
| `display` | 28/34 | 700 | Onboarding titles |
| `title` | 20/26 | 600 | Screen titles |
| `headline` | 16/22 | 600 | Card titles, agent names |
| `body` | 15/21 | 400 | Body, messages |
| `caption` | 13/18 | 400 | Meta, timestamps |
| `mono` | 13/18 | 400 (monospace) | Tool-call args in approvals, IDs, verify code (verify code uses 32/40 700 mono) |

### 3.3 Spacing / shape / motion
- Spacing scale: 4, 8, 12, 16, 24, 32. Screen gutter 16. Card padding 12–16.
- Radius: chips 999, cards 12, sheets 16 (top corners), bubbles 18.
- Min touch target 44×44 pt (48 dp Android).
- Motion: 150–250 ms ease-out. Respect Reduce Motion (disable pulse dot, use static dot).

---

## 4. Core components

### 4.1 `StatusPill`
`[● Working]` — dot/icon + label, tinted bg at 12% opacity of status color. Sizes `sm` (in lists) and `md` (headers). `accessibilityLabel="Status: Working"`.

### 4.2 `FreshnessIndicator`
Text in header subtitle: `Updated 2s ago` (ticks every second locally).
- age ≤ 2× poll interval → muted text.
- age > 2× → amber `Updated 24s ago · retrying` + small spinner.
- age > 60 s or unreachable → ConnectionBanner takes over.
Tap → forces an immediate refresh.

### 4.3 `SlotCard` (dashboard row)
```
┌──────────────────────────────────────┐
│ (MA) Mobile Engineer        [● Work] │
│      Scaffold React Native app + …   │  ← current task subject (1 line)
│      ✉ 2 queued · ⏱ 4m in turn       │  ← queue count · turn duration
└──────────────────────────────────────┘
```
Blocked variant adds a reason line with the status color strip on the left edge (4 pt):
```
┃ (UX) UI/UX Designer       [✋ Needs you]
┃      Waiting for approval: Bash      │
┃      "npm install expo-camera"       │
┃      [ Review ]                       │  ← inline CTA → approval sheet
```
Avatar = initials on a color derived from slot_id hash. Lead gets a small ★ badge.

### 4.4 `QueueBadge`
Pill with count of unread mailbox messages queued for that slot. 0 → hidden. ≥ 100 → `99+`.

### 4.5 `TaskCard`
```
┌──────────────────────────────────────┐
│ Design AionDX mobile app screens …   │
│ (AD) App Designer    ⛓ blocks 1      │
│ [● In progress]          #…b93d      │
└──────────────────────────────────────┘
```
`⛓ blocked by N` shown in `stWaiting` when any `blocked_by` task isn't completed.

### 4.6 `MessageBubble`
- Own (from "You") right-aligned, `primary` bg. Agent messages left-aligned, `surface` bg, with avatar + name above first message in a group (group = same sender within 2 min).
- Body renders **Markdown** (agents send markdown: lists, code blocks, tables → horizontally scrollable). Code blocks get a copy button.
- ~~Attachments (`files[]`)~~: removed in rev 2 (§14.3). Message rendering by role/type is in §14.3.
- Special message types render as system cards, not bubbles: `shutdown_request`, `shutdown_approved`, `shutdown_rejected: …`, task-assignment notices (`📋 Task assigned…` → TaskCard link).
- Send states on own messages: `sending` (clock icon, 60% opacity) → `sent` (check) → `failed` (red ! + "Tap to retry").

### 4.7 `ApprovalBanner` + `ApprovalSheet`
Banner (sticky, `stNeedsYou` bg tint):
```
┌──────────────────────────────────────┐
│ ✋ 2 approvals waiting        Review ›│
└──────────────────────────────────────┘
```
1 pending → tap opens ApprovalSheet directly; >1 → opens Approvals inbox (A1).

ApprovalSheet (bottom sheet, ~70% height, not dismissible by swipe while biometrics prompt is up):
```
┌──────────────────────────────────────┐
│ ────                                 │
│ (MA) Mobile Engineer wants to run    │
│ Bash                     2m ago      │
│ ┌──────────────────────────────────┐ │
│ │ npx expo install expo-camera     │ │  ← mono, scrollable, full args
│ └──────────────────────────────────┘ │
│ Working dir: …/aiondx-mobile         │
│ Why: "Need camera for QR pairing"    │  ← if agent supplied description
│                                      │
│ [        Allow once        ]         │  ← primary
│ [  Always allow "Bash(npx expo…)" ] │  ← secondary, shows exact rule scope
│ [          Deny            ]         │  ← danger outline
│ Deny with message…                   │  ← link → text field, sent as reason
└──────────────────────────────────────┘
```
Rules: no button is pre-focused; "Always allow" shows the precise rule it will create; if the
prompt was resolved elsewhere (on PC) while the sheet is open, swap content to
`Already handled on PC — Allowed` and auto-close after 1.5 s.

### 4.8 `ConnectionBanner`
| State | Copy | Action |
|---|---|---|
| Reconnecting (1–3 failed polls) | `Reconnecting to NATE-PC…` + spinner | — |
| Unreachable (>3 fails or >60s) | `Can't reach NATE-PC. Showing data from 2 min ago.` | `Retry` |
| Auth/key rejected | `NATE-PC no longer trusts this phone.` | `Re-pair` → P2 |
| PC app not running | `AionDX isn't running on NATE-PC.` | `Retry` |
While unreachable, all mutating controls are disabled (greyed, with toast "Offline — can't send" on tap); data stays visible but dimmed to 60%.

### 4.9 `Composer`
Multiline input (max 6 lines then scroll) + send button. Send disabled when empty or offline.
Long-press send → "Send to all teammates (broadcast)" only in team-lead thread context (maps to `to="*"`). Draft persisted per conversation.

### 4.10 `ConfirmSheet`
Standard destructive confirmation: title, one-line consequence, `Cancel` (default) + red action.
**As built:** native system alert (`Alert.alert`, Cancel style + destructive style) for ≤3 choices;
custom bottom sheet (`OptionSheet`) for more than 3, since Android alerts cap at 3 buttons.

---

## 5. Polling & live-update model (UX contract)

| Context | Endpoint(s) | Interval (foreground) | Notes |
|---|---|---|---|
| Dashboard D1 visible | run-state | **3 s** | Also drives tab badges + ApprovalBanner |
| Agent detail D2 | run-state + agent messages since cursor | 3 s | |
| Chat thread C2 | messages `?since=` | **2 s** while screen focused | Bump to 1 s for 30 s after user sends |
| Chat list C1 | conversations summary | 5 s | |
| Task board T1/T2 | tasks | 5 s | Immediately refetch after any mutation |
| Any other tab | run-state (light) | 10 s | Keeps approvals/badges live everywhere |
| App backgrounded | — | **stop polling** | No background fetch in v1 (no push). On foreground: fetch immediately, show `Updated just now` |

Rules for the engineer:
- One shared poller per resource (e.g., React Query `refetchInterval`), paused via `AppState` and screen focus.
- Backoff on failure: 3 s → 6 s → 12 s → 30 s max; reset on success. Drive ConnectionBanner from consecutive failure count.
- Use `ETag`/`If-None-Match` or a `since` cursor where available so unchanged polls are cheap. **[ASSUMED server support]**
- **Diff, don't redraw**: list rows keyed by `slot_id` / `task.id` / `message_id`; status changes animate the pill color (150 ms) — no full-list flash.
- **Optimistic mutations**: send message, update task status, approve/deny → apply locally immediately with a pending marker, reconcile on next poll, roll back + toast on error.
- **"Changed" hints**: when a slot's status changes between polls, flash a 1 s subtle highlight on its card. When a new message arrives while scrolled up in a thread, show `↓ 3 new` pill instead of auto-scrolling.
- No local OS notifications in v1 (requires background execution). Reserve a Settings row "Notifications — coming soon" so the IA doesn't change later.

---

## 6. Screens

Wireframes are ~38 chars wide ≈ a 390 pt phone. `[ ]` = button, `( )` = avatar, `▾` = picker.

### 6.1 Pairing / onboarding

**P1 Welcome**
```
┌──────────────────────────────────────┐
│                                      │
│              [ logo ]                │
│        Control AionDX from           │
│            your phone                │
│                                      │
│  • See every agent's status live     │
│  • Approve requests on the go        │
│  • Chat with agents, manage tasks    │
│                                      │
│  🔒 End-to-end encrypted. Your PC    │
│     and phone pair directly.         │
│                                      │
│  [        Pair with my PC        ]   │
│      How do I find the QR code?      │  ← sheet: "AionDX on PC → Settings → Mobile → Pair new device"
└──────────────────────────────────────┘
```

**P1b Name this phone** — before scanning, so the name rides in the pairing request and the PC's
confirm prompt reads "Nate's iPhone wants to pair" (helps the user spot an unexpected device).
```
┌──────────────────────────────────────┐
│ ‹                                    │
│ Name this phone                      │
│ [ Nate's iPhone                  ]   │  ← prefilled from OS device name
│ Your PC will show this name when     │
│ you confirm pairing.                 │
│                                      │
│ [          Continue          ]       │  ← disabled if empty; trim, max 40 chars
└──────────────────────────────────────┘
```
No post-pairing rename in v1 (would need an extra rename call; revisit if requested).

**P2 Scan QR** (camera permission requested here, with pre-prompt explaining why)
```
┌──────────────────────────────────────┐
│ ‹                         Scan code  │
│ ┌──────────────────────────────────┐ │
│ │                                  │ │
│ │        ┌──────────────┐          │ │  ← live camera, dimmed outside frame
│ │        │              │          │ │
│ │        │   viewfinder │          │ │
│ │        └──────────────┘          │ │
│ │                                  │ │
│ └──────────────────────────────────┘ │
│ On your PC open AionDX → Settings →  │
│ Mobile → Pair new device             │
└──────────────────────────────────────┘
```
States: camera denied → replace viewfinder with explainer ("AionDX needs the camera to scan the
pairing code from your PC — it's how your phone gets your PC's key securely.") + `[Open Settings]`.
No manual-entry fallback in v1 (see A8). When the user returns from Settings with permission
granted (AppState → active), re-check and start the camera automatically.
Invalid/foreign QR → haptic error + toast "That's not an AionDX pairing code". Expired QR →
"This code expired. Generate a new one on your PC." On valid scan: haptic success, freeze frame,
spinner "Connecting to NATE-PC…" → P3.

**P3 Verify** — prevents MITM; mandatory, not skippable.
```
┌──────────────────────────────────────┐
│ ‹                                    │
│       Confirm the code matches       │
│                                      │
│           4 8 2   9 1 7              │  ← mono 32pt, spaced
│                                      │
│  Your PC NATE-PC is showing a code.  │
│  Only continue if they're identical. │
│                                      │
│  [       Codes match       ]         │
│  [    They don't match     ]         │  ← aborts attempt, saves nothing, explains risk (§12.7)
└──────────────────────────────────────┘
```
After "Codes match" phone shows `Waiting for you to confirm on your PC…` until PC also
confirms (poll pairing status 1 s, 2 min timeout → "Pairing timed out. Try again.").

**P4 App lock** (local setting only — no server call)
```
┌──────────────────────────────────────┐
│ Lock the app                         │
│ ◉ Face ID / fingerprint  (default)   │
│ ○ Device passcode only               │
│ ○ No lock (not recommended)          │
│                                      │
│ [x] Require Face ID to approve       │  ← rev 3.1: removed; replaced by the §15.2 Confirmations card
│     permission requests              │
│                                      │
│ [          Continue          ]       │
└──────────────────────────────────────┘
```
**Why the app lock matters (contract §5.1):** chat messages aren't confirmed per send, and a message
to an agent running in YOLO mode can do anything an approval can. The app lock (on open, and on
resume after at most 5 min) is the only thing protecting that. So "No lock" carries the caption
"Anyone with your unlocked phone could message your agents", and Face ID / fingerprint stays the
default.


**P5 Done**: check animation, "Paired with NATE-PC", summary (host name, route LAN, teams found: N), `[Open dashboard]`.

**Flow**
```
P1 ─tap Pair─► P1b name ─► P2 ──scan ok──► P3 ──match + PC confirms──► P4 ─► P5 ─► D1
                           └─camera denied─► explainer ─Open Settings─► (return) ─► P2
                                             P3 "don't match" ─► abort screen ─► P1
                                             P3 timeout (2 min) ─► "Pairing timed out" ─► P2
Any step: network error → inline error + Retry; Back from P3 cancels pairing (confirm).
Pairing is complete on the server once P3 confirms; P4 is local-only, so Back from P4 is disabled.
```

**Lock screen** (`lock.tsx`): shown on cold start and after >5 min in background (configurable down to Immediately; never longer than 5 min). Auto-triggers biometric prompt; fallback `Use passcode`. Shows host name + app logo only (no data behind it — blur snapshots in the app switcher too).

### 6.2 D1 — Team dashboard (Agents tab)

```
┌──────────────────────────────────────┐
│ AionDX App Team ▾          ⊕  Spawn │
│ Updated 2s ago · NATE-PC · LAN       │
├──────────────────────────────────────┤
│ ✋ 1 approval waiting        Review › │  ← ApprovalBanner (if any)
├──────────────────────────────────────┤
│ ┌────────┐┌────────┐┌────────┐┌─────┐│
│ │ 2      ││ 1      ││ 2      ││ 3   ││  ← summary chips (tap = filter)
│ │Working ││Needs u ││Idle    ││Tasks││
│ └────────┘└────────┘└────────┘└─────┘│
├──────────────────────────────────────┤
│ NEEDS YOU                            │  ← section only when non-empty
│ ┃(UX) UI/UX Designer    [✋ Needs you]│
│ ┃   Waiting for approval: Bash       │
│ ┃   [ Review ]                       │
│ WORKING                              │
│  (★CC) Claude Code        [● Working]│
│      Coordinating team · ✉ 0         │
│  (ME) Mobile Engineer     [● Working]│
│      Scaffold React Native app…      │
│      ✉ 2 queued · 4m in turn         │
│ IDLE                                 │
│  (U2) UI/UX Designer 2       [○ Idle]│
│      No task · ✉ 0                   │
├──────────────────────────────────────┤
│ [Agents]   [Chat]   [Tasks]   [⚙]    │
└──────────────────────────────────────┘
```
- Sections sorted: Needs you → Error → Waiting → Working → Transition → Idle → Unknown. Within a section: lead first, then by name.
- Summary chip "Tasks" shows open (non-completed) task count → jumps to Tasks tab.
- Tap card → D2. Long-press card → quick actions sheet: Message, Stop turn, View tasks, Shutdown.
- Pull-to-refresh forces a poll.
- Empty team: illustration + "No agents yet" + `[Spawn an agent]`.
- **Blocked reason copy** (map server reason codes → human text):
  - `permission_prompt` → "Waiting for approval: {tool}" + args preview (1 line)
  - `awaiting_user_reply` → "Asked you a question" + message preview → CTA `Reply`
  - `blocked_by_task` → "Waiting on task: {subject}" (stWaiting) → CTA `View task` — **rev 2: not on the wire; derived on Idle cards instead (§14.2)**
  - `waiting_for_teammate` → "Waiting for {name}" — **rev 2: dropped (§14.2)**
  - `rate_limited` / `provider_error` → "Model provider error — retrying" (stError) with retry time
  - unknown code → show raw code in caption, never hide it.

### 6.3 D2 — Agent detail

```
┌──────────────────────────────────────┐
│ ‹ Agents                         ⋯   │  ← ⋯: Rename*, Clear context*, Shutdown
│ (ME)  Mobile Engineer                │
│       Teammate · opus[1m]            │
│       [● Working] · 4m in turn       │
│ Updated 1s ago                       │
├──────────────────────────────────────┤
│ [  Message  ]  [ Stop turn ]         │  ← Stop = interrupt; Start shown when idle w/ queue
├──────────────────────────────────────┤
│ CURRENT                              │
│  Blocked reason card (if any)        │
│ TASKS (2)                            │
│  TaskCard…                           │
│  TaskCard…                           │
│ MAILBOX                              │
│  ✉ 2 queued messages          ›      │  ← list of queued (unread) msgs, read-only
│ RECENT ACTIVITY                      │
│  • 18:15 Started task "Scaffold…"    │
│  • 18:14 Sent message to Claude Code │
│  • 18:02 Spawned                     │
└──────────────────────────────────────┘
```
- **Stop turn** → ConfirmSheet: "Stop Mobile Engineer's current turn? It will stop mid-step. You can send it a new instruction." Options: `Cancel` / `Stop` / `Stop & send instruction…` (opens composer; maps to interrupt with replacement message).
- **Start / Resume**: when an idle agent has queued messages but isn't running (stuck), show `[ Wake agent ]`. **[ASSUMED endpoint]**
- **Shutdown** → ConfirmSheet; then card shows `Stopping…` until the agent replies. If agent responds `shutdown_rejected: <reason>`, show the reason in an inline system card with `[Force shutdown]` **[ASSUMED capability]** and `[Keep running]`.
- Items marked * only shown if API exposes them.

### 6.4 D3 — Spawn agent (modal sheet)

Step 1 — pick assistant (searchable list from assistant catalog):
```
│ Spawn an agent                    ✕ │
│ 🔍 Search assistants                │
│ ┌─────────────────────────────────┐ │
│ │ UI/UX Pro Max                   │ │
│ │ Design systems, UX review…      │ │
│ │ skills: ui-ux, a11y        ›    │ │
│ └─────────────────────────────────┘ │
```
Step 2 — details: tap assistant → description, skills, example tasks (from describe-assistant); fields `Name` (required, unique in team — inline error), optional `First task` (pick existing pending task or "Create new…"). `[Spawn]`.
After spawn: sheet closes, new SlotCard appears in `Starting…` state with highlight; toast "UI/UX Designer 3 is starting".

### 6.5 A1 — Approvals inbox

```
│ Approvals (2)                     ✕ │
│ ┌─────────────────────────────────┐ │
│ │ (UX) UI/UX Designer     2m ago │ │
│ │ Bash  npm install expo-camera  │ │
│ │ [Deny]            [Allow once] │ │  ← inline quick actions
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ (ME) Mobile Engineer   30s ago │ │
│ │ Write  src/app/_layout.tsx     │ │
│ │ [Deny]            [Allow once] │ │
│ └─────────────────────────────────┘ │
```
Tap card body → full ApprovalSheet (needed for "Always allow" / deny-with-message). Oldest first.
After resolving: card collapses with `Allowed ✓` / `Denied` for 1 s then leaves the list. Empty → "Nothing needs your approval" + close.
If biometrics-for-approval is on, each Allow triggers the OS prompt (one prompt per action; no batching in v1 — safer). **Superseded by §15.1:** the bridge now enforces confirmation for every allow.

### 6.6 C1 — Conversation list (Chat tab)

```
│ Chat                          ✎ New │
│ [ Team ]  [ Solo ]                   │  ← segmented
│ ─ AionDX App Team ─────────────────  │
│ (★CC) Claude Code          18:16   │
│       Acknowledged, standing by…  ● │  ← ● unread
│ (ME) Mobile Engineer        18:15   │
│       Scaffold done, see app.json… │
│ (UX) UI/UX Designer         18:10   │
│ 👥 Everyone (broadcast)              │
```
- Team segment: one thread per teammate (DM between **you** and that slot) + an "Everyone" broadcast thread. Agents needing a reply float to top with `✋`.
- Solo segment: standalone conversations (title, last message, model). `✎ New` in Solo → create conversation **[ASSUMED]**; in Team → picker of teammates.

### 6.7 C2 — Thread

```
┌──────────────────────────────────────┐
│ ‹ (ME) Mobile Engineer   [● Working] │
│        Updated 1s ago                │
├──────────────────────────────────────┤
│        ─── Today ───                 │
│ (ME) I've scaffolded the Expo app.   │
│      Questions:                      │
│      1. Use expo-router? …           │
│                              18:15   │
│                ┌───────────────────┐ │
│                │ Yes, expo-router. │ │
│                └───────────────── ✓┘ │
│ ┌ system ─────────────────────────┐ │
│ │ 📋 Task assigned: Scaffold RN …  │ │  ← links to T2
│ └─────────────────────────────────┘ │
│ (ME) is working…  ● ● ●              │  ← shown when slot status = working
│                         [ ↓ 2 new ]  │
├──────────────────────────────────────┤
│ [ Message Mobile Engineer…     ] (➤) │
└──────────────────────────────────────┘
```
- Header tap → D2. Status pill in header live.
- If the agent is blocked on a permission prompt, a sticky ApprovalSheet-lite card sits above the composer (`Wants to run Bash… [Review]`).
- Messages are paginated upward (load 50, infinite scroll) and polled downward via `since`.
- Long-press bubble: Copy, Create task from message (pre-fills T3 subject/description), Copy message ID.
- Composer attachment button **not in v1** (files are PC paths; phone can't meaningfully attach).

### 6.8 T1 — Task board (Tasks tab)

Phone-first: **status-segmented list**, not a horizontal kanban (kanban is unreadable at 390 pt).
```
┌──────────────────────────────────────┐
│ Tasks                          ＋ New│
│ [Open 2] [In progress 2] [Done 0]    │  ← segmented w/ counts; "Open" = pending
│ Owner: Anyone ▾   ⋯ Show deleted     │
├──────────────────────────────────────┤
│ TaskCard: Design AionDX mobile app…  │
│ TaskCard: Scaffold React Native app… │
└──────────────────────────────────────┘
```
- Swipe right on a card → advance status (pending→in_progress→completed), with color reveal + label; swipe left → `Delete` (confirm). Both have equivalent actions in T2 for accessibility.
- Owner filter: Anyone / Me (unassigned-to-agent tasks) / each teammate. **Rev 2: replaced by §14.6** (Anyone · You · Unassigned · teammates · Removed agents).
- Blocked tasks show `⛓ blocked by 1` and swipe-to-start shows a warning toast "Blocked by: {subject}" but still allows it (user override).
- Empty states per segment: "No open tasks" + `[Create task]`.

### 6.9 T2 — Task detail

```
│ ‹ Tasks                         ⋯   │  ← ⋯: Edit, Delete
│ Design AionDX mobile app screens &  │
│ flows                               │
│ [● In progress ▾]                   │  ← tap = status picker sheet
│ Owner   (AD) App Designer   ▾       │  ← tap = reassign picker
│ ID      …b93d   (copy)              │
│ ─ Description ───────────────────── │
│ Design the full UI/UX for the …     │  ← markdown, "Show more" after 12 lines
│ ─ Dependencies ──────────────────── │
│ Blocked by: none          ＋ Add    │
│ Blocks: (none)                      │
│ ─ Related messages ──────────────── │
│ 📋 Assigned to App Designer · 18:02  │
│ [ Message owner ]                   │
```
Status / owner changes are optimistic and save immediately (no Save button). Reassign confirms only if the current owner is `working` on it ("App Designer is working on this. Reassign anyway?").

### 6.10 T3 — Create / edit task (modal)
Fields: Subject (required, 1 line, max 200), Description (multiline, markdown), Owner (picker: Unassigned + teammates with status pills), Blocked by (multi-select of non-completed tasks, searchable). `[Create]` disabled until subject non-empty. On create: close, scroll T1 to new card with highlight. ~~Option checkbox `[x] Notify owner`~~ — **rev 3: removed; the bridge notifies the owner automatically (§14.6).**

### 6.11 Settings

**S1 Settings**
```
│ Settings                             │
│ CONNECTED TO                         │
│  🖥 NATE-PC · LAN · Updated 2s ago  › │ → S2
│ SECURITY                             │
│  App lock          Face ID         › │ → S3
│  Approve with Face ID          [on] │  ← removed; see §15.5
│ LIVE UPDATES                         │
│  Refresh rate     Normal (3s)    ›   │  ← Fast 1s / Normal 3s / Battery saver 10s
│  Notifications    Coming soon        │
│ ABOUT                                │
│  Version 1.0.0 · Diagnostics       › │  ← last poll latency, error log (copyable)
```
**S2 Paired PCs**: list of hosts with last-seen; active host checkmark; per-host: `Rename`, `Re-pair`, `Unpair` (confirm: "This phone will lose access to NATE-PC. Keys are deleted from this phone."). `＋ Pair another PC` → P2. Re-pair and Pair another PC skip P1b and reuse the phone name from the first pairing. `Rename` here only changes the PC's label on this phone; it never calls the server.
**S3 Security**: lock method, auto-lock timeout (Immediately / 1 / 5 min; **max 5 min**, because contract §5.1 relies on it, see §15), ~~approval biometrics~~ (removed; per-PC Confirmations in §15.5), "Show this device's key fingerprint" (for audit, mono).

---

## 7. Key interaction flows

### F1. Unblock an agent from a glance (core loop)
```
Open app ─► Lock (Face ID) ─► D1 (fetch immediately)
  ApprovalBanner "1 approval waiting" ─tap─► ApprovalSheet
    Allow once ─► (Face ID if enabled) ─► optimistic: card → Working (pending)
      next poll confirms ─► highlight flash ─► done
      server error ─► rollback + toast "Couldn't send approval. Retry"
```

### F2. Answer an agent's question
```
D1 card "Asked you a question" ─Reply─► C2 thread scrolled to the question
  type ─► send (optimistic bubble "sending") ─► POST …/agents/{slot}/messages
  ─► ✓ sent ─► poll at 1 s for 30 s ─► agent status → Working, reply appears
```

### F3. Stop a runaway agent
```
D1 long-press card ─► Stop turn ─► ConfirmSheet
  "Stop & send instruction…" ─► composer ─► send
  ─► card shows "Stopping…" (stTransition) ─► next polls → Idle/Working w/ new instruction
```

### F4. Create and assign a task
```
T1 ＋New ─► T3 (subject, owner = Mobile Engineer, blocked by: "Design…")
  Create ─► optimistic card in Open ─► server id replaces temp id
  Owner's SlotCard in D1 shows ✉ +1 queued on next poll
```

### F5. Spawn a new agent
```
D1 ⊕ Spawn ─► D3 pick assistant ─► details (name) ─► Spawn
  ─► D1 new card "Starting…" ─► polls → Idle ─► optional: assign first task
```

### F6. Lost trust / re-pair
```
Any poll returns auth failure ─► ConnectionBanner "NATE-PC no longer trusts this phone"
  Re-pair ─► P2 (scan) ─► P3 ─► back to the screen user was on
```

---

## 8. Loading / empty / error states (every screen)

| State | Treatment |
|---|---|
| First load (no cache) | Skeleton cards (3 rows), not spinners |
| Cached + refreshing | Show cache immediately; FreshnessIndicator handles the rest |
| Empty | Illustration-free: one line of copy + one primary action |
| Offline | Dimmed cached data + ConnectionBanner; mutations disabled |
| Mutation failed | Inline on the item (red ! + retry) + toast; never a blocking alert |
| Item removed remotely (task deleted, agent shut down while viewing) | Inline notice "This agent was removed" + `Back` |

Cache the last successful run-state, conversations, and tasks per host on device so cold starts render instantly (encrypted at rest — follow the engineer's storage scheme).

---

## 9. Accessibility

- All status = color + icon + text; contrast ≥ 4.5:1 for text, ≥ 3:1 for status dots against surface (palette above chosen for this — verify in both themes).
- Dynamic Type up to 200%: cards wrap, never truncate the agent name; mono code blocks scroll horizontally.
- Screen reader: SlotCard reads as one element: "Mobile Engineer, Working, task Scaffold React Native app, 2 queued messages. Double-tap for details. Actions available." with custom actions (Message, Stop turn).
- FreshnessIndicator is **not** live-announced every second; announce only state transitions (stale / reconnected) via `AccessibilityInfo.announceForAccessibility`.
- Swipe gestures on tasks always have button equivalents.
- Respect Reduce Motion (no pulse, no flash highlight — use a static "Updated" dot instead).

---

## 10. Data contracts the UI expects (TypeScript, **[ASSUMED]** — align with backend)

```ts
type SlotStatus =
  | 'working' | 'idle' | 'blocked' | 'starting' | 'stopping' | 'error' | 'offline';

type BlockedReason =
  | { code: 'permission_prompt'; promptId: string; tool: string; argsPreview: string }
  | { code: 'awaiting_user_reply'; messageId: string; preview: string }
  | { code: 'blocked_by_task'; taskId: string }
  | { code: 'waiting_for_teammate'; slotId: string }
  | { code: 'rate_limited' | 'provider_error'; retryAt?: number; detail?: string }
  | { code: string; detail?: string }; // unknown → render raw

interface RunState {
  teamId: string;
  teamName: string;
  serverTime: number;          // ms epoch — use for "Updated Xs ago", not device clock
  slots: Array<{
    slotId: string;
    name: string;
    role: 'lead' | 'teammate';
    assistantId: string;
    model?: string;
    status: SlotStatus;
    blocked?: BlockedReason;   // present when status === 'blocked'
    currentTaskId?: string;
    queuedMessages: number;    // unread mailbox count
    turnStartedAt?: number;
  }>;
  pendingApprovals: number;    // drives banner + badge without a second call
}

interface PermissionPrompt {
  promptId: string; slotId: string; tool: string;
  args: unknown;               // rendered as pretty JSON / command string
  cwd?: string; reason?: string; createdAt: number;
  alwaysAllowRule?: string;    // exact rule text for "Always allow" button
}
type PromptDecision = 'allow_once' | 'allow_always' | { deny: true; message?: string };

interface TeamMessage {
  messageId: string; fromSlot: string | 'user'; toSlot: string | '*';
  type: 'message' | 'shutdown_request' | 'system';
  content: string;             // markdown
  files: string[]; createdAt: number;
}

interface Task {
  id: string; subject: string; description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string; blockedBy: string[]; blocks: string[];
}
```

Blocked "awaiting_user_reply" requires the backend to know an agent is waiting on the human —
if that signal doesn't exist, D1 falls back to "Idle · last message to you 2m ago" and Chat
shows the unread dot.

---

## 11. Out of scope for v1
Push/local notifications, background refresh, file viewing/attachments, multi-select bulk task
edits, tablet split-view layouts (phone layout scales up; `supportsTablet` stays true),
relay/remote-network pairing UI, editing assistants/MCP/skills config.

---

## 12. v1 build decisions (reconciled with the Mobile Engineer's implementation)

These override earlier sections where they conflict.

1. **Confirmations** — native alert for ≤3 choices, custom sheet for more (§4.10). Accepted.
2. **"Device passcode only"** can't be enforced on iOS or Android; the OS may still offer
   biometrics first. The picker option carries a description saying so. Accepted.
3. **Deferred until the API exists** (hide the control entirely — no disabled stubs):
   loading older messages in a thread (C2 shows the most recent page only), "Related messages"
   on T2, Force shutdown after `shutdown_rejected` (show the reason + `Keep running` only),
   Rename and Clear context in the D2 ⋯ menu, and `✎ New` solo conversation.
4. **"📋 Task assigned" card** — real messages embed the id: `Task assigned to you (#<task-id>): …`.
   Parse it with `/\(#([0-9a-f-]{8,})\)/i`; if found **and** the task is in the cached task list,
   open T2 for that task. Otherwise fall back to the Tasks tab. (The mock message in
   `mockApi.ts` omits the id — add it so the deep-link path gets exercised.)
5. **Approvals inside a thread (C2)** — the "Wants to run…" card above the composer covers the
   thread's own agent, so the ApprovalBanner is hidden in C2 *only for that agent's prompts*.
   If other agents have pending approvals, still show the banner with their count
   (`✋ 1 other approval waiting`), so the user never loses sight of a blocked agent while chatting.
6. **Task descriptions (T2)** — render with the same `Markdown` component chat bubbles use
   (agents write task descriptions in Markdown: lists, code, headings). Keep the 12-line
   collapse + "Show more"; measure on the rendered Markdown container height instead of
   `onTextLayout` line count.
7. **"They don't match" (P3)** — abort the request loop, clear the pending offer, persist nothing
   (the host record is only saved after *both* user match and PC approval). The phone's
   long-term identity key is kept; it was never exposed. Abort-screen copy must also tell the
   user to act on the PC: *"On your PC, choose 'Doesn't match' — or if you already approved,
   remove this device in AionDX → Settings → Mobile."* A MITM'd PC may otherwise keep trusting
   the attacker's key.

---

## 13. Visual review of the web-preview screenshots (`docs/design/screenshots/`, 390 pt + 320 pt, light + dark)

Overall, layout, hierarchy, section order, banners and dark mode match the spec. Fixes are
listed by priority. File numbers refer to the screenshots.

**Must fix**
1. **Status text contrast (04–06, 11, 17).** Use the `st*Text` tokens for status-colored text (§3.1).
   Worst cases: the amber "Waiting on task…" line and "⛓ blocked by 1" (3.3:1), and the
   "Needs you" / "Working" pill labels (~3.0:1).
2. **Approval sheet buttons in the thumb zone (07, 21).** Pin Allow once / Always allow / Deny /
   Deny with message… to the bottom of the sheet as a fixed footer, and scroll only the
   header + command + context above it. Today the buttons sit in the top half and drift lower
   as commands get longer.
3. **"Always allow" button at 320 pt (21).** Its label wraps, sits top-left and touches the
   button edge. Center the label, allow up to 2 lines, and use min-height 44 with vertical
   padding 12. If it's still longer than 2 lines, truncate the middle of the rule text, and
   put the full rule in a caption line under the button (`Creates rule: Bash(npx expo install:*)`)
   so the user always sees exactly what they're allowing.
4. **Task detail footer (13).** "Delete" sits next to "Mark done" at equal size and weight, in the
   thumb zone. Remove Delete from the footer; it lives in the ⋯ menu (§6.9). The footer becomes
   `[Message owner]` + `[Mark done]`.
5. **Segmented control selected state (11, both themes).** Selected "Open 2" renders as grey
   text in a grey outline, which reads as *disabled*. Use the same selected style as the
   Team/Solo control on Chat (08): primary 12% tint background, primary-colored text, 600 weight.
   Use one shared component for both.

**Should fix**
6. **"↓ N new" pill (10).** Center it horizontally, 12 pt above the composer, as a surface-colored
   pill with a hairline border and shadow (primary text and arrow). While it's visible, add
   matching bottom padding to the list so the newest bubble can scroll fully clear of it.
   Today it sits right-aligned and covers own-bubble timestamps and send ticks.
7. **Zero queue count (04–06).** Hide "✉ 0" (§4.4: 0 → hidden). If the meta line is then empty
   (no queue, not in a turn), drop the line.
8. **Question preview is monospace (04, 17).** "Should the README target…" is prose and should
   use `caption` in the regular font with `textMuted`. Keep mono only for command/args previews.
9. **Summary chips (04, 20).** Show every non-zero status, including **Error 1** (currently
   missing), with a status dot in each chip. Keep the order of the dashboard sections: Needs
   you, Error, Waiting, Working, Idle, then Tasks.
10. **Owner row on task detail (12).** The "Idle" pill floats at the card's top-right edge,
    colliding with the border and chevron. Put it inline after the name: `(ME) Mobile Engineer [○ Idle]  ▾`.
11. **Toggle color (15, both themes).** The switch track is teal, which isn't a palette token.
    Use `primary` for the on-track and thumb (`trackColor.true` / `thumbColor` / iOS
    `ios_backgroundColor`). Also disable "Require Face ID to approve" when "No lock" is selected.
12. **Revoked state (19).** When `device_revoked`, stop polling. The freshness line should read
    "Not connected" with no spinner, the ApprovalBanner should hide (nothing can be approved),
    and the banner icon should change from cloud-off to a broken-shield/key so it differs from
    "can't reach".
13. **Offline approval banner (18).** While unreachable, dim the ApprovalBanner like the rest
    of the data and mute the "Review ›" color. Tapping still opens the inbox read-only, with
    actions disabled as in §4.8.

**Nice to have**
14. **Empty header bar on P4 (15).** P4 shows an empty white header strip. Hide the header
    completely (`headerShown: false`), since Back is disabled there anyway.
15. **Code blocks in bubbles (09, 22).** Add a 16 pt right-edge fade when the content scrolls
    sideways, so the cut-off "3000" reads as scrollable rather than clipped.
16. **Description collapse (12).** Add a 24 pt fade above "Show more" so the cut-off point
    after the "Notes" heading looks intentional.

**Needs a device (not verifiable on the web):** Dynamic Type at 200%, the native alert's
default button, the iOS sheet detent at ~70%, the haptics in P2, the camera-denied → Open
Settings swap, and the app-switcher blur on the lock screen.

**Re-review (recaptured screenshots):** all 16 items verified as fixed in light and dark.
One follow-up nit, low priority:
- 15b: when "No lock" disables the approval toggle, the row label stays at full contrast, so it
  reads as *off* rather than *unavailable*, and in dark mode the disabled track nearly vanishes.
  Dim the label to `textMuted`, use `border` for the disabled track, and add the caption
  "Needs an app lock". Re-enabling a lock should restore the toggle's previous value.
  **Resolved** (verified in recaptured 15b, light + dark).

---

## 14. Rev 2 design additions (bridge contract rev 2, updated for rev 3)

Source: `docs/bridge-api-contract-v1-draft.md` rev 3 (§6.3–6.7; rev 3 answers folded in) and the "Rev 2 readiness" section
of `docs/bridge-contract-v1-review.md`. This section overrides §4, §6 and §10 where they conflict.
**Not covered here (waiting on sign-off):** the re-key QR flow and the passcode-only confirm UX.
Wherever an action is "sensitive" (contract §5), this spec only says where it lives; how the
confirmation looks is decided later.

All new UI uses existing tokens and components. Every color below is given as a token, so light and
dark come for free. Any status-colored *text* uses the `st*Text` tokens (§3.1).

### 14.1 Agent and team states

#### 14.1.1 One display status per agent

The bridge sends several overlapping signals (`attention`, `shutdown`, `state`, `runtime`,
`blockedReason`). The card shows **one** status pill, picked by the first row that matches:

| # | Wire signal | Display status | Pill (icon · label) | Color token | Dashboard section |
|---|---|---|---|---|---|
| 1 | `attention: needs_answer` | needs_you | hand · "Question" | stNeedsYou | Needs you |
| 2 | `attention: needs_approval` | needs_you | hand · "Needs you" | stNeedsYou | Needs you |
| 3 | `attention: error` (runtime `failed` / `runtime_failed`) | error | x-octagon · "Error" | stError | Error |
| 4 | `shutdown.state: approved`, or `blockedReason: removing` | removing | spinner · "Removing…" | stTransition | Shutting down |
| 5 | `shutdown.state: requested` | shutting_down | spinner · "Shutting down…" | stTransition | Shutting down |
| 6 | `state: paused` | paused | pause · "Paused" | stWaiting | Paused |
| 7 | `state: running` | working | pulse-dot · "Working" | stWorking | Working |
| 8 | `state: starting`, runtime `pending`, or `blockedReason: runtime_starting` | starting | spinner · "Starting…" | stTransition | Working |
| 9 | `state: queued` | idle (+ queue) | hollow circle · "Idle" | stIdle | Idle |
| 10 | `state: idle` / runtime `dormant` | idle | hollow circle · "Idle" | stIdle | Idle |

- `blockedReason: session_stopped` doesn't get a per-agent status. The team banner covers it (§14.1.4).
- `shutdown.state: rejected` is **not** a status. The pill falls through to rows 6–10, and the card
  adds the "declined to shut down" block (§14.1.5).
- `your_turn` is **not** a status either. It's a quiet marker on top of whatever the pill says (§14.1.3).
- Priority reasoning: what the user can act on comes first (1–3), then a lifecycle change in
  progress (4–5), then what the agent is doing (6–10).

New dashboard section order: **Needs you → Error → Shutting down → Paused → Working → Idle**. The
"Waiting" section is removed (§14.2). The summary chips follow the same order; a chip only shows
when its count is > 0.

`docs/design/tokens.ts` is updated to match: `slotStatusStyle` has the new keys (`needs_you`,
`question`, `removing`, `shutting_down`, `paused`, `not_running`), and `dashboardSections` replaces
`statusSortOrder`. The app's copy in `src/theme` still uses the old keys (`blocked_user`,
`blocked_dep`), so it has to migrate along with the rev 2 mappers.

#### 14.1.2 Paused (`state: 'paused'`)

Work on the slot is paused on the PC. The contract has **no resume route**, so the phone only explains:
```
┃ (QE) QA Engineer             [⏸ Paused]
┃      Paused on your PC                    ← body, textMuted
┃      Write QA test plan for pairing…      ← currentTask.subject, if any
┃      ✉ 2 queued                           ← hide at 0
```
- Edge strip and pill: stWaiting / stWaitingText (the amber is free now that "Waiting" is gone).
- If `blockedReason` is also set (paused while `runtime_failed`, say), add a second line in
  stErrorText: "Runtime failed — check AionDX on your PC". The pill stays "Paused".
- D2 shows an info panel instead of Stop/Wake: "This agent is paused. Resume it from AionDX on your
  PC. Messages you send now are queued." The composer stays enabled, since sending only queues.
- Long-press actions: Message, View tasks. No Stop. Wake is hidden, because waking a paused slot
  isn't defined.

#### 14.1.3 `attention: 'your_turn'` (solo chats and the lead only)

This means the agent finished and replied after your last message. It's a soft signal: it doesn't
set `waitingOnUser`, it doesn't count toward the Agents tab badge, and it never moves a card into
the Needs you section.

- **Lead card (D1):** the reason line becomes `↩ Replied · your turn` in `primary`, with a
  secondary `[Reply]` button (opens the thread at the newest message). The pill still shows the
  actual state (normally Idle).
- **Chat list (C1), lead and solo rows:** a small `Your turn` chip (primary 12% tint, primary text,
  caption 600) to the right of the preview. It replaces the unread dot for that row; the unread
  count remains in the Chat tab badge.
- **Team picker:** a team whose `TeamSummary.attention` is `your_turn` gets the same chip. A team
  with `waitingOnUser` gets the ✋ chip in stNeedsYouText instead.
- It clears when the server's `attention` changes (after you reply or read). Don't clear it
  optimistically on open; the read marker POST does that on the server.

Attention marker reference (chat list rows, team picker, D2 header):

| attention | Marker | Token |
|---|---|---|
| needs_answer | `✋ Question` | stNeedsYouText on stNeedsYou 12% tint |
| needs_approval | `✋ Approval` | same |
| error | `⊗ Error` | stErrorText on stError 12% tint |
| your_turn | `Your turn` | primary on primary 12% tint |
| none | — (unread dot if `unread > 0`) | primary dot |

#### 14.1.4 Team `sessionStatus`

This is a team-level banner (`TeamSessionBanner`) on every tab that belongs to the team (Agents,
Chat team segment, Tasks). It sits **below** the ConnectionBanner and **above** the ApprovalBanner.
It doesn't show while the host is unreachable or revoked, because the team state is unknown then.

| sessionStatus | Banner | Style | Agents | Chat composer |
|---|---|---|---|---|
| `ready` | none | — | normal | normal |
| `starting` | spinner · "Starting AionDX App Team…" | surfaceAlt bg, textMuted | pills as sent (mostly Starting…) | enabled |
| `none` | ⏻ "AionDX App Team isn't running." `[Start]` | surfaceAlt bg, text; Start = primary text button | data dimmed to 60%; pill "Not running" (stUnknown, dash icon) | enabled, with a hint (below) |
| `stopped` | ⏻ "AionDX App Team was stopped." `[Start]` | surfaceAlt bg | same as `none` | enabled, with a hint |
| `failed` | ⊗ "AionDX App Team failed to start." + `details.error` from the last attempt, if known (caption, 2 lines + "more") `[Try again]` | stError 12% tint, stErrorText icon, text body | same as `none` | enabled, with a hint |

- **Start (rev 3, contract §6.3):** `[Start]` / `[Try again]` calls `POST /v1/teams/{t}/session`.
  It isn't sensitive, so there's no confirmation. While the request is in flight, the button shows
  a spinner and the banner switches to the `starting` row as soon as the response arrives.
  Starting an already-running team is a no-op, so a double tap is harmless. There's no Stop
  session on the phone in v1.
- **`503 team_session_failed`:** the banner shows the `failed` row with `details.error` as its
  caption (for example "Claude CLI not found"), and `[Try again]`. The same error from a chat send
  is handled the same way in the thread (§14.3.2: a failed system row with Retry).
- **Composer:** stays enabled, because sending a message starts the team automatically. When the
  session isn't `ready`/`starting`, the hint above the composer reads "Sending will start the team"
  (caption, textMuted). After the send, the banner moves to `starting` with the next change-feed
  update.
- While the session isn't `ready`/`starting`, the dashboard hides the summary chips and section
  headers and lists the roster flat under the banner (§16 #18).
- Approvals can't be pending in a stopped team (they're cancelled when turns end), so the
  ApprovalBanner simply won't appear.
- Agent controls (Stop, Wake, Shut down, Force remove, Spawn) are hidden while the session isn't
  `ready`; Start in the banner is the only team action then. Task reads keep working; task writes follow `tasks.write` as before.
- `activeRun.status: 'cancelling'` shows as a thin caption under the freshness line: "Stopping the
  current run…" (stTransitionText). No banner.

#### 14.1.5 Shutdown in progress, rejected, and force remove

Where the actions live:
- **Shut down…** is in the D2 ⋯ menu and the D1 long-press sheet. It's **hidden for the lead**
  (rev 2 returns `422 lead_not_allowed`). It opens a sheet with an optional "Reason (sent to the
  agent)" field (max 200 characters) and a `[Ask to shut down]` button (danger outline). It's a
  sensitive action (contract §5); the confirmation step is designed later.
- **Force remove…** appears **only** when `shutdown.state === 'rejected'`, and never for the lead.
  It lives in two places: the rejected block on the card, and the D2 ⋯ menu (danger text,
  last item). Also sensitive.

Visible states on the SlotCard and in D2:

```
requested                                approved / removing
┃ (QE) QA Engineer  [◌ Shutting down…]   ┃ (QE) QA Engineer      [◌ Removing…]
┃      Asked to shut down · 12s ago      ┃      Shutting down — removing from team
┃      "Duplicate of Researcher"         ┃      (card fades out when the roster drops it)
```
- **requested:** the reason line is in stTransitionText, plus the user's reason in quotes
  (textMuted) if one was given. Card actions other than Message are hidden. There's no Cancel
  (no route).
- **approved:** "Removing…". When the roster no longer includes the agent, the card animates out
  (200 ms fade + collapse; with Reduce Motion, it's simply removed) and a toast shows "QA Engineer
  was removed".
- **rejected:** the pill shows the real state (Working/Idle). Below the card's body, an inset block
  appears (surfaceAlt bg, radius 8, 4 pt stNeedsYou left edge):
```
│ ┌──────────────────────────────────┐ │
│ │ Declined to shut down · 2m ago   │ │  ← caption 600, stNeedsYouText
│ │ "I'm mid-way through the test    │ │  ← rejectReason, body, up to 3 lines + "more"
│ │  plan; done in ~10 min."         │ │
│ │ [ Keep running ] [Force remove…] │ │  ← secondary · danger outline
│ └──────────────────────────────────┘ │
```
  - **Keep running** dismisses the block on this phone (stored by `slotId` + `requestedAt`). The
    server keeps `rejected` until the next shutdown request or a removal, so it's dismissed
    locally. D2 still lists the rejection in Recent activity.
  - **Force remove…** opens an alert: title "Force remove QA Engineer?", body "This stops its
    process immediately. Work in progress in its current turn is lost. Its tasks stay on the board
    under 'Removed agent'.", buttons `Cancel` (cancel style) / `Force remove` (destructive).
  - In D2, the same block sits in the CURRENT section, above Tasks.
- A rejected block doesn't count as attention. The user was the one who asked, so a quiet inline
  note is enough.

### 14.2 The dashboard "Waiting" section: remove it, and keep the explanation as a reason line

**Recommendation:** drop "Waiting" as a section and a status. Show "waiting on a task" only as a
**derived reason line on Idle cards**.

Why:
1. **It's an inference, not a state.** The bridge doesn't report "blocked on a teammate/task". A
   top-level section that ranks above Working would present a client-side guess as if it were fact.
   Sections should reflect states the backend actually reports.
2. **`currentTask` alone is the wrong input.** `currentTask` is the agent's *in_progress* task. An
   agent that is truly waiting on a dependency usually hasn't started its task (it's `pending`),
   so `currentTask` is null. An agent whose in_progress task has an open blocker is often still
   working on it. So a rule based on `currentTask` + `blockedBy` would miss real waits and flag
   working agents.
3. **What the user needs to know is why an idle agent is idle.** That's what the reason line answers,
   and it needs no new section or color slot. Waiting on a teammate also isn't something the user
   needs to act on, so it doesn't belong above Working.

Derivation rule (client side; the task list is already cached from `/v1/changes` `task` entries
and `GET /v1/teams/{t}/tasks`):
- **Applies when** the agent's `state` is `idle` or `queued`, `attention` is `none`, it isn't shutting
  down, and it owns ≥ 1 open task (`pending`/`in_progress`; `openTaskCount > 0`).
- **AND** every one of those open tasks has ≥ 1 `blockedBy` task that isn't `completed` or `deleted`.
- **Shows:** `⧗ Waiting on "Build app screens per design spec"`, the subject of the first
  unfinished blocker of its oldest open task. When several tasks are involved, it adds "+ N more".
  Styling: stWaitingText, caption, hourglass icon. CTA `[View task]` (secondary) opens that blocker.
- **Otherwise** (some open task is unblocked but the agent is idle), no line. Idle with work
  available is normal between turns, and the queue / Wake affordances already cover it.
- If tasks haven't loaded yet, show no line rather than a spinner.

What changes elsewhere: the `blocked_by_task` / `waiting_for_teammate` copy in §6.2 is replaced by
this rule. The "Waiting" summary chip is removed. The `blocked_dep` status goes away; this line uses
`waitingReasonStyle` in `tokens.ts`. "Waiting for {teammate}" (no task involved) can't be
detected, so it isn't shown.

### 14.3 Chat with mixed senders

Replaces the message rendering in §4.6 and §6.7. **File chips are removed** (`files[]` is gone from
the wire; attachments are out of scope).

#### 14.3.1 Row types

| role / sender | type | Rendering |
|---|---|---|
| `user` | text | Right bubble, `primary` bg / `onPrimary` text (unchanged). |
| `agent` | text | Left bubble, `surface` bg, with the agent's avatar and name on the first row of a group (unchanged). |
| `teammate` | text | Left bubble, **`surfaceAlt` bg + 1 pt `border`**, with the *teammate's* avatar. The header line reads `Claude Code → Mobile Engineer` (caption 600, textMuted), always shown, even inside a group. Tapping the name opens that agent's D2 (`sender.slotId`); a null `slotId` (removed agent) means no link and the name in textMuted. |
| `teammate` + `notice.task_assigned` | text | Task card (existing system card): `📋 Claude Code assigned you a task` / subject / `View task ›`. The link uses `notice.taskId`; the regex is now a fallback only. |
| `system` / `team_system` + `notice.context_reset` | — | Full-width divider: `──── Context cleared · 14:02 ────` (caption, textMuted), with the line below it: "The agent doesn't remember messages above this line." Messages above stay visible and undimmed. |
| `system` / `team_system` (other) | text | Centered system card (existing style). Recognized shutdown mailbox texts keep their §4.6 cards. |
| `system` / `app` | tips, agent_status | Centered caption text, textMuted, no card, max 2 lines (for example "Agent restarted"). |
| any | `tool_call` | **Tool row** (§14.3.3) |
| any | `thinking` | **Thinking row**, collapsed (§14.3.3) |
| any | `plan` | **Plan row** (§14.3.3) |
| any | `other` | Hidden. In Settings → Diagnostics, a count of hidden rows. |

Grouping: tool, thinking and plan rows **don't break** an agent's message group. A teammate row
always starts a new group. A day divider and the context-reset divider also reset grouping.

**Unread divider:** when a thread opens with `unread > 0`, insert `──── New ────` (primary, caption
600) above the first unread `agent` row and scroll there. It disappears after leaving the thread.

#### 14.3.2 Message status

| status | Where | Rendering |
|---|---|---|
| `streaming` | agent text | The bubble grows in place (upsert by `messageId`). At the end of the text: a blinking `▍` caret (primary, 1 s period); with Reduce Motion, a static `…`. The meta line reads "Writing…" (textMuted) instead of a timestamp. Re-render at most every 150 ms. If the user is at the bottom, follow the growth. If they've scrolled up, don't move; show the pill `↓ New reply` (§13.6 style). |
| `done` | all | Normal timestamp. The caret disappears. |
| `pending` | user text only | The message reached the agent mid-turn and it hasn't read it yet. The meta line reads `○ Delivered · not read yet` (hollow check, textMuted). It isn't a warning and has no action. It becomes ✓ when the row turns `done`. |
| `error`, `error.source: 'agent'` | agent row (`type: tips`) | **Error bubble:** left-aligned like an agent bubble, `surface` bg with a 2 pt stError left edge. Header `⊗ <agent> hit an error` (caption 600, stErrorText); body `error.message` (body, text; 6 lines + "more"); `error.code`, if present, in mono caption, textMuted. **No retry**: the user simply sends again. Partial reply text in an earlier streaming bubble stays as it was. |
| `error`, `error.source: 'send_failed'` | system row (`type: tips`) | **Centered failed row**, not a bubble: `surfaceAlt` card, full width minus 32 pt, stError 12% tint border. Line 1 `⊗ Couldn't start a reply` (caption 600, stErrorText); line 2 `error.message` (caption, text, 3 lines + "more"); trailing `[Retry]` (secondary, small). Retry re-sends **the message that failed**, as a new send with a new `rid` (contract rev 3.1). Which message: `error.messageId` when it's set (solo chats and failed mid-turn deliveries). When it's null (team-member chats, failures from before the bridge was running), use the nearest `role: 'user'` row *before* the failed row in thread order. If there isn't one, hide Retry. The toast quotes that message's first line ("Retrying: 'Yes, expo-router…'"), so the user can see which one is being re-sent. After a successful retry, the row's Retry is replaced by a muted "Retried" caption, and the failed user bubble's mark (below) too, so one failure can't be re-sent twice. The failed row itself stays in history. |
| `error` | user text | A mid-turn delivery failed (AionCore moved the row from `pending` to `error`). The bubble keeps its normal style, plus a 1 pt stError border, and the meta line reads `⊗ Not delivered · Retry` (stErrorText). Tapping the mark runs **the same Retry** as the matching `send_failed` row (the one whose `error.messageId` is this message): one action, two entry points. If no matching row has arrived yet, the mark shows without "· Retry" until it does. |

**Delivery marks on the user's own bubbles** (meta line, right-aligned):

| Source | Mark |
|---|---|
| Local `sending` (before `POST` returns) | clock, bubble at 60% opacity |
| Local `failed` (the `POST` itself failed) | red ! + "Tap to retry" (stays local; never comes from the server) |
| `delivery: queued` / `queued_first` | clock + "Queued" |
| `delivery: midturn`, or row `status: pending` | `○ Delivered · not read yet` |
| `delivery: started`, or row `status: done` | ✓ |
| Row `status: error` (failed mid-turn delivery) | `⊗ Not delivered · Retry` (stErrorText); after a retry, `Not delivered · retried` (textMuted, no action) |

A later state always replaces an earlier one. If the change feed reports `done` before the
`POST` response arrives, show ✓.

#### 14.3.3 Tool, thinking and plan rows

These are compact rows aligned with the agent bubbles' left edge (indented past the avatar column),
with no bubble background, body/caption sized, min height 32, and a full-row tap target ≥ 44.

```
   🔧 Used Bash · npx expo install expo-camera        ← tool row, done
   ◌ Using Edit · src/app/_layout.tsx                 ← streaming (spinner)
   ⊗ Bash failed · exit code 1                        ← tool.status error → stErrorText
   ▸ Used 5 tools                                     ← 4+ consecutive tool rows collapse
   💭 Thought · tap to show                            ← thinking, collapsed
   📋 Plan updated · 3 of 5 done              ▸       ← plan
```
- **Tool row:** text is `Used <tool.title ?? tool.name>` plus ` · <tool.summary>` (single line,
  middle-truncated, mono for the summary). Icon and caption color are textMuted. Tap expands the
  row inline to show `title`, `status` and the full `summary` (wrapping, mono, `surfaceAlt` block,
  max 12 lines + "Show more"). There's no raw-payload view; for that, the user opens the PC.
- **Run of tool rows:** 4 or more in a row (with no text between) collapse into `▸ Used N tools`;
  tap to expand all.
- **Thinking row:** collapsed by default. While streaming: `💭 Thinking…` with animated dots.
  Expanded: the text in body italic, textMuted, inside a `surfaceAlt` block with a "Hide" link.
  Collapsed state isn't remembered between visits.
- **Plan row:** collapsed: `📋 Plan updated` + `· X of Y done` if the mapper can read entries from
  `raw`. Expanded: a checklist (☐ / ◐ / ☑, one entry per line, body). If it can't parse the plan:
  "Plan updated — open on your PC to view".
- The chat list preview (`LastMessage.text`) already reads "Used <tool>". Show it as is, in textMuted.

#### 14.3.4 Everyone (broadcast) thread

Your own broadcasts render as right bubbles. The meta line summarizes deliveries:
`✓ Delivered to 5` / `Delivered to 4 · 1 queued` / `⊗ 1 failed` (stErrorText). Tapping the meta
line opens a sheet with one row per agent: avatar, name, a delivery pill (Delivered / Queued /
Failed) and the `error` text in caption. A failed row has `[Send to <name>]`, which opens that
agent's thread with the text prefilled.

#### 14.3.5 Questions and approvals inside a thread

When the thread's agent has a pending approval, the existing sticky card above the composer stays.
Its copy depends on `kind`: permission → `Wants to run Bash… [Review]`; question → `Has a question:
"<first question, 1 line>" [Answer]` (opens §14.5).

### 14.4 Approval sheet with an option list

This replaces the fixed three buttons in §4.7. The footer is still pinned (§13.2).

```
┌──────────────────────────────────────┐
│ (AD) App Designer wants to run  2m   │
│      Bash   [Execute]                 │  ← title ?? toolName; commandType chip
│ ┌──────────────────────────────────┐ │
│ │ npx expo install expo-camera &&  │ │  ← inputSummary, mono, wraps
│ │ npx expo prebuild --clean        │ │
│ └──────────────────────────────────┘ │
│ Why: "Need camera for QR pairing"    │  ← input.description, only if present
│ Show full input ›                    │  ← pretty JSON of input, only if it has other fields
├──────────────────────────────────────┤  ← pinned footer starts
│ [            Allow once            ] │  ← first allow_once: primary
│ [ Always allow                     ] │  ← allow_always: secondary + caption (see below)
│   Scope decided by App Designer      │
│ [        Deny and don't ask        ] │  ← reject_always: danger outline
│ [               Deny               ] │  ← reject_once: danger outline
│        Deny with message…            │  ← link; expands a reason field
└──────────────────────────────────────┘
```

**Removed:** the "Working dir" line (`cwd` isn't on the wire), and the "Creates rule" caption
except when `option.rule` is non-null (never, today).

**Command block:** `inputSummary` if present. Otherwise a pretty-printed `input` (mono, 2-space
indent, wrapped, max 16 lines then "Show full input"). The `commandType` chip: `execute` →
"Execute" (stNeedsYouText on its tint), `edit` → "Edit" (primary), `read` → "Read" (stIdleText).
Hide the chip for unknown values or null.

**Options → buttons:**
- Order: **allow kinds first, then `other`, then reject kinds**, keeping the agent's order within
  each group. This keeps the primary action in the same place every time and puts the rejects
  next to each other.
- Styles: the **first** `allow_once` → primary filled. Any further `allow_*` and every `other` →
  secondary (`surfaceAlt`). `reject_*` → danger outline.
- The label is `option.label` verbatim: centered, up to 2 lines, min height 44.
- If there are more than 4 options, the footer itself scrolls (max 55% of the sheet height), and a
  fade shows at its bottom edge.
- Captions under `allow_always` (caption, textMuted):
  - `rule` non-null → `Creates rule: <rule>` (mono).
  - `alwaysScope: backend_defined` → `Scope decided by <agentName>`.
  - `alwaysScope: same_as_once` (Claude agents) → **decided (sign-off #9): relabel.** The button
    reads "Allow (this agent will ask again)", secondary style, no caption, and answers with that
    option's `optionId`. The backend's own label is not shown. No flag, and it's never hidden.
- Tapping a button answers with `{optionId}`. While the answer is in flight, all buttons are
  disabled and the tapped one shows a spinner.
- `422 ambiguous_decision` (only from the inbox quick actions) opens this sheet using
  `details.options`.
- `409 already_resolved` → the existing "Already handled on PC" state.

**Deny with message… (rev 3, contract §6.5):**
- The `Deny with message…` link sits under the option buttons. Tapping it expands a multiline
  field in the footer (placeholder "Tell <agent> why, or what to do instead"; 4 lines visible,
  max 2,000 characters, with a counter from 1,800). Every reject button in the footer then reads
  `<label> with message` and sends `{optionId, message}`. Allow buttons are disabled while the
  field has text, since a message is only valid on a refusal (the server would return `400`).
  Clearing the field restores them.
- Caption under the field (textMuted): "Sent to <agent> with the refusal." There's no promise
  about *how*; the result tells us.
- **After the answer**, the toast depends on `messageDelivery`:
  - `native` → "Denied. <agent> got your reason."
  - `followup` → "Denied. Your reason was posted in the chat." with an `Open chat` action. The
    thread then shows it as your own bubble, `Denied <tool>: <message>`, which is expected; no
    extra styling.
  - `null` with `details.messageError` → the deny still stands. Toast in stErrorText: "Denied, but
    your message wasn't delivered." with `Open chat`, which opens the thread with the composer
    prefilled with the message.
- Inbox quick `[Deny]` never carries a message. A reason always goes through the sheet.

**`input: null`: open on PC, no Allow.**
```
│ (AD) App Designer wants to run  2m   │
│      Bash                             │
│ ┌──────────────────────────────────┐ │
│ │ 🖥  Open AionDX on NATE-PC to see │ │  ← surfaceAlt panel, body
│ │    the full command.             │ │
│ │    This phone didn't receive the │ │  ← caption, textMuted
│ │    details, so it can't be       │ │
│ │    allowed from here.            │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ [               Deny               ] │  ← only reject_* options are rendered
```
- Every `allow_*` and `other` option is hidden (an `other` option could approve).
- If there are no reject options, the footer shows a single secondary `[Close]`.
- The inbox card for this approval shows `[Deny]` and `Open on PC` (caption) instead of
  `[Allow once]`.

**Inbox quick actions (A1):** a card shows inline `[Deny] [Allow once]` only when `input` is
non-null **and** the options contain exactly one `allow_once` and one `reject_once`. Otherwise it
shows a single `[Review]` button that opens the sheet. Solo-chat approvals (no `teamId`) are listed
in their own "Solo chats" group under the team groups; the card subtitle is the conversation name.

### 14.5 Question sheet (`kind: 'question'`)

Opened from: the `needs_answer` card CTA `[Answer]` (D1, replaces Review/Reply), the Approvals inbox
(questions are listed alongside permissions with a `?` icon), and the thread's sticky card. The
ApprovalBanner copy counts both kinds: `✋ 1 question · 1 approval waiting`.

```
┌──────────────────────────────────────┐
│ ────                                 │
│ (DW) Docs Writer asks           1m   │
├──────────────────────────────────────┤  ← scrolls
│ AUDIENCE                              │  ← header, caption 600, textMuted, uppercase
│ Who should the README target?        │  ← question, headline
│ ◉ End users                          │  ← single-select: radio
│   Install + first run only           │  ← description, caption textMuted
│ ○ Contributors                       │
│   Build, test and release steps      │
│ ○ Other…                             │  ← only when approval.freeText
│                                      │
│ SECTIONS                (choose any) │  ← multiSelect hint, right-aligned caption
│ Which sections should it include?    │
│ ☑ Quick start                        │  ← multi-select: checkbox
│ ☐ Configuration                      │
│ ☑ Troubleshooting                    │
├──────────────────────────────────────┤  ← pinned footer
│ [           Send answers           ] │  ← primary; disabled until every question answered
│ [             Decline              ] │  ← secondary
└──────────────────────────────────────┘
```
- **Layout:** all questions are stacked in one scroll, each in its own section, 24 pt apart.
  Claude sends at most 4, so no pager is needed. With more than one question, the header reads
  "Docs Writer has 2 questions".
- **Option rows:** full-width rows, min height 48. The whole row is the tap target. Radio or
  checkbox in primary; the selected row gets a primary 12% tint background. The description is
  optional (caption, textMuted, up to 3 lines).
- **"Other…" (rev 3):** shown on every question **only when `approval.freeText` is true** (Claude
  agents). For other agents only the offered options are valid, so the row isn't shown.
  - Selecting it reveals a multiline field under the row (2 lines visible, grows to 5; max 2,000
    characters, counter from 1,800), focused. The text is trimmed on send.
  - Single-select: Other deselects the offered options, and picking an option collapses Other
    (the typed text is kept as a draft).
  - Multi-select: Other adds to the checked options, and the text is sent alongside them.
  - At most one free-text string per question; there's one field, so that's guaranteed.
- **Send answers** builds `{answers: [{question, labels}]}` in question order. `labels` holds the
  checked option labels, plus the trimmed Other text if present. It's enabled once every question
  has ≥ 1 selection, and any selected Other has non-blank text. It's a sensitive action (contract
  §5); the confirmation is designed later.
- **Decline** sends `{decline: true}`. Below it, an `Add a note…` link expands a field (same limits
  as the deny message), and the button becomes `Decline with note`, which sends
  `{decline: true, message}`. Declining is never gated, so there's no alert. Toasts:
  - no note → "Declined — Docs Writer will continue without an answer";
  - `followup` → "Declined. Your note was posted in the chat." with `Open chat`;
  - `null` + `messageError` → same failure toast as deny (§14.4).
- **Results:** `200` → the sheet closes and a toast shows "Answer sent". `409 already_resolved` →
  the "Answered on your PC" state, auto-closing after 1.5 s.
- **Drafts:** selections persist for the session if the sheet is dismissed by swipe, keyed by
  `approvalId`.
- **Accessibility:** each question is a radiogroup or a group of checkboxes, labelled by its
  question text. The multi-select hint is part of the label ("choose any").

### 14.6 Task owner "user" → "You"

- **Display:** `owner === 'user'` renders as **"You"**, with a person-icon avatar in primary 12% tint
  (not initials). On TaskCard and T2, the owner chip uses primary text so your own tasks stand out
  in a list of agent-owned ones.
- `owner` set but `ownerName` null (removed agent) → "Removed agent", dash avatar, textMuted.
- `owner` null → "Unassigned" (unchanged).
- **Owner filter (T1)** replaces §6.8's "Anyone / Me (unassigned) / each teammate". The order is:
  **Anyone · You · Unassigned · <each teammate, roster order> · Removed agents** (the last only if
  any task has one). "You" = `owner === 'user'`. "Unassigned" = `owner === null`. The old "Me"
  label is gone; it meant "unassigned", which was misleading.
- **Owner picker (T3, T2):** order: You, Unassigned, then agents with status pills.
  - **No "Notify owner" checkbox (rev 3).** The bridge posts the "📋 Task assigned" notice
    automatically, with "user" as the sender: on create with an owner, on an owner change, and to
    a downstream task's owner when completing a task unblocks theirs. T3 shows a caption under
    the owner picker instead: "<name> will be notified." (hidden when the owner is You or
    Unassigned). A matching toast after saving: "Task created · Mobile Engineer notified".
  - In the owner's chat, these notices render as the task card (§14.3.1), with sender "You".
  - T2's `[Message owner]` is hidden when the owner is You or unassigned. In its place,
    `[Mark done]` takes the full width.
- **D1:** the "Tasks" summary chip shows `Tasks 3 · 1 yours` when any open task is yours. Tapping it
  opens T1 filtered to You if any are yours; otherwise it opens Anyone.

### 14.7 Open items: resolved in contract rev 3

All five bridge questions are answered and folded in above, and sign-off #9 is decided.

| Item | Answer (contract rev 3) | Where it landed |
|---|---|---|
| (a)1: deny with a message | Yes. Optional `message` ≤ 2,000 characters, only on refusals (deny, `reject_*`, decline). `messageDelivery` is `native` or `followup` | §14.4 deny field and toasts; §14.5 decline note |
| (a)3: does task create notify the owner? | Yes, automatically (also on owner change and on unblock), sender "user" | §14.6; T3's checkbox removed (§6.10) |
| (a)5: free text in question answers | Only when `Approval.freeText` (Claude); one string ≤ 2,000 characters per question, combinable with labels in multi-select | §14.5 "Other…" |
| (a)6: start a team session / sends while stopped | `POST /v1/teams/{t}/session` (not sensitive); sends auto-start; `503 team_session_failed` with `details.error`; no stop | §14.1.4 Start / Try again, composer stays enabled |
| (a)8: `pending` / `error` message status | `pending` = the user's message was delivered mid-turn, not yet read. `error` carries `{source, code, message}` | §14.3.2 |
| Sign-off #9: "Always allow" on Claude agents | Decided: relabel to "Allow (this agent will ask again)" | §14.4 |

Light/dark check: every new element uses existing tokens. The only new color pairings are the
teammate bubble (`text` on `surfaceAlt`: 16.2:1 light, 13.0:1 dark) and the primary-tint chips
(`primary` on its 12% tint: 4.77:1 light on surface, 4.51:1 on the page background, 5.13:1 dark).
The rejected-shutdown block puts stNeedsYouText on `surfaceAlt` (4.82:1 light, 6.9:1 dark). All
pass at least 4.5:1. Put primary-tint chips on `surface` where possible, since 4.51:1 on the page
background has no margin.

---

## 15. Confirmations, passcode-only phones, re-key, and "Always allow" (sign-offs #3, #8, #9)

Source: contract rev 3.1, §5–§5.4 and §6.5. Nathan signed off all nine §11 items as recommended.
This section overrides earlier ones where they conflict. In particular, the client-side "Require
Face ID to approve" toggle (§6.1 P4, §6.11 S1/S3, §13.11, the 15b work) is **removed**: the bridge
now enforces confirmation, so a client-side toggle would only add confusion.

Terms used below:
- **Confirmation:** the OS unlock prompt (Face ID, Touch ID, fingerprint, or the device passcode)
  that runs right before a sensitive request is sent. Unlocking reads `confirmKey`, which signs
  that one request.
- **Confirm mode (per PC):** `biometric`, `device_passcode`, `none`, or **Off** (the PC set
  `requireConfirm = false` for this phone; read from `GET /v1/host` → `device.requireConfirm`).
- **App lock** (§6.1 P4, the lock screen, S3) **stays**, unchanged except that the auto-lock is
  capped at 5 min. Contract §5.1 relies on it as the only control on chat send: sending to an agent
  in YOLO mode is as powerful as an approval, and chat send isn't confirmed per message. App lock
  is about opening the app, not
  sending a request.

### 15.1 Sensitive-action confirmation (sign-off #3)

#### 15.1.1 Which buttons confirm

| Action | Button(s) | Where | OS prompt text (`promptMessage` / Android title) |
|---|---|---|---|
| Allow an approval | every `allow_*` and `other` option button; the inbox's `[Allow once]` quick action | §14.4, A1 | "Allow Bash for App Designer" |
| "Always" variants | the `allow_always` button (incl. "Allow (this agent will ask again)") | §14.4 | "Always allow Bash for App Designer" (relabelled: "Allow Bash for App Designer") |
| Answer a question | `[Send answers]` | §14.5 | "Send answers to Docs Writer" |
| Spawn | `[Spawn]` | §6.4 D3 | "Add UI/UX Designer 3 to AionDX App Team" |
| Polite shutdown | `[Ask to shut down]` | §14.1.5 | "Ask QA Engineer to shut down" |
| Force remove | the alert's `Force remove` | §14.1.5 | "Force remove QA Engineer" |
| Clear context | the alert's `Clear context` | D2 ⋯ | "Clear QA Engineer's context" |
| Delete task | the alert's `Delete` | T2 ⋯ | "Delete task “Publish bridge API schema”" |

**Clear context alert** (D2 ⋯, now that the route exists): title "Clear QA Engineer's context?",
body "It starts a fresh session and forgets this conversation. Your chat history stays visible
here, and unread messages are kept.", buttons `Cancel` / `Clear context` (destructive). After it
succeeds, the thread shows the "Context cleared" divider (§14.3.1).

**Never confirmed:** deny, `reject_*`, decline (with or without a message), chat send, stop, wake,
rename, task create and edit, read markers, Start team.

- **Android subtitle:** "AionDX · NATE-PC". **iOS:** the prompt message only, since the OS adds the
  Face ID chrome itself. Names come from the live data and are truncated to 40 characters.
- **The button shows that it confirms.** Each button in the table gets a 16 pt leading glyph in the
  button's own text color: face-id or fingerprint for `biometric` (whichever the phone has), and a
  lock for `device_passcode`. There's no glyph when the mode is **Off**. Accessibility hint:
  "Requires Face ID" / "Requires your passcode". No extra caption text, so the footers keep their
  §13 sizes.

#### 15.1.2 The prompt moment

```
tap a sensitive button
  ├─ destructive action? its app-level step comes first:
  │     force remove / delete task / clear context → alert; shutdown → the reason sheet
  │     └─ Cancel → stop, nothing changes   └─ confirm ↓
  ├─ mode Off ─────────────────────────────→ send (no prompt)
  ├─ mode biometric ── read confirmKey (OS Face ID / fingerprint sheet)
  ├─ mode device_passcode ── LocalAuthentication prompt (passcode allowed), then read the key
  │
  ├─ success → button spinner, other buttons disabled → send (signed) → normal result handling
  ├─ cancel  → back to the sheet exactly as it was (§15.1.3)
  └─ error   → §15.1.4
```
- The OS prompt appears **immediately** on tap, with no intermediate app screen. Allow-type actions
  never get an extra app alert, so the user sees only one confirmation step.
- The key is read **once per logical request**. If the request itself has to be retried
  automatically (the 401 re-handshake, failover), the proof is recomputed from the key already in
  memory, without prompting again. The key is dropped from memory as soon as the request resolves.
  A *manual* retry by the user prompts again.
- **Inbox quick actions:** each `[Allow once]` gets its own prompt (no batching), as before.

#### 15.1.3 Cancel path

- OS prompt cancelled (Cancel button, swipe, app switched away): **nothing is sent and nothing
  changes.** The sheet stays open with its state intact (any typed note or selected answers too),
  and the buttons are re-enabled. Focus returns to the tapped button. No toast, since cancelling is
  a normal choice.
- Biometric not recognized: the OS handles its own retries inside the prompt. If it gives up
  (`authenticationFailed`), the result is the same as cancel, plus a toast: "Face ID didn't match.
  Try again."
- **Lockout** (too many failed attempts): toast "Face ID is locked. Unlock your phone with its
  passcode, then try again." The sheet stays open.

#### 15.1.4 Errors

| Situation | Response | What the user sees |
|---|---|---|
| The PC turned confirmations **on** after the phone last read `/v1/host` (the request went unsigned) | `428 confirm_required` | Refetch `/v1/host`. If a key is available: show the prompt **once**, automatically, with the same copy, and resend the signed request with the same `rid`. If there's no key (mode `none`): go to "Confirmations unavailable" (§15.1.5) with the copy "NATE-PC now requires confirmation for this." |
| The PC doesn't accept the proof (key replaced on the PC, the device was re-keyed from elsewhere, or a corrupted key) | `403 confirm_invalid` | No automatic retry. The PC's state flips to **Needs re-confirming** (§15.1.5). In the sheet, an inline error above the footer (stErrorText): "NATE-PC didn't accept this phone's confirmation. Re-confirm this phone to continue." `[Re-confirm…]` → §15.3. The approval stays pending, so nothing is lost. |
| Key unreadable when reading (biometrics changed: a face or fingerprint was added or removed) | the read throws locally | Same as `confirm_invalid`, but detected before sending. Copy: "Your phone's Face ID settings changed, so this phone needs to be re-confirmed on NATE-PC." |
| Passcode removed from the phone (mode `device_passcode`, and the enrolled level is now none) | detected before prompting | **Unavailable** (§15.1.5) with the copy "This phone no longer has a passcode." |
| `409 already_resolved` and the other answer errors | as §14.4 | unchanged |

#### 15.1.5 "Confirmations unavailable" state

This is per PC. It applies when the key is missing (`none`), invalidated (needs re-confirming), or
rejected (`confirm_invalid`), and `requireConfirm` is true. **Everything else keeps working:**
dashboard, chat, deny/decline, stop/wake, tasks (except delete), and Start team.

- **Sensitive buttons** are visible but disabled (40% opacity, glyph swapped for a lock-slash).
  Under the footer, a single line (caption, textMuted) reads `Confirmations unavailable ·
  Re-confirm…` (the link is primary). For mode `none`, the line reads `Needs a screen lock ·
  Learn more` instead, which opens §15.2.3.
- **Approval / question sheets** additionally show an inline notice at the top of the footer
  (surfaceAlt, 4 pt stNeedsYou left edge): "You can deny from here, but allowing needs this phone
  to be re-confirmed on NATE-PC." Deny keeps working. The notice carries the only `Re-confirm…`
  link in these sheets; the caption line above isn't shown there (§16 #7).
- **Menus and swipe actions** (long-press, ⋯, task swipe) don't render sensitive items as
  disabled. Tapping one shows the toast "Confirmations unavailable on NATE-PC" with a
  `Re-confirm` action (§16 D5).
- **No global banner.** The dashboard stays clean; the state shows up only where an action is
  blocked, plus:
  - a dot on the Settings tab and the PC's row in S2 (stNeedsYou);
  - a one-time toast when the state is first detected: "Confirmations need attention on NATE-PC"
    with `Fix`.
- Inbox `[Allow once]` quick actions become `[Review]`, so a disabled button never sits next to
  an enabled Deny.

### 15.2 Passcode-only phones and phones with no screen lock (sign-off #8)

The phone picks its mode at pairing from `LocalAuthentication.getEnrolledLevelAsync()`, and sends
it in the pair request. The PC shows the mode when approving the pairing.

#### 15.2.1 At pairing

**P1b (name this phone)** gets one caption under the name field, matching what the PC will show:

| Enrolled level | Caption (textMuted, with leading glyph) |
|---|---|
| biometric | (none) |
| passcode only | 🔒 "This phone has no Face ID or fingerprint set up. It will use its passcode to confirm sensitive actions. Your PC will show this." |
| none | ⚠ (stNeedsYouText) "This phone has no screen lock. You can pair it, but it won't be able to approve requests or manage agents." `Why?` → §15.2.3 sheet |

**P4 (after verify)**: the old "Require Face ID to approve" toggle is replaced by a read-only
**Confirmations** card under the lock options, using the same card style:
```
┌──────────────────────────────────────┐
│ Confirmations on NATE-PC             │  ← caption 600, textMuted
│ 🔒 Passcode (app-enforced)            │  ← body 600
│ Approving requests and managing      │  ← caption, textMuted
│ agents will ask for your phone's     │
│ passcode. Set up Face ID later and   │
│ re-confirm to switch.                │
└──────────────────────────────────────┘
```
- Biometric: "Face ID" (or "Fingerprint"), with the body "Approving requests and managing agents
  will ask for Face ID."
- None: stNeedsYou left edge, title "Not available on this phone", body "Set a screen lock on this
  phone, then re-confirm it on NATE-PC. Until then, you can still chat, deny requests, and manage
  tasks." `Learn more` → §15.2.3.
- The P4 lock options follow the same reality. "Face ID / fingerprint" is disabled on
  passcode-only phones (caption "Not set up on this phone"). With no screen lock, only "No lock"
  is selectable (caption "Set a passcode on your phone to use an app lock").

#### 15.2.2 The passcode prompt

For `device_passcode`, the app calls `LocalAuthentication.authenticateAsync` with:
- `promptMessage`: the §15.1.1 copy;
- `cancelLabel`: "Cancel";
- `disableDeviceFallback: false` (a passcode is allowed).

The OS draws the passcode screen, so the app adds nothing. Cancel, failure and lockout behave as
in §15.1.3, with "Face ID" replaced by "passcode" in the copy. Because enforcement is app-only,
Settings says so (§15.5), but there's no warning at the moment of action. That would be noise the
user can't act on.

#### 15.2.3 No screen lock: the explainer sheet

Opened from `Learn more` / `Why?` links and from the Settings row:
```
│ Why some actions are unavailable              │
│                                               │
│ AionDX asks you to confirm actions that let    │
│ agents run commands or change your team:      │
│ approving requests, answering questions,      │
│ adding, shutting down or removing agents,     │
│ clearing context, and deleting tasks.         │
│                                               │
│ This phone has no screen lock, so it can't     │
│ confirm them. Everything else still works.    │
│                                               │
│ To turn them on, either:                      │
│ 1. Set a passcode (and Face ID, if you like)   │
│    on this phone, then [Re-confirm this phone] │  ← → §15.3
│ 2. Or, in AionDX on NATE-PC, turn off          │
│    "Require confirmation" for this phone.     │
│    Anyone holding this phone could then       │  ← caption, stNeedsYouText
│    approve requests.                          │
│                                               │
│ [ Close ]                                     │
```
Option 2 is described, not linked, because it happens on the PC. When the phone sees
`requireConfirm` become false, the state changes to **Off** and the actions work without a
prompt (§15.5 shows it).

### 15.3 Re-key flow (§5.3)

Used when the key became unreadable (biometrics changed), when the PC rejects the proof
(`confirm_invalid`), to switch modes (for example passcode → Face ID after enrolling), or to get a
key for the first time after adding a screen lock (`none` → passcode/biometric).

#### 15.3.1 Entry points

1. **Inline:** the `Re-confirm…` link under any disabled sensitive footer, and `[Re-confirm…]` in
   the `confirm_invalid` error (§15.1.4).
2. **Settings:** S2 → the PC → **Confirmations** row → `Re-confirm this phone…` (§15.5). It's always
   available there, including when everything works, so the user can switch modes.
3. **The one-time toast's `Fix` action** (§15.1.5).
4. **Upgrade hint:** if the phone is in `device_passcode` mode and biometrics are now enrolled, the
   Confirmations row shows `Use Face ID instead…`, which starts the same flow.

All entry points open **R1** for that specific PC.

#### 15.3.2 Screens

Routes: `(app)/rekey/[hostId].tsx`, a full-screen modal holding R1–R4 as steps (stack inside the
modal), plus an optional `?from=` to return to after success. R2 reuses the P2 scanner component
(`(onboarding)/scan.tsx`'s camera view) with a `mode: 'rekey'` prop.

**R1, explainer** (full-screen modal, header "Re-confirm this phone", close ✕):
```
┌──────────────────────────────────────┐
│ ✕                Re-confirm          │
│                                      │
│ 🖥  NATE-PC                           │  ← headline; PC name
│ Confirmations: Needs re-confirming   │  ← current state, state color
│                                      │
│ 1  On NATE-PC, open AionDX →          │  ← numbered steps, body
│    Settings → Mobile                  │
│ 2  Choose "Nate's iPhone" →           │  ← this phone's paired name
│    Re-issue confirm key               │
│ 3  Scan the code it shows             │
│                                      │
│ This phone will use Face ID for      │  ← mode it will request (from the
│ confirmations.                       │    current enrolled level), caption
│                                      │
│ [          Scan code           ]     │  ← primary
└──────────────────────────────────────┘
```
- The flow needs a live session with that PC. While it's unreachable, `[Scan code]` is disabled
  with the caption "Connect to NATE-PC first (same network or your VPN)", and the
  ConnectionBanner shows as usual.
- If the enrolled level is `none`, R1 says "Set a screen lock on this phone first" with
  `[Open Settings]` instead of Scan. Re-key would only give `none` again.

**R2, scan:** the P2 scanner component (camera, viewfinder, permission states), with the title
"Scan re-confirm code" and the help line "On NATE-PC: Settings → Mobile → Nate's iPhone →
Re-issue confirm key". The scanner accepts `aiondx://rekey` only. Local checks before anything is
sent:

| Scanned | Result (haptic error + inline message under the viewfinder; the camera keeps running) |
|---|---|
| A pairing QR (`aiondx://pair…`) | "That's a pairing code. On your PC, choose **Re-issue confirm key** for this phone instead." |
| A re-key QR for a PC this phone isn't paired with | "This code is from a PC this phone isn't paired with." |
| A re-key QR for **another paired PC** | Sheet: "This code is for OTHER-PC, not NATE-PC. Re-confirm OTHER-PC instead?" `[Re-confirm OTHER-PC]` / `[Cancel]` |
| The right PC, but another phone's `deviceId` | "This code is for another phone paired with NATE-PC. On your PC, choose **Nate's iPhone**." |
| `x` (expiry) is in the past | "This code expired. Choose Re-issue confirm key on your PC again." |
| Anything else | "That's not an AionDX code." (the existing P2 copy) |

**R3, confirming:** after a valid scan, the frame freezes and a spinner shows "Confirming with
NATE-PC…". The phone sends `{proof, confirmMode}`, then stores the returned key under the new mode.
In `biometric` mode, storing it may show the OS prompt with the copy "Save confirmation key for
NATE-PC". Cancelling that prompt goes to the error "Not saved" with `[Try again]`, which re-stores
the key already received without re-scanning; if the app was closed meanwhile, the user rescans.

**R4, success:**
```
│                 ✓                     │  ← stWorking check, 48 pt
│      Confirmations are back on        │  ← title
│  NATE-PC · Face ID                    │  ← caption: PC + new mode
│                                      │
│ [            Done            ]        │
```
- `Done` returns to wherever the flow started. If it started from a blocked sheet (an approval,
  say) that's still pending, that sheet reopens with its buttons enabled. The action is **not**
  performed automatically; the user taps it again (and confirms).
- Toast if the origin closed meanwhile: "Confirmations are back on for NATE-PC".

**Errors (R3 → error state, same layout as R4 with a ⊗ in stError):**

| Error | Title | Body | Actions |
|---|---|---|---|
| `403 rekey_invalid` | "NATE-PC didn't accept this code" | "It may have been used already, or the scan didn't match. Re-issue a new code on your PC and scan again." | `[Scan again]` (→ R2) · `Cancel` |
| `404 no_rekey_offer` | "No re-confirm request on NATE-PC" | "Codes last 5 minutes and work once. On NATE-PC, choose Re-issue confirm key for Nate's iPhone again." | `[Scan again]` · `Cancel` |
| Wrong PC / device / expired | handled locally in R2 (above); never reaches R3 | | |
| Can't reach the PC / session error | "Couldn't reach NATE-PC" | "Check that your phone and PC are on the same network." | `[Try again]` (re-sends the same proof request if the code hasn't expired; otherwise → R2) · `Cancel` |

The PC limits a code to 5 attempts. The phone doesn't count them, since the server's error is
authoritative.

### 15.4 "Always allow" on Claude agents (sign-off #9): decided

Decided as **option B (relabel)**. §14.4 is updated, and the flag and option A are removed. When
an `allow_always` option has `alwaysScope: 'same_as_once'`:
- The label is **"Allow (this agent will ask again)"**, in the secondary style, with no caption.
- It answers with that option's own `optionId`.
- Its confirmation copy is "Allow Bash for App Designer", not "Always allow", since that's what it
  does.

### 15.5 Settings: confirm mode per PC

**S2 Paired PCs**, the row subtitle gains the mode:
`NATE-PC · LAN · Confirmations: Face ID`.

Each PC's detail (tap the row) gets a **Confirmations** row:

| State | Value text | Token | Row action / caption |
|---|---|---|---|
| biometric, key OK | "Face ID" / "Touch ID" / "Fingerprint" | text | caption "Asked before approving or managing agents." |
| device_passcode, key OK | "Passcode (app-enforced)" | text | caption "Checked by this app, not your phone's secure hardware. Your PC shows this too." + `Use Face ID instead…` if biometrics are now enrolled |
| Off (`requireConfirm: false`) | "Off on this PC" | stNeedsYouText | caption "NATE-PC lets this phone approve and manage agents without confirming. Change this in AionDX on your PC." |
| none (no key, required) | "Not available — no screen lock" | stNeedsYouText | `Learn more` → §15.2.3 |
| needs re-confirming (unreadable or rejected key) | "Needs re-confirming" | stNeedsYouText + dot | primary `[Re-confirm…]` |

Below the row: `Re-confirm this phone…` (a link, primary) → R1. It's hidden while the row is in
the "needs re-confirming" state, since the primary `[Re-confirm…]` button is shown then (§16 #8). S3 Security loses the
"Approve with Face ID" toggle and gets a single pointer row instead: "Confirmations are set per PC.
See Paired PCs."

### 15.6 Light / dark and tokens

There are no new tokens:
- **Glyphs** use the button's text token.
- **Disabled sensitive buttons** use 40% opacity of their normal style.
- **Warnings** (no screen lock, needs re-confirming, Off) use stNeedsYouText on `surface` /
  `surfaceAlt` (≥ 4.8:1 in both themes, per §14.7).
- **Errors** use stErrorText.
- **Success check** uses stWorking (a non-text mark, ≥ 3:1).

The OS prompts follow the system theme on their own.

---

## 16. Visual review of phase 2 (§14 / §15), web demo build

Screenshots: `docs/design/screenshots/phase2/{light,dark}/` (36 per theme). File names below
drop the `.png`; "both" means the issue shows in light and dark.

**Overall:** phase 2 matches §14/§15 closely. All the §14.1 states, the §14.3 chat rows, the
§14.4/§14.5 sheets, and the §15 unavailable / re-key / Settings flows are present and use the
right tokens, and dark mode matches light. I checked from code what isn't in the screenshots:
- P4 `ConfirmationsCard` and the lock-picker rules;
- the R2 local checks (wrong PC, another phone's code, pairing QR, expired);
- the R3 error screens (`rekey_invalid`, `no_rekey_offer`, unreachable, not saved);
- the one-time "needs attention" toast;
- the demo-only "Use the demo PC's code" button, which only appears for the demo host.

All present.

### 16.1 Fix list

**Must-fix**

1. **Agent avatar colors change inside threads** (`c2-thread-lead`, `c2-thread-mobile-top`,
   `c2-thread-agent-error`, both). Claude Code is teal on the dashboard and in the thread header,
   but orange next to its messages. Mobile Engineer and Perf Analyst turn purple. The cause:
   `MessageBubble.tsx:251` keys `Avatar` by `senderName` for `agent` rows (and by `slotId` only for
   teammate rows). Key agent rows by the thread's `slotId` (team chats) or `conversationId` (solo),
   the same id used in the header and on the SlotCard. The same agent must be the same color
   everywhere.
2. **The file path is shown twice on Write/Edit approvals** (`d1-dashboard-top` Mobile Engineer
   card, `a1-approvals-inbox` third card, `a2-approval-sheet-acp-options` heading,
   `c2-thread-mobile-top` sticky card). The ACP `title` already contains the path
   ("Write src/app/_layout.tsx"), and `inputSummary` repeats it underneath. Rule: when `title`
   contains `inputSummary`, use `toolName` ("Write") as the heading and reason text, and keep the
   path only in the mono line. Otherwise keep `title`. Result: "Waiting for approval: Write" /
   `src/app/_layout.tsx`.
3. **The shutdown dialog's confirm button is cut off** (`d2-shutdown-sheet`, both): "Ask to shu…".
   When two side-by-side dialog buttons can't fit their labels on one line, stack them: the action
   first (full width), Cancel below. Apply the same rule to every two-button dialog (clear context,
   force remove).
4. **Approvals inbox, question card** (`a1-approvals-inbox`, both):
   - The question preview uses the mono font; it's prose, so use `caption` in the regular font,
     as in §13.8.
   - The literal "?" before "Docs Writer" reads like a typo. Use the same `✋ Question` pill the
     dashboard card has (stNeedsYouText on its tint), placed where the timestamp row is.
5. **A disabled "Stop turn" shows on idle agents** (`d2-agent-menu`, `d2-shutdown-rejected`,
   both). A dead button sits in the second-most prominent spot. Per §6.3: show Stop turn only while
   `turn` is non-null. When idle with queued messages, show `[Wake agent]` instead. Otherwise show
   Message alone, at full width.
6. **The confirmation glyph reads as "scan / full screen", not Face ID** (`a1`, `a2-*`,
   `a3-question-sheet`, `d2-shutdown-sheet`, both). The corner-bracket icon is the only cue that a
   biometric prompt is coming (§15.1.1), so it has to be recognizable:
   - a Face ID glyph (face inside brackets) for Face ID;
   - fingerprint for Touch ID or Android fingerprint;
   - lock for `device_passcode`.

   Map them from `LocalAuthentication.supportedAuthenticationTypesAsync()`. If the web demo can't
   detect a type, fall back to the lock, not the bracket.

**Nice-to-have**

7. **Two Re-confirm links in one sheet** (`x-needs-reconfirm-approval`, both): the notice block
   has `Re-confirm…`, and the caption line at the bottom repeats it. When the notice block is shown
   (approval and question sheets), drop the bottom line. *(Spec fix: §15.1.5 updated by this item.)*
8. **PC detail when it needs re-confirming** (`x-needs-reconfirm-pc-detail`): the primary
   `[Re-confirm…]` and the `Re-confirm this phone…` link sit next to each other. Hide the link
   while the primary button is shown. *(Spec fix to §15.5.)*
9. **Input focus ring** (`p1b-name`, `a2-approval-deny-message`, `a3-question-sheet`,
   `d2-shutdown-sheet`): focused fields get a 2 pt `text`-colored border (black in light). Use a
   2 pt `primary` border, so focus looks the same as every other active state.
10. **"Waiting on…" line has no hourglass** (`d1-dashboard-middle`, both). Add the
    `waitingReasonStyle.icon` glyph before the text (§14.2), so the line isn't conveyed by color
    alone.
11. **Broadcast delivery summary** (`c2-thread-everyone`): `⊗ 1 failed` alone hides that the
    others got it. Use `Delivered to 4 · 1 failed` (§14.3.4), and make sure the line opens the
    per-agent sheet.
12. **The send-failed `Retry` is plain bold text** (`c2-thread-solo-failed`). Make it the small
    secondary button from §14.3.2 (`surface` fill, 1 pt `border`, 44 pt hit area), so it reads as
    tappable.
13. **"0 queued messages" with a chevron** (`d2-agent-menu`, `d2-shutdown-rejected`): show
    "No queued messages", with no chevron and not tappable.
14. **Paused agent detail** (`d2-agent-paused`): the CURRENT card "Paused on your PC" repeats the
    info line above it. Drop the CURRENT section when the only thing to say is "paused".
15. **Paired PCs row subtitle repeats the PC name** (`s2-paired-pcs`): "DEMO-PC (active)" /
    "DEMO-PC · LAN · …". The subtitle should read `LAN · Connected · Confirmations: Face ID`.
16. **Settings → Confirmations row** (`s1-settings`): with several PCs, "Confirmations: Face ID"
    doesn't say which PC. Label it `Confirmations · DEMO-PC` (the active PC), and open that PC's
    detail.
17. **Auto-lock stays active with "No lock"** (`s3-security`): disable the Auto-lock row (40%,
    caption "Needs an app lock") when No lock is selected, as in §13 15b.
18. **Team not running** (`d1-team-not-running`): the "Idle 1" chip and the IDLE section header
    describe agents that aren't running. While `sessionStatus` isn't `ready`/`starting`, hide the
    summary chips and section headers and list the roster flat under the banner. *(This comes
    from my `dashboardSections` token, which put `not_running` in Idle; spec fix in §14.1.4.)*
19. **Disabled secondary buttons almost disappear in dark** (`x-needs-reconfirm-approval` dark,
    "Allow (this agent will ask again)"). Keep the `surfaceAlt` fill at full strength and dim only
    the label and glyph (to `textMuted`), so the button's shape stays visible.

**Verify (likely capture artifacts)**

20. **No back button in several headers** (`d2-*`, `c2-thread-*` except `start-hint`,
    `s2-pc-detail`, `x-needs-reconfirm-pc-detail`). These were probably deep-linked for the capture.
    Check that a normal navigation shows `‹ Back` on every pushed screen.
21. **The `x-needs-reconfirm-toast` capture shows no toast** (both). The code is there
    (`(app)/_layout.tsx`, `confirm.tsx:176`). Please recapture while it's on screen, so its copy
    and `Fix` action can be checked.

### 16.2 Mobile Engineer's deferrals

| # | Deferral | Decision |
|---|---|---|
| D1 | No removal fade when an agent leaves | **Accept.** It's polish; the toast "QA Engineer was removed" carries the information. |
| D2 | Static streaming caret | **Accept.** "Writing…" in the meta line already says it's live (`c2-thread-mobile-bottom`). |
| D3 | No animated "Thinking…" dots | **Accept**, provided the static label reads "Thinking…" while streaming and "Thought · tap to show" once done (the latter is confirmed in `c2-thread-mobile-*`). |
| D4 | "Didn't match" / "locked" not distinguished from cancel | **Accept for `biometric` mode**, because `expo-secure-store` rejects the same way for all three. Two asks: **(a)** in `device_passcode` mode, `LocalAuthentication` does return distinct errors, so show the §15.1.3 lockout toast there; **(b)** in both modes, after 2 failed or cancelled prompts for the same action within 30 s, show one neutral toast: "Couldn't confirm. If Face ID is locked, unlock your phone with its passcode, then try again." |
| D5 | Sensitive items in long-press / ⋯ / swipe show an "unavailable" toast with Re-confirm, instead of rendering disabled | **Accept.** It's better than disabled menu rows, which give no reason on mobile. Keep the toast copy consistent: "Confirmations unavailable on DEMO-PC" + `Re-confirm`. *(Spec fix: §15.1.5 now allows this for menus and swipe actions; sheet footers stay disabled-with-reason.)* |

### 16.3 Re-review of the §16 fixes: **signed off**

Checked against `docs/design/screenshots/phase2-fixes/{light,dark}/` (26 per theme) and
`docs/phase2-handoff.md` → "§16 visual fixes". D4a isn't reachable in the web demo (it needs
passcode mode), so I checked it in code (`errors.ts` `cancelNotice`).

**Result: all 21 items, D4a/b and the D5 copy are verified. No must-fix items remain.** Phase 2
is visually signed off for both themes. Device-only checks (§13 list, the real Face ID /
fingerprint glyphs for #6, and the OS prompts) still wait for a dev build.

| # | Verified in | Note |
|---|---|---|
| 1 | `c2-thread-lead`, `c2-thread-mobile-top` | Same avatar color in the header, list and bubbles |
| 2 | `d1-dashboard-top`, `a1-approvals-inbox`, `a2-approval-sheet-acp-options`, `c2-thread-mobile-top` | "Write" + one mono path |
| 3 | `d2-shutdown-sheet` (both) | Stacked; full label visible |
| 4 | `a1-approvals-inbox` | Question pill, regular font, no stray "?" |
| 5 | `d2-agent-menu`, `d2-shutdown-rejected` | Message alone at full width when idle |
| 6 | `a1`, `a2-*`, `a3`, `d2-shutdown-sheet` | The lock fallback shows on web; lock-off when unavailable. Face ID / fingerprint glyphs are on the device-check list |
| 7 | `x-needs-reconfirm-approval` (both) | One Re-confirm link |
| 8 | `x-needs-reconfirm-pc-detail` | Link hidden while the primary button shows |
| 9 | `d2-shutdown-sheet`, `a3-question-sheet` | 2 pt primary focus ring in both themes |
| 10 | `d1-dashboard-middle` | Hourglass present |
| 11 | `c2-thread-everyone` | "Delivered to 6 · 1 failed" (see N3) |
| 12 | `c2-thread-solo-failed` | Retry is a secondary button |
| 13 | `d2-agent-menu` | "No queued messages", no chevron |
| 14 | `d2-agent-paused` | CURRENT section dropped |
| 15 | `s2-paired-pcs` | "LAN · Connected · Confirmations: Face ID" |
| 16 | `s1-settings` | "Confirmations · DEMO-PC" |
| 17 | `s3-security` | Auto-lock disabled with "Needs an app lock" |
| 18 | `d1-team-not-running` | Flat roster, no chips or headers |
| 19 | `x-needs-reconfirm-approval` (dark) | Secondary button shape stays visible |
| 20 | every pushed screen | ‹ Back present (a real deep-link bug, now fixed) |
| 21 | `x-needs-reconfirm-toast` (both) | Toast copy and `Fix` as specified |
| D4a | `errors.ts` | Passcode lockout / mismatch copy |
| D4b | `x-d4-neutral-hint` (both) | Inline in the sheet instead of a toast: **accepted** (better placement). See N2 for its style |
| D5 | `confirm.tsx` | "Confirmations unavailable on <PC>" + Re-confirm |

**New nice-to-haves** (found on this pass; none block the sign-off):

- **N1** (`d2-shutdown-rejected`): "Keep running" in the declined block is plain text. Give it the
  same small secondary button as Retry (#12), so the two choices look like a pair.
- **N2** (`x-d4-neutral-hint`, both): the D4b hint uses the error style (stError tint, stErrorText).
  A cancelled prompt isn't an error. Use the neutral notice style of the re-confirm notice
  (`surfaceAlt`, 4 pt stNeedsYou edge, `text` color), and clear it after the next successful
  confirmation.
- **N3** (`c2-thread-everyone`): the whole delivery line is red. Only the `⊗ 1 failed` part should be
  stErrorText; "Delivered to 6 ·" stays textMuted.
- **N4** (`c2-thread-mobile-top`): the sticky card reads "Wants to run Write…". Now that the heading
  is short, drop the ellipsis ("Wants to run Write"), so it doesn't look truncated.
