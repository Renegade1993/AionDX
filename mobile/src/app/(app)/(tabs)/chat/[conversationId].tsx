import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { Avatar } from '@/components/Avatar';
import { ApprovalBanner, ConnectionBanner, FreshnessIndicator } from '@/components/Banners';
import { Composer } from '@/components/Composer';
import { markdownToPlain } from '@/components/Markdown';
import { isSystemMessage, isTaskNotice, MessageBubble, noticeTaskId } from '@/components/MessageBubble';
import { pickOption } from '@/components/OptionSheet';
import {
  AppCaption,
  broadcastSummary,
  ContextDivider,
  FailedSendRow,
  NewDivider,
  PlanRow,
  TaskNoticeCard,
  ThinkingRow,
  ToolRow,
  ToolRunRow,
} from '@/components/ThreadRows';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, Icon, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { BROADCAST_CONVERSATION } from '@/lib/api/client';
import {
  newLocalMessageId,
  type ThreadMessage,
  useAllApprovals,
  useBroadcasts,
  useCanWriteTasks,
  useConversation,
  useLoadOlder,
  useMarkRead,
  useRunState,
  useSendBroadcast,
  useSendMessage,
  useTasks,
  useThread,
} from '@/lib/api/hooks';
import type { Agent, Broadcast } from '@/lib/api/types';
import { agentStatusKey, approvalCommand, approvalTitle, formatClock, formatDay, isSessionDown, messageText, retryTargetFor, type StatusKey } from '@/lib/format';
import { useIsOffline } from '@/state/healthStore';
import { toast } from '@/state/toastStore';
import { radius, space, useColors, useReduceMotion } from '@/theme';

/** Drafts survive leaving and re-opening a thread for the lifetime of the app process (SPEC §4.9). */
const drafts = new Map<string, string>();

const GROUP_WINDOW_MS = 2 * 60_000;
const BOTTOM_THRESHOLD = 80;
/** Pill height (36) + its 12pt offset + breathing room, so the newest bubble can scroll clear of it. */
const NEW_PILL_CLEARANCE = 36 + space.md + space.sm;
const OFFLINE_TOAST = "Offline — can't send";

type RowKind = 'tool' | 'thinking' | 'plan' | 'context' | 'caption' | 'failed' | 'task';

type Item =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'new'; key: string }
  | { kind: 'msg'; key: string; message: ThreadMessage; groupStart: boolean }
  | { kind: 'row'; key: string; message: ThreadMessage; row: RowKind }
  | { kind: 'tools'; key: string; messages: ThreadMessage[] };

/** How a row renders (SPEC §14.3.1); null = a chat bubble or a centered system card. */
function rowKind(m: ThreadMessage): RowKind | null {
  if (m.type === 'tool_call') return 'tool';
  if (m.type === 'thinking') return 'thinking';
  if (m.type === 'plan') return 'plan';
  if (m.notice?.kind === 'context_reset') return 'context';
  if (m.status === 'error' && m.error?.source === 'send_failed') return 'failed';
  if (isTaskNotice(m)) return 'task';
  if (m.sender.kind === 'app' || m.type === 'agent_status' || (m.type === 'tips' && m.status !== 'error' && m.role === 'system')) return 'caption';
  return null;
}

/** Tool, thinking and plan rows don't break an agent's message group (SPEC §14.3.1). */
const isCompact = (k: RowKind | null) => k === 'tool' || k === 'thinking' || k === 'plan';
/** Four or more tool rows in a row collapse into one (SPEC §14.3.3). */
const TOOL_RUN_MIN = 4;

/** Who sent a row, for grouping: same key within the window → one group. */
function senderKey(m: ThreadMessage): string {
  const s = m.sender;
  return s.kind === 'agent' || s.kind === 'teammate' ? `${s.kind}:${s.name}` : s.kind;
}

/** Your own broadcasts as rows of the Everyone thread (SPEC §14.3.4). */
function broadcastRow(b: Broadcast): ThreadMessage {
  return {
    messageId: b.broadcastId,
    conversationId: BROADCAST_CONVERSATION,
    role: 'user',
    sender: { kind: 'user' },
    type: 'text',
    status: 'done',
    text: b.content,
    createdAt: b.createdAt,
  };
}

