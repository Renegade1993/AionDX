import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Alert, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useHostLabel } from '@/components/Banners';
import { TabChrome } from '@/components/TeamHeader';
import { useBiometricKind } from '@/components/confirm';
import { Card, Divider, Row, SectionHeader } from '@/components/ui/primitives';
import { useConfirmState, useRunState } from '@/lib/api/hooks';
import { biometricLockLabel, confirmValueText, isConfirmWarning } from '@/lib/confirmState';
import { useConnectionStore } from '@/state/connectionStore';
import { formatAgo } from '@/lib/format';
import { useConnectionState, useHealthStore } from '@/state/healthStore';
import { usePrefsStore } from '@/state/prefsStore';
import { space } from '@/theme';

const LOCK_LABEL = { biometric: biometricLockLabel(), passcode: 'Device passcode', none: 'Off' } as const;

/** S1 — Settings (SPEC §6.11). */
export default function Settings() {
  const host = useHostLabel();
  const prefs = usePrefsStore();
  const runState = useRunState();
  const conn = useConnectionState();
  const health = useHealthStore();
  const activeHostId = useConnectionStore((s) => s.activeHostId);
  const confirmState = useConfirmState();
  const kind = useBiometricKind();

  const showDiagnostics = () =>
    Alert.alert(
      'Diagnostics',
      [
        `Connection: ${conn}`,
        `Last successful poll: ${health.lastSuccessAt ? formatAgo(health.lastSuccessAt) : 'never'}`,
        `Consecutive failures: ${health.consecutiveFailures}`,
        `Last failure: ${health.lastFailure ?? 'none'}`,
        `Platform: ${Platform.OS} ${String(Platform.Version)}`,
      ].join('\n'),
    );

  const status = conn === 'ok' ? `LAN · Updated ${runState.dataUpdatedAt ? formatAgo(runState.dataUpdatedAt) : '—'}` : conn;

  return (
    <View style={{ flex: 1 }}>
      <TabChrome team={false} />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Connected to" />
        <Card style={styles.group}>
          <Row icon="desktop-outline" title={host} value={status} onPress={() => router.push('/settings/hosts')} />
        </Card>

        <SectionHeader title="Security" />
        <Card style={styles.group}>
          <Row icon="lock-closed-outline" title="App lock" value={LOCK_LABEL[prefs.lockMethod]} onPress={() => router.push('/settings/security')} />
          <Divider />
          {/* Confirmations are per PC and enforced by the PC (SPEC §15.5). */}
          <Row
            icon="finger-print-outline"
            title={`Confirmations · ${host}`}
            value={confirmValueText(confirmState, kind)}
            valueColor={isConfirmWarning(confirmState) ? 'stNeedsYouText' : 'textMuted'}
            dot={confirmState === 'needs_reconfirm' || confirmState === 'none'}
            onPress={activeHostId ? () => router.push({ pathname: '/settings/pc/[hostId]', params: { hostId: activeHostId } }) : undefined}
          />
        </Card>

        <SectionHeader title="Live updates" />
        <Card style={styles.group}>
          <Row icon="notifications-outline" title="Notifications" value="Coming soon" />
        </Card>

        <SectionHeader title="About" />
        <Card style={styles.group}>
          <Row icon="information-circle-outline" title={`Version ${Constants.expoConfig?.version ?? '—'}`} value="Diagnostics" onPress={showDiagnostics} />
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.gutter, paddingBottom: space.xxl },
  group: { padding: 0, overflow: 'hidden', gap: 0 },
});
