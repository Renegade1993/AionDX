import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useToastStore } from '@/state/toastStore';
import { radius, space, useColors } from '@/theme';

/** Non-blocking toasts (SPEC §8: never a blocking alert for failures). */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const insets = useSafeAreaInsets();
  const c = useColors();
  if (toasts.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: insets.bottom + 72 }]}>
      {toasts.map((t) => (
        <Pressable
          key={t.id}
          onPress={() => dismiss(t.id)}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[styles.toast, styles.row, { backgroundColor: t.tone === 'error' ? c.stError : c.text }]}
        >
          <Text style={{ color: c.bg, flexShrink: 1 }}>{t.message}</Text>
          {t.action ? (
            <Pressable
              onPress={() => {
                dismiss(t.id);
                t.action!.onPress();
              }}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={{ color: c.bg, fontWeight: '700', textDecorationLine: 'underline' }}>{t.action.label}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: space.gutter, right: space.gutter, gap: space.sm, alignItems: 'center' },
  toast: { paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.card, maxWidth: 480 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
