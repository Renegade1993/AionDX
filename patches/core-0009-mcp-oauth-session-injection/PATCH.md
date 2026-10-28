# core-0009: attach the stored MCP OAuth token to real agent-session MCP servers

Patch: `0001-mcp-oauth-session-injection.patch` in this folder.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0`), the same sources as
`upstream-aioncore`. Applies on top of `core-0007` and `core-0008` (overlaps
`core-0008` in `crates/aionui-mcp/src/oauth_service.rs` and
`crates/aionui-mcp/src/routes.rs` — see "Relationship to core-0008" below — and
touches two files core-0001 also touches, `session_agent.rs` and
`factory/acp.rs`; see "Baseline note" below). Size: 10 files, ~245 lines
added, ~16 removed (mostly moving the merge body into the shared helper).
Written and build+test+clippy verified October 27th, 2026 (rustc/cargo
1.95.0, `CARGO_TARGET_DIR` pointed at a short path per the usual Windows
`MAX_PATH` workaround).

## The bug

`core-0008` fixed AionDX's MCP settings UI so that completing an OAuth login
correctly shows "authorized" instead of immediately flipping back to "login
required" — by making the `/api/mcp/test-connection` connection-test route
attach the stored OAuth token as a bearer header. But that only fixes the
*test*. A real chat session that actually tries to call a tool on an
OAuth-protected MCP server (e.g. Higgsfield) never attaches the token either,
so the server still returns 401 and the tool call fails — even though the UI
now reports the server as "authorized" right before the user tries to use it.

## Root cause

`aionui-ai-agent::mcp_resolve::resolve_session_mcp_servers`
(`crates/aionui-ai-agent/src/mcp_resolve.rs`, before this patch) is the single
function that turns a conversation's configured MCP server rows into the
`SessionMcpServer`s actually injected into a live agent session (claude/codex
via `build_session_instance`, agy via `build_antigravity_instance`, both in
`crates/aionui-ai-agent/src/session_agent.rs`). Before this patch it only read
each row's static, stored `transport_config.headers` via its `parse_headers`
helper — confirmed by its prior signature taking no OAuth-related parameter
and no code path consulting `McpOAuthService` anywhere in the crate (a
repo-wide search for `McpOAuthService`/`oauth_service` inside
`aionui-ai-agent` turned up nothing before this patch, matching what
`core-0008`'s own PATCH.md already flagged as a known follow-up).

So after a successful Higgsfield OAuth login, `McpOAuthService::get_token`
has a real, valid token persisted — `core-0008` proved that by reading it back
for the connection test — but the one code path that builds a *real* session's
MCP transports never looks it up. Every actual tool call against that server
in a live chat still goes out with only the server's static headers, gets
401'd, and the UI's "authorized" badge (now correct, per `core-0008`) is lying
about whether the feature actually works end to end.

## The fix

**Shared the merge logic with `core-0008` instead of duplicating it.** Pulled
the "merge a stored bearer token into a headers map" rule out of `core-0008`'s
`routes.rs::merge_oauth_header` into a new method on the service itself,
`McpOAuthService::merge_bearer_token` (`crates/aionui-mcp/src/oauth_service.rs:222`):

- skip if `headers` already has an `Authorization` key (case-insensitive —
  explicit server config always wins);
- otherwise look up `get_token(user_id, url)`; `Ok(Some(token))` inserts
  `Authorization: Bearer <token>`; `Ok(None)` is a no-op; `Err` is logged at
  `warn` and treated as a no-op (a transient DB issue degrades to
  "unauthenticated" rather than failing the caller).

`core-0008`'s `routes.rs::merge_oauth_header` (`crates/aionui-mcp/src/routes.rs:276`)
now delegates to this one-line body instead of implementing the rule itself —
no behavior change there, just de-duplication so the rule lives in exactly one
place. The new call site, `mcp_resolve.rs`'s `apply_oauth_token`
(`crates/aionui-ai-agent/src/mcp_resolve.rs:193`), does the same thing for
`SessionMcpTransport`'s `Http`/`Sse`/`StreamableHttp` variants (one more
variant than `routes.rs`'s `McpServerTransport`, which has no
`StreamableHttp`) and leaves `Stdio` untouched, same rule as `core-0008`.

**Threaded a `McpOAuthService` reference through to the resolver via DI**, since
`resolve_session_mcp_servers` had no access to one before:

- `crates/aionui-ai-agent/src/mcp_resolve.rs`: new 6th parameter
  `oauth_service: Option<&McpOAuthService>` on `resolve_session_mcp_servers`;
  applies `apply_oauth_token` per resolved server when `Some`.
- `crates/aionui-ai-agent/src/session_agent.rs`: `SessionBuildInputs<'a>` gets
  a new field `pub oauth_service: Option<&'a Arc<McpOAuthService>>`; both of
  its two consumers, `build_session_instance` and `build_antigravity_instance`,
  destructure it and pass `oauth_service.map(|o| o.as_ref())` into
  `resolve_session_mcp_servers`.
