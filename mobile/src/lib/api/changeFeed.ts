import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getApi } from '@/state/connectionStore';
import { backoffInterval, useHealthStore } from '@/state/healthStore';

import { HOST_INFO_STALE_MS, keys, type ThreadData, upsertApproval, upsertTask } from './hooks';
import type { ChangeEntry, HostInfo } from './types';

/*
 * The change feed (contract §6.2) replaces per-screen polling: one GET /v1/changes long-poll per
 * active host while the app is in the foreground. Inline objects (approvals, tasks) are applied to
 * the query cache directly; team and conversation entries invalidate only the resource named, so
 * screens that show it refetch it (and ones that don't, refetch when they next mount).
 */

/** Server-side hold for the long-poll; the HTTP timeout is 35 s (secureChannel). */
const WAIT_SEC = 25;
/** Pause between cycles that returned changes, so a burst (a streaming reply) coalesces server-side. */
const MIN_CYCLE_MS = 1000;
/** Without the `changes.longpoll` capability the feed is polled plainly at the old dashboard rate. */
const PLAIN_POLL_MS = 3000;
const FAILURE_BASE_MS = 3000;

/** Feed tokens per host, kept across remounts (but not app restarts: a fresh start refetches anyway). */
const tokens = new Map<string, string>();

export function applyChanges(qc: QueryClient, hostId: string, changes: ChangeEntry[]): void {
  for (const c of changes) {
    switch (c.kind) {
      case 'team':
        if (c.what.includes('roster') || c.what.includes('run_state') || c.what.length === 0) {
          void qc.invalidateQueries({ queryKey: keys.runState(hostId, c.teamId) });
        }
        // The team list carries attention / unread / name.
        void qc.invalidateQueries({ queryKey: keys.teams(hostId) });
        break;
      case 'team_removed':
        qc.removeQueries({ queryKey: keys.team(hostId, c.teamId) });
        void qc.invalidateQueries({ queryKey: keys.teams(hostId) });
        break;
      case 'conversation':
        if (c.what.includes('messages') || c.what.length === 0) void qc.invalidateQueries({ queryKey: keys.thread(hostId, c.conversationId) });
        void qc.invalidateQueries({ queryKey: keys.conversation(hostId, c.conversationId) });
        // Team members' unread / attention / lastMessage live on the roster; solo chats on the list.
        if (c.teamId) void qc.invalidateQueries({ queryKey: keys.runState(hostId, c.teamId) });
        else void qc.invalidateQueries({ queryKey: keys.solo(hostId) });
        break;
      case 'conversation_removed':
        qc.removeQueries({ queryKey: keys.thread(hostId, c.conversationId) });
        qc.removeQueries({ queryKey: keys.conversation(hostId, c.conversationId) });
        void qc.invalidateQueries({ queryKey: keys.solo(hostId) });
        break;
      case 'approval_added':
        upsertApproval(qc, hostId, c.approval);
        break;
      case 'approval_removed':
        qc.setQueryData(keys.approvals(hostId), (old: { approvalId: string }[] | undefined) => old?.filter((a) => a.approvalId !== c.approvalId));
        break;
      case 'task':
        upsertTask(qc, hostId, c.task);
        void qc.invalidateQueries({ queryKey: keys.activityAll(hostId, c.teamId) });
        break;
      case 'broadcast':
        void qc.invalidateQueries({ queryKey: keys.broadcasts(hostId, c.teamId) });
        break;
    }
  }
}

/** `reset`: the token is from an older bridge epoch or too old. Everything shown is refetched. */
export function resetHost(qc: QueryClient, hostId: string): void {
  // Threads restart from the latest page: their sync cursors belong to the old epoch too.
  for (const q of qc.getQueryCache().findAll({ queryKey: ['host', hostId, 'thread'] })) {
    qc.setQueryData<ThreadData>(q.queryKey, (old) => old && { ...old, cursor: undefined });
  }
  void qc.invalidateQueries({ queryKey: ['host', hostId] });
}

const sleep = (ms: number, signal: { stopped: boolean }) =>
  new Promise<void>((resolve) => {
    if (signal.stopped) return resolve();
    setTimeout(resolve, ms);
  });

/**
 * Runs the feed for `hostId` while the app is active. Health (banner, backoff, offline) is
 * driven from here now: the feed is the one request that is always in flight.
 */
export function useChangeFeed(hostId: string | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!hostId) return;
    const signal = { stopped: false };
    let running = false;

    async function loop(id: string) {
      if (running) return;
      running = true;
      // Capabilities decide long-poll vs plain polling.
      void qc.prefetchQuery({ queryKey: keys.host(id), queryFn: () => getApi(id).getHost(), staleTime: HOST_INFO_STALE_MS });
      try {
        while (!signal.stopped && AppState.currentState !== 'background') {
          const health = useHealthStore.getState();
          // Once the PC has revoked this phone, nothing can succeed until it's re-paired.
          if (health.lastFailure === 'revoked') return;
          const longPoll = qc.getQueryData<HostInfo>(keys.host(id))?.capabilities.includes('changes.longpoll') ?? false;
          const since = tokens.get(id);
          let delay: number;
          try {
            const res = await getApi(id).getChanges(since, since && longPoll ? WAIT_SEC : 0);
            if (signal.stopped) return;
            health.recordSuccess();
            if (res.reset && since) resetHost(qc, id);
            else applyChanges(qc, id, res.changes);
            tokens.set(id, res.token);
            delay = res.more ? 0 : !longPoll ? PLAIN_POLL_MS : res.changes.length > 0 ? MIN_CYCLE_MS : 0;
          } catch (err) {
            if (signal.stopped) return;
            health.recordFailure(err);
            delay = backoffInterval(FAILURE_BASE_MS, useHealthStore.getState().consecutiveFailures);
          }
          if (delay > 0) await sleep(delay, signal);
        }
      } finally {
        running = false;
      }
    }

    void loop(hostId);
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void loop(hostId);
    });
    // A re-pair (or a recovered trust problem) restarts the loop.
    const unsubHealth = useHealthStore.subscribe((s, prev) => {
      if (prev.lastFailure === 'revoked' && s.lastFailure !== 'revoked') void loop(hostId);
    });
    return () => {
      signal.stopped = true;
      sub.remove();
      unsubHealth();
    };
  }, [hostId, qc]);
}
