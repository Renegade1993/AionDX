/*
 * Wire JSON → the types in types.ts (contract rev 3.1 §6), plus derivations the UI shares.
 *
 * The facade is a new service, so mapping is defensive: a missing field gets a neutral default,
 * an enum value this build doesn't know falls back to its "nothing special" value, and a row
 * that lacks its id is dropped. A newer bridge must never crash an older phone.
 */
import type {
  Activity,
  ActivityPage,
  ActivityParty,
  Agent,
  AgentShutdown,
  AnswerResult,
  Approval,
  ApprovalOption,
  ApprovalQuestion,
  Assistant,
  Attention,
  Broadcast,
  ChangeEntry,
  ChangesResponse,
  Conversation,
  HostInfo,
  LastMessage,
  Message,
  MessageHistory,
  MessageSender,
  MessageSync,
  Page,
  RunState,
  SendResult,
  Task,
  TeamSummary,
  Workspace,
} from './types';

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Maps a list, dropping rows the mapper rejects (returns null). */
function list<T>(v: unknown, map: (x: Json) => T | null): T[] {
  return arr(v).flatMap((x) => {
    const mapped = map(obj(x));
    return mapped === null ? [] : [mapped];
  });
}

// ---------------------------------------------------------------------------
// Host, teams, run state
// ---------------------------------------------------------------------------

const ATTENTION = ['needs_answer', 'needs_approval', 'error', 'your_turn', 'none'] as const;
const toAttention = (v: unknown): Attention => oneOf(v, ATTENTION, 'none');

export function toHostInfo(v: unknown): HostInfo {
  const j = obj(v);
  const d = j.device === undefined ? undefined : obj(j.device);
  return {
    hostId: str(j.hostId),
    hostName: str(j.hostName),
    appVersion: typeof j.appVersion === 'string' ? j.appVersion : undefined,
    coreVersion: typeof j.coreVersion === 'string' ? j.coreVersion : undefined,
    bridgeVersion: typeof j.bridgeVersion === 'number' ? j.bridgeVersion : undefined,
    serverTime: num(j.serverTime, Date.now()),
    device: d && {
      deviceId: str(d.deviceId),
      name: str(d.name),
      pairedAt: num(d.pairedAt),
      // Unknown means the PC's default, which is on (§5).
      requireConfirm: d.requireConfirm !== false,
      confirmMode: oneOf(d.confirmMode, ['biometric', 'device_passcode', 'none'] as const, 'none'),
    },
    capabilities: strings(j.capabilities),
  };
}

export function toLastMessage(v: unknown): LastMessage | null {
  if (!v || typeof v !== 'object') return null;
  const j = obj(v);
  if (typeof j.messageId !== 'string') return null;
  return {
    messageId: j.messageId,
    role: oneOf(j.role, ['user', 'agent', 'teammate', 'system'] as const, 'system'),
    senderName: strOrNull(j.senderName),
    text: str(j.text),
    createdAt: num(j.createdAt),
  };
}

export function toTeamSummary(j: Json): TeamSummary | null {
  if (typeof j.teamId !== 'string') return null;
  return {
    teamId: j.teamId,
    name: str(j.name, j.teamId),
    workspace: str(j.workspace),
    leadSlotId: str(j.leadSlotId),
    agentCount: num(j.agentCount),
    attention: toAttention(j.attention),
    waitingOnUser: bool(j.waitingOnUser),
    unread: num(j.unread),
    updatedAt: num(j.updatedAt),
  };
}

export const toTeams = (v: unknown): TeamSummary[] => list(v, toTeamSummary);

function toShutdown(v: unknown): AgentShutdown {
  if (!v || typeof v !== 'object') return null;
  const j = obj(v);
  const requestedAt = num(j.requestedAt);
  switch (j.state) {
    case 'requested':
      return { state: 'requested', requestedAt, reason: strOrNull(j.reason) };
    case 'rejected':
      return { state: 'rejected', requestedAt, respondedAt: num(j.respondedAt), rejectReason: str(j.rejectReason) };
    case 'expired':
      return { state: 'expired', requestedAt, expiredAt: num(j.expiredAt), reason: strOrNull(j.reason) };
    default:
      return null;
  }
}

