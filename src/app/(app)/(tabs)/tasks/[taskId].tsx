import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Markdown } from '@/components/Markdown';
import { EdgeFade } from '@/components/ui/EdgeFade';
import { StatusPill } from '@/components/StatusPill';
import { confirmDeleteTask, OptionSheet, type SheetOption, warnIfBlocked } from '@/components/SwipeableTaskRow';
import { TASK_STATUS, TaskStatusPill } from '@/components/TaskCard';
import { toastConfirmUnavailable, useSensitive } from '@/components/confirm';
import { TabChrome } from '@/components/TeamHeader';
import { Button } from '@/components/ui/Button';
import { Card, Divider, EmptyState, Icon, IconButton, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { usePullRefresh } from '@/components/usePullRefresh';
import { useCanWriteTasks, useRunState, useTasks, useUpdateTask } from '@/lib/api/hooks';
import type { Task, TaskPatch, TaskStatus } from '@/lib/api/types';
import { agentStatusKey, shortId, taskOwnerLabel } from '@/lib/format';
import { useIsOffline } from '@/state/healthStore';
import { toast } from '@/state/toastStore';
import { space, touchTarget, type, useColors } from '@/theme';

const OFFLINE = "Offline — can't send";
const UNASSIGNED = '__unassigned';
const DESCRIPTION_LINES = 12;
const COLLAPSED_HEIGHT = DESCRIPTION_LINES * type.body.lineHeight;
const PICKABLE_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed'];

type SheetKind = 'menu' | 'status' | 'owner' | 'blocker';

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/tasks');
}

