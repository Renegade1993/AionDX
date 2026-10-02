# 0001-renderer-dx: Loop control in the conversation composer

**Built against:** AionUi 2.2.2 · **Target:** renderer only · **Status:** live build `5C877C23...`,
installed September 23rd at 11:40 (the round button, explainer, backoff and resume). The source
now also carries K's reports of September 23rd (below), passes all 110 real-mouse checks in
`tools\dx-harness\click-test.js`, and goes live with the next "AionDX Apply Update".

## What it adds

A round loop button in the composer's action row, directly left of the Permission pill, the same
28 x 28 circle as the composer's "+" button: grey when off, tinted and ringed in the theme's
primary colour when on, amber while it holds back (a paused member sitting out a limit, or a
backoff). Hovering it for a third of a second, or tabbing to it, opens an explainer styled as
AionUi's own tooltips (Arco's tooltip classes, which AionUi restyles): what the Loop does, its five
rules (never while working; the backoff; waiting out a rate limit, teammates before the lead;
runs on any page; when it switches itself off), what the three colours mean, and the current
status or why it switched off. Team members and solo chats get their own wording. (It was a
labelled `Loop · Off` pill until 2026-09-23; a request, then *"we should include a tooltip on it's functionality when you hover
over it that explains all this"*.)
Clicking it opens a menu in the same style as the permission menu:

- **Keep working after each turn: On / Off**, with the same fixed check-mark slot the permission
  menu uses.
- **Continue message**, edited inline. This replaces the old right-click that opened a browser
  `prompt()` dialog, which nobody would find.
- A status line: `On. Sent 2 times, last 3 min ago.`, or why it turned itself off.

While on, it polls the conversation every 15 s. Once a turn has finished and the conversation has
been quiet for 20 s, and at least 60 s have passed since its last send, it posts the continue
message to `/api/conversations/{id}/messages`, the same call the send box makes. It turns itself off
after 3 sends that drew no reply. (Until 2026-09-24 it also turned off when you sent a message of
your own; see "K's reports" below.)

Screenshots, taken with AionUi's shipped CSS in `tools\dx-harness\shots\`:

| file | shows |
|---|---|
| `explainer-team-light.png`, `explainer-team-dark.png`, `explainer-solo-light.png` | the hover explainer: a team member holding back, and a solo chat that is off |
| `look-team-light.png`, `look-team-dark.png` | the round button in two team columns: on (primary) and holding back (amber) |
| `look-solo-light.png`, `look-solo-dark.png` | the same button armed in a solo chat |

## Why it was rebuilt

a request of September 22nd, 2026.

The first version was a `position:fixed` panel pinned 16 px from the right and 96 px from the bottom
of the window, drawn with hardcoded dark colors (`#333`, `#222`). So it covered whatever was under
it, stayed dark in the light theme, and belonged to no part of the interface.

The pill was then built from the same classes Arco renders for `<Button shape="round" size="small">`,
plus the two AionUi classes every composer pill carries. Since 2026-09-23 it is the composer's
circle button instead, Arco `<Button shape="circle" size="small">`:

```
arco-btn arco-btn-secondary arco-btn-size-small arco-btn-shape-circle
```

That is what makes it match: it inherits the app's font, height, hover color and theme instead of
imitating them. The menu uses `arco-dropdown-menu`, `arco-dropdown-menu-group-title` and
`arco-dropdown-menu-item`. Colors come only from theme tokens (`--text-secondary`,
`--color-bg-popup`, `--color-fill-2`, `rgb(var(--primary-6))`), so light and dark need no
separate rules.

**Placement was chosen from the source, not by eye.** `AcpSendBox.tsx` passes the Permission pill
through `rightTools`, which `SendBox/index.tsx` renders inside `.sendbox-actions`. The mode pills
live there, so the loop pill goes at the front of that row.

## What was removed, and why that loses nothing

**The queue box.** It held messages typed mid-turn and sent them when the turn ended, to cover Devin
not advertising `supports_midturn_delivery`. AionUi 2.2.2 already ships that: the **Draft box**, with
an **Auto send** mode that drains when the turn ends. `AcpSendBox.tsx` states that queue is *"always
live"* for every ACP backend, including ones that cannot take mid-turn messages. Two queues for one
job is part of what made the old panel look bolted on.

Anything still sitting in the old queue in `localStorage` is drained, one message per idle tick,
so nothing a user queued under the old version is dropped.

## Team agents

a request of September 22nd, 2026. The first rebuild only
recognized `#/conversation/<id>`. Teams differ in three ways, all read from source:

1. **A different page.** `#/team/<teamId>` (`Router.tsx:79`) shows every member side by side, one
   column each, `div[data-slot-id][data-role="leader"|"member"]` (`TeamPage.tsx:896`), each with
   its own composer. So each column gets its own pill, bound to that member.
2. **A different send path.** In a team the composer calls
   `ipcBridge.team.sendMessageToAgent`, which is `POST /api/teams/{id}/agents/{slot}/messages`
   (`ipcBridge.ts:2346`, AionCore `aionui-team\src\routes.rs:199`). The backend **enqueues** it
   (`session.rs`, `enqueue_user_message`) into the member's queue, the same queue the lead writes to.
   Posting straight into the member's conversation would bypass the team runtime.
3. **A different interrupt signal.** Because the lead also sends to members, "the newest user-side
   message is not the loop's own text" fires every time the lead speaks. In a team the only reliable
   signal is K pressing send in that member's box.

**What the team loop does:**

| step | how |
|---|---|
| is the member free? | `GET /api/teams/{id}/run-state`, `slot_work[]`: fires only when `state` is `idle`, `blocked_reason` is empty and both `queued_foreground_count` and `queued_background_count` are 0, so it never talks over work the lead has queued |
| which conversation is it? | `GET /api/teams/{id}`, `assistants[]`: `slot_id` to `conversation_id`, cached 60 s |
| quiet time, no-reply count | the member's conversation, same rules as solo |
| send | `POST /api/teams/{id}/agents/{slot}/messages`, body `{content}` |
| turn off | K presses send (button, or Enter with text) in that member's composer; or 3 sends with no reply |

Pressing send now also turns a **solo** loop off immediately; the solo history check stays as a
backstop. A loop runs while its chat or team page is open, as before.

## Bugs fixed in the team build

- **The no-reply safety could never trip.** State is re-read after each send to pick up a message
  edited in the menu meanwhile, and the stall count had not been saved before that re-read, so it
  was lost every time. Now saved first. The new `no-reply` test sends 3 times into a history that
  never replies and expects the loop to switch itself off; the previous build would have kept
  sending indefinitely.

## Paused members, background running, failed turns (2026-09-23)

A report came after a team sat paused for most of an hour with its Loops on: the Loops should have been working, and were not, for two reasons, both fixed.

1. **A paused member was skipped.** The loop fired only for `state === 'idle'`. A Devin free-model
   rate limit fails a delivery, aioncore retries three times in about two seconds, and the slot goes
   to `paused` and stays there. A user message resumes it (`work_source.rs` 47-52) and is exactly
   what the loop sends, so the loop now resumes a paused member on a schedule:
   - when the error states its reset ("Your limit will reset in 19 minutes"), exactly that plus
     30 s. Devin has both a burst limit that clears in under a minute and a budget that takes about
     20; the stated time exists because a Devin proxy script now passes Devin's sentence
     through (FOOTPRINT, incident section);
   - otherwise 20 minutes after an error that reads as a provider limit, 2 minutes after any other,
     then 10, 15, 15 and 30 minutes apart, 10 tries at most, then off with the reason;
   - teammates before the lead, and a resume note that tells the lead `run-state` is the truth,
     because a lead unpaused into a mailbox of stale "Delivery retry limit reached" notices
     interrupted two healthy teammates that morning.
2. **It ran only for the page on screen.** A team left in the background was never ticked. Every
   saved target with its loop on is now ticked on every poll, on any page; pills are still drawn
   only where a composer is visible.

Also:
- **It never sends to an agent that is working** (stated plainly because a summary of this change
  read as "sends every 2 minutes"). A solo chat must have finished its turn; a team member must be
  idle with nothing queued. The `working` test pins running, queued, starting, and idle-with-work.
- **Nudges back off when the agent has nothing to do.** a request. An agent idle because it
  waits on something outside its turn (a tournament driver) would otherwise be nudged about
  every 80 s and answer "still waiting" each time, at about 200K tokens a turn. Now each nudge is
  scored once: a turn under 3 minutes with fewer than 6 tool-call records means nothing to do, and
  the next nudge waits 2, then 5, 10, 20, and at most 30 minutes; a longer turn resets it. The menu
  says when the next nudge is due. The "no reply" check now compares timestamps instead of message
  counts, which saturate in a 40-message window.
- **One send per team every 2 minutes**, resumes and continue messages alike. At 09:20 two members
  resumed two minutes apart still tripped Devin's one-minute limit within 19 seconds of the second;
  after an AionUi restart every member comes back idle at once, which would be worse.
- **A solo chat whose last turn failed waits on the same schedule** instead of re-sending every
  minute into a limit. Retries after an error do not count toward the 3-sends-with-no-reply
  switch-off, since each failed retry adds a new error message.
- Errors are read from `type: "tips"` messages with an error payload; both shapes the app stores
  are handled (`content.error.detail`, and the top-level `content.details` added by newer builds).

## K's reports of September 23rd, built 2026-09-24

From `K Standing Feature Requests and Bug Reports.docx` in the project root, plus two notes the
a team agent left in the project notes. Source ready and tested; installs with the next
**AionDX Apply Update**.

- Your own messages no longer switch the Loop off. a request. The Loop's saved state (AionUi's localStorage,
  `%APPDATA%\AionUi\Local Storage\leveldb\000007.log`) showed every team Loop K had armed ended
  `off: "you sent a message"` with `fires: 0`. Nothing was SWE-specific: the backend wakes a
  dormant or paused slot on a user message for any backend (`session.rs` 661-664 and 1655,
  `work_source.rs`). Now a send only resets the backoff. The Loop holds while that box has an
  unsent draft, and after your message it waits for the reply plus a minute of quiet.
