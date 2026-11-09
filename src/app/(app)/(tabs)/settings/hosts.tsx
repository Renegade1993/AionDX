import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useBiometricKind } from '@/components/confirm';
import { Button } from '@/components/ui/Button';
import { Card, Divider, Row, SectionHeader } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { keys } from '@/lib/api/hooks';
import type { HostInfo } from '@/lib/api/types';
import { confirmStateFor, confirmValueText, isConfirmWarning } from '@/lib/confirmState';
import type { PairedHost } from '@/lib/storage/keyStore';
import { getApi, useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { space } from '@/theme';

/** S2 — Paired PCs (SPEC §6.11, §15.5): each row opens that PC's detail. */
export default function Hosts() {
  const hosts = useConnectionStore((s) => s.hosts);
  const activeHostId = useConnectionStore((s) => s.activeHostId);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SectionHeader title="Paired PCs" />
      <Card style={styles.group}>
        {hosts.map((h, i) => (
          <View key={h.hostId}>
            {i > 0 ? <Divider /> : null}
            <HostRow host={h} active={h.hostId === activeHostId} />
          </View>
        ))}
      </Card>
      <View style={{ marginTop: space.lg }}>
        <Button title="＋ Pair another PC" variant="secondary" onPress={() => router.push('/scan')} />
      </View>
      <Text variant="caption" color="textMuted" style={{ marginTop: space.md }}>
        Tap a PC to switch, rename, re-confirm, re-pair or unpair it.
      </Text>
    </ScrollView>
  );
}

/** `NATE-PC · LAN · Confirmations: Face ID`, with a dot when it needs attention (SPEC §15.5). */
function HostRow({ host, active }: { host: PairedHost; active: boolean }) {
  const label = usePrefsStore((s) => s.hostLabels[host.hostId] ?? host.hostName);
  const kind = useBiometricKind();
  // Only the cached answer for other PCs: listing them shouldn't open sessions with each.
  const info = useQuery<HostInfo>({ queryKey: keys.host(host.hostId), queryFn: () => getApi(host.hostId).getHost(), enabled: false });
  const state = confirmStateFor(host, info.data);
  return (
    <Row
      icon="desktop-outline"
      title={`${label}${active ? ' (active)' : ''}`}
      subtitle={`LAN${active && info.data ? ' · Connected' : ''} · Confirmations: ${confirmValueText(state, kind)}`}
      dot={state === 'needs_reconfirm' || state === 'none'}
      valueColor={isConfirmWarning(state) ? 'stNeedsYouText' : 'textMuted'}
      onPress={() => router.push({ pathname: '/settings/pc/[hostId]', params: { hostId: host.hostId } })}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: space.gutter },
  group: { padding: 0, overflow: 'hidden', gap: 0 },
});
