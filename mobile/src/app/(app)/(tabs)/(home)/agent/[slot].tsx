import { router, Stack, useLocalSearchParams } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import {
  canForceRemove,
  canShutDown,
  confirmClearContext,
  confirmForceRemove,
  confirmShutdown,
  confirmStop,
  openThread,
  promptInstruction,
  promptRename,
} from '@/components/agentActions';
import { useSensitive } from '@/components/confirm';
import { hasShutdownOutcome, RejectedBlock } from '@/components/SlotCard';
import { pickOption } from '@/components/OptionSheet';
import { Avatar } from '@/components/Avatar';
import { FreshnessIndicator } from '@/components/Banners';
import { StatusPill } from '@/components/StatusPill';
import { TaskCard } from '@/components/TaskCard';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, IconButton, Row, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { usePullRefresh } from '@/components/usePullRefresh';
import { useActivity, useAgentActions, useApprovals, useRunState, useTasks } from '@/lib/api/hooks';
import type { Activity } from '@/lib/api/types';
import { agentReasonCopy, agentStatusKey, formatClock, formatDuration } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useConnectionStore } from '@/state/connectionStore';
import { useIsOffline } from '@/state/healthStore';
import { usePrefsStore } from '@/state/prefsStore';
import { toast } from '@/state/toastStore';
import { space } from '@/theme';

