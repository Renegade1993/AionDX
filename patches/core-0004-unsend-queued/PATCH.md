# core-0004: Take back a message that is still in a team member's queue

Patch: `0001-unsend-queued.patch` in this folder. Applies after core-0001, core-0002 and core-0003.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written October 9th, 2026.

## Why

a request of October 9th Unsend worked only for a message in a solo Claude chat that Claude had not read yet. A message sent to a
team member waits in AionCore's work coordinator (the member's queue), where the renderer could not reach it, so the Unread badge of a team
column had no Unsend.

## What it changes

`POST /api/teams/{id}/agents/{slot_id}/steer` (core-0002) takes one more field, `unsend: true`, together with `message_id` (the mailbox id of one of
the user's queued messages). The message leaves the queue, is marked read so no later turn of the member opens with it, and the answer is
`{ "outcome": "unsent" }`. A message that is not waiting any more (the member took it, or it was never queued) answers `not_queued`, and the
renderer then tries the member's own chat (a message handed to a running Claude turn can still be cancelled there). Only the user's own messages
can be unsent.

Code: `SteerTeamAgentRequest.unsend`, `TeamSteerOutcome::Unsent` (`aionui-api-types`), `TeamSessionService::steer_agent` and
`TeamSession::unsend_queued_message_from_user` (`aionui-team`), reusing `SlotWorkCoordinator::take_queued_message` from core-0002.

## Tests

Built with `tools\build-aioncore.ps1 -Patched` (all core patches applied to a clean checkout). The coordinator call it uses has its own
tests from core-0002; the route is exercised by `tools\test-live-oct9.js` (the field is accepted) and by the owner's use.

## Not done

- A live check of Unsend on a queued team message with a running Claude member.