function buildItems(messages: ThreadMessage[], newFromId: string | null): Item[] {
  const out: Item[] = [];
  let prev: ThreadMessage | undefined;
  let prevDay = '';
  let tools: ThreadMessage[] = [];
  const flushTools = () => {
    if (tools.length >= TOOL_RUN_MIN) out.push({ kind: 'tools', key: `run-${tools[0].messageId}`, messages: tools });
    else for (const t of tools) out.push({ kind: 'row', key: t.messageId, message: t, row: 'tool' });
    tools = [];
  };
  for (const m of messages) {
    const day = formatDay(m.createdAt);
    if (day !== prevDay) {
      flushTools();
      out.push({ kind: 'day', key: `day-${day}`, label: day });
      prevDay = day;
      prev = undefined;
    }
    if (m.messageId === newFromId) {
      flushTools();
      out.push({ kind: 'new', key: 'new-divider' });
      prev = undefined;
    }
    const row = rowKind(m);
    if (row === 'tool') {
      tools.push(m);
      continue;
    }
    flushTools();
    if (row) {
      out.push({ kind: 'row', key: m.messageId, message: m, row });
      // Compact rows sit inside an agent's group; everything else (dividers, cards) resets it.
      if (!isCompact(row)) prev = undefined;
      continue;
    }
    const groupStart =
      !prev ||
      isSystemMessage(m) ||
      isSystemMessage(prev) ||
      // A teammate row always starts a new group: its "from → to" header is always shown (SPEC §14.3.1).
      m.role === 'teammate' ||
      senderKey(prev) !== senderKey(m) ||
      m.createdAt - prev.createdAt > GROUP_WINDOW_MS;
    out.push({ kind: 'msg', key: m.messageId, message: m, groupStart });
    prev = m;
  }
  flushTools();
  return out;
}

/** Notice text after "(#id): ", for the task card when the task isn't cached. */
function noticeSubject(text: string | undefined): string {
  const m = /\):\s*([\s\S]*)$/.exec(text ?? '');
  return (m?.[1] ?? text ?? '').split('\n')[0].trim();
}

function firstLine(content: string): string {
  const line = markdownToPlain(content)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return (line ?? '').slice(0, 200);
}

function copyToClipboard(text: string, done: string) {
  Clipboard.setStringAsync(text).then(
    () => toast(done, 'success'),
    () => toast("Couldn't copy", 'error'),
  );
}

/**
 * Long-press bubble: Copy, Create task from message, Copy message ID (SPEC §6.7).
 * "Create task" only when the PC allows task writes (`tasks.write`, contract §6.7).
 */
function showMessageActions(m: ThreadMessage, canWriteTasks: boolean) {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  const content = messageText(m);
  const items = [
    { label: 'Copy', run: () => copyToClipboard(content, 'Copied') },
    ...(canWriteTasks
      ? [
          {
            label: 'Create task from message',
            run: () => router.push({ pathname: '/task-edit', params: { subject: firstLine(content), description: content } }),
          },
        ]
      : []),
    { label: 'Copy message ID', run: () => copyToClipboard(m.messageId, 'Message ID copied') },
  ];
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...items.map((i) => i.label), 'Cancel'], cancelButtonIndex: items.length },
      (index) => items[index]?.run(),
    );
  } else {
    // Android alerts allow at most three buttons; dismiss by tapping outside / back.
    Alert.alert('Message', undefined, items.map((i) => ({ text: i.label, onPress: i.run })), { cancelable: true });
  }
}

