# core-0019: routes only a human may call (SG-0, Phase 0 of docs/sage/CONTRACT.md)

Patch: `0001-human-only-routes.patch` (not exported yet). Applies after core-0018. Target: AionCore v0.2.2.
Approved by Nathan ("yes do it", relayed by the lead on 2026-11-13; Phase 0 of the sage contract, draft 2).
LOCAL ONLY.

## Why

Every agent subprocess holds a conversation runtime token that authenticates as the full user on every route
(`aionui-auth/src/middleware.rs` `runtime_token_channel`: no path scoping). So an agent could:
- answer its own permission prompts;
- switch its chat to bypass mode;
- turn on cross-session messaging;
- change the password;
- approve a bot pairing.

It also inherited `AIONCORE_BOOTSTRAP_SECRET`: `aionui-runtime/src/agent_env.rs` `clean_agent_env` passes AionCore's
whole environment minus six keys. That secret authenticates `/api/auth/internal/*` (create users, set passwords, rotate
JWT secrets).

## What it does

- `aionui-auth/src/human_only.rs`: the policy, `refusal(method, path, body)`, a pure function with unit tests.
- `aionui-auth/src/middleware.rs`: after a runtime token is verified, a human-only route gets `403 HUMAN_ONLY_ROUTE`.
  Session and Local callers never reach this check. The mobile bridge calls services directly, so it's unaffected.
- `aionui-runtime/src/agent_env.rs`: `AIONCORE_BOOTSTRAP_SECRET` is removed from agent environments.

## RESUME (WIP, 2026-11-13)

**Trees:**
- Dev core tree: `AionDX-impl\work-p0`, branch `p0-dev`.
  - `a535ea44`: the baseline core-0001..0018 from origin/main 30810c6.
  - Then a WIP commit: the gate plus the env scrub, NOT YET COMPILED.
- AionDX branch: `p0-human-routes` in `..\AionDX-p0` (off origin/main 30810c6).
- Cargo target: `%LOCALAPPDATA%\aiondx-build\p0-target`. A warm `cargo test --no-run` was started; its log is
  `p0-warm.log`.

**Next:**
1. `cargo test -p aionui-auth` (the human_only unit tests), then fix compile errors.
2. An integration test in aionui-app tests: a RuntimeToken call → 403 HUMAN_ONLY_ROUTE on each gated route; a session
   call → not 403; the config CLI's rename and settings language still pass. K1 tests (aionui-team lifecycle) still
   pass.
3. A test that `build_agent_process_env` drops `AIONCORE_BOOTSTRAP_SECRET`.
4. core-0020: header escaping in `aionui-team/src/prompts/mod.rs:129` (the wake payload) and core-0018's
   `midturn_teammate_text`. Neutralize body lines starting `- From ` / `## New Messages`, indent continuations. Test
   with forged headers.
5. Optional D-4, a SEPARATE commit: deny runtime-token reads of `aiondx.voice.config` (`GET /api/settings/client`).
6. Export the patches; build (a full rebuild, since the caches are on F:); run the wider suites against the baseline;
   update CONTRACT; report.

## Caller audit

Agent-side callers found:
- the `aioncore config` CLI (`crates/aionui-app/src/commands/cmd_config.rs`, used by the aiondx-config skill; it sends
  `x-aionui-runtime-token`);
- app patch 0007 (the loop tool's MCP row install, runtime token);
- 0009 (identity themes, runtime token);
- 0002 (claude-stream-proxy / account router, runtime token).

The renderer and the main process use a session, so they're unaffected.

| Route | Class | Agent-side callers | Decision |
|---|---|---|---|
| `POST /api/conversations/{id}/confirmations/{callId}/confirm` | answer a prompt | none. 0002's YOLO approver answers inside Claude's stream for chats the OWNER set to bypass, never via this route. | **gated** |
| `POST /api/conversations/{id}/asks/{requestId}/answer` | answer a question | none | **gated** |
| `PUT /api/conversations/{id}/config-options/{opt}` | permission mode (ids are agent-defined: `mode`, `session_mode`, …) | none (the CLI doesn't use it; the renderer uses a session) | **gated (whole route)** |
| `PUT /api/teams/{id}/conversations/{cid}/config-options/{opt}` | same | none | **gated** |
| `POST /api/teams/{id}/session-mode` | a team's permission mode | none | **gated** |
| `PATCH /api/conversations/{id}` | rename, pin, model, `extra` | the config CLI (rename) | **open; refused only when `extra` sets `session_mode` / `current_mode_id`** (0002's stream proxy reads these as the YOLO authority) |
| `PATCH /api/settings` | language, notifications, `cross_session_message_enabled` | the config CLI (`config settings patch`) | **open; refused only for `cross_session_message_enabled`** |
| `PUT /api/settings/client` | the client key-value store | the config CLI, 0002, 0007, 0009 | open (D-4: maybe deny `aiondx.voice.config` reads, separately) |
| `POST /api/auth/change-password`, `/api/webui/{change-password,change-username,reset-password,generate-qr-token}` | credentials | none | **gated** |
| `/api/auth/internal/*` | user admin | none (bootstrap-secret auth) | **the secret is scrubbed from agent env** |
| `POST /api/channel/pairings/{approve,reject}`, `/channel/users/revoke`, `/channel/plugins/{enable,disable}` | letting outside users in | none | **gated** |
| `POST /api/extensions/{permissions,risk-level}` | extension grants | none | **gated** |
| `/api/mobile/admin/*` | bridge pairing, devices | — | already Session/Local only (core-0016) |
| team lifecycle | — | — | already lead-only for runtime tokens (core-0015) |

**FLAG for Nathan (left open, because a shipped agent feature uses them):**
- `POST/PUT/DELETE /api/providers` (API keys) and `GET /api/providers` (reads them?);
- `/api/mcp/servers*` (an MCP row is a command line that gets executed);
- `/api/skills/import`, `/api/hub/*`, `/api/cron/jobs`, `/api/assistants*`.

All are reachable through the aiondx-config skill and the loop tool. Gating them would break "configure AionDX for me".
They're also code-execution or credential surfaces, so carve-outs need Nathan's call.
