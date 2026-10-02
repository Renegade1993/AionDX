# 0007-loop-tool: agents use the same Loop as the owner

**Target:** outside the asar: `%LOCALAPPDATA%\AionDX\bin\` (two programs), an auto-inject skill,
one MCP server row in AionUi's database, and records in AionUi's per-user settings store.
**Status:** installed and registered 2026-09-24 13:48. The Loop that acts on it is patch 0001's
build `2026-09-24.2`, inside `vendor\app.asar.patched` (BCE7BB32), waiting for AionDX Apply
Update. Built against AionUi 2.2.2 / AionCore 0.2.2.

a request of September 24th Prerogative P-010, design
directive 2.

## What an agent can do

| | MCP tool | shell |
|---|---|---|
| see its Loop: on or off, continue message, who changed it last, what the Loop last decided, whether AionUi is running it | `loop_status` | `aiondx loop status` |
| switch it on or off, change the continue message, ask for a context compaction, with a note | `loop_set` | `aiondx loop set --on/--off --message --compact --note` |
| the same for a teammate, or the whole team (`all`) | `member` | `--member` |

Anyone on a team can read a teammate's Loop; only the lead changes one. Every change shows on
the Loop button within 3 seconds: a notice at the top of the window naming the agent and its
note, a purple mark on the button for 10 minutes, and a "Last changed by" line in the hover card
and the menu (patch 0001).

## How the pieces fit

**State.** Each Loop's settings are a record in AionUi's per-user key-value store,
`GET/PUT /api/settings/client` (aionui-system `client_pref.rs`: a flat map, per-key upsert, null
deletes, no side effects):

| key | written by | holds |
|---|---|---|
| `aiondx.loop.conv.<conversationId>`, `aiondx.loop.team.<teamId>.<slotId>` | The owner's menu, the Loop switching itself off, the tool | `on`, `msg`, `compactAt`, `by` (`user`, `loop`, `agent`), `who`, `for`, `at`, `note`, `rev` |
| `aiondx.loopstatus.<same suffix>` | the renderer only | what the Loop last decided (`why`), nudges, last nudge, compaction sent |
| `aiondx.engine` | the renderer, every 2 minutes | `{at, build}`; the tool calls the engine stale after 5 minutes |

The renderer takes a record when its `at` is newer than the last one it applied or wrote; both
sides stamp with this machine's clock. Counters and timers stay in the renderer's localStorage.
Conversation `extra` was the first plan and was dropped: `PATCH /api/conversations/{id}` stamps
`updated_at`, the sidebar sorts by `modified_at`, so every toggle would have moved the chat to the
top of the owner's list.

**Identity.** aioncore puts `AIONUI_BASE_URL`, `AIONUI_RUNTIME_TOKEN`, `AIONUI_USER_ID` and
`AIONUI_CONVERSATION_ID` into every agent process, but an MCP server gets only its own row's
environment, and CLIs differ in what they pass on. So the program reads its own environment,
then walks up its parent processes and reads theirs from the PEB (the offsets
a Python helper uses). A parent counts only if it started before its
child, so a reused process id is never taken for one. That also covers Devin, whose shell strips
the variables: `devin.exe` above it still has them. The runtime token signs in as the user
(aionui-auth `runtime_token_channel`) and needs no CSRF token.

**Two ways in.** A chat's MCP servers are frozen when the chat is created (aionui-conversation
`build_runtime_mcp_snapshot`): the list comes from the assistant's MCP binding, which in `auto`
mode is whatever the user last picked for that assistant. The owner has never picked any, so a new MCP
row reaches no existing chat (the enabled `airtable` row is absent from every running Claude
agent's `--mcp-config`, checked 13:44). Changing an assistant's binding restarts team members
bound to it, which would interrupt a running team. So:

1. `aiondx-loop.exe`, the MCP server, is registered as an ordinary enabled row, for chats started
   with it selected and for the owner's MCP picker.
2. `aiondx.exe`, the same code as a console program, works from any agent's shell, and the
   `aiondx-loop` skill in `builtin-skills\auto-inject` (offered to every chat, every backend)
   says how and when to use it. PowerShell neither waits for nor captures a Windows-subsystem
   program (measured: no output, `$LASTEXITCODE` empty), hence the console build.

**Compaction.** `loop_set compact: true` (or the owner's "Compact its context" menu item) sets
`compactAt`; the renderer sends the agent's own command (`/compact` for Claude and Codex,
`/compress` for Gemini CLI and Qwen, from `GET /api/conversations/{id}/slash-commands`) the next
time the agent stops, through the same path as a nudge. A team member's recognized command
reaches it unwrapped (aionui-team `recognized_command_is_sent_bare_to_member`). An agent with
neither command is refused up front.

## Files

| file | what |
|---|---|
| `aiondx-loop.cs` | the whole program: MCP server, shell commands, identity, API client |
| `aiondx-loop.exe`, `aiondx.exe` | the two builds (`/target:winexe` and `/target:exe`), rebuilt by `install.js` when the source is newer |
| `skill\aiondx-loop\SKILL.md` | the skill; `{{AIONDX}}` becomes this machine's path to `aiondx.exe` at install |
| `install.js` | builds, copies, installs the skill, registers the row; `--no-register`, `--check`, `--remove`, `--remove-skill` |
| `test-loop-tool.js` | 64 checks against a stand-in API |

Build by hand:

    csc /nologo /optimize+ /target:winexe /platform:x64 /r:System.Web.Extensions.dll /out:aiondx-loop.exe aiondx-loop.cs
    csc /nologo /optimize+ /target:exe    /platform:x64 /r:System.Web.Extensions.dll /out:aiondx.exe      aiondx-loop.cs

(`csc` is `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`; from Git Bash prefix
`MSYS_NO_PATHCONV=1`, or it turns `/nologo` into a path.)

## Installing, checking, removing

    node patches\0007-loop-tool\install.js                 run from an agent's shell inside AionUi (the row needs its runtime token)
    node patches\0007-loop-tool\install.js --check         exit 0 when both programs, the skill and the row are current
    node patches\0007-loop-tool\install.js --remove        the row, the programs and the skill

`tools\aiondx-apply.ps1` runs it with `--no-register` after every swap, because a backend
version change rewrites `builtin-skills` and drops the skill; a revert to stock runs
`--remove-skill`. The programs and the row are outside the app, so an AionUi update leaves them.
A running agent holds `aiondx-loop.exe` open; the installer renames the old copy aside and each
agent moves to the new one at its next start.

To turn the tool off without removing it: switch `aiondx-loop` off on Settings > Tools (the switch
comes with Loop script `2026-09-26.3`; AionUi 2.2.2 itself has none, a correction of September 26th)
or run `aiondx mcp disable --name aiondx-loop`, then delete the skill folder. New chats then go
without it; chats that already have it keep it. Each call is logged to
`%LOCALAPPDATA%\AionDX\logs\loop-tool.log`, one line, never a token.

## Version 1.1.0 (2026-09-25): the hold and the cache window

`loop_set` takes `hold` (the CLI `--hold MINUTES`, 0 to 240): minutes of short replies the Loop keeps
the prompt cache warm through before it rests; written as `holdMin` on the Loop's record, kept by later
changes. `loop_status` adds a `Cache:` line (warm until, the agent's last message, the next nudge), a
`Resting since` line and the hold. The tool descriptions and the skill describe the cache window
instead of the old 2, 5, 10, 20, 30 minute backoff. 71 checks.

## Testing

`node patches\0007-loop-tool\test-loop-tool.js`, 64 checks. It builds both programs, starts a
stand-in for AionUi's API (the routes the tool uses, shapes checked live on the 24th) and talks
MCP over stdin and stdout:

- protocol: the client's protocol version is echoed, instructions are sent, a notification gets
  no reply, unknown methods get -32601, a line that is not JSON gets -32700 and the server goes on;
- schemas use only `type`, `properties` and `description`, and no text has an em or en dash;
- solo chat: on, message, empty message, nothing to change, a 4000-character limit, compaction,
  the engine's heartbeat and status shown, who changed it last;
- compaction per backend: `/compact`, `/compress`, and a refusal that writes nothing;
- team: a teammate reads the lead's Loop but cannot change it; the lead changes a teammate by
  name, case-insensitive, or by slot id; `all` writes every member in one request; unknown and
  ambiguous names are errors that list the team;
- identity: with none it says so; with none of its own it finds the chat in its parent; a
  refused token and a closed AionUi are reported plainly; the log never holds a token;
- lifetime: it exits when stdin closes, and when its parent dies with stdin still open;
- the shell program: the same reports and refusals, `--flag=value`, usage and exit codes, and
  PowerShell captures its output.

Live, 2026-09-24: Claude Code 2.1.281 (`claude -p` with a one-off `--mcp-config`) started the
installed server, called `loop_status` and got this chat's Loop back (`conv=dd44ee55
loop_status ok` in the log); `aiondx loop status` from this chat's shell gives the same report.

The renderer half is tested in `tools\dx-harness\click-test.js` (144 checks, 34 of them new):
The owner's changes reach the store, an agent's change shows (notice, mark, hover line, menu), a Loop
only the store knows is ticked with its page closed, status and heartbeat are published and not
rewritten while nothing changes, older Loops are migrated, compaction from the menu and from an
agent, and an older backend with no store runs as before.

## September 26th, 2026: 1.2.0, the installer's per-user half

- `aiondx activate [--payload DIR] [--quiet] [--from WHO]`: copies the payload's programs to
  `%LOCALAPPDATA%\AionDX\bin` (the Claude launcher only where Claude Code is installed, and never over
  the developer layout in `%APPDATA%\npm`), the skills into `builtin-skills\auto-inject` once AionCore
  has built that folder, the icon and AionUi's shortcut icons, puts bin first on the user PATH, and
  writes `HKCU\Software\AionDX\AionDX`, `%LOCALAPPDATA%\AionDX\manifest.user.json` (every file with its
  SHA-256, an append-only history) and a log per run (newest 20 kept). Only what differs is changed; a
  running program's file is renamed out of the way. 60 s deadline.
- `aiondx deactivate`: takes it back out; the manifest stays, marked removed.
- `aiondx shortcuts [--common] [--reset]`: the AionDX icon on AionUi's shortcuts through WScript.Shell,
  which keeps the shortcut's other properties.
- `aiondx doctor` reports the installed release from the manifest and any file that differs from it.

## September 26th, 2026: 1.3.0, priority messages, and the activator after review

- `priority_send` (MCP) and `aiondx priority --member NAME --message TEXT` (shell), for a team lead: the
  team lead's question 2, answered by making its requests top priority. The message goes by the
  user's own route to that teammate (`POST /api/teams/{id}/agents/{slot}/messages`), which AionCore
  queues as foreground work ahead of agents' messages and team notices, without stopping the teammate's
  turn. It arrives marked as the lead's priority message, and the reply gives the teammate's queue, with
  a warning from 20 waiting.
- `aiondx loop status` lists each teammate's queue (the lead's question 1).
- The activator, after review (`! LLM Files\Research\2026-09-26_bug-sweep-reports.md`, report 2): one
  run at a time (`Local\AionDX-activate`); log names carry milliseconds and the pid; timestamps are ISO
  in every culture; each step has its own error handling, so one failure no longer skips PATH and the
  registry; only its own logs rotate, never the installer's; a standalone install gets no shortcut step
  (AionDX.exe carries its icon), and a reset touches only shortcuts showing AionDX's icon; it waits for
  AionCore's skills folder only while AionCore is building it; deactivate removes only its own programs
  and registry values; the manifest is replaced in one step; the `C:\ProgramData` payload fallback is
  gone; `doctor` counts a missing stock AionUi as information on a standalone install. Skills get the
  real bin path in place of `{{AIONDX}}`.
- Tests 83/83. Installed on the developer's machine with `install.js --no-register` at 12:17.

## September 26th, 2026: 1.4.0, resume at a set time

A team lead, told to slow down until 12:10 for a new usage window, answered every nudge "Holding"
and resumed only when the owner noticed the time (team log, September 26th): an agent has no clock between turns.
`loop_set` takes `resume_at` (`12:10`, `3:30 pm`, `+45` minutes, an ISO time within 24 hours, `off`) and
`resume_message`; the shell takes `--resume-at` and `--resume-message`. The record gets `wakeAt`,
`wakeMsg`, `wakeBy` and `wakeSelf` (the agent set its own, so the nudge says "the resume time you set").
A resume time switches the Loop on; `on: false` clears it; other changes keep it. `loop status` says when
it resumes, who set it, whether the cache is kept warm until then (up to 50 minutes away) or left to run
out, and when it last resumed. When the running engine's build predates resume times the reply says so
and tells the agent to watch the clock itself. The renderer half is patch 0001 build `2026-09-26.2`.
Tests 101/101; installed on the developer's machine at 12:56.

## September 26th, 2026: 1.5.0, MCP for agents

a request, with agents changing servers freely and the owner seeing each change. Research:
`! LLM Files\Research\2026-09-26_mcp-configurable-and-transparent.md`.

- `mcp_status` (MCP) and `aiondx mcp status`: the servers the chat was started with, how its agent
  reported them where the backend keeps that (`runtime.mcp_servers`, from AionDX's AionCore build), and
  AionUi's whole MCP list: ON or OFF, how each runs, the last check, recent changes. Names of env
  variables and headers are shown, never their values.
- `mcp_set` and `aiondx mcp add|update|enable|disable|test|remove`, through AionUi's own routes:
  - add switches the new server on (plain create leaves it off) and checks it, and refuses a name
    already listed (create would take that row over and switch it off);
  - enable and disable read the state and toggle only when it differs, since AionCore's toggle flips;
  - servers built into AionUi are refused, as in the UI;
  - every change goes to `aiondx.mcp.log` (the last 30, with the agent's name, chat and note), which
    the renderer announces.
- Tests 115/115.

## September 26th, 2026: 1.6.0, the AionDX MCP file and servers used as needed

a request, made while a team was blocked:
agents need MCP access on an as-needed basis, through a global AionDX directory or file that every agent knows carries the MCP access
credentials.

- The AionDX MCP file, `%USERPROFILE%\.aiondx\mcp\servers.json` (`AIONDX_MCP_FILE` overrides it for the
  tests): `_about` lines, `mcpServers` in the form Claude Desktop and Claude Code use (`command`, `args`,
  `env`, `cwd`, or `type` http or sse with `url` and `headers`), and `secrets` that any value names as
  `${NAME}` (then the environment; `${NAME:-default}` falls back). No chat loads it. Writes go through a
  lock file and a whole-file swap; it is laid out for a person to edit.
- `aiondx mcp list | tools SERVER [TOOL] [--full] | call SERVER TOOL [--param k=v]... [--json J|-]
  [--json-file F] [--out F] [--raw] [--timeout S] | path | init | secret NAME`, and the MCP tools
  `mcp_tools` and `mcp_call`. A call looks the name up in the file, then in AionUi's list (so a server
  switched OFF there still works when asked), connects for that one command and closes.
- The client: stdio (a `.cmd` or `.bat` through `cmd.exe /d /s /c`, PATH and PATHEXT searched, Node found
  in Program Files or AionUi's runtime when it is not on PATH), streamable HTTP (JSON or event-stream
  answers, `Mcp-Session-Id`, `MCP-Protocol-Version`, a DELETE at the end) and the 2024-11-05 SSE
  transport, with the spec's fallback from a refused POST to a GET. A server's own requests get answers
  (`ping`, `roots/list` empty, anything else refused). TLS 1.2 and 1.3.
- What a server gets: its credentials from the file, and the agent's environment without `AIONUI_*`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. What it leaves: nothing; this
  process joins a kill-on-close job before starting one, and its process tree is killed after use. The
  command line has a watchdog (the timeout plus 60 s).
- `--param` values follow the tool's input schema: integers and numbers, `true`/`false`/`yes`/`no`, JSON for
  objects and arrays, `a,b,c` for a list, `null` where allowed, text otherwise. JSON that lost its quotes
  (Windows PowerShell 5.1) is refused with the ways round it.
- Answers: text as it is; pictures and sound saved under `%TEMP%\aiondx-mcp` and named by path;
  resources and links described; `structuredContent` printed when there is nothing else; the tool's own
  error exits 1. Through `mcp_call`, text and pictures go back as the server sent them, so the agent sees
  the picture.
- Shown, never values: env and header names, a URL without its query, `***` after a flag named like a key
  or token. Every use goes to `use.log` beside the file (when, which chat, server and tool); a secret's
  name is logged when `secret` prints it.
- `add` goes to the file by default (`where: "file"`). `--aionui` / `where: "aionui"` adds to AionUi's
  list, switched OFF unless `--on` / `on: true`: every new chat gets the ON ones. update, remove and test
  find the name in the file or the list; enable and disable are the list's. A change made in an AionUi
  chat is announced to the user as before (the renderer's notice reads "added the MCP server X to the
  AionDX MCP file").
- Tests: `test-mcp-bridge.js` 71/71 against `test-mcp-fixture.js` (stdio through a `.cmd`, streamable HTTP
  as JSON and as events, the SSE transport and the fallback, a stand-in AionUi API); `test-loop-tool.js`
  117/117. Installed on the developer's machine the same afternoon; the file was made empty.

## September 26th, 2026 (evening): 1.7.0, `aiondx setup`

`aiondx setup scan` and `aiondx setup apply --all [--skip KIND]... [--prefs TEXT]` / `--plan FILE`: the setup
skill's `survey.js` and `apply.js` for an agent, the same ones the Welcome screen's Import runs, so the backup agent
(Antigravity) follows fixed steps instead of improvising. They run on Node.js when it is installed, else on
AionDX's (or AionUi's) own Electron as Node, hidden, with a 150 s limit and a watchdog. The survey is kept in
`%LOCALAPPDATA%\AionDX\setup\survey.json` for `apply`. `test-setup-cli.js` (patch 0004) 8/8.

## September 26th, 2026 (night): 1.8.0, until the user stops it

a request. `loop_set until_stopped: true` / `aiondx loop set --until-stopped` (for when the user asks)
writes `forever: true` and `foreverAt` into the Loop's record; the Loop engine (patch 0001 build `2026-09-26.6`)
then never rests and never gives up. No agent can switch such a Loop off (`on: false`) or end the mode
(`until_stopped: false`) on its own: the tool refuses, names the Loops, and changes nothing. It allows it only when
`aiondx.loopask.<the caller's chat or member>` holds the user's own request for a Loop off, typed in the caller's
chat after the mode was set and in the last 30 minutes (the engine writes that key from what the user typed; no
agent's words reach it). The record then carries `askedAt` and the request as its note, and the engine accepts it.
So a lead can switch off a teammate's Loop when the user asks the lead to. Status reads "ON until the user stops
it". An engine older than `2026-09-26.6` is named in the reply. `test-loop-tool.js` 130/130.
- 1.8.1: a value that names a secret ("Bearer ${GITHUB_TOKEN}") is never sealed itself: the secret is sealed in
  "secrets", and the value is filled in at use. 1.8.0 would have sealed such a header with its placeholder unfilled.
  `test-mcp-bridge.js` 81/81, `test-loop-tool.js` 130/130. Installed on the developer's machine.

## September 27th, 2026: 1.9.0, the user's GitHub

a request. This PC's git signs in to GitHub through Git Credential Manager (the system git config's
`credential.helper manager`), so a push needs no token and no MCP server; an agent could not find that out, list the
repositories, or make one. `aiondx github` (status: the account, who commits are signed as, how to push),
`aiondx github repos`, `aiondx github create NAME [--public] [--description TEXT]`, and the MCP tools
`github_status` and `github_create_repo`, all with git's stored sign-in (`git credential fill`, never a window:
`GCM_INTERACTIVE=never`); the token goes to GitHub's API and is never printed, logged or kept. `create` is private
unless asked, sends JSON, and reads back what GitHub made and sets it right: the AionDX repository, created private
on the 27th through a hand-made call, came out public from its first second (GitHub's events: PublicEvent at
creation) and was made private about 40 minutes later. `aiondx mcp list` and `mcp_status` end with a line that sends
anyone looking for "the GitHub MCP" here. The skill's description and a "The user's GitHub" section say the same.

