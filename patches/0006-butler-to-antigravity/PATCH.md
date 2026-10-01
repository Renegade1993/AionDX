# 0006-butler-to-antigravity: the interface offers Antigravity where it offered the Butler

**Built against:** AionUi 2.2.2 (renderer bundle) · **Target:** `out/renderer/assets/*.js` ·
**Status:** built into `vendor\app.asar.patched` on 2026-09-24, not installed. Installs with the
next "AionDX Apply Update".

K, September 24th: *"at least remove it from the ui's presenting it everywhere for all things,
use antigravity in it's place"*.

## What changes

Every "via chat" button in AionUi goes through one hook, `useTalkToButler`
(`upstream\packages\desktop\src\renderer\hooks\assistant\useTalkToButler.ts`): it finds the
assistant with id `aionui-assistant`, switches it back on if the user turned it off, and opens the
home page with it selected and a prompt filled in. The buttons that use it: "Ask the Butler" on
error messages in chats (`MessageTips`, `MessageAgentStatus`, `MessageToolGroup`), "Let the butler
set it up" in WebUI settings, the "... via chat" buttons in model, tools, local-agent, skills and
assistant settings and in scheduled tasks, and "Solve via chat" in the feedback form.

The patch points that hook's one constant at `bare:a9f3c21e`, the plain Antigravity entry AionUi
generates for its builtin Antigravity agent, so every one of those buttons now opens a plain
Antigravity chat with the prompt filled in, and none of them turns the Butler back on. On a
machine without `agy` that entry does not exist, and the hook's own fallback opens the home page
with the prompt and no assistant pinned.

English labels change with it: "Ask the Butler" to "Ask Antigravity", "Let the butler set it up"
to "Let Antigravity set it up", "Enabled the AionUi Butler for you" to "Enabled Antigravity for
you", the assistants empty-state hint, and the first-run onboarding's featured assistant (now
Antigravity, name and target). Other languages keep their own words.

The Butler assistant itself was switched off for K with AionUi's own call, `PATCH
/api/assistants/aionui-assistant/state {"enabled": false}`, which takes it off the home page and
out of the assistant pickers. Nothing in the patched interface switches it back on; Settings >
Assistants still lists it, where it can be switched on by hand.

## What it does not change

The Butler's skills (`aionui-config`, `aionui-troubleshooting`, `aionui-webui-public`). The first
is auto-injected into every conversation anyway; the other two are only in the Butler. An
Antigravity chat opened from "Ask Antigravity" gets the prompt and the auto-injected skills,
including the AionDX setup skill.

## Safety

`apply.js` finds each anchor by a regex that survives the bundler renaming variables, and each
must match its exact expected count across all renderer chunks (1 or 2, two English locales),
or nothing is written and the build stops. It only changes string contents. Re-running finds the
new text and changes nothing.

## Testing

`node patches\0006-butler-to-antigravity\test.js`, 13 checks against the chunks read out of
`app.asar.stock`: every edit lands; no English Butler label is left; the new labels are in; other
languages keep theirs; the onboarding entry points at Antigravity; a second run changes nothing;
a missing or doubled anchor refuses; every patched chunk parses as an ES module; `apply.js` end to
end on a throwaway tree, twice, and leaves unrelated files alone. 13/13 on 2026-09-24 (the first
run caught two anchors that appear twice, one per English locale; the counts were corrected).

Built asar checked: the hook targets `bare:a9f3c21e`, "Ask Antigravity" is in, no English Butler
label is left, the patched chunk parses, and patches 0001 and 0003 are still in.

## Revert

Roll back or revert to stock from the desktop shortcut's menu. To bring the Butler back as an
assistant: Settings > Assistants, or `PATCH /api/assistants/aionui-assistant/state
{"enabled": true}`.
