# core-0008: dynamic client registration for MCP OAuth login

Patch: `0001-mcp-oauth-client-registration.patch` in this folder. Applies after core-0007 (it edits the same file, `crates/aionui-mcp/src/oauth_service.rs`, and its preimage is core-0007's result).
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written October 22nd, 2026.

## The bug

core-0007 (PotatoNateO) made AionCore find a sign-in service on another host. For Higgsfield (`https://mcp.higgsfield.ai/mcp`, sign-in service `https://clerk.higgsfield.ai`) discovery now succeeds, but the login still fails: v0.2.2 always sends the fixed client id `aionui`, and Clerk answers

```
GET https://clerk.higgsfield.ai/oauth/authorize/continue?client_id=aionui&...
-> 401 {"error":"invalid_client","error_description":"... The requested OAuth 2.0 Client does not exist."}
```

(checked October 22nd, 2026, with plain requests, no browser). Clerk, like most hosted sign-in services, accepts only clients that were registered with it. Its metadata names a `registration_endpoint` (`https://clerk.higgsfield.ai/oauth/register`) for that, which is RFC 7591 dynamic client registration, the method the MCP authorization spec expects.

## The fix

1. `OAuthServerMetadata` reads `registration_endpoint` (optional). `ProtectedResourceMetadata` reads `scopes_supported`; `discover_endpoints` passes those scopes along.
2. At login, when the server names a registration endpoint, `register_client` POSTs a public client (`client_name` AionDX, the login's loopback `redirect_uris`, `authorization_code` and `refresh_token` grants, `token_endpoint_auth_method` `none`; 20 second limit) and uses the `client_id` it returns. The loopback port is new at every login, so a client is registered per login.
3. If registration fails for any reason, the login goes on with `aionui` as before, so a server that accepts it is not affected.
4. The authorize request asks for the scopes the resource lists (Higgsfield: `openid email offline_access`; `offline_access` is what makes the server issue a refresh token).
5. The client id is kept with the token so a refresh uses the same client (the refresh token belongs to it): the stored `token_type` is `bearer` for the default client and `bearer;client_id=<id>` for a registered one. Nothing in the database changes (no migration), and nothing else reads `token_type`. Older tokens, and rolling back to a build without this patch, keep working: `bearer` alone means the default client, and an older build writes `bearer` back on a refresh, which only costs the registered client's refresh (a new login fixes it).

## Files and functions touched

| File | Change |
|---|---|
| `crates/aionui-mcp/src/oauth_service.rs` | `register_client`; `token_type_for` and `client_id_of`; `OAuthServerMetadata.registration_endpoint` and `.scopes`; `ClientRegistrationResponse`; `ProtectedResourceMetadata.scopes_supported`; `PendingLogin.client_id`; `prepare_login_flow`, `exchange_code`, `refresh_token`, `persist_token`, `get_token` use the client id; 10 new tests. |

## Tests (October 22nd, 2026, rustc 1.95.0 as AionCore pins)

`cargo test -p aionui-mcp --lib oauth_service`: 39 passed (10 new). The new ones read the Clerk metadata shape, round-trip the stored client id, register against a local stand-in (the request body is checked: redirect address, public client, name), refuse an error reply and a reply with no client id, and run the whole login preparation against a stand-in server that serves RFC 9728 metadata, authorization server metadata and a registration endpoint: the authorize address carries the registered client id and the resource's scopes, and the pending login keeps the id. A second stand-in whose registration answers 404 falls back to `aionui` with no scope.

Checked by hand against the real Clerk server (no browser): `POST /oauth/register` with a loopback redirect address answered 201 with a client id, and `authorize/continue` with that id went on to the sign-in page instead of `invalid_client`.

## Limits

- Not yet run end to end through the app: the browser sign-in and the token exchange against Higgsfield need a Higgsfield account.
- A registered client stays on the server after the login (one per login, no clean-up call); a server that limits registrations could refuse after many logins, in which case the login falls back to `aionui`.
- A server that answers a registration with a client secret and a different `token_endpoint_auth_method` than `none` is not handled; only the client id is read.
- The metadata requests still have no time limit of their own (the registration request has one).
- The RFC 8707 `resource` parameter is not sent.

## Re-applying on a new release

`git apply --check`, then `git apply -3`. If upstream adds client registration, retire this patch.
