# core-0017: @@ mentions reach teams

Patch: `0001-team-mentions.patch` in this folder. Applies after core-0016. Target: AionCore v0.2.2 (tag `v0.2.2`).
Written 2026-11-13 for R-111.

## What it does

AionCore's `@@` list left out every team-owned chat, so a team could not be mentioned at all. With this patch:

- The `@@` list (`/api/session-messages/mentionable`) starts its first page with every team the user has that is not
  archived, from any account, each shown as `Team: <team name>` and addressed by its lead's chat id. The caller's own
  team is left out. The search term matches the team name; the project filter and the id check apply as for chats.
  Member chats stay out of the list.
- The send boundary (`reject_unusable_target`) accepts a team lead's chat (`extra.teamId` set and `extra.role` "lead").
  A member's chat is still refused.
- The `[[AION_SESSIONS]]` block marks a team entry `<name> [team]` (the marker is on the name, so the id field stays a
  bare id for the chip parser) and adds one line without a tab: a team is an invitation to read, not to deliver to.
  Start with the layout (`aiondx team show <id>`), then the lead's chat (`aiondx chat read <id>`), then any member's
  chat as needed. Send nothing to a team unless the user asks.
- Delivering to a team chat through session-message stays refused by the delivery-time team check, which this patch
  does not touch.

## Files

| File | What |
|---|---|
| `aionui-session-message/src/targets.rs` | `MentionableTargets.team_repo`, `with_team_repo`, `team_candidates`, `team_lead_conversation_id`; teams lead page one. |
| `aionui-conversation/src/session_mentions.rs` | `SessionMentionTargetInfo.team`, `is_team_lead`, `TEAM_HINT`, the lead exception in `reject_unusable_target`. |
| `aionui-conversation/src/service.rs` | sets `team` from the target row's `extra`. |
| `aionui-app/src/router/state.rs` | wires `services.team_repo` into the `@@` list. |
| tests | `targets_test.rs` (lead lookup), `session_mentions_test.rs` (lead accepted, member refused, block marker and hint). |

The reading side is the Loop tool (`patches/0007-loop-tool`): `aiondx team show` and `aiondx chat read`.