export function toAgent(j: Json): Agent | null {
  if (typeof j.slotId !== 'string') return null;
  const turn = j.turn && typeof j.turn === 'object' ? obj(j.turn) : null;
  const queue = obj(j.queue);
  const task = j.currentTask && typeof j.currentTask === 'object' ? obj(j.currentTask) : null;
  return {
    slotId: j.slotId,
    name: str(j.name, j.slotId),
    role: j.role === 'lead' ? 'lead' : 'teammate',
    conversationId: str(j.conversationId),
    backend: str(j.backend),
    model: str(j.model),
    icon: strOrNull(j.icon),
    state: oneOf(j.state, ['idle', 'queued', 'starting', 'running', 'paused', 'blocked'] as const, 'idle'),
    blockedReason:
      j.blockedReason == null
        ? null
        : oneOf(j.blockedReason, ['runtime_starting', 'runtime_failed', 'removing', 'session_stopped'] as const, 'runtime_starting'),
    runtime: oneOf(j.runtime, ['dormant', 'pending', 'ready', 'failed'] as const, 'ready'),
    turn: turn && {
      turnId: str(turn.turnId),
      startedAt: num(turn.startedAt),
      elapsedMs: num(turn.elapsedMs),
      slow: bool(turn.slow),
      slowThresholdMs: num(turn.slowThresholdMs, 10 * 60_000),
    },
    queue: { foreground: num(queue.foreground), background: num(queue.background), foregroundMessageIds: strings(queue.foregroundMessageIds) },
    pendingApprovals: num(j.pendingApprovals),
    attention: toAttention(j.attention),
    waitingOnUser: bool(j.waitingOnUser),
    unread: num(j.unread),
    shutdown: toShutdown(j.shutdown),
    currentTask: task && typeof task.taskId === 'string' ? { taskId: task.taskId, subject: str(task.subject) } : null,
    openTaskCount: num(j.openTaskCount),
    lastMessage: toLastMessage(j.lastMessage),
    lastActivityAt: num(j.lastActivityAt),
  };
}

export function toRunState(v: unknown): RunState {
  const j = obj(v);
  const run = j.activeRun && typeof j.activeRun === 'object' ? obj(j.activeRun) : null;
  const agents = list(j.agents, toAgent);
  // The lead first (contract §6.3); kept stable if the bridge already orders it.
  agents.sort((a, b) => (a.role === 'lead' ? -1 : 0) - (b.role === 'lead' ? -1 : 0));
  return {
    teamId: str(j.teamId),
    sessionStatus: oneOf(j.sessionStatus, ['none', 'starting', 'ready', 'failed', 'stopped'] as const, 'ready'),
    activeRun: run && {
      runId: str(run.runId),
      status: oneOf(run.status, ['accepted', 'running', 'cancelling'] as const, 'running'),
      targetSlotId: str(run.targetSlotId),
      source: oneOf(run.source, ['user_message', 'system_lifecycle'] as const, 'user_message'),
    },
    agents,
  };
}

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export function toConversation(j: Json): Conversation | null {
  if (typeof j.conversationId !== 'string') return null;
  return {
    conversationId: j.conversationId,
    name: str(j.name),
    kind: j.kind === 'team_member' ? 'team_member' : 'solo',
    teamId: typeof j.teamId === 'string' ? j.teamId : undefined,
    slotId: typeof j.slotId === 'string' ? j.slotId : undefined,
    backend: str(j.backend),
    model: typeof j.model === 'string' ? j.model : undefined,
    workspace: typeof j.workspace === 'string' ? j.workspace : undefined,
    state: oneOf(j.state, ['idle', 'starting', 'running', 'cancelling', 'restarting', 'waiting_confirmation'] as const, 'idle'),
    attention: toAttention(j.attention),
    waitingOnUser: bool(j.waitingOnUser),
    unread: num(j.unread),
    lastMessage: toLastMessage(j.lastMessage),
    updatedAt: num(j.updatedAt),
  };
}

export function toPage<T>(v: unknown, map: (j: Json) => T | null): Page<T> {
  const j = obj(v);
  return { items: list(j.items, map), nextCursor: strOrNull(j.nextCursor) };
}

export const toWorkspaces = (v: unknown): Workspace[] =>
  list(v, (j) => (typeof j.path === 'string' ? { path: j.path, label: str(j.label, j.path), lastUsedAt: num(j.lastUsedAt) } : null));

