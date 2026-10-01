---
name: aiondx-setup
description: >-
  Import a user's setup from their other AI tools (Claude Code, Codex, Gemini CLI, Cursor,
  Windsurf, Devin and more): global instructions, custom agents, commands and skills, MCP
  servers, and what those tools left elsewhere on the machine. Two commands do the work:
  aiondx setup scan, then aiondx setup apply. Use only when the user asks to import, harvest
  or migrate from their other tools (the AionDX Welcome screen's brief counts); never on your own.
---

# AionDX setup: bring the user's other AI tools into AionDX

AionDX is a free edition of AionUi that drives many AI agents from one app. This skill brings what a
user already built in other tools into AionDX, so every agent they run here starts from their best
instructions and their own tools. The Welcome screen's Import button does the same with two clicks;
you are the other way in, for a user who asked an agent to do it.

## Rule zero: only when asked

Run this only after the user asks for it in so many words ("import my settings", "set AionDX up
from Claude Code"), or sends the Welcome screen's setup brief. If they only mention other tools,
you may offer once: "I can bring your instructions and tools over from X. Want me to?" Then wait.

## Do the work yourself

Run every command and write every file yourself, in the chat. Never hand the user a script or a
command to run, and never ask them to open a terminal: the whole point is that they do not have
to. If a step fails, read the error, fix what you can and run it again; if you cannot, say
plainly what failed. Only the two decisions below are theirs: what to bring over, and yes.

## Safety rules

1. Look, then ask, then write. `aiondx setup scan` only lists paths, sizes and dates. Nothing is
   copied, merged or written until the user has seen what was found and said yes.
2. Copy, never move, never delete. Every original stays where it is. An agent's own instructions
   file gets one marked block added, and is backed up first.
3. No secrets, ever. Do not open or copy API keys, tokens, passwords, `.env` files, `auth` or
   `credentials` files, keychains, or the `env` blocks of MCP and settings files. The commands
   below keep to this themselves: key-like strings are left out of copies, and an MCP server
   that needs a key gets a `${NAME}` placeholder, filled from the user's environment variable of
   that name when there is one.
4. Stay inside the catalog: the locations in `references/catalog.json`, never whole drives, and
   never anything in the user's exclusions file, `~/.aiondx/exclusions.txt` (one path per line).
   If that file does not exist, ask once whether any folders are off limits, and write their
   answer into it before the scan.
5. Say what changed, and how to undo it: the summary `apply` prints, and the report it names.

## The two commands

`aiondx` is on PATH in every AionDX chat. From outside AionDX, use its full path,
`"%LOCALAPPDATA%\AionDX\bin\aiondx.exe"`. Neither command needs Node.js.

```
aiondx setup scan
aiondx setup apply --all [--skip KIND]... [--prefs "the user's own instructions, one line"]
aiondx setup apply --plan FILE
```

`scan` prints what each app has: its instructions file, folders of custom agents, commands,
skills, prompts and rules, and its MCP servers with the key names they need. It also writes the
full inventory, which `apply` reads.

`apply --all` brings over everything the scan found, less each `--skip KIND` (agents, commands,
prompts, skills, rules, instructions, mcp, wire; `wire` leaves the agents' own files alone). For
choices item by item, write a plan file and pass `--plan`:

```json
{ "prefs": "Answer briefly.",
  "items": ["C:\\Users\\me\\.claude\\CLAUDE.md", "C:\\Users\\me\\.claude\\agents"],
  "mcp": [{ "file": "C:\\Users\\me\\.claude.json", "name": "github" }],
  "wire": ["claude-code", "codex", "antigravity", "gemini-cli", "qwen-code", "opencode"] }
```

`items` and `mcp` take paths and server names exactly as the scan printed them; anything the scan
did not find is refused. What `apply` does:

- copies each chosen file or folder under `~/.aiondx/harvest/<date>/<tool>/`, leaving out
  secret-looking files, `node_modules`, `.git` and the like, and places custom agents, commands,
  skills, prompts and rules under `~/.aiondx/<kind>/` (same name, different content: the newer
  keeps the name, the other is kept beside it);
- writes `~/.aiondx/AIONDX.md`: the user's own instructions first, then each app's instructions
  file whole under its own heading, newest first, exact duplicates dropped;
- writes that into each chosen agent's own instructions file between
  `<!-- AionDX instructions: begin -->` and `<!-- AionDX instructions: end -->`, without the part
  that came from that same file, after backing the file up;
- adds the chosen MCP servers to the AionDX MCP file (`~/.aiondx/mcp/servers.json`), which no
  chat loads; an agent uses a server from it when the user asks (the aiondx-loop skill);
- writes `~/.aiondx/harvest/<date>/report.md`, with how to undo each change, and prints a summary.

| agent | its own instructions file |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` (`CLAUDE_CONFIG_DIR` moves it) |
| Codex | `~/.codex/AGENTS.md` (`AGENTS.override.md` if it exists; `CODEX_HOME` moves the folder) |
| Antigravity | `~/.gemini/config/AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| Qwen Code | `~/.qwen/QWEN.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |

## Procedure

1. Scope. The Welcome brief says what to bring over and the user's own instructions; otherwise
   ask which apps and which kinds (default: everything found). Check `exclusions.txt` (rule 4).
2. Run `aiondx setup scan`. Show what it found as a short list per app, the newest instructions
   file marked. Wait for a yes, and note anything they want left out.
3. Run `aiondx setup apply` with their choices: `--all` with a `--skip` for each kind left out, or
   `--plan` for single items, and `--prefs` for their own instructions.
4. Show the summary it printed, in a few lines: what came over, which agents now read the
   instructions, the MCP servers added and any keys still needed (with where to put them), and
   the report's path.
5. Only if they asked about sign-ins: for each agent CLI installed, say whether it is signed in by
   whether its file exists, never by opening it: `~/.claude/.credentials.json` (Claude Code),
   `~/.codex/auth.json` (Codex), `~/.gemini/oauth_creds.json` (Gemini CLI and Antigravity). AionDX
   runs each agent on the sign-in its own CLI already has. One not signed in: say so, and that its
   own first chat in AionDX signs it in.
6. Only if they ask: tidy `AIONDX.md` (merge sections the apps repeat, one heading per topic),
   showing them the result before you save it. Keep a copy of the version before.
7. Bread crumbs, only if they ask: what `scan` lists under bread crumbs (scheduled tasks, startup
   entries, PATH folders, global packages), what each is and which tool left it. Change nothing
   outside `~/.aiondx/` without a yes to that exact change.
