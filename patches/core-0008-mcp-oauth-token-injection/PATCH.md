# core-0008: attach the stored MCP OAuth token to outbound connection tests

Patch: `0001-mcp-oauth-token-injection.patch` in this folder.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`), the same sources as
`upstream-aioncore`. Applies on top of `core-0007` (different file, no overlap).
Size: 1 file, 2 hunks, ~196 lines added (mostly new tests), 0 removed. Written and
build+test verified October 27th, 2026 (rustc/cargo stable, `CARGO_TARGET_DIR` pointed at a
short path per the usual Windows `MAX_PATH` workaround).

## The bug

After `core-0007` fixed OAuth discovery, completing the Higgsfield OAuth login in AionDX's
MCP settings shows **both** "Authorization successful" and "Authorization required" for the
same server at the same time, right after each other. The success toast is real — login did
succeed — but the server immediately flips to "needs login" and stays that way; it never
self-heals on later manual "Test connection" clicks either.

## Root cause

This is a backend functional gap, not a stale-badge or frontend-only bug, though a frontend
behavior is what surfaces it to the user as a visible conflict.

**Backend: the stored OAuth token is never attached to any outbound MCP request.**
`McpOAuthService::get_token(user_id, server_url)` (`crates/aionui-mcp/src/oauth_service.rs:183`)
is the only function in the codebase that can retrieve a persisted access token (with
automatic refresh-on-expiry). It has **zero production call sites**. Confirmed by a
repo-wide search for `get_token`/`oauth_service`/`McpOAuthService`: the only callers are its
own unit tests and `tests/oauth_integration.rs`.

- `McpConnectionTestService::test_http`/`test_http_inner`
  (`crates/aionui-mcp/src/connection_test/mod.rs:159-274`) only builds request headers from
  the server's static, stored `transport.headers` — no OAuth lookup.
- The `/api/mcp/test-connection` route handler (`crates/aionui-mcp/src/routes.rs`, before this
  patch) passes that same static transport straight to the connection-test service.
- `aionui-ai-agent::mcp_resolve::resolve_session_mcp_servers` (which builds the MCP transports
  injected into a *real* agent session) also only reads the static JSON `headers` column via
  its `parse_headers` helper — no OAuth involvement either.

So `McpOAuthService::login()` (`oauth_service.rs:118-153`) persists a token via
`persist_token` → `token_repo.upsert(...)` that **nothing ever reads back**. Every request to
that server — test or real session — stays unauthenticated, the server keeps returning
401 + `WWW-Authenticate`, and `auth_result()` (`connection_test/protocol.rs:505-524`) keeps
setting `needs_auth: Some(true)`.

**Frontend: this is what turns the backend gap into a visible, conflicting pair of
messages.** All paths are in
`/c/rbuild/aionui-frontend/packages/desktop/src/renderer/`:

- `pages/settings/ToolsSettings/McpManagement.tsx`'s `handleOAuthLogin` (lines 59-71) shows a
  "Login successful" toast as soon as `login(server)` returns `{success:true}`, then fires
  `handleTestMcpConnection(server)` to re-verify.
- `hooks/mcp/useMcpConnection.ts`'s `handleTestMcpConnection` (lines 143-258) hits the real
  `/api/mcp/test-connection` endpoint. Because of the backend gap, it still gets
  `needs_auth: true`, shows an "Authentication required" warning toast (line 172), and calls
  `onAuthRequired(server)` (line 181).
- `hooks/mcp/useMcpOAuth.ts`: `login()`'s success branch (lines 92-101) sets
  `oauthStatus[id] = {isAuthenticated:true, needsLogin:false, ...}`. `markLoginRequired`
  (lines 170-179, wired as `onAuthRequired`) then sets `needsLogin:true` **without clearing
  `isAuthenticated`**, producing `{isAuthenticated:true, needsLogin:true}` at once.
- `pages/settings/ToolsSettings/McpServerHeader.tsx`'s `getStatusIcon`/`getStatusText`
  (lines 24-50, 107-142) check `needsLogin` **before** `isAuthenticated`, so the
  "Login required" badge is what renders and persists — right alongside the "Login
  successful" toast that already fired.

Verified this disproves the original hypothesis that this was `core-0001`'s live
per-conversation MCP status badge going stale: that mechanism
(`SessionRuntime.mcp_servers`, `broadcast_mcp_status_frame`) has no renderer consumer at all,
per its own PATCH.md "Limits and risks" section — it cannot be the thing rendering either of
these two messages.

## The fix

Backend-only, at the single point both pieces it needs are already available:
`/api/mcp/test-connection`'s `test_connection` handler in `crates/aionui-mcp/src/routes.rs`.
`McpRouterState` already holds both `oauth_service: McpOAuthService` and
`connection_test_service: McpConnectionTestService` — no new wiring.

New function `apply_stored_oauth_token`: for `Http`/`Sse` transports, looks up a stored token
via `oauth_service.get_token(user_id, url)` and merges it into the transport's headers as
`Authorization: Bearer <token>` before the connection test runs — unless the server's own
config already sets an `Authorization` header (case-insensitive check), in which case the
existing header wins unchanged. `Stdio` transports pass through untouched (OAuth tokens are
meaningless for a local process). A missing token (`Ok(None)`) is a no-op; a DB lookup error
is logged at `warn` and otherwise treated as no-op, so a transient DB issue degrades to "test
without the token" rather than failing the whole request.

This makes the connection test — and therefore the `needs_auth` verdict the frontend reads —
reflect the server's real, current auth state. Once the stored token is attached, the
auto-retest that `handleOAuthLogin` runs right after a successful login succeeds against a
real OAuth-protected server, so the frontend's existing `onAuthResolved` → `clearLoginRequired`
path fires instead of `onAuthRequired` → `markLoginRequired`, and the conflicting state is
never produced.

## Files and functions touched

| File | Change |
|---|---|
| `crates/aionui-mcp/src/routes.rs` | `test_connection` now calls new `apply_stored_oauth_token`/`merge_oauth_header` on the transport before running the connection test. 5 new tests in new `#[cfg(test)] mod oauth_token_merge_tests`. |

