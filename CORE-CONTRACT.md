# What AionDX needs from its backend (for a rebuilt AionDX Core)

Written November 9th, 2026, at release 0.26.3, for whoever rebuilds AionCore as AionDX's own backend. AionDX today runs AionCore v0.2.2
(tag `v0.2.2`, commit `47e66d0d`) with fourteen patches applied, renamed to AionDX (crates `aiondx-*`, variables `AIONDX_*`). A rebuilt core
keeps everything below, or AionDX's page, its Claude launcher, its tools and its installer break in ways the tests list.

Read with: each `patches/core-NNNN-*/PATCH.md` (what, why, how it was checked), `tools/build-aioncore.ps1` (how the core is built: a clean
checkout of the tag, the patches in name order with `git apply`, then `tools/brand-names.js --mode core`, then `cargo build -p aiondx-app`),
and `tools/brand-names.js` (which names stay as they were on purpose: stored values, key-derivation prefixes, licence notices).

## 1. The fourteen core patches: behaviour to keep

| Patch | Behaviour a rebuild must keep |
|---|---|
| core-0001 mcp-per-chat | `PUT /api/conversations/{id}/mcp`: per-chat MCP server choice; live MCP status per conversation (`conversation.mcpStatusChanged`) |
| core-0002 respond-now | `POST /api/teams/{id}/agents/{slot}/steer`: a message goes ahead of a member's queue and into its running turn |
| core-0003 names | the built-in assistants call the app AionDX |
| core-0004 unsend-queued | a message still in a team member's queue can be taken back |
| core-0005 open-path | `POST /api/shell/open-path {path, action: auto\|reveal\|run}`: a folder opens in Explorer, a program is shown selected, a file opens in its own program |
| core-0006 replace-agent | `POST /api/teams/{id}/agents/{slot}/replace`: swap the agent in any slot, the lead's included |
| core-0007, core-0008 | MCP OAuth login: RFC 9728 protected-resource discovery first; RFC 7591 client registration when the server names one; the client id kept with the token |
| core-0009 conversation-anchors | `GET /api/conversations/{id}/anchors`: every user turn of a chat in one request (the page's turn rail) |
| core-0010 hard-stop | Stop is a hard stop: a cancelled conversation gets no scheduled task until the user writes again; a missed scheduled task is skipped after a restart; a message to a busy member goes into its running turn; no "Proceed with your work" in wake payloads |
| core-0011, core-0012 | the stored MCP OAuth token goes with a connection test and with a real session's MCP server |
| core-0013 adopt-legacy-database | an earlier `aionui-backend.db` (with `-wal`, `-shm`) is renamed to `aiondx-backend.db` on start |
| core-0014 launch-skills | at every launch, each current auto-inject skill a conversation's creation snapshot lacks is added and its skill view rebuilt |

## 2. Routes AionDX's own code calls

Besides the patched routes above. "Page" is `patches/0001-renderer-dx/aiondx-ui.js`; "launcher" is
`patches/0002-claude-model-currency/claude-account-router.js` and `claude-stream-proxy.js`; "tool" is `patches/0007-loop-tool/aiondx-loop.cs`.

- Conversations: `GET /api/conversations?limit=` (items with `id`, `name`, `modified_at`), `GET /api/conversations/{id}` (`extra`
  with `agent_id`, `teamId`, `workspace`, `backend`; `runtime` with `turn_id`, `state`, `is_processing`; `updated_at`, `created_at`,
  `archived_at`), `PATCH /api/conversations/{id}` (`name`), `POST .../cancel {turn_id}`, `POST .../runtime/restart` (end the agent process
  and start it again, history and session kept), `POST .../runtime/ensure`, `GET .../usage` (`used`, `size`, `cost {amount, currency}`,
  served with or without a live agent), `GET .../confirmations` (pending permission requests and questions: `id`, `call_id`),
  `GET .../slash-commands` (the page looks for `compact` or `compress`), `GET .../messages?limit=&before=`, `POST .../messages {content}`.
- Teams: `GET /api/teams`, `GET /api/teams/{id}` (`agents` or `assistants`: `slot_id`, `conversation_id`, `name`, `role`, `backend`),
  `PATCH /api/teams/{id}/name`, `GET .../run-state` (`slot_work`: `slot_id`, `state`, `active_turn_id`), `GET .../mailbox`,
  `POST .../agents/{slot}/messages`, `POST .../agents/{slot}/attach`, `POST .../agents/{slot}/runtime/restart`,
  `POST .../agents/{slot}/context/reset` (fresh context; the lead cannot be reset), `POST .../runs/{run}/agents/{slot}/pause`
  (the page sends `runs/stop/agents/{slot}/pause` to pause a member with no active run), `POST/DELETE .../session`.
- Sidebar: `POST /api/sidebar/conversation/{id}/archive`, `POST /api/sidebar/team/{id}/archive`.
- Settings store: `GET/PUT /api/settings/client` (`client_preferences`): every `aiondx.*` key (Loops, usage readings, groups, options,
  accounts). Agents read and write the same keys through the tool, with their runtime token.
- Files and shell: `POST /api/fs/metadata`, `/api/fs/image-base64`, `/api/shell/open-file`, `/api/shell/show-item-in-folder`,
  `/api/shell/open-folder-with`, `/api/shell/open-external`.
- MCP: `GET /api/mcp/servers`, `POST /api/mcp/servers/{id}/toggle`, `POST /api/mcp/test-connection`.
- Assistants: `GET /api/assistants`, `GET /api/assistants/{id}`.

## 3. What the core gives an agent process

- Environment: `AIONDX_CONVERSATION_ID`, `AIONDX_USER_ID`, `AIONDX_BASE_URL`, `AIONDX_RUNTIME_TOKEN`, `AIONDX_HELPER_BIN`; requests from
  an agent carry `x-aiondx-runtime-token`, `x-aiondx-user-id`, `x-aiondx-conversation-id`. The launcher also reads the `AIONUI_*` names,
  for an agent an older core started.
- Claude Code is started as `claude` from PATH. AionDX's `claude.exe` shim there runs the launcher, which picks the account per chat
  (`CLAUDE_CONFIG_DIR`, `HOME`, the token), the newest Claude Code build, the usage tap, the project's `--add-dir`, and the closed-by-default
  claude.ai switches. A rebuilt core that starts Claude another way loses all of that.
- Skills: `--plugin-dir <the conversation's skill view>` plus one `--add-dir` per skill (layer 1), decided at every launch (core-0014).

## 4. The database AionDX's tools read directly

`%APPDATA%\AionDX\aionui\aiondx-backend.db` (SQLite, opened read-only by the tools except the picker refresh):
`conversations` (`extra` JSON), `teams` (`agents` JSON, `archived_at`), `agent_metadata` (`available_models`, `config_options`, `env`;
rewritten by `aiondx-model-refresh.js`), `client_preferences` (the settings store), `acp_session` (`session_config.runtime.context_usage`),
`messages` (counts and timestamps only). The installer's data move (`patches/0016-data-move`) rewrites every stored absolute path when the
data folder moves; a new table that stores paths needs adding there.

## 5. AionCore behaviours AionDX works around (worth fixing in a rebuild)

- Desktop notices for questions come from the live event stream only, keyed by chat and message; a late or dropped event (the renderer's
  channel fills and drops events) gives no notice. AionDX polls `/confirmations` as a backstop (patch 0019).
- A conversation's `status` reads "finished" while its runtime is mid-turn; `runtime` is the truth.
- A conversation's skills were a snapshot at creation, and an exclusion chosen at creation is not stored after it (core-0014 adds new
  auto-inject skills back at launch, exclusions included).
- `extra.last_token_usage` is never written; the context count lives in `acp_session` and `/usage`.
- A Claude agent's model picker is rewritten at each chat start from the live session's list, which can lack models the account has
  (November 9th: the Fable models); AionDX re-merges the account catalog every 15 minutes.
- AionUi "projects" point only at chat folders, so nothing tells which real project a chat belongs to; AionDX keeps its own registry
  (`%APPDATA%\AionDX\aiondx-projects.json`) for project skills and the Claude Docs scoping.
- Stop: a press can carry a stale turn id and a turn can start from a queue right after; the page now escalates to `runtime/restart`.

## 6. Tests that exercise the core through the app

Run against a staged build (`tools/build-release.ps1 -Version X -AionDxCore`): `tools/smoke-standalone.js`, `tools/test-live-*.js`
(official, anchors, context, groups, dollar, menu, data folder), `tools/test-installer-migrate.js`, and the page suite
`tools/dx-harness/click-test.js` (stubbed routes). `cargo test` per touched crate for the core itself.