- It says why it is not sending, in the menu status and the hover card: "Not sending: it is
  working.", "Not sending: it has 3 queued items.", "Waiting a minute after your message.",
  "Holding: you have an unsent draft in this box.", "Paused by the team runtime, usually a
  provider limit. Retry 1 of 10 at 10:52."
- The button shows the agent's state. a requestprocessing" bib on the top of the chat input window is missing."* Every 3 s the script reads
  `run-state` for team members and the conversation status for solo chats (left-side output under
  6 s old also counts as working). A green dot means the agent is working, red means paused or
  blocked, and none means idle. The card's second line reads "Agent: working, turn open 4 min." and
  so on. The icon also spins while working, but only under `prefers-reduced-motion:
  no-preference`. K's Windows has animations off, which Chromium reports as `reduce`, so the
  static dot is what K sees.
- Permission is a round shield. a request. The pill
  becomes a 28 x 28 grey circle with the shield; label and caret are hidden; hovering shows
  "Permission: Bypass Permissions / What the agent may do without asking you first. / Click to
  change it."; the mode is in the `aria-label`. AionUi's CSS forces this pill to grow
  (`flex-basis:0!important; flex-grow:1!important`) and makes it transparent, so the override
  pins size and background with `!important`. While the mode is loading, the spinner shows in
  place of the shield.
- Clicking into a member's box no longer scrolls the team page. a request. `TeamPage.tsx` 751-755 scrolls the active column to the left
  edge whenever the active member changes, and focusing a box makes that member active. The script
  wraps `Element.prototype.scrollIntoView` and skips the call for a `[data-slot-id]` column when
  the last pointer press, under 1.5 s ago, landed inside that same column. Arrows and tabs scroll
  as before.
