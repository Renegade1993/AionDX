import { useQuery } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useBiometricKind, useEnrolledMode } from '@/components/confirm';
import { TextPromptModal } from '@/components/TextPromptModal';
import { Button } from '@/components/ui/Button';
import { Card, Divider, EmptyState, Row, SectionHeader } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { keys } from '@/lib/api/hooks';
import { biometricName, confirmStateFor, confirmValueText, isConfirmWarning } from '@/lib/confirmState';
import { formatAgo } from '@/lib/format';
import { getApi, useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { space } from '@/theme';

/**
 * One paired PC (SPEC §6.11 S2 detail, §15.5): name, connection, the Confirmations row with its
 * state-specific caption and action, and switch / re-pair / unpair.
 */
export default function PcDetail() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const host = useConnectionStore((s) => s.hosts.find((h) => h.hostId === hostId));
  const activeHostId = useConnectionStore((s) => s.activeHostId);
  const setActiveHost = useConnectionStore((s) => s.setActiveHost);
  const forgetHost = useConnectionStore((s) => s.forgetHost);
  const label = usePrefsStore((s) => (host ? (s.hostLabels[host.hostId] ?? host.hostName) : ''));
  const labels = usePrefsStore((s) => s.hostLabels);
  const update = usePrefsStore((s) => s.update);
  const [renaming, setRenaming] = useState(false);
  // The active PC's info is already cached; another PC is asked on demand (it opens a session).
  const info = useQuery({ queryKey: keys.host(hostId), queryFn: () => getApi(hostId).getHost(), enabled: !!host, retry: false, staleTime: 60_000 });
  const kind = useBiometricKind();
  const enrolled = useEnrolledMode(hostId);

  if (!host) return <EmptyState title="This PC isn't paired any more." action={<Button title="Back" variant="secondary" onPress={() => router.back()} />} />;

  const state = confirmStateFor(host, info.data);
  const warn = isConfirmWarning(state);
  const rekey = () => router.push({ pathname: '/rekey/[hostId]', params: { hostId: host.hostId } });
  const caption = {
    biometric: 'Asked before approving or managing agents.',
    device_passcode: 'Checked by this app, not your phone’s secure hardware. Your PC shows this too.',
    off: `${label} lets this phone approve and manage agents without confirming. Change this in AionDX on your PC.`,
    none: undefined,
    needs_reconfirm: undefined,
  }[state];

  const saveLabel = (text: string) => {
    const name = text.trim();
    const next = { ...labels };
    if (name) next[host.hostId] = name.slice(0, 40);
    else delete next[host.hostId];
    update({ hostLabels: next });
  };
  const unpair = () =>
    Alert.alert(`Unpair ${label}?`, `This phone will lose access to ${label}. Keys are deleted from this phone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpair',
        style: 'destructive',
        onPress: () => {
          void forgetHost(host.hostId);
          router.back();
        },
      },
    ]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: label }} />
      <TextPromptModal
        visible={renaming}
        title="Rename PC"
        message="Only changes the name on this phone. Leave empty to use the PC's own name."
        initialValue={label}
        maxLength={40}
        onSubmit={saveLabel}
        onClose={() => setRenaming(false)}
      />
      <Card style={styles.group}>
        <Row title="Name" value={label} onPress={() => setRenaming(true)} />
        <Divider />
        <Row title="Connection" value={host.hostId === activeHostId ? (info.isSuccess ? 'LAN · Connected' : 'LAN') : `Paired ${formatAgo(host.pairedAt)}`} />
      </Card>

      <SectionHeader title="Confirmations" />
      <Card style={styles.group}>
        <Row
          title="Confirmations"
          value={confirmValueText(state, kind)}
          valueColor={warn ? 'stNeedsYouText' : 'text'}
          dot={state === 'needs_reconfirm'}
          subtitle={caption}
          onPress={state === 'none' ? () => router.push('/confirm-help') : state === 'needs_reconfirm' ? rekey : undefined}
        />
        {state === 'device_passcode' && enrolled === 'biometric' ? (
          <>
            <Divider />
            <Row title={`Use ${biometricName(kind)} instead…`} onPress={rekey} />
          </>
        ) : null}
      </Card>
      {state === 'needs_reconfirm' ? <Button title="Re-confirm…" style={{ marginTop: space.md }} onPress={rekey} /> : null}
      {state === 'none' ? (
        <Pressable onPress={() => router.push('/confirm-help')} accessibilityRole="link" style={styles.link}>
          <Text color="primary">Learn more</Text>
        </Pressable>
      ) : null}
      {state !== 'needs_reconfirm' ? (
        <Pressable onPress={rekey} accessibilityRole="link" style={styles.link}>
          <Text color="primary">Re-confirm this phone…</Text>
        </Pressable>
      ) : null}

      <SectionHeader title="This PC" />
      <Card style={styles.group}>
        {host.hostId !== activeHostId ? (
          <>
            <Row title="Switch to this PC" onPress={() => setActiveHost(host.hostId)} />
            <Divider />
          </>
        ) : null}
        <Row title="Re-pair" onPress={() => router.push('/scan')} />
        <Divider />
        <Row title="Unpair" destructive onPress={unpair} />
      </Card>
      <View style={{ height: space.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.gutter },
  group: { padding: 0, overflow: 'hidden', gap: 0 },
  link: { minHeight: 44, justifyContent: 'center' },
});
