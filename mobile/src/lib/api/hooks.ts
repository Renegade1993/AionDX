import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useMemo } from 'react';

import { randomUuid } from '@/lib/crypto/primitives';
import { getApi, useActiveHost, useConnectionStore } from '@/state/connectionStore';
import { useHealthStore } from '@/state/healthStore';
import { usePrefsStore } from '@/state/prefsStore';
import { useTeamSessionStore } from '@/state/teamSessionStore';
import { toast } from '@/state/toastStore';

import type { AionDxApi } from './client';
import { promptName } from '../confirmState';
import { describeActionError, isApiError } from './errors';
import { DeviceRevokedError } from './secureChannel';
import { canConfirm, confirmStateFor, type ConfirmState } from '../confirmState';
import type {
  AnswerResult,
  Approval,
  ApprovalAnswer,
  Broadcast,
  Capability,
  Delivery,
  Message,
  Page,
  RunState,
  SpawnInput,
  Task,
  TaskInput,
  TaskPatch,
} from './types';

/*
 * One hook per resource. Nothing polls on a timer any more: the change feed (changeFeed.ts)
 * invalidates or patches exactly what changed (contract §6.2). Every query key starts with
 * ['host', hostId] so switching PCs never mixes data, and the encrypted cache can persist one
 * host at a time.
 */

export const HOST_INFO_STALE_MS = 5 * 60_000;

export const keys = {
  host: (h: string) => ['host', h, 'info'] as const,
  teams: (h: string) => ['host', h, 'teams'] as const,
  team: (h: string, t: string) => ['host', h, 'team', t] as const,
  runState: (h: string, t: string) => ['host', h, 'team', t, 'run-state'] as const,
  tasks: (h: string, t: string) => ['host', h, 'team', t, 'tasks'] as const,
  broadcasts: (h: string, t: string) => ['host', h, 'team', t, 'broadcasts'] as const,
  activityAll: (h: string, t: string) => ['host', h, 'team', t, 'activity'] as const,
  activity: (h: string, t: string, s: string) => ['host', h, 'team', t, 'activity', s] as const,
  approvals: (h: string) => ['host', h, 'approvals'] as const,
  solo: (h: string) => ['host', h, 'solo'] as const,
  conversation: (h: string, c: string) => ['host', h, 'conversation', c] as const,
  thread: (h: string, c: string) => ['host', h, 'thread', c] as const,
  assistants: (h: string) => ['host', h, 'assistants'] as const,
  workspaces: (h: string) => ['host', h, 'workspaces'] as const,
};

/** Wraps a fetch so connection health (banner, offline) tracks it, alongside the change feed. */
function tracked<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const result = await fn();
      useHealthStore.getState().recordSuccess();
      return result;
    } catch (err) {
      useHealthStore.getState().recordFailure(err);
      if (err instanceof DeviceRevokedError) void forgetRevokedHost(err);
      throw err;
    }
  };
}

const forgetting = new Set<string>();

/**
 * A verified revocation notice (A1) means that PC will never accept this key again, so
 * the pairing, its identity and its cache are deleted. Several queries fail together;
 * only the first one acts.
 */
export async function forgetRevokedHost(err: DeviceRevokedError) {
  const { hosts, forgetHost } = useConnectionStore.getState();
  const host = hosts.find((h) => h.hostId === err.hostId);
  if (!host || forgetting.has(err.hostId)) return;
  forgetting.add(err.hostId);
  try {
    await forgetHost(err.hostId);
    toast(`${host.hostName} ${err.reason === 'unknown' ? 'no longer knows' : 'removed'} this phone. Pair again to reconnect.`, 'error');
  } finally {
    forgetting.delete(err.hostId);
  }
}

/** Toasts an action failure in plain words; a cancelled Face ID / passcode prompt stays silent. */
function failToast(fallback: string) {
  return (err: unknown) => {
    const text = describeActionError(err, fallback);
    if (text) toast(text, 'error');
  };
}

export function useHostId(): string {
  const hostId = useConnectionStore((s) => s.activeHostId);
  if (!hostId) throw new Error('No active host');
  return hostId;
}

