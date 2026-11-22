# core-0024: routes only a human may call (SG-0, Phase 0 of docs/sage/CONTRACT.md)

Patch: `0001-human-only-routes.patch`. Applies after core-0023, before `tools\brand-names.js`. Target: AionCore v0.2.2.
Approved by Nathan ("yes do it", relayed by the lead on 2026-11-13; Phase 0 of the sage contract, draft 2).
History: core-0019 in PR #4. It became core-0023 when 0.28.3 took core-0019..0022 (2026-11-18), then core-0024 when 0.28.5
took core-0023 (2026-11-21). See "0.28.3" and "0.28.5" below.

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
- **F2, any-chat-talks (core-0019) (hardened in core-0025).**
  - A chat can now send to a team's chats. The `sender_is_team` refusal is gone, so team agents can send too.
  - The message goes in through the user's own team-message path (`send_message_to_conversation`, then
    `send_message` / `send_message_to_agent`), so the mailbox stores it as from `user`.
  - It adds no route that sends as the user beyond that, and no way around `cross_session_message_enabled`: the send
    still checks it, and only a human can switch it (`PATCH /api/settings` rule above).
  - Its body starts with the session-message block, which names the sending chat.
  - core-0025 now heads it in the wake payload as `another chat (relayed, not the user)`, not as `user`. The body is
    quoted like any other.
  - It also replaces control characters in the sending chat's name, which goes into the block. An agent can rename its
    own chat, and a line break in the name could otherwise add a forged `from:` / `reply_to:` line.
  - Left as it is: when the target lane is mid-turn, the message is handed to that turn the way the user's own
    mid-turn message is, as raw text with the block on top. This is upstream's delivery for any chat, team or not.
  - The new `POST /api/session-messages/block` only builds the `[[AION_SESSIONS]]` reference text for chats the caller
    names. It sends nothing.
- **F3, chat-hold (core-0020) (gated: the lead, 2026-11-21).**
  - `POST /api/conversations/{id}/runtime/hold` with `stop: true` lets a runtime token end another chat's turn and keep
    its agent from starting until released. An AionCore restart releases everything.
  - It doesn't answer prompts, send as the user, or touch cross-session messaging.
  - Its only caller is the renderer's folder move (patch 0001 `aiondx-ui.js`, session auth), so gating it for agents
    would break nothing.
  - The lead's decision (least privilege): it refuses runtime tokens with `403 HUMAN_ONLY_ROUTE`.
    `runtime/restart` and the stop and cancel routes stay open.
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

Lead's decisions (2026-11-21): F1 stays narrow (`member set --mode` being human-only is correct: a lead shouldn't put a
member into bypass); the F2 fixes are accepted; F3 is gated.

## 0.28.5: rebase and audit (2026-11-21)

0.28.5 changed none of core-0001..0022 and added core-0023-local-folders-and-stdin. Ours applied on top without conflicts.
Audit of core-0023:
- **G1, a `local` attachment may be a folder (no change needed).**
  - There's no new route: the message send routes already took `local` attachments. The path must exist and is
    canonicalized (`aionui-project/src/chat_files.rs`); a folder is now accepted as well as a regular file.
  - The canonical path goes into the message after the files marker, as a file's always did. In a team chat that text is
    a message body, so core-0025's quoting covers it. A Windows path can't hold a line break anyway.
  - An agent learns nothing new: it reads the folder with its own tools, and it could already name any path in its text.
  - It doesn't touch the gates: no prompt answering, no mode, no settings.
- **G2, the CLI reads JSON piped from Windows PowerShell (no change needed).** `aioncore` commands now drop a leading byte
  order mark (or decode UTF-16) on stdin (`commands/stdin_text.rs`). This is client-side only; no route or server check
  changed. Agents on a PC without Git Bash can now use the config CLI from PowerShell, and its calls still go through the
  gate.
## Tests

- `human_only.rs` unit tests (6):
  - prompts and the mode options are refused; model and every effort id stay open (F1);
  - a conversation PATCH is refused only for the mode keys;
  - settings are refused only for cross-session;
  - credentials, bots, extension grants and chat-hold are refused (F3);
  - agent tools keep their routes (`runtime/restart` included);
  - the voice config is stripped from client-settings reads.
- `middleware_tests.rs`, through the real `auth_middleware`:
  - `an_agent_cannot_call_a_human_only_route_but_the_user_can`: 403 `HUMAN_ONLY_ROUTE` on confirm, a PATCH with
    `extra.session_mode`, a settings PATCH with cross-session, a bot pairing approval, the `mode` /
    `session_mode` config options (chat and team), and a chat-hold with `stop`; a session JWT answers the same confirm and
    holds a chat, both 200.
  - `agent_tools_keep_their_routes_and_bodies_pass_through_intact`: the config CLI's rename, a non-mode `extra`, a
    language setting, a provider create, and `config-options/model` and team `config-options/reasoning_effort` all
    pass, with bodies byte-identical.
  - D-4 `an_agent_never_sees_or_sets_the_voice_config_but_the_user_does`: an agent's read-all and its direct `?keys=`
    read both lack the key, and the secret appears nowhere in the body; its write is 403 while other keys are
    written; the session reads and writes the key.
