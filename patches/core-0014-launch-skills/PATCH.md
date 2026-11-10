# core-0014: a session's skills are decided again at every launch

Patch: `0001-launch-skills.patch`. Applies after core-0013, before `tools\brand-names.js`. Target: AionCore v0.2.2 (tag `v0.2.2`,
commit `47e66d0d`). Written November 9th, 2026 for R-084 (finding: `! LLM Files\2026-11-09_Project-skills-do-not-reach-agents.md`).

## Why

A conversation's `extra.skills` is a snapshot taken when it was created (`compute_initial_skills`), and its skill view (layer 1, the
`--plugin-dir` folder) was built then. An auto-inject skill added later (AionDX's `aiondx-loop`, `aiondx-config`, `aiondx-setup`) never
reached an older conversation or a long-lived team member: a team lane created in September had none of them on November 9th.

## What it does

`ConversationService::build_task_options` and `build_task_options_for_runtime` (every launch and every restart of a session) call
`refresh_launch_skills`: each current auto-inject skill the snapshot lacks is added for this launch, the conversation's skill view is rebuilt
from the full list (`sync_skill_view`), and the launch's skill list (`--add-dir` per skill, skill dirs) uses it. The stored snapshot is not
changed. A failure keeps the snapshot as it was; the session still starts. An auto-inject skill a conversation excluded when it was made
(an assistant's disabled builtin skills) comes back: AionCore does not store that exclusion after creation.

## Check

Build with `tools\build-aioncore.ps1 -Patched`. In a conversation created before an auto-inject skill existed, the backend log shows
"launch skills: auto-inject skills added since this conversation was created" at its next start, and the agent's skill list names the skill.

## Revert

Delete this folder and rebuild AionCore.
