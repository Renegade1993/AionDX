import { router } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { useEnrolledMode } from '@/components/confirm';
import { LockMethodPicker } from '@/components/LockMethodPicker';
import { pickOption } from '@/components/OptionSheet';
import { Card, Divider, Row, SectionHeader } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { fingerprint } from '@/lib/crypto/fingerprint';
import { useActiveHost, useActiveIdentity } from '@/state/connectionStore';
import { AUTO_LOCK_OPTIONS, usePrefsStore } from '@/state/prefsStore';
import { space } from '@/theme';

/** S3 — Security (SPEC §6.11). */
export default function Security() {
  const prefs = usePrefsStore();
  const identity = useActiveIdentity();
  const host = useActiveHost();
  const autoLockLabel = AUTO_LOCK_OPTIONS.find((o) => o.ms === prefs.autoLockMs)?.label ?? 'Custom';
  const enrolled = useEnrolledMode();

  const pickAutoLock = () =>
    void pickOption(
      'Auto-lock',
      AUTO_LOCK_OPTIONS.map((o) => ({ key: String(o.ms), label: o.label, selected: prefs.autoLockMs === o.ms })),
      'Lock the app after it has been in the background for:',
    ).then((key) => key !== null && prefs.update({ autoLockMs: Number(key) }));

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SectionHeader title="Lock the app" />
      <LockMethodPicker value={prefs.lockMethod} onChange={(lockMethod) => prefs.update({ lockMethod })} enrolled={enrolled} />

      <SectionHeader title="Options" />
      <Card style={styles.group}>
        {/* Auto-lock means nothing without an app lock (§13 15b, §16 #17). */}
        <Row
          title="Auto-lock"
          value={autoLockLabel}
          subtitle={prefs.lockMethod === 'none' ? 'Needs an app lock' : undefined}
          disabled={prefs.lockMethod === 'none'}
          onPress={prefs.lockMethod === 'none' ? undefined : pickAutoLock}
        />
        <Divider />
        <Row title="Confirmations are set per PC" subtitle="See Paired PCs." onPress={() => router.push('/settings/hosts')} />
      </Card>

      <SectionHeader title={host ? `This phone's key for ${host.hostName}` : "This phone's key"} />
      <Card>
        <Text variant="mono" selectable>
          {identity ? fingerprint(identity.publicKey) : '—'}
        </Text>
        <Text variant="caption" color="textMuted">
          {identity
            ? 'Matches the fingerprint this PC shows for the phone in its paired-devices list. Each PC gets its own key.'
            : 'No key for this PC (demo mode).'}
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.gutter, paddingBottom: space.xxl },
  group: { padding: 0, overflow: 'hidden', gap: 0 },
});
