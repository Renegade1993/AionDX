# core-0014: lead-only team routes for agent runtimes, and the AuthChannel marker

Patch: `0001-auth-channel.patch` in this folder. Applies after core-0013.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written November 7th, 2026. Built with
`tools\build-aioncore.ps1 -Patched`. Approved by Nathan on 2026-11-07 as a separate patch
(docs/mobile-bridge/CONTRACT.md §9 K1, §11 #5).

## Why

Every agent subprocess carries `AIONUI_RUNTIME_TOKEN`, and the auth middleware turns it into the full `CurrentUser`.
The MCP tools behind spawn, shutdown, interrupt, rename and clear-context are lead-only, but their HTTP twins under
`/api/teams` only check that the user owns the team. So a non-lead teammate could call them directly with its token
and skip the rule. `CurrentUser` alone could not tell the user's own client from an agent.

## What it changes

1. **`aionui-auth`: `AuthChannel`.** The auth middleware now inserts `AuthChannel::{Local, Session,
   RuntimeToken { conversation_id }}` next to `CurrentUser`. Handlers and layers can use it to tell the user's clients
   from an agent runtime. The mobile bridge (core-0015) uses it to refuse runtime-token callers on its admin routes.
2. **`aionui-auth`: no fallback from a runtime token to the cookie.** A request that carries `x-aionui-runtime-token`
   is authenticated by that token only. Before, a bad token with a valid session cookie fell through to the cookie.
   The CSRF layer exempts any request carrying that header, so the old fallback authenticated a cookie-bearing request
   with no CSRF check.
3. **`aionui-team`: `lifecycle_guard`**, a route layer on the team router. A runtime-token caller may use these
   routes only when its conversation is the **lead of the same team**:
   - `DELETE /api/teams/{id}`
   - `PATCH /api/teams/{id}/name`
   - `POST /api/teams/{id}/agents`
   - `DELETE /api/teams/{id}/agents/{slot}`
   - `POST /api/teams/{id}/agents/{slot}/replace`
   - `PATCH /api/teams/{id}/agents/{slot}/name`
   - `POST /api/teams/{id}/agents/{slot}/interrupt`
   - `POST /api/teams/{id}/agents/{slot}/context/reset`
   - `DELETE /api/teams/{id}/session`

   Anything else is refused with `403` (`TeamError::LeaderOnly`). The slot and role come from AionCore's own
   `resolve_team_tool_context`, the same lookup the runtime team tools use.

## What it does not change

- **Sessions and local mode:** the desktop renderer, the WebUI and local mode are untouched on every route.
- **The agent paths that matter:**
  - The MCP team tools and the `aioncore team` CLI go through `/api/runtime/team-tools/{context,call}`, outside the
    team router, so the guard never sees them.
  - Messages, steer, attach, model, run-state, tasks, mailbox, session start and run cancel stay open to every
    agent.
  - The `aiondx` loop tool calls `replace` only for the lead acting on a teammate (patch 0007 refuses everything
    else), so it is unaffected.
- **Stop session:** `DELETE /api/teams/{id}/session` stops the whole team's session; no agent-side code calls it.
  Agents cancel their own turn through the conversation and run cancel routes, which aren't guarded.

## Tests

- **`aionui-auth/tests/middleware_tests.rs`, 5 new:**
  - `Session` marking for a JWT, and `RuntimeToken { conversation_id }` for the runtime channel;
  - a valid token plus a cookie authenticates as the token;
  - a bad token plus a valid cookie gets `401`, not a fallback to the cookie.
- **`aionui-team/src/lifecycle_guard.rs`, 8 new.** They drive the real middleware through an axum router, with a
  fake slot lookup:
  - (a) a lead's own token keeps all 9 guarded routes and the everyday routes;
  - (b) a teammate keeps the everyday routes and is refused on all 9 guarded routes;
  - (c) another team's lead is refused, and so is a solo chat;
  - (d) session and local callers pass every guarded route;
  - plus the route matcher and the decision function.

Run: `cargo test -p aionui-auth -p aionui-team --lib --tests` on 2026-11-07.
- All new tests pass. aionui-auth: 166 + 38 + others; aionui-team lib: 504.
- **3 pre-existing failures** in `aionui-team/tests/session_service_integration.rs`:
  - `create_team_without_workspace_uses_leader_auto_workspace_for_all_initial_agents`
  - `add_agent_uses_team_temp_workspace_when_team_and_leader_workspaces_are_unusable`
  - `add_agent_continues_when_team_temp_leader_patch_fails`

  They assert workspace paths contain `/conversations/` and fail on Windows paths. That's the same class core-0002's
  PATCH.md records, in code this patch doesn't touch.

**2026-11-08:** clippy-clean. `lifecycle_guard.rs` allows `disallowed_types` per module because it is HTTP middleware (as upstream `routes.rs` does), and the route table is now a `matches!`. No change in behavior; the 14 lifecycle tests pass.
