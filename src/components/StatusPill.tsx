import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { StatusKey } from '@/lib/format';
import { radius, slotStatusStyle, space, useColors, useReduceMotion, withAlpha } from '@/theme';

const ICONS: Record<string, IconName> = {
  'circle-outline': 'ellipse-outline',
  hand: 'hand-left',
  hourglass: 'hourglass-outline',
  'x-octagon': 'close-circle',
  dash: 'remove-outline',
  pause: 'pause',
};

function PulseDot({ color }: { color: string }) {
  const reduce = useReduceMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, opacity]);
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity: reduce ? 1 : opacity }]} />;
}

/** Status = color + icon + label, never color alone (SPEC §4.1, §9). */
export function StatusPill({ status, size = 'sm' }: { status: StatusKey; size?: 'sm' | 'md' }) {
  const c = useColors();
  const s = slotStatusStyle[status];
  const color = c[s.color];
  const textColor = c[s.textColor];
  return (
    <View
      accessible
      accessibilityLabel={`Status: ${s.label}`}
      style={[styles.pill, size === 'md' && styles.md, { backgroundColor: withAlpha(color, 0.12) }]}
    >
      {s.icon === 'pulse-dot' ? (
        <PulseDot color={color} />
      ) : s.icon === 'spinner' ? (
        <ActivityIndicator size="small" color={color} style={{ transform: [{ scale: 0.6 }] }} />
      ) : (
        <Icon name={ICONS[s.icon] ?? 'ellipse'} size={size === 'md' ? 14 : 12} color={s.color} />
      )}
      <Text variant="caption" style={{ color: textColor, fontWeight: '600' }}>
        {s.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.chip,
    alignSelf: 'flex-start',
  },
  md: { paddingHorizontal: space.md, paddingVertical: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
