# core-0009: the chat's anchors in one request

Patch: `0001-conversation-anchors.patch` in this folder. Applies after core-0001 to core-0008 (it adds a route and a method in `crates/aionui-conversation`, in `routes.rs` and `service.rs`).
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written October 24th, 2026.

## The problem

The side rail beside a chat (one tick per user turn) needs the turns of the whole conversation. AionUi 2.2.2 gets them by downloading every message, 200 at a time, and reading the user turns out of the pages in the browser (`loadAllConversationMessagesPaged` in `useConversationAnchors.ts`), on every open of the chat. Measured on a copy of a team lead's chat (35,423 messages, 48 MB of content): 177 requests, the whole history parsed into page objects, and 2,800 ticks drawn. That was the main cause of the lag in that chat (October 24th, 2026; see patch 0013 for the page side).

## The fix

`GET /api/conversations/{id}/anchors` returns `{ "items": [ { "message_id", "msg_id", "question", "answer" } ] }`, one item per user turn, oldest first:

- a user turn starts at each visible (`hidden` false) `text` message with position `right` whose text has words in it;
- its `answer` is the first visible `text` message with position `left` after it (empty until one exists);
- `question` and `answer` are the text with whitespace collapsed and cut to 120 UTF-16 units with an ellipsis, the same rules as the page's `normalizeText` and `truncate`, so the rail reads the same as before.

The route walks the same pages the page used (200 rows, newest first, through the existing `list_messages_page`) inside AionCore, keeps only the small previews of text messages, and folds them. It adds no repository method (so none of the test doubles that implement the repository change), and it checks the conversation belongs to the user like the messages route does. A chat of 35,000 messages answers with about 2,800 turns, a few hundred KB.

## Files

| File | Change |
|---|---|
| `crates/aionui-conversation/src/service.rs` | `ConversationAnchor`, `ConversationAnchorsResponse`, `anchor_preview`, `fold_anchors`, `ConversationService::list_anchors`; 5 unit tests (`anchor_tests`). |
| `crates/aionui-conversation/src/routes.rs` | the route and its handler. |

## Tests (October 24th, 2026, rustc 1.95.0)

`cargo test -p aionui-conversation --lib anchor_tests`: 5 passed (whitespace and non-text rules, the 120-unit cut, UTF-16 counting, turns and first reply, no turns).

## Limits

- Every request reads the chat's text messages once (about 12,000 here); there is no cache, so the last turn's answer is always current.
- A chat with an older AionCore (no route) answers 404; patch 0013's page code then falls back to the old paged download.

## Re-applying on a new release

`git apply --check`, then `git apply -3`. If upstream adds its own anchors route, retire this patch.