/** D2 — Agent detail (SPEC §6.3). */
export default function AgentDetail() {
  const { slot: slotId } = useLocalSearchParams<{ slot: string }>();
  const runState = useRunState();
  const tasks = useTasks().data ?? [];
  const approvals = useApprovals().data;
  const activity = useActivity(slotId).data;
  const sensitive = useSensitive();
  const hostId = useConnectionStore((s) => s.activeHostId) ?? undefined;
  // "Keep running" dismisses a declined shutdown on this phone only, keyed by its request time (SPEC §14.1.5).
  const dismissed = usePrefsStore((s) => s.dismissedRejections);
  const updatePrefs = usePrefsStore((s) => s.update);
  const actions = useAgentActions();
  const offline = useIsOffline();
  const pull = usePullRefresh(runState.refetch);
  const now = useNow();

  const agents = runState.data?.agents ?? [];
  const sessionStatus = runState.data?.sessionStatus;
  const slot = agents.find((a) => a.slotId === slotId);

  if (!runState.data) return <SkeletonList />;
  if (!slot) {
    return (
      <EmptyState title="This agent was removed." action={<Button title="Back" variant="secondary" onPress={() => router.back()} />} />
    );
  }

  const guard = (fn: () => void) => () => (offline ? toast("Offline — can't send") : fn());
  const status = agentStatusKey(slot, sessionStatus);
  const reason = agentReasonCopy(slot, { approvals, tasks, sessionStatus, now });
  const myTasks = tasks.filter((t) => t.owner === slot.slotId && t.status !== 'deleted');
  const running = slot.state === 'running' || slot.state === 'starting';
  const paused = slot.state === 'paused';
  const stuck = !running && !paused && (slot.queue.foreground > 0 || slot.runtime === 'dormant' || slot.runtime === 'failed');
  const queued = slot.queue.foreground;
  const rejectionKey = `${hostId}:${slot.slotId}`;
  const showRejection = hasShutdownOutcome(slot) && dismissed[rejectionKey] !== slot.shutdown!.requestedAt;
  // Agent controls are hidden while the team session isn't ready (§14.1.4).
  const sessionUp = sessionStatus === 'ready' || sessionStatus === undefined;

  // ⋯ menu (SPEC §14.1.5, §15.1.1): Force remove is last, and only after a declined shutdown.
  const menu = [
    { key: 'rename', label: 'Rename…', run: () => void promptRename(slot, actions) },
    { key: 'clear', label: 'Clear context…', run: () => confirmClearContext(slot, actions, sensitive, hostId) },
    ...(sessionUp && canShutDown(slot) ? [{ key: 'shutdown', label: 'Shut down…', destructive: true, run: () => void confirmShutdown(slot, actions, sensitive, hostId) }] : []),
    ...(sessionUp && canForceRemove(slot)
      ? [{ key: 'force', label: 'Force remove…', destructive: true, run: () => confirmForceRemove(slot, actions, sensitive, hostId) }]
      : []),
  ];
  const more = () => {
    if (menu.length === 1) return menu[0].run();
    void pickOption(slot.name, menu).then((key) => menu.find((m) => m.key === key)?.run());
  };

  const onReasonCta = () => {
    const cta = reason?.cta;
    if (!cta) return;
    if ((cta.kind === 'review' || cta.kind === 'answer') && cta.approvalId) router.push({ pathname: '/approval/[approvalId]', params: { approvalId: cta.approvalId } });
    else if (cta.kind === 'reply') openThread(slot.conversationId);
    else if (cta.kind === 'task' && cta.taskId) router.push({ pathname: '/tasks/[taskId]', params: { taskId: cta.taskId } });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: '',
          headerRight: menu.length > 0 ? () => <IconButton icon="ellipsis-horizontal" label="More actions" onPress={guard(more)} /> : undefined,
        }}
      />
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
        <View style={styles.header}>
          <Avatar id={slot.slotId} name={slot.name} lead={slot.role === 'lead'} size={56} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text variant="title">{slot.name}</Text>
            <Text variant="caption" color="textMuted">
              {slot.role === 'lead' ? 'Lead' : 'Teammate'}
              {slot.model ? ` · ${slot.model}` : ''}
            </Text>
            <View style={styles.statusRow}>
              <StatusPill status={status} size="md" />
              {slot.turn ? (
                <Text variant="caption" color="textMuted">
                  {formatDuration(now - slot.turn.startedAt)} in turn
                </Text>
              ) : null}
            </View>
            <FreshnessIndicator updatedAt={runState.dataUpdatedAt} onRefresh={() => void runState.refetch()} />
          </View>
        </View>

        <View style={styles.actions}>
          <Button title="Message" style={{ flex: 1 }} onPress={() => openThread(slot.conversationId)} />
          {/* Stop only during a turn; Wake when idle with queued messages; else Message alone (§6.3, §16 #5). */}
          {paused || !sessionUp ? null : slot.turn ? (
            <Button
              title={runState.data.activeRun?.status === 'cancelling' && runState.data.activeRun.targetSlotId === slot.slotId ? 'Stopping…' : 'Stop turn'}
              variant="dangerOutline"
              style={{ flex: 1 }}
              disabled={offline}
              onPress={() => confirmStop(slot, actions, () => void promptInstruction(slot, actions))}
            />
          ) : stuck ? (
            <Button title="Wake agent" variant="secondary" style={{ flex: 1 }} disabled={offline} onPress={() => actions.wake.mutate({ slotId: slot.slotId })} />
          ) : null}
        </View>
        {paused ? (
          <Text color="textMuted" style={{ marginTop: space.md }}>
            This agent is paused. Resume it from AionDX on your PC. Messages you send now are queued.
          </Text>
        ) : null}

        {showRejection ? (
          <>
            <SectionHeader title="Current" />
            <RejectedBlock
              agent={slot}
              now={now}
              inset={false}
              disabled={offline}
              onKeepRunning={() => updatePrefs({ dismissedRejections: { ...dismissed, [rejectionKey]: slot.shutdown!.requestedAt } })}
              onAskAgain={canShutDown(slot) && sessionUp ? () => void confirmShutdown(slot, actions, sensitive, hostId) : undefined}
              onForceRemove={canForceRemove(slot) && sessionUp ? () => confirmForceRemove(slot, actions, sensitive, hostId) : undefined}
              forceIcon={sensitive.icon}
              forceDisabled={!sensitive.available}
            />
          </>
        ) : null}

        {/* Paused is already said by the info line above; CURRENT would only repeat it (§16 #14). */}
        {reason && status !== 'paused' ? (
          <>
            <SectionHeader title="Current" />
            <Card accentColor={undefined}>
              <Text variant="headline">{reason.text}</Text>
              {reason.detail ? <Text variant={reason.detailIsCode ? 'mono' : 'body'} color="textMuted">{reason.detail}</Text> : null}
              {reason.cta ? (
                <Button title={reason.cta.label} compact style={styles.cta} disabled={offline && reason.cta.kind !== 'task'} onPress={onReasonCta} />
              ) : null}
            </Card>
          </>
        ) : null}

        <SectionHeader title={`Tasks (${myTasks.length})`} />
        <View style={styles.list}>
          {myTasks.length === 0 ? <Text color="textMuted">No tasks assigned.</Text> : null}
          {myTasks.map((t) => (
            <TaskCard key={t.taskId} task={t} tasks={tasks} agents={agents} onPress={() => router.push({ pathname: '/tasks/[taskId]', params: { taskId: t.taskId } })} />
          ))}
        </View>

        <SectionHeader title="Mailbox" />
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {queued > 0 ? (
            <Row icon="mail-outline" title={`${queued} queued message${queued === 1 ? '' : 's'}`} onPress={() => openThread(slot.conversationId)} />
          ) : (
            <Row icon="mail-outline" title="No queued messages" />
          )}
        </Card>

        <SectionHeader title="Recent activity" />
        <View style={styles.list}>
          {activity?.length ? (
            activity.slice(0, 20).map((a) => (
              <Text key={a.activityId} color="textMuted" numberOfLines={2}>
                • {formatClock(a.createdAt)} {activityText(a)}
              </Text>
            ))
          ) : (
            <Text color="textMuted">No recent activity.</Text>
          )}
        </View>
      </ScrollView>
    </>
  );
}

/** One line per mailbox message or task change (contract §6.8). */
function activityText(a: Activity): string {
  if (a.kind === 'task') return `Task "${a.task.subject}" · ${a.task.status.replace('_', ' ')}`;
  const { from, to, msgType, summary, content } = a.message;
  const what = msgType === 'message' ? (summary ?? content.split('\n')[0]) : msgType.replace(/_/g, ' ');
  return `${from.name} → ${to.name}: ${what}`;
}

const styles = StyleSheet.create({
  content: { padding: space.gutter, paddingBottom: space.xxl },
  header: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  list: { gap: space.sm },
  cta: { alignSelf: 'flex-start', marginTop: space.sm },
});
