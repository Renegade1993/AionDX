# 0002-claude-model-currency: Claude model catalog, current builds, full per-version list, both accounts

**Built against:** AionUi 2.2.2, Claude Code 2.1.280, claude-agent-acp 0.76.0 · **Target:** user-owned
launch chain, no asar change · **Status:** installed and verified September 22nd, 2026

## What it fixes

Three separate faults, all of which presented as "the Claude model picker is wrong".

1. **AionUi offered a model that did not exist and hid one that did.** The picker showed Opus 5 as
   the newest Opus. Claude Opus 5.5 (`claude-opus-5-5`) was released on September 21st, 2026 and both
   accounts could see it in the Models API, but no AionUi conversation could select it.
2. **Five entries, four of them aliases.** `default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`,
   `haiku`. An alias hides which version answers: `opus[1m]` meant Opus 5 before September 21st and
   Opus 5.5 after, with nothing in the picker saying so and no way to ask for a specific earlier
   version. Devin, in the same application, offers 76 models in a searchable list.
3. **The second account was two bridge versions behind the main account**, so the same model
   rendered under different labels depending on which agent you opened.

## Root cause

AionUi does not own the Claude model list. It asks for it, and caches the answer in
`agent_metadata.available_models`. The request travels:

```
aioncore
  -> <configDir>\acp-wrapper.js            per-account HOME, config dir, OAuth token
  -> @agentclientprotocol/claude-agent-acp  the Agent Client Protocol (ACP) bridge
  -> @anthropic-ai/claude-agent-sdk
  -> claude.exe                             the list actually comes from here
```

The bridge picks the binary in `claudeCliPath()` (`dist/acp-agent.js`):

```js
if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
// otherwise the binary bundled inside @anthropic-ai/claude-agent-sdk-win32-x64
```

**That bundled binary is pinned to the SDK release.** It was 2.1.257 while the machine had 2.1.280.
The pin is not cosmetic: Anthropic's API rejects a model the CLI predates, with

```
API Error: 400 Claude Code 2.1.236 does not support this model;
version 2.1.280 or newer is required. Run 'claude update'.
```

So no settings change could have surfaced Opus 5.5. The binary had to move first.

A second path exists and was also stale. AionUi spawns some Claude conversations through plain
`claude` on PATH, which reaches `claude-account-router.js` through the npm shim. That router
hardcoded the npm-installed binary, and npm never self-updates.

## What it changes

Everything here is a user-owned file. **The asar is untouched**, so this patch survives an AionUi
update and does not need `do_patch.ps1`.

| File | Change |
|---|---|
| `%APPDATA%\npm\claude-account-router.js` | Resolves the newest Claude Code binary instead of hardcoding the npm one. Version probe cached against file size and mtime. |
| `%APPDATA%\npm\claude.cmd`, `claude`, `claude.ps1` | Rebuilt. `claude install` had deleted them, see below. |
| `~\.agents\claude-newest-exe.js` | New. Shared "newest binary" resolver used by both wrappers. |
| `~\.claude\acp-wrapper.js` | Sets `CLAUDE_CODE_EXECUTABLE` to the newest binary. |
| `~\.claude-second\acp-wrapper.js` | Same, plus moved off `npx -y ...@0.70.0` with `shell: true` onto the pinned local 0.76.0 bridge the main account already used. |
| `~\.claude\settings.json`, `~\.claude-second\settings.json` | `availableModels` written with the account's full catalog. Every other key preserved, previous copy kept as `.bak-<timestamp>`. |

### The trap that `claude install latest` set

