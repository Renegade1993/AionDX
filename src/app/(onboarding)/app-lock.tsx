import { router } from 'expo-router';
import { useEffect } from 'react';
import { BackHandler, ScrollView, StyleSheet } from 'react-native';

import { useHostLabel } from '@/components/Banners';
import { ConfirmationsCard, useEnrolledMode } from '@/components/confirm';
import { LockMethodPicker } from '@/components/LockMethodPicker';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { confirmStateFor } from '@/lib/confirmState';
import { useActiveHost } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { space } from '@/theme';

/**
 * P4 — App lock. Local only; pairing is already complete so Back is disabled (SPEC §6.1),
 * and the header is hidden entirely rather than left as an empty bar (SPEC §13.14).
 */
export default function AppLock() {
  const lockMethod = usePrefsStore((s) => s.lockMethod);
  const update = usePrefsStore((s) => s.update);
  // The PC just paired; its confirm mode is what this phone offered (SPEC §15.2.1).
  const host = useActiveHost();
  const hostName = useHostLabel();
  const enrolled = useEnrolledMode(host?.hostId);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  return (
    <Screen edges={['top', 'bottom']} style={styles.container}>
      <ScrollView contentContainerStyle={{ gap: space.lg }}>
        <Text variant="display">Lock the app</Text>
        <LockMethodPicker value={lockMethod} onChange={(v) => update({ lockMethod: v })} enrolled={enrolled} />
        {host ? <ConfirmationsCard state={confirmStateFor(host, undefined)} hostName={hostName} /> : null}
      </ScrollView>
      <Button title="Continue" onPress={() => router.replace('/done')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.xl, gap: space.lg },
});
