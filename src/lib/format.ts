import type { Agent, Approval, ApprovalOption, Message, RunState, SessionStatus, Task } from './api/types';
import { approvalHeading } from './api/mappers';
import { dashboardSections, slotStatusStyle } from '@/theme';

export type StatusKey = keyof typeof slotStatusStyle;
export type SectionKey = (typeof dashboardSections)[number]['key'];

/** The team session isn't running: agents show "Not running" (SPEC §14.1.4). */
export const isSessionDown = (status: SessionStatus | undefined) => status === 'none' || status === 'stopped' || status === 'failed';

/**
 * One display status per agent, picked by the first matching row of SPEC §14.1.1. What the user
 * can act on comes first, then a lifecycle change in progress, then what the agent is doing.
 * `shutdown: rejected` and `your_turn` are not statuses (they're shown alongside).
 */
export function agentStatusKey(
  a: Pick<Agent, 'attention' | 'shutdown' | 'blockedReason' | 'state' | 'runtime'>,
  sessionStatus?: SessionStatus,
): StatusKey {
  if (a.attention === 'needs_answer') return 'question';
  if (a.attention === 'needs_approval') return 'needs_you';
  if (a.attention === 'error' || a.runtime === 'failed' || a.blockedReason === 'runtime_failed') return 'error';
  if (a.shutdown?.state === 'approved' || a.blockedReason === 'removing') return 'removing';
  if (a.shutdown?.state === 'requested') return 'shutting_down';
  if (isSessionDown(sessionStatus)) return 'not_running';
  if (a.state === 'paused') return 'paused';
  if (a.state === 'running') return 'working';
  if (a.state === 'starting' || a.runtime === 'pending' || a.blockedReason === 'runtime_starting') return 'starting';
  return 'idle';
}

export function sectionOf(status: StatusKey): SectionKey {
  return dashboardSections.find((s) => (s.statuses as readonly string[]).includes(status))?.key ?? 'idle';
}

/** Section order (SPEC §14.1.1), then the lead first, then the bridge's roster order. */
export function sortAgents(agents: Agent[], sessionStatus?: SessionStatus): Agent[] {
  const rank = (a: Agent) => dashboardSections.findIndex((s) => s.key === sectionOf(agentStatusKey(a, sessionStatus)));
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || (x.a.role === 'lead' ? -1 : y.a.role === 'lead' ? 1 : 0) || x.i - y.i)
    .map(({ a }) => a);
}

export interface ReasonCopy {
  text: string;
  detail?: string;
  /** Detail is a command/args preview (monospace); otherwise it's prose. */
  detailIsCode?: boolean;
  /** status: the pill's color; muted: lifecycle notes; primary: your turn; waiting: the derived waiting line. */
  tone?: 'status' | 'muted' | 'primary' | 'waiting';
  cta?: { label: string; kind: 'review' | 'answer' | 'reply' | 'task'; approvalId?: string; taskId?: string };
}

/**
 * The card's reason line: why the agent shows its status, or what it's waiting on. Approvals come
 * from the approvals list (the agent only has a count); tasks feed the derived waiting line.
 */