- `crates/aionui-ai-agent/src/factory/mod.rs`: `AgentFactoryDeps` gets a new
  field `pub oauth_service: Option<Arc<McpOAuthService>>`.
- `crates/aionui-ai-agent/src/factory/acp.rs` and
  `crates/aionui-ai-agent/src/factory/antigravity.rs`: both pass
  `deps.oauth_service.as_ref()` into `SessionBuildInputs`.
- `crates/aionui-app/src/services.rs`: constructs a `McpOAuthService` (its own
  `oauth_token_repo` + a fresh `reqwest::Client`) and sets it on
  `AgentFactoryDeps::oauth_service`. See "Two independent `McpOAuthService`
  instances" below for why this isn't wired to `router/state.rs`'s existing
  instance.

**Trigger-point check (verified, not assumed):** grepped every call site of
`resolve_session_mcp_servers` — there are exactly two, both inside
`session_agent.rs`'s `build_session_instance` and `build_antigravity_instance`,
which only run at session-build time (a fresh session, or a restart triggered
by changing the conversation's MCP selection). Nothing in the OAuth login flow
(`McpOAuthService::login`/`finish_login`, the `/api/mcp/*` routes) triggers a
session rebuild. So this fix is correctly scoped to "the token in effect when
a session is (re)built", not "live, mid-session" — a user who logs in for the
first time in the middle of an existing chat still needs that session to
restart (e.g. toggling the MCP server selection, or starting a new
conversation) before the new token takes effect. This is the existing session
lifecycle, unchanged by this patch; flagged below under "Limits and risks"
rather than worked around, since building a live mid-session MCP-transport
hot-reload is a materially larger change outside this bug's scope.

### Two independent `McpOAuthService` instances

`router/state.rs`'s `McpRouterState` already constructs its own
`McpOAuthService` (used by `core-0007`/`core-0008`'s login + test-connection
routes, which also track in-flight `pending` logins). `services.rs` builds a
**second**, independent `McpOAuthService` for `AgentFactoryDeps` rather than
threading the router's instance through. This was the minimal-diff choice:
`AgentFactoryDeps` is constructed in a different part of `services.rs` with no
existing path to the router's state, and `McpOAuthService`'s only
session-affecting state (`pending` logins, held only during the OAuth
redirect dance) is never touched by the resolver — it only ever calls
`get_token`/`merge_bearer_token`, which read straight through to
`token_repo`, so both instances see the same persisted tokens. Functionally
there is no gap from having two instances; a reviewer who prefers a single
shared instance for conceptual cleanliness could refactor this later, but it
isn't required for correctness.

## Files and functions touched

| File | Change |
|---|---|
| `crates/aionui-mcp/src/oauth_service.rs` | New `pub async fn merge_bearer_token`. No new direct unit tests on the method itself — it's exercised through both existing call sites' own test suites (`routes.rs`'s `oauth_token_merge_tests`, now running through this method, and the 5 new `mcp_resolve` tests below). |
| `crates/aionui-mcp/src/routes.rs` | `merge_oauth_header` now delegates to `merge_bearer_token` (de-duplication, no behavior change; its existing 5 `oauth_token_merge_tests` still pass unchanged). |
| `crates/aionui-ai-agent/src/mcp_resolve.rs` | New `oauth_service` parameter on `resolve_session_mcp_servers`; new `apply_oauth_token` helper; 5 new unit tests. |
| `crates/aionui-ai-agent/src/session_agent.rs` | `SessionBuildInputs` gets `oauth_service` field; both build functions thread it into `resolve_session_mcp_servers`. |
| `crates/aionui-ai-agent/src/factory/mod.rs` | `AgentFactoryDeps` gets `oauth_service` field. |
| `crates/aionui-ai-agent/src/factory/acp.rs` | Passes `deps.oauth_service.as_ref()` into `SessionBuildInputs`. |
| `crates/aionui-ai-agent/src/factory/antigravity.rs` | Same, for the agy path. |
| `crates/aionui-app/src/services.rs` | Constructs the `McpOAuthService` instance for `AgentFactoryDeps`. |
| `crates/aionui-ai-agent/Cargo.toml` | `reqwest` added to `[dev-dependencies]` (needed by the new `services.rs`-style test fixture in `factory_provider_integration.rs`). |
| `crates/aionui-ai-agent/tests/factory_provider_integration.rs` | `oauth_service: None` added to an existing `AgentFactoryDeps` test fixture literal (new required field). |

Not touched: any frontend file, `aionui-db`, any other crate.

## Baseline note: `core-0001`'s stored `.patch` file is stale for two of this patch's files

While reconstructing a clean "before this patch" baseline for
`session_agent.rs` and `factory/acp.rs` (needed to generate a minimal diff),
`core-0001-mcp-per-chat/0001-mcp-per-chat.patch` — the only earlier patch that
also touches these two files — was checked first as the natural source for
that baseline. It does **not** match the current working tree: it documents a
"live MCP server status" feature in `session_agent.rs` (`mcp_servers` mutex,
`record_mcp_server_status`, `broadcast_mcp_status_frame`, etc.) and a
"soft-deleted MCP row" feature + test in `factory/acp.rs`, neither of which
exists in either the pristine v0.2.2 source or the actual current working
tree (confirmed via grep returning zero matches for both feature's symbol
names in both). This is a pre-existing discrepancy unrelated to this patch —
not something broken by this patch or something this patch is responsible for
fixing — but it means `core-0001`'s patch file on disk cannot currently be
re-applied as-is or trusted as a reconstruction baseline; it's stale relative
to what's actually in the tree. Flagged here since it was discovered as a
side effect of this patch's own baseline work, not independently
investigated or fixed.

## How to verify

### 1. Apply

From the root of a v0.2.2 checkout, after `core-0007` and `core-0008`:

```
git apply --check patches/core-0009-mcp-oauth-session-injection/0001-mcp-oauth-session-injection.patch
git apply patches/core-0009-mcp-oauth-session-injection/0001-mcp-oauth-session-injection.patch
```

Verified October 27th, 2026 by applying this exact patch with `patch -p1`
against reconstructed pre-patch copies of all 10 files and confirming the
result is content-identical (whitespace/line-ending differences aside — GNU
`patch` normalizes CRLF to LF the same way `core-0008`'s own stored patch file
shows; the repo's working tree is CRLF, `git diff`'s hunks are LF, same as
every other patch in this series) to the real edited working tree for every
file.

### 2. Build and tests

```
$env:CARGO_TARGET_DIR = "C:\rbuild\core0009-final"   # short-path MAX_PATH workaround
cargo build -p aionui-ai-agent -p aionui-mcp -p aionui-app
```
Builds cleanly, zero warnings or errors, through the full dependency chain
(verified in 2m20s).

```
cargo clippy -p aionui-mcp -p aionui-ai-agent -p aionui-app -- -D warnings
```
Exits 0 — zero lint warnings across all three touched crates.

```
cargo test -p aionui-mcp -p aionui-ai-agent
```
`cargo test -p aionui-mcp --lib`: 298 passed, 0 failed.
`cargo test -p aionui-ai-agent --lib`: 977 passed, 1 failed (pre-existing,
unrelated — see below). The 5 new `mcp_resolve` tests
(`crates/aionui-ai-agent/src/mcp_resolve.rs`, confirmed individually via
`cargo test -p aionui-ai-agent --lib mcp_resolve`), confirmed by name:
`resolve_applies_stored_oauth_token_to_http_transport`,
`resolve_applies_stored_oauth_token_to_sse_transport`,
`resolve_no_stored_token_leaves_headers_untouched`,
`resolve_existing_authorization_header_is_not_overwritten`,
`resolve_stdio_transport_is_unaffected_by_oauth` — all `ok`. The last one
originally used a non-existent `/bin/true` stdio command (copied from a
Unix-biased assumption) which fails command resolution on Windows CI and
silently drops the row before OAuth logic ever runs; fixed by switching to
`std::env::current_exe()`, the same fixture pattern
`factory/acp.rs::stdio_config_for_existing_command` already uses for exactly
this reason.

One pre-existing, unrelated failure: `terminal::tests::default_cwd_applies_when_agent_sends_none`
(a Windows-path-format assertion mismatch) — fails independently of this
patch and is not touched by any file this patch changes.

### 3. Live check

With a build of this patch running: complete the Higgsfield OAuth login,
then actually invoke a tool on that server from within a chat (not just
"Test connection"). Expect the tool call to succeed instead of 401ing. If the
login happens mid-conversation, the fix only takes effect on that
conversation's next rebuild (new conversation, or an MCP-selection change
that triggers a session restart) — see "Limits and risks".

## Limits and risks

- Compiled, linted, and unit-tested clean (see "How to verify" §2). Not yet
  verified: a live OAuth login + real tool call against the actual
  Higgsfield server through a running AionDX build (§3 describes that check;
  it needs a full AionDX build, not just the crates in isolation).
- **Does not make a running session pick up a token from a login that happens
  after that session was built.** Verified (not assumed) that
  `resolve_session_mcp_servers`'s only two call sites are both inside
  session-build functions, never invoked by the OAuth login routes. A token
  obtained mid-conversation requires that conversation to rebuild its session
  (new conversation, or an MCP-selection-triggered restart) before it's
  attached to outbound requests. Making this live (e.g. a WS-driven
  hot-reload of in-flight MCP transports) is a materially larger change and
  was deliberately left out of this patch's scope.
- **Two independent `McpOAuthService` instances now exist at runtime** (the
  router's and `AgentFactoryDeps`'s) — see "Two independent `McpOAuthService`
  instances" above for why this is safe (both read the same persisted token
  store, and the resolver never touches the `pending`-login state that's the
  only thing NOT shared). A project owner could consolidate this into one
  shared instance for conceptual cleanliness; not required for correctness.
