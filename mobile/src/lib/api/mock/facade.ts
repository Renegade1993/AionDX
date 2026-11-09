import { rekeyProof } from '../../crypto/confirm';
import { isSensitiveAnswer } from '../api';
import type {
  Activity,
  Agent,
  AgentRuntime,
  AgentShutdown,
  AgentState,
  Approval,
  ApprovalAnswer,
  ApprovalOption,
  Attention,
  BlockedReason,
  Broadcast,
  ChangeEntry,
  Conversation,
  ConversationState,
  Delivery,
  LastMessage,
  Message,
  RunState,
  SessionStatus,
  Task,
  TaskStatus,
  TeamSummary,
} from '../types';
import { seed } from './seed';

/*
 * An in-memory bridge facade (contract rev 3.1 §6) for the demo host, tests and the e2e
 * bridge. It answers the same /v1 routes with the same shapes and error codes as the real
 * bridge, keeps a change journal for /v1/changes, and simulates a live team: replies stream in,
 * approvals unblock agents, shutdowns are accepted or declined, tasks notify their owners.
 */

export interface MockAgent {
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
  turn: { turnId: string; startedAt: number } | null;
  /** The user's queued message ids, in the order the agent will read them. */
  queue: string[];
  backgroundQueue: number;
  shutdown: AgentShutdown;
  lastActivityAt: number;
}

export interface MockConversation {
  conversationId: string;
  name: string;
  kind: 'solo' | 'team_member';
  teamId?: string;
  slotId?: string;
  backend: string;
  model?: string;
  workspace?: string;
  state: ConversationState;
  /** createdAt of the newest message the user has read. */
  readUpTo: number;
  /** `rev`: the sync counter when the row was last inserted or changed. */
  messages: (Message & { rev: number })[];
  updatedAt: number;
}

export interface MockTeam {
  teamId: string;
  name: string;
  workspace: string;
  sessionStatus: SessionStatus;
  activeRun: RunState['activeRun'];
  agents: MockAgent[];
  tasks: Task[];
  broadcasts: Broadcast[];
  activity: Activity[];
}

export interface FacadeRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface FacadeResponse {
  status: number;
  body?: unknown;
}

/** The demo transport's fixed "session" (the re-key proof binds it, §5.3). */
export const DEMO_SESSION_ID = new Uint8Array(16).fill(7);
/** The demo PC always has an open re-key offer with this secret, so the §15.3 flow can be tried. */
export const DEMO_REKEY_SECRET = new Uint8Array(32).fill(9);

export interface MockFacadeOptions {
  hostId?: string;
  hostName?: string;
  deviceId?: string;
  capabilities?: string[];
  /** The PC's "Require confirmation" for this phone (contract §5). Default on. */
  requireConfirm?: boolean;
  /** Simulated agent work speed; tests pass small values. */
  replyDelayMs?: number;
}

export interface MockFacade {
  handle(req: FacadeRequest): Promise<FacadeResponse>;
  /** §5.1: would the real bridge require a confirm proof for this request? */
  isSensitive(req: FacadeRequest): boolean;
  /** Cancels the simulation timers (tests). */
  dispose(): void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = '',
    readonly details?: Record<string, unknown>,
  ) {
    super(message || code);
  }
}

function fail(status: number, code: string, message?: string, details?: Record<string, unknown>): never {
  throw new HttpError(status, code, message, details);
}

const MAX_TEXT = 2000;
const JOURNAL_LIMIT = 5000;
const CHANGES_LIMIT = 500;
const PAGE_DEFAULT = 50;
const ATTENTION_ORDER: Attention[] = ['needs_answer', 'needs_approval', 'error', 'your_turn', 'none'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, field: string, { optional = false, max = MAX_TEXT } = {}): string | undefined => {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.trim()) fail(400, 'invalid_request', `${field} must be non-blank text`);
  if ((v as string).length > max) fail(400, 'invalid_request', `${field} is longer than ${max} characters`);
  return v as string;
};

