import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Divider, Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { ConfirmMode } from '@/lib/api/types';
import { biometricLockLabel } from '@/lib/confirmState';
import type { LockMethod } from '@/state/prefsStore';
import { space, touchTarget } from '@/theme';

const OPTIONS: { value: LockMethod; label: string; note?: string }[] = [
  { value: 'biometric', label: biometricLockLabel(), note: 'Default' },
  { value: 'passcode', label: 'Device passcode only', note: 'Your OS may still offer biometrics first' },
  { value: 'none', label: 'No lock', note: 'Anyone holding this phone can open AionDX and message your agents' },
];

/**
 * Radio group shared by onboarding P4 and Settings S3. The options follow what the phone has
 * (SPEC §15.2.1): no biometrics → Face ID is disabled; no screen lock → only "No lock".
 */
export function LockMethodPicker({ value, onChange, enrolled }: { value: LockMethod; onChange: (v: LockMethod) => void; enrolled?: ConfirmMode | null }) {
  const unavailable = (v: LockMethod): string | null => {
    if (enrolled === 'none' && v !== 'none') return 'Set a passcode on your phone to use an app lock';
    if (enrolled === 'device_passcode' && v === 'biometric') return 'Not set up on this phone';
    return null;
  };
  return (
    <Card style={styles.group} accessibilityRole="radiogroup">
      {OPTIONS.map((o, i) => {
        const reason = unavailable(o.value);
        const checked = value === o.value && !reason;
        return (
          <View key={o.value}>
            {i > 0 ? <Divider /> : null}
            <Pressable
              onPress={() => onChange(o.value)}
              disabled={!!reason}
              accessibilityRole="radio"
              accessibilityState={{ checked, disabled: !!reason }}
              style={[styles.row, reason ? styles.disabled : null]}
            >
              <Icon name={checked ? 'radio-button-on' : 'radio-button-off'} color={checked ? 'primary' : 'textMuted'} size={22} />
              <View style={{ flex: 1 }}>
                <Text>{o.label}</Text>
                {reason || o.note ? (
                  <Text variant="caption" color="textMuted">
                    {reason ?? o.note}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  group: { padding: 0, overflow: 'hidden', gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touchTarget + 12, paddingHorizontal: space.lg, paddingVertical: space.sm },
  disabled: { opacity: 0.5 },
});
