# core-0021-skills-every-agent: the same skills for every agent type (R-128 step 2, November 15th, 2026)

A Claude chat gets the user's personal skills (`~\.claude\skills`), the shared skill folders named by `skillRoots` in
`<data>\aiondx-projects.json`, and its bound project's `.claude\skills` (AionDX's Claude launcher adds them with `--add-dir`). Codex,
Gemini CLI, Antigravity and the other agents read none of those; they read `.agents\skills` in the folder they start in, which for an
AionDX chat is its conversation folder (measured from source: `! LLM Files\2026-11-15_skills-delivery-per-agent.md`).

At every launch (`refresh_launch_skills`, the place core-0014 already uses) of an ACP chat whose backend is not Claude or CodeBuddy, and
of an Antigravity chat, the layers are mirrored into `<working folder>\.agents\skills` (`aionui-conversation/src/skill_layers.rs`):

- Layers, lowest first: personal, each shared root in the registry's order, the bound project (a `conv:` binding, then the team's
  `team:` binding). A skill of the same name in a nearer layer wins.
- Each skill folder (one holding SKILL.md) copied file by file where the copy is missing, older or a different size; `node_modules`,
  `.git`, `__pycache__` and virtual environments are skipped.
- A mirrored skill carries `.aiondx-mirror` (its source path); only those are updated or removed when their source is gone. A skill the
  user or the agent put in `.agents\skills` by hand is left alone.
- Any trouble is logged ("skill layers could not be mirrored") and the launch goes on.

Not covered: matching a team member to a project by its team's name (the Claude launcher does; here only bindings count, since the launch
options carry the team's id, not its name).

Files: `aionui-conversation/src/skill_layers.rs` (new, with 3 tests), `lib.rs`, `service.rs`. Work on it: `.tmp\core-base21.ps1`, then
`git add -N crates/aionui-conversation/src/skill_layers.rs` and `git diff HEAD --output=patches\core-0021-skills-every-agent\0001-skills-every-agent.patch`.
