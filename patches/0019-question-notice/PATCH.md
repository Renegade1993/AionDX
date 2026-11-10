# 0019-question-notice: every question an agent asks gets a notice, in time

Files: `apply.js` (bundle change), plus the backstop `questionSweep` in `patches\0001-renderer-dx\aiondx-ui.js`. Registered in
`tools\build-release.ps1`. Written November 9th, 2026 against AionUi 2.2.2, for "i'm not seeing question notifications pop in time".

## The faults (AionUi)

1. The notifier keyed a question's notice by chat and message (`${conversation_id}:${msg_id}`). A second permission request or question
   in the same assistant message had the same key and never notified.
2. It notifies only from the live event stream. An event that arrives late gives a late notice; one that is dropped (AionCore logged
   dropped live events when the page's channel was full, November 7th) gives none.

## The change

- The key carries the question's own id (call or request id), so each question notifies once.
- The notifier tells AionDX's page script of each question it saw (`window.__aionDxOnAsk`).
- AionDX polls every 4 seconds what busy chats are waiting on (`GET /api/conversations/{id}/confirmations`): chats on screen that are
  working, solo chats active in the last 10 minutes, members of teams with a run going (team run-state every 15 s), at most 16 chats a
  sweep. A question the stream did not tell of in the last 45 seconds gets a desktop notice and an in-app notice that opens the chat.

## Checked

`node patches\0019-question-notice\apply.js <copy of the bundle>`: one change, a second run reports "already done". The live
behaviour needs a real agent question; check by hand: a chat whose agent asks two questions in one reply notifies twice.

## Revert

Remove `0019-question-notice` from `tools\build-release.ps1` and the `questionSweep` interval from the page script.
