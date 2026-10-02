# core-0002: Respond now without stopping the agent

Patch: `0001-respond-now.patch` in this folder. Applies after core-0001.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`), the same sources as `upstream-aioncore`.
Written October 1st, 2026. Built with `tools\build-aioncore.ps1 -Patched`, which applies every `core-*` patch in name order.

## Why

a request of September 26th The first build of that (renderer `2026-09-26.1`) stopped the agent's running turn, or sent a note that
only piled onto the queue. a request of October 1st

A team member's messages wait in AionCore's work coordinator (foreground lane, first in first out; claimed in one
batch when the member's turn ends). The only existing route that reordered anything, `interrupt`, cancels the turn.
A team conversation also refuses the ordinary send route ("Team-owned conversations must be sent through Team API"),
so the mid-turn delivery a solo Claude chat gets was not available to a member.

## What it changes

1. A new route, `POST /api/teams/{id}/agents/{slot_id}/steer`, works for the lead and for members. It never stops a
   turn.
   - `{ "content": "..." }`: a new message from the user. When the member's running turn can take a message mid-turn
     (Claude and Codex: AionCore's `Command::Steer`, a stdin user frame for Claude) and is not waiting on a
     permission card, the message is written into the member's chat (status pending until Claude reads it, so
     "Unread" and Unsend work) and delivered into the running turn; the agent reads it at its next step. Otherwise
     it is queued like any message of the user's and moved to the front of the queue.
   - `{ "message_id": "..." }`: one of the user's messages already waiting in the member's queue (the mailbox id).
     With a mid-turn route it is handed to the running turn and leaves the queue; without one it moves to the front.
   - Answer: `{ "outcome": "delivered_midturn" | "queued_first" | "moved_to_front" | "not_queued", "message_id": ... }`.
2. `queued_foreground_message_ids` on every slot in `GET /api/teams/{id}/run-state` and the slot-work events: the
   mailbox ids of the user's queued messages in the order the slot will read them. Left out of the JSON when empty.
   The renderer places a bolt on exactly those messages, and removes it the moment the member's turn starts on one.
3. Under the routes: `ConversationService::steer_active_turn` (the mid-turn delivery the ordinary send already used,
   made callable for a team conversation), `AgentTurnCancellationPort::steer_agent_turn` (default: not available, so
   other implementers of the port need no change), `SlotWorkCoordinator::promote_queued_message` and
   `take_queued_message`, and `TeamSession::steer_agent_from_user` and `promote_queued_message_from_user`.

Nothing else changes: `interrupt`, `send`, the queue order of every other source, and the lanes are as they were.

## Tests

Six new in `aionui-team` (three coordinator, three session), three new in `aionui-conversation`
(`steer_active_turn_*`). `cargo test --release -p aionui-team --lib` 495 passed; `-p aionui-api-types --lib` 538
passed; `-p aionui-conversation --lib` 490 passed and 2 failed: `session_context` `is_auto_workspace_matches_by_structure
_across_user_and_date` and `service_test` `create_rejects_unavailable_workspace_with_trailing_whitespace_in_request`,
which check workspace paths written with `/` and fail on Windows paths, in code this patch does not touch (not run
against stock to confirm). The release build (`tools\build-aioncore.ps1 -Patched`, both core patches applied to a clean
checkout of the tag) succeeded: `vendor\aioncore\aioncore.exe`, sha256 `942be1cc4b9a...`.

## Not done

- A message waiting in AionCore's queue is moved or delivered by its mailbox id; the bubble in the chat is matched to
  it by its text. Two queued messages with identical text are matched in order.
- Attachments: a steered new message carries its files the way the ordinary send does; a queued message moved
  through `message_id` delivers its text and file paths from the mailbox row.
- Not live-tested against a running Claude member yet: the unit tests use the coordinator and a recording port, and
  the conversation tests use the existing mid-turn mock agent. K's confirmation is what moves this to confirmed.