- A paused teammate is visible (a team agent's death-notification note): the red dot
  and the agent line. The note's other fix, raising the pause notice's priority so it wakes the
  lead, is backend code and out of reach of this patch.

## Shared with agents, and Compact (build `2026-09-24.2`)

a request of September 24th, and, later the same day, *"any way we can force
context compression if the user desires?"*. The agent side is patch 0007; this is the button's.

- Each Loop's settings (on or off, the continue message, a compaction request) are also kept in
  AionUi's per-user settings store, `GET/PUT /api/settings/client`, under
  `aiondx.loop.conv.<id>` or `aiondx.loop.team.<teamId>.<slotId>`. The menu writes there (a
  message edit once typing pauses for 0.8 s); the Loop writes there when it switches itself off.
- The store is read on every 3 s pulse, on any page, and on every 15 s tick. A newer record (by
  its `at`) wins over this window's copy. A Loop only the store knows, one an agent switched on
  in a chat K never opened, is ticked like any other.
- An agent's change shows within 3 s: a notice at the top of the window in AionUi's own message
  style ("Lead switched the Loop on for Worker." with the agent's note under it), a purple mark
  at the bottom right of the button for 10 minutes, the aria-label, and a "Last changed by ...
  at 13:21: note." line in the hover card and the menu for a day. A change read more than 2
  minutes late marks the button without a notice. The legend lists the purple mark.
- What the Loop last decided goes to `aiondx.loopstatus.<same>` for the tool's `loop_status`,
  written only when it changes (a change of wording alone at most every 2 minutes, because
  aioncore logs every write). `aiondx.engine` gets `{at, build}` every 2 minutes.
- On the first read of the store, Loops saved before it existed (on, or with their own message)
  are written to it, unless it already has a record.
- "Compact its context" appears in the menu when the agent lists `/compact` (Claude, Codex) or
  `/compress` (Gemini CLI, Qwen) in `GET /api/conversations/{id}/slash-commands`. It sends that
  command the next time the agent stops, through the same path as a nudge, whether the Loop is
  on or off, and straight away if it has already stopped. A team member gets it unwrapped
  (aionui-team `recognized_command_is_sent_bare_to_member`). Not held to the 2-minute team
  spacing; it does count as the team's latest send. The next nudge waits for its reply.
- No store (an older backend; the test stub with `?nostore=1`): a 404 switches all of this off,
  and the Loop runs from localStorage exactly as before.

Conversation `extra` was the first plan for the shared record. A PATCH there stamps `updated_at`
and the sidebar sorts by `modified_at`, so every toggle would have moved the chat to the top.

## Opening a team does not wake it (build `2026-09-24.3`, P-011)

Build `2026-09-25.1` adds the other half: the Loop's own tick does nothing for a team whose run-state has
no `session_generation`. On the 25th the team still started as K opened it, and the request that
started it was the Loop's nudge to the lead, whose Loops the lead had switched on. Any send starts a
stopped team (and drains the lead's mailbox), so the Loop now waits for someone to message the team.

a request of September 24th. The
team page calls `POST /api/teams/{id}/session` when it opens. For a team with no session (every
team, after an AionUi restart) that starts the session and drains the lead's unread mailbox as
work, so the lead takes turns and wakes its teammates. The script wraps `window.fetch`: that one
call, when `GET /api/teams/{id}/run-state` says `session_generation` is null, is answered
`{ success: true }` locally and never reaches the backend. A running team gets the real call.
Every real send starts the session in the backend by itself, so the team wakes on the first
message, yours, the Loop's or an agent's. Any failure to tell passes the call through; the kill
switch passes everything through. `window.__aionDx.heldWakes()` lists the teams it held.

## Build `2026-09-25.4`: the cache window, your stop, the outbox, notices that say where, the account pill

The Loop kept a waiting agent busy but let its prompt cache lapse: after short replies it waited 2, 5,
10, 20 and 30 minutes from its last nudge, and Anthropic's cache lasts 5 minutes from its last read
(5-minute writes cost 1.25 times the input price, reads 0.1 times, 0.05 on Opus 5.5). a request.

| rule | constant |
|---|---|
| after real work, nudge once quiet | `QUIET_MS` 20 s, `MIN_FIRE_GAP_MS` 60 s |
| after 1, then 2+ short replies, nudge this long after the agent's last message | `NUDGE_WAITS_MS` 2, 4 min |
| a nudge later than this after its last message would miss the cache: rest instead | `WARM_LATEST_MS` 4 min 40 s (`CACHE_TTL_MS` 5 min) |
| after this long of short replies, rest | `HOLD_MIN` 45 min; menu 0, 45, 90, 180; tool `holdMin` up to 240 |
| Claude members of a team, apart | `CLAUDE_SEND_GAP_MS` 20 s (Devin members keep `TEAM_SEND_GAP_MS` 2 min) |

Resting: on, but no nudges until the agent works again (someone else's message, or its own). A Loop
switched on for an agent that is already cold sends one nudge, because someone asked. Your stop phrases
(`STOP_RES`, minus the negations in `STOP_NOT_RES`) switch it off: said to a lead, every Loop of the
team. A member removed from the team switches its Loop off. The button's ring shows the cache time
left; dashed while resting; the hover card and menu say until when the cache is warm. Published to
`aiondx.loopstatus.*`: `lastAt`, `warmUntil`, `holdMin`, `shortSince`, `restingSince`, `restKind`.

A solo chat's `status` can read "finished" while its runtime is mid-turn; `convBusy()` reads
`runtime.is_processing` first, for the Loop, the working dot and the outbox.

The outbox (unsend): Enter or the send button, while the agent works, is caught before AionUi (window
capture) and held above the box with Send now and Unsend. Team: until it stops. Solo Claude or Codex
(`runtime.supports_midturn_delivery`): 30 s, or until it stops if ticked. Other solo: until it stops.
Not held: an idle agent, a `/command`, attached files (`.scrollbar-hide` in the panel), an open slash
or @ menu (`.sendbox-panel.overflow-visible`). Kept in localStorage `aionui.dx.outbox.v1`; a message
from an earlier app session waits for you. Research: `! LLM Files\Research\2026-09-25_unsend-queued-messages.md`.

Notices: `notify(t, text, sub)` names the team and member or the chat, and a click opens it
(`#/team/<id>`, the column scrolled into view, or `#/conversation/<id>`).

The account pill: before AionUi's model picker (`[data-testid^="acp-model-selector"]`) in Claude chats,
when `aiondx.accounts` exists. A choice asks first, then writes `aiondx.account.conv.<conversation id>`
(removed when it matches the agent's own account) and restarts the agent
(`/api/conversations/{id}/runtime/restart`, or the team's `/agents/{slot}/runtime/restart`); refused
while it works. The router in patch 0002 does the rest. Research:
`! LLM Files\Research\2026-09-25_model-and-account-per-chat.md`.

## Build `2026-09-25.5`: Unsend on "Unread"; the outbox removed

a request. The outbox is gone. In a Claude chat each "Unread" badge
(`[data-testid="message-status-badge"]`) gets an Unsend button. A click reads the message's `msg_id`
(`GET /api/conversations/{id}/messages/{messageId}`; the row is `#message-<id>`), writes
`aiondx.unsend.req.<msg_id>` = `{conv, messageId, at}`, and waits for the router's answer in
`aiondx.unsend.result.<msg_id>` (read every 3 s with the rest of the store). Cancelled: the row gets
`data-aiondx-unsent` (struck through, "Unsent", badge hidden) and a notice. Already taken, or no answer
in 20 s (a Claude process started before the router update): a notice says so. The router side is
patch 0002's `claude-stream-proxy.js`.

## Testing: `tools\dx-harness\click-test.js`

154 checks (25 until 2026-09-23, 87, 110, 144 and then 150 on 2026-09-24), real mouse input throughout, against `harness.html` and its stub
backend. Tests reach the stub through `window.__stub` to pause a member or add an error. The stub
serves the response shapes above and, like the real backend, adds each sent message to that
conversation's history. (The first stub did not, which made the solo history check misfire in the
test in a way the real app never would; fixed in the stub, not by loosening the test.)

| scenario | checks |
|---|---|
| `toggle-light`, `toggle-dark` | menu opens on a real click, is not rebuilding itself, On takes, menu closes |
| `solo-fire` | posts the continue message to the conversation, records it, pressing send turns it off and says why |
| `no-reply` | exactly 3 sends into a silent history, then off, with the reason |
| `team` | one pill per column; arming the worker leaves the lead alone; sends via the team endpoint only; never fires for a running member; not twice inside 60 s; send in the lead's box turns off only the lead's loop, and in the worker's box only the worker's |
| `background` | a team member whose page is not open is still ticked and sent to; no pill is drawn for it |
| `paused` | waits while a rate-limit error is 5 min old, schedules 20 min after it, the menu says so; resumes after the wait with the resume note; no immediate retry; retries 10 min later; stays on |
| `lead-last` | lead and teammate both paused: teammate first, lead held; 2 min gap inside a team; then the lead, told to trust `run-state` |
| `team-gap` | two idle members armed at once: one send, the other 2 min later |
| `stated-reset` | the real error shape from 09:20, "reset in 45 seconds": waits 75 s, not 20 min, then resumes |
| `solo-error` | a failed solo turn: waits, retries after the wait, counts a retry and not a stall, stays on |
| `look-light`, `look-dark` | one round 28 x 28 icon button per column, no text, first in the action row; off grey, on primary, holding back amber (computed colours checked against the theme tokens); the hover explainer carries the status; same button in a solo chat |
| `explainer` | no native title tooltip; nothing under 350 ms of hover, open after it; team wording and all five rules; the colour legend; how to change it; above the button and inside the window; AionUi's tooltip colours; closes on mouse-out and on click (menu opens); solo wording without team rules; off shows no repeated status, and after switching itself off it says why |
| `working` | nothing sent while a member is running, queued, starting, or idle with work queued |
| `nudge-backoff` | first nudge; a short reply makes the next wait 2 min, the menu says until when; another short reply, 5 min; a 5-minute turn resets it |
| `user-send` | an unsent draft holds it and says so; after your own message it waits for the reply plus a minute, then sends; it stays on throughout |
| `why` | "Not sending: it is working." and "Not sending: it has 3 queued items." in the menu, and the card's "Now:" line |
| `agent-state` | green dot, no spin, under reduced motion; spin under `no-preference`; no dot when idle, red when paused; the card's agent line; a running solo chat and fresh solo output both count as working |
| `permission` | a 28 x 28 circle, 50% radius; shield visible, label and caret hidden; `aria-label` names the mode; hover card opens and closes on mouse-out |
| `column-scroll` | two 640 px columns: clicking into the second box leaves `scrollLeft` at 0; the arrow still scrolls to it |
| `shared-write` | switching on from the menu writes the shared record as the user's; an edited message is written once typing pauses, not per keystroke; switching off writes too |
| `shared-read` | an agent's switch-on shows on the button with the purple mark, a notice naming the agent, what it did and its note, the aria-label and the hover line; the notice shows once; the nudge sends the agent's message; an agent's switch-off turns it off and the menu says who and why; a change read 5 minutes late marks without a notice |
| `shared-team` | the lead's change turns on the worker's Loop only, the notice names whose Loop, the worker is nudged through the team; a Loop only the store knows is ticked with its page closed |
| `shared-status` | the decision and nudge count are published for `loop_status`; the heartbeat carries the build; nothing is rewritten while nothing changes |
| `migrate` | a Loop saved before the store existed is written to it |
| `no-store` | with no store it runs as before and writes nothing |
| `team-wake` | a running team gets the real session call; a team with no session is not woken by the page, and the script records it; the absolute-URL form is held; a real message still reaches the backend; the kill switch lets the call through |
| `compact` | the menu offers it when the agent lists `/compact`; a click sends `/compact` at once to a stopped chat and leaves the Loop off; the request and the send are in the store; sent once; no item for an agent without the command; a working member gets it once it stops, through the team; the hover card says it is waiting; an agent's request is sent the same way, with a notice |

**Not covered by the harness:** the real team runtime's response to a loop send, and the team page's
tab view, which may not carry `data-slot-id`; if so, no pill appears there, and nothing breaks.

## Bug that shipped: no Loop request ever reached the backend in the desktop app

Found 2026-09-24, about 15:25. A team lead switched its team's Loops on through the new tool
(`aiondx loop set --on --member all`, 15:14, records correct in the store) and K saw nothing change.
aioncore's request log (`%APPDATA%\AionUi\logs\<date>.log`, one `http response ... path=` line per
request) showed no Loop traffic at all: no store reads, no run-state polls beyond AionUi's own (about
15 every 10 minutes all day, before and after the install), no heartbeat. The window's localStorage
had not been written since startup.

Cause: AionUi's desktop window is loaded from the app bundle, not from the backend. The preload script
puts the backend's port in `window.__backendPort`, and the app's own requests go to
`http://127.0.0.1:<port>/api/...` with `credentials: "include"` (shipped `index-*.js`, the http
bridge's `fetch(`${$l()}${t}`, {..., credentials:"include"})`). This script used same-origin paths
(`/api/...`), which in the desktop window resolve against the page's own address, so every request
failed and was swallowed by the pulse and tick error handlers. That holds for every build since
September 22nd: the Loop never nudged, resumed, read run-state or showed an agent dot in the real
app. The saved Loops' `fires: 0` and the offReasons that need no request ("you sent a message",
"turned off") were the visible trace. The test page stubs `fetch` and serves same-origin paths, so
all its checks passed. It also broke the team-wake guard in build `2026-09-24.3`: its run-state check
failed and it let the wake call through.

Fix, build `2026-09-24.4`: `apiUrl(path)` builds `http://127.0.0.1:<window.__backendPort>` + path the
way the app does (a same-origin path in WebUI, where there is no `__backendPort`), used by `getJson`,
`postJson`, the store writes and the team-wake guard. The CSRF header already came from
`window.__coreCsrfToken`, as the app's does. New checks (`backend-port`): with `__backendPort` set,
every Loop request, the nudge, the store read and write, and the guard's run-state call use the
absolute address. The stub now keys routes by path whatever the origin.

Verify after installing: the request log shows `GET /api/settings/client` every 3 s, run-state polls
for the team on screen, and a `PUT /api/settings/client` heartbeat every 2 minutes.

## Bug that shipped: the loop could not be turned on

First install, September 22nd, 18:37. a request, then *"only i can't turn the
loop on"*.

**Cause.** The page watcher (a `MutationObserver` on `document.body`) re-rendered the menu from
scratch on every DOM change, and the menu's own re-render was a DOM change. So while open it rebuilt
itself every animation frame. A browser only fires `click` when mouse-down and mouse-up land on the
**same element**; the "On" item under the cursor was replaced in between, so the click went nowhere.

**Why the harness missed it.** It opened the menu with a scripted `.click()`, which fires on the
element directly and never involves a press and release. The screenshots were accurate; they just
could not show a menu that ignores real clicks.

**Fix.** The menu is built once per opening and afterwards only its check marks and status text
change, in place. The watcher ignores mutations inside the pill and the menu. Side benefit: an open
menu no longer re-renders 60 times a second.

**Test that now guards it:** `tools\dx-harness\click-test.js` drives headless Edge over the DevTools
protocol with real mouse press and release, held 120 ms, checks the open menu is not rebuilding
itself, clicks On, and reads the label and stored state back. Against the shipped code it failed
(`menuRebuildingWhileOpen: true`, label stayed `Loop · Off`); against the fix it passes in both
themes.

## The API calls, checked against the backend source

The first version's calls came from observing the app. With `upstream-aioncore\` pulled, each was
checked against AionCore `v0.2.2`:

| call | backend | what the loop relies on |
|---|---|---|
| `GET /api/conversations/{id}` | `aionui-conversation\src\routes.rs:120` | `status` is `pending`, `running` or `finished` (lowercase, `aionui-common\src\enums.rs`); the loop fires on `finished` |
| `GET /api/conversations/{id}/messages?limit=40` | `routes.rs:124`, `service.rs` | no cursor means `MessagePageDirection::InitialLatest`, so it gets the **newest** 40; response `items[]` with `position`, `created_at`, `content`, `hidden` |
| `POST /api/conversations/{id}/messages` | `routes.rs:124` | body `SendMessageRequest`: only `content` is required |
| `POST /api/conversations/{id}/runtime/ensure` | `routes.rs:136` | wakes a suspended runtime before a retry |

The check turned up one real gap: messages carry `hidden`, for text the app injects. A hidden
user-side message would have read as the user interrupting and switched the loop off. The interrupt
check now skips hidden messages.

## Bug fixed in passing

Editing the continue message while the loop was on switched the loop off at the next tick. The
check compared the last user message against the **current** setting, so a changed setting read as
"the user typed something else". It now compares against the text actually sent
(`lastFiredText`).

## Surviving React

The composer is React-managed and remounts its action row when layout changes, which drops any node
it did not create. A `MutationObserver` on `document.body` re-inserts the pill, throttled to one
check per animation frame, and the check is a single `querySelector`. It only appears on
`#/conversation/<id>` routes, since the loop needs a conversation id.

## Install: the old installer was unsafe, and was replaced

`tools\elevated_copy.ps1` used to be one line, `Copy-Item app.asar.patched app.asar -Force`. That
writes over the live archive in place, and it succeeds while AionUi is running because the app opens
its archive with shared write access. Electron keeps reading through its open handle using the file
table it parsed at startup, so every file packed after a changed one is read at the wrong offset. The
first install of this patch was dated 08:06 while AionUi had been running since 07:12, so it happened
under a live app.

The replacement stages the build as `app.asar.new`, then swaps by rename. When AionUi holds the file,
Windows refuses the rename, which is the safe outcome. The first real run confirmed the lock:

```
live swap refused, AionUi holds the file: The process cannot access the file because it is
being used by another process.
```

### The first waiter was killed by AionUi itself

The rebuilt installer then waited for AionUi to close in the same elevated process. K restarted
AionUi at 18:20 and nothing happened: the waiter was gone, its log stopped at 17:27 with no swap,
error, timeout or stop recorded, and `app.asar` was still the old build.

A crash inside the script would have been caught and logged, so something killed it from outside.
aioncore gives every agent process a Windows Job object holding the agent and all its descendants,
with `KILL_ON_JOB_CLOSE` and breakaway disabled
(`upstream-aioncore\crates\aionui-process\src\process.rs` 74-79, `capabilities.rs` 98-118). This
session's shell reports `IsProcessInJob` = True. A UAC-elevated child inherits the job, so when
AionUi shut down, Windows killed the waiter with everything else in it, elevated or not.

**The wait now runs under Task Scheduler.** When the live swap is refused, the elevated worker
registers the one-shot SYSTEM task `AionDX pending asar swap`, starts it, and exits. The task runs
`elevated_copy.ps1 -Mode Wait`, swaps within 250 ms of the last `AionUi.exe` exiting, and deletes
itself. Its ancestry, checked on the live system:

```
powershell.exe (waiter) > svchost.exe (Schedule service) > services.exe > wininit.exe
```

against an agent shell's `powershell.exe > cmd.exe > claude.exe > node.exe > cmd.exe > aioncore.exe`.
Nothing in the waiter's chain belongs to AionUi.

## Apply

**Normal use: the desktop shortcut "AionDX Apply Update".** It runs `tools\aiondx-apply.ps1`, which
opens a menu: install the new build, roll back to the previous one, or revert to stock AionUi (menu
added 2026-09-24). Whichever K picks, it closes AionUi (that ends every agent session), rebuilds
first for an install when the source is newer, swaps with one UAC prompt, checks the hash, reopens
AionUi, and checks it started, offering a roll back or a revert on the spot if it did not. It exists
because nothing started from inside AionUi can do this: closing AionUi kills whatever an agent
launched. If an agent does run it, it hands itself to Task Scheduler first. `-DryRun` prints the
state and plan and changes nothing.

By hand, the steps it wraps:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\do_patch.ps1         # build
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch_elevated.ps1  # install, one UAC prompt
```

`launch_elevated.ps1` reports `SWAPPED` (restart AionUi to load it) or `WAITING` (the Task Scheduler
waiter installs it the moment AionUi fully closes). State in `vendor\install-state.txt`, log in
`vendor\install.log`. A non-elevated shell cannot list the SYSTEM task; the log shows its
`[Wait]` lines.

## Verify

1. Close AionUi fully, wait for `vendor\install-state.txt` to read `SWAPPED`, reopen.
2. `powershell -File tools\check-install.ps1` should report `STATUS: patched build installed`.
3. Open any conversation. A round grey loop button sits left of `Permission · ...` in the
   composer; on a team page, one per member column.
4. Click it, choose On. It turns the theme's primary colour. After the next turn finishes and 20 s
   pass, the continue message posts itself.
5. Send any message of your own. The button goes grey again and its menu says why.

`window.__aionDx.status()` in DevTools shows the stored state for the open conversation.

## Preview without installing

`tools\dx-harness\harness.html` rebuilds the composer row from `AcpSendBox` markup, loads AionUi's
shipped stylesheets out of `vendor\extracted\`, and runs the real `aionui-dx.js`. Query options
`?theme=dark`, `?on=1`, `?open=1`. Screenshot it headless:

```
msedge --headless=new --user-data-dir=%TEMP%\aiondx-edge-profile --window-size=980,640
       --virtual-time-budget=3000 --screenshot=out.png "file:///.../harness.html?theme=dark&open=1"
```

The separate profile keeps it away from the user's own Edge session.

## Revert

The desktop shortcut's menu: "Roll back to the previous build" puts `app.asar.prev` back (the
build that was live before the last swap), and "Revert to stock AionUi" puts `app.asar.stock` back.
Every swap keeps the archive it replaced as `app.asar.prev`, so a revert can be undone the same way.
Without the menu: `powershell -File tools\aiondx-apply.ps1 -Action Rollback` or `-Action Stock`.
`powershell -File tools\revert.ps1` still restores `app.asar.stock` through the stage-and-swap
installer, and is also safe with AionUi open.

Without reverting: set Loop to Off, or `localStorage['aionui.dx.disabled'] = '1'` hides the pill and
stops all polling.

## Known limits

- **It depends on 2.2.2 class names.** `.sendbox-actions` is the anchor. If an AionUi update renames
  it, the pill quietly stops appearing and nothing breaks.
- **Polling is wall-clock**, not event-driven, so there can be up to about 35 s between a turn ending
  and the next send. Chromium slows timers in a hidden or minimized window to about once a minute,
  so a loop running behind a tray-hidden AionUi reacts a little later; the resume schedule is in
  minutes, so this costs little.
- **It runs only while AionUi is open.** The loop lives in the renderer. With AionUi closed, nothing
  resumes anything.
- **App updates overwrite the patch.** Re-run `do_patch.ps1` and `launch_elevated.ps1`.
- **The repacked archive is about 50 MB larger than stock** (363,160,422 bytes against 313,278,785).
  `do_patch.ps1` packs without `--unpack`, so files AionUi ships in `app.asar.unpacked` (214 files,
  58.8 MiB) get folded into the archive as well; the 28 MB Skia binary
  `@napi-rs\canvas-win32-x64-msvc\skia.win32-x64-msvc.node` is one, confirmed present in the packed
  tree. The app has run this way since the first install, but it is untidy and worth fixing in
  `do_patch.ps1` by passing the stock archive's unpack list.

## September 26th, 2026: build `2026-09-26.1`

- Drafts survive closing the app: every message box's text goes to localStorage as you type and to the
  settings store (`aiondx.draft.<scope>`) 2 s after you stop and whenever the window hides or closes;
  an empty box gets the newer copy back once AionUi has had its turn to fill it; 30 days kept.
- Background colours for dark and light mode on Settings > Appearance, stepped to the other surfaces,
  with Reset (`aiondx.theme` bgDark, bgLight).
- The agent control replaces the account pill. The list is the new-chat screen's own (`GET
  /api/assistants`, enabled, in `assistants.enabledOrder`). A Claude chat switches in place to another
  Claude agent (`aiondx.agent.conv.<id>` = {agent}; the launcher gives the chat that agent's
  environment and carries the transcript); any other agent opens a new chat in the same folder with
  this conversation in its message box. It sits just left of the model picker, outside the team
  column's 140 px picker box, as a bare profile icon in team columns (a request).
  The first version's `aiondx.account.conv.<id>` picks still show and are cleared by a new pick.
- Respond now: a tick box in each message box's top-right corner and a bolt left of a queued message.
  Solo Claude and Codex: the running turn is cancelled and the queued message runs next. Other solo
  agents: stopped, then sent. Team member: `/interrupt` with `queued_policy: retain` (the lead is not
  told or woken). Team lead: sent, then its turn cancelled through its run, or its chat when the turn
  has no run. The member bolt sends a one-line note through `/interrupt`.
- A notice when a team member has 20 or more messages waiting, once per long queue.
- Stop phrases are judged clause by clause: none counts in a clause that starts with when, once,
  after, until, before, if; "we're done" must end its clause. Fixes the September 25th false positive
  ("...swap it when we are done testing" switched off a team's Loops). `tools\dx-harness\stop-phrases-test.js`.
- First run: the Loop tool's MCP row, the Butler off, the AionDX themes, once (`aiondx.provisioned`).
  Then Welcome to AionDX: sign in to Antigravity (a chat with it; the setup step opens once it
  answers), or use another agent (a brief to copy; the tooltip names Claude Desktop), instructions for
  every agent, four things to bring over, Not now. Reopened from Settings > Appearance.
- `tools\dx-harness\click-test.js`: scenarios agent, respond-now and welcome added; the harness has the
  assistant list, new-chat, cancel and interrupt routes and the team column's real header layout.

Later the same day, same build number:

- Welcome, from K's smoke-test window: the primary buttons are painted in the accent colour with black
  or white text, whichever reads on it (a request); each button runs once
  until its work settles, and Sign in reuses the chat it opened (a request); the sign-in panel and its code box sit above the Welcome
  screen, and Welcome says where to paste a code (K had to press Not now to reach it).
- Antigravity failsafe: when it is not installed, its sign-in fails, or it has not answered 90 s after
  Sign in, step 1 offers "Set up with <agent>" for the first working agent in the new-chat list
  (Claude Code, Codex, Gemini, Qwen, OpenCode, then any other), and gives the install line with a Copy
  button.
- The usage meter: a Claude chat's 5-hour and weekly windows as two thin bars with percentages
  ("5h 92% · wk 87%") just left of the agent control, bars alone in team columns. The tooltip names the
  account and each window's reset and says when it was read; a reached limit is marked; a reading
  older than 30 minutes is hidden. The data comes from patch 0002's probe.
- AionCore's "is newer than the version AionUi verified" notice (and its Chinese forms) is hidden in
  chats; the window title reads AionDX.
- The Antigravity sign-in panel has a close button. A Stop in the chat kills the wrapper before it can
  write "failed", which left the panel up for 16 minutes above everything; a closed sign-in stays
  hidden, a newer record shows the panel again, and the sign-in's end still raises its notice.
- From the review (`! LLM Files\Research\2026-09-26_bug-sweep-reports.md`, report 1):
  - Stop phrases: questions, can't/won't/doesn't forms and ordinary coding phrases ("wrap it up in a
    helper") no longer count; phrases must open their clause. 45 cases pinned.
  - Respond now: the turn id is read at the keypress and only that turn is cancelled; the queued row
    must be pending and newer than the keypress; the text goes back in the box if a request fails; a
    cancel the backend ignored is not reported as a stop.
  - A failing conversation or team GET waits 30 s before retrying; it had been a request per frame.
  - The Loop's tick cannot overlap itself, and each render step is wrapped so one failure cannot stop
    the others.
  - Ctrl/Cmd+Enter (the Draft box) and Enter in an open @ or / menu are not counted as sends.
  - First-run setup records each step and retries a failed one at the next start, and writes no MCP
    row blind when the list read fails.
  - Drafts: cleared on send, keepalive only while the page unloads (the 64 KiB limit), store copies
    over 30 days deleted.
  - Unsend cannot stick on "Unsending..."; its results are removed once shown.
  - The handoff to another agent says when earlier messages were left out.
  - The picker anchor is cached per element; it forced a style recalculation on every frame while
    agents streamed.
- `click-test.js` 285/285 (a usage scenario and Welcome's three findings added), `stop-phrases-test.js`
  45/45.

## Build `2026-09-26.2`: resume at a set time

For a team lead's missed 12:10 (team log, September 26th). A Loop can carry one resume time and
message, from the Loop tool (`resume_at`, patch 0007 1.4.0) or the menu's new "Resume at a set time" row
(a time box, Set, Clear). Until the time:

- nudges read "Holding until 12:10, the resume time you set. Nothing to do before then: reply in a
  word", 4 minutes after the agent's last message, so it is never told to continue working early;
- with the time under 50 minutes away the hold does not end them (keeping the cache warm that long costs
  less than one reload); further out the Loop rests ("Resting until 12:10, the resume time: keeping the
  cache warm that long would cost more than one reload") and the cache runs out;
- a cold agent is still not woken early.

At the time, one nudge goes whatever the rest, backoff or cache say: "It is 12:10, the resume time you
set." (or "Team Lead set", "the user set"; "It is 12:25; the resume time ... was 12:10." when the
agent was busy past it), then the resume message or the continue message. The time is then cleared in
the shared record, and `loop_status` shows when it resumed. Switching the Loop off, by anyone or by
K's stop, clears it. An agent setting one raises the usual notice ("... set it to resume at 12:10").
`click-test.js` scenario `resume-at`.

Same build: Welcome's first step explains Antigravity under K's sentence (a request). Two short blocks: free with a Google account, with an allowance
that refreshes every week and no published number (Google's plans page gives none: "Meaningful quota,
refreshed weekly"); and what it does for you, a one-time move-in that asks before each change, after
which nothing in AionDX needs it. The footer says Settings > Appearance > Open AionDX setup brings the
screen back.

## Build `2026-09-26.3`: chat colours, the right-click menu, MCP seen and switched

Chat colours (a request; his answers:
per agent plus per team member, his typed messages, Loop nudges and agent-to-agent messages each apart,
separate dark and light colours, a small right-click menu). Research:
`! LLM Files\Research\2026-09-26_chat-bubble-dom-and-colours.md`.

- Rows are tagged as they render: `data-aiondx-kind` (mine, loop, a2a, agent), and on an agent's reply
  `data-aiondx-agent` (the chat's agent, or a team member's through its assistant id) and
  `data-aiondx-member` (team id/slot); a teammate message gets `data-aiondx-from` from its sender's
  name. Cross-chat deliveries are told from yours by their "From conversation" badge, Loop nudges by
  their tag.
- Colours live in the theme record (`aiondx.theme.bubbles`), dark and light apart, and are drawn with
  generated CSS: the bubble's background, black or white text that reads on it, and the same text
  colours on the Markdown shadow host (a page declaration beats the shadow's own `:host`). An agent's
  reply gets a rounded box of its colour. A member's colour wins over its agent's and also goes on its
  messages to teammates, its column's tint and its name. AionUi's own member colours are palette
  indices read once per page, so they are overridden in CSS.
- Settings > Appearance > AionDX colours > Chat colours: a row per kind, per agent (the new-chat
  list) and per member of a team picked from a list, each with Dark and Light pickers and Reset. The
  AionDX setup button moved above it.
- Right-click on a message, a team column or a chat's empty space: a small menu with the matching
  colours ("Colour of Claude Code (Second)'s replies...", "Colour of Worker...", "Background
  colour...") and Copy when text is selected. An item opens Settings > Appearance scrolled to that
  control and marks it. Text boxes, AionUi's own right-click menus and dialogs keep theirs.

MCP (a request): an agent's change through the Loop tool's `mcp_set` (patch 0007 1.5.0) is announced with
its name and note, linked to its chat; Settings > Tools gets an On/Off switch per server that is not
built in, which reads the state before toggling.

`click-test.js` scenarios `bubbles` and `mcp`.

## Build `2026-09-26.4`: opening a chat does not start its agent

K chose "Don't start chats on open" after agents started when a chat was only viewed. Opening a solo chat
sends `POST /api/conversations/{id}/runtime/ensure` from five hooks on mount, and for Claude, Codex and the
other ACP agents that starts the agent's process (research: `! LLM Files\Research\
2026-09-26_chat-start-on-open.md`). The same `window.fetch` wrapper as P-011 now holds that call, without
answering it, when the chat is `type: "acp"` and its `runtime.has_task` is false. It lets the held calls
through (one reaches the backend, every caller gets the answer) when the chat's message is accepted, when
a `/btw` question or a picker change needs the agent (those wait for the start first), or when the user
presses the model or mode pill. A chat whose agent runs, Antigravity (it starts nothing), aionrs, a lookup
that fails and the kill switch all go straight through. While a start is held the model pill's spinner is
stopped and dimmed, and the pill takes a pointer. The Loop's own recovery call after a failed send goes
straight to the backend. `__aionDx.heldStarts()` lists them. `click-test.js` scenario `chat-start`; 330/330.

## Build `2026-09-26.5`: the one-click Welcome, model versions in the pickers

- Welcome to AionDX opens on "Look for my setup" when the app has `window.aiondxSetup` (patch 0009): the scan, then
  "Here is what AionDX found" (per app: instructions with their dates, folders with counts, each MCP server with the
  keys it needs, a tick box each; the agents to give the instructions to; the user's own instructions), then Import,
  then "Your setup is in AionDX" (what came over, who reads the instructions, the MCP servers, keys found in the
  environment and keys still needed, the report to copy). Antigravity is the backup ("Set up with Antigravity
  instead", and offered afterwards), and without the one-click setup (WebUI) the first screen is Antigravity's, as
  before. Its text no longer says "key": Antigravity signs in with Google. The brief for Antigravity or any other
  agent now says to do every step itself, never to hand the user a script, with `aiondx setup scan` and
  `aiondx setup apply --all` spelled out.
- Model names get their versions (from a tester's install: the pickers showed "Fable", "Opus", "Sonnet", the
  version only on hover). Every model list that reaches the page through `runtime/ensure` or `config-options` is read
  for the versions in its descriptions; the pills ("Opus 5.5 · High") and the model menu's rows ("Opus 5.5",
  "Opus 5.5 (1M context)", "Default (Opus 5.5)") show them, a pill AionUi rewrites is relabelled at once, and the
  names learned are kept (`aionui.dx.modelLabels`) for chats whose agent has not started.
- `click-test.js` scenarios `one-click` and `model-labels`; 349/349.

## September 26th, 2026 (night): build `2026-09-26.6`, On until I stop it

a request. The Loop menu has three choices: On, On until I stop it, Off. The second marks the button
with ∞ and changes what the Loop does: no hold, no rest when the cache ran out (it wakes a cold agent), no giving
up after failed retries, and 3 nudges with no reply pause it instead of switching it off. It ends when:

- you pick Off, or say stop (the usual stop phrases);
- you press the agent's Stop button (`.sendbox-stop-button`; this now switches any Loop of that chat or member off);
- you tell that chat to turn its Loop off ("turn off your loop", "stop the loop", "loop off", "can you turn the loop
  off?"; not "don't turn off the loop", "when you're done, stop the loop", "did you turn off the loop?", or "the
  loop for Worker", which is someone else's);
- an agent switches it off after you asked it to: any request for a Loop off typed in a chat or member ("turn off
  Worker's loop", "stop all the loops") is written to `aiondx.loopask.<chat or member>`, and the Loop tool (1.8.0)
  lets that chat's agent act on it for 30 minutes.

An agent's switch-off without that (an older Loop tool) is refused and your record goes back to the store.
`click-test.js` scenario `forever`.

## September 26th, 2026 (night): /plugin, and why a Loop button is missing

- `/plugin` or `/plugins` in any message box opens the Claude Code plugins panel instead of going to the agent (Enter
  or the send button, taken before AionUi's slash menu, whose Enter would pick `/reload-plugins`). Installed and
  Available tabs (from `claude plugin list --json --available`, most installed first), search, Install, Enable or
  Disable, Update, Uninstall, and Add a marketplace. A marketplace that installs by running its own command shows the
  command and runs it only on "Run it and install". `/plugin install x@y` (uninstall, enable, disable, update,
  `marketplace add`) runs at once. In the WebUI it says to ask a Claude agent instead. Through `window.aiondxPlugins`
  (patch 0009). `click-test.js` scenario `plugins`.
- A message box on screen with no Loop button is recorded in the store as `aiondx.diag.loop` (the newest 12; each
  place at most every 10 minutes): the route, whether the box sits in a member column, whether it has an actions row,
  and the class names up from the box. And one member whose button fails to draw no longer costs the others theirs
  (`pill-failed`, same key). For a team's missing buttons, which the harness does not reproduce.
  `click-test.js` scenario `diag`.

## September 26th, 2026 (late night): a team's missing buttons, and model versions from the catalog

- The Loop button in AionUi's single view of a team (tabs above, one message box, no member columns). A team's
  "Loop buttons gone" was this view: `aiondx.diag.loop` on K's app recorded one box, zero member columns,
  every 10 minutes from 18:37. The box belongs to the tab in front, which AionUi keeps in
  `localStorage['team-active-slot-<team id>']` (else the lead's); the tabs are `[data-team-tab-role]` with
  `data-testid="team-tab-<slot>"`. `targets()` and `targetOf()` use it, so the button, your sends and the Stop button
  reach that member's Loop. `click-test.js` scenario `single-view`; harness `?team=1&single=1[&front=slotB]`.
- Model versions (the pickers showed only family names such as Fable and Opus). Measured in the standalone app: a chat's start
  (`runtime/ensure`) answers with only its Mode option, no models, so the build-.5 labels never learned anything.
  AionUi's pickers read each agent's catalog from `GET /api/agents/management`, whose model options carry the
  versions in their descriptions ("Opus 5.5 · Best for everyday, complex tasks", "Fable 5 · ...", "Haiku 4.5 ·
  ..."). That answer is now read too. The new-chat page's picker (`guid-model-selector`, `.sendbox-model-btn`) and
  its menu (the same `runtimeSelectorOptions` rows as a chat's) get the names.
- Checked in the real app (`tools\dx-harness\probe-app.js`, the staged standalone app driven over its debugging port):
  "/plugin" typed with real key presses in a real chat opens the Plugins panel, lists 314 plugins, and sends nothing.
- "/plugin" by every road (a request reached Claude Code as the /plugin command):
  Ctrl+Enter and the draft-queue button (`sendbox-add-to-draft-btn`), which queue a message without the send button;
  an Enter that Windows text input reports as keyCode 229 with no composition under way (AionUi's message box tracks
  composition with compositionstart/end and sends on it; the Loop script now does the same); and, behind all of
  them, the send itself (any `POST .../messages` whose text starts with /plugin is answered 409 with the reason, and
  the panel takes it). A message that only mentions /plugin goes through as usual.
- Real-app checks for this build (the staged standalone app, throwaway profile, over its debugging port):
  `tools\dx-harness\probe-app.js` ("/plugin" with Enter and with Ctrl+Enter opens the panel and sends nothing; the
  panel lists 314 plugins) and `tools\dx-harness\probe-models.js` (the page loads `/api/agents/management` with fetch,
  so the Loop script sees it; a fresh profile's Claude agent has no model list yet, K's has the full one with versions).
  `tools\smoke-standalone.js` 14/14.
- AionUi's own "Interrupt & send" is hidden (a request). AionUi draws it in the message box's send-button slot, beside
  the context meter, for a team member that is working while you type, and it calls the same interrupt route as Respond
  now. Found by its lightning icon, so in any language. `click-test.js` scenario `interrupt-btn`.

## October 1st, 2026: build `2026-10-01.1`, K's day list

K's list of October 1st, each item in his own words in `! LLM Files\OPEN-REQUESTS.md`. Every one stays open there until K
confirms it works. Tests: `tools\dx-harness\click-test.js`, scenarios named below.

- Loop menu: "Compact its context" is gone (R-004). An agent can still ask for a compaction through the Loop tool,
  and the status line shows it (`compact`).
- Limits (R-006). The Loop used to read a limit message as a reply, and nudged again. Now (a) a short assistant message
  that says the limit was hit ("You've hit your limit · resets 3pm") counts as the failed turn, with the stated clock
  time (and zone, and date) read as the retry time; (b) the usage tap's record of the account (patch 0002) pauses the
  Loop for as long as a window is rejected, with "Paused: your Claude account is at its 5-hour limit. The Loop carries
  on at 15:10, when it resets."; (c) after the reset the Loop sends one resume nudge to the agent, whatever the cache
  says, because a limit may have cut its turn off. A chat moved to another agent with the account pill forgets which account's
  usage it was reading, so a limit on the old account cannot hold its Loop back (a paused Loop sends nothing that could write the new
  record). `limits`, `accounts`.
- Every nudge ends with the account's usage, `[Usage: 5-hour 62% (resets 15:10), week 31%.]`, with a warning above 90%.
  `limits`.
- Usage bar (K: left of the account pill, and on hover where the chat is too narrow). The meter now shows readings up to
  12 hours old, dimmed after 30 minutes, with the age in its tooltip; a window past its reset time reads 0%. Where the
  chat is too narrow for it, it hides, and hovering the account pill shows the agent and both windows in a hover card.
  `usage`.
- Stop phrases (R-012). A stop that carves someone out ("let Builder continue working", "except Worker"), that is told to
  be relayed ("have them stand down", "tell Worker to stand down") or that is followed by its condition ("stand down
  once the build lands") no longer switches the team's Loops off. K's message of September 28th is pinned as a test.
  `stop-phrase`.
- Context ring colours (R-008). AionUi's ring is the accent colour, amber over 70% and red over 90%. AionDX paints its
  progress circle with five zones: blue, green, yellow, orange, red, starting at 0, 40, 60, 75 and 90 percent. Settings
  > Appearance has a colour and a start percentage for each, and Reset. `ctx-ring`.
- Schedule send (R-003). A round timer button before AionUi's draft button holds what is typed and sends it later: in 15
  minutes, an hour, three hours, at 9:00, or at a time picked. The menu lists what is waiting, with Send now and Cancel;
  the button carries a count. Records live in the settings store (`aiondx.sched.<id>`), so they survive closing the app;
  any open window sends what is due (checked every 5 seconds), after claiming the record in the store so two windows do
  not both send; one due while the app was closed goes out when it opens and the notice says it was late. Text only.
  `sched`.
- Sidebar spinner (R-007). AionUi spins a team's icon while the team has an active run, taken from run events and
  refreshed only at load and on a reconnect. AionDX reads run-state every 10 seconds for each spinner on screen, and
  where no member is running, starting or queued it shows the team's own icon. `team-spinner`.
- Respond now, rebuilt (R-005). It stopped the agent, or piled a note onto the queue. Now it is for team columns, and
  uses AionCore patch core-0002's `steer` route: ticked, the message goes into the member's running turn when its agent
  can take one mid-turn (it reads it at its next step) and is otherwise first in its queue; the bolt does the same for a
  message of yours waiting in a member's queue, found from `queued_foreground_message_ids` in run-state matched through
  the team's mailbox, so a bolt is on a message exactly while it waits. Solo chats have neither box nor bolt: their agent
  takes a message at its next step already. Without core-0002 there are no bolts and a ticked send goes as usual.
  `respond-now`.
- Links (R-014). Each chat link to an absolute local path gets a button that opens the file with Windows (a folder in
  Explorer); Shift+click shows it in its folder. A chip for a folder opens in Explorer when clicked, since AionUi's own
  preview cannot show one. The message text lives in an open shadow root, so the chips are looked for every 3 seconds.
  `local-links`. The skill now tells every agent how to write pictures and links (R-015).

## October 1st, 2026 (later): Stop must stop

a request of October 1st (can't be stopped by the harness or the UI). AionUi's draft box has a Manual mode, which
sends nothing by itself, and an Auto mode, which sends its next message as soon as a turn ends; a turn the Stop button cancelled ends like any
other (`useConversationCommandQueue.ts` drains on turn completion and `handleStop` does not pause it). In Auto mode Stop therefore stops the
agent for one cancel and starts it again on the next queued message. The chat K pointed at on October 1st shows the pattern in the AionCore
log: a new message accepted 70 to 130 ms after each cancel. Pressing the Stop button now also puts that message box's draft box on Manual, in
the capture phase, before AionUi's own handler cancels the turn; the queued messages stay in it, a notice says so, and the box's own mode
toggle puts it back. A team member's column holds its own box only. `click-test.js` scenario `stop-holds-draft-box`; suite 459/459. (A team
member's Stop already pauses the member through AionCore's pause route.)
