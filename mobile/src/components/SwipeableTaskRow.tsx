import { useRef } from 'react';
import { type AccessibilityActionEvent, Alert, Platform, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods, SwipeDirection } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { Extrapolation, interpolate, type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

import { TASK_STATUS, TaskCard } from '@/components/TaskCard';
import { Icon, type IconName } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { Agent, Task, TaskStatus } from '@/lib/api/types';
import { openBlockers, taskOwnerLabel } from '@/lib/format';
import { type ColorToken, radius, space, useColors, useReduceMotion } from '@/theme';

export { OptionSheet, type SheetOption } from './OptionSheet';

// ---------------------------------------------------------------------------
// Task status helpers (shared by T1 / T2)
// ---------------------------------------------------------------------------

/** Swipe-right progression (SPEC §6.8): pending → in_progress → completed. */
export function nextTaskStatus(status: TaskStatus): TaskStatus | null {
  if (status === 'pending') return 'in_progress';
  if (status === 'in_progress') return 'completed';
  return null;
}

const ADVANCE: Partial<Record<TaskStatus, { label: string; icon: IconName; color: ColorToken }>> = {
  pending: { label: 'Start', icon: 'play', color: TASK_STATUS.in_progress.color },
  in_progress: { label: 'Done', icon: 'checkmark-done', color: TASK_STATUS.completed.color },
};

/** "Blocked by: {subject}" warning — still allows the change (user override, SPEC §6.8). */
export function warnIfBlocked(task: Task, all: Task[], notify: (message: string) => void) {
  const blockers = openBlockers(task, all);
  if (blockers.length > 0) notify(`Blocked by: ${blockers.map((b) => b.subject).join(', ')}`);
}

/** ConfirmSheet (SPEC §4.10): Cancel is the default, destructive action in red. */
export function confirmDeleteTask(task: Task, onConfirm: () => void) {
  Alert.alert(
    'Delete task?',
    `"${task.subject}" will be removed from the board.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ],
    { cancelable: true },
  );
}

// ---------------------------------------------------------------------------
// Swipeable row (T1)
// ---------------------------------------------------------------------------

const ACTION_WIDTH = 112;

function SwipeAction({
  progress,
  color,
  icon,
  label,
  side,
}: {
  progress: SharedValue<number>;
  color: string;
  icon: IconName;
  label: string;
  side: 'left' | 'right';
}) {
  const c = useColors();
  const reduceMotion = useReduceMotion();
  const animated = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4, 1], [0, 0.5, 1], Extrapolation.CLAMP),
    transform: [{ scale: reduceMotion ? 1 : interpolate(progress.value, [0, 1], [0.8, 1], Extrapolation.CLAMP) }],
  }));
  // Hidden until the row actually moves, otherwise the colour shows at the card's rounded corners.
  const panel = useAnimatedStyle(() => ({ opacity: progress.value > 0.01 ? 1 : 0 }));
  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.action, { backgroundColor: color, justifyContent: side === 'left' ? 'flex-start' : 'flex-end' }, panel]}
    >
      <Animated.View style={[styles.actionInner, animated]}>
        <Icon name={icon} size={22} color="onPrimary" />
        <Text variant="caption" style={{ color: c.onPrimary, fontWeight: '700' }}>
          {label}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

export interface SwipeableTaskRowProps {
  task: Task;
  tasks: Task[];
  agents: Agent[];
  onPress: () => void;
  /** Swipe right / "Advance status" accessibility action. */
  onAdvance: (task: Task) => void;
  /** Swipe left / "Delete" accessibility action. Caller confirms. */
  onDelete: (task: Task) => void;
}

/**
 * TaskCard with swipe actions (SPEC §6.8): swipe right reveals the next status
 * color + label and advances; swipe left reveals Delete. Every gesture has an
 * accessibility action and a button equivalent on T2 (SPEC §9).
 */
export function SwipeableTaskRow({ task, tasks, agents, onPress, onAdvance, onDelete }: SwipeableTaskRowProps) {
  const c = useColors();
  const ref = useRef<SwipeableMethods>(null);
  const advance = ADVANCE[task.status];
  const canDelete = task.status !== 'deleted';

  const blockers = openBlockers(task, tasks);
  const a11yLabel = [
    task.subject,
    TASK_STATUS[task.status].label,
    task.owner ? `owner ${taskOwnerLabel(task)}` : 'unassigned',
    blockers.length ? `blocked by ${blockers.length}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const a11yActions = [
    { name: 'activate', label: 'Open task' },
    ...(advance ? [{ name: 'advance', label: `Advance status to ${TASK_STATUS[nextTaskStatus(task.status)!].label}` }] : []),
    ...(canDelete ? [{ name: 'delete', label: 'Delete' }] : []),
  ];

  const onA11yAction = (e: AccessibilityActionEvent) => {
    switch (e.nativeEvent.actionName) {
      case 'activate':
        onPress();
        break;
      case 'advance':
        onAdvance(task);
        break;
      case 'delete':
        onDelete(task);
        break;
    }
  };

  // On web the pointer-up that ends a swipe also reaches the card as a click; ignore taps right after a swipe.
  const swipedAt = useRef(0);
  const markSwipe = () => {
    swipedAt.current = Date.now();
  };
  const onCardPress = () => {
    if (Date.now() - swipedAt.current > 400) onPress();
  };

  const onOpen = (direction: SwipeDirection) => {
    markSwipe();
    ref.current?.close();
    // Act after the close animation: the change can move/unmount this row, and unmounting while the
    // gesture is still settling makes gesture-handler throw ("No handler for tag").
    setTimeout(() => {
      if (direction === SwipeDirection.RIGHT && advance) onAdvance(task);
      else if (direction === SwipeDirection.LEFT && canDelete) onDelete(task);
    }, 300);
  };

  return (
    <View
      accessible
      // On native this groups the row into one element with swipe actions. On web the role would
      // render a <button> around the card's own button (invalid HTML), so the card keeps that role there.
      accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
      accessibilityLabel={a11yLabel}
      accessibilityHint="Double-tap for details. Swipe actions available."
      accessibilityActions={a11yActions}
      onAccessibilityAction={onA11yAction}
    >
      <ReanimatedSwipeable
        ref={ref}
        friction={1.5}
        leftThreshold={ACTION_WIDTH * 0.6}
        rightThreshold={ACTION_WIDTH * 0.6}
        overshootFriction={8}
        containerStyle={styles.container}
        onSwipeableOpen={onOpen}
        onSwipeableOpenStartDrag={markSwipe}
        onSwipeableCloseStartDrag={markSwipe}
        renderLeftActions={
          advance
            ? (progress) => <SwipeAction progress={progress} color={c[advance.color]} icon={advance.icon} label={advance.label} side="left" />
            : undefined
        }
        renderRightActions={
          canDelete ? (progress) => <SwipeAction progress={progress} color={c.danger} icon="trash-outline" label="Delete" side="right" /> : undefined
        }
      >
        <TaskCard task={task} tasks={tasks} agents={agents} onPress={onCardPress} />
      </ReanimatedSwipeable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: radius.card },
  action: { width: ACTION_WIDTH, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg },
  actionInner: { alignItems: 'center', gap: space.xs },
});
