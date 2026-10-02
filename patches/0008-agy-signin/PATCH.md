# 0008-agy-signin: Antigravity signs in from AionUi, no terminal

**Target:** outside the asar: `%LOCALAPPDATA%\AionDX\bin\agy.exe` (a wrapper), the Antigravity agent's
command override in AionUi's database, and the Loop script's sign-in panel (patch 0001 build
`2026-09-24.5`). Status on September 26th: the fixed wrapper is installed (12:17); chat turns reach it
once AionUi restarts with patch 0009's start hook (see "How AionCore finds agy"); the first real
sign-in through the panel worked during the standalone smoke test.

a request of September 24th.

## Why Antigravity could not sign in inside AionUi

AionUi runs Antigravity's CLI in print mode (`agy -p <prompt> --output-format stream-json ...`,
aionui-session `antigravity/argv.rs`) and supports no sign-in for it (`answer_auth: false`; its
error text says to run `agy` in a terminal). Signed out, print mode tries a silent sign-in, then
opens Google's sign-in page and waits 60 seconds (agy log: "Print mode: triggering interactive
OAuth" ... "Print mode: auth timed out"). Google redirects to `https://antigravity.google/oauth-callback`,
which hands the sign-in back to agy's local listener (`http://localhost:<port>/auth/callback`); if
agy is gone or the handoff fails, the page shows a code to paste into agy's own screen. A Google
sign-in often takes longer than 60 seconds, and an AionUi chat has no agy screen to paste into:
The owner's pasted code went to the agent as a chat message, and both turns failed at about 60 s.

## The fix

`agy.exe`, a wrapper built from `agy-shim.cs` with the in-box C# compiler, installed at
`%LOCALAPPDATA%\AionDX\bin\agy.exe`; the Antigravity agent's command override
(`PUT /api/agents/a9f3c21e/overrides`) points at it. For a chat turn (`-p`):

1. It checks the sign-in with `agy models` (about 1.4 s; exit 1 and "Please sign in" when signed
   out). A success is remembered for an hour in `%LOCALAPPDATA%\AionDX\agy-signed-in.txt`.
2. Signed out, it runs agy's interactive screen in a hidden pseudo-console (ConPTY: no window,
   nothing for the user to type). The screen reads "Select login method: > 1. Google OAuth";
   the wrapper presses Enter, agy opens the Google page in the browser, and waits with no
   60-second limit. The wrapper allows 15 minutes.
3. It writes `aiondx.agy.signin = {state: "waiting", message, at}` to AionUi's settings store with
   the agent's own runtime token. The Loop script shows a panel at the top of the window: "Sign in
   to Antigravity", the message, and a box for the code in case the page shows one. A code
   submitted there goes to `aiondx.agy.signin.code`; the wrapper checks every 2 seconds and types
   it into agy's "paste the authorization code" field.
4. Every 5 seconds it runs `agy models`; once that works it ends the sign-in screen, writes
   `state: "done"` (the panel closes with "Antigravity is signed in."), and runs the turn exactly
   as AionUi asked, the command line passed through byte for byte. The chat's reply arrives as if
   nothing had happened.

Everything else (`--version`, `models`, ...) goes straight to agy. One sign-in at a time
(`Local\AionDX-agy-signin` mutex): a second turn waits for the first one's. Log:
`%LOCALAPPDATA%\AionDX\logs\agy-shim.log`, screen snapshots every 30 s with the OAuth state, code
challenge and codes masked.

    agy.exe --aiondx-status       signed in or not
    agy.exe --aiondx-signin       run the sign-in now
    agy.exe --aiondx-probe N [enter]   the interactive screen's text for N seconds (optionally press Enter on the menu)

Build: `csc /nologo /optimize+ /target:exe /platform:x64 /r:System.Web.Extensions.dll /out:agy.exe agy-shim.cs`
(from Git Bash, prefix `MSYS_NO_PATHCONV=1`).

## Checked

- Probe: the pseudo-console shows agy's welcome and login menu (2170 bytes); after Enter, "Signing
  in...", "Your browser should open automatically. If not: https://accounts.google.com/o/oauth2/auth?...
  redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback ...", and the paste field. The
  first probe read nothing: a ConPTY child of a process with redirected stdio needs
  `STARTF_USESTDHANDLES` with null handles, and the reader must drain after `ClosePseudoConsole`.