export function agentReasonCopy(
  a: Agent,
  ctx: { approvals?: Approval[]; tasks?: Task[]; sessionStatus?: SessionStatus; now?: number },
): ReasonCopy | null {
  const now = ctx.now ?? Date.now();
  const mine = ctx.approvals?.filter((x) => x.conversationId === a.conversationId) ?? [];
  const question = mine.find((x) => x.kind === 'question');
  const permission = mine.find((x) => x.kind === 'permission');
  const status = agentStatusKey(a, ctx.sessionStatus);
  switch (status) {
    case 'question':
      return { text: 'Has a question', detail: question?.questions?.[0]?.question, cta: { label: 'Answer', kind: 'answer', approvalId: question?.approvalId } };
    case 'needs_you':
      return {
        text: `Waiting for approval: ${permission ? approvalTitle(permission) : 'a tool call'}`,
        detail: permission ? (approvalCommand(permission) ?? undefined) : undefined,
        detailIsCode: true,
        cta: { label: 'Review', kind: 'review', approvalId: permission?.approvalId },
      };
    case 'error':
      return { text: a.runtime === 'failed' || a.blockedReason === 'runtime_failed' ? 'Runtime failed — check AionDX on your PC' : 'Hit an error' };
    case 'removing':
      return { text: 'Shutting down — removing from team', tone: 'muted' };
    case 'shutting_down':
      return {
        text: `Asked to shut down · ${formatAgo(a.shutdown?.requestedAt ?? now, now)}`,
        detail: a.shutdown?.state === 'requested' && a.shutdown.reason ? `"${a.shutdown.reason}"` : undefined,
      };
    case 'not_running':
      return null;
    case 'paused':
      return { text: 'Paused on your PC', tone: 'muted' };
    default:
      break;
  }
  if (a.attention === 'your_turn') return { text: '↩ Replied · your turn', tone: 'primary', cta: { label: 'Reply', kind: 'reply' } };
  const waiting = status === 'idle' && a.attention === 'none' && ctx.tasks ? waitingOn(a, ctx.tasks) : null;
  if (waiting) {
    return {
      text: `Waiting on "${waiting.blocker.subject}"${waiting.more > 0 ? ` + ${waiting.more} more` : ''}`,
      tone: 'waiting',
      cta: { label: 'View task', kind: 'task', taskId: waiting.blocker.taskId },
    };
  }
  return null;
}

const isOpen = (t: Task) => t.status === 'pending' || t.status === 'in_progress';
const isDone = (t: Task | undefined) => !t || t.status === 'completed' || t.status === 'deleted';

/** A task's unfinished blockers. */
export function openBlockers(task: Task, all: Task[]): Task[] {
  return task.blockedBy.map((id) => all.find((t) => t.taskId === id)).filter((t): t is Task => !isDone(t));
}

/**
 * SPEC §14.2: an idle agent whose every open task has an unfinished blocker is "waiting on" the
 * first unfinished blocker of its oldest open task. Otherwise null (idle with work is normal).
 */
export function waitingOn(a: Pick<Agent, 'slotId' | 'state' | 'shutdown'>, tasks: Task[]): { blocker: Task; more: number } | null {
  if ((a.state !== 'idle' && a.state !== 'queued') || a.shutdown?.state === 'requested' || a.shutdown?.state === 'approved') return null;
  const open = tasks.filter((t) => t.owner === a.slotId && isOpen(t)).sort((x, y) => x.createdAt - y.createdAt);
  if (open.length === 0 || !open.every((t) => openBlockers(t, tasks).length > 0)) return null;
  return { blocker: openBlockers(open[0], tasks)[0], more: open.length - 1 };
}

/** Task owner for display (SPEC §14.6): "You", "Unassigned", or "Removed agent". */
export function taskOwnerLabel(task: Pick<Task, 'owner' | 'ownerName'>, run?: RunState): string {
  if (task.owner === 'user') return 'You';
  if (!task.owner) return 'Unassigned';
  return task.ownerName ?? run?.agents.find((x) => x.slotId === task.owner)?.name ?? 'Removed agent';
}

// ---------------------------------------------------------------------------
// Approvals (SPEC §14.4)
// ---------------------------------------------------------------------------

export const approvalTitle = (a: Pick<Approval, 'title' | 'toolName' | 'inputSummary'>) => approvalHeading(a);

/** What the agent wants to run: inputSummary, else the pretty-printed input; null when unknown. */
export function approvalCommand(a: Pick<Approval, 'inputSummary' | 'input'>): string | null {
  if (a.inputSummary) return a.inputSummary;
  if (a.input === null || a.input === undefined) return null;
  return formatArgs(a.input);
}

/** Sign-off #9: Claude's "always" is the same as once, so it's relabelled rather than hidden. */
export function optionLabel(o: ApprovalOption): string {
  if (o.kind === 'allow_always' && o.alwaysScope === 'same_as_once') return 'Allow (this agent will ask again)';
  return o.label;
}

/**
 * Buttons in display order: allow kinds, then other, then reject kinds, keeping the agent's order
 * within each group. Without the input (`input: null`) only refusals are offered (contract §6.5).
 */
