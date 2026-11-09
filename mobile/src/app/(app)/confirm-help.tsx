import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useHostLabel } from '@/components/Banners';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useActiveHost } from '@/state/connectionStore';
import { space, useColors } from '@/theme';

/** §15.2.3 — "Why some actions are unavailable" (no screen lock / no confirm key). */
export default function ConfirmHelp() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const host = useActiveHost();
  const hostName = useHostLabel();
  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}>
      <Text variant="title" accessibilityRole="header">
        Why some actions are unavailable
      </Text>
      <Text>
        AionDX asks you to confirm actions that let agents run commands or change your team: approving requests, answering questions, adding,
        shutting down or removing agents, clearing context, and deleting tasks.
      </Text>
      <Text>This phone has no screen lock, so it can&apos;t confirm them. Everything else still works.</Text>
      <Text variant="headline">To turn them on, either:</Text>
      <View style={styles.step}>
        <Text style={styles.num}>1</Text>
        <View style={styles.stepBody}>
          <Text>Set a passcode (and Face ID, if you like) on this phone, then re-confirm it.</Text>
          {host ? (
            <Button
              title="Re-confirm this phone"
              variant="secondary"
              compact
              style={styles.inline}
              onPress={() => {
                router.back();
                router.push({ pathname: '/rekey/[hostId]', params: { hostId: host.hostId } });
              }}
            />
          ) : null}
        </View>
      </View>
      <View style={styles.step}>
        <Text style={styles.num}>2</Text>
        <View style={styles.stepBody}>
          <Text>
            Or, in AionDX on {hostName}, turn off &quot;Require confirmation&quot; for this phone.
          </Text>
          <Text variant="caption" color="stNeedsYouText">
            Anyone holding this phone could then approve requests.
          </Text>
        </View>
      </View>
      <Button title="Close" variant="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.xl, gap: space.md },
  step: { flexDirection: 'row', gap: space.md },
  num: { fontWeight: '700', width: 16 },
  stepBody: { flex: 1, gap: space.xs },
  inline: { alignSelf: 'flex-start', marginTop: space.xs },
});
