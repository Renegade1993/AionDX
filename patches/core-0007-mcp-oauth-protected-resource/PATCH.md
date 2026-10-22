# core-0007: RFC 9728 protected-resource discovery for MCP OAuth login

Patch: `0001-mcp-oauth-protected-resource.patch` in this folder.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`), the same sources as `upstream-aioncore`.
Size: 1 file, 2 hunks, ~50 lines added, 4 removed. Written October 21st, 2026, build+test
verified October 22nd, 2026 (rustc/cargo 1.99.1 stable, installed via `winget install
Rustlang.Rustup`).

## The bug

Adding Higgsfield's MCP server (`https://mcp.higgsfield.ai/mcp`) fails with a 500
`INTERNAL_ERROR` from `POST /api/mcp/oauth/login` during the OAuth login flow.

## Root cause

`McpOAuthService::discover_endpoints` (`crates/aionui-mcp/src/oauth_service.rs`) only ever
tried two URLs, both built by appending a well-known suffix directly onto the MCP server's
own URL:

- `{server_url}/.well-known/oauth-authorization-server`
- `{server_url}/.well-known/openid-configuration`

That assumes the authorization server is colocated with the resource (the same host that
serves the MCP endpoint). Higgsfield is not colocated: the resource is `mcp.higgsfield.ai`,
but its authorization server is `clerk.higgsfield.ai` — a different host entirely. Neither
guess resolves against `mcp.higgsfield.ai`:

```
GET https://mcp.higgsfield.ai/mcp/.well-known/oauth-authorization-server  -> 404
GET https://mcp.higgsfield.ai/mcp/.well-known/openid-configuration        -> 404
```

(Confirmed by direct request during this investigation.) `discover_endpoints` returns
`Err(McpError::OAuth("Failed to discover OAuth endpoints for '...'..."))`, which
propagates through `McpOAuthService::login` → `prepare_login_flow` to the route handler.
`routes.rs`'s `impl From<McpError> for ApiError` maps `McpError::OAuth(_)` to
`ApiError::Internal(_)`, which the HTTP layer renders as a 500 — exactly the symptom
reported. This is deterministic for any MCP server that puts its authorization server on a
separate host, which is the pattern RFC 9728 protected-resource metadata exists for, and
which identity providers like Clerk, WorkOS and Auth0 commonly produce.

What this patch is **not**: a `deny_unknown_fields` problem. v0.2.2 never fetches or parses
RFC 9728 protected-resource metadata at all — the nonstandard `higgsfield_auth_hints` field
in Higgsfield's resource-metadata document is never reached by any code path in this
version, so it cannot be the direct cause of the 500. (Confirmed by reading
`discover_endpoints`: it has no protected-resource fetch, and `OAuthServerMetadata` is a
plain `#[derive(Deserialize)]` struct with no `deny_unknown_fields`, which already ignores
unknown fields by default.) That said, tolerating nonstandard fields is still worth doing
defensively once protected-resource parsing is added — see below — since the whole point of
this metadata format is that resource servers are free to extend it.

Verified against the live servers while writing this patch:

```
GET https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp
  -> {"resource":"https://mcp.higgsfield.ai/mcp",
      "authorization_servers":["https://clerk.higgsfield.ai"], ...,
      "higgsfield_auth_hints": {...potential_clients...}}   # nonstandard, ignored
GET https://clerk.higgsfield.ai/.well-known/oauth-authorization-server
  -> {"issuer":"https://clerk.higgsfield.ai",
      "authorization_endpoint":"https://clerk.higgsfield.ai/oauth/authorize",
      "token_endpoint":"https://clerk.higgsfield.ai/oauth/token", ...}
```

## The fix

`discover_endpoints` now tries RFC 9728 first:

1. Build the protected-resource-metadata URL per RFC 9728 §3.1: insert
   `/.well-known/oauth-protected-resource` **between the authority and the resource's own
   path**, not after it — `https://mcp.higgsfield.ai/mcp` becomes
   `https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp`. New function
   `protected_resource_metadata_url`.
2. Fetch and parse it into a new `ProtectedResourceMetadata { authorization_servers: Vec<String> }`
   (`#[serde(default)]`, no `deny_unknown_fields`, so `higgsfield_auth_hints` and any other
   extra field a resource server adds is silently ignored rather than rejected).
3. Take its first `authorization_servers` entry and run the existing RFC 8414 /
   OpenID-Connect discovery (`oauth-authorization-server`, then `openid-configuration`)
   against *that* host instead of the resource's own URL.
4. If step 1–3 find nothing (no protected-resource document, or it names no authorization
   server), fall back to the original behavior unchanged: try both well-known paths directly
   on the resource's own URL. This keeps existing servers that colocate their authorization
   server with the resource working exactly as before.

`fetch_metadata` is now a thin wrapper over a new generic `fetch_json<T: DeserializeOwned>`,
shared by both the authorization-server-metadata and protected-resource-metadata fetches.

Dynamic client registration is unchanged — v0.2.2 doesn't do DCR for MCP OAuth login (it
uses the hardcoded public client id `"aionui"`), and that's out of scope for this patch.
Higgsfield's DCR endpoint being healthy was already confirmed before this investigation
started; it isn't part of the path this patch touches.

## Files and functions touched

| File | Change |
|---|---|
| `crates/aionui-mcp/src/oauth_service.rs` | New struct `ProtectedResourceMetadata`. New free function `protected_resource_metadata_url`. `discover_endpoints` tries RFC 9728 discovery first, falls back to the original two well-known lookups unchanged. `fetch_metadata` now delegates to new generic `fetch_json`. 5 new tests. |