Found on the way: .NET writes the console input encoding's byte-order mark into a child's standard input as soon as
it sets the pipe up, so with a UTF-8 console `git credential fill` refused the first line ("credential missing
protocol field"). `RunGit` switches the console input encoding to UTF-8 without the mark while git starts.
Tests: `test-loop-tool.js` 143/143 (a stand-in git and a stand-in GitHub), `test-mcp-bridge.js` 81/81. Installed.

## October 1st, 2026: version 1.10.1, the usage of the account, and pictures in chat

a request of October 1st.

- `usage_status` (tool) and `aiondx usage [--all]` (shell): the Claude account this chat runs on, from the records the
  usage tap writes (patch 0002): how much of the 5-hour and weekly windows is used, when each resets ("resets 12:30, in 3
  h 3 min"), and LIMIT REACHED with the reset time when a window is rejected. A window past its reset time is reported as
  reset (usage back to 0% until the next request). `--all` lists every account AionDX has a reading for. `loop_status` and
  `loop status` end with a one-line summary. The skill's "Usage and limits" section tells an agent to look before a long
  job, to say so when usage is over about 70%, and not to retry or ask for a nudge while a limit stands.
- The Loop's nudges end with the same summary (renderer `2026-10-01.1`), and the Loop pauses by itself for an account at its
  limit and carries on at the reset.
- 1.10.1: the tool's instructions and the skill (`SKILL.md`, "Pictures, files and folders in chat") tell every agent how to
  show the user a picture (`![what it shows](C:/path/in/your/working/folder/pic.png)`, inside the working folder, spaces in
  angle brackets) and how to link a file or folder (`[label](file:///C:/path/folder/)`, which becomes a chip with a button
  that opens it with Windows). The picture route was already in AionUi (`LocalImageView`, `/api/fs/image-base64`, limited to
  the working folder and AionUi's own folders); the agents did not know. The owner's September 26th and 27th requests (R-014,
  R-015).
- Tests: `test-loop-tool.js` 152/152, `test-mcp-bridge.js` 81/81. Installed with `node patches\0007-loop-tool\install.js
  --no-register` on October 1st (the MCP row was already there); the skill is refreshed, and a chat started from now on sees
  `usage_status`.

## October 1st, 2026: version 1.11.0, a real stop for a teammate

A request of October 1st: fix the "lost control" case, an agent that cannot be stopped by the harness or by the UI (one agent was then running away).
A team lead had no tool that stops a teammate: `team_interrupt_agent` cancels the turn and then delivers the replacement message the lead
supplies, which starts the next turn (`session.rs` `interrupt_agent_message`), and `team_shutdown_agent` is a handshake the teammate has to agree
to. AionCore does have a stop, the pause route the UI's Stop button for a member uses, and no agent tool reached it.

- `agent_stop` (tool) and `aiondx stop --member NAME [--reason TEXT] [--keep-process]` (shell), team lead only. In order: the member's Loop
  off (a Loop the user set to run until they stop it cannot be switched off by an agent; the reply says it will wake the member again);
  `POST /api/teams/{id}/runs/{run}/agents/{slot}/pause` (the turn is cancelled and the slot claims no work until the user writes to it); a
  wait of up to 6 seconds for the turn to end; then `POST /api/teams/{id}/agents/{slot}/runtime/restart`, which ends the agent's process and
  with it anything it started in the background (monitors, background shells, scheduled wake-ups), which a cancel does not. Each step is
  reported, including a refused pause or restart; nothing is claimed as done that was not. `keep_process` skips the restart.
- The skill ("Stopping a teammate") and the tool's instructions say that interrupt and shutdown are not stops.
- Tests: `test-loop-tool.js` 167/167 (the order of the three calls, the reason carried to the pause, a refused pause, a refused restart, a
  locked Loop, the lead and teammate refusals, the shell form), `test-mcp-bridge.js` 81/81. Installed on this PC on October 1st.

## October 1st, 2026: version 1.12.0, `aiondx migrate`, moving from AionUi to AionDX

a request of October 1st. AionDX is AionUi's program renamed and uses the
same data folder (`%APPDATA%\AionUi`), so the chats carry over by themselves; the work is removing AionUi's program safely and
proving the data was not touched. The installer page (`installer\aiondx.iss`) calls this; it is also a command.

- `aiondx migrate detect [--dir D] [--data D]` reports the AionUi found (its folder, version, whether it is for one user or all users,
  its uninstaller, whether it is running, the size of its chats database). `aiondx migrate run [--backup-dir D | --no-backup]
  [--no-elevate] [--result FILE] [--log FILE] [--dir D] [--data D]` does the move. Without `--dir` it reads the uninstall entries in the
  registry (all users, 32-bit view, current user) and the two usual folders. `aiondx migrate backup --to DIR` and `aiondx migrate
  verify --backup DIR` are the two halves on their own: copy the data aside, and compare the data folder with a backup.
- `run`, in order: refuse while that AionUi's own `AionUi.exe` is running; copy the chats database (with its `-wal` and `-shm`), the
  assistant rules, `config`, Local Storage, Session Storage, Preferences, Local State, `auth.enc` and `device-id.json` to the backup
  folder, hashing each copy and comparing it with the original; run AionUi's own uninstaller silently (`/S`, `/currentuser` or
  `/allusers`, `_?=<folder>` so it finishes before we go on), then delete the uninstaller and the folder it leaves; hash the data again
  against the manifest taken before. The data folder is never written to, only read.
- A machine-wide AionUi needs administrator rights to remove. `run` starts itself again through the Windows prompt (once), waits for the
  elevated copy and reads its result file. Declining the prompt leaves everything as it was.
- Exit codes: 0 moved, 2 no AionUi found, 3 permission prompt declined, 4 AionUi is running, 5 the backup failed (nothing removed),
  6 AionUi would not uninstall, 7 the data changed during the move (said loudly, the backup is named).
- `--result FILE` gets `status=`, `message=` and `backup=` lines for the installer to show on its last page; `--log FILE` appends what
  was done.
- Installer: when AionUi is found, a page after the welcome offers "Move to AionDX" (the default, unless the AionUi found is newer than
  the 2.2.2 this AionDX is built on) or "Keep AionUi too", with a tick for the backup. Silent installs keep AionUi unless run with
  `/MIGRATE=yes`; `/AIONUIBACKUP=no` skips the backup. When only the chats are left (AionUi already removed), nothing is offered; the
  Ready page and the run log say AionDX opens the chats in `%APPDATA%\AionUi`.
- Tests: `test-migrate.js` 23/23 (a made-up AionUi and uninstaller: detection, running refusal, backup byte for byte, a failing
  uninstaller, a changed database caught, the result file, the exit codes), `test-loop-tool.js` 167/167, `test-mcp-bridge.js` 81/81, and
  `tools\test-installer-migrate.js` 15/15, which builds the real installer script under its own name, registry key and data folder and
  installs it silently against made-up AionUi folders. Never run against the real AionUi: it is installed machine-wide on this PC and
  was running. The Windows prompt and the wizard page's layout are therefore not exercised.
