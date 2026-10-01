# 0005-claude-exe-shim: Claude agents get all their launch arguments

**Target:** the Claude launch chain outside the asar (`%APPDATA%\npm\claude.exe`, new) ·
**Status:** installed 2026-09-24 11:49, takes effect at each Claude agent's next launch; no AionUi
restart needed. Built against AionUi 2.2.2 / AionCore 0.2.2.

K, September 24th: *"for some reason i have to manually bash allow agents, we need to remove that
requirement in yolo mode"*.

## The bug

aioncore launches Claude by resolving the bare name `claude` on PATH
(`aionui-ai-agent\src\session_agent.rs` 2158-2180). On this machine that found the npm shim
`%APPDATA%\npm\claude.cmd`, which only cmd.exe can run, so aioncore ran
`cmd /d /c ...\npm\claude.cmd <args>`. AionUi's `--append-system-prompt` is several lines long,
and cmd.exe ends a command at a line break, so every Claude agent lost every argument after the
first line of that prompt:

- `--permission-mode bypassPermissions` and `--allow-dangerously-skip-permissions`: YOLO never
  applied. The main account's `settings.json` default (`bypassPermissions`) masked it most of
  the time; the second account has no default, so its agents asked before every Bash command.
- the rest of the appended system prompt: AionUi's assistant and team instructions.
- `--plugin-dir`: the conversation's skills.
- `--mcp-config`: every MCP server, the team tools among them.

Proof from the live machine is in `! LLM Files\Research\2026-09-24_claude-args-lost-through-cmd.md`.

## The fix

`claude.exe`, a 7.5 KB console program built from `claude-shim.cs` with the .NET Framework
compiler every Windows 11 has, placed beside `claude.cmd`. Windows and aioncore's resolver
(`which`, in `PATHEXT` order) take `.EXE` before `.CMD` in the same folder. The shim takes its own
command line, drops the program name, and starts `node claude-account-router.js` with the rest
exactly as received, through `CreateProcessW`, so line breaks survive. Stdin, stdout and stderr
are passed through as inherited handles (Claude's stream-json runs over them), the environment is
inherited (the router routes by `AIONUI_CONVERSATION_ID`), and the router's exit code is returned.
With no console window of its own (AionUi starts agents hidden) it starts the child with
`CREATE_NO_WINDOW`; in a terminal it shares the terminal.

The router is kept on purpose. It routes each conversation to the right Claude account (HOME,
USERPROFILE and the OAuth token per agent) and picks the newest Claude build; pointing agents at
`claude.exe` directly would skip both. It launches Claude with `spawnSync` and no shell, so the
arguments survive that step already.

If the router or node is missing, the shim runs the native build in the real profile's
`.local\bin` (the real profile comes from `APPDATA`, because the second agent's HOME and
USERPROFILE point at a sandbox), then the npm package's `claude.exe`, like `claude.cmd` does.

## Testing

`node patches\0005-claude-exe-shim\test-shim.js`, 10 checks. It compiles the shim beside a fake
router and launches it the way aioncore does (an argument list, no shell, hidden, piped stdio):

- every argument arrives intact and in order, including a four-line prompt, quotes, a trailing
  backslash, an empty string and double spaces;
- `--permission-mode`, `--mcp-config` and `--plugin-dir` survive after the multi-line prompt;
- stdin reaches the router, its stdout and stderr come back, its exit code is the shim's;
- the environment is inherited;
- control: the same arguments through `cmd.exe` and a `.cmd` lose everything after the line break.

Installed copy checked by hand: `%APPDATA%\npm\claude.exe --version` went through the real router
(`claude-account-router.log`: `conv=dd44ee55 agent=cc33dd44 -> main (Plan A) [cli 2.1.281
native]`) and printed `2.1.281 (Claude Code)`.

End to end on the real chain, 2026-09-24 12:00: Node started the installed shim the way aioncore
does (argument list, no shell, hidden) with a two-line `--append-system-prompt`,
`--permission-mode bypassPermissions`, `--allow-dangerously-skip-permissions` and a prompt. The
real Claude process's command line, read while it ran, held all three: the mode, the flag and the
prompt's second line. Claude answered "OK", exit 0.

## Verify on the live app

After any Claude agent's next launch, its router process's command line should carry
`--permission-mode` and `--mcp-config`, and its parent should be `claude.exe`, not `cmd.exe`:

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'claude-account-router' |
      ForEach-Object { $_.ProcessId, ($_.CommandLine -match '--permission-mode'), (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)").Name }

## Revert

Delete `%APPDATA%\npm\claude.exe`. The lookup falls back to `claude.cmd`, and the bug returns.

## Rebuild

    C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /target:exe /out:claude.exe claude-shim.cs

## September 26th, 2026

Node is looked for in this order: a `runtime` folder beside the shim's, Program Files\nodejs, the Node
AionUi itself unpacks (`%APPDATA%\AionUi\aionui\runtime\node\node-v*`), the copy under Program
Files\AionUi, then PATH, so a PC with no Node of its own runs the router on AionUi's Node 24. With no
router, Claude Code is looked for in the npm global folder and on PATH too (skipping folders with a
router). Rebuilt; 10/10.

Later the same day, after review: the router needs Node 22.13 or later (`node:sqlite` without a flag;
23.x from 23.4.0), and without it moving a chat to another agent and Unsend stop working. The shim now
reads each candidate's version from node.exe's version resource (nothing is started) and takes the first
new enough one; when none is, the first one found, so Claude still starts. The standalone app's own copy
joins the list before Program Files\AionUi's
(`%LOCALAPPDATA%\Programs\AionDX\resources\bundled-aioncore\win32-x64\managed-resources\node\node-v*`),
and `node-v*` folders are compared by number (v24.11.0 above v24.9.0). Tests 15/15: four new cases with
stand-in node.exe builds of 20.18, 24.9 and 24.11. Windows resets ProgramFiles when a 64-bit process
starts, so those cases run a copy of the shim built to read `SHIM_TEST_PROGRAMFILES` in that one place.
Installed as `%APPDATA%\npm\claude.exe` at 12:26; the September 24th build is kept as
`claude.exe.bak-20260926`.
