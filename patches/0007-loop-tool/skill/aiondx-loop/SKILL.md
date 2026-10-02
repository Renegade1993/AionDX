---
name: aiondx-loop
description: The AionDX Loop, the button that keeps an AionUi chat working and its prompt cache warm, shared with you. Use it to switch your Loop off when your work is finished or you are waiting on the user, to switch it on before a long list of work, to keep your cache warm through a long wait (hold), to be woken at a set time when told to hold or slow down until then (resume at), to change the message it sends you, or to compact your context. Also use it when the user mentions the Loop, as a team lead when a message must reach a teammate ahead of its queue (priority messages), when a teammate must be stopped and stay stopped (agent_stop; interrupt and shutdown do not stop one), and whenever the user asks you to use, add or fetch one of their MCP servers or its access credentials: they live in the AionDX MCP file, which no chat loads, and you reach a server for one command at a time (aiondx mcp list, tools, call). Also use it whenever the user asks you to push to their GitHub, make a GitHub repository, or anything about "my github": git on this PC is already signed in, so no token or GitHub MCP is needed (aiondx github shows the account and how to push; aiondx github create NAME makes a repository). Also use it before a long job and whenever a message says a limit was hit: it shows your Claude account's usage (aiondx usage). Also use it when you want to show the user a picture, or link a file or folder, in chat: Markdown does both, and the section on pictures says how. It is the only keep-warm mechanism: do not write a script that pokes agents.
---

# The AionDX Loop

The Loop is the round button beside the Permission shield in AionUi's message box. While a
chat's Loop is on, AionUi sends that chat its continue message each time the agent stops with
nothing queued. It never sends while the agent is working. On a team page every member has its
own Loop.

It keeps a waiting agent's prompt cache warm and never wakes a cold one. Anthropic keeps a
prompt cached for 5 minutes, refreshed each time it is read: a nudge inside that window reads the
cache at a tenth of the input price, and one after it writes the whole context again at 1.25
times. So after a short reply ("nothing to do yet") the next nudge comes 2, then 4 minutes after
your last message. After the hold (45 minutes of short replies by default, about the cost of one
reload) it rests and lets the cache expire. It never nudges an agent whose cache has already run
out; it carries on once that agent works again. It waits out provider limits, switches itself off
after 3 nudges with no reply, and goes off when the user says stop ("stop", "time to stop work",
"stand down", "good night").

