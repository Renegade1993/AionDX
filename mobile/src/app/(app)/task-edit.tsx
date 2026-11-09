import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { StatusPill } from '@/components/StatusPill';
import { TASK_STATUS, TaskStatusPill } from '@/components/TaskCard';
import { Button } from '@/components/ui/Button';
import { Card, Divider, EmptyState, Icon, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { useCanWriteTasks, useCreateTask, useHostInfo, useRunState, useTasks, useUpdateTask } from '@/lib/api/hooks';
import type { Task, TaskPatch } from '@/lib/api/types';
import { agentStatusKey, shortId } from '@/lib/format';
import { useIsOffline } from '@/state/healthStore';
import { toast } from '@/state/toastStore';
import { radius, space, touchTarget, type as typeScale, useColors } from '@/theme';

const OFFLINE = "Offline — can't send";
const SUBJECT_MAX = 200;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/tasks');
}

/**
 * T3 — Create / edit task (SPEC §6.10). Route `/task-edit`, optional params:
 * `taskId` (edit mode), `subject` / `description` (prefill from chat "Create task from message").
 */
export default function TaskEditScreen() {
  const params = useLocalSearchParams<{ taskId?: string; subject?: string; description?: string }>();
  const taskId = first(params.taskId);
  const tasksQuery = useTasks();
  const editing = !!taskId;
  const task = editing ? tasksQuery.data?.find((t) => t.taskId === taskId) : undefined;
  const title = editing ? 'Edit task' : 'New task';
  const hostInfo = useHostInfo();
  const canWrite = useCanWriteTasks();

  // Every entry point is hidden without `tasks.write`; this guards deep links and stale navigation.
  if (!canWrite) {
    return (
      <View style={styles.flex}>
        <Stack.Screen options={{ title, headerLeft: () => <CancelButton /> }} />
        {hostInfo.isPending ? (
          <SkeletonList rows={3} />
        ) : (
          <EmptyState title="Editing tasks from the phone isn't turned on for this PC." action={<Button title="Back" variant="secondary" onPress={close} />} />
        )}
      </View>
    );
  }

  if (editing && !task) {
    return (
      <View style={styles.flex}>
        <Stack.Screen options={{ title, headerLeft: () => <CancelButton /> }} />
        {tasksQuery.data ? (
          <EmptyState title="This task was removed" action={<Button title="Back" variant="secondary" onPress={close} />} />
        ) : tasksQuery.isError ? (
          <EmptyState title="Can't load this task." action={<Button title="Retry" onPress={() => void tasksQuery.refetch()} />} />
        ) : (
          <SkeletonList rows={3} />
        )}
      </View>
    );
  }

  // Keyed so the form's initial state is taken from the task once it's available.
  return (
    <TaskForm
      key={task?.taskId ?? 'new'}
      title={title}
      task={task}
      initialSubject={task?.subject ?? first(params.subject) ?? ''}
      initialDescription={task?.description ?? first(params.description) ?? ''}
    />
  );
}

