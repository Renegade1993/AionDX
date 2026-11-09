/*
 * Data contracts: the bridge facade's resources, contract rev 3.1 §6
 * (docs/bridge-api-contract-v1-draft.md). The app uses these shapes directly; mappers.ts
 * normalizes wire JSON into them (defaults, unknown enum values) and derives display state.
 * Timestamps are integer ms since the epoch; ids are opaque strings.
 */

// ---------------------------------------------------------------------------
// §6.1 Host
// ---------------------------------------------------------------------------

/** Optional features the PC has switched on. Missing → hide the UI for it. */
export type Capability = 'changes.longpoll' | 'tasks.write' | 'approvals.questions' | (string & {});

export type ConfirmMode = 'biometric' | 'device_passcode' | 'none';

export interface HostInfo {
  hostId: string;
  hostName: string;
  appVersion?: string;
  coreVersion?: string;
  bridgeVersion?: number;
  serverTime: number;
  /** This phone as the PC sees it. */
  device?: { deviceId: string; name: string; pairedAt: number; requireConfirm: boolean; confirmMode: ConfirmMode };
  capabilities: Capability[];
}

// ---------------------------------------------------------------------------
// §6.2 Change feed
// ---------------------------------------------------------------------------

export interface ChangesResponse {
  /** Pass back as `since`. Opaque. */
  token: string;
  /** `since` is from an older bridge epoch or too old: refetch everything shown. */
  reset: boolean;
  /** More than 500 entries were pending: call again right away. */
  more: boolean;
  changes: ChangeEntry[];
}

export type ChangeEntry =
  | { kind: 'team'; teamId: string; what: ('roster' | 'run_state' | 'meta')[] }
  | { kind: 'team_removed'; teamId: string }
  | { kind: 'conversation'; conversationId: string; teamId?: string; slotId?: string; what: ('messages' | 'state' | 'meta' | 'read')[] }
  | { kind: 'conversation_removed'; conversationId: string }
  | { kind: 'approval_added'; approval: Approval }
  | { kind: 'approval_removed'; approvalId: string; conversationId: string; teamId?: string; resolution: 'answered' | 'cancelled' }
  | { kind: 'task'; teamId: string; task: Task; change: 'created' | 'updated' }
  | { kind: 'broadcast'; teamId: string; broadcastId: string };

// ---------------------------------------------------------------------------
// §6.3 Teams, roster, run state
// ---------------------------------------------------------------------------

export type Attention = 'needs_answer' | 'needs_approval' | 'error' | 'your_turn' | 'none';

export interface LastMessage {
  messageId: string;
  role: MessageRole;
  /** Teammate or agent display name; null for the user. */
  senderName: string | null;
  /** Plain text, first 200 characters; tool rows read "Used <tool>". */
  text: string;
  createdAt: number;
}

export interface TeamSummary {
  teamId: string;
  name: string;
  workspace: string;
  leadSlotId: string;
  agentCount: number;
  attention: Attention;
  waitingOnUser: boolean;
  unread: number;
  updatedAt: number;
}

export type SessionStatus = 'none' | 'starting' | 'ready' | 'failed' | 'stopped';

export interface RunState {
  teamId: string;
  sessionStatus: SessionStatus;
  activeRun: null | {
    runId: string;
    status: 'accepted' | 'running' | 'cancelling';
    targetSlotId: string;
    source: 'user_message' | 'system_lifecycle';
  };
  /** The lead first, then teammates in roster order. */
  agents: Agent[];
}

export type AgentState = 'idle' | 'queued' | 'starting' | 'running' | 'paused' | 'blocked';
export type BlockedReason = 'runtime_starting' | 'runtime_failed' | 'removing' | 'session_stopped';
export type AgentRuntime = 'dormant' | 'pending' | 'ready' | 'failed';

export type AgentShutdown =
  | null
  | { state: 'requested'; requestedAt: number; reason: string | null }
  | { state: 'approved'; requestedAt: number; respondedAt: number }
  | { state: 'rejected'; requestedAt: number; respondedAt: number; rejectReason: string };