Not touched: `aionui-ai-agent::mcp_resolve` (real agent-session MCP injection), any frontend
file, `aionui-db`, any other crate. See "Limits and risks" below for why.

## How to verify

### 1. Apply

From the root of a v0.2.2 checkout:

```
git apply --check patches/core-0008-mcp-oauth-token-injection/0001-mcp-oauth-token-injection.patch
git apply patches/core-0008-mcp-oauth-token-injection/0001-mcp-oauth-token-injection.patch
```

Checked October 27th, 2026 in a scratch repo holding only the pristine v0.2.2 blob of
`routes.rs` (taken via `git show v0.2.2:crates/aionui-mcp/src/routes.rs`, blob id
`671818a`, confirmed equal to `git rev-parse v0.2.2:crates/aionui-mcp/src/routes.rs`):
`git apply --check` passed, `git apply` produced a file byte-identical to the edited tree
(`diff -q` empty), and `git apply -R --check` passed.

### 2. Build and tests

Toolchain: stable `rustc`/`cargo`, same as used for `core-0007`.

```
$env:CARGO_TARGET_DIR = "C:\rbuild\core-mcp-oauth-fix"   # short-path MAX_PATH workaround
cargo build -p aionui-mcp
```
```
   Compiling aionui-mcp v0.2.2 (...\crates\aionui-mcp)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 28s
```
Builds cleanly, zero warnings or errors, through the full dependency chain.

```
cargo clippy -p aionui-mcp -- -D warnings
```
Exits 0 — zero lint warnings.

