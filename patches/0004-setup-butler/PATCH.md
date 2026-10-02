# 0004-setup-butler: the Butler as AionDX's setup agent

**Target:** AionUi's builtin Butler assistant and every conversation, through AionUi's own
assistant and skill system (no asar change, no backend change) · **Status:** 2026-09-24: the
Butler now runs on Gemini CLI on K's machine (waiting on one Google sign-in); the skill installs
into `builtin-skills\auto-inject` with `install.js`, which the updater runs after every swap.

## How it is attached (decided 2026-09-24)

- The Butler runs on Antigravity, Google's free individual tier ($0/month per
  antigravity.google/pricing). Gemini CLI was tried first: K's cached Google login refreshed fine,
  but Google's server refused the free tier itself (`IneligibleTierError ... This client is no
  longer supported for Gemini Code Assist for individuals ... migrate to the Antigravity suite`).
  Details: `! LLM Files\Research\2026-09-24_gemini-cli-free-tier-ended.md` and
  `...\2026-09-24_antigravity-free-tier-and-cli.md`. Gemini CLI was uninstalled again the same day:
  installed, it showed in the new-chat menu as "Needs Sign-in", which signing in cannot fix.
- `agy` 1.2.10 installed with Google's installer (`%LOCALAPPDATA%\agy\bin`, added to the user
  PATH). AionUi's builtin Antigravity agent (`a9f3c21e`) got a per-user command override to the
  full path, so it works before AionUi's next restart picks up the new PATH; health check: online.
- The Butler's agent is switched per user with the supported call, `PUT
  /api/assistants/aionui-assistant {"agent_id":"antigravity"}` (one row in `assistant_overlays`,
  survives updates). It had been bound to "Aion CLI" (`632f31d2`) with no LLM provider configured,
  so it could not answer anything. Undo: the same call with `{"agent_id":"632f31d2"}`.
- The one step left: the Butler's first message starts `agy` signed out, and `agy` opens a Google
  sign-in page in the browser and waits 60 s. One click on the account finishes it, and the
  keyring keeps it. Pinokio's Gemini launcher needed the same consent in June. No free Google
  path skips it.
- The skill goes to `%APPDATA%\AionUi\aionui\builtin-skills\auto-inject\aiondx-setup\`. Every
  auto-inject skill is offered to every conversation, on every backend, as a one-line index entry
  the agent opens when needed (the backend injects the index, not the content), so the Butler and
  any other agent can run the setup when the user asks. aioncore rewrites `builtin-skills` only
  when its version changes (`.version` = `0.2.2+builtin-skills.3512a13e...`), so the folder stays
  until an update, and the updater puts it back after every swap.
- Rejected: the `AIONUI_BUILTIN_ASSISTANTS_PATH` / `AIONUI_BUILTIN_SKILLS_PATH` overrides. They
  swap the whole builtin tree, shadow every upstream builtin change silently, and are marked in
  the source as test and E2E hooks.
- For a new install (no per-user choice yet), the one-time setup screen (P-009) makes the same
  Butler call; until then a fresh AionDX install's Butler stays on AionUi's default.

K, September 24th:

- *"Yes, Gemini CLI, that would be great for managing setup, and honestly i don't why the butler
  isn't automatically hooked up to use it. Getting an external app to channel a agent to set it up
  externally before you use it is a pain in the rear."*
- *"We should make sure that that initial agent has plenty of instructions regarding setup, and
  directories or registries to check for existing installs so it can harvest and assemble a latest
  and greatest version of all of their global instructions and custom files into AionDX's global
  folder, and to hook up anything that other agents from those previous ui's or desktop apps hooked
  up that landed outside those folders (or what i refere to as bread crumbs."*
- *"the harvest should only be done if a user wants it done, but the butler should be primed with
  the information it needs to act on if the user requests"*

## What it adds

A skill, `skill\aiondx-setup\`, in the Agent Skills format AionUi's own Butler skills use
(`SKILL.md` with `name` and `description` front matter):

| file | what it is |
|---|---|
| `SKILL.md` | the playbook: rule zero (only when the user asks), the safety rules, the AionDX global folder, and an eight-step procedure (scope, survey, show, copy, assemble, hook up, check, report) |
| `scripts\survey.js` | the read-only inventory, run by the agent; the no-secrets, stay-in-the-catalog and exclusion rules live here in code, so they hold whichever model runs the skill |
| `references\catalog.json` | where each AI tool keeps instructions, custom files and MCP servers. Starter version with five tools; the sourced catalog from the research pass replaces it |

The AionDX global folder is `~\.aiondx\` (`%USERPROFILE%\.aiondx\`): `AIONDX.md` (the assembled
global instructions), `agents\`, `commands\`, `skills\`, `prompts\`, `rules\`, `mcp\servers.json`,
`breadcrumbs.md`, `exclusions.txt` (paths never read, kept by the user), and
`harvest\<date>\` (the raw copies, the survey and the report, never deleted by the skill).

## The survey's promises, in code

- Records paths, types, sizes, dates and folder entry names only.
- MCP configs are the one file type it reads: server names, commands, args and URLs, with env and
  header values dropped (their names are kept) and key-like URL parameters hidden. JSON and Codex
  TOML are parsed; a TOML sub-table like `[mcp_servers.x.env]` is skipped.
- Secret-looking files (`.env`, `auth*.json`, `credentials*`, `*token*.json`, keys, keychains,
  `oauth*.json`) are listed by name and never opened. Environment variables are reported by name.
- Anything under a path in `~\.aiondx\exclusions.txt` is reported as excluded and not looked at.
- Bread crumbs on Windows: non-Microsoft scheduled tasks, HKCU Run entries, the Startup folder,
  PATH entries inside the profile and the agent CLIs in them, global npm AI packages, VS Code AI
  extensions, and script registries such as `~\.agents\SCRIPT-REGISTRY.md`.
- 90 s deadline; child processes have timeouts and no windows.

## Testing

`node patches\0004-setup-butler\test-survey.js`, 18 checks against a fake home folder planted
with six secrets (an API key in a settings env block, an MCP env value, an MCP header, a token in an
MCP URL, a credentials file, a Codex TOML env value) and an excluded folder:

- NO SECRETS: none of the six values appears anywhere in the output or the written JSON.
- EXCLUSIONS: the excluded folder is reported as excluded and not read.
- READ-ONLY: the fake home is byte-identical afterwards.
- Plus: MCP servers keep name, command and args; env and header names survive without values;
  Codex TOML parses; folders list their entries; the script registry is found.

18/18 on 2026-09-24, after fixing a TOML parser bug the first run caught (it took the env
sub-table for a second server; no value leaked, but the list was wrong).

`node patches\0004-setup-butler\test-install.js`, 10 checks, against a throwaway data folder:
refuses without a `builtin-skills` folder; `--check` reports missing, current and stale; install
copies the whole skill and stamps it; a second run changes nothing; an edited copy is refreshed;
other skills, `.version` and staging leftovers are untouched; `--remove` takes out only this
skill. 10/10 on 2026-09-24. Installed for real the same day (`8b6baf46...`).

## Still to do

1. Done 2026-09-24: `references\catalog.json` now holds 28 tools and 94 user-level locations,
   built from the filed research (`! LLM Files\Research\2026-09-24_ai-tool-locations-catalog*.md`)
   by a subagent. Rows the research could not confirm carry `"unconfirmed": true`; OpenCode's
   Windows folder, on which the sources disagree, is listed both ways; no credentials file is a
   location. On this machine the survey finds 8 of the 28: Claude Code, Claude Desktop, Gemini
   CLI, Cursor, Windsurf, Devin, Zed and AionUi. Installed copy refreshed (`b2d31392...`).
2. The distribution step: how `AIONDX.md` reaches every agent AionDX runs (directive 1), either
   injected by AionUi into every conversation or written into each CLI's own global file.
3. The P-009 setup screen, which runs the Butler call for a new install and offers the Gemini
   sign-in.

## September 26th, 2026

The skill's steps: 6 gives each installed agent the instructions, with the global file each CLI reads
(Antigravity: `~/.gemini/config/AGENTS.md`; a second Claude account: `CLAUDE.md` in its own config
folder); 7 is new, accounts, only when the user ticks it on the Welcome screen: which CLIs are signed
in (by file presence, never opened), the sign-in command for the rest, and a second account as a
second agent with its own config folder. Hook up, Check and Report are 8, 9 and 10.

## September 26th, 2026 (evening): the one-click setup

a request; then "One click setup as you described, with the
backup of antigravity....which needs clearer instructions".

- `scripts/apply.js`, new: the import, deterministic, beside `survey.js`. It takes the survey and a plan (or `--all`
  with `--skip KIND` and `--prefs`), refuses anything the survey did not find, copies into
  `~/.aiondx/harvest/<date>/<tool>/` without secret-looking files, dependency or version-control folders, and with
  key-like strings taken out of text; places custom agents, commands, skills, prompts and rules under
  `~/.aiondx/<kind>/`; writes `AIONDX.md` (the user's own instructions, then each app's file whole under its own
  heading, newest first, duplicates dropped, keys removed); writes that into each chosen agent's own file between
  the AionDX markers, without the part from that same file, after a backup; puts MCP servers into the AionDX MCP file
  (the Loop tool's format) with `${NAME}` placeholders for every env and header value, named as the user's own
  environment variables so those fill them; writes `report.md` with how to undo each change. `--text` prints a
  summary for a person. Idempotent: a second run replaces its block and finds its servers already there.
- The same scripts behind three doors: the Welcome screen's Import (the main process runs them as Node on
  Electron itself, patch 0009), `aiondx setup scan|apply` for an agent (patch 0007 1.7.0, Node.js or the app's own
  Electron), and `node scripts/...` by hand.
- `SKILL.md` rewritten around the two commands, with "Do the work yourself": never a script or a command handed to
  the user, never "open a terminal".
- Tests: `test-apply.js` 22/22 (a made-up home with Claude Code, Codex, Antigravity, keys in instructions and in
  JSON and TOML MCP configs, a skill with node_modules and a .env), `test-setup-cli.js` 8/8 (both commands, and
  both again with no Node.js, on AionUi.exe as Node), `test-survey.js` 18/18, `test-install.js` 10/10.