- `agent_env.rs` `the_bootstrap_secret_never_reaches_an_agent`.
- Results on 0.28.5: see "State".
- Built and tested with `CARGO_BUILD_JOBS=6` and `--test-threads=4` (the lead's rule after a full-parallel build froze
  the PC). `tools/build-aioncore.ps1` has `-Jobs` (default 6).

## State

(2026-11-21, on 0.28.5. The lead OK'd a force-push of p0-human-routes once the tests are green and the series tree is
re-verified.)

- Dev core tree: `AionDX-impl\work-p028`, branch `p0285-dev`.
  - Base `bee92fe1` is core-0001..0023 (origin/main 7912efd).
  - Ours cherry-picked without conflicts (`95ce2531`, `a0c0f20b`, `fde9d08f`).
  - HEAD `68057889`: the renumbering plus the F3 gate.
- Exports:
  - core-0024 = `git diff bee92fe1 HEAD -- Cargo.lock crates/aionui-auth crates/aionui-runtime`;
  - core-0025 = `git diff bee92fe1 HEAD -- crates/aionui-team crates/aionui-session-message`.
- Every `patches\core-*\*.patch` (26 files) applied to v0.2.2 in name order gives tree `df991165`, the same tree as the
  dev HEAD.
- Release core: `tools\build-aioncore.ps1 -Patched -Jobs 6` built with all 25 core patches. `aioncore.exe` sha256
  `1fbbc9968c5b5066675cfa7fb47bad83f3028f079a2738796da4d22b2795a653`.
- Tests on the dev tree vs the plain 0.28.5 baseline (`bee92fe1`), same machine, `CARGO_BUILD_JOBS=6`, `--test-threads=4`:

  | Suite | Ours: passed / failed | Baseline: passed / failed |
  |---|---|---|
  | aionui-auth | 287 / 0 | — |
  | aionui-session-message | 148 / 0 | 147 / 0 |
  | aionui-team | 779 / 3 | 775 / 3 |
  | aionui-conversation | 614 / 2 | 614 / 2 |
  | aionui-runtime | 86 / 8 | 86 / 8 |
  | aionui-project (upstream core-0023's crate) | 377 / 26 | 377 / 26 |
  | aionui-app e2e (12 suites)* | 141 / 1 | `session_skill` fails there too |

  \* auth, config_cli, team, team_cli, team_model, acp_config_options, runtime_team_tools, session_skill,
  system_settings, helper_runtime_auth, midturn, conversation_runtime_routes.

- The failing tests are the same, by name, on both trees:
  - Windows path and separator tests in aionui-project (`canonical`, `containment`, `scm::git_provider`,
    `tree_model`), in aionui-team (`session_service_integration`, workspace) and in aionui-conversation (workspace);
  - aionui-runtime's eight `node_runtime` / `shell_env` / `spawn` tests;
  - `session_skill`.
- The first run of ours also failed `stream_relay_emits_feedback_runtime_terminal_log` (aionui-conversation, which no
  patch of ours touches). It passed 5 of 5 times alone and in a full rerun of that suite, so it's a timing flake.
- Clippy (`--no-deps -D warnings`) has nothing in our code. The lints it reports are in upstream files.
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
| `POST /api/conversations/{id}/runtime/hold` (0.28.3, core-0020) | stop and hold a chat's agent | none (the renderer's folder move, session) | **gated** (F3, the lead 2026-11-21) |
| `POST /api/session-messages/block` (0.28.3, core-0019) | build reference text | none | open (sends nothing) |
| `/api/mobile/admin/*` | bridge pairing, devices | — | already Session/Local only (core-0016) |
| team lifecycle | — | — | already lead-only for runtime tokens (core-0015) |

**Left open by Nathan's decision of 2026-11-15** (a shipped agent feature uses them):
- `POST/PUT/DELETE /api/providers` (API keys) and `GET /api/providers` (reads them?);
- `/api/mcp/servers*` (an MCP row is a command line that gets executed);
- `/api/skills/import`, `/api/hub/*`, `/api/cron/jobs`, `/api/assistants*`.

All are reachable through the aiondx-config skill and the loop tool. Gating them would break "configure AionDX for me".
They're also code-execution or credential surfaces, so carve-outs need Nathan's call.
