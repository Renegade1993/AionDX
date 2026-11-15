# core-0019: routes only a human may call (SG-0, Phase 0 of docs/sage/CONTRACT.md)

Patch: `0001-human-only-routes.patch`. Applies after core-0018. Target: AionCore v0.2.2.
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

## Tests

- `human_only.rs` unit tests (5):
  - prompts and modes are refused;
  - a conversation PATCH is refused only for the mode keys;
  - settings are refused only for cross-session;
  - credentials, bots and extension grants are refused;
  - agent tools keep their routes.
- `middleware_tests.rs`, through the real `auth_middleware`:
  - `an_agent_cannot_call_a_human_only_route_but_the_user_can`: 403 `HUMAN_ONLY_ROUTE` on confirm, a PATCH with
    `extra.session_mode`, a settings PATCH with cross-session, and a bot pairing approval; a session JWT answers the
    same confirm with 200.
  - `agent_tools_keep_their_routes_and_bodies_pass_through_intact`: the config CLI's rename, a non-mode `extra`, a
    language setting and a provider create all pass, with bodies byte-identical.
- `agent_env.rs` `the_bootstrap_secret_never_reaches_an_agent`.
- D-4:
  - the unit test `the_voice_config_is_stripped_from_client_settings_reads`, plus the PUT rule in the settings test;
  - the middleware test `an_agent_never_sees_or_sets_the_voice_config_but_the_user_does`: an agent's read-all and its
    direct `?keys=` read both lack the key, and the secret appears nowhere in the body; its write is 403 while other
    keys are written; the session reads and writes the key.
- Results: aionui-auth 287, all green, including the K1/channel tests (`auth_channel_*`, `runtime_token_*`).
- Built and tested with `CARGO_BUILD_JOBS=6` and `--test-threads=4` (the lead's rule after a full-parallel build froze
  the PC). `tools/build-aioncore.ps1` gained `-Jobs` (default 6).

## State (2026-11-15, ready for a PR)

- Dev core tree: `AionDX-impl\work-p0`, branch `p0-dev`. Base `a535ea44` (core-0001..0018, origin/main 30810c6), HEAD
  `9f3dde47`.
- Exports:
  - core-0019 = `git diff a535ea44 HEAD -- Cargo.lock crates/aionui-auth crates/aionui-runtime`;
  - core-0020 = `git diff a535ea44 HEAD -- crates/aionui-team`.
  The whole series applied to v0.2.2 reproduces HEAD (0 diff lines).
- QA's live check of the core without D-4 passed (d9c7b7e7 on a 0.27.11 copy).
- Nathan (2026-11-15): providers / MCP / skills / cron / assistants stay open to agents for now; D-4 yes; open a PR.

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
| `GET`/`PUT /api/settings/client` | the client key-value store | the config CLI, 0002, 0007, 0009 | open, except `aiondx.voice.config`: stripped from agent reads, agent writes 403 (D-4) |
| `POST /api/auth/change-password`, `/api/webui/{change-password,change-username,reset-password,generate-qr-token}` | credentials | none | **gated** |
| `/api/auth/internal/*` | user admin | none (bootstrap-secret auth) | **the secret is scrubbed from agent env** |
| `POST /api/channel/pairings/{approve,reject}`, `/channel/users/revoke`, `/channel/plugins/{enable,disable}` | letting outside users in | none | **gated** |
| `POST /api/extensions/{permissions,risk-level}` | extension grants | none | **gated** |
| `/api/mobile/admin/*` | bridge pairing, devices | — | already Session/Local only (core-0016) |
| team lifecycle | — | — | already lead-only for runtime tokens (core-0015) |

**Left open by Nathan's decision of 2026-11-15** (a shipped agent feature uses them):
- `POST/PUT/DELETE /api/providers` (API keys) and `GET /api/providers` (reads them?);
- `/api/mcp/servers*` (an MCP row is a command line that gets executed);
- `/api/skills/import`, `/api/hub/*`, `/api/cron/jobs`, `/api/assistants*`.

All are reachable through the aiondx-config skill and the loop tool. Gating them would break "configure AionDX for me".
They're also code-execution or credential surfaces, so carve-outs need Nathan's call.