`claude install latest` **deletes the npm package it supersedes.** It removed
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code` and took `claude.cmd` with it. The effect was
silent and serious: `claude` on PATH then resolved straight to `~\.local\bin\claude.exe`, the account
router stopped being consulted, and both AionUi agents would have billed the main account again,
which is the exact bug the router was written to prevent.

The rebuilt shims live in the npm directory, which sits at PATH position 30 against `.local\bin` at
34, so they win the lookup. They fall through to the native binary if the router or node is missing.

### Why a settings allowlist can add models rather than only remove them

`availableModels` in Claude Code settings is an allowlist, and the bridge applies it in
`applyAvailableModelsAllowlist()` (`dist/session-model.js`). Two properties make the catalog work:

- An entry matching a model the CLI knows inherits its display name, description and effort levels.
- **An entry matching nothing is surfaced verbatim rather than dropped.** This is how a model newer
  than the bridge reaches the picker at all.

`default` is exempt and always survives, so no list written here can leave an account with nothing
selectable.

Verified that a verbatim entry is functional, not just visible: `claude-fable-5-1` renders with no
description (the CLI has no metadata for it) and answers correctly, `modelUsage: ['claude-fable-5-1']`.

## Result

25 entries per account, up from 5. Aliases first, then every model the account can use, each with its
`[1m]` 1M-context variant where CLI 2.1.280 defines one.

```
opus[1m], claude-fable-5[1m], sonnet, haiku          aliases, track the newest in family
claude-opus-5-5, claude-opus-5-5[1m]                 Opus 5.5, $4/$20 per Mtok
claude-fable-5-1                                     Fable 5.1
claude-opus-5, claude-opus-5[1m]                     ... through Sonnet 4.5
claude-sonnet-5, claude-sonnet-5[1m]
claude-fable-5, claude-opus-4-8[1m], claude-opus-4-7[1m],
claude-sonnet-4-6[1m], claude-opus-4-6[1m],
claude-opus-4-5-20251101, claude-haiku-4-5-20251001,
claude-sonnet-4-5-20250929[1m]
```

## Verify

```powershell
node "C:\AI Projects\AionDX\tools\probe-acp-models.js" both
```

Speaks ACP to the same wrapper AionUi spawns and prints the live list per account, so it answers
"what will the picker show" without starting AionUi or trusting the database cache.

```powershell
node "C:\AI Projects\AionDX\tools\sync-claude-model-catalog.js" both --dry-run
```

Rebuilds each catalog from that account's live entitlement and shows what would change.

Observed on September 22nd, 2026, main account:

```
opus[1m]            Opus (1M context)   Opus 5.5 with 1M context · $4/$20 per Mtok
claude-opus-5-5     Opus (1M context)   Opus 5.5 with 1M context · $4/$20 per Mtok
claude-opus-4-8     Opus 4.8            Newer version available · select Opus for Opus 5.5
```

## Known limits

- **Earlier claim withdrawn, and now disproved: the second account was never missing Opus 5.5.** This
  document previously said its Claude Code entitlement was narrower than its Models API list. That
  came from the `os.homedir()` bug below, which left the second agent on the bundled 2.1.257 binary
  while the main account ran 2.1.280, so two binaries were being compared rather than two accounts. With the
  bug fixed and the wrapper reapplied, both accounts resolve
  `Opus 5.5 with 1M context, $4/$20 per Mtok`, identically.

- **Bare entries still have no friendly label.** The allowlist is a list of strings with no label
  field, so a model the CLI has no metadata for shows as its raw id. Selecting one works: verified by
  live call on `claude-fable-5-1`. Tracked as P-001 in `PREROGATIVES.md`.

## Incident, 2026-09-22: this patch took the second agent down

**Symptom.** Every second-account conversation failed with `UserAgentDisconnected` about 79 ms into the turn.
The main account was unaffected, which made it look like an account or quota problem.

**Cause.** AionUi spawns the second agent with `HOME` and `USERPROFILE` set to
`C:\Users\<you>\.claude-second-home`, from `agent_metadata.env`. That is how the second account selects
its own credential store. Both `claude-account-router.js` and `claude-newest-exe.js` used
`os.homedir()` to find the native build, so under the second agent they looked for
`C:\Users\<you>\.claude-second-home\.local\bin\claude.exe`, which does not exist.

In the router the consequence was fatal: no candidate resolved, the fallback returned that same
absent path, `spawnSync` gave ENOENT, the process exited 1, and the agent died before the turn
started. The router log recorded `[cli fallback native]` on exactly those launches, against
`[cli 2.1.280 native]` for the main account, which is what identified it.

In the resolver the consequence was silent: `newestClaudeExe()` returned `null`, so
`CLAUDE_CODE_EXECUTABLE` was never set for the second account and it quietly kept using the bundled 2.1.257.

**Fix.** Both files now derive the real profile from `APPDATA`, which neither the wrapper nor AionUi
rewrites: `C:\Users\<you>\AppData\Roaming` gives `C:\Users\<you>`. The homedir path is kept as a
lower-priority candidate. The router's last-resort no longer returns a path known to be absent, and
deliberately does not fall back to `claude` from PATH, because the shim beside it re-enters the
router and would recurse.

**Lesson worth keeping.** Anything in the Claude launch chain runs under two different profiles by
design. `os.homedir()` is not a safe way to find a machine-level file there, and the failure is
asymmetric: the main account keeps working, so it reads as an account problem.
- **Bare entries have no friendly label.** The allowlist is a list of strings with no label field, so
  a model the CLI has no metadata for shows as its raw id. A renderer patch could prettify these,
  which is a candidate for a later patch and not worth an asar change on its own.
- **Refresh timing.** A new conversation builds its list from a fresh ACP session and gets the new
  catalog immediately. The cached `agent_metadata.available_models` used before a session exists
  refreshes on the next agent check or on an AionUi restart.
- **Nothing here runs on a schedule.** `sync-claude-model-catalog.js` is manual, so no entry is owed
  to `SCRIPT-REGISTRY.md`. Re-run it after Anthropic ships a model.

## Per-chat account (2026-09-25)

a request. The router now
reads `aiondx.account.conv.<conversation id>` from AionUi's `client_preferences` table (same read-only
database session) and, when it names an account in the config, launches on that account instead of
the agent's own. An account without its own `home` gets the real profile, so a second-agent chat moved to
the main account leaves the second credential store behind. On `--resume <id>` it copies the newest
`projects\<folder>\<id>.jsonl` (and the `<id>\` folder) from whichever account's config folder has
it into the one about to run it, with the chat's `memory` folder where the target has none, and
logs "carried session". Any failure leaves the launch as it was.

`install-account-switch.js` installs the router (backup `.bak-20260925`), adds plain account names to
the config (`second` added; backup `.bak-20260925`), and writes `aiondx.accounts` (names, labels, each
agent's own account) for the renderer's account pill (patch 0001). `test-account-switch.js` runs a
scratch copy: 8 checks. `tools\account-resume-test.js` resumes a throwaway session on the other
account (`node tools\account-resume-test.js <from> <to>`); on September 25th it
passed both ways with a signed thinking block in the transcript, after a first attempt hit the second
account's rate limit (429).

## Unsend through the pass-through (2026-09-25)

`claude-stream-proxy.js`, installed beside the router, runs every AionCore Claude session (stream-json
in and out): bytes pass unchanged both ways; AionDX's control requests go into Claude's stdin only
between whole lines; Claude's answers to them (`request_id` "aiondx-...") are kept from AionCore. Each
second it reads `aiondx.unsend.req.*` for its own chat from the database (read-only), sends Claude
`cancel_async_message` with that `msg_id`, and saves `aiondx.unsend.result.<msg_id>` through the API
with the runtime token AionCore gives the process. `"streamProxy": false` in the router config returns
to the plain launch. `test-stream-proxy.js` 13 checks; `tools\unsend-live-test.js` end to end.

## Revert

```powershell
copy /Y "%APPDATA%\npm\claude-account-router.js.ORIGINAL" "%APPDATA%\npm\claude-account-router.js"
copy /Y "%USERPROFILE%\.claude\acp-wrapper.js.ORIGINAL" "%USERPROFILE%\.claude\acp-wrapper.js"
copy /Y "%USERPROFILE%\.claude-second\acp-wrapper.js.ORIGINAL" "%USERPROFILE%\.claude-second\acp-wrapper.js"
```

For the catalog, restore the newest `settings.json.bak-<timestamp>` in each config directory, or
delete the `availableModels` key to fall back to the CLI's own five entries.

Do not restore `claude.cmd.ORIGINAL`. It is the stock npm shim and points at the deleted npm package.

## September 26th, 2026

- Any agent, not two accounts: a chat moved with the agent control (`aiondx.agent.conv.<id>`) runs with
  the chosen Claude agent's own environment from `agent_metadata.env` (`swapAgentEnv`); named accounts in
  the config still win where they exist.
- Claude Code is also looked for on PATH, skipping any folder that holds an AionDX launcher, so a PC
  whose Claude came from winget or elsewhere works and the search can never land on a shim.
- For the installer: the router, the pass-through and the shim go to `%LOCALAPPDATA%\AionDX\bin` on a
  a tester's PC (the owner's stay in `%APPDATA%\npm`), only when Claude Code is installed.

Later the same day:

- The usage meter's data (research `! LLM Files\Research\2026-09-26_claude-usage-windows.md`). While a
  Claude chat runs behind the pass-through, a one-token Haiku call reads the account's
  `anthropic-ratelimit-unified-*` headers: 10 s after the session starts, every 5 minutes, and after a
  turn ends when the last reading is over 90 s old. Every chat of the account shares one reading
  (`aiondx.usage.acct.<key>`; each chat's `aiondx.usage.conv.<id>` names its account). The token is the
  environment's (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`), or else the access token in the
  config folder's `.credentials.json`, read at each probe and skipped while expired; the refresh token is
  never read. `claude /login` writes a token to that file only when Windows Credential Manager fails
  (Claude Code 2.1.283 uses `Bun.secrets`), so most /login accounts get no meter; the owner's agents run on token
  files and do. The key is a hash of the token, or of the credentials
  file's path. `"usageMeter": false` in the config, or `AIONDX_NO_USAGE=1`, switches it off. Live on the first machine it ran on.