/** Revoked or not focused: don't fetch. */
function useLive(): boolean {
  const focused = useIsFocused();
  const revoked = useHealthStore((s) => s.lastFailure === 'revoked');
  return focused && !revoked;
}

// ---------------------------------------------------------------------------
// Host + capabilities (§6.1)
// ---------------------------------------------------------------------------

/** Not health-tracked: a bridge without it isn't a connectivity problem, just no capabilities. */
export function useHostInfo() {
  const hostId = useHostId();
  return useQuery({
    queryKey: keys.host(hostId),
    queryFn: () => getApi(hostId).getHost(),
    staleTime: HOST_INFO_STALE_MS,
    retry: false,
  });
}

/** True only once the PC has advertised the capability; unknown or loading counts as off. */
export function useCapability(capability: Capability): boolean {
  return useHostInfo().data?.capabilities.includes(capability) ?? false;
}

/** How sensitive actions confirm on the active PC (lib/confirmState.ts, SPEC §15.5). */
export function useConfirmState(): ConfirmState {
  const host = useActiveHost();
  const info = useHostInfo().data;
  return confirmStateFor(host, info);
}

/** Sensitive buttons can be used (maybe after a prompt) on the active PC. */
export const useCanConfirm = () => canConfirm(useConfirmState());

/** Task writes are on (sign-off #4), but each PC can still switch them off (contract §6.7). */
export const useCanWriteTasks = () => useCapability('tasks.write');

// ---------------------------------------------------------------------------
// Teams (§6.3)
// ---------------------------------------------------------------------------

export function useTeams() {
  const hostId = useHostId();
  return useQuery({ queryKey: keys.teams(hostId), queryFn: tracked(() => getApi(hostId).listTeams()) });
}

/** Active team for the active host: the user's last pick, else the first team. */
export function useActiveTeam(): { teamId: string | undefined; teamName: string | undefined; setTeam: (teamId: string) => void } {
  const hostId = useHostId();
  const teams = useTeams().data;
  const picked = usePrefsStore((s) => s.activeTeamByHost[hostId]);
  const update = usePrefsStore((s) => s.update);
  const current = teams?.find((t) => t.teamId === picked) ?? teams?.[0];
  return {
    teamId: current?.teamId,
    teamName: current?.name,
    setTeam: (teamId) => update({ activeTeamByHost: { ...usePrefsStore.getState().activeTeamByHost, [hostId]: teamId } }),
  };
}

export interface ApiContext {
  api: AionDxApi;
  hostId: string;
  teamId: string;
}

/** For screens that render under a team: gate on `ready`. */
export function useApiContext(): (ApiContext & { ready: true }) | { ready: false } {
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  return useMemo(() => (teamId ? { ready: true as const, api: getApi(hostId), hostId, teamId } : { ready: false as const }), [hostId, teamId]);
}

/** The dashboard projection for the active team; kept current by the change feed. */
export function useRunState() {
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  const live = useLive();
  return useQuery({
    queryKey: keys.runState(hostId, teamId ?? ''),
    queryFn: tracked(() => getApi(hostId).getRunState(teamId!)),
    enabled: !!teamId,
    subscribed: live,
  });
}

export function useStartTeamSession() {
  const qc = useQueryClient();
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  const setError = useTeamSessionStore((s) => s.setError);
  return useMutation({
    mutationFn: () => getApi(hostId).startTeamSession(teamId!),
    onSuccess: (run) => {
      setError(teamId!, null);
      qc.setQueryData(keys.runState(hostId, run.teamId || teamId!), run);
    },
    onError: (err) => {
      // 503 team_session_failed: the banner shows AionCore's reason (SPEC §14.1.4).
      if (isApiError(err, 'team_session_failed')) {
        setError(teamId!, typeof err.details?.error === 'string' ? err.details.error : '');
        void qc.invalidateQueries({ queryKey: keys.runState(hostId, teamId ?? '') });
      } else failToast("Couldn't start the team")(err);
    },
  });
}

