# core-0006: swap the agent in a team slot, the lead's included

Patch: `0001-replace-agent.patch` in this folder. Applies after core-0001 to core-0005.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written October 20th, 2026.

## Why

K, October 20th: "Would like the ability to completely swap agent types in any team slot (including lead)". AionCore adds and removes teammates and refuses to remove the lead, and a member's agent is
fixed when its conversation is created, so changing it meant a new member with a new slot id (a new mailbox, new task owners) and, for the lead, no way at all.

## What it changes

`POST /api/teams/{id}/agents/{slot_id}/replace` with `{ "assistant_id": "...", "name"?: "...", "model"?: "..." }` (unknown fields are refused). The slot keeps its id, name (unless a new one is given) and
role, so the mailbox rows, the task owners and the lead marker still point at it; it gets a new conversation on the new assistant (`provision_new_agent`, the same call that creates members), the roster
is saved, and the team's live session is stopped (`stop_session_unchecked`), which ends every member's process: the caller does this between turns, and the next message starts the session again from the
saved roster. The old conversation is left as it is. Any role may be replaced. The answer is the new member (`TeamAgentResponse`).

Code: `ReplaceAgentRequest` (`aionui-api-types`), `TeamSessionService::replace_agent`, `TeamProvisioner::replace_agent`, the route in `aionui-team/src/routes.rs`.

## Tests

The release build (`tools\build-aioncore.ps1 -Patched`, all six core patches on a clean checkout) compiles. No Rust test was added; the route is exercised by `tools\test-live-swap.js` (a team made in a
throwaway profile of the staged app, a member swapped) and by `aiondx member replace` against a stand-in in `test-loop-tool.js`.

## Not done

- A live session is stopped rather than updated in place, so a swap costs every running member its process. An in-place re-attach of one slot (`add_manual_agent` for the new agent) is possible.
- The old conversation is not archived.
