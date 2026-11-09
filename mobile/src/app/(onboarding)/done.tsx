import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useHostLabel } from '@/components/Banners';
import { Button } from '@/components/ui/Button';
import { Card, Icon, Screen } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { useTeams } from '@/lib/api/hooks';
import { useConnectionStore } from '@/state/connectionStore';
import { space, useReduceMotion } from '@/theme';

/** P5 — Done (SPEC §6.1). */
export default function Done() {
  const host = useHostLabel();
  const teams = useTeams();
  const reduce = useReduceMotion();
  const enterApp = useConnectionStore((s) => s.enterApp);
  const [scale] = useState(() => new Animated.Value(0.4));

  useEffect(() => {
    if (reduce) scale.setValue(1);
    else Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
  }, [reduce, scale]);

  return (
    <Screen edges={['top', 'bottom']} style={styles.container}>
      <View style={styles.center}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Icon name="checkmark-circle" size={80} color="stWorking" />
        </Animated.View>
        <Text variant="display" style={{ textAlign: 'center' }}>
          Paired with {host}
        </Text>
        <Card style={{ alignSelf: 'stretch' }}>
          <Text>PC: {host}</Text>
          <Text>Route: LAN</Text>
          <Text>Teams found: {teams.data ? teams.data.length : teams.isError ? '—' : '…'}</Text>
        </Card>
      </View>
      <Button
        title="Open dashboard"
        onPress={() => {
          enterApp();
          router.replace('/');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.xl, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg },
});
