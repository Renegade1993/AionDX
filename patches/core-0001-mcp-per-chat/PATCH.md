# core-0001: per-chat MCP selection and live MCP status

Patch: `0001-mcp-per-chat.patch` in this folder.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`), the same sources as `upstream-aioncore`.
Size: 16 files, 62 hunks, 1895 lines added, 52 removed. Written September 26th, 2026.

## What it changes

1. A new route, `PUT /api/conversations/{id}/mcp`, replaces the MCP servers of a conversation
   that already exists, for solo chats and for team members' conversations. The change reaches
   the running agent: an idle solo agent restarts at once, a busy one restarts when its work
   ends, and a team member restarts through the team's own restart gate.
2. Live MCP status. What the agent CLI itself reports for each server is kept on the session,
   returned by `GET /api/conversations/{id}` as `runtime.mcp_servers`, and pushed over the
   WebSocket as `conversation.mcpStatusChanged` whenever a server's state changes. Claude Code
   and Codex sessions report it.
3. Deleting a server stops it. A soft-deleted server no longer launches in chats whose frozen
   selection still lists it (all three session loaders), and new snapshots leave it out.

A request of September 26th, 2026 asked for MCP to be fully configurable and transparent to agents,
and for per-chat MCP to be a permanent one-time fix. The investigation behind this patch is
`! LLM Files\Research\2026-09-26_mcp-configurable-and-transparent.md`; this patch closes its
gaps 1 (no per-chat control after creation), 3 (no live connection status) and 6 (deleted
servers keep launching).

## The API

### PUT /api/conversations/{id}/mcp

Send one of:

```json
{ "server_ids": ["mcp_abc", "mcp_builtin_img"] }
{ "inherit": true }
```

- `server_ids`: MCP row ids from `GET /api/mcp/servers`, builtin rows included, the same ids
  creation takes. `selected_mcp_server_ids` and `mcp_ids` are accepted as aliases. `[]` selects
  no server. Duplicates and blank ids are dropped; order is kept.
- `inherit: true`: drop the conversation's own selection and resolve again the way creation does
  with no explicit pick. That is the assistant's binding (its fixed list, or its remembered Auto
  pick) when the conversation has an assistant, and every globally enabled server otherwise. A
  team member without an assistant gets none.
- Both fields, or neither: 400.
- Unknown, soft-deleted or reserved (`aionui-team`) ids: 400 naming them, and nothing is written.

Response `data`:

```json
{ "conversation": { "...": "same as GET /api/conversations/{id}" }, "runtime_action": "restarted" }
```

| `runtime_action` | Meaning |
|---|---|
| `next_start` | No agent was running; the next session start reads the new selection. Also returned for a team member with no assistant, and when an immediate restart failed after the old process stopped. |
| `restarted` | The idle agent was restarted with the new selection before the response returned. |
| `deferred` | The agent was busy (a claimed turn, a turn it runs on its own, or background tasks). It restarts once idle; `runtime.mcp_restart_pending` is `true` until then. |
| `team` | Team member with an assistant. The team runtime restarts it now if idle, after its current work if busy, or at its next attach if dormant. |

What it writes: the four snapshot fields in `extra` (`mcp_server_ids`, `session_mcp_servers`,
`mcp_servers`, `mcp_statuses`), built by `build_runtime_mcp_snapshot`, the builder creation uses,
plus `extra.mcp_selection = { "source": "conversation", "server_ids": [...] }` for an explicit
selection (`inherit` removes it). User rows are frozen by id and builtin rows become launch-ready
session servers, the same split an assistant binding gets. The assistant's Auto-mode
`last_mcp_ids` preference is left alone, so changing one chat never restarts other chats or team
members bound to the same assistant.

Events: `conversation.mcpChanged` with `{ user_id, conversation_id, team_id?, mcp_server_ids,
mcp_servers, runtime_action }`, and `conversation.listChanged` with `action: "updated"`, which
makes an open conversation refetch. For a team member with an assistant, also
`assistant.mcpBindingChanged` for that assistant (see Design).

### GET /api/conversations/{id}: two new runtime fields

```json
"runtime": {
  "state": "idle",
  "mcp_servers": [
    { "name": "airtable", "status": "degraded", "error": "mcp server 'airtable' needs auth" },
    { "name": "aiondx-loop", "status": "connected" }
  ],
  "mcp_restart_pending": true
}
```

`status` is `pending`, `connected`, `degraded` or `failed`. Claude's `needs-auth` arrives as
`degraded` with the error text shown; Codex's `cancelled` and a failed Codex OAuth login also map
to `degraded`, with Codex's own error text. `mcp_servers` is absent while no agent runs, for
backends that report nothing (ACP-manager agents, aionrs, Antigravity), and for Claude until its
first turn starts, because Claude sends the report in a turn's `system/init` frame.
`mcp_restart_pending` is omitted when false. Both fields are additive, and the same summary rides
the send and turn-completed payloads.

### WebSocket event conversation.mcpStatusChanged

`{ user_id, conversation_id, mcp_servers: [...] }` with the full list, sent from the session's
event pump only when a server's state changes. Claude re-reports every server at each turn's
init; repeats are dropped.

### PATCH /api/conversations/{id}

Behavior unchanged, except that it now also refuses `extra.mcp_selection`, and its 400 message
ends with "change MCP servers with PUT /api/conversations/{id}/mcp". Creation strips a
client-supplied `extra.mcp_selection`.

## Design

### Why a dedicated route

PATCH merges into `extra` and deliberately refuses every MCP key today. The MCP snapshot is four
derived fields that must change together, and changing it restarts the agent. Folding that into
PATCH would give a restart side effect to a call the renderer already uses for workspace, name
and pin updates. A separate `PUT` leaves PATCH as it was (one more refused key), carries its own
response contract (`runtime_action`), and is idempotent.

### Reusing creation's resolution

The explicit path splits ids with `split_selected_mcp_rows`, which is the loop
`resolve_assistant_mcp_selection` already had, now shared by both, and then calls
`build_runtime_mcp_snapshot`. `inherit` calls `resolve_assistant_mcp_selection` or creation's
all-enabled fallback. Nothing about snapshot shape is duplicated.

### Solo chats

`try_begin_idle_restart` takes the existing restart gate only when no turn is claimed, atomically
with that check: either the running turn wins and the restart waits, or the restart wins and new
sends get the existing `runtime_restarting` 409 until it is done. The rebuild is the tail of the
existing `restart_runtime` (kill with `RuntimeRestart`, clear turn state, `ensure_runtime_agent`),
so the backend session resumes with its history. A busy agent gets one background waiter per
conversation. It sleeps on the runtime state's existing release notifier (`wait_until_idle`), polls
every 5 seconds only while the agent is busy without a claimed turn, and exits after restarting,
when the runtime disappears (idle kill or delete; the next start reads the selection anyway), or
on shutdown. A second change while one is pending reuses the same waiter, because its restart
reads the newest row.

### Team members

`aionui-team` already re-resolves every member of an assistant on `assistant.mcpBindingChanged`
and restarts a member through its work-coordinator gate (now if idle, deferred while busy, at
attach if dormant). Two changes let a conversation's own selection use that path with no edit to
`aionui-team`:

- The conversation adapter in `aionui-app` (`resolve_conversation_mcp_snapshot`) returns the
  conversation's persisted snapshot, with the fingerprint of its own ids, whenever
  `extra.mcp_selection` is present. Re-attach and assistant edits then keep the per-chat choice,
  and the attach records it as applied, so the same selection never restarts the member twice.
- The PUT publishes `assistant.mcpBindingChanged` for the member's assistant. The member resolves
  to its new selection and restarts; other members of that assistant resolve to their unchanged
  binding and stay put. In v0.2.2 the team handler uses only the event's user and assistant ids
  and ignores its fingerprint.

### Live status

`SessionEvent::Provisioning` gains `server: Option<String>` (serde default, omitted when `None`,
so stored events stay readable in both directions). Claude's `system/init.mcp_servers[]` and
Codex's `mcpServer/startupStatus/updated` and `mcpServer/oauthLogin/completed` fill it with the
server name. The session event pump keeps a per-server list on `SessionRuntime` and broadcasts
when it changes; `AgentInstance::mcp_server_statuses` exposes the list, and `runtime_summary_for`
copies it into the summary. The list lives with the runtime, so after a restart there is no status
until the CLI reports again.

### Soft delete

`list_by_ids_any` returns soft-deleted rows by contract (pinned by `aionui-db`'s own test
`list_by_ids_any_includes_soft_deleted_rows`), so the fix is in its callers: the three session
loaders skip rows with `deleted_at` set, and the two snapshot builders leave them out.

## Files and functions touched

| File | Change |
|---|---|
| `crates/aionui-api-types/src/conversation.rs` | New types `UpdateConversationMcpRequest`, `UpdateConversationMcpResponse`, `ConversationMcpRuntimeAction`, `ConversationMcpChanged`, `McpServerLiveState`, `McpServerLiveStatus`, `ConversationMcpStatusChangedPayload`; constants `CONVERSATION_MCP_SELECTION_KEY`, `CONVERSATION_MCP_CHANGED_EVENT`, `CONVERSATION_MCP_STATUS_CHANGED_EVENT`; function `conversation_mcp_selection_fingerprint`; `ConversationRuntimeSummary` gains `mcp_servers` and `mcp_restart_pending`. 4 tests. |
| `crates/aionui-api-types/src/lib.rs` | Re-exports. |
| `crates/aionui-session/src/event.rs` | `SessionEvent::Provisioning` gains `server`. Test constructions updated; the serde round-trip test gains a named-server case. |
| `crates/aionui-session/src/reducer.rs` | Three test constructions only (the new field). |
| `crates/aionui-session/src/backend/claude_conn.rs` | `sniff_init` names the server. Its test asserts the names. |
| `crates/aionui-session/src/backend/codex_conn.rs` | `map_notification` names the server; new helper `mcp_server_name`. Two tests extended. |
| `crates/aionui-ai-agent/src/session_agent.rs` | `SessionRuntime` field `mcp_servers` with `record_mcp_server_status` and `mcp_servers`; `SessionAgentTask::mcp_server_statuses`; a hook in `spawn_event_pump`; new `mcp_live_status`, `upsert_mcp_live_status`, `broadcast_mcp_status_frame`. 2 tests. |
| `crates/aionui-ai-agent/src/agent_task.rs` | `AgentInstance::mcp_server_statuses`. |
| `crates/aionui-ai-agent/src/mcp_resolve.rs` | `resolve_session_mcp_servers` skips soft-deleted rows (Claude, Codex, Antigravity). 1 test. |
| `crates/aionui-ai-agent/src/factory/acp.rs` | `load_user_mcp_servers` skips soft-deleted rows (ACP-manager agents). 1 test. |
| `crates/aionui-ai-agent/src/factory/aionrs.rs` | `load_user_mcp_servers` skips soft-deleted rows (aionrs). 1 test. |
| `crates/aionui-conversation/src/runtime_state.rs` | State `pending_mcp_restarts`; new `wait_until_idle`, `try_begin_idle_restart`, `mark_pending_mcp_restart`, `clear_pending_mcp_restart`, `has_pending_mcp_restart`; `clear_conversation` and `summary_from_parts` updated. 4 tests. |
| `crates/aionui-conversation/src/service.rs` | `create` strips the marker; `update` refuses it and names the new route; `runtime_summary_for` fills live status; new `update_mcp_selection`, `inherited_mcp_selection`, `conversation_assistant_id`, `apply_mcp_selection_to_runtime`, `rebuild_runtime_for_mcp`, `schedule_deferred_mcp_restart`, `run_deferred_mcp_restart`, `publish_conversation_mcp_changed`, `split_selected_mcp_rows`, and free functions `dedup_mcp_server_ids`, `write_mcp_snapshot_into_extra`, `agent_has_work_in_flight`; `build_runtime_mcp_snapshot` leaves out deleted rows; `resolve_assistant_mcp_selection` uses the shared split. |
| `crates/aionui-conversation/src/routes.rs` | Route `PUT /api/conversations/{id}/mcp`, handler `update_mcp`. |
| `crates/aionui-conversation/src/service_test.rs` | Helper `make_service_with_mcp_catalog` (in-memory SQLite MCP catalog) and 9 tests. |
| `crates/aionui-app/src/router/team_conversation_adapters.rs` | `resolve_conversation_mcp_snapshot` honors `extra.mcp_selection`; new `conversation_owned_mcp_snapshot_resolution`. 1 test. |

Not touched: `aionui-team`, `aionui-db`, the renderer, the `aioncore` CLI.

## How to verify

### 1. Apply

From the root of a v0.2.2 checkout:

```
git apply --check patches/core-0001-mcp-per-chat/0001-mcp-per-chat.patch
git apply patches/core-0001-mcp-per-chat/0001-mcp-per-chat.patch
```

The patch is LF. With `core.autocrlf=true` (this machine's global setting) git normalizes the CRLF
working tree while applying and writes CRLF back. The `index` lines carry the real v0.2.2 blob
ids, so `git apply -3` can do a three-way merge on a later release.

How it was checked on September 26th, 2026, without running cargo:

- LF scratch repo holding only the 16 original files, taken from the `v0.2.2` blobs:
  `git apply --check` passed, `git apply` produced files byte-identical to the edited tree, and
  `git apply -R --check` passed.
- CRLF scratch repo with `core.autocrlf=true`, files copied from the reference clone's working
  tree: `git apply --check` and `git apply` passed; the results match the edited tree apart from
  line endings and are uniformly CRLF. The delivered file was checked again the same way.
- Every preimage `index` id equals `git rev-parse v0.2.2:<path>`.
- All 16 edited files went through the 1.95.0 toolchain's own `rustfmt.exe` on stdin with the
  repo's settings (`max_width=120`, `style_edition=2024`, `fn_params_layout=Tall`): they parse and
  are format-clean, and the pristine originals were already clean under those settings. That is a
  syntax check, not a compile.

### 2. Build and tests

```
cargo test -p aionui-api-types
cargo test -p aionui-session
cargo test -p aionui-ai-agent
cargo test -p aionui-conversation
cargo test -p aionui-app --lib owned_selection
cargo build --release -p aionui-app
```

New tests: `deserialize_update_mcp_request_accepts_the_creation_field_names`,
`conversation_mcp_selection_fingerprint_matches_the_assistant_fingerprint`,
`runtime_summary_mcp_fields_are_additive`, `conversation_mcp_changed_payload_round_trip`,
`mcp_live_status_maps_every_provisioning_phase`,
`mcp_provisioning_is_kept_per_server_and_broadcast_on_change`,
`resolve_skips_soft_deleted_rows_in_a_frozen_selection`,
`load_user_mcp_servers_skips_soft_deleted_rows_in_a_frozen_selection`,
`aionrs_skips_soft_deleted_rows_in_a_frozen_selection`,
`idle_restart_gate_waits_for_the_claimed_turn_then_blocks_new_ones`,
`idle_restart_gate_refuses_a_deleting_conversation`,
`pending_mcp_restart_is_marked_once_and_shows_in_the_summary`,
`wait_until_idle_outlasts_the_turn_and_the_restart_after_it`,
`update_mcp_selection_freezes_the_new_selection_like_create`,
`update_mcp_selection_rejects_unknown_and_deleted_servers_without_writing`,
`update_mcp_selection_needs_exactly_one_of_server_ids_or_inherit`,
`update_mcp_selection_restarts_an_idle_runtime_now`,
`update_mcp_selection_defers_the_restart_until_the_turn_ends`,
`update_mcp_selection_inherit_drops_the_selection_and_resolves_like_create`,
`update_mcp_selection_hands_a_team_member_to_the_team_runtime`,
`update_rejects_the_mcp_selection_marker_and_points_at_the_mcp_route`,
`create_strips_a_client_supplied_mcp_selection`,
`owned_selection_keeps_the_persisted_snapshot_and_fingerprints_its_ids`.
Extended: `session_event_serde_round_trip`,
`b_claude_init_captures_current_model_and_emits_mcp_provisioning`,
`mcp_startup_status_maps_to_provisioning_phases`, `mcp_oauth_login_failure_maps_to_degraded`.

### 3. Live check against the patched backend (PowerShell)

Run from an agent shell inside AionUi (a Claude Code chat); the helper variables are already set
there. The runtime token authenticates as the user, bound to the calling conversation.

```powershell
$base = $env:AIONUI_BASE_URL   # http://127.0.0.1:<port>; outside an agent shell: read it from the running AionUi
$h = @{
  'x-aionui-runtime-token'   = $env:AIONUI_RUNTIME_TOKEN
  'x-aionui-user-id'         = $env:AIONUI_USER_ID
  'x-aionui-conversation-id' = $env:AIONUI_CONVERSATION_ID
}
function Get-Conv($id) { (Invoke-RestMethod "$base/api/conversations/$id" -Headers $h).data }
function Set-Mcp($id, $json) {
  (Invoke-RestMethod -Method Put "$base/api/conversations/$id/mcp" -Headers $h `
     -ContentType 'application/json' -Body $json).data
}

# 1. The catalog, to pick ids
(Invoke-RestMethod "$base/api/mcp/servers" -Headers $h).data | Select-Object id, name, enabled, builtin

# 2. An idle solo chat whose agent is running (open it, let it finish, then run this elsewhere)
$cid = '<conversation id>'
$r = Set-Mcp $cid '{"server_ids":["<mcp id>"]}'
$r.runtime_action                        # restarted
$r.conversation.extra.mcp_servers        # the new names
$r.conversation.extra.mcp_selection      # source = conversation, server_ids = [...]
# send one message in that chat, then:
(Get-Conv $cid).runtime.mcp_servers      # name, status (connected / degraded / failed), error

# 3. The agent changes its own chat in the middle of its turn
$r = Set-Mcp $env:AIONUI_CONVERSATION_ID '{"server_ids":["<mcp id>"]}'
$r.runtime_action                        # deferred
$r.conversation.runtime.mcp_restart_pending   # True
# when this turn ends the backend log shows "Deferred MCP runtime restart finished";
# the next turn has the new tools and mcp_restart_pending is gone.

# 4. Back to what creation would pick
(Set-Mcp $cid '{"inherit":true}').conversation.extra.mcp_selection   # empty

# 5. Refusals
try { Set-Mcp $cid '{"server_ids":["mcp_nope"]}' } catch { $_.ErrorDetails.Message }   # 400 naming mcp_nope
try { Invoke-RestMethod -Method Patch "$base/api/conversations/$cid" -Headers $h `
        -ContentType 'application/json' -Body '{"extra":{"mcp_server_ids":[]}}' } `
catch { $_.ErrorDetails.Message }        # 400 ending "PUT /api/conversations/{id}/mcp"
```

Further checks:

6. Team member. In a team whose members come from a custom assistant, run
   `Set-Mcp '<member conversation id>' '{"server_ids":[...]}'`; expect `team`. An idle member shows
   pending then ready on the team page. After an app restart the member still has this selection.
   `{"inherit":true}` puts it back on the assistant's binding and restarts it again.
7. Soft delete. For a server some chat lists: `Invoke-RestMethod -Method Delete
   "$base/api/mcp/servers/<id>" -Headers $h`, then `Invoke-RestMethod -Method Post
   "$base/api/conversations/$cid/runtime/restart" -Headers $h`, then send a message. The server is
   gone from `(Get-Conv $cid).runtime.mcp_servers`, and it no longer starts with the agent.
8. Failure report. Add a stdio server whose command does not exist, select it on a chat and send a
   message: `runtime.mcp_servers` lists it as `failed`, and the backend log has
   `session-pump: MCP server status changed` (the same change goes out as
   `conversation.mcpStatusChanged`).
9. A Codex chat reports `pending` then `connected` while its servers start, before any turn.

## How to revert

Build aioncore from unpatched v0.2.2 sources (`git apply -R` this patch, or a clean checkout) and
ship that `aioncore.exe` in place of the patched one. There is no migration and no schema change.
Data written by the patched build stays readable by stock v0.2.2: the snapshot fields have
creation's shape, stock ignores `extra.mcp_selection`, and stock ignores the optional `server`
field on stored session events (`SessionEvent` does not deny unknown fields). After a revert, a
team member with its own selection returns to its assistant's binding at its next attach, and the
`/mcp` route no longer exists.

## Limits and risks

- Not compiled here. The spots most worth watching in the first build: the let-chain with
  `.await?` in `inherited_mcp_selection`; the reborrow in `SessionRuntime::record_mcp_server_status`;
  the `tokio::spawn` of the deferred waiter, which needs `ConversationService: Sync` and a `Send`
  `ensure_runtime_agent` future (both already required by the axum handlers); and, test-only, the
  nested `async fn` helper in the team test and the pump test's timing (it waits up to 2 seconds).
- Claude reports status only when a turn starts. Antigravity, ACP-manager agents and aionrs report
  none in v0.2.2, so their `runtime.mcp_servers` stays absent.
- A team member without an assistant picks up a change only at its next attach (`next_start`).
- The team path relies on `TeamSessionService::handle_assistant_mcp_binding_changed` re-resolving
  members through `resolve_conversation_mcp_snapshot` and ignoring the event's fingerprint, which
  holds in v0.2.2. Each per-chat change to a team member also rewrites an identical snapshot for the
  assistant's other active members (no restart for them).
- A deferred restart waits as long as the agent stays busy, background tasks included.
  `POST /api/conversations/{id}/runtime/restart` forces it, and that restart also loads the new
  selection.
- `inherit` on a chat without an assistant takes the servers enabled at that moment, as creation
  would.
- No UI yet. The open conversation's read-only MCP list refreshes on `conversation.listChanged`,
  but a per-chat picker and a live-status display belong in the AionDX renderer layer. The
  `aioncore config` CLI and the `aionui-config` skill do not know the route; agents call it with the
  runtime-token headers above, and the AionDX skill docs need a line saying so.

## Re-applying on a new release

Run `git apply --check`, then `git apply -3` if it fails. Conflicts are most likely in
`service.rs`, `service_test.rs` and `session_agent.rs`, which upstream edits often. Recheck two
assumptions each time: that `handle_assistant_mcp_binding_changed` still re-resolves members through
`resolve_conversation_mcp_snapshot`, and that `list_by_ids_any` still returns soft-deleted rows (if
upstream starts filtering there, the loader lines become redundant but stay harmless). If upstream
ships its own per-chat MCP route, retire this patch.
