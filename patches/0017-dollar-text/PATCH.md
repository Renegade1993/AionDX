# 0017-dollar-text: a dollar sign in a chat message stays a dollar sign

Files: `apply.js`. Registered in `tools\build-release.ps1` with the other renderer patches. Live test: `node tools\test-live-dollar.js`. Written November 2nd, 2026.

## The fault (inherited from AionUi 2.2.2)

Chat Markdown is read with remark-math, which treats any text between two single dollar signs as an inline formula. A sentence with two prices, such as "the $1M/$2M limits" or "uses $40,000 ... reflect the $12,500", has its middle drawn as italic maths with the spaces removed, and the dollar signs disappear.

## The change

remark-math's `mathText()` tokenizer defaults its option `singleDollarTextMath` to true when the app does not pass it, and the app does not. The patch changes that default to false. Maths written with two dollar signs (`$$x^2$$`) and block maths still render; the single-dollar form no longer does. The anchor must match exactly once in `out/renderer/assets/*.js`, or nothing is written; running it again changes nothing.

## Checked

`node patches\0017-dollar-text\apply.js <tree>` on a copy of the bundle: changes the tokenizer's default only (the serializer's default for writing maths back out is left alone), second run reports "already done". `tools\test-live-dollar.js` shows three replies with prices as written and one `$$...$$` reply still drawn as a formula, in the built app.

## Trade-off

A person who types inline maths as `$x$` now sees the dollar signs. `$$x$$` draws it.
