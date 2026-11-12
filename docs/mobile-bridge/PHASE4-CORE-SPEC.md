# Phase 4 core: change journal and approvals tracker (spec for a parallel implementer)

Written 2026-11-07 by the Bridge/API Engineer for the Voice Core Engineer.

**What you build:** two **pure, self-contained modules** in the `aionui-mobile` crate, with unit tests:
- `journal.rs`: the change journal behind `GET /v1/changes`;
- `approvals.rs`: the approvals tracker and per-backend answer mapping behind `/v1/approvals`.

**What you don't do:** no axum, no AionCore services, no event bus. I wire them to the event bus, the facade routes
and AionCore's confirm/ask calls in phase 4 integration.

The contract is `docs/mobile-bridge/CONTRACT.md` (rev 4.3). §6.2 is the change feed and §6.5 is approvals. The
JSON shapes there are normative; this spec only fixes the Rust interfaces and the rules.

## Where to work

The AionCore source lives in `AionDX-impl\upstream-aioncore` (a full clone).

- **Start from:** my dev branch `aiondx-dev` at commit `32e2cc34` (core-0001..0015 phase 1).
- **Create your own worktree:**
  ```
  git -C "<AionDX-impl>\upstream-aioncore" worktree add -b phase4-core "<AionDX-impl>\work-phase4" 32e2cc34
  ```
  Use the short folder name `work-phase4` next to `work-core`; the path is already deep.
- **Commit identity:** use `git -c user.name=... -c user.email=...`, because the clone has no identity configured.
- **Files:** add `crates/aionui-mobile/src/journal.rs` and `crates/aionui-mobile/src/approvals.rs`, then
  `pub mod journal; pub mod approvals;` in `lib.rs`. Touch nothing else. If you need a dependency, ask me first; the
  crate already has `serde`, `serde_json`, `tokio` (with sync) and `base64`.
- **Tests:**
  ```
  CARGO_TARGET_DIR=%LOCALAPPDATA%\aiondx-build\dev-target-p4 %USERPROFILE%\.cargo\bin\cargo.exe test -p aionui-mobile
  ```
  - Your **own** target dir, so you don't block my builds.
  - Cargo by its full path, because Rust is deliberately not on PATH.
  - The short target dir avoids the MAX_PATH / LNK1104 failure in this deep checkout.
- **Format:** `%USERPROFILE%\.cargo\bin\rustfmt.exe --edition 2024 <your files>`.
- **Hand-off:** commit on `phase4-core` and message me the commit hash. I cherry-pick it onto `aiondx-dev`.

## 1. `journal.rs`: the change journal (CONTRACT §6.2)

```rust
/// One change, exactly the JSON of CONTRACT §6.2 `ChangeEntry` (tag "kind", camelCase fields).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeEntry {
    Team { #[serde(rename = "teamId")] team_id: String, what: Vec<TeamWhat> },
    TeamRemoved { #[serde(rename = "teamId")] team_id: String },
    Conversation {
        #[serde(rename = "conversationId")] conversation_id: String,
        #[serde(rename = "teamId", skip_serializing_if = "Option::is_none")] team_id: Option<String>,
        #[serde(rename = "slotId", skip_serializing_if = "Option::is_none")] slot_id: Option<String>,
        what: Vec<ConversationWhat>,
    },
    ConversationRemoved { #[serde(rename = "conversationId")] conversation_id: String },
    ApprovalAdded { approval: serde_json::Value },            // the full Approval object (§6.5)
    ApprovalRemoved {
        #[serde(rename = "approvalId")] approval_id: String,
        #[serde(rename = "conversationId")] conversation_id: String,
        #[serde(rename = "teamId", skip_serializing_if = "Option::is_none")] team_id: Option<String>,
        resolution: Resolution,                                 // "answered" | "cancelled"
    },
    Task { #[serde(rename = "teamId")] team_id: String, task: serde_json::Value, change: TaskChange }, // "created" | "updated"
    Broadcast { #[serde(rename = "teamId")] team_id: String, #[serde(rename = "broadcastId")] broadcast_id: String },
}
// TeamWhat: roster | run_state | meta. ConversationWhat: messages | state | meta | read. All snake_case.

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChangesPage {
    pub token: String,          // "<epoch>.<rev>"
    pub reset: bool,
    pub more: bool,
    pub changes: Vec<ChangeEntry>,
}

pub struct ChangeJournal { /* private */ }

impl ChangeJournal {
    /// `max_entries` = 50_000 and `max_age_ms` = 24 h in production; small values in tests.
    pub fn new(max_entries: usize, max_age_ms: i64) -> Self;
    /// Random per process (b64u of 6 random bytes is fine); a restart means a new epoch.
    pub fn epoch(&self) -> &str;
    /// Records a change for one Core user.
    pub fn record(&self, user_id: &str, entry: ChangeEntry, now_ms: i64);
    /// Non-blocking read.
    pub fn since(&self, user_id: &str, token: Option<&str>, limit: usize, now_ms: i64) -> ChangesPage;
    /// Long-poll: returns at once if `since` would return changes, or if `token` is None; otherwise waits
    /// until something is recorded for THIS user or `wait` passes, then returns `since(...)`.
    pub async fn wait_since(&self, user_id: &str, token: Option<&str>, wait: std::time::Duration, limit: usize) -> ChangesPage;
}
```

