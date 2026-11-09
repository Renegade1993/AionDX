import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useHostLabel } from '@/components/Banners';
import { Button } from '@/components/ui/Button';
import { Icon, Screen } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { authenticate, type AuthResult, useLockStore } from '@/state/lockStore';
import { toast } from '@/state/toastStore';
import { space } from '@/theme';

/** Shows logo + host name only — no data behind it (SPEC §6.1 Lock screen). */
export default function LockScreen() {
  const unlock = useLockStore((s) => s.unlock);
  const host = useHostLabel();
  // Starts busy: the OS prompt is triggered automatically on mount.
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);

  const handle = useCallback(
    (r: AuthResult) => {
      setBusy(false);
      if (r.ok) {
        if (r.warning) toast(r.warning);
        unlock();
      } else {
        setFailed(true);
      }
    },
    [unlock],
  );

  useEffect(() => {
    let cancelled = false;
    void authenticate('Unlock AionDX').then((r) => {
      if (!cancelled) handle(r);
    });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const attempt = () => {
    setBusy(true);
    void authenticate('Unlock AionDX').then(handle);
  };

  return (
    <Screen edges={['top', 'bottom']} style={styles.container}>
      <View style={styles.center}>
        <Icon name="lock-closed" size={48} color="primary" />
        <Text variant="display">AionDX</Text>
        <Text color="textMuted">{host}</Text>
      </View>
      <View style={styles.actions}>
        {failed ? <Text color="textMuted" style={{ textAlign: 'center' }}>Locked. Authenticate to continue.</Text> : null}
        <Button title="Unlock" onPress={attempt} loading={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.xl, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  actions: { gap: space.md },
});