- From the review: `defaultAccount` applies only when the database names the chat's agent, so a failed
  read no longer moves a chat to the default account; a chat moved to an agent separated only by
  HOME/USERPROFILE gets its transcript carried to that profile's `.claude`; the pass-through ends 2 s
  after Claude exits even when a process Claude started still holds its output pipe.
- Tests: `test-stream-proxy.js` 18/18, `test-usage-for.js` 8/8 (new), `test-account-switch.js` 13/13.
  Installed in `%APPDATA%\npm`; the morning's copies are `.bak-20260926`.

## September 26th, 2026: the usage probe is off unless asked

Anthropic's terms do not permit a Free, Pro or Max OAuth token in any product but Claude Code
(`! LLM Files\Research\2026-09-26_headroom-and-subscription-oauth.md`), and the probe is AionDX's own call
with that token. `usageFor` now needs `"usageMeter": true` in the router config; no config, a config
without the key, or any other value leaves it off, so no installed copy starts probing by itself. The owner's own
config already said `false`. `test-usage-for.js` 11/11.

## October 1st, 2026: usage from Claude's own traffic, and YOLO means YOLO

two requests of October 1st: get the usage numbers by any means that can be proven to work before it is built in, and stop
making agents wait for a manual approval of every Bash command in YOLO mode.

