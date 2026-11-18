# core-0023: routes only a human may call (SG-0, Phase 0 of docs/sage/CONTRACT.md)

Patch: `0001-human-only-routes.patch`. Applies after core-0022, before `tools\brand-names.js`. Target: AionCore v0.2.2.
Approved by Nathan ("yes do it", relayed by the lead on 2026-11-13; Phase 0 of the sage contract, draft 2).
Was core-0019 in PR #4 before 0.28.3 took core-0019..0022 (rebased 2026-11-18, see "0.28.3" below). LOCAL ONLY.

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

## D-4: the voice config (Nathan, 2026-11-15)

`aiondx.voice.config` holds the ElevenLabs API key the voice feature uses (patch 0011 `aiondx-voice.js`). The renderer
reads it through its session. The name stored in client settings is exactly `aiondx.voice.config`: the brand-names pass
only rewrites `aionui`, so the name is the same in the built core.

For a runtime-token caller:
- **Reads:** `GET /api/settings/client` (read-all, or `?keys=`) has the key removed from `data` before the response
  leaves AionCore. The config CLI's read-all still works; it just doesn't include the key. No other route returns client
  settings (`ClientPrefService` is read only by this handler; aionui-shell's speech-to-text uses prefs server-side and
  never returns them).
- **Writes:** a `PUT /api/settings/client` that sets or clears the key gets `403 HUMAN_ONLY_ROUTE`. An agent could
  otherwise swap in its own key and receive the audio. Other keys are written as before.
- Session and Local are unchanged.

Code: `human_only.rs` `PROTECTED_CLIENT_KEYS`, `filters_response`, `strip_protected_client_keys` and the PUT rule;
`middleware.rs` `strip_protected_keys`.

## 0.28.3: rebase and audit (2026-11-18)

Our two patches applied unchanged on top of 0.28.3's core-0001..0022 (origin/main f408991). The lead asked for an audit
of the new upstream features against these protections. Findings, with what was done:

- **F1, a break in our own gate (fixed).** PR #4 refused the whole `PUT .../config-options/{opt}` route, chat and team.
  Patch 0007's `aiondx member set` uses the team route for `--effort` (option ids `reasoning_effort`, `thought_level`,
  `effort`, `thinking_budget`, `thinking`: 0007 PATCH.md) and `--mode` (`FindOption(opts, "mode")` in
  `aiondx-loop.cs`). `--model` goes through `PATCH .../model`. So a lead agent's `member set --effort` would have got a
  403. The rule now refuses only the mode options, `mode` and `session_mode` (case-insensitive):
  - `mode`: the Claude and Codex session agents (`aionui-ai-agent/src/session_agent.rs`, the `"mode" =>` arm that
    sends `Command::SetMode`);
  - `session_mode`: the ACP catalog (`manager/acp/config_option_catalog.rs`, category Mode).

  Consequence: `aiondx member set --mode` is now human-only for agents (a lead can no longer change a member's
  permission mode). An ACP agent whose mode option has another id isn't covered.
- **F2, any-chat-talks (core-0019) (hardened in core-0024).**
  - A chat can now send to a team's chats. The `sender_is_team` refusal is gone, so team agents can send too.
  - The message goes in through the user's own team-message path (`send_message_to_conversation`, then
    `send_message` / `send_message_to_agent`), so the mailbox stores it as from `user`.
  - It adds no route that sends as the user beyond that, and no way around `cross_session_message_enabled`: the send
    still checks it, and only a human can switch it (`PATCH /api/settings` rule above).
  - Its body starts with the session-message block, which names the sending chat.
  - core-0024 now heads it in the wake payload as `another chat (relayed, not the user)`, not as `user`. The body is
    quoted like any other.
  - It also replaces control characters in the sending chat's name, which goes into the block. An agent can rename its
    own chat, and a line break in the name could otherwise add a forged `from:` / `reply_to:` line.
  - Left as it is: when the target lane is mid-turn, the message is handed to that turn the way the user's own
    mid-turn message is, as raw text with the block on top. This is upstream's delivery for any chat, team or not.
  - The new `POST /api/session-messages/block` only builds the `[[AION_SESSIONS]]` reference text for chats the caller
    names. It sends nothing.
- **F3, chat-hold (core-0020) (flagged, not gated).**
  - `POST /api/conversations/{id}/runtime/hold` with `stop: true` lets a runtime token end another chat's turn and keep
    its agent from starting until released. An AionCore restart releases everything.
  - It doesn't answer prompts, send as the user, or touch cross-session messaging.
  - Its only caller is the renderer's folder move (patch 0001 `aiondx-ui.js`, session auth), so gating it for agents
    would break nothing.
  - It's left open, like the other stop and cancel routes, pending a call. Gating it is a one-line rule.