**Rules**, each one a test:
1. **No token** (`None`): the current token, `changes: []`, `reset: false`, `more: false`. Never waits (rev 4.1).
2. **Reset:** a token whose epoch isn't the current one, a malformed token, or one older than the oldest entry still
   kept → `reset: true`, `changes: []`, and the current token.
3. **Coalescing.** At most **one entry per (kind, id)** since the token, in the order of each key's *latest*
   change; the newest state wins.
   - Ids: team → `teamId`; conversation → `conversationId`; approval_added / approval_removed → `approvalId`
     (`approval["approvalId"]` for added); task → `task["taskId"]`; broadcast → `broadcastId`.
   - For `Team` and `Conversation`, merge the `what` lists as a deduplicated **union**, not newest-wins.
   - An `approval_removed` after an `approval_added` for the same approval, both since the token, returns **only**
     the removed entry.
4. **Paging:** at most `limit` entries (production 500). If more are pending, `more: true`, and the returned token
   points just after the last *included* change, so the next call continues without loss.
5. **Per user:** a user only ever sees their own entries, and `wait_since` only wakes for its own user.
6. **Retention:** drop entries past `max_entries` (oldest first) or older than `max_age_ms`. Tokens older than what's
   kept then reset (rule 2).
7. **Concurrency:** many concurrent `wait_since` callers and `record`s. Use `tokio::sync::Notify` or `watch`, with no
   lost wake-ups (record between the check and the wait must still wake the waiter).

## 2. `approvals.rs`: tracker and answer mapping (CONTRACT §6.5)

### Inputs (I build these from AionCore events; you only consume them)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind { Acp, ClaudeSession, CodexSession, Aionrs, Other }

/// Where an approval lives (filled by me from AionCore's conversation and team data).
#[derive(Debug, Clone)]
pub struct ApprovalOrigin {
    pub user_id: String,
    pub conversation_id: String,
    pub team_id: Option<String>,
    pub slot_id: Option<String>,
    pub agent_name: String,
    pub backend: BackendKind,
}

