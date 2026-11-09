import type { BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { QrScanner } from '@/components/QrScanner';
import { parsePairingUri, type PairingOffer, ProtocolError } from '@/lib/crypto/protocol';
import { useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { toast } from '@/state/toastStore';

/** P2 — Scan QR. Camera is the only pairing path in v1 (SPEC §6.1, A8). */
export default function Scan() {
  const setPendingOffer = useConnectionStore((s) => s.setPendingOffer);
  const hasName = usePrefsStore((s) => !!s.deviceName);
  const [connecting, setConnecting] = useState<PairingOffer | null>(null);
  const lastError = useRef<{ data: string; at: number } | null>(null);
  // State updates are async; a ref stops a burst of detections from pushing verify twice.
  const handled = useRef(false);

  // Re-pair / "Pair another PC" skip P1b, but a name is still required.
  useEffect(() => {
    if (!hasName) router.replace('/name');
  }, [hasName]);

  useFocusEffect(
    useCallback(() => {
      handled.current = false;
      setConnecting(null);
    }, []),
  );

  const onScanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (handled.current) return;
      // The scanner fires continuously; don't repeat the same error toast every frame.
      if (lastError.current && lastError.current.data === data && Date.now() - lastError.current.at < 3000) return;
      try {
        const offer = parsePairingUri(data);
        handled.current = true;
        if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setConnecting(offer);
        setPendingOffer(offer);
        router.push('/verify');
      } catch (err) {
        lastError.current = { data, at: Date.now() };
        if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        if (err instanceof ProtocolError && err.code === 'pairing_expired') toast('This code expired. Generate a new one on your PC.', 'error');
        else toast("That's not an AionDX pairing code", 'error');
      }
    },
    [setPendingOffer],
  );

  return (
    <QrScanner
      mode="pair"
      onCode={(data) => onScanned({ data } as BarcodeScanningResult)}
      busyText={connecting ? `Connecting to ${connecting.hostName}…` : null}
      help="On your PC open AionDX → Settings → Mobile → Pair new device"
    />
  );
}