export function orderedOptions(a: Pick<Approval, 'options' | 'input'>): ApprovalOption[] {
  const group = (o: ApprovalOption) => (o.kind.startsWith('allow_') ? 0 : o.kind === 'other' ? 1 : 2);
  const visible = a.input === null ? a.options.filter((o) => o.kind.startsWith('reject_')) : a.options;
  return visible
    .map((o, i) => ({ o, i }))
    .sort((x, y) => group(x.o) - group(y.o) || x.i - y.i)
    .map(({ o }) => o);
}

/** Inline Deny / Allow once on inbox cards only when unambiguous (SPEC §14.4); else Review. */
export function quickOptions(a: Approval): { allow: ApprovalOption; deny: ApprovalOption } | null {
  if (a.kind !== 'permission' || a.input === null) return null;
  const allow = a.options.filter((o) => o.kind === 'allow_once');
  const deny = a.options.filter((o) => o.kind === 'reject_once');
  return allow.length === 1 && deny.length === 1 ? { allow: allow[0], deny: deny[0] } : null;
}

// ---------------------------------------------------------------------------
// Messages (SPEC §14.3)
// ---------------------------------------------------------------------------

/**
 * The message a send_failed row's Retry re-sends (contract rev 3.1): `error.messageId` when set,
 * else the nearest user message before the failed row; null hides Retry.
 */
export function retryTargetFor(row: Message, thread: Message[]): Message | null {
  if (row.status !== 'error' || row.error?.source !== 'send_failed') return null;
  const failedId = row.error.messageId;
  if (failedId) return thread.find((m) => m.messageId === failedId) ?? null;
  const at = thread.findIndex((m) => m.messageId === row.messageId);
  for (let i = (at === -1 ? thread.length : at) - 1; i >= 0; i--) if (thread[i].role === 'user') return thread[i];
  return null;
}

export type PlanEntry = { content: string; status: 'pending' | 'in_progress' | 'completed' };

/** Reads plan entries from the compacted raw content (ACP `entries[{content, status}]`), if present. */
export function planEntries(raw: unknown): PlanEntry[] | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(r?.entries) ? r.entries : Array.isArray(raw) ? raw : null;
  if (!list) return null;
  const entries = list.flatMap((e): PlanEntry[] => {
    if (!e || typeof e !== 'object') return [];
    const x = e as Record<string, unknown>;
    const content = typeof x.content === 'string' ? x.content : typeof x.title === 'string' ? x.title : null;
    if (!content) return [];
    const status = x.status === 'completed' || x.status === 'in_progress' ? x.status : 'pending';
    return [{ content, status }];
  });
  return entries.length ? entries : null;
}

/** Plain text of a row for previews and copy: text, error message, or the tool line. */
export function messageText(m: Pick<Message, 'text' | 'error' | 'tool' | 'type'>): string {
  if (m.type === 'tool_call') return `Used ${m.tool?.title ?? m.tool?.name ?? 'a tool'}${m.tool?.summary ? ` · ${m.tool.summary}` : ''}`;
  return m.text ?? m.error?.message ?? '';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = ['#5C7CFA', '#20C997', '#F76707', '#AE3EC9', '#1098AD', '#E64980', '#74B816', '#FAB005'];

export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function formatAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatRelativeFuture(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  return s < 60 ? `in ${s}s` : `in ${Math.round(s / 60)}m`;
}

export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDay(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

export const shortId = (id: string) => `#…${id.slice(-4)}`;

/** Tool-call args → readable string for approvals (command strings stay as-is, objects pretty-printed). */
export function formatArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    if (typeof a.command === 'string') return a.command;
    if (typeof a.file_path === 'string' && Object.keys(a).length === 1) return a.file_path;
  }
  return JSON.stringify(args, null, 2);
}

/** Task id embedded in an assignment notice: "📋 Task assigned to you (#<id>): …" (SPEC §12.4). */
export function taskIdFromNotice(content: string): string | null {
  return /\(#([0-9a-f-]{8,})\)/i.exec(content)?.[1] ?? null;
}

/** Notice text without the embedded "(#<task-id>)" — the id drives the link but is noise to read. */
export function stripTaskRef(content: string): string {
  return content.replace(/\s*\(#[0-9a-f-]{8,}\)/i, '');
}
