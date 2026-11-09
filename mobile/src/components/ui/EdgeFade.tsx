import { StyleSheet, View } from 'react-native';

import { withAlpha } from '@/theme';

const STEPS = 8;

/**
 * Fades content into `color` at one edge (no gradient dependency): stacked strips of
 * rising opacity. Purely decorative, so it ignores touches and is hidden from screen readers.
 */
export function EdgeFade({ edge, color, size = 16 }: { edge: 'right' | 'bottom'; color: string; size?: number }) {
  const strip = size / STEPS;
  const horizontal = edge === 'right';
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.base, horizontal ? { right: 0, top: 0, bottom: 0, width: size, flexDirection: 'row' } : { left: 0, right: 0, bottom: 0, height: size }]}
    >
      {Array.from({ length: STEPS }, (_, i) => (
        <View key={i} style={[horizontal ? { width: strip } : { height: strip }, { backgroundColor: withAlpha(color, (i + 1) / STEPS) }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { position: 'absolute' },
});
