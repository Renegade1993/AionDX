# 0013-chat-anchors: a long chat no longer gets slower the longer it stays open

Written October 24th, 2026, on a report that the interface lagged badly in a team lead's chat, that quitting the app made the lag go away, and with a request for a fix in the interface and not a workaround.

Applied by `apply.js` (run by `tools\build-release.ps1` with 0003, 0006, 0009 and 0012). Same rule as those: every edit must match its expected count on an unpatched tree, or show its marker on a patched one, or nothing is written. `--check` reports and writes nothing. The page half of AionCore patch core-0009.

## What was measured

A throwaway profile holding one conversation: a copy of that lead's messages (35,423 rows, 48 MB), opened in the built app on a hidden desktop. The chat page was driven the way a person uses it (scrolling up with wheel events, typing into the message box), with Chromium's profiler and layout counters running.

| Rows loaded | DOM nodes | Typing, per key | Layouts per 40 keys | Time in layout |
|---|---|---|---|---|
| 49 | 1,000 | 48 ms | 246 | 0.4 s |
| 420 | 5,700 | 105 ms | | |
| 1,224 | 16,000 | 292 ms | 247 | 7.7 s |
| 2,559 | 33,500 | 619 ms | | |

- The message box resizes itself on every key (Arco's auto-size creates a hidden mirror box and measures it), which makes the browser lay the whole page out about six times per key. The number of layouts does not change; what one costs does, because each walks every row that is mounted (1.6 ms with 49 rows, 31 ms with 1,224).
- AionUi never lets go of a message: every message the chat receives stays in the list and in the page. A chat left open for a day, which is what a team lead's chat is, reaches thousands of rows. Quitting the app reloads only the newest 50, which is why that made the lag go away.
- Page scripts add a smaller share (sweeps of the page that grow with it: about 10% at 1,200 rows). They shrink with the page.
- Tried and rejected: `content-visibility: auto` on the rows (typing 288 to 201 ms at 1,224 rows, scrolling slower), and layout containment on the list (no effect).
- Opening the chat also made the page send 177 requests for the whole 48 MB history, for the rail beside the chat (`useConversationAnchors` calls `loadAllConversationMessagesPaged`), and draw 2,800 rail ticks although 20 show at a time.

## What it does

| Where | Change |
|---|---|
| W1: the message list | While the list is at its bottom (the scroll-to-bottom button is not showing and the scroller itself is within 80 px of its end) and holds 200 messages or more, it drops to the newest 100, and the pagination state is told where the list now begins (a cursor of the shape AionCore's own cursors have, built from the new first message). Scrolling up loads the older messages again through AionUi's own paging. Nothing is dropped while the user has scrolled away, or while an earlier page or an anchor window is loading. |
| H1: rail history | The rail's loader first asks `window.__aionDxAnchors` (patch 0001's script) for the turns: one request to `GET /api/conversations/{id}/anchors` (AionCore patch core-0009). If that fails (an older AionCore, an error) the old paged download runs, as before. |
| T1: rail ticks | Only the ticks in view and 8 above and below are drawn (a tick is 2 px high with a 10 px gap, so 12 px a step). The first one drawn carries the offset, the stack keeps its full height, and the hover and scroll maths use the numbers, not the elements. |

`hasMoreAfter` cannot gate W1: AionUi's loader ORs it in when any older page loads, so it turns true and stays true. The measured chat showed it true after the first older page. The scroll button alone cannot gate it either: with real wheel scrolling on a seeded chat it read false while the list was scrolled up, and the first version of W1 trimmed the list under the reader. The scroller's own geometry is checked as well.

## Checks

- On the long chat copy, scrolled with real wheel events: scrolled up to 420 rows (the count never fell below 420 in the 5 seconds after), back at the bottom 98 rows; scrolling up again paged older messages back in (287 rows); back at the bottom 98 again; no row shown twice at any point. Typing at the bottom after the trim: 55 ms per key and 0.7 s in layout per 40 keys, against 292 ms and 7.7 s at 1,224 rows.
- `tools\test-live-anchors.js` (core-0009 and 0013 in the built app, on a seeded chat of 4,200 messages): one `/anchors` request and no paged download, a few dozen ticks drawn, preview card and rail scrolling. The bounded list is not checked there: on that seeded chat AionUi 2.2.2 itself freezes when the list is scrolled back to its bottom, with the stock chunk and with AionDX's page scripts blocked (October 24th; see `! LLM Files\2026-10-24_Seeded-chat-freezes-at-bottom.md`).
- `apply.js --check` on the extracted app; on a scratch copy all edits match once, a second run reports each as already applied, and the changed file still parses.

## Limits

- Messages that arrive while the list is at its bottom are what the bound covers. A tool call that was started more than 100 messages before its result arrives would show its result as a new row (the list no longer has the call to update).
- The rail uses the history it fetched when the chat opened for a long chat, as before; new turns appear in it after the next open.
- The message list still mounts every loaded page while the user reads older messages; a chat scrolled far up is as slow as before.
