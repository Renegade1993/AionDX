import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { useActiveTeam, useApprovals, useRunState, useStartTeamSession } from '@/lib/api/hooks';
import { useTeamSessionStore } from '@/state/teamSessionStore';
import { formatAgo, isSessionDown } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useActiveHost, useConnectionStore } from '@/state/connectionStore';
import { type ConnectionState, isTrustProblem, useConnectionState, useHealthStore } from '@/state/healthStore';
import { usePrefsStore } from '@/state/prefsStore';
import { poll, space, useColors, withAlpha } from '@/theme';

/** The change feed answers at least this often while connected (25 s hold + slack). */
const FEED_CYCLE_MS = 30_000;

export function useHostLabel(): string {
  const host = useActiveHost();
  const label = usePrefsStore((s) => (host ? s.hostLabels[host.hostId] : undefined));
  return label ?? host?.hostName ?? 'your PC';
}

/** SPEC §4.8 — reconnecting / unreachable / not running, plus the trust states (contract A1, 409 unknown_host). */
export function ConnectionBanner() {
  const c = useColors();
  const state = useConnectionState();
  const lastSuccessAt = useHealthStore((s) => s.lastSuccessAt);
  const host = useHostLabel();
  const qc = useQueryClient();
  const activeHostId = useConnectionStore((s) => s.activeHostId);
  const forgetHost = useConnectionStore((s) => s.forgetHost);
  const prev = useRef<ConnectionState>(state);

  useEffect(() => {
    // Announce transitions only, never every tick (SPEC §9).
    if (prev.current !== state) {
      if (state === 'ok' && prev.current !== 'ok') AccessibilityInfo.announceForAccessibility(`Reconnected to ${host}`);
      else if (state === 'unreachable') AccessibilityInfo.announceForAccessibility(`Can't reach ${host}`);
      prev.current = state;
    }
  }, [state, host]);

  if (state === 'ok') return null;
  const retry = () => void qc.refetchQueries({ type: 'active' });
  const confirmForget = () => {
    if (!activeHostId) return;
    Alert.alert(`Forget ${host}?`, "This phone's key for it is deleted. Pair again to reconnect.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => void forgetHost(activeHostId) },
    ]);
  };
  const copy: Record<Exclude<ConnectionState, 'ok'>, { text: string; action?: { label: string; onPress: () => void } }> = {
    reconnecting: { text: `Reconnecting to ${host}…` },
    unreachable: {
      text: `Can't reach ${host}.${lastSuccessAt ? ` Showing data from ${formatAgo(lastSuccessAt)}.` : ''}`,
      action: { label: 'Retry', onPress: retry },
    },
    revoked: { text: `${host} removed this phone.`, action: { label: 'Re-pair', onPress: () => router.push('/scan') } },
    // Unauthenticated 403 (A1): could be spoofed, so the pairing stays and forgetting is the user's call.
    refused: { text: `${host} refused the connection.`, action: { label: 'Forget', onPress: confirmForget } },
    host_reset: { text: `${host} was reset. Pair it again.`, action: { label: 'Pair again', onPress: () => router.push('/scan') } },
    not_running: { text: `AionDX isn't running on ${host}.`, action: { label: 'Retry', onPress: retry } },
  };
  const { text, action } = copy[state];
  const tone = state === 'reconnecting' ? c.stWaiting : c.stError;
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: withAlpha(tone, 0.14) }]}>
      {state === 'reconnecting' ? (
        <ActivityIndicator size="small" color={tone} />
      ) : (
        // Distinct from "can't reach": this is a trust problem, not a network one (SPEC §13.12).
        <Icon name={isTrustProblem(state) ? 'key-outline' : 'cloud-offline-outline'} color="stError" />
      )}
      <Text variant="caption" style={{ flex: 1 }}>
        {text}
      </Text>
      {action ? (
        <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={8} style={styles.action}>
          <Text variant="caption" color="primary" style={{ fontWeight: '700' }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * SPEC §4.7 / §14.5: sticky "1 question · 1 approval waiting". 1 → straight to the sheet; >1 → inbox.
 * `excludeConversationId` (chat thread, SPEC §12.5): that agent's approvals are already shown above
 * the composer, so only the others are counted ("1 other approval waiting").
 */
export function ApprovalBanner({ excludeConversationId }: { excludeConversationId?: string } = {}) {
  const c = useColors();
  const all = useApprovals().data ?? [];
  const relevant = excludeConversationId ? all.filter((a) => a.conversationId !== excludeConversationId) : all;
  const pending = relevant.length;
  const conn = useConnectionState();
  // Revoked: nothing can be approved, so don't advertise it (SPEC §13.12).
  if (pending === 0 || isTrustProblem(conn)) return null;
  // Offline: dimmed with the rest of the cached data; the inbox still opens, read-only (SPEC §13.13).
  const offline = conn === 'unreachable' || conn === 'not_running';
  const questions = relevant.filter((a) => a.kind === 'question').length;
  const permissions = pending - questions;
  const other = excludeConversationId ? ' other' : '';
  const label = [
    questions > 0 ? `${questions}${other} question${questions === 1 ? '' : 's'}` : null,
    permissions > 0 ? `${permissions}${questions > 0 ? '' : other} approval${permissions === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
    .concat(' waiting');
  const open = () => {
    if (pending === 1) router.push({ pathname: '/approval/[approvalId]', params: { approvalId: relevant[0].approvalId } });
    else router.push('/approvals');
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Review`}
      style={[styles.banner, { backgroundColor: withAlpha(c.stNeedsYou, 0.14) }, offline && { opacity: 0.6 }]}
    >
      <Icon name="hand-left" color="stNeedsYou" />
      <Text variant="headline" style={{ flex: 1 }}>
        {label}
      </Text>
      <Text variant="caption" color={offline ? 'textMuted' : 'primary'} style={{ fontWeight: '700' }}>
        Review ›
      </Text>
    </Pressable>
  );
}

/**
 * TeamSessionBanner (SPEC §14.1.4): the team isn't running, is starting, or failed to start.
 * Hidden while the PC itself is unreachable or doesn't trust this phone (team state is unknown).
 */
export function TeamSessionBanner() {
  const c = useColors();
  const run = useRunState().data;
  const { teamId, teamName } = useActiveTeam();
  const start = useStartTeamSession();
  const conn = useConnectionState();
  const lastError = useTeamSessionStore((s) => (teamId ? s.lastError[teamId] : undefined));
  const [expanded, setExpanded] = useState(false);
  const status = run?.sessionStatus;
  if (!run || !status || status === 'ready' || conn !== 'ok') return null;
  const name = teamName ?? 'The team';
  if (status === 'starting' || start.isPending) {
    return (
      <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: c.surfaceAlt }]}>
        <ActivityIndicator size="small" color={c.textMuted} />
        <Text variant="caption" color="textMuted" style={{ flex: 1 }}>
          Starting {name}…
        </Text>
      </View>
    );
  }
  const failed = status === 'failed' || (lastError !== undefined && lastError !== null);
  const text = failed ? `${name} failed to start.` : status === 'stopped' ? `${name} was stopped.` : `${name} isn't running.`;
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: failed ? withAlpha(c.stError, 0.12) : c.surfaceAlt }]}>
      <Icon name={failed ? 'close-circle' : 'power'} color={failed ? 'stErrorText' : 'text'} />
      <View style={{ flex: 1 }}>
        <Text variant="caption">{text}</Text>
        {failed && lastError ? (
          <Pressable onPress={() => setExpanded((e) => !e)} accessibilityRole="button" accessibilityLabel={`Reason: ${lastError}`}>
            <Text variant="caption" color="textMuted" numberOfLines={expanded ? undefined : 2}>
              {lastError}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {isSessionDown(status) || failed ? (
        <Pressable onPress={() => start.mutate()} accessibilityRole="button" hitSlop={8} style={styles.action}>
          <Text variant="caption" color="primary" style={{ fontWeight: '700' }}>
            {failed ? 'Try again' : 'Start'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Header subtitle: "Updated 2s ago" ticking locally; amber when stale (SPEC §4.2). Tap = refresh now.
 * Data is current as of the newer of its fetch and the change feed's last answer: an empty feed
 * cycle confirms nothing changed (contract §6.2), which is as good as a refetch.
 */
export function FreshnessIndicator({ updatedAt: fetchedAt, intervalMs = FEED_CYCLE_MS, onRefresh }: { updatedAt: number; intervalMs?: number; onRefresh?: () => void }) {
  const now = useNow();
  const conn = useConnectionState();
  const feedAt = useHealthStore((s) => s.lastSuccessAt) ?? 0;
  const updatedAt = fetchedAt > 0 ? Math.max(fetchedAt, feedAt) : 0;
  const age = now - updatedAt;
  const stale = updatedAt > 0 && age > intervalMs * poll.staleAfterMultiplier;
  if (isTrustProblem(conn)) {
    // Polling has stopped; a spinner would promise a retry that won't happen (SPEC §13.12).
    return (
      <Text variant="caption" color="textMuted">
        Not connected
      </Text>
    );
  }
  return (
    <Pressable onPress={onRefresh} accessibilityRole="button" accessibilityLabel="Refresh now" hitSlop={8} style={styles.fresh}>
      <Text variant="caption" color={stale ? 'stWaitingText' : 'textMuted'} accessibilityLiveRegion="none">
        {updatedAt ? `Updated ${formatAgo(updatedAt, now)}` : 'Loading…'}
        {stale ? ' · retrying' : ''}
      </Text>
      {stale ? <ActivityIndicator size="small" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.gutter,
    paddingVertical: space.md,
    minHeight: 48,
  },
  action: { minHeight: 32, justifyContent: 'center' },
  fresh: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
