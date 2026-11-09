import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { openThread } from '@/components/agentActions';
import { AttentionChip } from '@/components/AttentionChip';
import { Avatar } from '@/components/Avatar';
import { FreshnessIndicator, useHostLabel } from '@/components/Banners';
import { markdownToPlain } from '@/components/Markdown';
import { StatusPill } from '@/components/StatusPill';
import { TabChrome, TeamSwitcherTitle } from '@/components/TeamHeader';
import { usePullRefresh } from '@/components/usePullRefresh';
import { Button } from '@/components/ui/Button';
import { Card, Chip, Divider, EmptyState, Icon, IconButton, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { BROADCAST_CONVERSATION } from '@/lib/api/client';
import { useActiveTeam, useBroadcasts, useRunState, useSoloConversations } from '@/lib/api/hooks';
import type { Agent, Attention, LastMessage } from '@/lib/api/types';
import { agentStatusKey, formatClock, formatDay } from '@/lib/format';
import { radius, space, touchTarget, useColors } from '@/theme';

type Segment = 'team' | 'solo';

interface RowModel {
  /** Route id: a conversationId, or BROADCAST_CONVERSATION for the team's Everyone thread. */
  id: string;
  kind: 'team' | 'broadcast' | 'solo';
  title: string;
  agent?: Agent;
  last: Pick<LastMessage, 'role' | 'text' | 'createdAt'> | null;
  unread: number;
  attention: Attention;
  model?: string;
}

/** Waiting on the human (SPEC §6.6: float to top with ✋): a question or an approval. */
const needsReply = (attention: Attention) => attention === 'needs_answer' || attention === 'needs_approval';

function lastTime(ts: number | undefined): string {
  if (!ts) return '';
  return formatDay(ts) === 'Today' ? formatClock(ts) : formatDay(ts);
}

function openConversation(conversationId: string) {
  router.push({ pathname: '/chat/[conversationId]', params: { conversationId } });
}

/** C1 — Conversation list (SPEC §6.6). */
export default function ConversationList() {
  // Team members' chats come from the roster (contract §6.4: one id space); solo chats are listed.
  const runState = useRunState();
  const solo = useSoloConversations();
  const broadcasts = useBroadcasts().data;
  const { teamName } = useActiveTeam();
  const host = useHostLabel();
  const [segment, setSegment] = useState<Segment>('team');
  const [picking, setPicking] = useState(false);
  const source = segment === 'solo' ? solo : runState;
  const pull = usePullRefresh(source.refetch);

  const agents = runState.data?.agents;
  const rows = useMemo<RowModel[]>(() => {
    if (segment === 'solo') {
      return (solo.data ?? []).map((conv) => ({
        id: conv.conversationId,
        kind: 'solo' as const,
        title: conv.name,
        last: conv.lastMessage,
        unread: conv.unread,
        attention: conv.attention,
        model: conv.model,
      }));
    }
    const team = (agents ?? [])
      .map((agent) => ({
        id: agent.conversationId,
        kind: 'team' as const,
        title: agent.name,
        agent,
        last: agent.lastMessage,
        unread: agent.unread,
        attention: agent.attention,
      }))
      .sort((a, b) => Number(needsReply(b.attention)) - Number(needsReply(a.attention)) || (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0));
    const latest = broadcasts?.at(-1);
    const everyone: RowModel = {
      id: BROADCAST_CONVERSATION,
      kind: 'broadcast',
      title: 'Everyone (broadcast)',
      last: latest ? { role: 'user', text: latest.content, createdAt: latest.createdAt } : null,
      unread: 0,
      attention: 'none',
    };
    return [...team, everyone];
  }, [solo.data, agents, broadcasts, segment]);

  const teammates = useMemo(
    () => [...(agents ?? [])].sort((a, b) => (a.role === 'lead' ? -1 : b.role === 'lead' ? 1 : a.name.localeCompare(b.name))),
    [agents],
  );

  const onNew = useCallback(() => setPicking((p) => !p), []);

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => <TeamSwitcherTitle />,
        // No API to create solo conversations yet, so New only exists on the Team segment (SPEC §12.3).
        headerRight: segment === 'solo' ? () => null : () => (
          <Pressable onPress={onNew} accessibilityRole="button" accessibilityLabel="New conversation" hitSlop={8} style={styles.newButton}>
            <Icon name="create-outline" size={20} color="primary" />
            <Text color="primary" style={{ fontWeight: '600' }}>
              New
            </Text>
          </Pressable>
        ),
      }}
    />
  );

  const listHeader = (
    <View>
      <View style={styles.segments}>
        <Chip label="Team" selected={segment === 'team'} onPress={() => setSegment('team')} />
        <Chip
          label="Solo"
          selected={segment === 'solo'}
          onPress={() => {
            setSegment('solo');
            setPicking(false);
          }}
        />
        <View style={{ flex: 1 }} />
        {source.dataUpdatedAt ? <FreshnessIndicator updatedAt={source.dataUpdatedAt} onRefresh={() => void source.refetch()} /> : null}
      </View>

      {picking && segment === 'team' ? (
        <Card style={styles.picker}>
          <View style={styles.pickerHeader}>
            <Text variant="headline" style={{ flex: 1 }} accessibilityRole="header">
              Message a teammate
            </Text>
            <IconButton icon="close" label="Close picker" color="textMuted" onPress={() => setPicking(false)} />
          </View>
          {teammates.length === 0 ? (
            <Text color="textMuted">No teammates yet.</Text>
          ) : (
            teammates.map((s) => (
              <Pressable
                key={s.slotId}
                onPress={() => {
                  setPicking(false);
                  openThread(s.conversationId);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Message ${s.name}`}
                style={({ pressed }) => [styles.pickerRow, pressed && { opacity: 0.6 }]}
              >
                <Avatar id={s.slotId} name={s.name} lead={s.role === 'lead'} size={32} />
                <Text style={{ flex: 1 }}>{s.name}</Text>
                <StatusPill status={agentStatusKey(s, runState.data?.sessionStatus)} />
              </Pressable>
            ))
          )}
        </Card>
      ) : null}

      {segment === 'team' && rows.length > 0 ? (
        <View style={styles.sectionPad}>
          <SectionHeader title={teamName ?? 'Team'} />
        </View>
      ) : null}
    </View>
  );

  if (!source.data) {
    return (
      <View style={styles.flex}>
        {header}
        <TabChrome />
        {source.isError ? (
          <EmptyState title={`Can't load conversations from ${host}.`} action={<Button title="Retry" onPress={() => void source.refetch()} />} />
        ) : (
          <SkeletonList />
        )}
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {header}
      <TabChrome />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <ConversationRow row={item} solo={segment === 'solo'} />}
        ItemSeparatorComponent={RowDivider}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          segment === 'team' ? (
            <EmptyState title="No conversations yet" action={<Button title="Message a teammate" onPress={() => setPicking(true)} />} />
          ) : (
            <EmptyState title="No solo conversations" />
          )
        }
        refreshControl={<RefreshControl {...pull} />}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

function RowDivider() {
  return (
    <View style={{ paddingLeft: space.gutter + 40 + space.md }}>
      <Divider />
    </View>
  );
}

function ConversationRow({ row, solo }: { row: RowModel; solo: boolean }) {
  const c = useColors();
  const { title, agent, last } = row;
  const waiting = needsReply(row.attention);
  const isBroadcast = row.kind === 'broadcast';
  const preview = last
    ? `${last.role === 'user' ? 'You: ' : ''}${markdownToPlain(last.text).replace(/\s+/g, ' ')}`
    : solo
      ? 'No messages yet'
      : 'No messages yet — say hi';
  const time = lastTime(last?.createdAt);
  const unread = row.unread > 0;
  const isToolPreview = !!last && last.role !== 'user' && /^Used /.test(last.text);

  const a11y = [
    title,
    waiting ? 'needs your reply' : null,
    unread ? `${row.unread} unread` : null,
    solo && row.model ? `model ${row.model}` : null,
    last ? `last message ${time}: ${preview}` : 'no messages',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      onPress={() => openConversation(row.id)}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surfaceAlt : c.bg }]}
    >
      {isBroadcast ? (
        <View style={[styles.broadcastAvatar, { backgroundColor: c.surfaceAlt }]}>
          <Text style={{ fontSize: 18 }}>👥</Text>
        </View>
      ) : (
        <Avatar id={agent?.slotId ?? row.id} name={title} lead={agent?.role === 'lead'} size={40} />
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text variant="headline" style={styles.rowTitle}>
            {title}
          </Text>
          {time ? (
            <Text variant="caption" color={unread ? 'primary' : 'textMuted'}>
              {time}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowTop}>
          {/* Tool rows read "Used <tool>" and stay muted (SPEC §14.3.3). */}
          <Text color={(waiting || unread) && !isToolPreview ? 'text' : 'textMuted'} numberOfLines={1} style={styles.preview}>
            {preview}
          </Text>
          {/* An attention marker replaces the unread dot for that row (SPEC §14.1.3). */}
          {row.attention !== 'none' ? (
            <AttentionChip attention={row.attention} />
          ) : unread ? (
            <View style={[styles.unreadDot, { backgroundColor: c.primary }]} />
          ) : null}
        </View>
        {solo && row.model ? (
          <Text variant="caption" color="textMuted">
            {row.model}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  listContent: { paddingBottom: space.xl, flexGrow: 1 },
  newButton: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: touchTarget, paddingHorizontal: space.xs },
  segments: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.gutter, paddingTop: space.md },
  sectionPad: { paddingHorizontal: space.gutter },
  picker: { marginHorizontal: space.gutter, marginTop: space.md, gap: 0 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touchTarget + 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md, minHeight: 64 },
  broadcastAvatar: { width: 40, height: 40, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { flex: 1, flexWrap: 'wrap' },
  preview: { flex: 1 },
  unreadDot: { width: 10, height: 10, borderRadius: 5 },
});