/** C2 — Thread (SPEC §6.7). */
export default function ThreadScreen() {
  const params = useLocalSearchParams<{ conversationId: string }>();
  const conversationId = typeof params.conversationId === 'string' ? params.conversationId : '';
  const isBroadcast = conversationId === BROADCAST_CONVERSATION;

  const c = useColors();
  const headerHeight = useHeaderHeight();
  const focused = useIsFocused();
  // One id space (contract §6.4): a team member's chat is its roster conversationId.
  const runState = useRunState();
  const agents = runState.data?.agents;
  const agent: Agent | undefined = isBroadcast ? undefined : agents?.find((a) => a.conversationId === conversationId);
  const conversation = useConversation(isBroadcast || agent ? undefined : conversationId);
  const thread = useThread(isBroadcast ? undefined : conversationId);
  const broadcasts = useBroadcasts();
  const approvals = useAllApprovals().data;
  const offline = useIsOffline();
  const { mutate: sendMutate } = useSendMessage(conversationId);
  const { mutate: broadcastMutate } = useSendBroadcast();
  const markRead = useMarkRead(isBroadcast ? undefined : conversationId);

  const name = isBroadcast ? 'Everyone' : (agent?.name ?? conversation.data?.name ?? 'Conversation');
  const status: StatusKey | undefined = agent ? agentStatusKey(agent, runState.data?.sessionStatus) : undefined;
  // A team member's chat whose agent left the roster, or a conversation the PC no longer has.
  const agentRemoved = !isBroadcast && !agent && (conversation.data?.kind === 'team_member' || conversation.isError);
  const isLeadDm = agent?.role === 'lead';
  const pending = approvals?.find((a) => a.conversationId === conversationId);
  const leadSlotId = agents?.find((a) => a.role === 'lead')?.slotId;

  const senderInfo = useCallback(
    (m: ThreadMessage): { name: string; lead: boolean } => {
      const s = m.sender;
      if (s.kind === 'user') return { name: 'You', lead: false };
      if (s.kind === 'agent') return { name: s.name || name, lead: agent?.role === 'lead' };
      if (s.kind === 'teammate') return { name: s.name, lead: !!s.slotId && s.slotId === leadSlotId };
      return { name: 'AionDX', lead: false };
    },
    [agent?.role, leadSlotId, name],
  );

  // ---- Draft (per conversation, in memory) ----
  const [draft, setDraftState] = useState(() => drafts.get(conversationId) ?? '');
  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      if (text) drafts.set(conversationId, text);
      else drafts.delete(conversationId);
    },
    [conversationId],
  );

  // ---- Scroll / "↓ N new" ----
  const listRef = useRef<FlatList<Item>>(null);
  const atBottom = useRef(true);
  // Set while we scroll programmatically, so those scroll events don't count as the user leaving the bottom.
  const programmaticUntil = useRef(0);
  const didInitialScroll = useRef(false);
  const [newCount, setNewCount] = useState(0);
  const newCountRef = useRef(0);
  const seenIds = useRef<Set<string> | null>(null);
  const lastStreaming = useRef<string | null>(null);
  const [newReply, setNewReply] = useState(false);

  // `other` rows are hidden (SPEC §14.3.1).
  const messages = useMemo(
    () => (isBroadcast ? (broadcasts.data ?? []).map(broadcastRow) : (thread.data?.items ?? []).filter((m) => m.type !== 'other')),
    [isBroadcast, broadcasts.data, thread.data],
  );
  const loaded = isBroadcast ? broadcasts.data : thread.data;
  const queuedIds = useMemo(() => new Set(agent?.queue.foregroundMessageIds ?? []), [agent?.queue.foregroundMessageIds]);
  const loadOlder = useLoadOlder(conversationId);

  // "──── New ────" above the first unread agent row, fixed when the thread opens (SPEC §14.3.1).
  const [unreadAtOpen, setUnreadAtOpen] = useState<number | null>(null);
  if (unreadAtOpen === null && loaded) setUnreadAtOpen(agent?.unread ?? conversation.data?.unread ?? 0);
  const newFromId = useMemo(() => {
    const n = unreadAtOpen ?? 0;
    if (n <= 0) return null;
    const unreadRows = messages.filter((m) => m.role === 'agent' && m.type === 'text' && m.status === 'done');
    return unreadRows[Math.max(0, unreadRows.length - n)]?.messageId ?? null;
  }, [messages, unreadAtOpen]);

  // Retry for failed sends (SPEC §14.3.2): each send_failed row → the message it re-sends, and back.
  const [retried, setRetried] = useState<Set<string>>(() => new Set());
  const retryTargets = useMemo(() => {
    const byFailedRow = new Map<string, ThreadMessage>();
    const byTarget = new Map<string, string>();
    for (const m of messages) {
      const target = retryTargetFor(m, messages);
      if (target) {
        byFailedRow.set(m.messageId, target);
        byTarget.set(target.messageId, m.messageId);
      }
    }
    return { byFailedRow, byTarget };
  }, [messages]);

  // Read marker (contract §6.4): moved to the newest server row while the thread is on screen.
  const newestServerId = useMemo(() => [...messages].reverse().find((m) => !m.localState)?.messageId, [messages]);
  const markedRef = useRef<string | undefined>(undefined);
  const { mutate: markReadMutate } = markRead;
  useEffect(() => {
    if (isBroadcast || !focused || !newestServerId || markedRef.current === newestServerId) return;
    markedRef.current = newestServerId;
    markReadMutate(newestServerId);
  }, [isBroadcast, focused, newestServerId, markReadMutate]);
  const items = useMemo(() => buildItems(messages, newFromId), [messages, newFromId]);

  useEffect(() => {
    const ids = new Set(messages.map((m) => m.messageId));
    const seen = seenIds.current;
    if (seen && !atBottom.current) {
      const added = messages.filter((m) => !seen.has(m.messageId) && m.role !== 'user').length;
      if (added > 0) {
        newCountRef.current += added;
        setNewCount(newCountRef.current);
      }
    }
    if (messages.length || loaded) seenIds.current = ids;
    // A streaming reply growing while the user is scrolled up: "↓ New reply" (SPEC §14.3.2).
    const streaming = messages.find((m) => m.status === 'streaming');
    const length = streaming ? `${streaming.messageId}:${streaming.text?.length ?? 0}` : null;
    if (length && lastStreaming.current && length !== lastStreaming.current && !atBottom.current) setNewReply(true);
    lastStreaming.current = length;
  }, [messages, loaded]);

  const scrollToEnd = useCallback((animated: boolean) => {
    programmaticUntil.current = Date.now() + 500;
    listRef.current?.scrollToEnd({ animated });
    // The new row may not be laid out yet (notably on web); settle once more next frame.
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);

  const jumpToBottom = useCallback(() => {
    atBottom.current = true;
    newCountRef.current = 0;
    setNewCount(0);
    setNewReply(false);
    scrollToEnd(true);
  }, [scrollToEnd]);

  const updateAtBottom = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const bottom = contentSize.height - (contentOffset.y + layoutMeasurement.height) < BOTTOM_THRESHOLD;
    atBottom.current = bottom;
    if (bottom) setNewReply(false);
    if (bottom && newCountRef.current) {
      newCountRef.current = 0;
      setNewCount(0);
    }
  }, []);

  // Any scroll that isn't our own scrollToEnd is the user's: drag on native, wheel/touchpad on web
  // (react-native-web emits no drag events), so programmatic scrolls are tracked instead.
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (Date.now() > programmaticUntil.current) updateAtBottom(e);
    },
    [updateAtBottom],
  );
  const onDragBegin = useCallback(() => {
    programmaticUntil.current = 0;
  }, []);
  const onScrollSettled = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => updateAtBottom(e),
    [updateAtBottom],
  );
  const onMomentumBegin = onDragBegin;

  const onContentSizeChange = useCallback(() => {
    if (atBottom.current) scrollToEnd(didInitialScroll.current);
    didInitialScroll.current = true;
  }, [scrollToEnd]);

  const onListLayout = useCallback(() => {
    // Keyboard / sticky card resize the list: keep the newest message visible.
    if (atBottom.current) scrollToEnd(false);
  }, [scrollToEnd]);

  // ---- Sending ----
  // Replies arrive through the change feed (contract §6.2); there's no faster poll to switch on.
  const broadcast = useCallback(
    (text: string) => {
      if (offline) {
        toast(OFFLINE_TOAST);
        return;
      }
      broadcastMutate({ content: text, localId: newLocalMessageId() }, { onSuccess: () => toast('Sent to all teammates', 'success') });
      setDraft('');
      atBottom.current = true;
    },
    [offline, broadcastMutate, setDraft],
  );

  const send = useCallback(
    (text: string) => {
      if (offline) {
        toast(OFFLINE_TOAST);
        return;
      }
      if (isBroadcast) return broadcast(text);
      sendMutate({ content: text, localId: newLocalMessageId() });
      setDraft('');
      atBottom.current = true;
    },
    [offline, isBroadcast, broadcast, sendMutate, setDraft],
  );

  // Retry from a send_failed row (or the failed bubble's mark): a NEW send with a new rid (rev 3.1).
  const retryFailed = useCallback(
    (failedRowId: string) => {
      const target = retryTargets.byFailedRow.get(failedRowId);
      if (!target) return;
      if (offline) {
        toast(OFFLINE_TOAST);
        return;
      }
      const text = messageText(target);
      toast(`Retrying: '${firstLine(text).slice(0, 60)}'`);
      sendMutate({ content: text, localId: newLocalMessageId() });
      setRetried((s) => new Set([...s, failedRowId, target.messageId]));
      atBottom.current = true;
    },
    [retryTargets, offline, sendMutate],
  );

  const showDeliveries = useCallback(
    (broadcastId: string) => {
      const b = broadcasts.data?.find((x) => x.broadcastId === broadcastId);
      if (!b) return;
      const label = { started: 'Delivered', midturn: 'Delivered', queued: 'Queued', queued_first: 'Queued', failed: 'Failed' } as const;
      void pickOption(
        'Delivery',
        b.deliveries.map((d) => {
          const a = agents?.find((x) => x.slotId === d.slotId);
          const name = a?.name ?? 'Removed agent';
          return {
            key: d.slotId,
            label: d.delivery === 'failed' && a ? `${name} · Failed — Send to ${name}` : `${name} · ${label[d.delivery]}`,
            description: d.error,
            destructive: d.delivery === 'failed',
          };
        }),
      ).then((slotId) => {
        const d = b.deliveries.find((x) => x.slotId === slotId);
        const a = agents?.find((x) => x.slotId === slotId);
        // A failed row's "Send to <name>" opens that agent's thread with the text prefilled.
        if (d?.delivery === 'failed' && a) {
          drafts.set(a.conversationId, b.content);
          router.push({ pathname: '/chat/[conversationId]', params: { conversationId: a.conversationId } });
        }
      });
    },
    [broadcasts.data, agents],
  );

  // "Tap to retry" after the POST itself failed: same local id, so the same rid (A4).
  const retry = useCallback(
    (m: ThreadMessage) => {
      if (offline) {
        toast(OFFLINE_TOAST);
        return;
      }
      sendMutate({ content: messageText(m), localId: m.messageId });
    },
    [offline, sendMutate],
  );

  // Assignment notices open the task itself when it's in the cached list, else the Tasks tab (SPEC §12.4).
  const cachedTasks = useTasks().data;
  const canWriteTasks = useCanWriteTasks();
  const onLongPress = useCallback((m: ThreadMessage) => showMessageActions(m, canWriteTasks), [canWriteTasks]);
  const onSystemPress = useCallback(
    (m: ThreadMessage) => {
      if (!isTaskNotice(m)) return;
      const taskId = noticeTaskId(m);
      if (taskId && cachedTasks?.some((t) => t.taskId === taskId)) router.push({ pathname: '/tasks/[taskId]', params: { taskId } });
      else router.push('/tasks');
    },
    [cachedTasks],
  );

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      if (item.kind === 'day') return <DaySeparator label={item.label} />;
      if (item.kind === 'new') return <NewDivider />;
      if (item.kind === 'tools') return <ToolRunRow messages={item.messages} />;
      if (item.kind === 'row') {
        const m = item.message;
        switch (item.row) {
          case 'tool':
            return <ToolRow message={m} />;
          case 'thinking':
            return <ThinkingRow message={m} />;
          case 'plan':
            return <PlanRow message={m} />;
          case 'context':
            return <ContextDivider message={m} />;
          case 'caption':
            return <AppCaption message={m} />;
          case 'failed':
            return (
              <FailedSendRow
                message={m}
                retried={retried.has(m.messageId)}
                onRetry={retryTargets.byFailedRow.has(m.messageId) ? () => retryFailed(m.messageId) : undefined}
              />
            );
          case 'task': {
            const taskId = noticeTaskId(m);
            const task = taskId ? cachedTasks?.find((t) => t.taskId === taskId) : undefined;
            const assigner = m.role === 'user' ? 'You' : m.sender.kind === 'teammate' || m.sender.kind === 'agent' ? m.sender.name : 'AionDX';
            return (
              <TaskNoticeCard
                assigner={assigner}
                subject={task?.subject ?? noticeSubject(m.text)}
                time={formatClock(m.createdAt)}
                onPress={() => onSystemPress(m)}
              />
            );
          }
        }
      }
      const sender = senderInfo(item.message);
      const m = item.message;
      const failedRow = retryTargets.byTarget.get(m.messageId);
      const b = isBroadcast ? broadcasts.data?.find((x) => x.broadcastId === m.messageId) : undefined;
      return (
        <MessageBubble
          message={m}
          senderName={sender.name}
          senderLead={sender.lead}
          groupStart={item.groupStart}
          queued={queuedIds.has(m.messageId)}
          avatarId={m.sender.kind === 'teammate' ? (m.sender.slotId ?? m.sender.name) : (agent?.slotId ?? conversationId)}
          teammateHeader={
            m.sender.kind === 'teammate'
              ? {
                  from: m.sender.name,
                  to: name,
                  onPressFrom: m.sender.slotId ? () => router.push({ pathname: '/agent/[slot]', params: { slot: (m.sender as { slotId: string }).slotId } }) : undefined,
                }
              : undefined
          }
          failedDelivery={
            m.role === 'user' && m.status === 'error'
              ? { retry: failedRow ? () => retryFailed(failedRow) : undefined, retried: retried.has(m.messageId) }
              : undefined
          }
          broadcastMeta={b ? { ...broadcastSummary(b), onPress: () => showDeliveries(b.broadcastId) } : undefined}
          onRetry={retry}
          onLongPress={onLongPress}
          onSystemPress={onSystemPress}
        />
      );
    },
    [senderInfo, retry, onSystemPress, onLongPress, queuedIds, retried, retryTargets, retryFailed, cachedTasks, isBroadcast, broadcasts.data, showDeliveries, name, agent?.slotId, conversationId],
  );

  const openAgent = agent ? () => router.push({ pathname: '/agent/[slot]', params: { slot: agent.slotId } }) : undefined;
  const source = isBroadcast ? broadcasts : thread;

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <ThreadTitle
            name={name}
            avatarId={agent?.slotId ?? conversationId}
            broadcast={isBroadcast}
            lead={agent?.role === 'lead'}
            status={status}
            updatedAt={source.dataUpdatedAt}
            onRefresh={() => void source.refetch()}
            onPress={openAgent}
          />
        ),
      }}
    />
  );

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {header}
      <ConnectionBanner />
      {/* This agent's own prompt is the card above the composer; still surface everyone else's (SPEC §12.5). */}
      <ApprovalBanner excludeConversationId={isBroadcast ? undefined : conversationId} />

      <View style={[styles.flex, offline && styles.dimmed]}>
        {!loaded ? (
          source.isError ? (
            <EmptyState title="Can't load messages." action={<Button title="Retry" onPress={() => void source.refetch()} />} />
          ) : (
            <SkeletonList />
          )
        ) : (
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(i) => i.key}
            renderItem={renderItem}
            contentContainerStyle={[styles.listContent, newCount > 0 && { paddingBottom: NEW_PILL_CLEARANCE }]}
            onScroll={onScroll}
            onScrollBeginDrag={onDragBegin}
            onScrollEndDrag={onScrollSettled}
            onMomentumScrollBegin={onMomentumBegin}
            onMomentumScrollEnd={onScrollSettled}
            scrollEventThrottle={100}
            onContentSizeChange={onContentSizeChange}
            onLayout={onListLayout}
            initialNumToRender={30}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            ListEmptyComponent={<EmptyState title={`No messages yet. Say hi to ${name}.`} />}
            ListHeaderComponent={
              !isBroadcast && thread.data?.before ? (
                <View style={styles.older}>
                  <Button title="Load earlier messages" variant="ghost" compact loading={loadOlder.isPending} onPress={() => loadOlder.mutate()} />
                </View>
              ) : undefined
            }
            ListFooterComponent={agent?.state === 'running' && !messages.some((m) => m.status === 'streaming') ? <TypingRow name={name} /> : undefined}
          />
        )}

        {newCount > 0 || newReply ? (
          <View style={styles.newPillRow} pointerEvents="box-none">
            <Pressable
              onPress={jumpToBottom}
              accessibilityRole="button"
              accessibilityLabel={newCount > 0 ? `${newCount} new message${newCount === 1 ? '' : 's'}. Scroll to bottom` : 'New reply. Scroll to bottom'}
              style={[styles.newPill, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <Icon name="arrow-down" size={14} color="primary" />
              <Text variant="caption" color="primary" style={{ fontWeight: '700' }}>
                {newCount > 0 ? `${newCount} new` : 'New reply'}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {pending ? (
        <Card accentColor={c.stNeedsYou} style={styles.approvalCard}>
          <Icon name="hand-left" color="stNeedsYou" />
          <View style={styles.flex}>
            <Text variant="headline" numberOfLines={2}>
              {pending.kind === 'question' ? `Has a question: "${pending.questions?.[0]?.question ?? ''}"` : `Wants to run ${approvalTitle(pending)}`}
            </Text>
            {pending.kind === 'permission' && approvalCommand(pending) ? (
              <Text variant="mono" color="textMuted" numberOfLines={1}>
                {approvalCommand(pending)}
              </Text>
            ) : null}
          </View>
          <Button
            title={pending.kind === 'question' ? 'Answer' : 'Review'}
            compact
            onPress={() => router.push({ pathname: '/approval/[approvalId]', params: { approvalId: pending.approvalId } })}
          />
        </Card>
      ) : null}

      {agentRemoved ? (
        <Card style={styles.removedCard}>
          <Text color="textMuted" style={styles.flex}>
            This agent was removed.
          </Text>
          <Button title="Back" variant="secondary" compact onPress={() => router.back()} />
        </Card>
      ) : (
        <Composer
          value={draft}
          onChangeText={setDraft}
          onSend={send}
          name={name}
          offline={offline}
          onBroadcast={isLeadDm ? broadcast : undefined}
          // Sending starts a stopped team, so the composer stays enabled with a hint (SPEC §14.1.4).
          hint={agent && isSessionDown(runState.data?.sessionStatus) ? 'Sending will start the team' : undefined}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function ThreadTitle({
  name,
  avatarId,
  broadcast,
  lead,
  status,
  updatedAt,
  onRefresh,
  onPress,
}: {
  name: string;
  avatarId: string;
  broadcast: boolean;
  lead?: boolean;
  status?: StatusKey;
  updatedAt: number;
  onRefresh: () => void;
  onPress?: () => void;
}) {
  const c = useColors();
  return (
    <View style={styles.titleRow}>
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : 'header'}
        accessibilityLabel={onPress ? `${name}. Agent details` : name}
        hitSlop={4}
        style={styles.titleMain}
      >
        {broadcast ? (
          <View style={[styles.broadcastAvatar, { backgroundColor: c.surfaceAlt }]}>
            <Text>👥</Text>
          </View>
        ) : (
          <Avatar id={avatarId} name={name} lead={lead} size={28} />
        )}
        <Text variant="headline" numberOfLines={1} style={styles.titleName}>
          {name}
        </Text>
        {status ? <StatusPill status={status} /> : null}
      </Pressable>
      <FreshnessIndicator updatedAt={updatedAt} onRefresh={onRefresh} />
    </View>
  );
}

function DaySeparator({ label }: { label: string }) {
  const c = useColors();
  return (
    <View style={styles.day} accessibilityRole="header">
      <View style={[styles.dayLine, { backgroundColor: c.border }]} />
      <Text variant="caption" color="textMuted">
        {label}
      </Text>
      <View style={[styles.dayLine, { backgroundColor: c.border }]} />
    </View>
  );
}

function TypingRow({ name }: { name: string }) {
  return (
    <View style={styles.typing} accessible accessibilityLabel={`${name} is working`}>
      <Text variant="caption" color="textMuted">
        {name} is working…
      </Text>
      <TypingDots />
    </View>
  );
}

function TypingDots() {
  const c = useColors();
  const reduce = useReduceMotion();
  const [anims] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.3)));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.stagger(
        180,
        anims.map((a) =>
          Animated.sequence([
            Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }),
            Animated.timing(a, { toValue: 0.3, duration: 300, useNativeDriver: true }),
          ]),
        ),
      ),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, anims]);
  return (
    <View style={styles.dots}>
      {anims.map((a, i) => (
        <Animated.View key={i} style={[styles.dot, { backgroundColor: c.stWorking, opacity: reduce ? 0.8 : a }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dimmed: { opacity: 0.6 },
  listContent: { paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, flexGrow: 1 },
  titleRow: { alignItems: 'flex-start', maxWidth: 280 },
  titleMain: { flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 280 },
  titleName: { flexShrink: 1 },
  broadcastAvatar: { width: 28, height: 28, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
  day: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg, marginBottom: space.xs, paddingHorizontal: space.xl },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth },
  typing: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md, marginLeft: 32 + space.sm },
  dots: { flexDirection: 'row', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  newPillRow: { position: 'absolute', left: 0, right: 0, bottom: space.md, alignItems: 'center' },
  newPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    minHeight: 36,
    borderRadius: radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  older: { alignItems: 'center', paddingVertical: space.sm },
  approvalCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.sm, marginBottom: space.sm },
  removedCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, margin: space.sm },
});