function toSender(v: unknown, role: Message['role']): MessageSender {
  const j = obj(v);
  switch (j.kind) {
    case 'user':
      return { kind: 'user' };
    case 'agent':
      return { kind: 'agent', name: str(j.name) };
    case 'teammate':
      return { kind: 'teammate', name: str(j.name), slotId: strOrNull(j.slotId), conversationId: strOrNull(j.conversationId) };
    case 'team_system':
      return { kind: 'team_system' };
    case 'app':
      return { kind: 'app' };
    default:
      // Unknown sender kind: derive the closest from role so the row still renders sensibly.
      return role === 'user' ? { kind: 'user' } : role === 'system' ? { kind: 'app' } : { kind: 'agent', name: str(j.name) };
  }
}

export function toMessage(j: Json): Message | null {
  if (typeof j.messageId !== 'string') return null;
  const role = oneOf(j.role, ['user', 'agent', 'teammate', 'system'] as const, 'system');
  const err = j.error && typeof j.error === 'object' ? obj(j.error) : null;
  const tool = j.tool && typeof j.tool === 'object' ? obj(j.tool) : null;
  const notice = j.notice && typeof j.notice === 'object' ? obj(j.notice) : null;
  return {
    messageId: j.messageId,
    conversationId: str(j.conversationId),
    turnId: typeof j.turnId === 'string' ? j.turnId : undefined,
    role,
    sender: toSender(j.sender, role),
    type: oneOf(j.type, ['text', 'thinking', 'tool_call', 'plan', 'tips', 'agent_status', 'other'] as const, 'other'),
    status: oneOf(j.status, ['streaming', 'done', 'error', 'pending'] as const, 'done'),
    text: typeof j.text === 'string' ? j.text : undefined,
    error: err
      ? {
          source: err.source === 'send_failed' ? 'send_failed' : 'agent',
          code: strOrNull(err.code),
          message: str(err.message),
          messageId: err.messageId === undefined ? undefined : strOrNull(err.messageId),
        }
      : undefined,
    tool: tool
      ? {
          name: str(tool.name),
          title: typeof tool.title === 'string' ? tool.title : undefined,
          status: typeof tool.status === 'string' ? tool.status : undefined,
          summary: typeof tool.summary === 'string' ? tool.summary : undefined,
        }
      : undefined,
    notice:
      notice?.kind === 'task_assigned' && typeof notice.taskId === 'string'
        ? { kind: 'task_assigned', taskId: notice.taskId }
        : notice?.kind === 'context_reset'
          ? { kind: 'context_reset' }
          : undefined,
    raw: j.raw,
    createdAt: num(j.createdAt),
  };
}

export function toMessageSync(v: unknown): MessageSync {
  const j = obj(v);
  return {
    items: list(j.items, toMessage),
    cursor: str(j.cursor),
    reset: bool(j.reset),
    hasMore: bool(j.hasMore),
    before: j.before === undefined ? undefined : strOrNull(j.before),
  };
}

export function toMessageHistory(v: unknown): MessageHistory {
  const j = obj(v);
  return { items: list(j.items, toMessage), before: strOrNull(j.before) };
}

const DELIVERY = ['started', 'midturn', 'queued', 'queued_first'] as const;

export function toSendResult(v: unknown): SendResult {
  const j = obj(v);
  return { messageId: str(j.messageId), delivery: oneOf(j.delivery, DELIVERY, 'queued') };
}

