import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect } from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { radius, space, useColors } from '@/theme';

const FRAME = 240;

/**
 * The P2 camera view (SPEC §6.1), shared by pairing and the re-key flow (`mode: 'rekey'`,
 * SPEC §15.3.2 R2): permission states, the viewfinder, a help line, and an inline message under
 * the viewfinder for rejected codes (the camera keeps running).
 */
export function QrScanner({
  mode,
  onCode,
  busyText,
  help,
  message,
}: {
  mode: 'pair' | 'rekey';
  onCode: (data: string) => void;
  /** While set, scanning pauses and a spinner shows this text (e.g. "Connecting to NATE-PC…"). */
  busyText?: string | null;
  help: string;
  /** Inline error under the viewfinder. */
  message?: string | null;
}) {
  const c = useColors();
  const [permission, requestPermission, getPermission] = useCameraPermissions();

  // Returning from OS Settings with permission granted restarts the camera automatically.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void getPermission();
    });
    return () => sub.remove();
  }, [getPermission]);

  if (!permission) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  if (!permission.granted) {
    const canAsk = permission.canAskAgain;
    return (
      <View style={[styles.explainer, { backgroundColor: c.bg }]}>
        <View style={{ alignItems: 'center' }}>
          <Icon name="qr-code-outline" size={56} color="primary" />
        </View>
        <Text variant="title" style={styles.center}>
          {mode === 'rekey' ? 'Camera needed to re-confirm' : 'Camera needed to pair'}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {mode === 'rekey'
            ? 'AionDX needs the camera to scan the re-confirm code your PC shows.'
            : 'AionDX needs the camera to scan the pairing code from your PC — it’s how your phone gets your PC’s key securely.'}
        </Text>
        {canAsk ? (
          <Button title="Allow camera" onPress={() => void requestPermission()} />
        ) : (
          <Button title="Open Settings" onPress={() => void Linking.openSettings()} />
        )}
        <Text color="textMuted" style={styles.center}>
          {help}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busyText ? undefined : ({ data }: BarcodeScanningResult) => onCode(data)}
        active={!busyText}
      />
      {/* Dim everything outside the viewfinder. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.dim} />
        <View style={{ flexDirection: 'row', height: FRAME }}>
          <View style={styles.dim} />
          <View style={[styles.frame, { borderColor: c.primary }]} />
          <View style={styles.dim} />
        </View>
        <View style={[styles.dim, styles.below]}>
          {busyText ? (
            <View style={styles.busy}>
              <ActivityIndicator color="#fff" />
              <Text style={{ color: '#fff' }}>{busyText}</Text>
            </View>
          ) : (
            <>
              {message ? (
                <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.message, { backgroundColor: c.stError }]}>
                  <Text style={{ color: '#fff', textAlign: 'center' }}>{message}</Text>
                </View>
              ) : null}
              <Text style={{ color: '#fff', textAlign: 'center' }}>{help}</Text>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  explainer: { flex: 1, padding: space.xl, gap: space.lg, alignItems: 'stretch', justifyContent: 'center' },
  center: { textAlign: 'center' },
  dim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  frame: { width: FRAME, height: FRAME, borderWidth: 3, borderRadius: radius.card },
  below: { alignItems: 'center', paddingTop: space.xl, paddingHorizontal: space.xl, gap: space.md },
  busy: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  message: { borderRadius: radius.card, paddingHorizontal: space.md, paddingVertical: space.sm },
});