Not touched: `aionui-api-types`, routes, DB, DCR, any other crate. The `McpError::OAuth` → `ApiError::Internal` → 500 mapping in `routes.rs` is unchanged; once discovery succeeds, the existing login flow runs as before.

## How to verify

### 1. Apply

From the root of a v0.2.2 checkout:

```
git apply --check patches/core-0007-mcp-oauth-protected-resource/0001-mcp-oauth-protected-resource.patch
git apply patches/core-0007-mcp-oauth-protected-resource/0001-mcp-oauth-protected-resource.patch
```

How it was checked on October 21st, 2026, **without running cargo** (no Rust toolchain was
available in that sandbox): LF scratch repo holding only the pristine v0.2.2 blob of
`oauth_service.rs` (taken via `git show v0.2.2:crates/aionui-mcp/src/oauth_service.rs`):
`git apply --check` passed, `git apply` produced a file byte-identical to the edited tree,
and `git apply -R --check` passed. The preimage `index` blob id (`dddce6e`) equals
`git rev-parse v0.2.2:crates/aionui-mcp/src/oauth_service.rs`.

Superseded October 22nd, 2026 by an actual build and test run (see §2) — this `git apply`
check and blob-id match still stand as the apply-mechanics verification, but the "not
compiled" caveat is gone.

### 2. Build and tests

Toolchain: `rustc 1.99.1 (58cf8f9c3 2026-10-13)` / `cargo 1.99.1 (5f94df478 2026-08-27)`,
stable channel, installed via `winget install --id Rustlang.Rustup -e`.

Checkout: fresh clone of the local `upstream-aioncore` mirror (itself `iOfficeAI/AionCore`
at tag `v0.2.2`) into a scratch working copy, patch applied with `git apply`, confirmed
clean (`git apply --check` OK, applied, `grep` for the new symbols present in the tree).

One environment-specific wrinkle, unrelated to this patch: the session's working directory
is nested deep enough (`.../2026/10/21/claude-temp-.../aiondx-repo/...`) that MSVC's
`link.exe` hit `LNK1104: cannot open file ...` on the default `target/` path — a Windows
`MAX_PATH` (260 char) problem with the *build output path*, not the source tree or the
patch. Worked around by pointing `CARGO_TARGET_DIR` at a short path (`C:\rbuild\core0007`):

```
$env:CARGO_TARGET_DIR = "C:\rbuild\core0007"
cargo build -p aionui-mcp
```
```
   Compiling aionui-mcp v0.2.2 (...\core-0007-verify-build\crates\aionui-mcp)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 54.58s
```
Builds cleanly, zero warnings or errors, through the full dependency chain
(`aionui-common` → `aionui-api-types` → `aionui-runtime` → `aionui-realtime` →
`aionui-auth` → `aionui-system` → `aionui-mcp`).

```
cargo test -p aionui-mcp
```
```
test result: ok. 293 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
... (9 integration test binaries, all "ok", 0 failed) ...
Doc-tests aionui_mcp: test result: ok. 0 passed; 0 failed
```
371 tests total across the lib target and all 9 integration-test binaries in this crate,
all passing, 0 failed. The 5 new tests (all in `oauth_service.rs`'s existing
`#[cfg(test)] mod tests`) ran and passed:
`protected_resource_metadata_url_inserts_well_known_before_path`,
`protected_resource_metadata_url_handles_root_resource`,
`protected_resource_metadata_url_rejects_unparseable_input`,
`protected_resource_metadata_ignores_nonstandard_vendor_fields` (uses Higgsfield's actual
captured response body, including `higgsfield_auth_hints`, as the test fixture),
`protected_resource_metadata_defaults_authorization_servers_when_absent`.

No implementation changes were needed — the patch compiled and passed on the first real
build/test run.

### 3. Live check against the patched backend

With a build of this patch running, add Higgsfield's MCP server
(`https://mcp.higgsfield.ai/mcp`) through AionDX's MCP settings and start the OAuth login.
Expect the browser to open Clerk's authorization page instead of the backend returning a
500. `POST /api/mcp/oauth/login` with `{"server_url":"https://mcp.higgsfield.ai/mcp"}` should
return `{"success":true}` (or a user-facing OAuth error, e.g. if the browser flow itself is
cancelled) rather than an `ApiError::Internal` 500.

Regression check: repeat login against an MCP server whose authorization server **is**
colocated with the resource (any existing working OAuth MCP server) and confirm it still
succeeds — this exercises the step-4 fallback path.

## Limits and risks

- Compiled and tested clean (see "How to verify" §2) — `cargo build -p aionui-mcp` and
  `cargo test -p aionui-mcp` both pass with zero warnings, zero failures. Not yet verified:
  a live OAuth login against the real Higgsfield/Clerk servers through a running AionDX
  build (§3 below describes that check; it still needs a human or an agent with a full
  AionDX build, not just the crate in isolation).
- Only the first `authorization_servers` entry is used. RFC 9728 allows more than one; if a
  server lists several and the first is unreachable, this patch does not try the rest. Not a
  problem for Higgsfield (one entry), worth revisiting if a server with multiple entries
  surfaces.
- Still no dynamic client registration — this patch only fixes *discovery*. If an
  authorization server requires a registered client and rejects the hardcoded `"aionui"`
  client id, login will fail at the token-exchange step instead of at discovery. Not
  observed for Higgsfield/Clerk in this investigation, but out of scope here.

## Re-applying on a new release

Run `git apply --check`, then `git apply -3` if it fails. If upstream adds its own RFC 9728
support, retire this patch.