// ---------------------------------------------------------------------------
// Approvals (§6.5)
// ---------------------------------------------------------------------------

export function upsertApproval(qc: QueryClient, hostId: string, approval: Approval) {
  qc.setQueryData<Approval[]>(keys.approvals(hostId), (old) => {
    if (!old) return old; // not loaded yet: the first fetch will include it
    const rest = old.filter((a) => a.approvalId !== approval.approvalId);
    return [...rest, approval].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  });
}

/** Every pending approval on the PC (solo and team), oldest first. Patched live by the change feed. */
export function useAllApprovals() {
  const hostId = useHostId();
  return useQuery({
    queryKey: keys.approvals(hostId),
    queryFn: tracked(async () => (await getApi(hostId).listApprovals()).sort((a, b) => a.firstSeenAt - b.firstSeenAt)),
  });
}

/** The active team's approvals. */
export function useApprovals() {
  const { teamId } = useActiveTeam();
  const all = useAllApprovals();
  const data = useMemo(() => all.data?.filter((a) => a.teamId === teamId), [all.data, teamId]);
  return { ...all, data };
}

/**
 * Answers an approval. Optimistically removes it; `409 already_resolved` counts as done (someone
 * answered on the PC). Allow answers prompt for Face ID / passcode inside the transport (§5).
 */