- **F4, guarded ask-first chats (app patch 0002) (no change needed).**
  - "Guarded" is Windows' RedirectionGuard, which the Claude launcher turns on at start for any `--permission-mode` but
    `bypassPermissions` (`claude-account-router.js` `guardFor`, commit 14017ad).
  - That commit changes only the launcher, `aiondx-guard.exe` and its test, not how prompts are answered. Their prompts
    are the usual confirmation cards, which the user answers through the confirm route with a session. 0002's approver
    answers inside Claude's stream for bypass chats only. So the confirm gate doesn't break them.
  - An agent can't take a chat out of guarded mode: the mode keys in `PATCH /api/conversations/{id}`'s `extra`, the
    `mode` / `session_mode` config options, and `POST /api/teams/{id}/session-mode` all refuse runtime tokens.
  - The gap is the one in F1: an ACP mode option with another id.
- **F5, skills-every-agent and skill-view-files (core-0021/0022) (no change needed).** They add no setting and no
  credential surface. They mirror skills into each agent's folder and build skill views as files.

## Tests

- `human_only.rs` unit tests (6):
  - prompts and the mode options are refused; model and every effort id stay open (F1);
  - a conversation PATCH is refused only for the mode keys;
  - settings are refused only for cross-session;
  - credentials, bots and extension grants are refused;
  - agent tools keep their routes;
  - the voice config is stripped from client-settings reads.
- `middleware_tests.rs`, through the real `auth_middleware`:
  - `an_agent_cannot_call_a_human_only_route_but_the_user_can`: 403 `HUMAN_ONLY_ROUTE` on confirm, a PATCH with
    `extra.session_mode`, a settings PATCH with cross-session, a bot pairing approval, and the `mode` /
    `session_mode` config options (chat and team); a session JWT answers the same confirm with 200.
  - `agent_tools_keep_their_routes_and_bodies_pass_through_intact`: the config CLI's rename, a non-mode `extra`, a
    language setting, a provider create, and `config-options/model` and team `config-options/reasoning_effort` all
    pass, with bodies byte-identical.
  - D-4 `an_agent_never_sees_or_sets_the_voice_config_but_the_user_does`: an agent's read-all and its direct `?keys=`
    read both lack the key, and the secret appears nowhere in the body; its write is 403 while other keys are
    written; the session reads and writes the key.
- `agent_env.rs` `the_bootstrap_secret_never_reaches_an_agent`.
- Results on 0.28.3: see "State".
- Built and tested with `CARGO_BUILD_JOBS=6` and `--test-threads=4` (the lead's rule after a full-parallel build froze
  the PC). `tools/build-aioncore.ps1` has `-Jobs` (default 6).

## State

