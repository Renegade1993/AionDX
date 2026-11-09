import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Icon, Screen } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { DEMO_ENABLED, useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { space, touchTarget } from '@/theme';

/** P1 — Welcome (SPEC §6.1). */
export default function Welcome() {
  const addDemoHost = useConnectionStore((s) => s.addDemoHost);
  const hasName = usePrefsStore((s) => !!s.deviceName);

  return (
    <Screen edges={['top', 'bottom']} style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.logo}>
          <Icon name="grid" size={56} color="primary" />
        </View>
        <Text variant="display" style={styles.center}>
          Control AionDX from your phone
        </Text>
        <View style={styles.bullets}>
          <Text>• See every agent’s status live</Text>
          <Text>• Approve requests on the go</Text>
          <Text>• Chat with agents, manage tasks</Text>
        </View>
        <View style={styles.e2e}>
          <Icon name="lock-closed" color="textMuted" />
          <Text variant="caption" color="textMuted" style={{ flex: 1 }}>
            End-to-end encrypted. Your PC and phone pair directly.
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Button title="Pair with my PC" onPress={() => router.push(hasName ? '/scan' : '/name')} />
        <Pressable
          accessibilityRole="button"
          style={styles.link}
          onPress={() => Alert.alert('Find the pairing code', 'On your PC, open AionDX → Settings → Mobile → Pair new device.')}
        >
          <Text color="primary">How do I find the QR code?</Text>
        </Pressable>
        {DEMO_ENABLED ? (
          <Pressable accessibilityRole="button" style={styles.link} onPress={() => void addDemoHost().then(() => router.replace('/'))}>
            <Text variant="caption" color="textMuted">
              Explore with demo data (dev build)
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.xl, justifyContent: 'space-between' },
  hero: { flex: 1, justifyContent: 'center', gap: space.xl },
  logo: { alignItems: 'center' },
  center: { textAlign: 'center' },
  bullets: { gap: space.sm, alignSelf: 'center' },
  e2e: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', paddingHorizontal: space.lg },
  actions: { gap: space.sm },
  link: { minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' },
});