```
cargo test -p aionui-mcp
```
```
test result: ok. 298 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (lib)
... 9 integration test binaries, all "ok", 0 failed, 78 tests total ...
Doc-tests aionui_mcp: test result: ok. 0 passed; 0 failed
```
376 tests total across the lib target and all integration-test binaries in this crate, all
passing, 0 failed. The 5 new tests, confirmed individually by name
(`cargo test -p aionui-mcp --lib oauth_token_merge_tests`):
`http_transport_gets_stored_token_as_bearer_header`,
`sse_transport_gets_stored_token_as_bearer_header`,
`no_stored_token_leaves_headers_untouched`,
`existing_authorization_header_is_not_overwritten`,
`stdio_transport_is_passed_through_unchanged` — all `ok`.

No implementation changes were needed after the first real build/test run.

### 3. Live check against the patched backend

With a build of this patch running: complete the Higgsfield OAuth login through AionDX's MCP
settings. Expect only "Login successful" to end up showing — the immediate auto-retest
should now pass instead of flipping the server to "Login required". Manually clicking "Test
connection" afterward should also keep reporting success, since the stored token is now sent
on every test. Regression check: a server with no OAuth configured, or one with its own
manually-configured `Authorization` header, should behave exactly as before (no header
injected in the first case, existing header left alone in the second) — exercised directly by
`no_stored_token_leaves_headers_untouched` and `existing_authorization_header_is_not_overwritten`.

## Limits and risks

- Compiled and tested clean (see "How to verify" §2). Not yet verified: a live OAuth login
  against the real Higgsfield/Clerk servers through a running AionDX build (§3 above
  describes that check; it needs a full AionDX build, not just the crate in isolation).
- **Does not fix real agent-session MCP tool calls.** `aionui-ai-agent::mcp_resolve`'s
  `resolve_session_mcp_servers` builds the transports injected into a live conversation and
  also never consults stored OAuth tokens — only this patch's narrow slice
  (`/api/mcp/test-connection`) was touched. After this patch, "Test connection" and the login
  flow's own retest will correctly report success, but an actual tool call in a chat session
  against an OAuth-protected MCP server would still go out unauthenticated and fail. Fixing
  that is a larger, cross-crate change (`aionui-ai-agent` would need to depend on
  `McpOAuthService` or something exposing equivalent lookups) that was deliberately left out
  of this patch, which targets the specific reported UI-conflict symptom. Flagged here as a
  follow-up, not fixed.
- **Frontend state shape is still structurally capable of the same conflict.**
  `useMcpOAuth.ts`'s `markLoginRequired` sets `needsLogin:true` without clearing
  `isAuthenticated`, so `{isAuthenticated:true, needsLogin:true}` remains a reachable state
  in principle (e.g. if a token that was valid during login expires between then and a later
  manual test, with no refresh token to renew it). This patch removes the *reliable* trigger
  (the immediate post-login retest always failing), but doesn't make the two flags mutually
  exclusive by construction. A frontend-only tightening of `markLoginRequired` to also clear
  `isAuthenticated` would close this defensively; not done here because it would need to ship
  as a new frontend asar-patch (`patches/000N-*/`, built via `tools/build-release.ps1
  -StageOnly` and verified with `tools/privacy-check.js`/`tools/audit-literals.js`) which is
  separate, unfamiliar packaging tooling from this backend git-diff patch series, and the
  backend fix alone stops the reported symptom from reproducing. Flagged as a follow-up.
- Logging: added one `warn!` on a DB lookup failure during token merge (expected per
  `AGENTS.md`'s logging guidance — a safely-handled unexpected condition). No other logging
  changes; existing coverage of the connection-test path is unaffected.

## Re-applying on a new release

If `crates/aionui-mcp/src/routes.rs`'s `test_connection` handler or `McpServerTransport`'s
variants change shape in a future AionCore release, regenerate this patch against the new
`routes.rs` rather than force-applying; the core change (look up and merge a bearer token
before testing) should still make sense, but the match arms and State field names may need to
move.
