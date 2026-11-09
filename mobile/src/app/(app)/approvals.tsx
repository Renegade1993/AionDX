import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { AttentionChip } from '@/components/AttentionChip';
import { Avatar } from '@/components/Avatar';
import { useSensitive } from '@/components/confirm';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, IconButton, SectionHeader, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { isApiError } from '@/lib/api/errors';
import { useAllApprovals, useAnswerApproval } from '@/lib/api/hooks';
import type { Approval, ApprovalOption } from '@/lib/api/types';
import { approvalCommand, approvalTitle, formatAgo, quickOptions } from '@/lib/format';
import { useIsOffline } from '@/state/healthStore';
import { space } from '@/theme';

const openSheet = (approvalId: string) => router.push({ pathname: '/approval/[approvalId]', params: { approvalId } });

/**
 * A1 — Approvals inbox, oldest first (SPEC §6.5). Every pending approval on the PC, solo chats
 * included. Inline Deny / Allow once only when that's unambiguous (SPEC §14.4); else Review.
 */
export default function ApprovalsInbox() {
  const approvals = useAllApprovals();
  const answer = useAnswerApproval();
  const offline = useIsOffline();
  const sensitive = useSensitive();
  // Resolved cards linger 1 s with their outcome before leaving the list.
  const [resolved, setResolved] = useState<Record<string, 'Allowed ✓' | 'Denied'>>({});
  const [lingering, setLingering] = useState<Approval[]>([]);

  const act = async (a: Approval, option: ApprovalOption) => {
    const allow = option.kind.startsWith('allow_');
    try {
      await answer.mutateAsync({ approval: a, answer: { optionId: option.optionId } });
    } catch (err) {
      // The options changed under us: the sheet shows the full list.
      if (isApiError(err, 'ambiguous_decision')) openSheet(a.approvalId);
      return;
    }
    setLingering((l) => [...l, a]);
    setResolved((r) => ({ ...r, [a.approvalId]: allow ? 'Allowed ✓' : 'Denied' }));
    setTimeout(() => setLingering((l) => l.filter((x) => x.approvalId !== a.approvalId)), 1000);
  };

  const live = approvals.data ?? [];
  const all = [...live, ...lingering.filter((l) => !live.some((a) => a.approvalId === l.approvalId))].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  // Solo-chat approvals (no teamId) are their own group, under the team ones (SPEC §14.4).
  const items: (Approval | { header: string })[] = [
    ...all.filter((a) => a.teamId),
    ...(all.some((a) => !a.teamId) ? [{ header: 'Solo chats' }, ...all.filter((a) => !a.teamId)] : []),
  ];

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: `Approvals${live.length ? ` (${live.length})` : ''}`,
          headerRight: () => <IconButton icon="close" label="Close" onPress={() => router.back()} />,
        }}
      />
      {approvals.isPending ? (
        <SkeletonList />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(a) => ('header' in a ? a.header : a.approvalId)}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<EmptyState title="Nothing needs your approval" action={<Button title="Close" variant="secondary" onPress={() => router.back()} />} />}
          renderItem={({ item }) => {
            if ('header' in item) return <SectionHeader title={item.header} />;
            const a = item;
            const outcome = resolved[a.approvalId];
            // Inline Allow only when this phone can confirm it: a disabled button never sits next to Deny (§15.1.5).
            const quick = sensitive.available ? quickOptions(a) : null;
            const what =
              a.kind === 'question'
                ? (a.questions?.[0]?.question ?? 'Has a question')
                : (approvalCommand(a) ?? a.questions?.[0]?.question ?? 'Open on PC to see the full command');
            return (
              <Card>
                <Pressable
                  onPress={() => openSheet(a.approvalId)}
                  accessibilityRole="button"
                  accessibilityLabel={`${a.agentName} ${a.kind === 'question' ? 'asks' : `wants to run ${approvalTitle(a)}`}: ${what}. Open details`}
                  style={{ gap: space.xs }}
                >
                  <View style={styles.row}>
                    <Avatar id={a.slotId ?? a.conversationId} name={a.agentName} size={28} />
                    <Text variant="headline" style={{ flex: 1 }}>
                      {a.agentName}
                    </Text>
                    {a.kind === 'question' ? <AttentionChip attention="needs_answer" /> : null}
                    <Text variant="caption" color="textMuted">
                      {formatAgo(a.firstSeenAt)}
                    </Text>
                  </View>
                  {a.kind === 'question' ? (
                    // A question is prose, not a command (SPEC §13.8, §16 #4).
                    <Text variant="caption" numberOfLines={2}>
                      {what}
                    </Text>
                  ) : (
                    <Text variant="mono" numberOfLines={2}>
                      <Text variant="mono" style={{ fontWeight: '700' }}>
                        {approvalTitle(a)}
                        {'  '}
                      </Text>
                      {what}
                    </Text>
                  )}
                </Pressable>
                {outcome ? (
                  <Text variant="headline" color={outcome === 'Denied' ? 'danger' : 'stWorkingText'} style={{ marginTop: space.sm }}>
                    {outcome}
                  </Text>
                ) : quick ? (
                  <View style={[styles.row, { marginTop: space.sm }]}>
                    <Button title="Deny" variant="dangerOutline" compact style={{ flex: 1 }} disabled={offline} onPress={() => void act(a, quick.deny)} />
                    <Button
                      title="Allow once"
                      icon={sensitive.icon}
                      accessibilityHint={sensitive.accessibilityHint}
                      compact
                      style={{ flex: 1 }}
                      disabled={offline}
                      onPress={() => void act(a, quick.allow)}
                    />
                  </View>
                ) : (
                  <Button
                    title={a.kind === 'question' ? 'Answer' : 'Review'}
                    variant="secondary"
                    compact
                    style={{ marginTop: space.sm }}
                    onPress={() => openSheet(a.approvalId)}
                  />
                )}
              </Card>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.gutter, gap: space.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
