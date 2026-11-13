# core-0018: team messages reach a busy member inside its running turn

Patch: `0001-team-midturn.patch` in this folder. Applies after core-0017. Target: AionCore v0.2.2 (tag `v0.2.2`).
Written 2026-11-13 for R-113.

## Why

A message one team member sends another (the lead to a member, a member to the lead) waits in AionCore's work coordinator
until the recipient's turn ends, then arrives as the next turn's `## New Messages`. A member that works for an hour reads
its messages an hour late. The user's own messages already reach a busy member mid-turn (core-0002's steer route); team
messages did not.

## What it changes

`TeamSession::send_agent_message_from_agent` (the path of the team `send_message` tool), after the message is written,
projected into the recipient's chat and queued as before, calls `deliver_teammate_message_midturn`:

- It hands the message to the recipient's running turn through `AgentTurnCancellationPort::steer_agent_turn` (the same
  call core-0002 uses for the user's messages: a stdin user frame for Claude, `Command::Steer` for Codex). `false` for
  "write into the chat": the projection above already put it there.
- When it is delivered, the message leaves the queue (`take_queued_message`) and is marked read, so the next turn does
  not read it again.
- When the recipient has no running turn, cannot take a message mid-turn, or is waiting on a permission card, the port
  answers `NotAvailable` and the message stays queued exactly as before. Errors are logged and change nothing.
- Nothing is stopped or cancelled.

The text the agent reads (`midturn_teammate_text`) keeps the wake payload's form, `## New Messages` and
`- From \`slot\` (name) [message]: ...`, and says it arrived while the agent was working and nothing was stopped.

## Files

| File | What |
|---|---|
| `aionui-team/src/session.rs` | `deliver_teammate_message_midturn`, `midturn_teammate_text`, the call in `send_agent_message_from_agent`. |

## Not built yet

Written November 13th; held for the next AionCore build at the user's word (more core changes may come first).
