import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ApprovalBanner, ConnectionBanner, TeamSessionBanner } from '@/components/Banners';
import { Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { useActiveTeam } from '@/lib/api/hooks';
import { space } from '@/theme';

/** Header title "AionDX App Team ▾" → team picker sheet (SPEC §2 global chrome). */
export function TeamSwitcherTitle() {
  const { teamName } = useActiveTeam();
  return (
    <Pressable
      onPress={() => router.push('/team-picker')}
      accessibilityRole="button"
      accessibilityLabel={`Team: ${teamName ?? 'loading'}. Switch team`}
      hitSlop={8}
      style={styles.title}
    >
      <Text variant="headline" numberOfLines={1}>
        {teamName ?? 'Loading…'}
      </Text>
      <Icon name="chevron-down" size={16} color="textMuted" />
    </Pressable>
  );
}

/**
 * Banners pinned under the header of every tab root (SPEC §2): connection, then the team session
 * on tabs that belong to the team (§14.1.4), then approvals.
 */
export function TabChrome({ team = true }: { team?: boolean }) {
  return (
    <View>
      <ConnectionBanner />
      {team ? <TeamSessionBanner /> : null}
      <ApprovalBanner />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: 260 },
});
