# core-0025: a chat becomes a team's lead in place, and a team goes back to separate chats

Patch: `0001-chat-team.patch` in this folder. Applies after core-0001 to core-0024.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written November 24th, 2026 (R-134).

## Why

R-134, from a chat on the user's laptop (November 18th, 2026): "i want the ability for conversations to convert to teams, and
potentially vice versa". AionCore refuses it on purpose: creating a team from an existing conversation answers "creating Team
agents from existing conversations are no longer supported", and deleting a team deletes every member's conversation, the lead's
too.

## What it changes

- `POST /api/teams/from-conversation` with `{ "conversation_id", "name", "lead_name"? }` (unknown fields refused). The
  conversation must belong to the user, not be in a team already, and have a backend and a working folder. Its `extra` gets the
  markers a new lead's has (`teamId`, `slot_id`, `role`); nothing else in it changes, so its id, history, folder, agent, model
  and MCP servers stay. A team row is written with it as the only member and lead. If the row cannot be written, the markers are
  taken off again. A running agent process is ended (3 s at most) so its next start comes up with the team tools, which an agent
  gets at launch; its session is resumed as on any restart. Members are added afterwards with `POST /api/teams/{id}/agents`.
  Answer: the team (`TeamResponse`), 201.
- `POST /api/teams/{id}/dissolve`. The team's runtime and every member's process stop; each member's conversation, the lead's
  too, keeps its id, history and folder and loses only the team markers (set to null, which AionCore reads as no team); the
  team's mailbox, tasks, row and sidebar order row go. Nothing is deleted from any conversation; archiving is the caller's
  choice. Answer: `{ team_id, members: [{ slot_id, name, role, conversation_id }] }`.

Code: `CreateTeamFromConversationRequest`, `DissolvedTeamMember`, `DissolveTeamResponse` (`aionui-api-types`, exported from
its root), `TeamConversationProvisioningPort::conversation_name_and_extra` (default `None`, so test doubles need no change; the
app's adapter reads the row owner-checked), `TeamSessionService::create_team_from_conversation` and `dissolve_team`, the two
routes in `aionui-team/src/routes.rs`.

## Tests

The release build (`tools\build-aioncore.ps1 -Patched`) compiles. The AionDX side is click-tested against stand-ins of both
routes (`tools\dx-harness\click-test.js`, section `chatteam`) and the agent commands in `test-loop-tool.js`.

## Not done

- No Rust unit test yet for the two routes.
- The lead's Loop record and asks ledger stay keyed to the chat; the team's Loop for the lead starts off.