The user can also set a Loop to run until they stop it (the menu's "On until I stop it", the ∞ mark
on the button). That Loop never rests, wakes a cold agent, and keeps trying through errors and
silence. It ends when the user switches it off, presses the agent's Stop button, says stop, or asks
for the Loop to be turned off. No agent can switch it off or end that mode on its own: the tool
refuses, and says so. When the user asks you, in your own chat, to turn a Loop off (yours or, as
lead, a teammate's), the same call works for 30 minutes after they asked.

You and the user control the same Loop. Every change you make shows on the button within
seconds, with a purple mark and a notice naming you and your note.

## How

If your tool list has `loop_status` and `loop_set` (the aiondx-loop MCP server), use those.
Otherwise run the program below from your shell. Both change the same Loop. In PowerShell, put
`&` before the quoted path.

```
"{{AIONDX}}" loop status
"{{AIONDX}}" loop set --off --note "map tests pass; waiting on the user's review"
"{{AIONDX}}" loop set --on --message "Work through queue.md from the top; run the tests after each item." --note "long list ahead"
"{{AIONDX}}" loop set --hold 90 --note "waiting on a 70-minute spread; need the result when it lands"
"{{AIONDX}}" loop set --resume-at 12:10 --resume-message "The new usage window is open: back to the queue." --note "user asked to slow down until 12:10"
"{{AIONDX}}" loop set --compact --note "context is heavy after the long build"
"{{AIONDX}}" loop set --member all --until-stopped --note "user: keep everyone going until I stop it"
"{{AIONDX}}" loop status --member all
"{{AIONDX}}" loop set --member Worker --off --note "tournament still running"
```

`loop status` says whether the Loop is on, its continue message, who changed it last, what it
last decided, until when your cache is warm, whether it is resting, and whether AionUi is running
it. `loop set` takes `--on` or `--off`, `--until-stopped` (only when the user asks for it;
`--until-stopped=false` ends that mode, which needs the user's request like `--off` does),
`--message` (an empty string restores the default),
`--hold` (minutes of short replies to keep the cache warm through, 0 to 240), `--resume-at`
(`12:10`, `3:30 pm`, `+45` for minutes from now, `off` to clear) with `--resume-message`,
`--compact`, `--note`, and `--member` for a teammate's name or slot id, or `all`. The tool's
`loop_set` takes the same as `until_stopped`, `resume_at` and `resume_message`.

## Resume at a set time

You have no clock between turns. Nothing tells you that 12:10 has come unless something sends you
a message then, so an agent asked to "slow down until 12:10" and left to its own judgment holds
forever: on September 26th a lead answered every nudge "Holding" and restarted only when the
user noticed the time. So when you are told to hold, wait or slow down until a time, set the
Loop's resume time to it at once, with a note. Until then the Loop's nudges say you are holding
(reply in a word), and it keeps your cache warm while that costs less than one reload, up to
about 50 minutes away, past the hold if need be. Further out it lets the cache run out. At the
time it sends one nudge ("It is 12:10, the resume time you set.") with your resume message, or
the continue message. It switches the Loop on; switching the Loop off clears it; the user sees
it on the button and can set or clear the same from the Loop menu. A lead can set a teammate's.

## Priority messages (team lead)

A team lead can send one teammate a message that goes ahead of everything queued for it, without
stopping the turn it is in: `priority_send` in your tool list, or from the shell:

```
"{{AIONDX}}" priority --member Worker --message "Stop the spread; the map seed is wrong."
```

It travels by the user's own route to that teammate, which AionUi serves before agents' messages
and team notices, and it arrives marked as a priority message from you; the user sees it in the
teammate's chat. Use it for what cannot wait behind a long queue: a stop instruction, a correction
to something actively wrong. It does not stop the teammate's current turn; `team_interrupt_agent`
does that. The reply, and `loop status`, say how many messages each teammate has waiting. Past 20,
hold back further messages: on September 25th a teammate stopped taking work at 33.

## Stopping a teammate (team lead)

When the user wants a teammate to stop, or one is running away (looping on finished work, ignoring its instructions), use
`agent_stop`, or from the shell:

```
"{{AIONDX}}" stop --member Worker --reason "looping on a closed task"
```

It pauses the member (its turn is cancelled and it takes no new work, queued or from other agents, until the user writes to
it), switches its Loop off, and restarts its agent process, which ends anything it started in the background (monitors,
background shells, scheduled wake-ups). `--keep-process` skips the restart. `team_interrupt_agent` is not a stop: it cancels the
turn and then sends the replacement message you give it, which starts the next turn. `team_shutdown_agent` is not one either:
the teammate has to agree. A Loop the user set to run until they stop it cannot be switched off by an agent, and wakes the member
again at its next nudge; the reply says so, and you tell the user.

## MCP servers and their credentials

The user's MCP servers and their access credentials live in one file, the AionDX MCP file
(`"{{AIONDX}}" mcp path` prints where: `%USERPROFILE%\.aiondx\mcp\servers.json`). No chat loads
it. When the user asks you to use a server, or to "get" their access to one, reach it for one
command at a time; the program starts or calls the server, hands its credentials straight to it,
and closes it again, so they never pass through your context:

```
"{{AIONDX}}" mcp list                                        the servers: the file and AionUi's list
"{{AIONDX}}" mcp tools example-github                        its tools and parameters (* = required)
"{{AIONDX}}" mcp tools example-github get_file_contents      one tool in full, with its input schema
"{{AIONDX}}" mcp call example-github get_file_contents --param owner=octocat --param repo=hello --param path=README.md
```

With the aiondx-loop MCP server in your tool list, `mcp_tools` and `mcp_call` do the same, and a
picture a tool returns comes back as a picture you can see. On the command line it is saved under
`%TEMP%\aiondx-mcp` and named by its path.

`--param` values follow the tool's schema: numbers, `true`/`false`, JSON for objects, `a,b,c` for
a list. Windows PowerShell 5.1 loses double quotes inside an argument, so pass JSON with
`--json-file FILE` there. `--out FILE` writes a long answer to a file. `--timeout` is in seconds
(default 120).

Adding and changing servers (`mcp_set`, or the commands below) goes to the file unless you say
`--aionui` (`where: "aionui"`): AionUi's own list feeds every new chat the servers switched ON, so
a server added there stays OFF unless the user asks for `--on`. Every add is checked by connecting.

```
"{{AIONDX}}" mcp add --name example-github --url https://example.com/mcp --header 'Authorization=Bearer ${EXAMPLE_GITHUB_TOKEN}' --description "GitHub for the user's project" --note "the user asked"
"{{AIONDX}}" mcp add --name notes --command npx --arg -y --arg some-mcp-server --env API_KEY=... --note "the user asked"
"{{AIONDX}}" mcp update --name notes --description "Team notes"      "{{AIONDX}}" mcp remove --name notes
```

Any value in the file can name a secret as `${NAME}`, kept once under `"secrets"` in the same
file. Put `${NAME}` in single quotes on a command line: bash and PowerShell both expand it inside
double quotes. For a credential needed outside MCP (a git push), `"{{AIONDX}}" mcp secret NAME` prints one,
for a shell variable only: `$env:GH_TOKEN = (& "{{AIONDX}}" mcp secret NAME)` in PowerShell,
`GH_TOKEN="$("{{AIONDX}}" mcp secret NAME)"` in bash.

Rules:
- Use a server, or read a secret, only when the user has asked for it in this chat.
- Never print a credential, write it into a file or message, or `cat` the MCP file.
- The user sees each change as a notice with your name and note; every use is logged beside the
  file (`use.log`: when, which chat, server and tool, never arguments or values).
- `mcp_status` (`"{{AIONDX}}" mcp status`) also shows the servers this chat was started with and
  AionUi's list with each server ON or OFF.

## Usage and limits

The Claude account you run on has a 5-hour and a weekly usage window. AionDX reads both from Claude's own
responses as they go past (nothing is called to get them), shows them to the user beside the account control, and
shows them to you:

```
"{{AIONDX}}" usage            your account: how much of each window is used, when each resets, any limit reached
"{{AIONDX}}" usage --all      every account AionDX has a reading for
```

(`usage_status` does the same as a tool, and `loop_status` ends with a one-line summary.) The Loop's nudges end with
the same summary. Look before a long job that would spend a lot, and when the usage is over about 70%, say so and
plan the work to fit. When a window shows LIMIT REACHED, or a message says you hit a limit, the account cannot make
requests until the reset time: do not retry or ask for a nudge before then, tell the user the time, and stop. The
Loop pauses by itself for an account at its limit and carries on at the reset.

## Pictures, files and folders in chat

The chat draws Markdown, so you can show the user a picture or link a file or folder instead of describing it.

- A picture: `![what it shows](C:/Work/Project/shots/map.png)`, or a path relative to your working folder (`./shots/map.png`).
  The file has to be inside your working folder (AionUi refuses a picture outside it with "outside the allowed sandbox"),
  so copy or save the image there first. Use forward slashes. A path with spaces goes in angle brackets,
  `![map](<C:/Work/My Maps/map.png>)`, or as a `file:///` address with `%20` for each space.
- A file or folder: `[the build folder](file:///C:/Work/Project/build/)`. It shows as a chip with the label you gave. The
  user clicks the chip to preview a file in AionUi (a folder opens in Explorer), or the arrow button beside it to open
  the file in its own program; Shift+click on the arrow shows it in its folder. Absolute paths only.
- Give the label in words the user will recognize ("the mod build"), not the path.

## The user's GitHub

"Push this to my GitHub" needs no token and no GitHub MCP server: git on this PC signs in to GitHub by
itself (Git Credential Manager), the same sign-in the user's other repositories push with. Start with:

```
"{{AIONDX}}" github            the account git is signed in as, who commits are signed as, how to push
"{{AIONDX}}" github repos      that account's repositories, the latest changed first
"{{AIONDX}}" github create NAME [--public] [--description TEXT]    a new repository, private unless --public
```

(`github_status` and `github_create_repo` do the same as tools.) Then push with plain git:
`git init` if the folder is not a repository yet, `git add -A`, `git commit -m "..."`,
`git branch -M main`, `git remote add origin https://github.com/ACCOUNT/NAME.git`,
`git push -u origin main`.

- If `github` says the commit name and email look like a placeholder, ask the user
  which name and email to sign with, and set them in the repository (`git config user.name`,
  `git config user.email`), not globally.
- Keep build output, installers, downloaded copies and anything with a key in it out of the repository
  (`.gitignore`), and look for keys before the first push.
- Make a repository public only when the user says so. `create` reads back what GitHub made and sets it
  right if it differs.

## When

- Your work is finished, or you are waiting on the user: switch your Loop off, and say why in
  the note. A Loop left on nudges you after each stop, and each nudge costs a turn. A Loop the
  user set to run until they stop it stays on: answer its nudges in a line and carry on.
- The user asks for a Loop to run until they stop it: `--until-stopped`, for the Loops they named.
- You are starting a long list of work: switch it on, and set a continue message that says
  where to pick up, so each nudge is useful.
- You are waiting on a long job whose result you need the moment it lands (a tournament, a
  build): raise the hold to cover it (`--hold 90`), so the Loop keeps your cache warm instead of
  resting. Past about 50 minutes a single reload is cheaper, so do not raise it further than the
  job needs.
- You are told to hold, pause or slow down until a time: `--resume-at` that time, straight away.
- Your context is large and the work ahead does not need the detail: `--compact`. AionUi sends
  the agent's own compact command (`/compact`, or `/compress` for Gemini CLI) the next time you
  stop. Agents with no compact command are refused.
- The user asks about the Loop: run `loop status` and report what it says.

## Rules

- Always give a note. The user sees it on the button.
- Only a team lead changes a teammate's Loop. Anyone can read one.
- Do not switch the Loop on for work that needs the user's answer first.
- If `loop status` says AionUi's Loop engine has not reported, the change is saved but nothing
  runs it yet: AionUi's window is closed, or the installed AionDX build predates the shared Loop.
  Tell the user.