export interface Agent {
  slotId: string;
  name: string;
  role: 'lead' | 'teammate';
  conversationId: string;
  backend: string;
  model: string;
  icon: string | null;
  state: AgentState;
  blockedReason: BlockedReason | null;
  runtime: AgentRuntime;
  turn: null | { turnId: string; startedAt: number; elapsedMs: number; slow: boolean; slowThresholdMs: number };
  queue: { foreground: number; background: number; foregroundMessageIds: string[] };
  pendingApprovals: number;
  attention: Attention;
  waitingOnUser: boolean;
  unread: number;
  shutdown: AgentShutdown;
  currentTask: null | { taskId: string; subject: string };
  openTaskCount: number;
  lastMessage: LastMessage | null;
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// §6.4 Conversations and messages
// ---------------------------------------------------------------------------

export type ConversationState = 'idle' | 'starting' | 'running' | 'cancelling' | 'restarting' | 'waiting_confirmation';

export interface Conversation {
  conversationId: string;
  name: string;
  kind: 'solo' | 'team_member';
  teamId?: string;
  slotId?: string;
  backend: string;
  model?: string;
  workspace?: string;
  state: ConversationState;
  attention: Attention;
  waitingOnUser: boolean;
  unread: number;
  lastMessage: LastMessage | null;
  updatedAt: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Workspace {
  path: string;
  label: string;
  lastUsedAt: number;
}

export interface NewConversationInput {
  /** Exactly one of assistantId / backend. */
  assistantId?: string;
  backend?: string;
  name?: string;
  /** Must come from GET /v1/workspaces; omitted → a temp folder on the PC. */
  workspace?: string;
  model?: string;
}

export type MessageRole = 'user' | 'agent' | 'teammate' | 'system';

export type MessageSender =
  | { kind: 'user' }
  | { kind: 'agent'; name: string }
  | { kind: 'teammate'; name: string; slotId: string | null; conversationId: string | null }
  | { kind: 'team_system' }
  | { kind: 'app' };

export type MessageType = 'text' | 'thinking' | 'tool_call' | 'plan' | 'tips' | 'agent_status' | 'other';
export type MessageStatus = 'streaming' | 'done' | 'error' | 'pending';

export interface MessageError {
  source: 'send_failed' | 'agent';
  code: string | null;
  message: string;
  /** send_failed only: the user message whose send failed; null when the bridge can't tell (rev 3.1). */
  messageId?: string | null;
}

export interface Message {
  messageId: string;
  conversationId: string;
  turnId?: string;
  role: MessageRole;
  sender: MessageSender;
  type: MessageType;
  status: MessageStatus;
  text?: string;
  error?: MessageError;
  tool?: { name: string; title?: string; status?: string; summary?: string };
  notice?: { kind: 'task_assigned'; taskId: string } | { kind: 'context_reset' };
  raw?: unknown;
  createdAt: number;
}

/** `GET …/messages?since=` (or no cursor: the latest page). */
export interface MessageSync {
  items: Message[];
  cursor: string;
  reset: boolean;
  hasMore: boolean;
  /**
   * NOT IN CONTRACT rev 3.1 (raised with the bridge team): where older history continues, for
   * `?before=`. Only on the latest-page response (no `since`). Absent → the phone can't page back.
   */
  before?: string | null;
}

/** `GET …/messages?before=`: older history, ascending. `before: null` = start of the conversation. */
export interface MessageHistory {
  items: Message[];
  before: string | null;
}

export type Delivery = 'started' | 'midturn' | 'queued' | 'queued_first';

export interface SendResult {
  messageId: string;
  delivery: Delivery;
}

export interface Broadcast {
  broadcastId: string;
  teamId: string;
  content: string;
  createdAt: number;
  sentFrom: { kind: 'mobile'; deviceId: string; deviceName: string };
  deliveries: { slotId: string; messageId: string | null; delivery: Delivery | 'failed'; error?: string }[];
}

// ---------------------------------------------------------------------------
// §6.5 Approvals
// ---------------------------------------------------------------------------

export type ApprovalOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other';

export interface ApprovalOption {
  optionId: string;
  label: string;
  kind: ApprovalOptionKind;
  rule: string | null;
  /** allow_always only. */
  alwaysScope?: 'rule' | 'backend_defined' | 'same_as_once';
}

export interface ApprovalQuestion {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: { label: string; description: string | null }[];
}

export interface Approval {
  approvalId: string;
  kind: 'permission' | 'question';
  conversationId: string;
  teamId?: string;
  slotId?: string;
  agentName: string;
  title: string | null;
  description: string;
  commandType: 'read' | 'edit' | 'execute' | (string & {}) | null;
  toolName: string | null;
  /** The full tool input; null when the bridge only saw it through a recovery listing (no Allow then). */
  input: unknown;
  inputSummary: string | null;
  /** In the agent's order; empty for questions. */
  options: ApprovalOption[];
  questions?: ApprovalQuestion[];
  freeText: boolean;
  firstSeenAt: number;
}

/** `POST /v1/approvals/{id}/answer` bodies (exactly one shape). `message` only on refusals. */
export type ApprovalAnswer =
  | { optionId: string; message?: string }
  | { decision: 'allow_once' | 'allow_always' | 'deny'; message?: string }
  | { answers: { question: string; labels: string[] }[] }
  | { decline: true; message?: string };

export interface AnswerResult {
  resolved: true;
  messageDelivery: 'native' | 'followup' | null;
  details?: { messageError?: string };
}

// ---------------------------------------------------------------------------
// §6.6 Agent controls
// ---------------------------------------------------------------------------

export interface Assistant {
  assistantId: string;
  name: string;
  backend: string;
  icon: string | null;
  description: string | null;
}

export type StopOutcome = 'cancelled' | 'interrupted' | 'no_active_turn';

export interface SpawnInput {
  assistantId: string;
  name?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// §6.7 Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** `owner`: a slotId, "user" for the user, or null when unassigned. */
export const USER_OWNER = 'user';

export interface Task {
  taskId: string;
  teamId: string;
  subject: string;
  description: string | null;
  status: TaskStatus;
  owner: string | null;
  /** "You" for "user"; null if the slot was removed. */
  ownerName: string | null;
  blockedBy: string[];
  blocks: string[];
  assignment: null | { conversationId: string; messageId: string; createdAt: number };
  createdAt: number;
  updatedAt: number;
}

export interface TaskInput {
  subject: string;
  description?: string;
  owner?: string | null;
  blockedBy?: string[];
}

/** Omitted fields are unchanged; `owner: null` unassigns; `blockedBy` replaces the whole list. */
export type TaskPatch = Partial<Pick<Task, 'subject' | 'status' | 'blockedBy'>> & { description?: string | null; owner?: string | null };

// ---------------------------------------------------------------------------
// §6.8 Activity
// ---------------------------------------------------------------------------

export interface ActivityParty {
  slotId: string | null;
  name: string;
  isUser: boolean;
}

export type Activity =
  | {
      kind: 'message';
      activityId: string;
      createdAt: number;
      message: {
        messageId: string;
        from: ActivityParty;
        to: ActivityParty;
        msgType: string;
        content: string;
        summary: string | null;
        read: boolean;
        notice?: { kind: 'task_assigned'; taskId: string };
      };
    }
  | { kind: 'task'; activityId: string; createdAt: number; task: Task };

export interface ActivityPage {
  items: Activity[];
  nextCursor: string | null;
  hasMore: boolean;
}
