# 0003-local-account: AionUi opens without an aionui.com sign-in

**Built against:** AionUi 2.2.2 (the AionPro edition) · **Target:** main process and renderer
`index.html` · **Status:** built into `vendor\app.asar.patched` on 2026-09-24, not installed.
Installs with the next "AionDX Apply Update".

K, September 24th: *"also want to remove the whole "sign in with email" thing. That won't be
necessary for our fork."*

## What the stock app does

The installed AionUi is the AionPro edition. Its main process pins `CORE_IDENTITY_MODE =
"aionpro"` (`out\main\index.js` line 44091, with the comment "AionPro desktop always runs Core in
'aionpro' identity mode ... `--local` (system_default_user) is reserved for the open-source AionUI
embedded build"), launches aioncore with `--identity-mode aionpro`, and gates the whole window on
the main process's `AuthManager`: until someone signs in through aionui.com in the default
browser, the renderer's layout redirects to `/login` ("Sign in to AionUi"). After sign-in,
`CoreUserBridge` provisions a Core user for that account id through aioncore's internal routes
and installs a session cookie in the renderer.

The account id matters more than the sign-in: every conversation (174), team (17), project (121)
and setting belongs to the Core user that id maps to (`user_<id>...` on K's machine), and
aioncore's local default user owns nothing.

The aionui.com session K has now expires on October 7th, 2026 at 11:41 (`refreshExpireAt` in
`%APPDATA%\AionUi\auth.enc`). After that the stock app would sign him out and ask again.

## What this patch changes

`apply.js` rewrites five `AuthManager` methods to call a helper block inserted above the class:

| method | now |
|---|---|
| `getSnapshot()` | always `authenticated`, with the local account |
| `bootstrap()` | loads the local account and announces it; no network |
| `login()` | returns `{ ok: true }`; no browser |
| `logout()` | does nothing (logged) |
| `clearSession()` | drops tokens, keeps the account |

The local account is, in order: `%APPDATA%\AionUi\aiondx-account.json` if it exists; else the
account in `auth.enc` (K's, so the same Core user and all his data); else a new
`aiondx-<uuid>` id with the Windows user name. The choice is saved to `aiondx-account.json` on
first run. `desktop-user-` ids are never used, because `CoreUserBridge` refuses to provision them.

Nothing else in the main process changes. `CoreUserBridge`, the bootstrap secret, the backend's
`--identity-mode aionpro` and the session cookie all work exactly as they do today, so the backend
side is the same code path K's app ran this morning. `auth.enc` is never modified or deleted.

The renderer's `index.html` gets one style rule hiding Settings > Account
(`[data-settings-id="account"]`), which only showed the aionui.com profile, a balance and a
sign-out button.

The stock method bodies stay in the file under `__aiondxStock_*` names, unused, so a diff against
stock stays small and readable.

## What is lost

The aionui.com account itself: its profile page, the credit balance, and anything that needs an
aionui.com token. Nothing K uses is known to need it. WebUI pairing keeps working on K's machine,
because the account id is the real one.

## Why not local identity mode

aioncore has a real no-auth mode (`--local`, `system_default_user`), which the open-source build
uses. It was the first design and was dropped: it switches authentication off on the API and
shows an empty app, because every row belongs to K's AionPro user. Moving 174 conversations, 17
teams, three per-user folders (`assistant-rules`, `session-skills`, `conversations`) and the
`skills.path` column to another owner is a one-way data migration. The backend's own adoption
code (`aionui-db\src\repository\sqlite_user.rs` `adopt_system_default_data`,
`aionui-extension\src\fs_adopt.rs`) is the recipe if a source build of the open-source edition
ever needs it; it runs in the other direction today.

## Testing

`node patches\0003-local-account\test.js`, 34 checks, reads the stock bundle out of
`app.asar.stock` and runs the patched `AuthManager` in a VM sandbox with a fake `electron.app` and
a network stub that fails the run if anything reaches aionui.com:

- DATA LOSS: the `auth.enc` id wins on first run, is saved, survives `auth.enc` being deleted, and
  beats a different `auth.enc` later; a machine that never signed in gets a stable `aiondx-` id;
  a `desktop-user-` id is never used.
- SIGN-IN AGAIN: bootstrap announces `authenticated`; login, logout and `clearSession` all leave
  the account signed in; `auth.enc` is never cleared.
- NETWORK: bootstrap, login, logout, `getAccessToken` and `fetchUserInfo` make no call.
- BAD BUILD: applies to stock; applying twice changes nothing; an older helper block is replaced;
  a missing or duplicated anchor refuses and writes nothing; the patched bundle passes
  `node --check`; `index.html` gets exactly one style tag.

`tools\do_patch.ps1` runs `apply.js` on every build and stops the build if it exits non-zero.

## Verify after install

`tools\aiondx-apply.ps1` now waits up to 90 s after reopening AionUi for two lines in
`%APPDATA%\AionUi\logs\<yyyy>\<MM>\<dd>\<yyyy-MM-dd>.log` and reports the result in its closing
message:

    [AionDX 0003] local account from auth.enc, id c18c50...
    [CoreUserBridge] Core session ready (core_user_id=user_<id>...)

By hand: AionUi opens straight to the app, Settings has no Account entry, and the conversation list
is K's.

## Revert

`tools\revert.ps1` reinstalls the stock asar. `auth.enc` is untouched, so the stock app resumes the
aionui.com session until it expires. `aiondx-account.json` can stay; only this patch reads it.