- Usage tap (`startTap` in `claude-stream-proxy.js`). The router starts Claude with `ANTHROPIC_BASE_URL` on a loopback
  forwarder that hands every request to the real API untouched and reads the `anthropic-ratelimit-unified-*` headers of
  the answers going past: 5-hour and 7-day utilization, reset times, status, and which window is the representative
  claim. No call of AionDX's own is made (the September 26th probe, which presented itself as Claude Code with the
  account's token, stays behind `"usageProbe": true` and is off). Why this and not another source: neither `~\.claude`
  nor `~\.claude-second` has a `/login` session, so `/usage` cannot answer; a normal turn prints no `rate_limit_event`
  (`tools\probe-claude-stream.js rate`); `/api/oauth/usage` needs a scope the inference-only tokens do not carry. Proven on
  real calls before it was wired in: `tools\probe-usage-tap.js` (both accounts, a throwaway Haiku turn through the tap,
  headers read), and after installing, `tools\probe-router-live.js` (one turn through the installed router; `aiondx
  usage` then read "5-hour window: 16% used, resets 12:30; Weekly window: 2% used").
  Records: `aiondx.usage.acct.<key>` = `{ label, at, via: "tap", status, claim, five_hour: {u, reset, status},
  seven_day: {...} }` and `aiondx.usage.conv.<conversation>` = `{ acct, at }`, written when a window moved a whole percent
  or a status changed, else at most once a minute. The renderer's meter (patch 0001) and the Loop tool's `usage_status`
  and nudge lines (patch 0007) read them. `"usageMeter": false` in the config, or `AIONDX_NO_USAGE=1`, switches the tap
  off; **the owner's config had `false` from the probe period, so the tap does nothing until it is `true` (done October 1st,
  backup `claude-account-router.config.json.bak-20261001`).**
- YOLO means YOLO (`makeApprover`). A `can_use_tool` request on a chat whose stored mode (`conversations.extra
  .current_mode_id`, read from AionUi's database) is `bypassPermissions` is answered at once with allow, and AionCore never
  sees it. Claude asks even in bypass mode for what its own safety checks flag (a dangerous `rm`, say). Reply format
  proven on a real Claude (`tools\probe-claude-stream.js perm`): `{"type":"control_response","response":{"subtype":
  "success","request_id":...,"response":{"behavior":"allow","updatedInput":<the request's input>}}}`. `AskUserQuestion` and
  `ExitPlanMode` are never answered here. A chat the owner switched to another mode in the pill is left alone. Every answer, and
  every mode change AionCore makes, is logged (secrets masked) to `%LOCALAPPDATA%\AionDX\logs\auto-approve.log`, which is how
  the next unexplained switch gets explained. Why a chat leaves YOLO: AionCore starts Claude with `--permission-mode
  default` and applies the stored mode afterwards with `set_permission_mode` (`aionui-session claude.rs`); when that step is
  missed the process stays on `default` while the app shows YOLO. The proxy now repairs that: it logs the mismatch and
  sends the stored mode itself. All four of a team's members store `bypassPermissions`; nothing wrote anything else.
- Tests: `test-stream-proxy.js` 48/48 (the tap, usage records, the approver, the repair), `test-usage-for.js` 12/12,
  `test-account-switch.js` 13/13. Installed in `%APPDATA%\npm` (the morning's copies are `.bak-20261001`); new Claude
  processes use them, running ones keep the old until they restart.
