# 0012-mcp-oauth-ui-state: an MCP server flagged "needs login" is never also flagged "authenticated"

**Built against:** AionUi 2.2.2 (renderer bundle) · **Target:** `out/renderer/assets/index-9Ro2mf0O.js`
(the hashed chunk name is specific to the pinned stock build; re-locate the anchor if AionUi ships
a new version) · **Status:** written 2026-10-27, not yet built into `vendor\app.asar.patched`.

A follow-on to core-0007/0008/0009, the three backend fixes to MCP OAuth. core-0008's PATCH.md
documented this as a known limitation rather than fixing it there, since the frontend bug lives in
the compiled renderer bundle, not the Rust backend those patches touch.

## What changes

`useMcpOAuth`'s `markLoginRequired` (`upstream\packages\desktop\src\renderer\hooks\mcp\
useMcpOAuth.ts:170`) runs when the backend reports an MCP server needs a fresh OAuth login. Before
this patch it set `needsLogin: true` but left `isAuthenticated` at whatever it was already:

    isAuthenticated: prev[serverId]?.isAuthenticated ?? false,

So a server the user had previously authenticated, then lost that authentication (token expired,
revoked, server restarted), could carry `isAuthenticated: true` and `needsLogin: true` at the same
time. `McpServerHeader.getStatusIcon` happens to check `needsLogin` before `isAuthenticated`, so
nothing visibly wrong appears today - but a server whose login is required should never also read
as authenticated. The patch makes `markLoginRequired` force `isAuthenticated: false`, so the two
flags are never both true for the same server, regardless of what reads them now or in the future:

    isAuthenticated: false,

Minified, the anchor (captured generically so a bundler variable rename does not break it, the same
approach as patch 0006) is:

    markLoginRequired:M.useCallback(S=>{T(L=>({...L,[S]:{isAuthenticated:L[S]?.isAuthenticated??!1,needsLogin:!0,isChecking:!1}}))},[])

becomes:

    markLoginRequired:M.useCallback(S=>{T(L=>({...L,[S]:{isAuthenticated:!1,needsLogin:!0,isChecking:!1}}))},[])

## What it does not change

`checkOAuthStatus` and `clearLoginRequired`, which already set `isAuthenticated` to a real,
freshly-checked value rather than carrying a stale one forward. `McpServerHeader`'s status icon,
which already checks `needsLogin` first - this patch removes the latent inconsistency the icon's
ordering was quietly working around, it does not change the icon's own logic.

## Safety

`apply.js` finds the anchor by a regex that survives the bundler renaming variables, and it must
match exactly once in `out/renderer/assets/*.js`, or nothing is written and the build stops. The
edit only changes an object literal's value (a carried-forward reference becomes a literal
`false`), so the bundle's syntax cannot change. Re-running on a patched tree finds the new text and
changes nothing.

## Testing

`node patches\0012-mcp-oauth-ui-state\test.js` against the chunk read out of `app.asar.stock`:
the anchor is found once; `isAuthenticated` is forced to `false`, not carried forward; the old
carried-forward form is gone; a second run changes nothing; a missing or doubled anchor refuses;
the patched chunk still parses as an ES module; `apply.js` end to end on a throwaway tree, twice,
and leaves unrelated files alone.

## Revert

Roll back or revert to stock from the desktop shortcut's menu.
