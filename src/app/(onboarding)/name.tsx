import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { useEnrolledMode } from '@/components/confirm';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { defaultDeviceName } from '@/lib/api/pairing';
import { usePrefsStore } from '@/state/prefsStore';
import { radius, space, touchTarget, useColors } from '@/theme';

const MAX = 40;

/** P1b — Name this phone; the name rides in the pairing request (SPEC §6.1). */
export default function NamePhone() {
  const c = useColors();
  const saved = usePrefsStore((s) => s.deviceName);
  const update = usePrefsStore((s) => s.update);
  const [name, setName] = useState(saved ?? defaultDeviceName());
  const enrolled = useEnrolledMode();
  const trimmed = name.trim();

  const next = () => {
    if (!trimmed) return;
    update({ deviceName: trimmed.slice(0, MAX) });
    router.push('/scan');
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.container, { backgroundColor: c.bg }]}>
      <View style={{ gap: space.md }}>
        <Text variant="display">Name this phone</Text>
        <TextField
          value={name}
          onChangeText={setName}
          maxLength={MAX}
          autoFocus
          returnKeyType="next"
          onSubmitEditing={next}
          accessibilityLabel="Phone name"
          style={[styles.input, { backgroundColor: c.surfaceAlt, color: c.text }]}
        />
        <Text color="textMuted">Your PC will show this name when you confirm pairing.</Text>
        {/* What this phone can use to confirm sensitive actions; the PC shows the same (SPEC §15.2.1). */}
        {enrolled === 'device_passcode' ? (
          <Text variant="caption" color="textMuted">
            🔒 This phone has no Face ID or fingerprint set up. It will use its passcode to confirm sensitive actions. Your PC will show this.
          </Text>
        ) : enrolled === 'none' ? (
          <Text variant="caption" color="stNeedsYouText">
            ⚠ This phone has no screen lock. You can pair it, but it won&apos;t be able to approve requests or manage agents.
          </Text>
        ) : null}
      </View>
      <Button title="Continue" onPress={next} disabled={!trimmed} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.xl, justifyContent: 'space-between' },
  input: { minHeight: touchTarget + 4, borderRadius: radius.card, paddingHorizontal: space.md, fontSize: 17 },
});
