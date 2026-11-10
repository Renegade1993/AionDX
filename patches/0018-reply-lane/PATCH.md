# 0018-reply-lane: Reply quotes into one message box

Files: `apply.js` (bundle change), plus `window.__aionDxReplyFor` in `patches\0001-renderer-dx\aiondx-ui.js`. Registered in
`tools\build-release.ps1` with the other renderer patches. Written November 9th, 2026 against AionUi 2.2.2.

## The fault (AionUi)

The Reply button on a text selection emits one page-wide event, `sendbox.reply`, and every message box on the page takes it. On a team
page with several lanes open, the quote landed in each lane's box.

## The change

The listener in the message box component (`useEventBus("sendbox.reply", a => setQuote(a))`) first asks
`window.__aionDxReplyFor(<its container>, <the reply>)`, when AionDX's page script defines it, and takes the quote only on yes. AionDX
answers yes for the box you last typed in or clicked; on a page where no box has been used yet, for the box in the lane where the text was
selected; with a single box on the page, always. With AionDX switched off (no function), every box takes it, as before.

## Checked

`node patches\0018-reply-lane\apply.js <copy of the bundle>`: one listener changed, a second run reports "already done", the file still
parses. `tools\test-live-groups.js` has no Reply case; the live team-page check is by hand on a team with two lanes: select text in one
lane, click in the other lane's box, Reply; the quote shows in that box only.

## Revert

Remove `0018-reply-lane` from the patch list in `tools\build-release.ps1` and rebuild.
