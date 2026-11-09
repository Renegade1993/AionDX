import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { StatusPill } from '@/components/StatusPill';
import { confirmDeleteTask, nextTaskStatus, OptionSheet, SwipeableTaskRow, warnIfBlocked } from '@/components/SwipeableTaskRow';
import { TASK_STATUS, TaskCard } from '@/components/TaskCard';
import { toastConfirmUnavailable, useSensitive } from '@/components/confirm';
import { TabChrome, TeamSwitcherTitle } from '@/components/TeamHeader';
import { Button } from '@/components/ui/Button';
import { Chip, EmptyState, Icon, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { usePullRefresh } from '@/components/usePullRefresh';
import { useCanWriteTasks, useRunState, useTasks, useUpdateTask } from '@/lib/api/hooks';
import type { Task, TaskStatus } from '@/lib/api/types';
import { agentStatusKey } from '@/lib/format';
import { useIsOffline } from '@/state/healthStore';
import { toast } from '@/state/toastStore';
import { space, touchTarget } from '@/theme';

type Segment = Extract<TaskStatus, 'pending' | 'in_progress' | 'completed'>;
const SEGMENTS: Segment[] = ['pending', 'in_progress', 'completed'];
const EMPTY_COPY: Record<Segment, string> = {
  pending: 'No open tasks',
  in_progress: 'No tasks in progress',
  completed: 'No completed tasks',
};

/**
 * SPEC §14.6: 'any' = Anyone, 'user' = You, 'unassigned' = no owner, 'removed' = an owner that
 * left the team, otherwise a slot id.
 */
type OwnerFilter = 'any' | 'user' | 'unassigned' | 'removed' | (string & {});

const OFFLINE = "Offline — can't send";

/** T1 — Task board (SPEC §6.8): status-segmented list, not a kanban. */
export default function TaskBoard() {
  const tasksQuery = useTasks();
  const runState = useRunState();
  const update = useUpdateTask();
  const offline = useIsOffline();
  // Each PC can switch task writes off (contract §6.7): without `tasks.write` the board is read-only.
  const canWrite = useCanWriteTasks();
  // Deleting a task is sensitive (contract §5.1).
  const sensitive = useSensitive();

  const [segment, setSegment] = useState<Segment>('pending');
  const [owner, setOwner] = useState<OwnerFilter>('any');
  // D1's "Tasks 3 · 1 yours" chip opens the board filtered to You (SPEC §14.6).
  // The tab stays mounted, so a new param is applied when it changes (not only on first mount).
  const params = useLocalSearchParams<{ owner?: string }>();
  const [ownerParam, setOwnerParam] = useState<string | undefined>(undefined);
  if (params.owner !== ownerParam) {
    setOwnerParam(params.owner);
    if (typeof params.owner === 'string' && params.owner) setOwner(params.owner);
  }
  const [showDeleted, setShowDeleted] = useState(false);
  const [ownerSheet, setOwnerSheet] = useState(false);

  const tasks = tasksQuery.data;
  const agents = useMemo(() => runState.data?.agents ?? [], [runState.data]);

  const refetchTasks = tasksQuery.refetch;
  const refetchRun = runState.refetch;
  const pull = usePullRefresh(() => Promise.all([refetchTasks(), refetchRun()]));

  const isRemoved = useMemo(() => {
    const live = new Set(agents.map((a) => a.slotId));
    return (t: Task) => !!t.owner && t.owner !== 'user' && !live.has(t.owner);
  }, [agents]);

  const byOwner = useMemo(() => {
    const all = tasks ?? [];
    if (owner === 'any') return all;
    if (owner === 'unassigned') return all.filter((t) => !t.owner);
    if (owner === 'removed') return all.filter(isRemoved);
    return all.filter((t) => t.owner === owner);
  }, [tasks, owner, isRemoved]);

  const counts = useMemo(() => {
    const n: Record<TaskStatus, number> = { pending: 0, in_progress: 0, completed: 0, deleted: 0 };
    for (const t of byOwner) n[t.status] += 1;
    return n;
  }, [byOwner]);

  const ownerLabel =
    owner === 'any'
      ? 'Anyone'
      : owner === 'user'
        ? 'You'
        : owner === 'unassigned'
          ? 'Unassigned'
          : owner === 'removed'
            ? 'Removed agents'
            : (agents.find((a) => a.slotId === owner)?.name ?? owner);

  const guard = (fn: () => void) => () => (offline ? toast(OFFLINE) : fn());

  const advance = (task: Task) => {
    if (offline) return toast(OFFLINE);
    const next = nextTaskStatus(task.status);
    if (!next) return;
    warnIfBlocked(task, tasks ?? [], (m) => toast(m));
    update.mutate({ taskId: task.taskId, patch: { status: next } });
  };

  const remove = (task: Task) => {
    if (offline) return toast(OFFLINE);
    if (!sensitive.available) return toastConfirmUnavailable(sensitive.state);
    confirmDeleteTask(task, () => update.mutate({ taskId: task.taskId, patch: { status: 'deleted' }, subject: task.subject }));
  };

  const openTask = (taskId: string) => router.push({ pathname: '/tasks/[taskId]', params: { taskId } });
  const createTask = guard(() => router.push('/task-edit'));

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => <TeamSwitcherTitle />,
        headerRight: canWrite ? () => (
          <Pressable
            onPress={createTask}
            accessibilityRole="button"
            accessibilityLabel="New task"
            accessibilityState={{ disabled: offline }}
            hitSlop={8}
            style={[styles.headerButton, offline && styles.dimmed]}
          >
            <Icon name="add" size={22} color="primary" />
            <Text variant="headline" color="primary">
              New
            </Text>
          </Pressable>
        ) : undefined,
      }}
    />
  );

  if (!tasks) {
    return (
      <View style={styles.flex}>
        {header}
        <TabChrome />
        {tasksQuery.isError ? (
          <EmptyState title="Can't load tasks." action={<Button title="Retry" onPress={() => void tasksQuery.refetch()} />} />
        ) : (
          <SkeletonList />
        )}
      </View>
    );
  }

  const visible = byOwner.filter((t) => t.status === segment);
  const deleted = showDeleted ? byOwner.filter((t) => t.status === 'deleted') : [];
  const sections = [
    ...(visible.length ? [{ key: 'main', title: '', data: visible }] : []),
    ...(deleted.length ? [{ key: 'deleted', title: `Deleted (${deleted.length})`, data: deleted }] : []),
  ];

  const ownerOptions = [
    { key: 'any', label: 'Anyone', left: <Icon name="people-outline" color="textMuted" />, selected: owner === 'any' },
    { key: 'user', label: 'You', left: <Icon name="person" color="primary" />, selected: owner === 'user' },
    { key: 'unassigned', label: 'Unassigned', left: <Icon name="person-outline" color="textMuted" />, selected: owner === 'unassigned' },
    ...agents.map((a) => ({
      key: a.slotId,
      label: a.name,
      left: <Avatar id={a.slotId} name={a.name} lead={a.role === 'lead'} size={28} />,
      right: <StatusPill status={agentStatusKey(a, runState.data?.sessionStatus)} />,
      selected: owner === a.slotId,
    })),
    ...(tasks.some(isRemoved)
      ? [{ key: 'removed', label: 'Removed agents', left: <Icon name="remove-outline" color="textMuted" />, selected: owner === 'removed' }]
      : []),
  ];

  const listHeader = (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {SEGMENTS.map((s) => (
          <Chip
            key={s}
            label={TASK_STATUS[s].label}
            count={counts[s]}
            dot={TASK_STATUS[s].color}
            selected={segment === s}
            onPress={() => setSegment(s)}
          />
        ))}
      </ScrollView>
      <View style={styles.filters}>
        <Chip label={`Owner: ${ownerLabel} ▾`} selected={owner !== 'any'} onPress={() => setOwnerSheet(true)} />
        <Chip label={showDeleted ? 'Hide deleted' : 'Show deleted'} selected={showDeleted} onPress={() => setShowDeleted((v) => !v)} />
      </View>
      {visible.length === 0 ? (
        <EmptyState
          title={owner === 'any' ? EMPTY_COPY[segment] : `${EMPTY_COPY[segment]} for ${ownerLabel}`}
          action={segment === 'pending' && canWrite ? <Button title="Create task" onPress={createTask} style={offline && styles.dimmed} /> : undefined}
        />
      ) : null}
    </View>
  );

  return (
    <View style={styles.flex}>
      {header}
      <TabChrome />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.taskId}
        contentContainerStyle={styles.content}
        style={offline && styles.dimmed}
        ListHeaderComponent={listHeader}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl {...pull} />}
        renderSectionHeader={({ section }) => (section.title ? <SectionHeader title={section.title} /> : null)}
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => (
          canWrite ? (
            <SwipeableTaskRow task={item} tasks={tasks} agents={agents} onPress={() => openTask(item.taskId)} onAdvance={advance} onDelete={remove} />
          ) : (
            <TaskCard task={item} tasks={tasks} agents={agents} onPress={() => openTask(item.taskId)} />
          )
        )}
      />
      <OptionSheet
        visible={ownerSheet}
        title="Filter by owner"
        options={ownerOptions}
        onClose={() => setOwnerSheet(false)}
        onSelect={(key) => setOwner(key)}
      />
    </View>
  );
}

function Separator() {
  return <View style={{ height: space.md }} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: space.gutter, paddingBottom: space.xxl },
  chips: { gap: space.sm, paddingTop: space.md, paddingBottom: space.sm },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingBottom: space.md },
  headerButton: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: touchTarget, paddingHorizontal: space.xs },
  dimmed: { opacity: 0.6 },
});