/// A `message.stream` frame whose `type` is "acp_permission", "permission" or "ask".
#[derive(Debug, Clone)]
pub struct PermissionFrame {
    pub origin: ApprovalOrigin,
    pub frame_type: String,         // "acp_permission" | "permission" | "ask"
    pub msg_id: String,             // the frame's msg_id; AionCore's confirm needs it
    pub data: serde_json::Value,    // the frame's `data`, verbatim
    pub at_ms: i64,
}
```

**What `data` looks like.** These shapes are verified in AionCore v0.2.2; see
`aionui-ai-agent/src/protocol/events/permission.rs` and `session_agent.rs`.
- **`acp_permission`, request form:**
  `{ "session_id", "tool_call": { "tool_call_id", "title"?, "kind"?: "read"|"edit"|"execute", "raw_input"?: {...} }, "options": [ { "option_id", "name", "kind": "allow_once"|"allow_always"|"reject_once"|"reject_always" } ] }`
  - The call id is `tool_call.tool_call_id`, and the confirmation id equals it.
  - `raw_input` is the **full tool input**.
- **`acp_permission`, confirmation form** (the same untagged enum):
  `{ "id", "call_id", "title"?, "action"?, "description", "command_type"?, "options": [ { "label", "value", "params"? } ], "questions"? }`
  - The call id is `call_id`; removal matches on `id`.
- **`ask`** (Claude's AskUserQuestion): `{ "session_id", "request_id", "questions": [ { "question", "header"?, "multiSelect"?, "options": [ { "label", "description"? } ] } ] }`.
  The call id is `request_id`.
- **`permission`** (legacy): treat it like the confirmation form.

### Output: what the facade lists

The facade serializes `Approval` to exactly CONTRACT §6.5 (camelCase). These fields need care:
- **`approvalId`:** `b64u(conversation_id + ":" + call_id)`.
- **`kind`:** `"question"` for `ask` frames, or when `questions` is non-empty; otherwise `"permission"`.
- **`input`:** `raw_input` (request form), otherwise `null`. **Never invent it.**
- **`inputSummary`:** from `input`: `command` for `kind: execute` or a tool titled `Bash`; `file_path` for
  edit/write/read; `url` for WebFetch; otherwise `null`. Never truncated.
- **`options[].kind`:**
  - request form: the option's own `kind`;
  - confirmation form, by value: `"allow"`/`"proceed_once"` → `allow_once`; `"allow_always"`/`"proceed_always"` →
    `allow_always`; `"reject"`/`"cancel"` → `reject_once`; anything else → `other`.
- **`options[].label`:** the name or label, except AionCore's i18n keys: `messages.confirmation.yesAllowOnce` →
  "Allow once", `messages.confirmation.yesAllowAlways` → "Always allow", `messages.confirmation.no` → "Deny".
- **`options[].alwaysScope`** (allow_always only): `ClaudeSession` → `same_as_once`; `Acp`, `Aionrs`,
  `CodexSession` → `backend_defined`. **`rule`** is always `null` for now.
- **`questions`:** normalized to `{question, header|null, multiSelect (default false), options[{label, description|null}]}`.
  Unknown fields are dropped.
- **`freeText`:** `true` only for `kind: question` on `ClaudeSession`.
- **`title`, `description`, `commandType`, `toolName`:** from the frame; `toolName` is `tool_call.title` or `title`.
  **`firstSeenAt`:** the first frame's `at_ms`.

```rust
pub struct ApprovalTracker { /* private */ }
pub struct TrackedApproval { pub approval: Approval, pub origin: ApprovalOrigin, pub call_id: String,
                             pub confirmation_id: String, pub msg_id: String }

impl ApprovalTracker {
    pub fn new() -> Self;
    /// Adds or refreshes. Returns the Approval only when it is NEW (for an `approval_added` change).
    pub fn on_frame(&self, frame: PermissionFrame) -> Option<Approval>;
    /// `confirmation.remove {conversation_id, id}`: the approval was answered.
    pub fn on_removed(&self, conversation_id: &str, confirmation_id: &str) -> Option<String /*approvalId*/>;
    /// A turn ended or the agent stopped: every approval of that conversation is gone ("cancelled").
    pub fn on_turn_ended(&self, conversation_id: &str) -> Vec<String>;
    /// Reconcile one conversation with AionCore's `GET .../confirmations` list (`Confirmation` objects as JSON).
    /// Adds missing ones with `input: null`; removes tracked ones absent from the list.
    pub fn reconcile(&self, origin: &ApprovalOrigin, listed: &[serde_json::Value], now_ms: i64) -> (Vec<Approval>, Vec<String>);
    pub fn list(&self, user_id: &str, team_id: Option<&str>) -> Vec<Approval>;   // oldest first
    pub fn get(&self, approval_id: &str) -> Option<TrackedApproval>;
}
```

The rule for `reconcile`: an approval first seen through `reconcile`, which is the recovery listing, has
`input: null`. A later live frame for the same call fills `input` in.

### Answer mapping: pure, and the part that must be exactly right

```rust
pub enum AnswerInput {
    Option { option_id: String, message: Option<String> },
    Decision { decision: Decision, message: Option<String> },   // Decision: AllowOnce | AllowAlways | Deny
    Answers { answers: Vec<QuestionAnswer> },                     // QuestionAnswer { question, labels: Vec<String> }
    Decline { message: Option<String> },
}
pub enum BackendCall {
    /// AionCore `POST /api/conversations/{id}/confirmations/{callId}/confirm` semantics.
    Confirm { conversation_id: String, msg_id: String, call_id: String, data: serde_json::Value, always_allow: bool },
    /// AionCore `POST /api/conversations/{id}/asks/{requestId}/answer`.
    AskAnswer { conversation_id: String, request_id: String, answers: Vec<QuestionAnswer> },
    AskDecline { conversation_id: String, request_id: String },
}
pub enum MessageDelivery { Native, Followup }
pub struct MappedAnswer {
    pub call: BackendCall,
    pub deny_message: Option<String>,
    pub delivery: Option<MessageDelivery>,   // Some iff deny_message is Some
    pub sensitive: bool,                     // §5.1
}
pub enum AnswerError { InvalidRequest(String), Ambiguous(Vec<ApprovalOption>) }

