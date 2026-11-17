# core-0022: a chat's skill view holds files, so a guarded agent can read its skills (November 16th, 2026)

Patch: `0001-skill-view-files.patch` (`aionui-extension/src/skill_view.rs`). Applies after core-0021, before `tools\brand-names.js`.
Target: AionCore v0.2.2. Work on it: `.tmp\core-base22.ps1`, then `git diff HEAD --output=patches\core-0022-skill-view-files\0001-skill-view-files.patch -- crates/aionui-extension/src/skill_view.rs`.

## Why

AionCore gives each chat a skill view, `<data>\aionui\session-skills\<user>\<chat>\`, which Claude reads as a plugin (`--plugin-dir`)
and Codex as a skills root. Upstream builds it from one NTFS junction per skill. A process under Windows' RedirectionGuard
(ProcessRedirectionTrustPolicy) cannot follow a junction an ordinary user made: the read fails as if the file were not there.

- An AionDX started by Inno Setup's "Start AionDX now" (or an in-app update) up to 0.28.2 carried the guard, and so did every agent it
  started (fixed in the installer by `RedirectionGuard=no`, commit d161794). Measured on the development PC: AionDX, AionCore, every
  agent and every shell they run had the guard enforced; 1,556 junctions in 237 chat views, 0 readable. No chat had AionDX's own skills
  (`aiondx-loop`, `aiondx-setup`, `aiondx-config`) or AionCore's (`cron`, `officecli` and the rest), though the backend log said
  "launch skills: ... added=2 linked=8" (core-0014 did its part; the links it made could not be read).
- From 0.28.3 AionDX starts the agent of a chat that asks before acting under the guard on purpose (patch 0002, `aiondx-guard.exe`), so
  those chats would lose every view skill even in an app started normally.

Found because an agent did not know `aiondx context` existed (the `aiondx-loop` skill documents it) and told the user it could not read
its context size.

## What it does

On Windows, each skill in the view is a real folder whose files are hard links to the source's (the same bytes; a hard link is not a
redirection, so the guard allows it), or copies with the source's modified time where a hard link is not possible (another drive).
`node_modules`, `.git`, `__pycache__` and virtual environments are left out. A view whose names already match is still rebuilt when any
skill's files differ from its source (a file added, removed, or replaced, as an installer replaces a SKILL.md), and an earlier junction
view is replaced. Removing a view removes only its own links and copies. Other systems keep upstream's symbolic links.

## Check

`cargo test -p aionui-extension --lib skill_view`: 16, three new (the view holds no junction and is readable; a replaced, added or
removed source file refreshes it; an earlier junction view is replaced by files). `node patches\0002-claude-model-currency\test-guard.js`
(9): under `aiondx-guard.exe` a skill read through a junction fails and the same skill as hard-linked files is read. After a build, a
chat's view has no reparse point (`fsutil reparsepoint query` on a skill folder says it is not one) and the agent's skill list names
`aionui:aiondx-loop`.

## Revert

Delete this folder and rebuild AionCore.