function CancelButton() {
  return (
    <Pressable onPress={close} accessibilityRole="button" hitSlop={8} style={styles.headerButton}>
      <Text variant="headline" color="primary" style={{ fontWeight: '400' }}>
        Cancel
      </Text>
    </Pressable>
  );
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function TaskForm({ title, task, initialSubject, initialDescription }: { title: string; task?: Task; initialSubject: string; initialDescription: string }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const tasksData = useTasks().data;
  const tasks = useMemo(() => tasksData ?? [], [tasksData]);
  const runState = useRunState().data;
  const agents = runState?.agents ?? [];
  const create = useCreateTask();
  const update = useUpdateTask();
  const offline = useIsOffline();

  const [subject, setSubject] = useState(initialSubject.slice(0, SUBJECT_MAX));
  const [description, setDescription] = useState(initialDescription);
  // null = unassigned, 'user' = You, otherwise a slot id (contract §6.7).
  const [owner, setOwner] = useState<string | null>(task?.owner ?? null);
  const [blockedBy, setBlockedBy] = useState<string[]>(task?.blockedBy ?? []);
  const [search, setSearch] = useState('');

  const trimmed = subject.trim();
  const pending = create.isPending;
  const canSubmit = trimmed.length > 0 && !pending;

  // Non-completed tasks (plus any already selected, so they can be unchecked). Exclude this task
  // and tasks it blocks, which would create a cycle.
  const candidates = useMemo(() => {
    const blockedByThis = new Set(task ? tasks.filter((t) => t.blockedBy.includes(task.taskId)).map((t) => t.taskId) : []);
    return tasks.filter(
      (t) =>
        t.taskId !== task?.taskId &&
        !blockedByThis.has(t.taskId) &&
        (blockedBy.includes(t.taskId) || (t.status !== 'completed' && t.status !== 'deleted')),
    );
  }, [tasks, task, blockedBy]);

  const q = search.trim().toLowerCase();
  const filtered = q ? candidates.filter((t) => t.subject.toLowerCase().includes(q) || t.taskId.toLowerCase().includes(q)) : candidates;

  const toggleBlocker = (id: string) => setBlockedBy((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = () => {
    if (offline) return toast(OFFLINE);
    if (!canSubmit) return;
    const desc = description.trim();
    if (task) {
      const patch: TaskPatch = {};
      if (trimmed !== task.subject) patch.subject = trimmed;
      if (desc !== (task.description ?? '')) patch.description = desc;
      if (owner !== task.owner) patch.owner = owner;
      if (!sameSet(blockedBy, task.blockedBy)) patch.blockedBy = blockedBy;
      // Optimistic (SPEC §5): close now; useUpdateTask rolls back + toasts on failure.
      if (Object.keys(patch).length > 0) update.mutate({ taskId: task.taskId, patch });
      close();
      return;
    }
    create.mutate(
      { subject: trimmed, description: desc || undefined, owner, blockedBy },
      {
        onSuccess: () => {
          close();
          toast(notified ? `Task created · ${notified.name} notified` : 'Task created', 'success');
        },
      },
    );
  };

  // SPEC §14.6: You, Unassigned, then agents.
  const ownerRows: { key: string | null; name: string }[] = [
    { key: 'user', name: 'You' },
    { key: null, name: 'Unassigned' },
    ...agents.map((a) => ({ key: a.slotId, name: a.name })),
    // Keep a removed owner visible so the current selection is clear.
    ...(task?.owner && task.owner !== 'user' && !agents.some((a) => a.slotId === task.owner) ? [{ key: task.owner, name: 'Removed agent' }] : []),
  ];
  // The PC posts the "📋 Task assigned" notice itself, to live teammates only (contract §6.7).
  const ownerAgent = agents.find((a) => a.slotId === owner);
  const notified = ownerAgent && ownerAgent.role !== 'lead' && owner !== task?.owner ? ownerAgent : undefined;

  const inputStyle = [styles.input, typeScale.body, { backgroundColor: c.surfaceAlt, color: c.text }];

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={{ title, headerLeft: () => <CancelButton /> }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <View style={styles.fieldGroup}>
          <Text variant="caption" color="textMuted" style={styles.label}>
            Subject (required)
          </Text>
          <TextField
            value={subject}
            onChangeText={setSubject}
            placeholder="What needs to be done?"
            placeholderTextColor={c.textMuted}
            maxLength={SUBJECT_MAX}
            autoFocus={!task && !initialSubject}
            returnKeyType="next"
            submitBehavior="blurAndSubmit"
            accessibilityLabel="Subject, required"
            style={inputStyle}
          />
          {subject.length > SUBJECT_MAX - 40 ? (
            <Text variant="caption" color={subject.length >= SUBJECT_MAX ? 'danger' : 'textMuted'} style={styles.counter}>
              {subject.length}/{SUBJECT_MAX}
            </Text>
          ) : null}
        </View>

        <View style={styles.fieldGroup}>
          <Text variant="caption" color="textMuted" style={styles.label}>
            Description
          </Text>
          <TextField
            value={description}
            onChangeText={setDescription}
            placeholder="Details, acceptance criteria… (Markdown)"
            placeholderTextColor={c.textMuted}
            multiline
            textAlignVertical="top"
            accessibilityLabel="Description"
            style={[inputStyle, styles.multiline]}
          />
        </View>

        <View>
          <SectionHeader title="Owner" />
          <Card style={styles.list}>
            {ownerRows.map((row, i) => {
              const slot = agents.find((a) => a.slotId === row.key);
              const selected = owner === row.key;
              return (
                <View key={row.key ?? '__unassigned'}>
                  {i > 0 ? <Divider /> : null}
                  <Pressable
                    onPress={() => setOwner(row.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={slot ? `${row.name}, ${agentStatusKey(slot, runState?.sessionStatus)}` : row.name}
                    style={styles.option}
                  >
                    <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} color={selected ? 'primary' : 'textMuted'} size={22} />
                    {slot ? (
                      <Avatar id={slot.slotId} name={row.name} lead={slot.role === 'lead'} size={28} />
                    ) : (
                      <Icon name={row.key === 'user' ? 'person' : row.key ? 'remove-outline' : 'person-outline'} color={row.key === 'user' ? 'primary' : 'textMuted'} />
                    )}
                    <Text style={styles.flex} numberOfLines={1}>
                      {row.name}
                    </Text>
                    {slot ? <StatusPill status={agentStatusKey(slot, runState?.sessionStatus)} /> : null}
                  </Pressable>
                </View>
              );
            })}
          </Card>
          {notified ? (
            <Text variant="caption" color="textMuted" style={styles.checkbox}>
              {notified.name} will be notified.
            </Text>
          ) : null}
        </View>

        <View>
          <SectionHeader title={blockedBy.length ? `Blocked by (${blockedBy.length})` : 'Blocked by'} />
          {candidates.length > 0 ? (
            <View style={[styles.search, { backgroundColor: c.surfaceAlt }]}>
              <Icon name="search" color="textMuted" />
              <TextField
                value={search}
                onChangeText={setSearch}
                placeholder="Search tasks"
                placeholderTextColor={c.textMuted}
                accessibilityLabel="Search tasks"
                returnKeyType="search"
                autoCorrect={false}
                style={[typeScale.body, styles.searchInput, { color: c.text }]}
              />
            </View>
          ) : null}
          <Card style={styles.list}>
            {candidates.length === 0 ? (
              <Text color="textMuted" style={styles.emptyList}>
                No open tasks to depend on
              </Text>
            ) : filtered.length === 0 ? (
              <Text color="textMuted" style={styles.emptyList}>
                No tasks match “{search.trim()}”
              </Text>
            ) : (
              filtered.map((t, i) => {
                const checked = blockedBy.includes(t.taskId);
                return (
                  <View key={t.taskId}>
                    {i > 0 ? <Divider /> : null}
                    <Pressable
                      onPress={() => toggleBlocker(t.taskId)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      accessibilityLabel={`${t.subject}, ${TASK_STATUS[t.status].label}`}
                      style={styles.option}
                    >
                      <Icon name={checked ? 'checkbox' : 'square-outline'} color={checked ? 'primary' : 'textMuted'} size={22} />
                      <View style={styles.flex}>
                        <Text numberOfLines={2}>{t.subject}</Text>
                        <View style={styles.meta}>
                          <TaskStatusPill status={t.status} />
                          <Text variant="mono" color="textMuted">
                            {shortId(t.taskId)}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  </View>
                );
              })
            )}
          </Card>
        </View>
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: c.border, backgroundColor: c.surface, paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Button
          title={task ? 'Save' : 'Create'}
          onPress={submit}
          loading={pending}
          disabled={!canSubmit}
          style={offline && styles.dimmed}
          accessibilityState={{ disabled: !canSubmit || offline, busy: pending }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.gutter, gap: space.lg, paddingBottom: space.xxl },
  fieldGroup: { gap: space.xs },
  label: { fontWeight: '600' },
  input: { minHeight: touchTarget, borderRadius: radius.card, paddingHorizontal: space.md, paddingVertical: space.sm },
  multiline: { minHeight: 120, paddingTop: space.sm },
  counter: { alignSelf: 'flex-end' },
  list: { paddingVertical: 0, gap: 0 },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touchTarget + 4, paddingVertical: space.sm },
  checkbox: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touchTarget + 4, paddingTop: space.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    marginBottom: space.sm,
    minHeight: touchTarget,
  },
  searchInput: { flex: 1, minHeight: touchTarget },
  emptyList: { paddingVertical: space.md },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  footer: { paddingHorizontal: space.gutter, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  headerButton: { minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space.sm, marginRight: space.sm },
  dimmed: { opacity: 0.5 },
});