/** T2 — Task detail (SPEC §6.9). Every change saves immediately and optimistically. */
export default function TaskDetail() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const tasksQuery = useTasks();
  const runState = useRunState();
  const update = useUpdateTask();
  const offline = useIsOffline();
  // Without `tasks.write` the detail screen is read-only: no status, owner, blocker or menu edits.
  const canWrite = useCanWriteTasks();
  // Deleting a task is sensitive (contract §5.1): its menu row carries the confirmation glyph.
  const sensitive = useSensitive();
  const [sheet, setSheet] = useState<SheetKind | null>(null);

  const refetchTasks = tasksQuery.refetch;
  const pull = usePullRefresh(refetchTasks);

  const tasks = tasksQuery.data;
  const agents = runState.data?.agents ?? [];
  const sessionStatus = runState.data?.sessionStatus;
  const task = tasks?.find((t) => t.taskId === taskId);

  if (!tasks || !task) {
    const removed = !!tasks && !task;
    return (
      <View style={styles.flex}>
        <Stack.Screen options={{ title: '' }} />
        <TabChrome />
        {removed ? (
          <EmptyState title="This task was removed" action={<Button title="Back" variant="secondary" onPress={goBack} />} />
        ) : tasksQuery.isError ? (
          <EmptyState title="Can't load this task." action={<Button title="Retry" onPress={() => void tasksQuery.refetch()} />} />
        ) : (
          <SkeletonList rows={3} />
        )}
      </View>
    );
  }

  const owner = agents.find((a) => a.slotId === task.owner);
  const ownerName = taskOwnerLabel(task, runState.data);

  const mutate = (patch: TaskPatch) => {
    if (offline) return toast(OFFLINE);
    update.mutate({ taskId: task.taskId, patch });
  };
  const open = (kind: SheetKind) => (offline && kind !== 'menu' ? toast(OFFLINE) : setSheet(kind));
  const closeSheet = () => setSheet(null);

  const setStatus = (status: TaskStatus) => {
    if (status === task.status) return;
    if (status !== 'pending') warnIfBlocked(task, tasks, (m) => toast(m));
    mutate({ status });
  };

  const reassign = (key: string) => {
    const nextOwner = key === UNASSIGNED ? null : key;
    if (nextOwner === task.owner) return;
    const apply = () => mutate({ owner: nextOwner });
    const busy = owner && owner.state === 'running' && (!owner.currentTask || owner.currentTask.taskId === task.taskId);
    if (busy) {
      Alert.alert(`${owner.name} is working on this. Reassign anyway?`, undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reassign', style: 'destructive', onPress: apply },
      ]);
    } else {
      apply();
    }
  };

  const remove = () => {
    if (offline) return toast(OFFLINE);
    if (!sensitive.available) return toastConfirmUnavailable(sensitive.state);
    confirmDeleteTask(task, () => {
      update.mutate({ taskId: task.taskId, patch: { status: 'deleted' }, subject: task.subject });
      toast('Task deleted');
      goBack();
    });
  };

  const onMenu = (key: string) => {
    if (key === 'edit') {
      if (offline) return toast(OFFLINE);
      router.push({ pathname: '/task-edit', params: { taskId: task.taskId } });
    } else if (key === 'delete') {
      remove();
    }
  };

  const copyId = async () => {
    await Clipboard.setStringAsync(task.taskId);
    toast('Task ID copied', 'success');
  };

  // Dependencies — "Blocks" is derived from every task's blockedBy too, so it stays correct
  // even before the server back-fills `blocks` after an edit.
  const blockerIds = task.blockedBy;
  const blocksIds = [...new Set([...task.blocks, ...tasks.filter((t) => t.blockedBy.includes(task.taskId)).map((t) => t.taskId)])];
  const blockerCandidates = tasks.filter(
    (t) => t.taskId !== task.taskId && t.status !== 'completed' && t.status !== 'deleted' && !blockerIds.includes(t.taskId) && !blocksIds.includes(t.taskId),
  );

  const statusOptions: SheetOption[] = PICKABLE_STATUSES.map((s) => ({
    key: s,
    label: TASK_STATUS[s].label,
    left: <Icon name="ellipse" size={12} color={TASK_STATUS[s].color} />,
    selected: task.status === s,
  }));

  // SPEC §14.6: You, Unassigned, then agents. The PC notifies a new owner itself (contract §6.7).
  const ownerOptions: SheetOption[] = [
    { key: 'user', label: 'You', left: <Icon name="person" color="primary" />, selected: task.owner === 'user' },
    { key: UNASSIGNED, label: 'Unassigned', left: <Icon name="person-outline" color="textMuted" />, selected: !task.owner },
    ...agents.map((a) => ({
      key: a.slotId,
      label: a.name,
      left: <Avatar id={a.slotId} name={a.name} lead={a.role === 'lead'} size={28} />,
      right: <StatusPill status={agentStatusKey(a, sessionStatus)} />,
      selected: task.owner === a.slotId,
    })),
  ];

  const blockerOptions: SheetOption[] = blockerCandidates.map((t) => ({
    key: t.taskId,
    label: t.subject,
    description: `${TASK_STATUS[t.status].label} · ${shortId(t.taskId)}`,
  }));

  const menuOptions: SheetOption[] = [
    { key: 'edit', label: 'Edit', left: <Icon name="create-outline" color="text" /> },
    ...(task.status !== 'deleted'
      ? [
          {
            key: 'delete',
            label: 'Delete',
            destructive: true,
            description: sensitive.available ? undefined : 'Confirmations unavailable on this PC',
            left: <Icon name={sensitive.icon ?? 'trash-outline'} color="danger" />,
          },
        ]
      : []),
  ];

  const deleted = task.status === 'deleted';

  return (
    <View style={styles.flex}>
      <Stack.Screen
        options={{
          title: '',
          headerRight: canWrite ? () => <IconButton icon="ellipsis-horizontal" label="More actions" onPress={() => open('menu')} /> : undefined,
        }}
      />
      <TabChrome />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl {...pull} />}
        style={offline && styles.dimmed}
      >
        <Text variant="title" accessibilityRole="header" style={deleted && styles.strike}>
          {task.subject}
        </Text>

        {canWrite ? (
          <Pressable
            onPress={() => open('status')}
            accessibilityRole="button"
            accessibilityLabel={`Status: ${TASK_STATUS[task.status].label}. Change status`}
            hitSlop={8}
            style={styles.statusButton}
          >
            <TaskStatusPill status={task.status} />
            <Icon name="chevron-down" size={16} color="textMuted" />
          </Pressable>
        ) : (
          <View style={styles.statusButton}>
            <TaskStatusPill status={task.status} />
          </View>
        )}

        <Card style={styles.fields}>
          <Pressable
            onPress={canWrite ? () => open('owner') : undefined}
            disabled={!canWrite}
            accessibilityRole={canWrite ? 'button' : undefined}
            accessibilityLabel={`Owner: ${ownerName}${owner ? `, ${agentStatusKey(owner, sessionStatus)}` : ''}${canWrite ? '. Reassign' : ''}`}
            style={styles.field}
          >
            <Text variant="caption" color="textMuted" style={styles.fieldLabel}>
              Owner
            </Text>
            {owner ? (
              <Avatar id={owner.slotId} name={owner.name} lead={owner.role === 'lead'} size={24} />
            ) : (
              <Icon name={task.owner === 'user' ? 'person' : task.owner ? 'remove-outline' : 'person-outline'} color={task.owner === 'user' ? 'primary' : 'textMuted'} />
            )}
            <View style={styles.ownerValue}>
              <Text style={styles.shrink} numberOfLines={1} color={task.owner === 'user' ? 'primary' : 'text'}>
                {ownerName}
              </Text>
              {owner ? <StatusPill status={agentStatusKey(owner, sessionStatus)} /> : null}
            </View>
            {canWrite ? <Icon name="chevron-down" size={16} color="textMuted" /> : null}
          </Pressable>
          <Divider />
          <View style={styles.field}>
            <Text variant="caption" color="textMuted" style={styles.fieldLabel}>
              ID
            </Text>
            <Text variant="mono" style={styles.fieldValue} selectable accessibilityLabel={`Task ID ${task.taskId}`}>
              {shortId(task.taskId)}
            </Text>
            <IconButton icon="copy-outline" label="Copy task ID" onPress={() => void copyId()} />
          </View>
        </Card>

        <View>
          <SectionHeader title="Description" />
          <Description text={task.description ?? undefined} />
        </View>

        <View>
          <SectionHeader
            title="Dependencies"
            right={
              canWrite ? (
              <Pressable
                onPress={() => (offline ? toast(OFFLINE) : blockerCandidates.length === 0 ? toast('No open tasks to add') : setSheet('blocker'))}
                accessibilityRole="button"
                accessibilityLabel="Add blocker"
                hitSlop={8}
                style={styles.addButton}
              >
                <Icon name="add" size={18} color="primary" />
                <Text variant="caption" color="primary" style={styles.bold}>
                  Add
                </Text>
              </Pressable>
              ) : undefined
            }
          />
          <Card style={styles.deps}>
            <Text variant="caption" color="textMuted" style={styles.bold}>
              Blocked by
            </Text>
            {blockerIds.length === 0 ? (
              <Text color="textMuted">None</Text>
            ) : (
              blockerIds.map((id) => (
                <DependencyRow
                  key={id}
                  id={id}
                  tasks={tasks}
                  onRemove={canWrite ? () => mutate({ blockedBy: blockerIds.filter((b) => b !== id) }) : undefined}
                />
              ))
            )}
            <Divider />
            <Text variant="caption" color="textMuted" style={styles.bold}>
              Blocks
            </Text>
            {blocksIds.length === 0 ? <Text color="textMuted">None</Text> : blocksIds.map((id) => <DependencyRow key={id} id={id} tasks={tasks} />)}
          </Card>
        </View>

        {/* [Message owner] + one primary status action (button equivalent of the T1 swipe, SPEC §9).
            Delete is only in the ⋯ menu so it never sits beside a primary action (SPEC §13.4). */}
        <View style={styles.actions}>
          {owner ? (
            <Button
              title="Message owner"
              variant="secondary"
              style={styles.flex}
              onPress={() => router.push({ pathname: '/chat/[conversationId]', params: { conversationId: owner.conversationId } })}
            />
          ) : null}
          {canWrite && task.status === 'pending' ? <Button title="Start task" variant="primary" onPress={() => setStatus('in_progress')} style={styles.flex} /> : null}
          {canWrite && task.status === 'in_progress' ? <Button title="Mark done" variant="primary" onPress={() => setStatus('completed')} style={styles.flex} /> : null}
          {canWrite && deleted ? <Button title="Restore" variant="primary" onPress={() => setStatus('pending')} style={styles.flex} /> : null}
        </View>
      </ScrollView>

      <OptionSheet visible={sheet === 'menu'} title="Task" options={menuOptions} onClose={closeSheet} onSelect={onMenu} />
      <OptionSheet
        visible={sheet === 'status'}
        title="Change status"
        options={statusOptions}
        onClose={closeSheet}
        onSelect={(key) => setStatus(key as TaskStatus)}
      />
      <OptionSheet visible={sheet === 'owner'} title="Reassign task" options={ownerOptions} onClose={closeSheet} onSelect={reassign} />
      <OptionSheet
        visible={sheet === 'blocker'}
        title="Add blocker"
        message="This task will wait until the selected task is done."
        options={blockerOptions}
        onClose={closeSheet}
        onSelect={(id) => mutate({ blockedBy: [...blockerIds, id] })}
      />
    </View>
  );
}

