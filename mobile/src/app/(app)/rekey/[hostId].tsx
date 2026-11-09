import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { ConnectionBanner } from '@/components/Banners';
import { useBiometricKind, useEnrolledMode } from '@/components/confirm';
import { QrScanner } from '@/components/QrScanner';
import { Button } from '@/components/ui/Button';
import { Icon, IconButton } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { isApiError } from '@/lib/api/errors';
import { keys } from '@/lib/api/hooks';
import { DEMO_REKEY_SECRET } from '@/lib/api/mock/facade';
import { biometricName, confirmStateFor, confirmValueText, isConfirmWarning } from '@/lib/confirmState';
import { classifyScannedCode, type RekeyOffer } from '@/lib/crypto/confirm';
import { DEMO_HOST_ID, getApi, useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { toast } from '@/state/toastStore';
import { space, useColors } from '@/theme';

type Step =
  | { kind: 'explain' }
  | { kind: 'scan'; message?: string }
  | { kind: 'confirming'; offer: RekeyOffer }
  | { kind: 'success' }
  | { kind: 'error'; error: 'rekey_invalid' | 'no_rekey_offer' | 'unreachable' | 'not_saved'; offer: RekeyOffer; key?: Uint8Array };

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * §15.3 — Re-confirm this phone with one PC: R1 explainer → R2 scan (aiondx://rekey) → R3
 * confirming → R4 success, or an error. Needs a live session with that PC: the proof binds it.
 */
export default function Rekey() {
  const c = useColors();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const hosts = useConnectionStore((s) => s.hosts);
  const storeConfirmKey = useConnectionStore((s) => s.storeConfirmKey);
  const host = hosts.find((h) => h.hostId === hostId);
  const hostName = usePrefsStore((s) => (host ? (s.hostLabels[host.hostId] ?? host.hostName) : 'your PC'));
  const info = useQuery({ queryKey: keys.host(hostId), queryFn: () => getApi(hostId).getHost(), enabled: !!host, retry: false, staleTime: 30_000 });
  const enrolled = useEnrolledMode(hostId);
  const kind = useBiometricKind();
  const [step, setStep] = useState<Step>({ kind: 'explain' });
  const lastScan = useRef<{ data: string; at: number } | null>(null);

  if (!host) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <Stack.Screen options={{ title: 'Re-confirm' }} />
        <Text color="textMuted">{"This PC isn't paired with this phone any more."}</Text>
        <Button title="Close" variant="secondary" onPress={close} />
      </View>
    );
  }

  const deviceId = info.data?.device?.deviceId ?? useConnectionStore.getState().identities[host.hostId]?.deviceId;
  const deviceName = info.data?.device?.name ?? usePrefsStore.getState().deviceName ?? 'this phone';
  const state = confirmStateFor(host, info.data);
  const mode = enrolled === 'biometric' || enrolled === 'device_passcode' ? enrolled : null;
  const modeName = mode === 'biometric' ? biometricName(kind) : 'its passcode';
  const reachable = info.isSuccess;

  const fail = (message: string) => {
    if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setStep({ kind: 'scan', message });
  };

  async function confirm(offer: RekeyOffer, key?: Uint8Array) {
    if (!mode || !deviceId) return;
    setStep({ kind: 'confirming', offer });
    let received = key;
    try {
      received ??= (await getApi(hostId).reissueConfirmKey(offer.rekeySecret, deviceId, mode)).confirmKey;
    } catch (err) {
      const error = isApiError(err, 'rekey_invalid') ? 'rekey_invalid' : isApiError(err, 'no_rekey_offer') ? 'no_rekey_offer' : 'unreachable';
      setStep({ kind: 'error', error, offer });
      return;
    }
    try {
      // In biometric mode, storing may show the OS prompt ("Save confirmation key for NATE-PC").
      await storeConfirmKey(hostId, received, mode);
    } catch {
      setStep({ kind: 'error', error: 'not_saved', offer, key: received });
      return;
    }
    setStep({ kind: 'success' });
  }

  /** R2's local checks, before anything is sent (SPEC §15.3.2). */
  const onCode = (data: string) => {
    if (lastScan.current && lastScan.current.data === data && Date.now() - lastScan.current.at < 3000) return;
    lastScan.current = { data, at: Date.now() };
    const code = classifyScannedCode(data);
    if (code.kind === 'pairing') return fail("That's a pairing code. On your PC, choose Re-issue confirm key for this phone instead.");
    if (code.kind === 'unknown') return fail("That's not an AionDX code.");
    const { offer } = code;
    if (offer.hostId !== hostId) {
      const other = hosts.find((h) => h.hostId === offer.hostId);
      if (!other) return fail("This code is from a PC this phone isn't paired with.");
      const otherName = usePrefsStore.getState().hostLabels[other.hostId] ?? other.hostName;
      Alert.alert(`This code is for ${otherName}, not ${hostName}.`, `Re-confirm ${otherName} instead?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: `Re-confirm ${otherName}`, onPress: () => router.replace({ pathname: '/rekey/[hostId]', params: { hostId: other.hostId } }) },
      ]);
      return;
    }
    if (deviceId && offer.deviceId !== deviceId) return fail(`This code is for another phone paired with ${hostName}. On your PC, choose ${deviceName}.`);
    if (offer.expiresAt <= Date.now()) return fail('This code expired. Choose Re-issue confirm key on your PC again.');
    if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void confirm(offer);
  };

  const header = (
    <Stack.Screen
      options={{
        title: step.kind === 'scan' ? 'Scan re-confirm code' : 'Re-confirm',
        headerLeft: () => <IconButton icon="close" label="Close" onPress={close} />,
      }}
    />
  );

  if (step.kind === 'scan') {
    const help = `On ${hostName}: Settings → Mobile → ${deviceName} → Re-issue confirm key`;
    return (
      <View style={{ flex: 1 }}>
        {header}
        <QrScanner mode="rekey" onCode={onCode} help={help} message={step.message} />
        {hostId === DEMO_HOST_ID ? (
          // The demo PC has no screen to show a code, so the preview can use its built-in offer.
          <View style={[styles.demo, { backgroundColor: c.surface }]}>
            <Button
              title="Use the demo PC's code"
              variant="secondary"
              onPress={() => void confirm({ hostId, deviceId: deviceId ?? '', rekeySecret: DEMO_REKEY_SECRET, expiresAt: Date.now() + 300_000 })}
            />
          </View>
        ) : null}
      </View>
    );
  }

  if (step.kind === 'confirming') {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        {header}
        <ActivityIndicator size="large" color={c.primary} />
        <Text variant="headline">Confirming with {hostName}…</Text>
      </View>
    );
  }

  if (step.kind === 'success') {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        {header}
        <Icon name="checkmark-circle" size={48} color="stWorking" />
        <Text variant="title" style={styles.centerText}>
          Confirmations are back on
        </Text>
        <Text variant="caption" color="textMuted">
          {hostName} · {mode === 'biometric' ? biometricName(kind) : 'Passcode'}
        </Text>
        <Button
          title="Done"
          style={styles.wide}
          onPress={() => {
            // The action that was blocked isn't performed automatically; the user taps it again.
            if (!router.canGoBack()) toast(`Confirmations are back on for ${hostName}`, 'success');
            close();
          }}
        />
      </View>
    );
  }

  if (step.kind === 'error') {
    const copy = {
      rekey_invalid: {
        title: `${hostName} didn't accept this code`,
        body: 'It may have been used already, or the scan didn’t match. Re-issue a new code on your PC and scan again.',
      },
      no_rekey_offer: {
        title: `No re-confirm request on ${hostName}`,
        body: `Codes last 5 minutes and work once. On ${hostName}, choose Re-issue confirm key for ${deviceName} again.`,
      },
      unreachable: { title: `Couldn't reach ${hostName}`, body: 'Check that your phone and PC are on the same network.' },
      not_saved: { title: 'Not saved', body: `The new key from ${hostName} wasn't saved on this phone.` },
    }[step.error];
    const retryScan = step.error === 'rekey_invalid' || step.error === 'no_rekey_offer';
    const offer = step.offer;
    const key = step.key;
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        {header}
        <Icon name="close-circle" size={48} color="stError" />
        <Text variant="title" style={styles.centerText}>
          {copy.title}
        </Text>
        <Text color="textMuted" style={styles.centerText}>
          {copy.body}
        </Text>
        {retryScan ? (
          <Button title="Scan again" style={styles.wide} onPress={() => setStep({ kind: 'scan' })} />
        ) : (
          <Button
            title="Try again"
            style={styles.wide}
            // Re-sends the same proof request while the code is valid (or re-stores the received key).
            onPress={() => (key || offer.expiresAt > Date.now() ? void confirm(offer, key) : setStep({ kind: 'scan' }))}
          />
        )}
        <Button title="Cancel" variant="ghost" onPress={close} />
      </View>
    );
  }

  // R1 — explainer
  const warn = isConfirmWarning(state);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {header}
      <ConnectionBanner />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.pc}>
          <Icon name="desktop-outline" size={22} color="text" />
          <Text variant="headline">{hostName}</Text>
        </View>
        <Text color={warn ? 'stNeedsYouText' : 'textMuted'}>Confirmations: {confirmValueText(state, kind)}</Text>

        {enrolled === 'none' ? (
          <>
            <Text>Set a screen lock on this phone first. Without one, this phone can’t protect a confirm key.</Text>
            <Button title="Open Settings" onPress={() => void Linking.openSettings()} />
          </>
        ) : (
          <>
            {[`On ${hostName}, open AionDX → Settings → Mobile`, `Choose "${deviceName}" → Re-issue confirm key`, 'Scan the code it shows'].map((line, i) => (
              <View key={line} style={styles.step}>
                <Text style={styles.num}>{i + 1}</Text>
                <Text style={{ flex: 1 }}>{line}</Text>
              </View>
            ))}
            {mode ? (
              <Text variant="caption" color="textMuted">
                This phone will use {modeName} for confirmations.
              </Text>
            ) : null}
            <Button title="Scan code" disabled={!reachable || !mode} onPress={() => setStep({ kind: 'scan' })} />
            {!reachable && !info.isPending ? (
              <Text variant="caption" color="textMuted" style={styles.centerText}>
                Connect to {hostName} first (same network or your VPN).
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.xl, gap: space.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  centerText: { textAlign: 'center' },
  wide: { alignSelf: 'stretch' },
  pc: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  step: { flexDirection: 'row', gap: space.md },
  num: { fontWeight: '700', width: 16 },
  demo: { padding: space.lg },
});