export function useAnswerApproval({ quiet = false }: { quiet?: boolean } = {}) {
  const qc = useQueryClient();
  const hostId = useHostId();
  const key = keys.approvals(hostId);
  return useMutation<AnswerResult & { alreadyHandled?: boolean }, unknown, { approval: Approval; answer: ApprovalAnswer }, { prev?: Approval[] }>({
    mutationFn: async ({ approval, answer }) => {
      try {
        return await getApi(hostId).answerApproval(approval, answer);
      } catch (err) {
        if (isApiError(err, 'already_resolved')) return { resolved: true, messageDelivery: null, alreadyHandled: true };
        throw err;
      }
    },
    onMutate: async ({ approval }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Approval[]>(key);
      qc.setQueryData<Approval[]>(key, (old) => old?.filter((a) => a.approvalId !== approval.approvalId));
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      qc.setQueryData(key, ctx?.prev);
      // 422 is handled by the caller (it opens the option picker); a sheet shows errors inline.
      if (!quiet && !isApiError(err, 'ambiguous_decision')) failToast("Couldn't send your answer")(err);
    },
    onSettled: (_res, _err, { approval }) => {
      if (approval.teamId) void qc.invalidateQueries({ queryKey: keys.runState(hostId, approval.teamId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Conversations and threads (§6.4)
// ---------------------------------------------------------------------------

export function useSoloConversations() {
  const hostId = useHostId();
  const live = useLive();
  return useQuery({
    queryKey: keys.solo(hostId),
    queryFn: tracked(async () => (await getApi(hostId).listSoloConversations(undefined, 100)).items),
    subscribed: live,
  });
}

export function useConversation(conversationId: string | undefined) {
  const hostId = useHostId();
  return useQuery({
    queryKey: keys.conversation(hostId, conversationId ?? ''),
    queryFn: tracked(() => getApi(hostId).getConversation(conversationId!)),
    enabled: !!conversationId,
  });
}

/** A server row, or the phone's own message before the PC has accepted it. */
export type ThreadMessage = Message & {
  /** Local only: the POST hasn't returned (sending) or failed (failed). Never from the server. */
  localState?: 'sending' | 'failed';
  /** From the send response, until the row itself reports a status. */
  delivery?: Delivery;
};

export interface ThreadData {
  /** Ascending by createdAt. */
  items: ThreadMessage[];
  /** Sync cursor for `?since=`; undefined → fetch the latest page. */
  cursor?: string;
  /** Where older history continues (`?before=`); null at the start; undefined if unknown. */
  before?: string | null;
}

const byTime = (a: ThreadMessage, b: ThreadMessage) => a.createdAt - b.createdAt;

/** Upsert by messageId (contract §6.4: unchanged rows may repeat; harmless). */
export function upsertMessages(existing: ThreadMessage[], incoming: Message[]): ThreadMessage[] {
  const byId = new Map(existing.map((m) => [m.messageId, m]));
  // A server row replaces any local copy (and its send-time delivery): the row's status is newer.
  for (const m of incoming) byId.set(m.messageId, m);
  return [...byId.values()].sort(byTime);
}

/**
 * Thread messages, synced by cursor: the first fetch gets the latest page, each later one every
 * row inserted or changed since (a streaming reply grows in place). Refetched when the change
 * feed reports `messages` for this conversation.
 */
export function useThread(conversationId: string | undefined) {
  const qc = useQueryClient();
  const hostId = useHostId();
  const live = useLive();
  const key = keys.thread(hostId, conversationId ?? '');
  return useQuery({
    queryKey: key,
    queryFn: tracked(async (): Promise<ThreadData> => {
      const api = getApi(hostId);
      const existing = qc.getQueryData<ThreadData>(key);
      let cursor = existing?.cursor;
      let items = existing?.items ?? [];
      let before = existing?.before;
      for (let page = 0; page < 20; page++) {
        const res = await api.syncMessages(conversationId!, cursor);
        if (!cursor || res.reset) {
          // Fresh start: server rows are replaced; the phone's unsent messages stay.
          items = upsertMessages(items.filter((m) => m.localState), res.items);
          before = res.before;
        } else {
          items = upsertMessages(items, res.items);
        }
        cursor = res.cursor;
        if (!res.hasMore) break;
      }
      return { items, cursor, before };
    }),
    enabled: !!conversationId,
    subscribed: live,
  });
}

/** Loads the page before the oldest loaded message (`?before=`). */
export function useLoadOlder(conversationId: string) {
  const qc = useQueryClient();
  const hostId = useHostId();
  const key = keys.thread(hostId, conversationId);
  return useMutation({
    mutationFn: async () => {
      const before = qc.getQueryData<ThreadData>(key)?.before;
      if (!before) return null;
      return getApi(hostId).olderMessages(conversationId, before);
    },
    onSuccess: (res) => {
      if (!res) return;
      qc.setQueryData<ThreadData>(key, (old) => old && { ...old, items: upsertMessages(old.items, res.items), before: res.before });
    },
    onError: failToast("Couldn't load older messages"),
  });
}

export const newLocalMessageId = () => randomUuid();

/**
 * Sends a message. The local id doubles as the request id (A4), so "Tap to retry" after a failed
 * POST can't double-send if the first attempt did reach the PC.
 */
export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  const hostId = useHostId();
  const key = keys.thread(hostId, conversationId);
  const setLocal = (localId: string, patch: Partial<ThreadMessage>) =>
    qc.setQueryData<ThreadData>(key, (old) => old && { ...old, items: old.items.map((m) => (m.messageId === localId ? { ...m, ...patch } : m)) });

  return useMutation({
    mutationFn: ({ content, localId, priority }: { content: string; localId: string; priority?: 'normal' | 'now' }) =>
      getApi(hostId).sendMessage(conversationId, content, { priority, rid: localId }),
    onMutate: ({ content, localId }) => {
      qc.setQueryData<ThreadData>(key, (old) => {
        const local: ThreadMessage = {
          messageId: localId,
          conversationId,
          role: 'user',
          sender: { kind: 'user' },
          type: 'text',
          status: 'done',
          text: content,
          createdAt: Date.now(),
          localState: 'sending',
        };
        const items = (old?.items ?? []).filter((m) => m.messageId !== localId);
        return { ...old, items: [...items, local] };
      });
    },
    onSuccess: (sent, { localId }) => {
      qc.setQueryData<ThreadData>(key, (old) => {
        if (!old) return old;
        const local = old.items.find((m) => m.messageId === localId);
        // If the change feed already delivered the server row, the local copy just goes away.
        const others = old.items.filter((m) => m.messageId !== localId && m.messageId !== sent.messageId);
        const server = old.items.find((m) => m.messageId === sent.messageId);
        // Until the server row arrives, the send response says where the message went (SPEC §14.3.2).
        const row: ThreadMessage = server ?? {
          ...local!,
          messageId: sent.messageId,
          localState: undefined,
          delivery: sent.delivery,
          status: sent.delivery === 'midturn' ? 'pending' : 'done',
        };
        return { ...old, items: [...others, row].sort(byTime) };
      });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err, { localId }) => {
      setLocal(localId, { localState: 'failed' });
      failToast("Couldn't send message")(err);
    },
  });
}

/** Moves the read marker (contract §6.4); the server then clears unread and `your_turn`. */
export function useMarkRead(conversationId: string | undefined) {
  const hostId = useHostId();
  return useMutation({
    mutationFn: (upToMessageId: string) => getApi(hostId).markRead(conversationId!, upToMessageId),
    // Best effort: a failed marker isn't worth interrupting the user.
  });
}

/** The team's "Everyone" thread: broadcasts sent from phones, oldest first. */
export function useBroadcasts() {
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  return useQuery({
    queryKey: keys.broadcasts(hostId, teamId ?? ''),
    queryFn: tracked(async () => (await getApi(hostId).listBroadcasts(teamId!, undefined, 100)).items.sort((a, b) => a.createdAt - b.createdAt)),
    enabled: !!teamId,
  });
}

export function useSendBroadcast() {
  const qc = useQueryClient();
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  return useMutation({
    mutationFn: ({ content, localId }: { content: string; localId: string }) => getApi(hostId).broadcast(teamId!, content, { rid: localId }),
    onSuccess: (b) => {
      qc.setQueryData<Broadcast[]>(keys.broadcasts(hostId, teamId ?? ''), (old) => [...(old ?? []).filter((x) => x.broadcastId !== b.broadcastId), b]);
      void qc.invalidateQueries({ queryKey: keys.runState(hostId, teamId ?? '') });
    },
    onError: failToast("Couldn't send to everyone"),
  });
}

// ---------------------------------------------------------------------------
// Tasks (§6.7)
// ---------------------------------------------------------------------------

/**
 * Puts a task from a change entry or a write response into the cache. Those carry
 * `assignment: null` (contract §6.7, rev 4.4: it's looked up on reads only), so a known assignment
 * from an earlier read is kept rather than wiped.
 */
export function upsertTask(qc: QueryClient, hostId: string, task: Task) {
  qc.setQueryData<Task[]>(keys.tasks(hostId, task.teamId), (old) => {
    if (!old) return old;
    const known = old.find((t) => t.taskId === task.taskId);
    const merged = task.assignment === null && known?.assignment ? { ...task, assignment: known.assignment } : task;
    const rest = old.filter((t) => t.taskId !== task.taskId);
    return [merged, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export function useTasks() {
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  return useQuery({
    queryKey: keys.tasks(hostId, teamId ?? ''),
    queryFn: tracked(() => getApi(hostId).listTasks(teamId!)),
    enabled: !!teamId,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  return useMutation({
    mutationFn: (input: TaskInput) => getApi(hostId).createTask(teamId!, input),
    onSuccess: (task) => {
      qc.setQueryData<Task[]>(keys.tasks(hostId, teamId ?? ''), (old) => [task, ...(old ?? []).filter((t) => t.taskId !== task.taskId)]);
    },
    onError: failToast("Couldn't create task"),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  const key = keys.tasks(hostId, teamId ?? '');
  return useMutation({
    mutationFn: ({ taskId, patch, subject }: { taskId: string; patch: TaskPatch; subject?: string }) =>
      getApi(hostId).updateTask(teamId!, taskId, patch, subject ? `Delete task “${promptName(subject)}”` : undefined),
    onMutate: async ({ taskId, patch }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Task[]>(key);
      const run = qc.getQueryData<RunState>(keys.runState(hostId, teamId ?? ''));
      qc.setQueryData<Task[]>(key, (old) =>
        old?.map((t) => {
          if (t.taskId !== taskId) return t;
          const next = { ...t, ...patch, owner: patch.owner === undefined ? t.owner : patch.owner };
          if (patch.owner !== undefined) next.ownerName = ownerNameFor(next.owner, run);
          return next;
        }),
      );
      return { prev };
    },
    onSuccess: (task) => upsertTask(qc, hostId, task),
    onError: (err, _v, ctx) => {
      qc.setQueryData(key, ctx?.prev);
      failToast("Couldn't update task")(err);
    },
  });
}

/** Display name for an owner value, as the bridge would resolve it (§6.7). */
export function ownerNameFor(owner: string | null, run: RunState | undefined): string | null {
  if (owner === 'user') return 'You';
  if (!owner) return null;
  return run?.agents.find((a) => a.slotId === owner)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Agents (§6.6) and activity (§6.8)
// ---------------------------------------------------------------------------

export function useAssistants() {
  const hostId = useHostId();
  return useQuery({ queryKey: keys.assistants(hostId), queryFn: tracked(() => getApi(hostId).listAssistants()), staleTime: 5 * 60_000 });
}

export function useWorkspaces() {
  const hostId = useHostId();
  return useQuery({ queryKey: keys.workspaces(hostId), queryFn: tracked(() => getApi(hostId).listWorkspaces()), staleTime: 60_000 });
}

/** Mailbox and task activity for one agent, newest first. Refreshed by task changes and on focus. */
export function useActivity(slotId: string) {
  const hostId = useHostId();
  const { teamId } = useActiveTeam();
  const live = useLive();
  return useQuery({
    queryKey: keys.activity(hostId, teamId ?? '', slotId),
    queryFn: tracked(async () => (await getApi(hostId).getActivity(teamId!, { slotId, limit: 50 })).items),
    enabled: !!teamId,
    subscribed: live,
    staleTime: 10_000,
  });
}

/**
 * Agent lifecycle actions. Their effects arrive through the change feed; the run state is also
 * invalidated right away so the screen doesn't wait for the next feed cycle.
 */
export function useAgentActions() {
  const qc = useQueryClient();
  const hostId = useHostId();
  const { teamId, teamName } = useActiveTeam();
  const api = () => getApi(hostId);
  const done = () => qc.invalidateQueries({ queryKey: keys.runState(hostId, teamId ?? '') });
  return {
    spawn: useMutation({
      mutationFn: (input: SpawnInput) => api().spawnAgent(teamId!, input, `Add ${promptName(input.name ?? 'an agent')} to ${promptName(teamName ?? 'the team')}`),
      onSettled: done,
    }),
    stop: useMutation({
      mutationFn: ({ slotId, message }: { slotId: string; message?: string }) => api().stopAgent(teamId!, slotId, message),
      onSettled: done,
      onError: failToast("Couldn't stop the turn"),
    }),
    wake: useMutation({
      mutationFn: ({ slotId, nudge }: { slotId: string; nudge?: string }) => api().wakeAgent(teamId!, slotId, nudge),
      onSettled: done,
      onError: failToast("Couldn't wake the agent"),
    }),
    shutdown: useMutation({
      mutationFn: ({ slotId, name, reason }: { slotId: string; name: string; reason?: string }) =>
        api().shutdownAgent(teamId!, slotId, reason, `Ask ${promptName(name)} to shut down`),
      onSettled: done,
      onError: failToast("Couldn't shut down the agent"),
    }),
    forceRemove: useMutation({
      mutationFn: ({ slotId, name }: { slotId: string; name: string }) => api().forceRemoveAgent(teamId!, slotId, `Force remove ${promptName(name)}`),
      onSettled: done,
      onError: failToast("Couldn't remove the agent"),
    }),
    rename: useMutation({
      mutationFn: ({ slotId, name }: { slotId: string; name: string }) => api().renameAgent(teamId!, slotId, name),
      onSettled: done,
      onError: failToast("Couldn't rename the agent"),
    }),
    clearContext: useMutation({
      mutationFn: ({ slotId, name }: { slotId: string; name: string }) => api().clearContext(teamId!, slotId, `Clear ${promptName(name)}'s context`),
      onSettled: done,
      onError: failToast("Couldn't clear the agent's context"),
    }),
  };
}

export type { Page };