/**
 * Task descriptions are Markdown (SPEC §12.6). Collapsed to ~12 body lines with "Show more". Markdown
 * isn't a single Text, so the decision uses the rendered container height, not onTextLayout lines.
 */
function Description({ text }: { text?: string }) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  if (!text?.trim()) return <Text color="textMuted">No description</Text>;
  const overflows = fullHeight > COLLAPSED_HEIGHT + 4;
  return (
    <View>
      <View style={overflows && !expanded ? styles.collapsed : undefined}>
        {/* Unconstrained child: its layout height is the full rendered height even while the parent clips. */}
        <View onLayout={(e) => setFullHeight(e.nativeEvent.layout.height)}>
          <Markdown>{text}</Markdown>
        </View>
        {overflows && !expanded ? <EdgeFade edge="bottom" color={c.bg} size={24} /> : null}
      </View>
      {overflows ? (
        <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button" hitSlop={8} style={styles.more}>
          <Text color="primary" style={styles.bold}>
            {expanded ? 'Show less' : 'Show more'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DependencyRow({ id, tasks, onRemove }: { id: string; tasks: Task[]; onRemove?: () => void }) {
  const c = useColors();
  const dep = tasks.find((t) => t.taskId === id);
  const label = dep?.subject ?? `Unknown task ${shortId(id)}`;
  return (
    <View style={styles.depRow}>
      <Pressable
        onPress={dep ? () => router.push({ pathname: '/tasks/[taskId]', params: { taskId: id } }) : undefined}
        disabled={!dep}
        accessibilityRole="button"
        accessibilityLabel={[label, dep ? TASK_STATUS[dep.status].label : null].filter(Boolean).join(', ')}
        style={({ pressed }) => [styles.depMain, pressed && { backgroundColor: c.surfaceAlt }]}
      >
        {dep ? <TaskStatusPill status={dep.status} /> : null}
        <Text style={[styles.flex, dep?.status === 'deleted' && styles.strike]} color={dep ? 'text' : 'textMuted'} numberOfLines={2}>
          {label}
        </Text>
        {dep ? <Icon name="chevron-forward" color="textMuted" /> : null}
      </Pressable>
      {onRemove ? <IconButton icon="close" label={`Remove blocker ${label}`} color="textMuted" onPress={onRemove} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.gutter, gap: space.lg, paddingBottom: space.xxl },
  dimmed: { opacity: 0.6 },
  strike: { textDecorationLine: 'line-through' },
  bold: { fontWeight: '600' },
  statusButton: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: touchTarget, alignSelf: 'flex-start' },
  fields: { paddingVertical: 0 },
  field: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touchTarget + 4 },
  fieldLabel: { width: 56, fontWeight: '600' },
  fieldValue: { flex: 1 },
  ownerValue: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  shrink: { flexShrink: 1 },
  addButton: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: touchTarget, minWidth: touchTarget, justifyContent: 'flex-end' },
  deps: { gap: space.sm },
  depRow: { flexDirection: 'row', alignItems: 'center' },
  depMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touchTarget, borderRadius: 8 },
  more: { minHeight: touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  collapsed: { maxHeight: COLLAPSED_HEIGHT, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: space.md },
});
