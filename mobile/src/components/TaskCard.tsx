import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Card, Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { Agent, Task, TaskStatus } from '@/lib/api/types';
import { openBlockers, shortId, taskOwnerLabel } from '@/lib/format';
import { type ColorToken, radius, space, useColors, withAlpha } from '@/theme';

/** `color` for dots and tints; `textColor` for the label (text-safe contrast, SPEC §13.1). */
export const TASK_STATUS: Record<TaskStatus, { label: string; color: ColorToken; textColor: ColorToken }> = {
  pending: { label: 'Open', color: 'stIdle', textColor: 'stIdleText' },
  in_progress: { label: 'In progress', color: 'primary', textColor: 'primary' },
  completed: { label: 'Done', color: 'stWorking', textColor: 'stWorkingText' },
  deleted: { label: 'Deleted', color: 'textMuted', textColor: 'textMuted' },
};

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  const c = useColors();
  const s = TASK_STATUS[status];
  return (
    <View accessible accessibilityLabel={`Status: ${s.label}`} style={[styles.pill, { backgroundColor: withAlpha(c[s.color], 0.12) }]}>
      <View style={[styles.dot, { backgroundColor: c[s.color] }]} />
      <Text variant="caption" style={{ color: c[s.textColor], fontWeight: '600' }}>
        {s.label}
      </Text>
    </View>
  );
}

/** SPEC §4.5. */
export function TaskCard({ task, tasks, agents, onPress }: { task: Task; tasks: Task[]; agents: Agent[]; onPress?: () => void }) {
  const owner = agents.find((a) => a.slotId === task.owner);
  const ownerLabel = taskOwnerLabel(task);
  const blockers = openBlockers(task, tasks);
  const deleted = task.status === 'deleted';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[task.subject, TASK_STATUS[task.status].label, task.owner ? `owner ${ownerLabel}` : 'unassigned', blockers.length ? `blocked by ${blockers.length}` : null]
        .filter(Boolean)
        .join(', ')}
    >
      <Card style={[styles.card, deleted && { opacity: 0.6 }]}>
        <Text variant="headline" numberOfLines={2} style={deleted && { textDecorationLine: 'line-through' }}>
          {task.subject}
        </Text>
        <View style={styles.row}>
          {owner ? (
            <Avatar id={owner.slotId} name={owner.name} size={22} />
          ) : (
            <Icon name={task.owner === 'user' ? 'person' : task.owner ? 'remove-outline' : 'person-outline'} color={task.owner === 'user' ? 'primary' : 'textMuted'} />
          )}
          {/* Your own tasks stand out among agent-owned ones (SPEC §14.6). */}
          <Text variant="caption" color={task.owner === 'user' ? 'primary' : 'textMuted'} style={{ flex: 1 }} numberOfLines={1}>
            {ownerLabel}
          </Text>
          {blockers.length > 0 ? (
            <Text variant="caption" color="stWaitingText">
              ⛓ blocked by {blockers.length}
            </Text>
          ) : task.blocks.length > 0 ? (
            <Text variant="caption" color="textMuted">
              ⛓ blocks {task.blocks.length}
            </Text>
          ) : null}
        </View>
        <View style={styles.row}>
          <TaskStatusPill status={task.status} />
          <View style={{ flex: 1 }} />
          <Text variant="mono" color="textMuted">
            {shortId(task.taskId)}
          </Text>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.chip,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
