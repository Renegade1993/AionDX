import { Redirect, router, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card, Icon, IconButton } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import {
  detectConfirmMode,
  pairingCode,
  PairingLockedError,
  PairingRejectedError,
  type PairingResult,
  PairingTimeoutError,
  pairWithHost,
} from '@/lib/api/pairing';
import { ClockSkewError } from '@/lib/api/secureChannel';
import { createDeviceIdentity } from '@/lib/storage/keyStore';
import { useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { space } from '@/theme';

type Phase = 'compare' | 'waiting' | 'mismatch' | { error: string; timeout: boolean };

/**
 * P3 — Verify (SPEC §6.1). The pairing request starts as soon as this screen
 * opens so the PC can display its code; the result is only accepted once the
 * user has also tapped "Codes match" here.
 */
export default function Verify() {
  const offer = useConnectionStore((s) => s.pendingOffer);
  // A fresh keypair and deviceId for every pairing attempt (contract A5); saved only if approved.
  const [identity] = useState(createDeviceIdentity);
  const firstPairing = useRef(useConnectionStore.getState().hosts.length === 0).current;
  const addHost = useConnectionStore((s) => s.addHost);
  const setPendingOffer = useConnectionStore((s) => s.setPendingOffer);
  const deviceName = usePrefsStore((s) => s.deviceName) ?? undefined;
  const [phase, setPhase] = useState<Phase>('compare');
  const approved = useRef<PairingResult | null>(null);
  const matched = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const code = useMemo(() => (offer ? pairingCode(identity, offer) : null), [offer, identity]);

  const finish = useCallback(async () => {
    if (!approved.current || !matched.current) return;
    const { host, confirmKey } = approved.current;
    await addHost(host, { enterApp: false, identity, confirmKey });
    router.replace(firstPairing ? '/app-lock' : '/done');
  }, [addHost, firstPairing, identity]);

  useEffect(() => {
    if (!offer) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    detectConfirmMode()
      .then((confirmMode) => pairWithHost(identity, offer, { signal: ctrl.signal, deviceName, confirmMode }))
      .then((result) => {
        approved.current = result;
        void finish();
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const timeout = err instanceof PairingTimeoutError;
        const known = err instanceof PairingRejectedError || err instanceof PairingLockedError || err instanceof ClockSkewError || timeout;
        const message = known ? (err as Error).message : `Couldn't reach ${offer.hostName}. ${err instanceof Error ? err.message : ''}`;
        setPhase({ error: message, timeout });
      });
    return () => ctrl.abort();
  }, [offer, identity, deviceName, finish]);

  const cancel = useCallback(() => {
    Alert.alert('Cancel pairing?', `${offer?.hostName ?? 'Your PC'} won't be paired with this phone.`, [
      { text: 'Keep pairing', style: 'cancel' },
      {
        text: 'Cancel pairing',
        style: 'destructive',
        onPress: () => {
          controller.current?.abort();
          setPendingOffer(null);
          router.back();
        },
      },
    ]);
    return true;
  }, [offer, setPendingOffer]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', cancel);
    return () => sub.remove();
  }, [cancel]);

  // Checked before the missing-offer redirect: "They don't match" clears the offer, and the abort
  // screen must still show instead of bouncing back to the scanner.
  if (phase === 'mismatch') {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Icon name="warning" size={48} color="danger" />
          <Text variant="title" style={styles.text}>
            Pairing stopped
          </Text>
          <Text color="textMuted" style={styles.text}>
            The codes didn’t match, so this phone did not pair. Someone else on your network may have tried to intercept the connection. Generate a new code on your PC and scan it again.
          </Text>
          {/* The PC may already trust whoever intercepted the code; the user has to undo that there (SPEC §12.7). */}
          <Card style={{ alignSelf: 'stretch' }}>
            <Text variant="headline">Now, on your PC</Text>
            <Text>
              On your PC, choose “Doesn’t match” — or if you already approved, remove this device in AionDX → Settings → Mobile.
            </Text>
          </Card>
        </View>
        <Button title="Start over" onPress={() => router.dismissTo('/welcome')} />
      </View>
    );
  }

  if (!offer) return <Redirect href="/scan" />;

  const header = <Stack.Screen options={{ headerBackVisible: false, headerLeft: () => <IconButton icon="close" label="Cancel pairing" onPress={cancel} /> }} />;

  if (typeof phase === 'object') {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.center}>
          <Icon name="alert-circle" size={48} color="stError" />
          <Text variant="title" style={styles.text}>
            {phase.timeout ? 'Pairing timed out' : 'Pairing failed'}
          </Text>
          <Text color="textMuted" style={styles.text}>
            {phase.error}
          </Text>
        </View>
        <Button
          title="Try again"
          onPress={() => {
            setPendingOffer(null);
            router.back();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <View style={styles.center}>
        <Text variant="title" style={styles.text}>
          Confirm the code matches
        </Text>
        <Text variant="verifyCode" accessibilityLabel={`Code ${code?.split('').join(' ')}`} style={styles.text}>
          {code}
        </Text>
        <Text color="textMuted" style={styles.text}>
          Your PC {offer.hostName} is showing a code. Only continue if they’re identical.
        </Text>
      </View>
      {phase === 'waiting' ? (
        <View style={styles.waiting}>
          <ActivityIndicator />
          <Text color="textMuted">Waiting for you to confirm on your PC…</Text>
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          <Button
            title="Codes match"
            onPress={() => {
              matched.current = true;
              setPhase('waiting');
              void finish();
            }}
          />
          <Button
            title="They don't match"
            variant="dangerOutline"
            onPress={() => {
              controller.current?.abort();
              setPendingOffer(null);
              setPhase('mismatch');
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.xl, justifyContent: 'space-between' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg },
  text: { textAlign: 'center' },
  waiting: { flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center', minHeight: 100 },
});