- `--version` passes through (1.2.10); `--aiondx-status` reports signed out.
- The panel: 5 checks in `tools\dx-harness\click-test.js` (`agy-signin`): shown while waiting, a
  code is trimmed and sent, text that is not a code is refused, closes with a notice when done, a
  stale wait shows nothing.
- Not yet: a full sign-in by a person through a chat turn. The first real one is the owner's.

## How AionCore finds agy (corrected September 26th)

This section said on the 25th that aioncore launches the agent's `resolved_command` first
(`resolve_session_cli_program`). That route serves Claude and Codex only. For Antigravity, AionCore passes
`cli_program: None` (`aionui-ai-agent\src\session_agent.rs:1807-1810`), so every chat turn, model probe and
version check runs bare `agy`, looked up on AionCore's own PATH (`aionui-runtime\src\spawn.rs:353-363`). Only
the health check and Test Connection use the override, which is why Settings showed the wrapper while
chats ran the real agy.

So the wrapper serves a turn only when `%LOCALAPPDATA%\AionDX\bin` comes before agy's own folder in
AionCore's PATH. AionUi copies PATH from the registry once, at launch, with every system entry before
every user entry (`desktop\src\process\startup\windowsPath.ts`). Since the 26th, patch 0009's start hook
puts bin first in AionUi's process PATH at every start, and AionCore inherits that. Until AionUi restarts
after bin is added, turns run the real agy. The wrapper's log shows `run: chat turn conv=<id>` when a
turn goes through it.

## September 26th: the bug sweep, and the first real sign-in

Fixed after review (`! LLM Files\Research\2026-09-26_bug-sweep-reports.md`, report 3):

- The check closes agy's input. `agy models` does not exit while its stdin is open (AionCore's
  `models.rs`), and in a chat turn the wrapper's stdin is AionCore's pipe, open for the whole turn. A
  signed-in check therefore ran out its 30 s, and every turn would have stalled behind a false panel.
- Only agy's own signed-out words start a sign-in. Anything else (offline, a proxy, Google's errors, a
  timeout, agy updating itself) passes the turn straight through, so agy reports its own error.
- The screen: "waiting" is written only once the login menu or the Google URL shows; the sign-in is
  checked every 5 s whatever the screen says; a screen not recognised within 25 s ends the attempt as
  failed, with a reason. The hidden agy runs without the chat's `PWD` and AionCore's permission-hook
  variables.
- Output reads are bounded (5 s after exit), and another copy of the wrapper on PATH is never taken for
  the real agy (its version resource says "AionDX agy shim").

Observed on the 26th, agy 1.2.11:

- The first real sign-in through the panel, during the standalone smoke test. At 11:44:10 the check
  found agy signed out (3 s), the wrapper chose Google OAuth, the browser page offered a code, the owner pasted
  it into the panel at 11:45:39, the wrapper typed it into agy, and agy reported signed in at 11:45:45.
  The five further chats the owner's repeated clicks opened waited for that one sign-in.
- Signed out, `agy models` prints "Error: Please sign in to view available models. Launch the CLI
  without arguments to sign in." and exits 1 in about a second. It opens no browser.
- With `SSH_CONNECTION`, `SSH_CLIENT` and `SSH_TTY` set, agy ignores the sign-in it has stored and acts
  signed out, so the check must never set them. They do give a safe test of the menu on a signed-in
  PC: `agy.exe --aiondx-probe 12 enter` with them set shows "You are currently not signed in. Select
  login method: > 1. Google OAuth", and after Enter prints the Google URL and a paste field instead of
  opening a browser. Both of the wrapper's matches held.
- Installed in `%LOCALAPPDATA%\AionDX\bin` at 12:17; `--aiondx-status` says "signed in".
- The log lost lines. A chat's first message starts several wrappers at once (version check, model
  list, the turn), and `File.AppendAllText` refuses a file another one holds open, so the smoke test at
  13:04 showed the model list but no turn. The log now appends with shared access and retries; the
  rerun at 13:06 recorded `run: chat turn conv=46a7e0e2`, which confirms that turns in the standalone
  app go through the wrapper. Installed at 13:06.

## Removing it

`PUT /api/agents/a9f3c21e/overrides {"command_override": "C:\\Users\\<you>\\AppData\\Local\\agy\\bin\\agy.exe"}`
(the real agy), then delete `%LOCALAPPDATA%\AionDX\bin\agy.exe`.