export function toBroadcast(j: Json): Broadcast | null {
  if (typeof j.broadcastId !== 'string') return null;
  const from = obj(j.sentFrom);
  return {
    broadcastId: j.broadcastId,
    teamId: str(j.teamId),
    content: str(j.content),
    createdAt: num(j.createdAt),
    sentFrom: { kind: 'mobile', deviceId: str(from.deviceId), deviceName: str(from.deviceName) },
    deliveries: list(j.deliveries, (d) =>
      typeof d.slotId === 'string'
        ? {
            slotId: d.slotId,
            messageId: strOrNull(d.messageId),
            delivery: oneOf(d.delivery, [...DELIVERY, 'failed'] as const, 'failed'),
            error: typeof d.error === 'string' ? d.error : undefined,
          }
        : null,
    ),
  };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function toOption(j: Json): ApprovalOption | null {
  if (typeof j.optionId !== 'string') return null;
  const kind = oneOf(j.kind, ['allow_once', 'allow_always', 'reject_once', 'reject_always', 'other'] as const, 'other');
  return {
    optionId: j.optionId,
    label: str(j.label, j.optionId),
    kind,
    rule: strOrNull(j.rule),
    alwaysScope: kind === 'allow_always' ? oneOf(j.alwaysScope, ['rule', 'backend_defined', 'same_as_once'] as const, 'backend_defined') : undefined,
  };
}

function toQuestion(j: Json): ApprovalQuestion | null {
  if (typeof j.question !== 'string') return null;
  return {
    question: j.question,
    header: strOrNull(j.header),
    multiSelect: bool(j.multiSelect),
    options: list(j.options, (o) => (typeof o.label === 'string' ? { label: o.label, description: strOrNull(o.description) } : null)),
  };
}

export function toApproval(j: Json): Approval | null {
  if (typeof j.approvalId !== 'string') return null;
  const kind = j.kind === 'question' ? 'question' : 'permission';
  return {
    approvalId: j.approvalId,
    kind,
    conversationId: str(j.conversationId),
    teamId: typeof j.teamId === 'string' ? j.teamId : undefined,
    slotId: typeof j.slotId === 'string' ? j.slotId : undefined,
    agentName: str(j.agentName, 'Agent'),
    title: strOrNull(j.title),
    description: str(j.description),
    commandType: strOrNull(j.commandType),
    toolName: strOrNull(j.toolName),
    input: j.input === undefined ? null : j.input,
    inputSummary: strOrNull(j.inputSummary),
    options: list(j.options, toOption),
    // Questions are answered on kind 'question'. Since rev 4.4 a 'permission' may carry them too, as
    // display-only context (answered with optionId, never `answers`); omitted when absent.
    questions: kind === 'question' || Array.isArray(j.questions) ? list(j.questions, toQuestion) : undefined,
    freeText: kind === 'question' && bool(j.freeText),
    firstSeenAt: num(j.firstSeenAt),
  };
}

export const toApprovals = (v: unknown): Approval[] => list(obj(v).items, toApproval);

/**
 * The approval's heading (SPEC §16 #2): `title`, unless it already contains `inputSummary` (ACP
 * titles like "Write src/app/_layout.tsx"), in which case `toolName`, so the path shows only once.
 */
export function approvalHeading(a: Pick<Approval, 'title' | 'toolName' | 'inputSummary'>): string {
  if (a.title && a.inputSummary && a.title.includes(a.inputSummary) && a.toolName) return a.toolName;
  return a.title ?? a.toolName ?? 'Tool call';
}

export function toAnswerResult(v: unknown): AnswerResult {
  const j = obj(v);
  const details = j.details && typeof j.details === 'object' ? obj(j.details) : undefined;
  return {
    resolved: true,
    messageDelivery: j.messageDelivery === 'native' || j.messageDelivery === 'followup' ? j.messageDelivery : null,
    details: details && typeof details.messageError === 'string' ? { messageError: details.messageError } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Agents, tasks, activity
// ---------------------------------------------------------------------------

export const toAssistants = (v: unknown): Assistant[] =>
  list(v, (j) =>
    typeof j.assistantId === 'string'
      ? { assistantId: j.assistantId, name: str(j.name, j.assistantId), backend: str(j.backend), icon: strOrNull(j.icon), description: strOrNull(j.description) }
      : null,
  );

export function toTask(j: Json): Task | null {
  if (typeof j.taskId !== 'string') return null;
  const assignment = j.assignment && typeof j.assignment === 'object' ? obj(j.assignment) : null;
  return {
    taskId: j.taskId,
    teamId: str(j.teamId),
    subject: str(j.subject),
    description: strOrNull(j.description),
    status: oneOf(j.status, ['pending', 'in_progress', 'completed', 'deleted'] as const, 'pending'),
    owner: strOrNull(j.owner),
    ownerName: strOrNull(j.ownerName),
    blockedBy: strings(j.blockedBy),
    blocks: strings(j.blocks),
    assignment:
      assignment && typeof assignment.conversationId === 'string'
        ? { conversationId: assignment.conversationId, messageId: str(assignment.messageId), createdAt: num(assignment.createdAt) }
        : null,
    createdAt: num(j.createdAt),
    updatedAt: num(j.updatedAt),
  };
}

export const toTasks = (v: unknown): Task[] => list(v, toTask);

const toParty = (v: unknown): ActivityParty => {
  const j = obj(v);
  return { slotId: strOrNull(j.slotId), name: str(j.name), isUser: bool(j.isUser) };
};

function toActivity(j: Json): Activity | null {
  if (typeof j.activityId !== 'string') return null;
  if (j.kind === 'task') {
    const task = toTask(obj(j.task));
    return task ? { kind: 'task', activityId: j.activityId, createdAt: num(j.createdAt), task } : null;
  }
  if (j.kind !== 'message') return null;
  const m = obj(j.message);
  const notice = obj(m.notice);
  return {
    kind: 'message',
    activityId: j.activityId,
    createdAt: num(j.createdAt),
    message: {
      messageId: str(m.messageId),
      from: toParty(m.from),
      to: toParty(m.to),
      msgType: str(m.msgType, 'message'),
      content: str(m.content),
      summary: strOrNull(m.summary),
      read: bool(m.read),
      notice: notice.kind === 'task_assigned' && typeof notice.taskId === 'string' ? { kind: 'task_assigned', taskId: notice.taskId } : undefined,
    },
  };
}

export function toActivityPage(v: unknown): ActivityPage {
  const j = obj(v);
  return { items: list(j.items, toActivity), nextCursor: strOrNull(j.nextCursor), hasMore: bool(j.hasMore) };
}

// ---------------------------------------------------------------------------
// Change feed
// ---------------------------------------------------------------------------

const TEAM_WHAT = ['roster', 'run_state', 'meta'] as const;
const CONV_WHAT = ['messages', 'state', 'meta', 'read'] as const;

function toChange(j: Json): ChangeEntry | null {
  const id = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : null);
  switch (j.kind) {
    case 'team': {
      const teamId = id('teamId');
      return teamId ? { kind: 'team', teamId, what: strings(j.what).filter((w): w is (typeof TEAM_WHAT)[number] => (TEAM_WHAT as readonly string[]).includes(w)) } : null;
    }
    case 'team_removed': {
      const teamId = id('teamId');
      return teamId ? { kind: 'team_removed', teamId } : null;
    }
    case 'conversation': {
      const conversationId = id('conversationId');
      if (!conversationId) return null;
      return {
        kind: 'conversation',
        conversationId,
        teamId: id('teamId') ?? undefined,
        slotId: id('slotId') ?? undefined,
        what: strings(j.what).filter((w): w is (typeof CONV_WHAT)[number] => (CONV_WHAT as readonly string[]).includes(w)),
      };
    }
    case 'conversation_removed': {
      const conversationId = id('conversationId');
      return conversationId ? { kind: 'conversation_removed', conversationId } : null;
    }
    case 'approval_added': {
      const approval = toApproval(obj(j.approval));
      return approval ? { kind: 'approval_added', approval } : null;
    }
    case 'approval_removed': {
      const approvalId = id('approvalId');
      return approvalId
        ? {
            kind: 'approval_removed',
            approvalId,
            conversationId: str(j.conversationId),
            teamId: id('teamId') ?? undefined,
            resolution: j.resolution === 'cancelled' ? 'cancelled' : 'answered',
          }
        : null;
    }
    case 'task': {
      const teamId = id('teamId');
      const task = toTask(obj(j.task));
      return teamId && task ? { kind: 'task', teamId, task, change: j.change === 'created' ? 'created' : 'updated' } : null;
    }
    case 'broadcast': {
      const teamId = id('teamId');
      const broadcastId = id('broadcastId');
      return teamId && broadcastId ? { kind: 'broadcast', teamId, broadcastId } : null;
    }
    default:
      // A change kind this build doesn't know: skipped (the feed is advisory; screens can refresh).
      return null;
  }
}

export function toChanges(v: unknown): ChangesResponse {
  const j = obj(v);
  return { token: str(j.token), reset: bool(j.reset), more: bool(j.more), changes: list(j.changes, toChange) };
}
