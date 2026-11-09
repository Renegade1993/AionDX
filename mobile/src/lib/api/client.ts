import type {
  ActivityPage,
  Agent,
  AgentRuntime,
  AnswerResult,
  Approval,
  ApprovalAnswer,
  Assistant,
  Broadcast,
  ChangesResponse,
  ConfirmMode,
  Conversation,
  HostInfo,
  MessageHistory,
  MessageSync,
  NewConversationInput,
  Page,
  RunState,
  SendResult,
  SpawnInput,
  StopOutcome,
  Task,
  TaskInput,
  TaskPatch,
  TaskStatus,
  TeamSummary,
  Workspace,
} from './types';

/**
 * Everything the app needs from a paired PC: the bridge facade, contract rev 3.1 §6.
 * One implementation (api.ts) over a Transport: the SecureChannel for real PCs, an in-memory
 * facade for the demo host. Screens and hooks only ever see this interface.
 */
export interface AionDxApi {
  // §6.1 Host
  getHost(): Promise<HostInfo>;
  /** §5.3 re-issue: proves possession of the QR's rekeySecret inside this session. */
  reissueConfirmKey(rekeySecret: Uint8Array, deviceId: string, confirmMode: ConfirmMode): Promise<{ confirmKey: Uint8Array }>;
  /** Unpairs this phone from the PC side (same as revoking it on the PC). */
  unpairDevice(): Promise<void>;

  // §6.2 Change feed
  /** `waitSec` 0..25: the PC holds the request until there is a change or the wait ends. */
  getChanges(since: string | undefined, waitSec: number): Promise<ChangesResponse>;

  // §6.3 Teams
  listTeams(): Promise<TeamSummary[]>;
  getRunState(teamId: string): Promise<RunState>;
  getAgent(teamId: string, slotId: string): Promise<Agent>;
  startTeamSession(teamId: string): Promise<RunState>;

  // §6.4 Conversations and messages
  listSoloConversations(cursor?: string, limit?: number): Promise<Page<Conversation>>;
  getConversation(conversationId: string): Promise<Conversation>;
  createConversation(input: NewConversationInput): Promise<Conversation>;
  listWorkspaces(): Promise<Workspace[]>;
  /** Without `since`: the latest page. With it: every row inserted or changed since (upsert by id). */
  syncMessages(conversationId: string, since?: string, limit?: number): Promise<MessageSync>;
  olderMessages(conversationId: string, before: string, limit?: number): Promise<MessageHistory>;
  sendMessage(conversationId: string, content: string, opts?: { priority?: 'normal' | 'now'; rid?: string }): Promise<SendResult>;
  markRead(conversationId: string, upToMessageId: string): Promise<void>;
  broadcast(teamId: string, content: string, opts?: { rid?: string }): Promise<Broadcast>;
  listBroadcasts(teamId: string, cursor?: string, limit?: number): Promise<Page<Broadcast>>;

  // §6.5 Approvals
  /** Without teamId: every pending approval, solo and team. */
  listApprovals(teamId?: string): Promise<Approval[]>;
  /** Allow answers are sensitive (§5.1) and carry a confirm proof; refusals never do. */
  answerApproval(approval: Approval, answer: ApprovalAnswer): Promise<AnswerResult>;

  // §6.6 Agent controls
  wakeAgent(teamId: string, slotId: string, nudge?: string): Promise<{ runtime: AgentRuntime }>;
  /** With a replacement message: interrupt (teammates only; 422 lead_not_allowed on the lead). */
  stopAgent(teamId: string, slotId: string, replacementMessage?: string): Promise<{ outcome: StopOutcome }>;
  // Sensitive actions take the OS prompt copy (SPEC §15.1.1); callers know the names.
  shutdownAgent(teamId: string, slotId: string, reason?: string, prompt?: string): Promise<void>;
  forceRemoveAgent(teamId: string, slotId: string, prompt?: string): Promise<void>;
  spawnAgent(teamId: string, input: SpawnInput, prompt?: string): Promise<Agent>;
  renameAgent(teamId: string, slotId: string, name: string): Promise<Agent>;
  clearContext(teamId: string, slotId: string, prompt?: string): Promise<{ preservedUnread: number }>;
  listAssistants(): Promise<Assistant[]>;

  // §6.7 Tasks
  listTasks(teamId: string, filter?: { status?: TaskStatus[]; owner?: string }): Promise<Task[]>;
  getTask(teamId: string, taskId: string): Promise<Task>;
  createTask(teamId: string, input: TaskInput): Promise<Task>;
  /** `status: 'deleted'` is sensitive (§5.1). */
  updateTask(teamId: string, taskId: string, patch: TaskPatch, prompt?: string): Promise<Task>;

  // §6.8 Activity
  getActivity(
    teamId: string,
    query?: { slotId?: string; kind?: 'message' | 'task'; aroundTask?: string; cursor?: string; limit?: number },
  ): Promise<ActivityPage>;
}

/** Route id of a team's "Everyone" thread (broadcasts). Real conversation ids never collide with it. */
export const BROADCAST_CONVERSATION = 'all';