- **The frontend's `needsLogin`/`isAuthenticated` mutual-exclusivity issue
  flagged in `core-0008`'s own "Limits and risks" is still open and out of
  scope here.** This patch is backend-only and doesn't touch
  `useMcpOAuth.ts`; `markLoginRequired` still sets `needsLogin: true` without
  clearing `isAuthenticated`. `core-0008` already fixed the *reliable*
  trigger for that conflict (the connection-test auto-retest right after
  login). This patch removes the *other* reliable trigger a user would hit —
  a real tool call failing mid-chat and (depending on how that failure is
  surfaced to the oauth status hooks) potentially calling
  `markLoginRequired` again. Whether that path exists depends on whether a
  live tool-call 401 ever calls back into `useMcpOAuth`'s state — not
  investigated this patch, since it's a frontend asar-patch
  (`patches/000N-*/` under the frontend's own separate packaging/build
  tooling) and backend-only was the brief. Recommend a follow-up check of
  whether a mid-chat MCP 401 reaches `markLoginRequired`; if it does, the
  same frontend tightening `core-0008` already recommended (clear
  `isAuthenticated` whenever `needsLogin` is set) would close it for this
  path too.
- Baseline note on `core-0001`'s stale patch file for `session_agent.rs`/
  `factory/acp.rs` — see dedicated section above. Not fixed here, flagged for
  awareness.
- Logging: no new logging beyond the `warn!` already added by `core-0008`'s
  `merge_bearer_token` (now the single shared call site for both routes).
  No other logging changes.

## Re-applying on a new release

If `resolve_session_mcp_servers`'s signature, `SessionBuildInputs`, or
`AgentFactoryDeps` change shape in a future AionCore release, regenerate this
patch against the new sources rather than force-applying; the core change
(thread an optional `McpOAuthService` reference through to the point a
session's MCP transports are resolved, and merge a bearer token into
Http/Sse/StreamableHttp headers) should still make sense, but field names and
call sites may need to move.
