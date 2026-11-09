import { router } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { AttentionChip } from '@/components/AttentionChip';
import { Icon, Row, SkeletonList } from '@/components/ui/primitives';
import { useActiveTeam, useTeams } from '@/lib/api/hooks';
import { space } from '@/theme';

/** Teams on the current host (SPEC §2 team switcher). */
export default function TeamPicker() {
  const teams = useTeams();
  const { teamId, setTeam } = useActiveTeam();
  if (!teams.data) return <SkeletonList rows={2} />;
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {teams.data.map((t) => (
        <Row
          key={t.teamId}
          title={t.name}
          icon="people-outline"
          right={
            <>
              {/* ✋ when an agent waits on you, else "Your turn" (SPEC §14.1.3). */}
              <AttentionChip attention={t.waitingOnUser ? 'needs_approval' : t.attention === 'your_turn' ? 'your_turn' : 'none'} />
              {t.teamId === teamId ? <Icon name="checkmark" color="primary" /> : null}
            </>
          }
          onPress={() => {
            setTeam(t.teamId);
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ list: { paddingVertical: space.sm } });