(2026-11-18, on 0.28.3; LOCAL, awaiting the lead's go to force-push PR #4)

- Dev core tree: `AionDX-impl\work-p028`, branch `p028-dev`.
  - Base `f5af0aff` is core-0001..0022 (origin/main f408991).
  - `3513fd7e`: ours applied unchanged.
  - `edc5f037`: F1, the F2 relabel, the renumbering.
  - HEAD `e62f8984`: the F2 chat-name fix.
- Exports:
  - core-0023 = `git diff f5af0aff HEAD -- Cargo.lock crates/aionui-auth crates/aionui-runtime`;
  - core-0024 = `git diff f5af0aff HEAD -- crates/aionui-team crates/aionui-session-message`.
- Every `patches\core-*\*.patch` applied to v0.2.2 in name order gives tree `7593547f`, the same tree as the dev HEAD.
- Release core: `tools\build-aioncore.ps1 -Patched -Jobs 6` built with all 24 core patches. `aioncore.exe` sha256
  `86ebea32ff365983c1e9e32416bdbdef401c1664398a2938cc159c454491bdaf`.
- Tests on the dev tree (`CARGO_BUILD_JOBS=6`, `--test-threads=4`):

  | Suite | Passed | Failed |
  |---|---|---|
  | aionui-auth | 287 | 0 |
  | aionui-session-message | 148 | 0 |
  | aionui-team | 779 | 3 |
  | aionui-conversation | 614 | 2 |
  | aionui-runtime | 86 | 8 |
  | aionui-app e2e (12 suites)* | 141 | 1 |

  \* auth, config_cli, team, team_cli, team_model, acp_config_options, runtime_team_tools, session_skill,
  system_settings, helper_runtime_auth, midturn, conversation_runtime_routes.

  Every failure also fails, by the same name, on the plain 0.28.3 baseline (`f5af0aff`, same machine):
  - aionui-team: three workspace-path tests in `session_service_integration`;
  - aionui-conversation: `create_rejects_unavailable_workspace_with_trailing_whitespace_in_request` and
    `is_auto_workspace_matches_by_structure_across_user_and_date`;
  - aionui-runtime: eight `node_runtime` / `shell_env` / `spawn` tests;
  - aionui-app: `session_skill` `the_skill_declares_the_name_the_resolver_will_discover`.
- Clippy (`--no-deps -D warnings`) has nothing in our code. The lints it reports are in upstream files
  (`aionui-team/src/session.rs`, `aionui-session-message/src/targets.rs`, `aionui-extension/src/skill_view.rs`).
- Earlier: QA's live check of PR #4's core (on 0.27.x). Nathan (2026-11-15): providers / MCP / skills / cron /
  assistants stay open to agents for now; D-4 yes.

## Caller audit

Agent-side callers found:
- the `aioncore config` CLI (`crates/aionui-app/src/commands/cmd_config.rs`, used by the aiondx-config skill; it sends
  `x-aionui-runtime-token`);
- app patch 0007 (the loop tool's MCP row install, and `aiondx member set`; runtime token);
- 0009 (identity themes, runtime token);
- 0002 (claude-stream-proxy / account router, runtime token).

The renderer and the main process use a session, so they're unaffected.

| Route | Class | Agent-side callers | Decision |
|---|---|---|---|
| `POST /api/conversations/{id}/confirmations/{callId}/confirm` | answer a prompt | none. 0002's YOLO approver answers inside Claude's stream for chats the OWNER set to bypass, never via this route. | **gated** |
| `POST /api/conversations/{id}/asks/{requestId}/answer` | answer a question | none | **gated** |
| `PUT /api/conversations/{id}/config-options/{opt}` | session options: the permission mode, model, effort | 0007 `member set` (team route) | **gated for `mode` / `session_mode` only** (F1) |
| `PUT /api/teams/{id}/conversations/{cid}/config-options/{opt}` | same | 0007 `member set --effort/--mode` | **gated for `mode` / `session_mode` only** (F1) |
| `POST /api/teams/{id}/session-mode` | a team's permission mode | none | **gated** |
| `PATCH /api/conversations/{id}` | rename, pin, model, `extra` | the config CLI (rename) | **open; refused only when `extra` sets `session_mode` / `current_mode_id`** (0002's stream proxy reads these as the YOLO authority) |
| `PATCH /api/settings` | language, notifications, `cross_session_message_enabled` | the config CLI (`config settings patch`) | **open; refused only for `cross_session_message_enabled`** |
| `GET`/`PUT /api/settings/client` | the client key-value store | the config CLI, 0002, 0007, 0009 | open, except `aiondx.voice.config`: stripped from agent reads, agent writes 403 (D-4) |
| `POST /api/auth/change-password`, `/api/webui/{change-password,change-username,reset-password,generate-qr-token}` | credentials | none | **gated** |
| `/api/auth/internal/*` | user admin | none (bootstrap-secret auth) | **the secret is scrubbed from agent env** |
| `POST /api/channel/pairings/{approve,reject}`, `/channel/users/revoke`, `/channel/plugins/{enable,disable}` | letting outside users in | none | **gated** |
| `POST /api/extensions/{permissions,risk-level}` | extension grants | none | **gated** |
| `POST /api/conversations/{id}/runtime/hold` (0.28.3, core-0020) | stop and hold a chat's agent | none (the renderer's folder move, session) | open, flagged (F3) |
| `POST /api/session-messages/block` (0.28.3, core-0019) | build reference text | none | open (sends nothing) |
| `/api/mobile/admin/*` | bridge pairing, devices | — | already Session/Local only (core-0016) |
| team lifecycle | — | — | already lead-only for runtime tokens (core-0015) |

**Left open by Nathan's decision of 2026-11-15** (a shipped agent feature uses them):
- `POST/PUT/DELETE /api/providers` (API keys) and `GET /api/providers` (reads them?);
- `/api/mcp/servers*` (an MCP row is a command line that gets executed);
- `/api/skills/import`, `/api/hub/*`, `/api/cron/jobs`, `/api/assistants*`.

All are reachable through the aiondx-config skill and the loop tool. Gating them would break "configure AionDX for me".
They're also code-execution or credential surfaces, so carve-outs need Nathan's call.