pub fn map_answer(tracked: &TrackedApproval, input: AnswerInput) -> Result<MappedAnswer, AnswerError>;
```

**Rules.** Each one needs a test; the backend rules are verified in AionCore source.

1. **`option_id` must be one of the approval's own `options`**, otherwise `InvalidRequest`.
   - Why: the Claude session backend treats any unknown string as an AskUserQuestion answer, which means APPROVE
     (`session_agent.rs` `confirm`).
2. **`data` per backend.** Map with the option's `kind`:

   | Backend | allow_once | allow_always | reject_* / deny | other options |
   |---|---|---|---|---|
   | `Acp` | `"<option_id>"` (string) | same | same | same |
   | `ClaudeSession`, `CodexSession` | `"allow"` | `"allow_always"` | `"reject"` | `"<option value>"` |
   | `Aionrs` | `{"value":"proceed_once"}` | `{"value":"proceed_always"}` with `always_allow: true` | `{"value":"cancel"}` | `{"value":"<value>"}` |

   **Never send a bare string to aionrs:** it reads a bare string as `cancel`, i.e. deny (`manager/aionrs/agent.rs`).
   `always_allow` is `true` only for aionrs `allow_always`.
3. **`Decision`** maps to the single option with the matching kind: `allow_once`, `allow_always`, or for `deny`
   `reject_once` (falling back to `reject_always` when there's no `reject_once`). If there's no match or more than
   one, return `Ambiguous(options)`.
4. **`message`** is allowed only on a refusal: deny, an option of kind `reject_*`, or `Decline`. It must be non-blank
   and at most 2,000 characters, trimmed. On an allow it's `InvalidRequest`.
   - `delivery` is `Native` for `ClaudeSession` and `Aionrs` permission refusals.
   - It's `Followup` for `Acp`, `CodexSession`, and any `Decline`.
5. **Questions** (`kind: question`):
   - `Answers` → `AskAnswer` (`ClaudeSession` only; other backends answer by picking an option, so `Option` input).
   - Every label must be an offered label, **unless** `freeText`. Then at most one non-offered label per question,
     trimmed, non-empty, at most 2,000 characters.
   - `Decline` → `AskDecline`.
   - `Option`/`Decision` on a question is `InvalidRequest`, and `Answers` on a permission is `InvalidRequest`.
6. **`sensitive`** is true for any allow: an option of kind `allow_*` or `other`, a `Decision` other than `Deny`, or
   `Answers`. It's false for deny, `reject_*` and `Decline`.

## 3. Done means

- Both modules compile without warnings.
- Every numbered rule above has at least one test, including the dangerous cases:
  - no bare string to aionrs;
  - an unknown option id is refused;
  - an approval seen through recovery has `input: null`;
  - added-then-removed coalesces to removed;
  - no lost wake-ups.
- `cargo test -p aionui-mobile` is green (my existing 48 tests plus yours).
- One commit on `phase4-core`, then message me the hash. Questions about intent: message me. Don't guess at an agent
  CLI's behavior (AionCore `AGENTS.md` rule); the backend facts above are already verified.
