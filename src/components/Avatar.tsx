import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { avatarColor, initials } from '@/lib/format';
import { useColors } from '@/theme';

/** Initials on a color derived from the slot id; lead gets a ★ badge (SPEC §4.3). */
export function Avatar({ id, name, lead, size = 36 }: { id: string; name: string; lead?: boolean; size?: number }) {
  const c = useColors();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(id) }]}>
        <Text variant="caption" style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.36 }}>
          {initials(name)}
        </Text>
      </View>
      {lead ? (
        <View style={[styles.star, { backgroundColor: c.surface }]}>
          <Text style={{ fontSize: 10, lineHeight: 12 }}>★</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  star: { position: 'absolute', right: -3, bottom: -3, borderRadius: 8, paddingHorizontal: 2 },
});
