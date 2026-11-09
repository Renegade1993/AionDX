import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import type { Attention } from '@/lib/api/types';
import { type ColorToken, radius, space, useColors, withAlpha } from '@/theme';

const MARKERS: Record<Exclude<Attention, 'none'>, { label: string; text: ColorToken; tint: ColorToken }> = {
  needs_answer: { label: '✋ Question', text: 'stNeedsYouText', tint: 'stNeedsYou' },
  needs_approval: { label: '✋ Approval', text: 'stNeedsYouText', tint: 'stNeedsYou' },
  error: { label: '⊗ Error', text: 'stErrorText', tint: 'stError' },
  your_turn: { label: 'Your turn', text: 'primary', tint: 'primary' },
};

/**
 * Attention marker for chat list rows, the team picker and D2's header (SPEC §14.1.3). `none`
 * renders nothing (callers show the unread dot instead).
 */
export function AttentionChip({ attention }: { attention: Attention }) {
  const c = useColors();
  if (attention === 'none') return null;
  const m = MARKERS[attention];
  return (
    <View accessible accessibilityLabel={m.label.replace(/^[✋⊗] /, '')} style={[styles.chip, { backgroundColor: withAlpha(c[m.tint], 0.12) }]}>
      <Text variant="caption" color={m.text} style={styles.label}>
        {m.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: radius.chip, paddingHorizontal: space.sm, paddingVertical: 2 },
  label: { fontWeight: '600' },
});
