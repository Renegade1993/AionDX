import { router, Stack } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { canForceRemove, canShutDown, canStop, confirmForceRemove, confirmShutdown, confirmStop, openThread, promptInstruction, showQuickActions } from '@/components/agentActions';
import { useSensitive } from '@/components/confirm';
import { FreshnessIndicator, useHostLabel } from '@/components/Banners';
import { hasShutdownOutcome, SlotCard } from '@/components/SlotCard';
import { TabChrome, TeamSwitcherTitle } from '@/components/TeamHeader';
import { usePullRefresh } from '@/components/usePullRefresh';
import { Button } from '@/components/ui/Button';
import { Chip, EmptyState, IconButton, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { useAgentActions, useApprovals, useRunState, useTasks } from '@/lib/api/hooks';
import type { Agent } from '@/lib/api/types';
import { agentStatusKey, isSessionDown, type ReasonCopy, type SectionKey, sectionOf, sortAgents } from '@/lib/format';
import { useConnectionStore } from '@/state/connectionStore';
import { useIsOffline } from '@/state/healthStore';
import { usePrefsStore } from '@/state/prefsStore';
import { toast } from '@/state/toastStore';
import { dashboardSections, slotStatusStyle, space } from '@/theme';

/** D1 — Team dashboard (SPEC §6.2, sections per §14.1.1). */
export default function Dashboard() {
  const runState = useRunState();
  const tasks = useTasks().data;
  const approvals = useApprovals().data;
  const actions = useAgentActions();
  const offline = useIsOffline();
  const host = useHostLabel();
  const [filter, setFilter] = useState<SectionKey | null>(null);
  const pull = usePullRefresh(runState.refetch);
  const sensitive = useSensitive();
  const hostId = useConnectionStore((s) => s.activeHostId) ?? undefined;
  const dismissed = usePrefsStore((s) => s.dismissedRejections);
  const updatePrefs = usePrefsStore((s) => s.update);

  const agents = runState.data?.agents;
  const sessionStatus = runState.data?.sessionStatus;
  const grouped = useMemo(() => {
    const map = new Map<SectionKey, Agent[]>();
    for (const a of sortAgents(agents ?? [], sessionStatus)) {
      const k = sectionOf(agentStatusKey(a, sessionStatus));
      map.set(k, [...(map.get(k) ?? []), a]);
    }
    return map;
  }, [agents, sessionStatus]);
  const count = (k: SectionKey) => grouped.get(k)?.length ?? 0;
  const open = tasks?.filter((t) => t.status === 'pending' || t.status === 'in_progress') ?? [];
  const yours = open.filter((t) => t.owner === 'user').length;
  // Agent controls are hidden while the team session isn't ready; Start is the only team action (§14.1.4).
  const sessionUp = sessionStatus === 'ready' || sessionStatus === undefined;

  // When an agent that was shutting down leaves the roster: "QA Engineer was removed" (SPEC §14.1.5).
  // Rev 4.5 has no 'approved' state: leaving the roster while the request is pending is the agreement.
  const removing = useRef(new Map<string, string>());
  useEffect(() => {
    if (!agents) return;
    const present = new Set(agents.map((a) => a.slotId));
    for (const [slotId, name] of removing.current) {
      if (!present.has(slotId)) toast(`${name} was removed`);
    }
    removing.current = new Map(
      agents.filter((a) => a.shutdown?.state === 'requested' || a.blockedReason === 'removing').map((a) => [a.slotId, a.name]),
    );
  }, [agents]);

  const rejectionKey = (a: Agent) => `${hostId}:${a.slotId}`;
  const rejectionFor = (a: Agent) =>
    hasShutdownOutcome(a) && dismissed[rejectionKey(a)] !== a.shutdown!.requestedAt
      ? {
          onKeepRunning: () => updatePrefs({ dismissedRejections: { ...dismissed, [rejectionKey(a)]: a.shutdown!.requestedAt } }),
          onAskAgain: canShutDown(a) && sessionUp ? () => void confirmShutdown(a, actions, sensitive, hostId) : undefined,
          onForceRemove: canForceRemove(a) && sessionUp ? () => confirmForceRemove(a, actions, sensitive, hostId) : undefined,
          forceIcon: sensitive.icon,
          forceDisabled: !sensitive.available,
        }
      : null;

  const guard = (fn: () => void) => () => (offline ? toast("Offline — can't send") : fn());

  const onReason = (agent: Agent) => (cta: NonNullable<ReasonCopy['cta']>) => {
    if (cta.kind === 'review' || cta.kind === 'answer') {
      if (cta.approvalId) router.push({ pathname: '/approval/[approvalId]', params: { approvalId: cta.approvalId } });
      else router.push('/approvals');
    } else if (cta.kind === 'reply') {
      openThread(agent.conversationId);
    } else if (cta.kind === 'task' && cta.taskId) {
      router.push({ pathname: '/tasks/[taskId]', params: { taskId: cta.taskId } });
    }
  };

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => <TeamSwitcherTitle />,
        headerRight: sessionUp ? () => <IconButton icon="add-circle-outline" label="Spawn agent" onPress={guard(() => router.push('/spawn'))} /> : undefined,
      }}
    />
  );

  if (!runState.data) {
    return (
      <View style={styles.flex}>
        {header}
        <TabChrome />
        {runState.isError ? <EmptyState title={`Can't load agents from ${host}.`} action={<Button title="Retry" onPress={() => void runState.refetch()} />} /> : <SkeletonList />}
      </View>
    );
  }

  // A team that isn't running has no meaningful sections: one flat list under the banner (§14.1.4, §16 #18).
  const flat = !(sessionStatus === 'ready' || sessionStatus === 'starting' || sessionStatus === undefined);
  const sections = flat
    ? [{ key: 'idle' as SectionKey, label: '' }]
    : dashboardSections.filter((s) => count(s.key) > 0 && (!filter || filter === s.key));
  const agentsIn = (key: SectionKey) => (flat ? sortAgents(agents ?? [], sessionStatus) : (grouped.get(key) ?? []));

  return (
    <View style={styles.flex}>
      {header}
      <TabChrome />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl {...pull} />}
      >
        <View style={styles.meta}>
          <FreshnessIndicator updatedAt={runState.dataUpdatedAt} onRefresh={() => void runState.refetch()} />
          <Text variant="caption" color="textMuted">
            · {host} · LAN
          </Text>
        </View>
        {runState.data.activeRun?.status === 'cancelling' ? (
          <Text variant="caption" color="stTransitionText">
            Stopping the current run…
          </Text>
        ) : null}

        {flat ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {dashboardSections
            .filter((s) => count(s.key) > 0)
            .map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                count={count(s.key)}
                dot={slotStatusStyle[s.statuses[0]].color}
                selected={filter === s.key}
                onPress={() => setFilter(filter === s.key ? null : s.key)}
              />
            ))}
          {/* "Tasks 3 · 1 yours" opens the board filtered to You when any are yours (SPEC §14.6). */}
          <Chip
            label={yours > 0 ? `Tasks ${open.length} · ${yours} yours` : 'Tasks'}
            count={yours > 0 ? undefined : open.length}
            onPress={() => router.push(yours > 0 ? { pathname: '/tasks', params: { owner: 'user' } } : '/tasks')}
          />
        </ScrollView>
        )}

        {agents && agents.length === 0 ? (
          <EmptyState title="No agents yet" action={<Button title="Spawn an agent" onPress={guard(() => router.push('/spawn'))} />} />
        ) : null}

        <View style={{ opacity: offline || isSessionDown(sessionStatus) ? 0.6 : 1 }}>
          {sections.map((s) => (
            <View key={s.key}>
              {s.label ? <SectionHeader title={s.label} /> : null}
              <View style={[styles.list, flat ? styles.flatList : null]}>
                {agentsIn(s.key).map((agent) => (
                  <SlotCard
                    key={agent.slotId}
                    agent={agent}
                    sessionStatus={sessionStatus}
                    approvals={approvals}
                    tasks={tasks}
                    disabled={offline}
                    onPress={() => router.push({ pathname: '/agent/[slot]', params: { slot: agent.slotId } })}
                    onLongPress={guard(() => showQuickActions(agent, actions, sensitive, hostId, sessionUp))}
                    onReasonAction={onReason(agent)}
                    rejection={rejectionFor(agent)}
                    actions={[
                      { name: 'message', label: 'Message', onActivate: () => openThread(agent.conversationId) },
                      ...(canStop(agent) && sessionUp
                        ? [{ name: 'stop', label: 'Stop turn', onActivate: guard(() => confirmStop(agent, actions, () => void promptInstruction(agent, actions))) }]
                        : []),
                    ]}
                  />
                ))}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.gutter, paddingTop: space.sm, paddingBottom: space.xxl },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  chips: { gap: space.sm, paddingVertical: space.md },
  list: { gap: space.md },
  flatList: { marginTop: space.md },
});