export function createMockFacade(opts: MockFacadeOptions = {}): MockFacade {
  const hostId = opts.hostId ?? 'demo';
  const deviceId = opts.deviceId ?? 'demo-device';
  const replyDelay = opts.replyDelayMs ?? 4000;
  const capabilities = opts.capabilities ?? ['changes.longpoll', 'tasks.write', 'approvals.questions'];
  const requireConfirm = opts.requireConfirm ?? true;

  const state = seed(Date.now());
  const { teams } = state;
  const conversations = new Map(state.conversations.map((c) => [c.conversationId, c]));
  let approvals = state.approvals;

  /** Simulation timers, tagged with the conversation they belong to so a stop cancels only that turn. */
  const timers = new Map<ReturnType<typeof setTimeout>, string | undefined>();
  const later = (ms: number, fn: () => void, conversationId?: string) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.set(t, conversationId);
  };
  const cancelTimers = (conversationId: string) => {
    for (const [t, owner] of timers) {
      if (owner !== conversationId) continue;
      clearTimeout(t);
      timers.delete(t);
    }
  };

  let idCounter = 1000;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const newTaskId = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

  // -------------------------------------------------------------------------
  // Change journal (§6.2)
  // -------------------------------------------------------------------------

  const epoch = hex(6);
  let rev = 0;
  let msgRev = 1;
  const journal: { rev: number; entry: ChangeEntry }[] = [];
  const waiters = new Set<() => void>();

  function emit(entry: ChangeEntry) {
    journal.push({ rev: ++rev, entry });
    if (journal.length > JOURNAL_LIMIT) journal.splice(0, journal.length - JOURNAL_LIMIT);
    for (const wake of [...waiters]) wake();
  }
  const emitTeam = (t: MockTeam, ...what: ('roster' | 'run_state' | 'meta')[]) => emit({ kind: 'team', teamId: t.teamId, what });
  const emitConv = (c: MockConversation, ...what: ('messages' | 'state' | 'meta' | 'read')[]) =>
    emit({ kind: 'conversation', conversationId: c.conversationId, teamId: c.teamId, slotId: c.slotId, what });

  /** At most one entry per (kind, id) since `since`, newest state wins, `what` lists merged. */
  function changesSince(since: number): { changes: ChangeEntry[]; more: boolean; upTo: number } {
    const pending = journal.filter((j) => j.rev > since);
    const byKey = new Map<string, ChangeEntry>();
    let upTo = since;
    for (const { rev: r, entry } of pending) {
      const key = changeKey(entry);
      if (!byKey.has(key) && byKey.size >= CHANGES_LIMIT) return { changes: [...byKey.values()], more: true, upTo };
      const prev = byKey.get(key);
      if (prev && 'what' in prev && 'what' in entry) {
        byKey.set(key, { ...entry, what: [...new Set([...prev.what, ...entry.what])] } as ChangeEntry);
      } else if (prev?.kind === 'task' && entry.kind === 'task') {
        byKey.set(key, { ...entry, change: prev.change === 'created' ? 'created' : entry.change });
      } else {
        byKey.delete(key); // re-insert so the coalesced entry keeps its latest position
        byKey.set(key, entry);
      }
      upTo = r;
    }
    return { changes: [...byKey.values()], more: false, upTo };
  }

  function changeKey(e: ChangeEntry): string {
    switch (e.kind) {
      case 'team':
      case 'team_removed':
        return `${e.kind}:${e.teamId}`;
      case 'conversation':
      case 'conversation_removed':
        return `${e.kind}:${e.conversationId}`;
      case 'approval_added':
        return `approval:${e.approval.approvalId}`;
      case 'approval_removed':
        return `approval:${e.approvalId}`;
      case 'task':
        return `task:${e.teamId}:${e.task.taskId}`;
      case 'broadcast':
        return `broadcast:${e.broadcastId}`;
    }
  }

  async function getChanges(sinceToken: string | undefined, waitSec: number) {
    const token = () => `${epoch}.${rev}`;
    if (!sinceToken) return { token: token(), reset: false, more: false, changes: [] };
    const [e, r] = sinceToken.split('.');
    const since = Number(r);
    const oldest = journal[0]?.rev ?? rev + 1;
    if (e !== epoch || !Number.isInteger(since) || since > rev || (since < oldest - 1 && journal.length > 0)) {
      return { token: token(), reset: true, more: false, changes: [] };
    }
    if (waitSec > 0 && !journal.some((j) => j.rev > since)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          waiters.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, waitSec * 1000);
        waiters.add(done);
      });
    }
    const { changes, more, upTo } = changesSince(since);
    return { token: `${epoch}.${upTo}`, reset: false, more, changes };
  }

  // -------------------------------------------------------------------------
  // Lookups and projections
  // -------------------------------------------------------------------------

  const findTeam = (teamId: string) => teams.find((t) => t.teamId === teamId) ?? fail(404, 'not_found', 'No such team');
  const findAgent = (t: MockTeam, slotId: string) => t.agents.find((a) => a.slotId === slotId) ?? fail(404, 'not_found', 'No such agent');
  const findConv = (cid: string) => conversations.get(cid) ?? fail(404, 'not_found', 'No such conversation');
  const findTask = (t: MockTeam, taskId: string) => t.tasks.find((x) => x.taskId === taskId) ?? fail(404, 'not_found', 'No such task');
  const teamOfConv = (c: MockConversation) => (c.teamId ? teams.find((t) => t.teamId === c.teamId) : undefined);
  const agentOfConv = (c: MockConversation) => teamOfConv(c)?.agents.find((a) => a.slotId === c.slotId);

  const isUnreadRow = (m: Message, c: MockConversation) => m.role === 'agent' && m.type === 'text' && m.status === 'done' && m.createdAt > c.readUpTo;
  const unreadOf = (c: MockConversation) => Math.min(99, c.messages.filter((m) => isUnreadRow(m, c)).length);

  function lastMessageOf(c: MockConversation): LastMessage | null {
    const m = [...c.messages].reverse().find((x) => x.type !== 'other');
    if (!m) return null;
    const senderName = m.sender.kind === 'agent' || m.sender.kind === 'teammate' ? m.sender.name : null;
    const preview = m.type === 'tool_call' ? `Used ${m.tool?.title ?? m.tool?.name ?? 'a tool'}` : (m.error?.message ?? m.text ?? '');
    return { messageId: m.messageId, role: m.role, senderName, text: preview.slice(0, 200), createdAt: m.createdAt };
  }

  function attentionOf(c: MockConversation, a?: MockAgent): Attention {
    const pending = approvals.filter((x) => x.conversationId === c.conversationId);
    if (pending.some((x) => x.kind === 'question')) return 'needs_answer';
    if (pending.length > 0) return 'needs_approval';
    if (a && (a.runtime === 'failed' || a.blockedReason === 'runtime_failed')) return 'error';
    // your_turn: solo chats and the lead only (§6.3).
    if (!a || a.role === 'lead') {
      const busy = a ? a.state !== 'idle' : c.state !== 'idle';
      const lastAgent = [...c.messages].reverse().find((m) => m.role === 'agent');
      const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
      if (!busy && lastAgent && lastAgent.createdAt > (lastUser?.createdAt ?? 0) && lastAgent.createdAt > c.readUpTo) return 'your_turn';
    }
    return 'none';
  }

  function projectAgent(t: MockTeam, a: MockAgent): Agent {
    const c = conversations.get(a.conversationId);
    const attention = c ? attentionOf(c, a) : 'none';
    const owned = t.tasks.filter((x) => x.owner === a.slotId);
    const current = owned.filter((x) => x.status === 'in_progress').sort((x, y) => y.updatedAt - x.updatedAt)[0];
    const now = Date.now();
    return {
      slotId: a.slotId,
      name: a.name,
      role: a.role,
      conversationId: a.conversationId,
      backend: a.backend,
      model: a.model,
      icon: a.icon,
      state: a.state,
      blockedReason: a.blockedReason,
      runtime: a.runtime,
      turn: a.turn && {
        turnId: a.turn.turnId,
        startedAt: a.turn.startedAt,
        elapsedMs: now - a.turn.startedAt,
        slow: now - a.turn.startedAt >= 10 * 60_000,
        slowThresholdMs: 10 * 60_000,
      },
      queue: { foreground: a.queue.length, background: a.backgroundQueue, foregroundMessageIds: [...a.queue] },
      pendingApprovals: approvals.filter((x) => x.conversationId === a.conversationId).length,
      attention,
      waitingOnUser: attention === 'needs_answer' || attention === 'needs_approval',
      unread: c ? unreadOf(c) : 0,
      shutdown: a.shutdown && { ...a.shutdown },
      currentTask: current ? { taskId: current.taskId, subject: current.subject } : null,
      openTaskCount: owned.filter((x) => x.status === 'pending' || x.status === 'in_progress').length,
      lastMessage: c ? lastMessageOf(c) : null,
      lastActivityAt: a.lastActivityAt,
    };
  }

  const runState = (t: MockTeam): RunState => ({
    teamId: t.teamId,
    sessionStatus: t.sessionStatus,
    activeRun: t.activeRun && { ...t.activeRun },
    agents: t.agents.map((a) => projectAgent(t, a)),
  });

  function teamSummary(t: MockTeam): TeamSummary {
    const agents = t.agents.map((a) => projectAgent(t, a));
    const attention = ATTENTION_ORDER.find((x) => agents.some((a) => a.attention === x)) ?? 'none';
    return {
      teamId: t.teamId,
      name: t.name,
      workspace: t.workspace,
      leadSlotId: t.agents.find((a) => a.role === 'lead')?.slotId ?? '',
      agentCount: t.agents.length,
      attention,
      waitingOnUser: agents.some((a) => a.waitingOnUser),
      unread: Math.min(99, agents.reduce((n, a) => n + a.unread, 0)),
      updatedAt: Math.max(0, ...agents.map((a) => a.lastActivityAt)),
    };
  }

  function projectConversation(c: MockConversation): Conversation {
    const a = agentOfConv(c);
    const attention = attentionOf(c, a);
    return {
      conversationId: c.conversationId,
      name: c.name,
      kind: c.kind,
      teamId: c.teamId,
      slotId: c.slotId,
      backend: c.backend,
      model: c.model,
      workspace: c.workspace,
      state: c.state,
      attention,
      waitingOnUser: attention === 'needs_answer' || attention === 'needs_approval',
      unread: unreadOf(c),
      lastMessage: lastMessageOf(c),
      updatedAt: c.updatedAt,
    };
  }

  const stripRev = ({ rev: _rev, ...m }: Message & { rev: number }): Message => ({ ...m });

  function withOwnerName(t: MockTeam, task: Task): Task {
    const ownerName = task.owner === 'user' ? 'You' : task.owner ? (t.agents.find((a) => a.slotId === task.owner)?.name ?? null) : null;
    return { ...task, ownerName, blockedBy: [...task.blockedBy], blocks: [...task.blocks] };
  }

  /** Change entries and write responses carry `assignment: null` (contract §6.7, rev 4.4). */
  const asWritten = (t: MockTeam, task: Task): Task => ({ ...withOwnerName(t, task), assignment: null });

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  function addMessage(c: MockConversation, m: Omit<Message, 'conversationId'>) {
    const row = { ...m, conversationId: c.conversationId, rev: msgRev++ };
    c.messages.push(row);
    c.updatedAt = Math.max(c.updatedAt, m.createdAt);
    return row;
  }

  function updateMessage(c: MockConversation, messageId: string, patch: Partial<Message>) {
    const row = c.messages.find((m) => m.messageId === messageId);
    if (row) Object.assign(row, patch, { rev: msgRev++ });
  }

  function touch(t: MockTeam | undefined, c: MockConversation, convWhat: ('messages' | 'state')[] = ['messages']) {
    emitConv(c, ...convWhat);
    if (t) emitTeam(t, 'run_state');
  }

  /** One simulated agent turn: running → a streamed reply → idle, consuming the user's queue. */
  function runTurn(c: MockConversation, reply: string) {
    const t = teamOfConv(c);
    const a = agentOfConv(c);
    const turnId = nextId('turn');
    if (a) {
      a.state = 'running';
      a.runtime = 'ready';
      a.blockedReason = null;
      a.turn = { turnId, startedAt: Date.now() };
      a.lastActivityAt = Date.now();
      if (t) t.activeRun = { runId: nextId('run'), status: 'running', targetSlotId: a.slotId, source: 'user_message' };
    }
    c.state = 'running';
    touch(t, c, ['state']);

    const replyId = nextId('m');
    const name = a?.name ?? 'Claude';
    later(Math.round(replyDelay * 0.4), () => {
      addMessage(c, { messageId: replyId, turnId, role: 'agent', sender: { kind: 'agent', name }, type: 'text', status: 'streaming', text: reply.slice(0, Math.ceil(reply.length / 2)), createdAt: Date.now() });
      touch(t, c);
    }, c.conversationId);
    later(replyDelay, () => {
      updateMessage(c, replyId, { text: reply, status: 'done' });
      // Messages delivered mid-turn have now been read.
      for (const m of c.messages) if (m.role === 'user' && m.status === 'pending') updateMessage(c, m.messageId, { status: 'done' });
      c.state = 'idle';
      if (a) {
        a.queue = [];
        a.turn = null;
        a.state = 'idle';
        a.lastActivityAt = Date.now();
      }
      if (t?.activeRun?.targetSlotId === a?.slotId && t) t.activeRun = null;
      touch(t, c, ['messages', 'state']);
    }, c.conversationId);
  }

  function deliver(c: MockConversation, content: string, priority: 'normal' | 'now' = 'normal'): { messageId: string; delivery: Delivery } {
    const t = teamOfConv(c);
    const a = agentOfConv(c);
    if (t && t.sessionStatus !== 'ready') startSession(t);
    const busy = a ? a.state === 'running' || a.state === 'starting' : c.state === 'running';
    const delivery: Delivery = busy ? (priority === 'now' ? 'midturn' : a ? 'queued' : 'midturn') : 'started';
    const m = addMessage(c, {
      messageId: nextId('m'),
      role: 'user',
      sender: { kind: 'user' },
      type: 'text',
      status: delivery === 'midturn' ? 'pending' : 'done',
      text: content,
      createdAt: Date.now(),
    });
    c.readUpTo = Math.max(c.readUpTo, m.createdAt);
    if (delivery === 'queued' && a) a.queue.push(m.messageId);
    touch(t, c);
    if (delivery === 'started') runTurn(c, `Got it — "${content.slice(0, 60)}". Working on it now.`);
    return { messageId: m.messageId, delivery };
  }

  function startSession(t: MockTeam) {
    if (t.sessionStatus === 'ready' || t.sessionStatus === 'starting') return;
    t.sessionStatus = 'starting';
    for (const a of t.agents) if (a.blockedReason === 'session_stopped') a.blockedReason = 'runtime_starting';
    emitTeam(t, 'run_state');
    later(Math.round(replyDelay / 2), () => {
      t.sessionStatus = 'ready';
      for (const a of t.agents) {
        if (a.blockedReason === 'runtime_starting') a.blockedReason = null;
        if (a.runtime === 'dormant') a.runtime = 'ready';
      }
      emitTeam(t, 'run_state');
    });
  }

  function removeAgent(t: MockTeam, a: MockAgent) {
    t.agents = t.agents.filter((x) => x !== a);
    const c = conversations.get(a.conversationId);
    for (const ap of approvals.filter((x) => x.conversationId === a.conversationId)) removeApproval(ap, 'cancelled');
    emitTeam(t, 'roster', 'run_state');
    if (c) {
      conversations.delete(c.conversationId);
      emit({ kind: 'conversation_removed', conversationId: c.conversationId });
    }
    // Tasks keep the slot id; ownerName becomes null ("Removed agent").
    for (const task of t.tasks.filter((x) => x.owner === a.slotId)) emit({ kind: 'task', teamId: t.teamId, task: asWritten(t, task), change: 'updated' });
  }

  function removeApproval(ap: Approval, resolution: 'answered' | 'cancelled') {
    approvals = approvals.filter((x) => x !== ap);
    emit({ kind: 'approval_removed', approvalId: ap.approvalId, conversationId: ap.conversationId, teamId: ap.teamId, resolution });
  }

  /** §6.7: notify-and-wake a live, non-lead teammate owner of an unblocked, open task. */
  function notifyOwner(t: MockTeam, task: Task) {
    if (!task.owner || task.owner === 'user' || task.owner === '*') return;
    const a = t.agents.find((x) => x.slotId === task.owner);
    if (!a || a.role === 'lead' || task.status === 'completed' || task.status === 'deleted') return;
    const open = task.blockedBy.some((id) => {
      const dep = t.tasks.find((x) => x.taskId === id);
      return dep && dep.status !== 'completed' && dep.status !== 'deleted';
    });
    if (open) return;
    const c = conversations.get(a.conversationId);
    if (!c) return;
    const content = `📋 Task assigned to you (#${task.taskId}): ${task.subject}`;
    const m = addMessage(c, { messageId: nextId('m'), role: 'user', sender: { kind: 'user' }, type: 'text', status: 'done', text: content, notice: { kind: 'task_assigned', taskId: task.taskId }, createdAt: Date.now() });
    task.assignment = { conversationId: c.conversationId, messageId: m.messageId, createdAt: m.createdAt };
    t.activity.unshift({
      kind: 'message',
      activityId: nextId('act'),
      createdAt: m.createdAt,
      message: {
        messageId: m.messageId,
        from: { slotId: null, name: 'You', isUser: true },
        to: { slotId: a.slotId, name: a.name, isUser: false },
        msgType: 'message',
        content,
        summary: null,
        read: false,
        notice: { kind: 'task_assigned', taskId: task.taskId },
      },
    });
    touch(t, c);
    if (a.state === 'idle') runTurn(c, `Picking up "${task.subject}".`);
  }

  function recordTask(t: MockTeam, task: Task, change: 'created' | 'updated') {
    t.activity.unshift({ kind: 'task', activityId: nextId('act'), createdAt: Date.now(), task: withOwnerName(t, task) });
    emit({ kind: 'task', teamId: t.teamId, task: asWritten(t, task), change });
    emitTeam(t, 'run_state'); // currentTask / openTaskCount
  }

  function setBlockedBy(t: MockTeam, task: Task, blockedBy: string[]) {
    for (const id of blockedBy) if (!t.tasks.some((x) => x.taskId === id)) fail(400, 'invalid_request', `Unknown task ${id}`);
    task.blockedBy = [...new Set(blockedBy)];
    // Keep the reverse links consistent, as the real board does.
    for (const other of t.tasks) {
      const blocks = task.blockedBy.includes(other.taskId);
      const listed = other.blocks.includes(task.taskId);
      if (blocks && !listed) other.blocks.push(task.taskId);
      if (!blocks && listed) other.blocks = other.blocks.filter((id) => id !== task.taskId);
    }
  }

  // -------------------------------------------------------------------------
  // Approvals (§6.5)
  // -------------------------------------------------------------------------

  function answer(ap: Approval, raw: unknown) {
    if (!isRecord(raw)) fail(400, 'invalid_request', 'Body must be an object');
    const body = raw as Record<string, unknown>;
    const shapes = ['optionId', 'decision', 'answers', 'decline'].filter((k) => body[k] !== undefined);
    if (shapes.length !== 1) fail(400, 'invalid_request', 'Send exactly one of optionId, decision, answers or decline');
    const message = text(body.message, 'message', { optional: true });

    let refusal = false;
    let reply = '';
    if (ap.kind === 'permission') {
      let option: ApprovalOption | undefined;
      if (typeof body.optionId === 'string') {
        option = ap.options.find((o) => o.optionId === body.optionId);
        // Never pass an unknown option through: the Claude backend reads it as APPROVE.
        if (!option) fail(400, 'invalid_request', 'Unknown optionId');
      } else if (body.decision === 'allow_once' || body.decision === 'allow_always' || body.decision === 'deny') {
        const kind = body.decision === 'deny' ? 'reject_once' : body.decision;
        const matches = ap.options.filter((o) => o.kind === kind);
        if (matches.length !== 1) fail(422, 'ambiguous_decision', 'The decision matches more than one option', { options: ap.options });
        option = matches[0];
      } else {
        fail(400, 'invalid_request', 'A permission needs an optionId or a decision');
      }
      refusal = option.kind.startsWith('reject_');
      reply = refusal ? `Okay, I won't run ${ap.title ?? 'that'}.` : `Thanks — ran ${ap.title ?? 'it'}. Continuing.`;
    } else {
      if (body.decline === true) {
        refusal = true;
        reply = "No problem, I'll continue without an answer.";
      } else if (Array.isArray(body.answers)) {
        refusal = false;
        for (const a of body.answers as unknown[]) {
          const q = isRecord(a) ? ap.questions?.find((x) => x.question === a.question) : undefined;
          if (!q || !isRecord(a) || !Array.isArray(a.labels) || a.labels.length === 0) fail(400, 'invalid_request', 'Each answer needs a known question and labels');
          const labels = (a as { labels: unknown[] }).labels;
          const free = labels.filter((l) => typeof l !== 'string' || !q!.options.some((o) => o.label === l));
          if (free.length > (ap.freeText ? 1 : 0)) fail(400, 'invalid_request', 'Only the offered labels are allowed');
          for (const l of free) text(l, 'answer');
        }
        const firstAnswer = (body.answers as { labels: string[] }[])[0]?.labels.join(', ');
        reply = `Thanks — going with ${firstAnswer}.`;
      } else {
        fail(400, 'invalid_request', 'A question needs answers or decline');
      }
    }
    if (message && !refusal) fail(400, 'invalid_request', 'A message is only accepted with a refusal');

    removeApproval(ap, 'answered');
    const c = conversations.get(ap.conversationId);
    let messageDelivery: 'native' | 'followup' | null = null;
    if (c && message) {
      // Claude and aionrs carry the reason natively; ACP and Codex get a follow-up message (§6.5).
      if (c.backend === 'claude' || c.backend === 'aionrs') {
        messageDelivery = 'native';
      } else {
        messageDelivery = 'followup';
        addMessage(c, { messageId: nextId('m'), role: 'user', sender: { kind: 'user' }, type: 'text', status: 'done', text: `Denied ${ap.title ?? ap.toolName ?? 'request'}: ${message}`, createdAt: Date.now() });
      }
    }
    if (c) {
      c.state = 'running';
      touch(teamOfConv(c), c, ['state']);
      runTurn(c, reply);
    }
    return { resolved: true, messageDelivery };
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  function parse(path: string): { segs: string[]; q: URLSearchParams } {
    const [p, qs = ''] = path.split('?');
    return { segs: p.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs) };
  }

  const limitOf = (q: URLSearchParams) => Math.min(200, Math.max(1, Number(q.get('limit')) || PAGE_DEFAULT));

  async function route(method: string, path: string, body: unknown): Promise<unknown> {
    const { segs, q } = parse(path);
    if (segs[0] !== 'v1') return fail(404, 'no_such_route');
    const [, r1, r2, r3, r4, r5, r6] = segs;
    const m = method.toUpperCase();
    const b = isRecord(body) ? body : {};

    // §6.1 Host
    if (r1 === 'host' && !r2 && m === 'GET') {
      return {
        hostId,
        hostName: opts.hostName ?? 'DEMO-PC',
        appVersion: '0.26.0',
        coreVersion: '0.2.2',
        bridgeVersion: 1,
        serverTime: Date.now(),
        device: { deviceId, name: 'This phone', pairedAt: 0, requireConfirm, confirmMode: 'biometric' },
        capabilities,
      };
    }
    if (r1 === 'host' && r2 === 'device' && !r3 && m === 'DELETE') return {};
    if (r1 === 'host' && r2 === 'device' && r3 === 'confirm-key' && m === 'POST') {
      const expected = rekeyProof(DEMO_REKEY_SECRET, DEMO_SESSION_ID, deviceId);
      if (typeof b.proof !== 'string') fail(400, 'invalid_request', 'proof is required');
      if (b.proof !== expected) fail(403, 'rekey_invalid', "The code didn't match");
      // A fresh 32-byte key; the demo phone never uses its bytes, only the fact it has one.
      return { confirmKey: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA' };
    }

    // §6.2 Changes
    if (r1 === 'changes' && m === 'GET') {
      const wait = Math.max(0, Math.min(25, Number(q.get('wait')) || 0));
      return getChanges(q.get('since') ?? undefined, wait);
    }

    // §6.3 Teams
    if (r1 === 'teams' && !r2 && m === 'GET') return teams.map(teamSummary);
    if (r1 === 'teams' && r2) {
      const t = findTeam(r2);
      if (r3 === 'run-state' && m === 'GET') return runState(t);
      if (r3 === 'session' && !r4 && m === 'POST') {
        startSession(t);
        return runState(t);
      }
      if (r3 === 'agents' && !r4 && m === 'POST') return spawn(t, b);
      if (r3 === 'agents' && r4) {
        const a = findAgent(t, r4);
        if (!r5 && m === 'GET') return projectAgent(t, a);
        if (!r5 && m === 'PATCH') {
          a.name = text(b.name, 'name', { max: 60 })!;
          const c = conversations.get(a.conversationId);
          if (c) {
            c.name = a.name;
            emitConv(c, 'meta');
          }
          emitTeam(t, 'roster');
          return projectAgent(t, a);
        }
        if (!r5 && m === 'DELETE') {
          if (a.role === 'lead') fail(422, 'lead_not_allowed', 'The lead cannot be removed');
          removeAgent(t, a);
          return { removed: true };
        }
        if (r5 === 'wake' && m === 'POST') {
          if (a.runtime === 'failed' || a.runtime === 'dormant') {
            a.runtime = 'pending';
            a.blockedReason = 'runtime_starting';
            a.state = 'blocked';
            emitTeam(t, 'run_state');
            later(Math.round(replyDelay / 2), () => {
              a.runtime = 'ready';
              a.blockedReason = null;
              a.state = 'idle';
              emitTeam(t, 'run_state');
            });
          }
          const c = conversations.get(a.conversationId);
          if (typeof b.nudge === 'string' && b.nudge.trim() && c) deliver(c, b.nudge);
          else if (a.queue.length > 0 && c && a.state === 'idle') runTurn(c, 'Catching up on your messages now.');
          return { runtime: a.runtime };
        }
        if (r5 === 'stop' && m === 'POST') {
          const replacement = text(b.replacementMessage, 'replacementMessage', { optional: true });
          if (replacement && a.role === 'lead') fail(422, 'lead_not_allowed', 'Stop with a replacement is not available for the lead');
          if (!a.turn) return { outcome: 'no_active_turn' };
          cancelTimers(a.conversationId);
          a.turn = null;
          a.state = 'idle';
          if (t.activeRun?.targetSlotId === a.slotId) t.activeRun = null;
          const c = conversations.get(a.conversationId);
          if (c) {
            c.state = 'idle';
            for (const msg of c.messages) if (msg.status === 'streaming') updateMessage(c, msg.messageId, { status: 'done' });
            touch(t, c, ['messages', 'state']);
            if (replacement) deliver(c, replacement);
          }
          return { outcome: replacement ? 'interrupted' : 'cancelled' };
        }
        if (r5 === 'shutdown' && m === 'POST') {
          if (a.role === 'lead') fail(422, 'lead_not_allowed', 'The lead cannot be shut down');
          const reason = text(b.reason, 'reason', { optional: true, max: 200 }) ?? null;
          const requestedAt = Date.now();
          a.shutdown = { state: 'requested', requestedAt, reason };
          emitTeam(t, 'run_state');
          later(Math.round(replyDelay * 0.75), () => {
            if (!t.agents.includes(a)) return;
            // The Researcher declines (exercises the rejected path); everyone else accepts.
            if (a.slotId === 'research') {
              a.shutdown = { state: 'rejected', requestedAt, respondedAt: Date.now(), rejectReason: "I'm still collecting sources for the bridge review." };
              emitTeam(t, 'run_state');
              return;
            }
            a.shutdown = { state: 'approved', requestedAt, respondedAt: Date.now() };
            a.blockedReason = 'removing';
            emitTeam(t, 'run_state');
            later(1000, () => t.agents.includes(a) && removeAgent(t, a));
          });
          return { outcome: 'requested' };
        }
        if (r5 === 'clear-context' && m === 'POST') {
          const c = conversations.get(a.conversationId);
          const preservedUnread = c ? unreadOf(c) : 0;
          if (c) {
            addMessage(c, { messageId: nextId('m'), role: 'system', sender: { kind: 'team_system' }, type: 'text', status: 'done', text: 'Context cleared', notice: { kind: 'context_reset' }, createdAt: Date.now() });
            touch(t, c);
          }
          return { preservedUnread };
        }
      }
      if (r3 === 'broadcast' && m === 'POST') return broadcast(t, text(b.content, 'content')!);
      if (r3 === 'broadcasts' && m === 'GET') {
        const limit = limitOf(q);
        const start = Number(q.get('cursor')) || 0;
        const all = [...t.broadcasts].sort((x, y) => y.createdAt - x.createdAt);
        const items = all.slice(start, start + limit);
        return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
      }
      if (r3 === 'tasks') return tasksRoute(t, m, r4, b, q);
      if (r3 === 'activity' && m === 'GET') return activity(t, q);
    }

    // §6.4 Conversations
    if (r1 === 'conversations' && !r2 && m === 'GET') {
      const limit = limitOf(q);
      const start = Number(q.get('cursor')) || 0;
      const solo = [...conversations.values()].filter((c) => c.kind === 'solo' && (q.get('kind') ?? 'solo') === 'solo').sort((x, y) => y.updatedAt - x.updatedAt);
      return { items: solo.slice(start, start + limit).map(projectConversation), nextCursor: start + limit < solo.length ? String(start + limit) : null };
    }
    if (r1 === 'conversations' && !r2 && m === 'POST') {
      const exactlyOne = (typeof b.assistantId === 'string') !== (typeof b.backend === 'string');
      if (!exactlyOne) fail(400, 'invalid_request', 'Send exactly one of assistantId or backend');
      if (b.workspace !== undefined && !workspaces().some((w) => w.path === b.workspace)) fail(400, 'invalid_request', 'Unknown workspace');
      const c: MockConversation = {
        conversationId: nextId('solo'),
        name: typeof b.name === 'string' && b.name.trim() ? b.name : 'New chat',
        kind: 'solo',
        backend: typeof b.backend === 'string' ? b.backend : 'claude',
        model: typeof b.model === 'string' ? b.model : undefined,
        workspace: typeof b.workspace === 'string' ? b.workspace : 'C:\\Users\\demo\\AppData\\Local\\Temp\\aiondx-chat',
        state: 'idle',
        readUpTo: 0,
        messages: [],
        updatedAt: Date.now(),
      };
      conversations.set(c.conversationId, c);
      emitConv(c, 'meta');
      return projectConversation(c);
    }
    if (r1 === 'workspaces' && m === 'GET') return workspaces();
    if (r1 === 'conversations' && r2) {
      const c = findConv(r2);
      if (!r3 && m === 'GET') return projectConversation(c);
      if (r3 === 'messages' && m === 'GET') return messages(c, q);
      if (r3 === 'messages' && m === 'POST') {
        const priority = b.priority === 'now' ? 'now' : 'normal';
        return deliver(c, text(b.content, 'content', { max: 100_000 })!, priority);
      }
      if (r3 === 'read' && m === 'POST') {
        const upTo = c.messages.find((x) => x.messageId === b.upToMessageId);
        if (!upTo) fail(400, 'invalid_request', 'Unknown upToMessageId');
        if (upTo!.createdAt > c.readUpTo) {
          c.readUpTo = upTo!.createdAt;
          touch(teamOfConv(c), c, ['state']);
          emitConv(c, 'read');
        }
        return {};
      }
    }

    // §6.5 Approvals
    if (r1 === 'approvals' && !r2 && m === 'GET') {
      const teamId = q.get('teamId');
      return { items: approvals.filter((a) => !teamId || a.teamId === teamId) };
    }
    if (r1 === 'approvals' && r2 && r3 === 'answer' && m === 'POST') {
      const ap = approvals.find((a) => a.approvalId === r2);
      if (!ap) fail(409, 'already_resolved', 'Already answered on the PC or another device');
      return answer(ap!, body);
    }

    // §6.6 Assistants
    if (r1 === 'assistants' && m === 'GET') return ASSISTANTS;

    void r6;
    return fail(404, 'no_such_route');
  }

  function spawn(t: MockTeam, b: Record<string, unknown>) {
    const assistant = ASSISTANTS.find((x) => x.assistantId === b.assistantId) ?? fail(400, 'invalid_request', 'Unknown assistantId');
    const name = text(b.name, 'name', { optional: true, max: 60 }) ?? assistant.name;
    if (t.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) fail(409, 'conflict', 'That name is already used in this team');
    const slotId = nextId('slot');
    const a: MockAgent = {
      slotId,
      name,
      role: 'teammate',
      conversationId: `conv-${slotId}`,
      backend: assistant.backend,
      model: typeof b.model === 'string' ? b.model : 'sonnet',
      icon: null,
      state: 'starting',
      blockedReason: 'runtime_starting',
      runtime: 'pending',
      turn: null,
      queue: [],
      backgroundQueue: 0,
      shutdown: null,
      lastActivityAt: Date.now(),
    };
    t.agents.push(a);
    conversations.set(a.conversationId, { conversationId: a.conversationId, name, kind: 'team_member', teamId: t.teamId, slotId, backend: a.backend, model: a.model, state: 'idle', readUpTo: 0, messages: [], updatedAt: Date.now() });
    emitTeam(t, 'roster', 'run_state');
    later(Math.round(replyDelay * 1.25), () => {
      a.state = 'idle';
      a.runtime = 'ready';
      a.blockedReason = null;
      emitTeam(t, 'run_state');
    });
    return projectAgent(t, a);
  }

  function broadcast(t: MockTeam, content: string): Broadcast {
    const deliveries = t.agents.map((a) => {
      const c = conversations.get(a.conversationId);
      if (!c || a.runtime === 'failed') return { slotId: a.slotId, messageId: null, delivery: 'failed' as const, error: 'Agent runtime failed to start' };
      const sent = deliver(c, content);
      return { slotId: a.slotId, messageId: sent.messageId, delivery: sent.delivery };
    });
    const record: Broadcast = {
      broadcastId: nextId('b'),
      teamId: t.teamId,
      content,
      createdAt: Date.now(),
      sentFrom: { kind: 'mobile', deviceId, deviceName: 'This phone' },
      deliveries,
    };
    t.broadcasts.push(record);
    emit({ kind: 'broadcast', teamId: t.teamId, broadcastId: record.broadcastId });
    return record;
  }

  function messages(c: MockConversation, q: URLSearchParams) {
    const limit = limitOf(q);
    const before = q.get('before');
    if (before !== null) {
      const end = Math.max(0, Math.min(c.messages.length, Number(before.replace(/^b/, '')) || 0));
      const start = Math.max(0, end - limit);
      return { items: c.messages.slice(start, end).map(stripRev), before: start > 0 ? `b${start}` : null };
    }
    const since = q.get('since');
    const cursor = `c${msgRev - 1}`;
    if (since === null) {
      const start = Math.max(0, c.messages.length - limit);
      // A page that isn't the start also reports where older history continues, via `before` on the next call.
      return { items: c.messages.slice(start).map(stripRev), cursor, reset: false, hasMore: false, before: start > 0 ? `b${start}` : null };
    }
    const sinceRev = Number(since.replace(/^c/, ''));
    if (!Number.isInteger(sinceRev) || sinceRev >= msgRev) {
      const start = Math.max(0, c.messages.length - limit);
      return { items: c.messages.slice(start).map(stripRev), cursor, reset: true, hasMore: false };
    }
    const changed = c.messages.filter((x) => x.rev > sinceRev).sort((x, y) => x.rev - y.rev);
    const page = changed.slice(0, limit);
    const hasMore = changed.length > limit;
    return { items: page.map(stripRev), cursor: hasMore ? `c${page.at(-1)!.rev}` : cursor, reset: false, hasMore };
  }

  function tasksRoute(t: MockTeam, m: string, taskId: string | undefined, b: Record<string, unknown>, q: URLSearchParams) {
    if (!taskId && m === 'GET') {
      const statuses = q.get('status')?.split(',').filter(Boolean);
      const owner = q.get('owner');
      return t.tasks
        .filter((x) => (!statuses || statuses.includes(x.status)) && (!owner || x.owner === owner))
        .sort((x, y) => y.updatedAt - x.updatedAt)
        .map((x) => withOwnerName(t, x));
    }
    if (!capabilities.includes('tasks.write') && m !== 'GET') fail(404, 'no_such_route', 'Task writes are turned off on this PC');
    if (!taskId && m === 'POST') {
      const owner = b.owner === undefined || b.owner === null ? null : String(b.owner);
      if (owner && owner !== 'user' && !t.agents.some((a) => a.slotId === owner)) fail(400, 'invalid_request', 'Unknown owner');
      const now = Date.now();
      const task: Task = {
        taskId: newTaskId(),
        teamId: t.teamId,
        subject: text(b.subject, 'subject', { max: 200 })!,
        description: typeof b.description === 'string' && b.description.trim() ? b.description : null,
        status: 'pending',
        owner,
        ownerName: null,
        blockedBy: [],
        blocks: [],
        assignment: null,
        createdAt: now,
        updatedAt: now,
      };
      t.tasks.push(task);
      if (Array.isArray(b.blockedBy)) setBlockedBy(t, task, b.blockedBy.map(String));
      notifyOwner(t, task);
      recordTask(t, task, 'created');
      return asWritten(t, task);
    }
    if (taskId && m === 'GET') return withOwnerName(t, findTask(t, taskId));
    if (taskId && m === 'PATCH') {
      const task = findTask(t, taskId);
      const before = { owner: task.owner, status: task.status };
      if (b.subject !== undefined) task.subject = text(b.subject, 'subject', { max: 200 })!;
      if (b.description !== undefined) task.description = typeof b.description === 'string' && b.description.trim() ? b.description : null;
      if (b.status !== undefined) {
        const statuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'deleted'];
        if (!statuses.includes(b.status as TaskStatus)) fail(400, 'invalid_request', 'Unknown status');
        task.status = b.status as TaskStatus;
      }
      if (b.owner !== undefined) {
        const owner = b.owner === null ? null : String(b.owner);
        if (owner && owner !== 'user' && !t.agents.some((a) => a.slotId === owner)) fail(400, 'invalid_request', 'Unknown owner');
        task.owner = owner;
      }
      if (b.blockedBy !== undefined) {
        if (!Array.isArray(b.blockedBy)) fail(400, 'invalid_request', 'blockedBy must be a list');
        setBlockedBy(t, task, (b.blockedBy as unknown[]).map(String));
      }
      task.updatedAt = Date.now();
      if (task.owner !== before.owner) notifyOwner(t, task);
      if (task.status === 'completed' && before.status !== 'completed') {
        // Completing a task can unblock downstream tasks: their owners are notified too.
        for (const id of task.blocks) {
          const next = t.tasks.find((x) => x.taskId === id);
          if (next) notifyOwner(t, next);
        }
      }
      recordTask(t, task, 'updated');
      return asWritten(t, task);
    }
    return fail(404, 'no_such_route');
  }

  function activity(t: MockTeam, q: URLSearchParams) {
    const slotId = q.get('slotId');
    const kind = q.get('kind');
    const aroundTask = q.get('aroundTask');
    let items = t.activity.filter((x) => {
      if (kind && x.kind !== kind) return false;
      if (!slotId) return true;
      return x.kind === 'message' ? x.message.from.slotId === slotId || x.message.to.slotId === slotId : x.task.owner === slotId;
    });
    if (aroundTask) {
      const at = t.tasks.find((x) => x.taskId === aroundTask)?.createdAt ?? Date.now();
      items = [...items].sort((x, y) => Math.abs(x.createdAt - at) - Math.abs(y.createdAt - at)).slice(0, 20).sort((x, y) => y.createdAt - x.createdAt);
      return { items, nextCursor: null, hasMore: false };
    }
    items = [...items].sort((x, y) => y.createdAt - x.createdAt);
    const limit = limitOf(q);
    const start = Number(q.get('cursor')) || 0;
    const page = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return { items: page, nextCursor: more ? String(start + limit) : null, hasMore: more };
  }

  function workspaces() {
    const seen = new Map<string, number>();
    for (const t of teams) seen.set(t.workspace, Math.max(seen.get(t.workspace) ?? 0, teamSummary(t).updatedAt));
    for (const c of conversations.values()) if (c.workspace) seen.set(c.workspace, Math.max(seen.get(c.workspace) ?? 0, c.updatedAt));
    return [...seen.entries()].map(([path, lastUsedAt]) => ({ path, label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, lastUsedAt }));
  }

  return {
    async handle({ method, path, body }) {
      try {
        const res = await route(method, path, body);
        // JSON round trip: callers never share objects with the facade's state.
        return { status: 200, body: res === undefined ? undefined : JSON.parse(JSON.stringify(res)) };
      } catch (err) {
        if (err instanceof HttpError) {
          return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } } };
        }
        return { status: 500, body: { error: { code: 'backend_unavailable', message: err instanceof Error ? err.message : String(err) } } };
      }
    },

    isSensitive({ method, path, body }) {
      const { segs } = parse(path);
      const m = method.toUpperCase();
      const [, r1, r2, r3, r4, r5] = segs;
      if (r1 === 'approvals' && r3 === 'answer' && m === 'POST') {
        const ap = approvals.find((a) => a.approvalId === r2);
        return ap ? isSensitiveAnswer(ap, (body ?? {}) as ApprovalAnswer) : false;
      }
      if (r1 !== 'teams') return false;
      if (r3 === 'agents' && !r4 && m === 'POST') return true; // spawn
      if (r3 === 'agents' && r4 && !r5 && m === 'DELETE') return true; // force remove
      if (r3 === 'agents' && r4 && (r5 === 'shutdown' || r5 === 'clear-context') && m === 'POST') return true;
      if (r3 === 'tasks' && r4 && m === 'PATCH') return isRecord(body) && body.status === 'deleted';
      return false;
    },

    dispose() {
      for (const t of timers.keys()) clearTimeout(t);
      timers.clear();
      for (const wake of [...waiters]) wake();
    },
  };
}

const ASSISTANTS = [
  { assistantId: 'claude', name: 'Claude Code', backend: 'claude', icon: null, description: 'General-purpose coding agent.' },
  { assistantId: 'ui-ux-pro', name: 'UI/UX Pro Max', backend: 'claude', icon: null, description: 'Design systems, UX review, accessibility.' },
  { assistantId: 'writer', name: 'Docs Writer', backend: 'claude', icon: null, description: 'Writes READMEs, guides and release notes.' },
  { assistantId: 'word-creator', name: 'Word Creator', backend: 'acp', icon: null, description: 'Creates and edits .docx documents.' },
];
