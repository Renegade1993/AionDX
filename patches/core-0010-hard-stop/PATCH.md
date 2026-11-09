# core-0010: Stop is a hard stop, scheduled tasks wait for the user

Patch: `0001-hard-stop.patch` in this folder. Applies after core-0001 to core-0009.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written October 31st, 2026.

## The problem

Reported October 31st, 2026 from a PC running 0.25.11: agents start for no reason, Stop does nothing, queued messages reach the agent minutes late, and an agent reads the user's message only after it has answered an older one.

Found in the code:

- A scheduled task is started by the conversation service, not by a team run. AionUi's Stop for a team member asks the team to pause the member in the active run, and `pause_slot_work` answered "team run X is not active" when there was none (every turn a scheduled task or a retry started). Nothing was cancelled.
- After a restart AionCore ran every overdue scheduled task at once, and ran again any occurrence it had not finished, however old. An agent that had made itself schedules fired three times.
- The text sent with a scheduled task told the agent to obey it and not to ask questions, so the agent read it as an order from the user, over whatever the user had just said.
- The wake text for a team member ended with "Proceed with your work."
- A message the user wrote while a member was busy waited in the queue until the member's turn ended.

## The fix

| File | Change |
|---|---|
| `aionui-conversation/src/runtime_state.rs` | A set of conversations the user pressed Stop in: `mark_user_stopped`, `clear_user_stopped`, `is_user_stopped`; cleared with the conversation. 1 unit test. |
| `aionui-conversation/src/service.rs` | A user-requested cancel marks the conversation stopped; sending the conversation a message clears it. |
| `aionui-team/src/ports.rs`, `aionui-app/src/router/team_conversation_adapters.rs` | `user_wrote`, so a message to a team member clears the mark. |
| `aionui-team/src/session.rs` | `pause_slot_work` no longer needs an active team run. `deliver_user_message`: a message to a busy member goes to the front of the queue and into the running turn when the backend takes mid-turn messages (the path of the lightning bolt). Slash commands stay in order. |
| `aionui-cron/src/executor.rs` | A scheduled run does not start in a conversation the user stopped; it is skipped. |
| `aionui-cron/src/service.rs` | At startup a job overdue by more than 2 minutes is recorded as missed and moved to its next time, not run; an unfinished occurrence older than 10 minutes is marked missed, not run again. |
| `aionui-cron/src/prompt.rs` and its test | The task text says the user did not send it and outranks it: if the user has told the agent to stop or is waiting for an answer, the agent answers the user first. |
| `aionui-team/src/prompts/mod.rs` | "Proceed with your work." removed from the wake text. |

Added October 31st, after the first build (the cause of "agents start for no reason", found in the log: 9 seconds after a Stop, `session-pump: content after settled terminal, CLI-initiated turn begins`):

| File | Change |
|---|---|
| `aionui-conversation/src/background_stream.rs`, `service.rs` | A turn the agent's own process starts (a background task or monitor finishing) after the user pressed Stop and before the user writes again is cancelled and not shown. At most one cancel every 3 seconds. |
| `aionui-team/src/session.rs` | A Stop marks the messages the stopped turn opened with as read, so the next turn does not open with them again as new. A message sent to a busy member is handed to the running turn when the backend takes mid-turn messages (`hand_queued_message_to_running_turn`); queue order is not changed. |
| `aionui-team/src/service.rs`, `work_coordinator/coordinator.rs` | Opening a team (the page asks for its session on every visit) starts no agent: the recovery scan no longer runs on open, and the coordinator makes no recovery work from unread rows until the user has sent the session a message (`user_has_written`). Then the lead reads all of them with that message. |
| `aionui-team/tests/session_service_integration.rs` | The recovery-on-open test now asserts no turn runs on open. |

Not in this patch: a per-job "catch up missed runs" choice (missed runs are skipped), and a marker in the chat for what started a turn.

## 0002-pause-test.patch (2026-11-08, test only)

AionCore's `team_e2e.rs` test `pause_team_slot_endpoint_requires_owned_team_and_active_run` still expected the old `400`
for a pause with no active run, which this patch removed on purpose, so it failed on every AionDX build. It is now
`pause_team_slot_endpoint_works_without_an_active_run_on_an_owned_team`: `200` without an active run, and `404` for a
team the caller doesn't own. No product code changes. Found by the Bridge/API Engineer's baseline comparison against
v0.2.2.
